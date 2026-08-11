# OpenClaw 自动压缩重试后误报模型空回复修复设计文档

## 1. 概述

### 1.1 问题

用户在 Cowork 会话中发起一次较长任务后，智码 GLM Code 界面展示系统提示：

```text
[模型未输出内容] 模型已完成思考但未生成可见回复。你可以继续对话，让模型重新输出结果。
```

但 OpenClaw 实际上已经在自动上下文压缩后继续重试，并最终生成了可见 assistant 回复。问题表现为：

- UI 误以为模型已经空回复结束。
- 后续真实 assistant 文本没有进入 智码 GLM Code 会话。
- OpenClaw session jsonl 中可以看到完整最终回复。

本问题不是模型 API 的真实空输出，而是 智码 GLM Code 对 OpenClaw `chat.final`、上下文压缩重试和 run 生命周期的衔接判断过早。

### 1.2 现场证据

本次日志中的关键链路如下：

1. `22:53:23` 左右，`syncFinalAssistantWithHistory()` 调用 `chat.history`，返回 50 条消息，但尾部只有 thinking、toolCall、toolResult 等内容，没有可见 assistant 文本。
2. `syncFinalAssistantWithHistory()` 记录 `no canonical assistant text found in history`。
3. `handleChatFinal()` 判断当前 turn `hadToolCall=true` 且 `turn.currentText=""`，触发 `thinking-only response detected`，并向 UI 插入 `[模型未输出内容]` 系统消息。
4. 随后 OpenClaw 日志出现 context overflow 后的自动压缩：`outcome=compacted`，并对同一个 prompt 发起 retry。
5. 智码 GLM Code 已经把当前 run 标记为 completed 并清理 active turn。
6. 后续同一个 `runId` 的 assistant 流式文本被 `recentlyClosedRunIds` 守卫识别为已关闭 run 的 late event，日志连续出现 `dropped late assistant text for a closed run`。
7. OpenClaw session jsonl 中最终存在正常 assistant 回复，说明模型并未真的空回复。

本次涉及的关键标识：

| 字段 | 值 |
|---|---|
| 智码 GLM Code sessionId | `63592da9-09d9-40e9-8927-daf0b94e46e1` |
| OpenClaw sessionKey | `c2b25fbb-46e5-48ee-b44d-f56f0bee5529` |
| runId | `666ea222-9a9b-4fe8-8a21-2b3edefce367` |
| 现象时间 | `2026-05-18 22:53:23` 后 |

### 1.3 根因

根因是 **空 final 结算和上下文压缩 retry 的时序竞争**：

1. OpenClaw 在一次工具调用密集的长会话中触发 context overflow。
2. OpenClaw 自动进行上下文压缩，并准备 retry 原 prompt。
3. 智码 GLM Code 在 retry 生成可见文本前收到了 `chat.final` 或 final history 同步结果。
4. 此时 `chat.history` 尾部暂时还没有当前轮可见 assistant 文本，`turn.currentText` 也为空。
5. `handleChatFinal()` 将该状态误判为 thinking-only response，插入 `[模型未输出内容]`。
6. `deferChatFinalCompletion()` 默认只等待 `CHAT_FINAL_COMPLETION_GRACE_MS = 800ms`。
7. 800ms 后 `completeDeferredChatFinalNow()` 将 session 标记 completed，并调用 `cleanupSessionTurn()`。
8. `cleanupSessionTurn()` 把当前 `knownRunIds` 写入 `recentlyClosedRunIds`，默认保留 120 秒。
9. OpenClaw 自动压缩 retry 后继续用同一个 `runId` 输出 assistant 文本。
10. 智码 GLM Code 因 run 已进入 recently closed 集合，丢弃这些后续文本。

这与此前 `phase=fallback` 晚到事件导致已完成 turn 被重新打开的问题不同。本问题方向相反：当前 turn 被过早关闭，导致压缩 retry 后的真实输出被误判为 late event。

### 1.4 目标

修复目标：

1. OpenClaw 自动上下文压缩、维护或 retry 过程中，不应提前展示 `[模型未输出内容]`。
2. 同一个 run 在压缩 retry 后产生的 assistant 文本应继续进入当前 turn。
3. 保留 `recentlyClosedRunIds` 对真实 late event 的保护，避免旧 run 污染新 turn。
4. thinking-only 提示只用于确认模型最终确实没有可见输出的场景。
5. 修复后用户应看到 OpenClaw 最终生成的 assistant 回复，而不是系统空回复提示。

