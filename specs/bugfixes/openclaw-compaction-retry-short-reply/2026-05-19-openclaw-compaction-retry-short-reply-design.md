# OpenClaw 自动压缩重试后短回复提前完成修复设计文档

## 1. 概述

### 1.1 问题

用户在 Cowork 会话中提问后，模型先输出一句类似“我先看看日志”的短回复，随后 智码 GLM Code 界面认为本轮已经结束。用户需要再发送“继续”，模型才会继续输出完整分析。

从日志看，这不是模型真正停止，也不是单纯 UI 没有展示压缩进度。OpenClaw 后续仍然在同一个 run 中触发上下文溢出、自动压缩，并继续生成完整回答；但 智码 GLM Code 主进程已经把该 run 标记为 completed，后续 assistant stream 被 closed-run guard 当作迟到事件丢弃。

### 1.2 现场证据

本次日志中的关键标识：

| 字段 | 值 |
|---|---|
| OpenClaw sessionKey | `agent:test:lobsterai:bdf36d41-4f7c-48a0-a24c-ede0c130a61c` |
| OpenClaw internal sessionId | `a0e7f1f8-84e4-4625-90e2-9b1308e2ed59` |
| 提前完成的 runId | `e8234edd-add5-4e47-8de9-bcf9b40d9755` |
| 用户继续后的 runId | `95b56541-7e56-41ab-ab47-cd41a801f7f9` |
| 现象时间 | `2026-05-19 17:14:50` 至 `17:17:05` |

关键时间线：

1. `17:14:51`，preflight compaction 检查没有拿到精确 token：`tokenCount=undefined`，`contextWindow=54000`，`threshold=30000`，`promptTokensEst=1869`。因此本轮不是发送前就完成了可见压缩。
2. `17:14:52`，`context-diag pre-prompt` 显示 `systemPromptChars=47953`、`promptChars=7476`，起始上下文已经很大。
3. `17:14:56` 至 `17:15:11`，run `e8234edd-add5-4e47-8de9-bcf9b40d9755` 输出短文本，并执行多个日志读取工具。
4. `17:15:11`，OpenClaw 发出 `chat final`，`finalTextLen=109`。智码 GLM Code 将 session 状态切到 `idle`，原因是 `run_completed`，随后执行 turn cleanup。
5. 同一轮 final 同步从 `chat.history` 回填了大工具结果，其中多个 tool result 长度接近 `39952`、`39961` 字符。
6. `17:16:09`，同一个 run 后续出现上下文溢出诊断：`Context overflow: estimated context size exceeds safe threshold during tool loop`，并进入 `attempting auto-compaction`。当时 `pre.historyTextChars=125001`、`pre.toolResultChars=117385`。
7. `17:16:53` 至 `17:17:03`，同一个 run 开始输出完整回答，例如“好的，分析完了！让我把 5月19日 今天网关重启的完整时间线给你梳理出来。”
8. 但主进程反复记录 `dropped late assistant text for a closed run`，说明完整回答被 `recentlyClosedRunIds` 守卫丢弃。
9. `17:17:05`，用户继续后新开 run `95b56541-7e56-41ab-ab47-cd41a801f7f9`。这次上下文里已经出现 `compactionSummary:1`，因此可以继续回答。

### 1.3 根因

根因是 **可见短 final 和自动压缩 continuation 的生命周期竞争**：

1. OpenClaw 在工具调用密集任务中先输出一段可见短文本。
2. `chat.final` 到达时，该文本非空，因此现有空回复/maintenance 等待逻辑不会介入。
3. 智码 GLM Code 按普通完成路径调用 `deferChatFinalCompletion()`，短 grace 后将 session 标记 completed。
4. `cleanupSessionTurn()` 将该 runId 写入 `recentlyClosedRunIds`。
5. 随后工具结果导致 OpenClaw 在同一个 run 内触发 context overflow 和 auto-compaction retry。
6. retry 后同一个 runId 继续输出完整 assistant 文本。
7. `processAgentAssistantText()` 先检查 `isRecentlyClosedRunId(runId)`，因此后续文本被直接丢弃。

这与 `specs/bugfixes/openclaw-compaction-retry-empty-reply/2026-05-19-openclaw-compaction-retry-empty-reply-design.md` 覆盖的问题相邻但不同：