### 1.5 非目标

本修复不做以下事情：

- 不改 OpenClaw 的自动压缩策略。
- 不改模型选择、上下文窗口或 provider 配置。
- 不移除 `recentlyClosedRunIds` 守卫。
- 不取消 thinking-only 兜底提示。
- 不调整 UI 文案样式。

## 2. 用户场景

### 场景 1: 自动压缩后继续输出

**Given** 用户发起的 Cowork 任务触发 OpenClaw context overflow
**When** OpenClaw 自动压缩上下文并 retry 原 prompt
**Then** 智码 GLM Code 应保持当前会话 running 或 maintenance 状态
**And** 不应提前展示 `[模型未输出内容]`
**And** retry 后的 assistant 文本应显示在同一轮回复中

### 场景 2: 自动压缩期间展示 loading

**Given** OpenClaw 已经触发自动上下文压缩、memory flush 或压缩后的 prompt retry
**When** 智码 GLM Code 收到 context maintenance / compaction 相关事件
**Then** 对话区域应展示压缩或整理上下文的 loading 状态
**And** 上下文指示器可进入 spinning/loading 状态
**And** 输入区应阻止继续发送，或明确提示当前正在压缩上下文
**And** loading 应在 assistant 可见文本开始输出、run 正常完成、run 报错或用户停止任务后结束

### 场景 3: 压缩 retry 使用同一个 runId

**Given** OpenClaw retry 后继续使用原 runId 输出文本
**When** 智码 GLM Code 收到该 runId 的 assistant stream 或 final
**Then** 如果该 run 正处于允许 late continuation 的压缩 retry 窗口内，应继续绑定到当前 turn
**And** 不应被 `recentlyClosedRunIds` 丢弃

### 场景 4: 真实 thinking-only 回复

**Given** 当前 turn 没有上下文压缩、maintenance 或 retry 信号
**And** final history 重试同步后仍没有可见 assistant 文本
**And** 当前 turn 存在工具调用或模型完成思考但没有回复的明确证据
**When** run 真实结束
**Then** 智码 GLM Code 可以展示 `[模型未输出内容]`

### 场景 5: 真实 late event

**Given** 某个 run 已正常完成且没有压缩 retry 延续标记
**When** 后续收到旧 run 的过期 assistant 事件
**Then** 智码 GLM Code 仍应丢弃该事件，避免污染新的会话状态

## 3. 功能需求

### FR-1: 空 final 需要区分失败结束和可恢复维护

当 `chat.final` 到达但没有可见 assistant 文本时，不能只依据 `hadToolCall && !turn.currentText.trim()` 立刻判定 thinking-only。

必须先检查当前 turn 是否存在以下信号：

- `turn.hasContextCompactionEvent`
- `turn.hasContextMaintenanceTool`
- final history 尾部符合 `historyTailLooksLikeContextMaintenance()`
- 近期收到 context overflow / compaction / retry 相关生命周期或 diagnostics
- OpenClaw 正在执行 silent maintenance follow-up

如果存在这些信号，空 final 应被视为“可恢复维护中的中间状态”，不是最终空回复。

### FR-2: 压缩 retry 场景使用更长 completion grace

普通 `chat.final` 可以继续使用短 grace window。

但当 turn 存在上下文压缩、maintenance 或 retry 信号时，应使用较长等待窗口，例如现有 `SILENT_MAINTENANCE_FOLLOWUP_GRACE_MS = 60_000`，或与工具生命周期等待一致的窗口。

等待期间：

- session 保持 `running` 或 maintenance 状态。
- 输入区可以展示 `正在整理上下文...`。
- 不 emit `complete`。
- 不调用会把 runId 记入 closed 集合的清理路径。

### FR-3: 自动压缩期间展示 loading 状态

当 OpenClaw 进入上下文压缩、memory flush、silent maintenance 或压缩 retry 时，智码 GLM Code 应向 renderer 发出明确的 maintenance active 状态。

UI 表现要求：

- 对话底部的 streaming activity bar 展示压缩/整理上下文 loading 文案，例如 `正在整理上下文...` 或 `正在压缩上下文...`。
- 上下文使用量指示器如果已展示，应进入 loading/spinning 状态；如果没有 usage 数据，也可以只展示对话底部 loading。
- 发送入口在 loading 期间应与 session running 一致处理：阻止继续发送，并展示已有的 `正在压缩上下文，请稍后继续。` 或等效 i18n 文案。
- loading 不应作为正式聊天消息写入历史。
- loading 应在以下任一事件发生时结束：
  - retry 后开始输出可见 assistant 文本；
  - run 正常 final 并完成；
  - run 报错或 abort；
  - 用户主动 stop；
  - maintenance grace window 超时并进入 thinking-only 兜底。

当前 renderer 已有 `contextMaintenanceSessionIds`、`compactingSessionIds`、`StreamingActivityBar` 和 `ContextUsageIndicator` 等状态/组件，修复应优先复用这些机制，而不是新增平行状态。

### FR-4: 允许已识别 retry 的同 runId late continuation

如果某次 deferred completion 是为了等待 compaction retry 或 silent maintenance follow-up，应设置 `allowLateContinuation` 语义。

该语义要求：

- 清理 turn 时不要把相关 runId 写入 `recentlyClosedRunIds`。
- 如果 retry assistant 事件在 grace window 内到达，应取消或延后 final completion。
- 如果 active turn 已被清理但 runId 明确属于允许 continuation 的 retry，应允许重新绑定到原 session，而不是直接丢弃。

当前代码已有 `finalCompletionAllowLateContinuation` 和 `suppressRecentlyClosedRunIdsOnCleanup` 机制，修复应优先复用并补齐触发条件。

### FR-5: thinking-only 提示必须延迟到 retry 窗口之后

`[模型未输出内容]` 的插入时机应从“第一次空 final 后立即插入”调整为“确认没有压缩 retry 后插入”。

建议规则：

1. 首次空 final 且发现可恢复维护信号时，不插入提示。
2. 延迟等待 retry 或 maintenance follow-up。
3. 等待期间如果收到 assistant 文本，正常展示回复并取消 thinking-only。
4. 等待超时后，再次同步 `chat.history`。
5. 如果仍无当前轮可见 assistant 文本，才插入 `[模型未输出内容]`。

### FR-6: final history 同步应覆盖长尾输出

`syncFinalAssistantWithHistory()` 当前使用 `FINAL_HISTORY_SYNC_LIMIT = 50`。在工具调用密集的 turn 中，当前轮的可见 assistant 文本可能晚于多个工具结果才出现。

修复可考虑：

- 对压缩 retry 或工具密集 turn 增加一次更大 limit 的 final history 同步。
- 或在检测到 compaction retry 后，等待 OpenClaw 后续 stream/final，而不是立即依赖当前 history 尾部。
- 避免把“当前 50 条 history 未含文本”作为最终无输出的强证据。

### FR-7: 日志需要表达自然语言和诊断上下文

新增或调整日志时遵守仓库日志规范：

- 使用英文。
- 以 `[OpenClawRuntime]` 等模块 tag 开头。
- 不在高频 stream 中使用 info level。
- 说明发生了什么，而不是打印变量名 dump。
- error/warn 包含必要 sessionId/runId 上下文。

## 4. 实现方案

### 4.1 调整 thinking-only 判定入口

当前位置：`src/main/libs/agentEngine/openclawRuntimeAdapter.ts` 的 `handleChatFinal()`。

现有判定核心：

```ts
const hadToolCall = turn.toolResultMessageIdByToolCallId.size > 0;
const lastApiResponseHadNoText = !turn.currentText.trim();
if (hadToolCall && lastApiResponseHadNoText) {
  // 插入 taskThinkingOnly
}
```

建议新增一个显式判断函数：

```ts
private shouldWaitForRecoverableFollowup(turn: ActiveTurn): boolean {
  return Boolean(
    turn.hasContextCompactionEvent
    || turn.hasContextMaintenanceTool
    || turn.finalCompletionFlushOnLifecycleEnd === false
    || turn.pendingCompactionRetry
  );
}
```

其中 `pendingCompactionRetry` 可由 OpenClaw diagnostics、lifecycle 或 history maintenance tail 设置；如果已有字段足够表达，不需要新增字段。

### 4.2 将空 final 的压缩场景转入 deferred completion

当 `hadToolCall && lastApiResponseHadNoText` 成立时：