- 空回复问题：`finalText` 为空，UI 误报 `[模型未输出内容]`。
- 本问题：`finalText` 非空但只是短进度回复，UI 提前完成，完整 continuation 被丢弃。

### 1.4 目标

修复目标：

1. 工具结果很大、上下文压力很高时，短可见 `chat.final` 不应被立即视为不可逆终局。
2. OpenClaw 自动压缩、retry 或 continuation 期间，智码 GLM Code 应保持当前 turn 可恢复。
3. 同一个 run 在自动压缩后继续输出的 assistant 文本应显示在原会话中。
4. 用户不需要发送“继续”来恢复被丢弃的同轮回答。
5. 保留 `recentlyClosedRunIds` 对真实迟到旧事件的保护。
6. 自动压缩期间 UI 应展示 running / context maintenance 状态，而不是看起来已经结束。

### 1.5 非目标

本修复不做以下事情：

- 不调整 OpenClaw 的模型选择策略。
- 不修改 DeepSeek 或其他 provider 的上下文窗口配置。
- 不取消 `recentlyClosedRunIds` 守卫。
- 不把“短回复”本身视为错误；只有存在高上下文压力或压缩 continuation 信号时才延迟完成。
- 不将 OpenClaw 内部 compaction summary 直接作为正式聊天消息展示。
- 不重写现有上下文压缩 UI，仅复用已有 maintenance/loading 状态。

## 2. 用户场景

### 场景 1: 工具密集任务自动压缩后继续输出

**Given** 用户要求模型分析多份日志
**And** OpenClaw 执行多个工具调用，产生大量 tool result
**When** 模型先输出一段短进度回复，随后触发 context overflow 和 auto-compaction
**Then** 智码 GLM Code 不应提前把 session 标记 completed
**And** 压缩 retry 后的完整 assistant 文本应继续显示在当前回复中
**And** 日志不应出现该 run 的 continuation 文本被 `dropped late assistant text for a closed run` 丢弃

### 场景 2: 自动压缩期间用户看到运行状态

**Given** OpenClaw 正在压缩上下文或等待 retry continuation
**When** 用户查看对话界面
**Then** UI 应展示当前会话仍在运行或正在整理上下文
**And** 发送入口应沿用 running 状态保护，避免用户误以为必须手动发送“继续”

### 场景 3: 普通短回复正常完成

**Given** 模型没有工具调用，或工具结果很小，且没有上下文压力或 compaction 信号
**When** 模型输出一句短回答并 final
**Then** 智码 GLM Code 应按普通路径快速完成
**And** 不应为了防御本问题而无条件等待很长时间

### 场景 4: 真实旧 run 迟到事件

**Given** 某个 run 已经真正完成，且没有压缩 retry 或 continuation 信号
**When** 后续收到旧 run 的 assistant stream
**Then** `recentlyClosedRunIds` 仍应丢弃该事件，避免污染当前会话或下一轮

### 场景 5: 用户主动停止任务

**Given** 用户点击停止当前 Cowork 任务
**When** OpenClaw 后续仍发出 assistant stream 或 retry continuation
**Then** 用户停止优先级最高，智码 GLM Code 不应恢复该 turn
**And** context maintenance loading 应立即结束

## 3. 功能需求

### FR-1: 可见 final 也需要可恢复完成判断

`handleChatFinal()` 当前对空 final 已有 recoverable follow-up 逻辑，但本问题中 `finalTextLen=109`，不会进入空 final 分支。

修复后，非空 `finalText` 也需要在完成前判断是否属于“可恢复 continuation 风险”：

- 当前 turn 有工具调用。
- 当前 turn 已累计较大 tool result。
- 当前模型/provider 的安全上下文阈值较低，或已知 context usage 接近风险区。
- 已收到 context maintenance、context compaction、memory flush、overflow diagnostic、retry diagnostic 等信号。
- final 文本明显只是当前任务中的中间进度回复，而不是长任务的完整回答。

最后一条不能作为唯一条件，因为文本语义难以稳定判断；它只能作为高上下文压力下的辅助信号。

### FR-2: 高上下文压力下的短可见 final 应进入 deferred completion

当 `chat.final` 非空，但满足高风险条件时，应复用 deferred completion 机制：

```ts
this.deferChatFinalCompletion(sessionId, turn, runId, {
  graceMs: OpenClawRuntimeAdapter.SILENT_MAINTENANCE_FOLLOWUP_GRACE_MS,
  flushOnLifecycleEnd: false,
  allowLateContinuation: true,
});
```