1. 如果 `shouldWaitForRecoverableFollowup(turn)` 为 true：
   - 不插入 `taskThinkingOnly`。
   - 调用 `deferChatFinalCompletion()`，传入：

```ts
{
  graceMs: OpenClawRuntimeAdapter.SILENT_MAINTENANCE_FOLLOWUP_GRACE_MS,
  flushOnLifecycleEnd: false,
  allowLateContinuation: true,
}
```

2. 如果没有 recoverable follow-up 信号：
   - 保持现有 thinking-only 逻辑。

### 4.3 在压缩 retry 窗口内驱动 renderer loading

主进程已经存在 `emitContextMaintenance(sessionId, active)`，renderer 通过 `cowork:stream:contextMaintenance` 更新 `contextMaintenanceSessionIds`。

修复时应保证以下时机正确发出状态：

- 检测到 context maintenance history tail、memory flush tool 或 compaction/retry 信号时，发送 `active=true`。
- 空 final 转入 recoverable follow-up 等待时，保持 `active=true`，不要在短 grace 后立刻结束。
- retry 后收到可见 assistant 文本时，可以结束 maintenance loading，恢复普通 streaming loading。
- run final/error/abort/stop/cleanup 时发送 `active=false`。

renderer 侧优先复用现有展示：

- `CoworkSessionDetail` 的 `StreamingActivityBar` 用于展示整理上下文 loading。
- `ContextUsageIndicator` 的 `compacting` prop 用于圆环 spinner。
- `coworkSlice` 中的 `setContextMaintenance` / `setContextCompacting` 用于状态来源。
- 所有用户可见文案必须走 `src/renderer/services/i18n.ts`。

如果当前 `ContextUsageIndicator` 只响应手动 compacting 状态，应考虑让自动 context maintenance 也能驱动相同 spinner，或在 spec 实现时明确只展示底部 loading，避免出现“底部在压缩但圆环静止”的割裂状态。

### 4.4 复用 allowLateContinuation 抑制 recently closed

`completeDeferredChatFinalNow()` 已经在 `turn.finalCompletionAllowLateContinuation` 为 true 时设置：

```ts
turn.suppressRecentlyClosedRunIdsOnCleanup = true;
```

修复重点不是重写 closed-run 守卫，而是确保压缩 retry 场景进入这条路径。

同时需要确认：

- assistant stream 到达时会调用 `postponeChatFinalCompletion()` 或等效逻辑。
- `ensureActiveTurn()` / `bindRunIdToTurn()` 对明确 retry continuation 的 runId 不进行 closed-run suppression。
- 完成后如果确实没有 continuation，再按正常路径关闭。

### 4.5 二次确认 history 后再展示空回复提示

新增一个延迟确认步骤：

```text
空 final
  ↓
检测到 compaction / maintenance / retry 信号
  ↓
延迟 completion，不展示 taskThinkingOnly
  ↓
收到 assistant 文本 → 正常展示并完成
  ↓
等待超时仍无文本
  ↓
再次 syncFinalAssistantWithHistory()
  ↓
仍无文本 → 插入 taskThinkingOnly
```

这个步骤可减少误报，同时保留真实空回复的用户提示。

### 4.6 与现有上下文压缩功能衔接

本修复应与 `specs/features/cowork-context-compaction/2026-05-08-cowork-context-compaction-design.md` 的语义保持一致：

- 自动压缩、memory flush、retry 是内部维护状态。
- UI 应展示轻量 maintenance/loading 状态。
- 内部维护消息不应变成正式聊天内容。
- 自动压缩后的可见 assistant 回复仍属于用户当前 turn。

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| 空 final 后 1 秒内没有文本，但 10 秒后 retry 输出文本 | 不展示 thinking-only；保持 running；展示后续文本 |
| 自动压缩刚触发但尚未 retry 输出 | 展示整理/压缩上下文 loading，不插入聊天消息 |
| 自动压缩 loading 期间用户继续发送 | 阻止发送并提示稍后继续，或沿用 session running 的发送保护 |
| 自动压缩 loading 后开始输出 assistant 文本 | 结束 maintenance loading，切回普通 streaming 状态 |
| 自动压缩 loading 后用户手动 stop | 立即结束 loading，不允许后续 retry 文本恢复 turn |
| 空 final 后没有 compaction/retry/maintenance 信号 | 保持现有 thinking-only 兜底 |
| compaction retry 使用同一个 runId | 不把该 runId 过早写入 `recentlyClosedRunIds` |
| compaction retry 使用新 runId | 新 runId 应能绑定到当前 active turn 或同一 session continuation |
| history limit 50 未覆盖最终 assistant 文本 | 不把该结果作为最终无输出证据；延迟或扩大同步 |
| 真实旧 run 的 late assistant event | 继续由 `recentlyClosedRunIds` 丢弃 |
| 用户手动 stop session | 不允许 retry continuation 覆盖用户停止意图 |
| retry 后最终仍无可见文本 | 超时后二次同步 history，再展示 thinking-only |
| OpenClaw 返回明确 error stopReason | 走 error 路径，不套用 compaction retry grace |