等待期间：

- 保留已有短可见 assistant 文本。
- session 状态保持 `running` 或 context maintenance。
- 不 emit `complete`。
- 不执行会把 runId 写入 `recentlyClosedRunIds` 的最终 cleanup。
- 如果 continuation assistant text 到达，应取消或延后 completion，并继续写入当前 assistant 回复。
- 如果等待超时且没有 continuation，再以已有可见文本正常完成；此时不应插入 `[模型未输出内容]`。

### FR-3: continuation 信号必须优先于 closed-run 丢弃

当前 `processAgentAssistantText()` 在解析 session 之前先检查：

```ts
if (runId && this.isRecentlyClosedRunId(runId)) {
  console.debug('[OpenClawRuntime] dropped late assistant text for a closed run.');
  return;
}
```

修复后，应确保压缩 continuation 相关信号能在该丢弃判断前生效。可选方案：

1. 在真正 cleanup 前延迟写入 `recentlyClosedRunIds`，让同 run continuation 仍能进入当前 active turn。
2. 引入 `recoverableContinuationRunIds` 或类似状态，只有明确 compaction/retry 信号命中的 runId 才绕过 closed-run drop。
3. 如果 OpenClaw 当前只在日志中输出 `context-overflow-diag` / `compaction-diag`，应优先让 gateway 发出结构化 lifecycle/diagnostic event，而不是依赖解析日志文本。

不能简单移除 closed-run guard。

### FR-4: 明确区分 provisional completion 和 terminal completion

智码 GLM Code 需要区分两个阶段：

| 阶段 | 含义 | 可接受后续同 run 文本 |
|---|---|---|
| provisional completion | 收到 `chat.final`，但存在压缩 retry 风险 | 是 |
| terminal completion | grace 结束，且没有 continuation / retry / compaction 信号 | 否 |

只有 terminal completion 才应：

- emit `complete`
- 将 session 标记 completed / idle
- 调用最终 cleanup
- 将 runId 写入 `recentlyClosedRunIds`

### FR-5: 复用 context maintenance UI

压缩 retry 等待期间应向 renderer 发出 context maintenance 状态。

UI 表现要求：

- `CoworkSessionDetail` 底部继续展示 `StreamingActivityBar`。
- 如果已有文案支持，展示“正在整理上下文...”或“正在压缩上下文...”。
- `ContextUsageIndicator` 可以进入 compacting/loading 状态；如果无法可靠同步，也至少保持底部 loading。
- loading 不写入正式聊天历史。
- assistant 可见 continuation 开始输出、run 正常结束、run 报错、用户 stop 或 grace 超时后，loading 必须结束。

### FR-6: 普通完成路径不能被明显拖慢

为避免所有短回答都等待很久，进入长 grace 必须有明确条件。

建议条件至少包含以下之一：

- 当前 turn 的 tool result 总字符数超过阈值，例如 `20_000` 或按 context window 的比例计算。
- 当前上下文使用量已超过 warning / danger 阈值。
- OpenClaw 已发出 context maintenance / compaction / overflow / retry 相关事件。
- 当前 final 发生在工具调用密集 turn，且仍存在未完成的 tool result backfill 或 pending agent event。

没有工具调用、没有 context pressure、没有 maintenance 信号的普通短回复，应继续使用默认短 grace。

### FR-7: 日志需要保留可诊断链路

新增或调整日志时应遵守仓库日志规范，并能看出以下事实：

- 某个 visible final 被判定为 provisional。
- 判定依据是 tool result size、context pressure 或 compaction/retry signal。
- 进入 deferred completion 的 grace 时长。
- 后续 continuation 被接受还是被丢弃。
- terminal completion 发生时是否将 runId 写入 recently closed 集合。

日志应使用英文自然语言，避免高频 info-level stream 日志。

## 4. 实现方案

### 4.1 增加 visible final continuation 判断

涉及文件：`src/main/libs/agentEngine/openclawRuntimeAdapter.ts`。

建议新增一个判断函数：

```ts
private shouldWaitForVisibleFinalContinuation(turn: ActiveTurn, finalText: string): boolean {
  if (!finalText.trim()) return false;
  if (turn.toolResultMessageIdByToolCallId.size === 0) return false;

  return Boolean(
    turn.hasContextCompactionEvent
    || turn.hasContextMaintenanceTool
    || turn.pendingRecoverableFollowup
    || this.hasHighContextPressure(turn, finalText)
  );
}
```