## 6. 涉及文件

预计涉及以下文件：

| 文件 | 说明 |
|---|---|
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 调整 final、deferred completion、closed-run guard 和 thinking-only 判定 |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts` 或相邻测试文件 | 增加 compaction retry 空 final 回归测试 |
| `src/renderer/store/slices/coworkSlice.ts` | 复用或调整 context maintenance / compacting session 状态 |
| `src/renderer/services/cowork.ts` | 接收 maintenance 事件并驱动 renderer 状态 |
| `src/renderer/components/cowork/CoworkSessionDetail.tsx` | 展示整理/压缩上下文 loading，并控制发送保护 |
| `src/renderer/components/cowork/ContextUsageIndicator.tsx` | 自动压缩期间展示 spinner 或保持与底部 loading 一致 |
| `src/renderer/services/i18n.ts` | 如新增 loading 文案，补充中英文 key |
| `src/main/i18n.ts` | 通常不需要改；仅当新增主进程用户可见文案时补充中英文 key |

## 7. 验收标准

### AC-1: 不再误报空回复

模拟或复现以下事件顺序：

```text
tool calls / tool results
chat.final with empty visible text
context overflow
compaction outcome=compacted
retry prompt
same runId assistant stream text
chat.final with visible assistant text
```

预期：

- 压缩或 retry 等待期间 UI 展示整理/压缩上下文 loading。
- UI 不出现 `[模型未输出内容]`。
- session 不提前 completed。
- assistant 文本正常显示。
- assistant 文本开始输出或 run 完成后 loading 消失。
- 日志不出现 retry 文本被 `dropped late assistant text for a closed run` 丢弃。

### AC-2: 自动压缩 loading 不进入聊天历史

触发自动压缩并等待 retry。

预期：

- UI 有 loading 状态。
- cowork messages 中不新增“正在压缩上下文”之类的正式聊天消息。
- 切换会话再回来时，不应把 loading 文案当作历史消息展示。

### AC-3: 真实 thinking-only 仍提示

模拟没有 compaction/retry/maintenance 信号的空 final。

预期：

- 二次确认后仍无可见文本时展示 `[模型未输出内容]`。
- session 正常 completed。

### AC-4: closed-run guard 仍有效

模拟普通完成后的旧 run 迟到 assistant event。

预期：

- 事件仍被丢弃。
- 不污染当前 session 或新 turn。

### AC-5: 用户 stop 优先级最高

模拟用户停止任务后 OpenClaw 继续输出。

预期：

- 后续文本不应恢复已停止 turn。
- 不应重新打开 session running 状态。
- 自动压缩 loading 立即结束。

### AC-6: 日志可诊断

复现 compaction retry 时，日志应能看出：

- 空 final 被识别为 recoverable follow-up。
- completion 被延迟。
- maintenance loading 被开启和关闭。
- retry 文本被接受或绑定。
- 最终完成路径清晰。

## 8. 验证计划

1. 增加单元测试覆盖 `chat.final` 空文本 + compaction retry + 同 runId assistant stream。
2. 增加单元测试覆盖无 compaction 信号的真实 thinking-only。
3. 增加单元测试覆盖普通 completed run 的 late event 丢弃。
4. 增加 renderer 或集成测试覆盖 `contextMaintenance active=true/false` 后 loading 展示和消失。
5. 手动使用长上下文工具密集任务触发 OpenClaw 自动压缩，确认 UI 展示 loading 且不出现误报。
6. 检查主进程日志，确认 retry 输出没有被 closed-run guard 丢弃。
7. 运行 focused test 和 touched-file ESLint。