其中 `hasHighContextPressure()` 可以优先使用已有 runtime 状态，不需要第一版就做复杂语义分析：

- `turn.toolResultTextByToolCallId` 的累计字符数。
- `turn.currentText` / `turn.currentAssistantSegmentText` 的长度。
- 已知 context usage / context window。
- 已知 provider/model 的 safe threshold。
- 是否有 pending tool backfill 或 pending agent event。

第一版重点是捕捉“工具结果巨大 + 短可见 final + 后续可能压缩”的风险，不追求判断任意短文本是否完整。

### 4.2 在 `handleChatFinal()` 中延迟高风险可见 final

在 stopReason、tool-use final、error final 处理之后，普通完成之前插入判断：

```text
chat.final with visible text
  ↓
sync / backfill tool results
  ↓
detect high context pressure or compaction/retry signal
  ↓
defer completion with allowLateContinuation
  ↓
wait for continuation or timeout
```

如果进入该路径：

1. 先持久化当前可见短文本，避免 UI 空白。
2. 设置 `turn.pendingRecoverableFollowup = true` 或更精确的字段，例如 `turn.pendingVisibleFinalContinuation = true`。
3. `emitContextMaintenance(sessionId, true)`。
4. 调用长 grace deferred completion，且 `allowLateContinuation=true`。
5. 返回，不进入普通 `deferChatFinalCompletion()`。

### 4.3 continuation 到达时取消 provisional completion

当后续 assistant stream 到达同一个 run：

- 如果 active turn 仍在，调用 `postponeChatFinalCompletion()` 或新增更明确的 cancel 方法。
- 清除 `pendingVisibleFinalContinuation`。
- 保留 session running。
- 根据现有 agent stream 逻辑更新 assistant message。
- 后续真正 final 到达时再进入普通 completion。

如果后续先到的是 context overflow / compaction diagnostic：

- 记录该 runId 处于 recoverable continuation。
- 保持 context maintenance active。
- 不允许 cleanup 将该 runId 记入 recently closed。

### 4.4 cleanup 时只在 terminal completion 写入 closed-run tombstone

`cleanupSessionTurn()` 当前通过 `turn.suppressRecentlyClosedRunIdsOnCleanup` 控制是否记入 `recentlyClosedRunIds`。

修复时应明确：

- provisional completion 期间不 cleanup。
- 如果因为 allowLateContinuation 需要 cleanup，应设置 `suppressRecentlyClosedRunIdsOnCleanup=true`。
- 如果 grace 超时且没有 continuation，进入 terminal completion 后可以正常记入 recently closed。
- 如果用户 stop，则不允许后续 continuation 恢复 turn，并应按 stop 路径处理 tombstone。

### 4.5 renderer 复用已有 maintenance 状态

涉及文件：

- `src/renderer/store/slices/coworkSlice.ts`
- `src/renderer/services/cowork.ts`
- `src/renderer/components/cowork/CoworkSessionDetail.tsx`
- `src/renderer/components/cowork/ContextUsageIndicator.tsx`

当前 renderer 已有：

- `contextMaintenanceSessionIds`
- `compactingSessionIds`
- `StreamingActivityBar`
- `ContextUsageIndicator`

修复应优先复用这些状态，不新增一套平行 loading。若新增文案，必须在 `src/renderer/services/i18n.ts` 中补齐中英文 key。

### 4.6 与空回复修复保持一致

本设计应和已有空回复修复共用同一组语义：

- recoverable follow-up
- deferred completion
- allow late continuation
- suppress recently closed run ids
- context maintenance loading

差异只在触发条件：

- 空回复修复由 `!finalText.trim()` 触发。
- 本修复由“可见 final + 高上下文压力 / compaction retry 风险”触发。

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| `finalText` 非空但只有短进度说明，后续触发 compaction retry | 延迟 completion，保持 running，接收 continuation |
| `finalText` 非空且是真正完整短回答 | 没有工具/上下文压力时走普通完成 |
| 工具结果很大但没有后续 continuation | grace 超时后以已有可见文本完成，不插入空回复提示 |
| 后续 continuation 使用同一个 runId | 绑定回当前 turn，不被 recently closed 丢弃 |
| 后续 continuation 使用新 runId | 如果有明确 retry/compaction 关联，应绑定到当前 session continuation |
| context overflow diagnostic 在 final 之后才出现 | 如果仍在 provisional window，切换到 context maintenance 并延长等待 |
| context overflow diagnostic 在 terminal cleanup 之后才出现 | 只有存在明确 recoverable run 记录时才允许恢复；否则按真实 late event 处理 |
| 用户点击 stop 后 OpenClaw 继续输出 | 不恢复 turn，后续文本丢弃 |
| OpenClaw 明确返回 error stopReason | 走 error 路径，不套用 continuation grace |
| history sync 返回大量 tool results | 可以作为 high context pressure 依据，但不直接展示为 assistant |
| 多个 run 快速交错 | runId/sessionKey/turnToken 必须匹配，不能把旧 run 绑定到新 turn |

## 6. 涉及文件

预计涉及以下文件：

| 文件 | 说明 |
|---|---|
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 调整 visible final completion、continuation guard、context maintenance 状态和 cleanup |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts` | 增加短可见 final + compaction retry continuation 回归测试 |
| `src/renderer/store/slices/coworkSlice.ts` | 复用 context maintenance / compacting 状态，必要时补齐状态清理 |
| `src/renderer/services/cowork.ts` | 确认 context maintenance stream event 正确驱动 renderer |
| `src/renderer/components/cowork/CoworkSessionDetail.tsx` | 确认 running/loading 期间发送保护和 activity bar 展示 |
| `src/renderer/components/cowork/ContextUsageIndicator.tsx` | 必要时让自动 maintenance 也驱动 spinner |
| `src/renderer/services/i18n.ts` | 如新增 UI 文案，补齐中英文翻译 |

## 7. 验收标准

### AC-1: 复现本次日志链路时不再停在一句话

模拟或手动复现以下事件顺序：

```text
assistant short visible text
tool calls
large tool results
chat.final with short visible text
context overflow
auto-compaction
same runId assistant continuation
chat.final with full answer
```

预期：

- UI 不提前显示 completed / idle。
- 用户不需要发送“继续”。
- 自动压缩期间展示 running 或 context maintenance loading。
- 后续完整回答进入当前 assistant 消息。
- 日志不出现该 continuation 被 `dropped late assistant text for a closed run` 丢弃。

### AC-2: 已有短文本不会丢失

进入 provisional completion 后，短可见 final 应继续显示在 UI 中。

当 continuation 到达时：

- 可以在同一 assistant 消息中继续追加或按现有分段规则更新。
- 不应产生重复 assistant 消息。
- 不应把短文本覆盖成空字符串。

### AC-3: 普通短回答仍快速完成

模拟没有工具调用、没有 context maintenance、没有上下文压力的一句短回答。

预期：

- 使用默认短 grace。
- session 正常 completed。
- 不展示“正在整理上下文”。

### AC-4: 大工具结果但无 continuation 时正常收尾

模拟工具结果较大，但 OpenClaw 后续没有 compaction retry，也没有 assistant continuation。

预期：

- grace 超时后以已有可见文本 completed。
- 不展示 `[模型未输出内容]`。
- loading 状态清理干净。

### AC-5: closed-run guard 仍保护真实迟到事件

模拟普通 terminal completion 后旧 run 再发送 assistant stream。

预期：

- 事件仍被丢弃。
- 当前 session 和下一轮 turn 不被污染。

### AC-6: stop 优先级最高

模拟用户 stop 后同 run 继续发送 compaction continuation。

预期：

- 不恢复 turn。
- 不重新进入 running。
- loading 结束。
- 后续文本被丢弃。

## 8. 验证计划

1. 增加 `openclawRuntimeAdapter` 单元测试，覆盖可见短 final + 大 tool result + 同 run continuation。
2. 增加单元测试，覆盖可见短 final + 大 tool result + 无 continuation 的超时完成。
3. 增加单元测试，覆盖普通短回答不进入 long grace。
4. 增加单元测试，覆盖 terminal completion 后 true late event 仍被丢弃。
5. 手动使用日志分析类任务触发大量 tool result，确认 UI 不再停在一句话。
6. 检查主进程日志，确认能看到 provisional completion、maintenance active、continuation accepted、terminal completion 的完整链路。
7. 运行 focused test：`npm test -- openclawRuntimeAdapter`。
8. 对触及文件运行 narrow ESLint，例如 `npx eslint src/main/libs/agentEngine/openclawRuntimeAdapter.ts`。
