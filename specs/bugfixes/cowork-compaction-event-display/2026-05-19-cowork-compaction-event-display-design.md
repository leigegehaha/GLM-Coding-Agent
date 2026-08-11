# Cowork 压缩事件展示与生命周期修复设计文档

## 1. 概述

### 1.1 问题

用户在 Cowork 任务执行过程中触发 OpenClaw 自动上下文压缩时，智码 GLM Code 当前会在最终回答后方展示一条 `Compaction` 或上下文压缩完成提示。

这个表现有三个问题：

1. **时序不符合用户感知**：压缩实际发生在任务执行中，但 UI 在最终回答之后才补出提示，看起来像回答结束后又发生了一次无关事件。
2. **展示样式不一致**：截图中的 `Compaction` 被渲染成普通 system 卡片，而不是已有的上下文压缩分隔线，说明该消息没有结构化 metadata。
3. **生命周期判断不完整**：OpenClaw 可能在一次 `lifecycle end` / 空 `chat.final` 之后才触发 context overflow auto-compaction，并使用同一个 `runId` 继续 retry。智码 GLM Code 如果提前把该 `runId` 标记为 closed，后续 retry 的 assistant 文本会被当成 late event 丢弃，UI 停在中间态文本。

2026-05-20 复现日志中，OpenClaw 并没有卡死。实际时间线如下：

| 时间 | 事实 | 影响 |
|---|---|---|
| 12:08:27 | 同一 `runId` 第一次 `lifecycle=end`，`chat.final` 文本为空 | 智码 GLM Code 进入可完成路径 |
| 12:08:28 | OpenClaw 检测到 context overflow，开始 auto-compaction | 说明前一个 end 不是整轮任务真正结束 |
| 12:08:33 | compaction 后用同一个 `runId` retry | `runId` 不能被视为一次性完成标识 |
| 12:09:14 | 智码 GLM Code 从 history 同步到一句中间态文本并触发 complete | UI 显示“分析大致完成了...”并结束 turn |
| 12:09:22 | OpenClaw 第二次 compaction 后再次用同一个 `runId` retry | 后续事件仍属于同一用户任务 |
| 12:09:31-12:09:40 | OpenClaw 输出真正最终回答并成功结束 | 智码 GLM Code 因 `recentlyClosedRunIds` 丢弃这些文本 |

因此，本修复不能只解决“Compaction 卡片展示位置”。必须同时修正 `chat.final`、`lifecycle=end`、auto-compaction retry 和 `recentlyClosedRunIds` 之间的状态机关系。

2026-05-20 12:50 再次复现证明还存在另一条未覆盖路径：第一次 attempt 的 `chat.final` 已能被正确延迟，但第二次 attempt 没有发送 `chat.final`，只发送了 `lifecycle=end`。智码 GLM Code 的 lifecycle fallback 在约 800ms 后从 history 同步到一句短中间态 assistant 文本，随后直接 complete。约 11 秒后 OpenClaw 完成第二次 auto-compaction 并用同一个 `runId` retry 时，智码 GLM Code 已经把该 run 作为不可恢复 closed run 处理，导致新的 `lifecycle=start` 被丢弃。

| 时间 | 事实 | 影响 |
|---|---|---|
| 12:48:57 | 第一次 attempt 收到短 `chat.final`，tool result 约 210K 字符 | 智码 GLM Code 正确延迟 final，等待 retry |
| 12:49:03 | 第一次 auto-compaction 成功后同 `runId` retry | 证明 `chat.final` 路径修复有效 |
| 12:49:52 | 第二次 attempt 只收到 `lifecycle=end`，没有后续 `chat.final` | 进入 lifecycle fallback 路径 |
| 12:49:52 | OpenClaw 检测 context overflow，开始第 2 次 auto-compaction | `lifecycle=end` 仍只是 attempt end |
| 12:49:53 | lifecycle fallback 从 history 同步到短中间态文本并 complete | 智码 GLM Code 提前关闭 turn |
| 12:50:05 | 第 2 次 auto-compaction 成功，同 `runId` retry start | 事件被 `recentlyClosedRunIds` 丢弃，UI 停在中间态 |

这说明 `handleChatFinal()` 的延迟判断不够，`completeChannelTurnFallback()` 也必须执行同一套 recoverable retry 风险判断。缺少 `chat.final` 不能降低判断标准；相反，缺少 `chat.final` 且当前 turn 有工具工作时，应视为更不确定的完成信号。

### 1.2 现状链路

相关代码中存在五条链路需要一起纳入设计：

1. OpenClaw `stream=compaction` 事件
   - `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
   - `handleAgentCompactionEvent()` 收到 `phase=start/end` 后，只 emit `contextMaintenance` 状态。
   - renderer 主要用这个状态展示底部 `正在整理上下文...` loading。

2. context usage 刷新补插消息
   - `src/renderer/services/cowork.ts`
   - `handleContextUsageUpdate()` 在 `compactionCount` 增加后，通过 Redux `addMessage()` 临时追加一条 `metadata.kind = context_compaction` 的 system message。
   - 这条消息使用 `Date.now()` 和数组尾部追加，因此天然出现在最终回答后面。

3. history system message 同步
   - `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
   - `syncSystemMessagesFromHistory()` 会把 gateway history 中新的 `role=system` 文本补入本地消息。
   - 当 history 中出现裸文本 `Compaction` 时，当前逻辑会以 `metadata: {}` 写入，renderer 只能按普通 system 卡片渲染。

4. run 关闭和 late event 防重
   - `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
   - `cleanupSessionTurn()` 会把 `turn.knownRunIds` 写入 `recentlyClosedRunIds`。
   - `handleAgentEvent()`、`handleChatEvent()` 和 `processAgentAssistantText()` 会丢弃 recently closed run 的后续事件。
   - 这个机制可以挡住真正的 late events，但在 OpenClaw 同 `runId` retry 时会误伤合法输出。

5. final / lifecycle fallback 完成路径
   - `handleChatFinal()` 会在最终事件后调用 `deferChatFinalCompletion()`。
   - `handleAgentLifecycleEvent(phase=end)` 在部分情况下会立即 flush deferred final。
   - `completeChannelTurnFallback()` 会在缺少 `chat.final` 时从 history 同步最终 assistant 文本并 complete。
   - 当前 recoverable-followup 逻辑覆盖了显式 context maintenance tool、thinking-only、visible continuation 等场景，但原实现没有覆盖“缺少 `chat.final`，lifecycle fallback 同步到短中间态文本，随后 OpenClaw 内部 auto-compaction retry”的路径。

### 1.3 根因

根因分为两层。

第一层是展示模型问题：**压缩事件没有被建模为一条有生命周期的结构化消息**。

当前 UI 只把运行中的 compaction 当成瞬时状态，把压缩完成当成 usage count 的后验推断，把 gateway history 中的 `Compaction` 又当成普通 system 文本。这导致：

- 没有一个稳定的消息 id 能承载 `running -> completed` 状态变化。
- 完成提示只能事后追加，无法锚定到压缩实际开始的位置。
- history 同步会把 OpenClaw 内部 UI 分隔符泄漏到 智码 GLM Code 聊天流。
- renderer 只能根据 `metadata.kind` 区分压缩消息；裸 `Compaction` 无法走专门样式。

第二层是生命周期模型问题：**智码 GLM Code 把 `runId` 当成单次完成边界，但 OpenClaw auto-compaction retry 会复用同一个 `runId`**。

这导致：

- `lifecycle=end` 或空 `chat.final` 可能只是某次 attempt 的结束，不一定是用户 turn 的结束。
- context overflow 可能发生在一次 end/final 之后，不能用“已收到 end”直接推导任务完成。
- 如果提前 cleanup，`recentlyClosedRunIds` 会把同 `runId` retry 的合法 `lifecycle=start`、assistant stream、chat event 全部丢弃。
- 如果 final 文本为空，history 同步可能抓到中间态 assistant 文本并误判为最终答案。

所以完整修复必须同时满足：

1. 压缩展示必须结构化并锚定到真实发生位置。
2. turn 完成必须等 OpenClaw retry/compaction 路径稳定结束。
3. closed-run 防重必须区分真正 late event 和同 `runId` 的合法 retry。

### 1.4 目标

修复目标：

1. 当任务执行过程中触发自动上下文压缩时，消息流中立即展示结构化的压缩状态。
2. 压缩结束时更新同一条消息，而不是在最终回答后新增一条。
3. 不再展示裸 `Compaction` system 卡片。
4. 保留现有 context usage 指示器和手动压缩能力。
5. 保留 `contextMaintenance` 运行态，用于输入禁用、底部 activity bar 和防止会话过早完成。
6. 不把 OpenClaw 内部 `COMPACTION` / `Compaction` 分隔符当成用户可见聊天内容。
7. 不因空 `chat.final`、短中间态文本或某次 attempt 的 `lifecycle=end` 提前 complete。
8. 同一个 `runId` 在 auto-compaction 后合法 retry 时，后续 `lifecycle=start`、assistant stream 和最终 `chat.final` 必须继续进入同一 turn。
9. `recentlyClosedRunIds` 继续能挡住真正的旧事件、重复事件和手动停止后的 late events。

### 1.5 非目标

本修复不做以下事情：

- 不调整 OpenClaw 的自动压缩策略。
- 不展示 compacted summary 的具体内容。
- 不新增 checkpoint 管理 UI。
- 不修改模型上下文窗口计算。
- 不要求第一版修改 OpenClaw/gateway 协议；如果协议没有结构化 compaction/retry 事件，智码 GLM Code 需要有保守兜底。
- 不改手动压缩入口的交互模式，除非为了复用同一套消息模型做小范围整理。
- 不做数据库 migration；历史中的 legacy `Compaction` 可在渲染或同步层兼容处理。

## 2. 用户场景

### 场景 1: 自动压缩发生在任务执行中

**Given** 用户发起 Cowork 任务
**And** 当前会话上下文触发 OpenClaw 自动压缩
**When** 智码 GLM Code 收到 `stream=compaction phase=start`
**Then** 对话流当前位置展示一条 `上下文压缩中` 分隔线
**And** 输入区按 running/maintenance 状态阻止继续发送
**And** 用户能明确看到任务正在整理上下文，而不是卡住。

### 场景 2: 自动压缩完成后继续任务

**Given** 对话流中已经有一条 active 压缩分隔线
**When** 智码 GLM Code 收到 `stream=compaction phase=end completed=true`
**Then** 同一条分隔线更新为 `上下文压缩已完成`
**And** 后续 retry 或 assistant 文本继续显示在该分隔线之后
**And** 最终回答后不再额外追加 `Compaction` 或重复完成提示。

### 场景 3: 压缩完成后 OpenClaw retry

**Given** OpenClaw 压缩结束事件包含 `willRetry=true`
**When** retry 尚未开始输出可见 assistant 文本
**Then** UI 可以继续保持 maintenance 状态
**And** 压缩分隔线可显示为 `上下文压缩已完成，正在继续任务` 或保持完成状态
**And** 不应把当前 turn 提前标记 completed。

### 场景 4: history 中出现裸 `Compaction`

**Given** gateway history 中包含 `role=system, content=Compaction`
**When** 智码 GLM Code 执行 `syncSystemMessagesFromHistory()`
**Then** 该内部 system 文本不应写入本地聊天消息
**And** 如果已经存在 legacy 裸 `Compaction` 消息，renderer 不应再以普通 system 卡片展示。

### 场景 5: final usage 刷新发现 compaction count 增加

**Given** 本轮已经通过 compaction stream 展示并更新了结构化压缩消息
**When** final 后 context usage refresh 返回更大的 `compactionCount`
**Then** 只更新 context usage 指标和 notified count
**And** 不再追加新的聊天消息。

### 场景 6: 没有收到 compaction stream 的兜底

**Given** 某些 OpenClaw 版本或边界情况没有发送 `stream=compaction`
**When** usage refresh 发现 `compactionCount` 增加
**Then** 智码 GLM Code 可以更新 context usage 指标
**And** 默认不在最终回答后追加聊天消息
**And** 可记录 debug/warn 诊断，后续再评估是否需要非侵入式 toast 或 session meta。

### 场景 7: lifecycle end 后发生 context overflow auto-compaction

**Given** 智码 GLM Code 已收到某个 `runId` 的 `chat.final` 或 `lifecycle phase=end`
**And** final 文本为空，或 final/history 中只出现短中间态 assistant 文本
**When** OpenClaw 随后检测到 context overflow 并执行 auto-compaction
**Then** 智码 GLM Code 不应立即把当前 turn 标记为 completed
**And** 不应把该 `runId` 写入不可恢复的 closed-run 集合
**And** 应继续等待 retry、assistant stream、chat final 或明确错误。

### 场景 8: auto-compaction 后同 runId retry

**Given** 一个 `runId` 已经经历过 attempt 级别的 end/final
**When** 智码 GLM Code 收到同一 `runId`、同一 `sessionKey` 的新 `lifecycle phase=start`
**Then** 该事件应被识别为可能的合法 retry，而不是无条件当作 late event 丢弃
**And** 如果 session 仍属于同一个用户 turn，应恢复或延续 active turn
**And** 后续 assistant 文本应继续写入同一轮任务。

### 场景 9: 真正的 late event 仍然要被过滤

**Given** 某个 run 已经明确完成、手动停止或报错
**And** 没有新的同 session retry 信号
**When** gateway 晚到重复 assistant chunk、tool event 或 lifecycle event
**Then** 智码 GLM Code 仍应通过 closed-run / turn-token / session status 防重机制丢弃它们
**And** 不应重新打开已完成会话。

### 场景 10: lifecycle fallback 同步到短中间态文本

**Given** 当前 turn 已经产生工具调用和大量 tool result
**And** gateway 没有发送 `chat.final`
**When** 智码 GLM Code 在 `lifecycle=end` fallback 中从 `chat.history` 同步到短 assistant 文本
**Then** 该文本只能作为中间态候选展示
**And** 智码 GLM Code 必须进入 recoverable retry wait，而不是直接 complete
**And** 如果同 `runId` 的 retry 在等待窗口内开始，后续 assistant 输出必须继续进入同一 turn。

## 3. 功能需求

### FR-1: 压缩展示由 stream 生命周期驱动

自动压缩的用户可见展示必须以 OpenClaw `stream=compaction` 生命周期为主，而不是以 final 后的 usage count 增量为主。

事件映射：

| OpenClaw event | 智码 GLM Code 行为 |
|---|---|
| `phase=start` | 创建或激活一条结构化压缩消息，状态为 running |
| `phase=end, completed=true, willRetry=false` | 更新同一条消息为 completed，结束 maintenance |
| `phase=end, completed=true, willRetry=true` | 更新同一条消息为 completed/retrying，继续保持 maintenance |
| `phase=end, completed=false` | 更新同一条消息为 failed 或移除 active 状态，按后续错误/重试事件决定最终状态 |

### FR-2: 压缩消息必须结构化

压缩消息必须携带 metadata，renderer 不应依赖 `content === 'Compaction'` 判断正式状态。

建议结构：

```ts
type ContextCompactionMessageMetadata = {
  kind: ContextSystemMessageKind.ContextCompaction;
  mode: ContextCompactionMode.Auto | ContextCompactionMode.Manual;
  status: ContextCompactionStatus.Running
    | ContextCompactionStatus.Completed
    | ContextCompactionStatus.Retrying
    | ContextCompactionStatus.Failed;
  runId?: string;
  compactionCount?: number;
  checkpointId?: string;
  startedAt?: number;
  completedAt?: number;
};
```

实现时不要新增分散的裸字符串。若引入新的 `kind`、`mode`、`status`，应放到共享常量文件中，用 `as const` 定义并导出类型。

### FR-3: 自动压缩只创建一条消息

同一次自动压缩只能创建一条压缩消息：

- `phase=start` 创建 message，并在 active turn 中记录 `contextCompactionMessageId`。
- `phase=end` 通过 `updateMessage()` 更新同一个 message。
- 如果重复收到 `phase=start`，应复用已有 active message，避免重复插入。
- 如果收到 `phase=end` 但没有 active message，可以只结束 maintenance 并刷新 usage，不补插最终消息。

### FR-4: context usage 不再负责补插自动压缩聊天消息

`handleContextUsageUpdate()` 仍然负责：

- 更新 `contextUsageBySessionId`。
- 更新 `notifiedCompactionBySessionId`，避免后续重复提示。
- 驱动 context usage indicator 的百分比、token、checkpoint 信息。

但它不应再在 final 后直接 `addMessage()` 追加自动压缩完成提示。

手动压缩可以继续在手动操作完成后展示完成消息；如果复用新结构，也应使用 `mode=manual` 和同一套 metadata。

### FR-5: 过滤 OpenClaw 内部 compaction system 文本

`syncSystemMessagesFromHistory()` 应过滤 OpenClaw 内部 compaction 分隔符。

建议新增 helper：

```ts
isInternalCompactionSystemText(text: string): boolean
```

匹配策略应保守，只过滤明确的内部标签：

- `Compaction`
- `COMPACTION`
- 可选：只包含装饰符和 `Compaction` 的短文本，例如 `--- COMPACTION ---`

不要过滤普通提醒或用户内容中包含 `compaction` 的长句，避免误删真实系统提醒。

### FR-6: renderer 使用 metadata 渲染压缩分隔线

renderer 应继续以 `metadata.kind` 作为正式判断依据：

- `kind=context_compaction` -> 渲染 `ContextCompactionDivider`
- `status=running` -> 展示 active 动画和 running 文案
- `status=completed` -> 展示完成文案
- `status=retrying` -> 展示完成并继续任务文案
- `status=failed` -> 展示失败或中断文案

文案应走 `src/renderer/services/i18n.ts`，补齐中英文 key。不要在组件中硬编码用户可见字符串。

### FR-7: legacy 裸 `Compaction` 兼容

为了避免已有会话继续展示奇怪卡片，renderer 应对 legacy 裸 system 消息做兼容：

- 如果 `message.type === system`
- `metadata` 为空或没有业务 kind
- `content` 是保守匹配的内部 compaction 标签

则不渲染该消息，或渲染为非 active 的压缩分隔线。推荐第一版直接隐藏，因为新的结构化消息才是权威展示。

### FR-8: activity bar 与 inline divider 分工

`contextMaintenanceSessionIds` 仍然保留，职责是：

- 告诉输入区当前 session 正在运行或维护，阻止继续发送。
- 驱动底部 activity bar 的通用 `正在整理上下文...` 状态。
- 防止 `chat.final` 在压缩 retry 期间过早结算。

inline compaction divider 的职责是：

- 在消息流中锚定压缩发生的位置。
- 留下可回看的压缩完成记录。
- 避免 final 后再补消息。

如果两者同时显示造成重复，后续可在 UI 层优化为：当最后一条可见消息已经是 active compaction divider 时，底部 activity bar 只保留进度条或隐藏文案。

### FR-9: run 关闭必须支持同 runId retry

`recentlyClosedRunIds` 不能再表达为“这个 runId 后续所有事件都非法”。它只能表达“这个 runId 的当前 turn 已经结束，除非后续事件能证明这是同一 session 的合法 retry”。

建议规则：

1. `lifecycle phase=start` 是唯一可以触发 closed-run reopen 判断的 agent lifecycle 信号。
2. 如果收到 recently closed run 的 `phase=start`，且满足以下条件，可以解除 closed 状态并恢复接收：
   - `sessionKey` 能解析到同一个 智码 GLM Code session。
   - 该 session 没有处于手动停止 cooldown。
   - 该 session 最近一次完成时间仍在短窗口内，例如 2 分钟内。
   - event 没有命中 `terminatedRunIds`。
3. 解除 closed 状态后，应重新绑定 `sessionIdByRunId`，重建或延续 `ActiveTurn`，并清理该 runId 的 chat/agent seq 防重游标中会阻挡新 attempt 的部分。
4. 对非 `phase=start` 的 recently closed events，仍按 late event 丢弃。

如果实现无法可靠区分 retry 和陈旧事件，应优先选择“不提前 complete”，而不是完成后再 reopen。reopen 是兜底，不是唯一防线。

### FR-10: 空 final / 中间态 final 不应立即完成 turn

当 `handleChatFinal()` 遇到以下信号时，应进入 recoverable wait，而不是直接完成：

- final payload 没有可见 assistant 文本。
- final 后从 history 同步到的文本明显短于已观察到的 tool loop 复杂度，且当前 turn 近期存在工具调用或 agent stream。
- final 前后 session 有 context overflow / compaction / retry 迹象。
- final 对应的 lifecycle end 紧邻工具循环或大 history backfill。

recoverable wait 的行为：

1. session status 保持 `running`。
2. `contextMaintenance` 保持 true 或进入等价的 retry-wait 状态。
3. completion timer 使用更长的 grace window。
4. `flushOnLifecycleEnd=false`，避免下一次 attempt 的 `lifecycle=end` 把等待提前刷掉。
5. `allowLateContinuation=true`，如果最终仍完成，cleanup 不应把该 runId 立即写入不可恢复 closed 集合。

这条规则不能只依赖 `turn.hasContextMaintenanceTool`。OpenClaw 内部 auto-compaction 可能不会表现为 智码 GLM Code 的显式 maintenance tool。

### FR-11: lifecycle end 只是 attempt end，不一定是 user turn end

`handleAgentLifecycleEvent(phase=end)` 不能单独决定用户 turn 完成。它只能在满足以下条件时触发 fallback complete：

- 当前没有 active compaction。
- 当前没有 pending recoverable followup。
- 当前没有 deferred final 设置 `flushOnLifecycleEnd=false`。
- 当前没有最近的工具调用、空 final、visible continuation 或 retry-wait 迹象。
- end 的 `runId` 属于当前 active turn，且没有出现同 session retry start。

如果这些条件不满足，`phase=end` 应只记录 attempt 结束或继续等待后续 chat/gateway 信号。

### FR-12: 同 runId retry 的输出必须能覆盖或延续中间态文本

如果前一次 attempt 已经产生了短中间态 assistant 文本，后续同 `runId` retry 输出真正答案时：

- 不应创建一个已完成 session 之外的新孤立消息。
- 不应因为前一个 assistant message 标记了 `isFinal=true` 而拒绝继续更新。
- 可以选择复用上一条 assistant message 继续流式更新，或在同一 turn 中创建新的 assistant segment；但最终 UI 不能停留在中间态。
- 最终 complete 只能在最后一次 retry 的 final/lifecycle 稳定结束后触发。

### FR-13: lifecycle fallback 完成前必须复用 retry 风险判断

`completeChannelTurnFallback()` 不能把 history 同步结果直接当作最终答案。它必须在 complete 前复用 `handleChatFinal()` 的 recoverable retry 判断：

- 如果当前 turn 有工具工作，且 history 没有同步到可见 assistant 文本，应进入 recoverable retry wait。
- 如果当前 turn 有工具工作，history 同步到的是短 assistant 文本，且 tool result 体量较大，应进入 recoverable retry wait。
- 如果当前 turn 有 active compaction、pending recoverable followup、pending OpenClaw retry 或 deferred final，不得 complete。
- 如果 lifecycle fallback 最终因超时而 complete，并且该 turn 曾有工具工作或 recoverable 风险，应把该 run 记录为允许 same-run retry reopen 的 closed run。

这条规则是 FR-10 和 FR-11 在“缺少 `chat.final`”路径上的具体落点。实现时不能只修 `handleChatFinal()`。

## 4. 实现方案

### 4.1 增加共享常量和 metadata 类型

建议新增或复用共享常量位置，例如：

- `src/main/libs/agentEngine/constants.ts`
- 或新增可被 main/renderer 同时引用的 `src/shared/coworkConstants.ts`

示例：

```ts
export const CoworkSystemMessageKind = {
  ContextCompaction: 'context_compaction',
} as const;
export type CoworkSystemMessageKind =
  typeof CoworkSystemMessageKind[keyof typeof CoworkSystemMessageKind];

export const ContextCompactionStatus = {
  Running: 'running',
  Completed: 'completed',
  Retrying: 'retrying',
  Failed: 'failed',
} as const;
export type ContextCompactionStatus =
  typeof ContextCompactionStatus[keyof typeof ContextCompactionStatus];

export const ContextCompactionMode = {
  Auto: 'auto',
  Manual: 'manual',
} as const;
export type ContextCompactionMode =
  typeof ContextCompactionMode[keyof typeof ContextCompactionMode];
```

如果共享常量文件会引入构建边界问题，可以先在 main 和 renderer 各自模块内定义同名常量，但不应在调用点散落裸字符串。

### 4.2 主进程在 compaction start 创建消息

修改位置：

- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
- `handleAgentCompactionEvent()`

建议在 `ActiveTurn` 增加字段：

```ts
contextCompactionMessageId?: string;
contextCompactionStartedAt?: number;
```

`phase=start` 处理：

1. 设置 `turn.hasContextCompactionEvent = true`。
2. 更新 session status 为 `running`。
3. emit `contextMaintenance(sessionId, true)`。
4. 如果当前 turn 没有 `contextCompactionMessageId`：
   - `store.addMessage()` 插入 system message。
   - metadata 使用 `kind=context_compaction, mode=auto, status=running`。
   - 记录 message id 到 turn。
   - emit `message` 给 renderer。
5. 如果已经存在 message id，只更新 metadata/status，不新增。

消息 content 可以使用稳定 fallback，例如 `Context compaction`，renderer 对结构化消息应优先根据 metadata 和 i18n 渲染，不直接展示该 content。

### 4.3 主进程在 compaction end 更新消息

`phase=end` 处理：

1. 清除 `turn.hasContextCompactionEvent`。
2. 根据 `completed` 和 `willRetry` 计算 status：
   - `completed && willRetry` -> `retrying`
   - `completed && !willRetry` -> `completed`
   - `!completed` -> `failed`
3. 如果 `turn.contextCompactionMessageId` 存在：
   - `store.updateMessage()` 更新 metadata。
   - emit `messageUpdate(sessionId, messageId, content, metadata)`。
4. 如果 `willRetry=true`：
   - 设置 `turn.pendingRecoverableFollowup = true`。
   - 保持 `contextMaintenance=true`。
5. 如果 `willRetry=false`：
   - emit `contextMaintenance=false`。
6. 如果 `completed=true`：
   - 保留现有 `refreshAndEmitContextUsage()` 调用。

注意：不要在 end 阶段新增第二条 system message。

### 4.4 调整 renderer context usage 通知逻辑

修改位置：

- `src/renderer/services/cowork.ts`

`handleContextUsageUpdate()` 中当前 `compactionCount` 增量触发 `addMessage()` 的逻辑应移除或降级。

建议规则：

1. 如果 `notifyCompaction=true` 且 count 增加：
   - dispatch `markCompactionNotified()`。
   - 不 dispatch `addMessage()`。
2. 如果未来需要兜底提示，应先检查当前 session 是否没有任何结构化 compaction 消息，并且不要在 final 后直接插入普通 system 卡片。

这样最终回答后不会因为 delayed final usage refresh 追加完成提示。

### 4.5 过滤 history 中的内部 compaction 文本

修改位置：

- `src/main/libs/openclawHistory.ts`
- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`

实现 helper 后，在以下位置使用：

- `extractGatewayHistoryEntry()`：对 `role=system` 的内部 compaction 文本直接返回 null。
- 或 `syncSystemMessagesFromHistory()`：插入 system message 前跳过。

推荐放在 `openclawHistory.ts`，和 heartbeat/silent 过滤保持同一层级。

### 4.6 renderer 兼容 legacy 裸 `Compaction`

修改位置：

- `src/renderer/components/cowork/CoworkSessionDetail.tsx`

新增保守判断：

```ts
const isLegacyInternalCompactionSystemMessage = (message: CoworkMessage): boolean => {
  return message.type === 'system'
    && !message.metadata?.kind
    && isInternalCompactionSystemText(message.content);
};
```

在 `buildDisplayItems()` 或 `renderSystemMessage()` 中跳过该消息。

如果 helper 不能共享给 renderer，可在 renderer 侧定义同等保守规则，但应避免散落到多个文件。

### 4.7 i18n 文案

修改位置：

- `src/renderer/services/i18n.ts`

建议文案：

| key | zh | en |
|---|---|---|
| `coworkContextCompactionRunning` | 上下文压缩中 | Compacting context |
| `coworkContextCompactionCompleted` | 上下文压缩已完成 | Context compaction completed |
| `coworkContextCompactionRetrying` | 上下文压缩已完成，正在继续任务 | Context compaction completed, continuing task |
| `coworkContextCompactionFailed` | 上下文压缩未完成 | Context compaction did not complete |

已有 key 可复用，但应保证 running/completed/retrying/failed 有明确映射。

### 4.8 调整 closed-run 防重为 retry-aware

修改位置：

- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`

当前 `handleAgentEvent()` 在解析 session 前先检查 `recentlyClosedRunIds`，这会导致同 `runId` retry 的 `lifecycle=start` 被直接丢弃。应调整为：

1. 先解析 `stream`、`lifecyclePhase`、`runId`、`sessionKey`。
2. 如果 `runId` recently closed：
   - 若不是 `stream=lifecycle` + `phase=start`，继续丢弃。
   - 若是 `phase=start`，进入 retry reopen 判断。
3. retry reopen 判断通过后：
   - 从 `recentlyClosedRunIds` 删除该 `runId`。
   - 通过 `sessionKey` 找回 sessionId。
   - 如果没有 active turn，则创建 retry continuation turn；如果已有 active turn，则绑定该 runId。
   - 清理会挡住新 attempt 的 `lastAgentSeqByRunId` / `lastChatSeqByRunId`，但不要清理与其他 runId/session 相关的状态。
   - 记录 debug 日志，说明这是同 runId retry reopen，而不是普通 late event。

伪代码：

```ts
const isClosed = runId && this.isRecentlyClosedRunId(runId);
const isRetryStart = isClosed
  && stream === AgentStream.Lifecycle
  && lifecyclePhase === AgentLifecyclePhase.Start
  && sessionKey
  && !this.terminatedRunIds.has(runId);

if (isClosed && !isRetryStart) {
  return;
}

if (isRetryStart) {
  const sessionId = this.resolveSessionIdBySessionKey(sessionKey);
  if (!sessionId || this.manuallyStoppedSessions.has(sessionId)) {
    return;
  }
  this.reopenClosedRunForRetry(sessionId, sessionKey, runId);
}
```

实际实现应使用已有常量，不新增裸字符串。

### 4.9 增加 retry continuation turn 状态

`ActiveTurn` 需要能表达“这个 turn 曾经收到过 attempt end/final，但仍在等待 retry”。建议增加或复用字段：

```ts
pendingOpenClawRetry?: boolean;
lastAttemptEndedAtMs?: number;
lastRecoverableFinalAtMs?: number;
reopenedFromClosedRun?: boolean;
```

用途：

- `pendingOpenClawRetry`：阻止 lifecycle fallback 或 deferred final 过早 complete。
- `lastAttemptEndedAtMs`：给 retry reopen 设置合理时间窗口。
- `lastRecoverableFinalAtMs`：诊断和测试用，证明空 final 后进入等待。
- `reopenedFromClosedRun`：避免日志和状态判断混淆，便于后续清理。

如果希望减少字段，也可以复用 `pendingRecoverableFollowup`，但需要把命名和注释更新为“recoverable follow-up/retry”，不能再只暗示 maintenance tool。

### 4.10 调整 chat.final 完成策略

修改位置：

- `handleChatFinal()`
- `deferChatFinalCompletion()`
- `completeDeferredChatFinalNow()`

建议规则：

1. 如果 `finalText` 为空：
   - 先 `syncFinalAssistantWithHistory()`。
   - 如果 history 仍无最终文本，或只同步到短中间态文本，进入 retry wait。
   - retry wait 必须设置 `flushOnLifecycleEnd=false` 和 `allowLateContinuation=true`。
2. 如果 `finalText` 不为空但命中 visible continuation 规则：
   - 继续保留现有 wait。
   - 对 context overflow / compaction 风险较高的路径，应把 `allowLateContinuation` 设为 true，避免 cleanup 后挡住 retry。
3. 如果后续收到 assistant stream 或 retry lifecycle start：
   - `postponeChatFinalCompletion()` 或 `cancelChatFinalCompletion()` 应恢复 running 状态。
   - 如果上一条 assistant message 已被标记 `isFinal=true`，新的 assistant stream 应能继续更新或创建新段落。
4. 如果 grace window 超时仍无 retry/output：
   - 可以完成 turn，但不要立刻把 runId 记为不可恢复 closed；至少对 recoverable wait 路径启用 `suppressRecentlyClosedRunIdsOnCleanup`。

这部分是本 bug 的核心。只依靠 compaction stream 的方案不够，因为 2026-05-20 日志中的失败路径没有给 智码 GLM Code 足够明确的结构化 compaction event。

### 4.11 明确完成条件

一个 Cowork turn 只有在以下条件同时满足时才可以 emit `complete` 并 cleanup：

1. 没有 active `contextMaintenance`。
2. 没有 `hasContextCompactionEvent`。
3. 没有 `pendingRecoverableFollowup` / `pendingOpenClawRetry`。
4. 没有等待中的 `finalCompletionTimer`。
5. 最近没有同 session、同 runId 的 `lifecycle=start` retry 信号。
6. 已经收到可接受的最终 assistant 文本、明确空响应兜底，或明确错误/abort。

如果条件不满足，应保持 session `running`，并通过 activity bar 或 inline divider 表达“正在继续任务/整理上下文”。

### 4.12 lifecycle fallback 风险判断

修改位置：

- `completeChannelTurnFallback()`
- `scheduleLifecycleEndFallback()`
- 与 `handleChatFinal()` 共用的 retry-risk helper

建议实现：

1. `lifecycle=end` 仍可以启动 fallback timer，用于覆盖 gateway 未发送 `chat.final` 的情况。
2. fallback timer 触发后先执行 history sync/reconcile，补齐 tool result 和 assistant 候选文本。
3. sync 后在 complete 前执行风险判断：
   - `hasTurnToolWork(sessionId, turn)` 为 true。
   - `turn.currentAssistantSegmentText || turn.currentText` 为空，或命中短文本 + 大量 tool result。
4. 命中风险时调用 recoverable retry wait：
   - `pendingRecoverableFollowup=true`
   - `pendingOpenClawRetry=true`
   - `flushOnLifecycleEnd=false`
   - `allowLateContinuation=true`
   - session status 保持 `running`
5. 没命中风险且需要 fallback complete 时，如果当前 turn 曾有工具工作，应把 cleanup 标记为 retry-aware，允许合理窗口内同 `runId` 的 `lifecycle=start` reopen。

伪代码：

```ts
await syncFinalAssistantWithHistory(sessionId, turn);

if (isWaitingForRecoverableFollowup(turn) || turn.finalCompletionTimer) return;

const visibleText = turn.currentAssistantSegmentText.trim() || turn.currentText.trim();
if (hasTurnToolWork(sessionId, turn) && shouldWaitForRecoverableFallback(visibleText, turn)) {
  waitForRecoverableOpenClawRetry(sessionId, turn, runId, {
    flushOnLifecycleEnd: false,
    allowLateContinuation: true,
  });
  return;
}

if (hasTurnToolWork(sessionId, turn)) {
  turn.allowRecentlyClosedRunRetryReopenOnCleanup = true;
}

complete();
```

注意：普通无工具工作的 `lifecycle=end` fallback 仍应保持短延迟完成，避免影响简单回复。

### 4.13 协议层长期优化

如果后续可以修改 OpenClaw/gateway，推荐增加以下结构化字段或事件：

- `attemptId` 或 `runAttempt`：区分同一 `runId` 下的多次 retry。
- `stream=compaction phase=start/end`：确保 智码 GLM Code 不必从 stdout 或 usage count 推断。
- `willRetry=true`：在 `lifecycle=end` 或 `chat.final` 上明确告诉客户端这不是 user turn 结束。
- `retryReason=context_overflow`：让 UI 和日志能解释等待原因。

有了这些字段后，智码 GLM Code 可以从启发式 retry reopen 迁移到协议驱动状态机。

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| 重复收到 `phase=start` | 复用 active turn 中的 `contextCompactionMessageId`，不新增消息 |
| 收到 `phase=end` 但没有 start message | 只更新 maintenance 和 usage，不补插聊天消息 |
| `willRetry=true` 后长时间无输出 | 保持现有 maintenance grace/fallback 逻辑，超时后按已有错误或 thinking-only 兜底 |
| compaction 结束后 usage refresh 慢到达 | 只更新 usage 指标，不新增消息 |
| gateway history 含 `Compaction` | 过滤，不写入本地消息 |
| 历史 DB 已有裸 `Compaction` | renderer 隐藏或兼容，不显示普通 system 卡片 |
| 手动压缩 | 可继续现有完成消息；后续可迁移到同一 metadata 模型，`mode=manual` |
| 用户切换会话 | 消息是持久 system message，可随历史正常回放；临时 maintenance 状态不跨会话误显示 |
| 旧版本 OpenClaw 不发 compaction stream | 不显示聊天分隔线，只更新 context usage；避免 final 后追加奇怪提示 |
| `lifecycle=end` 后才发生 context overflow | 不立即 complete；进入 recoverable retry wait |
| 缺少 `chat.final`，lifecycle fallback 同步到短中间态文本 | 不立即 complete；按短 final + tool work 风险进入 recoverable retry wait |
| lifecycle fallback 最终超时完成，但 turn 曾有工具工作 | cleanup 记录为 retry-aware closed run，允许同 session 同 `runId` retry start 重开 |
| 同 `runId`、同 `sessionKey` 收到新的 `lifecycle=start` | 在合理窗口内视为 retry reopen，允许后续输出进入同一 turn |
| recently closed run 收到非 start 事件 | 继续按 late event 丢弃 |
| 手动停止后收到同 runId retry start | 不 reopen，尊重用户 stop |
| 空 final 后 history 同步到短中间态文本 | 不把它作为稳定最终答案；等待 retry 或超时兜底 |
| retry 最终输出到来时上一条 assistant 已 `isFinal=true` | 允许复用或新建 assistant segment，不能丢弃输出 |

## 6. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 在 compaction start/end 创建并更新结构化 system message；记录 active message id；修正 chat.final、lifecycle end、same-run retry 和 recentlyClosedRunIds 状态机 |
| `src/main/libs/agentEngine/types.ts` | 如需要，补充 context compaction metadata 类型 |
| `src/main/libs/agentEngine/constants.ts` 或共享 constants 文件 | 新增 compaction kind/mode/status 常量 |
| `src/main/libs/openclawHistory.ts` | 新增内部 compaction system 文本过滤 helper |
| `src/renderer/services/cowork.ts` | 移除 final usage refresh 追加自动压缩消息的逻辑 |
| `src/renderer/store/slices/coworkSlice.ts` | 如需要，支持通过 messageUpdate 合并 compaction metadata |
| `src/renderer/components/cowork/CoworkSessionDetail.tsx` | 根据 compaction metadata 渲染 running/completed/retrying/failed 分隔线；隐藏 legacy 裸文本 |
| `src/renderer/services/i18n.ts` | 新增或复用 compaction 状态文案 |
| `src/renderer/types/cowork.ts` / `src/renderer/types/electron.d.ts` | 如需要，补充 metadata 类型定义 |

## 7. 验收标准

- [ ] 自动压缩开始时，消息流当前位置出现 `上下文压缩中` 分隔线。
- [ ] 自动压缩完成时，同一条分隔线更新为完成状态。
- [ ] 最终 assistant 回答下方不再额外出现 `Compaction` 普通 system 卡片。
- [ ] final 后 context usage refresh 不再追加自动压缩完成消息。
- [ ] gateway history 中的裸 `Compaction` 不会被同步成用户可见聊天消息。
- [ ] 已有历史中的裸 `Compaction` 不再按普通 system 卡片渲染。
- [ ] `willRetry=true` 场景下 session 保持 running/maintenance，后续 assistant 文本继续进入同一 turn。
- [ ] `lifecycle=end` / 空 `chat.final` 后发生 context overflow auto-compaction 时，不提前 complete。
- [ ] OpenClaw 使用同一个 `runId` retry 时，新的 `lifecycle=start` 不会被 closed-run 防重丢弃。
- [ ] 同 `runId` retry 后的 assistant stream 和最终回答能正常显示，不停留在中间态文本。
- [ ] 真正的 late events、重复 events、手动停止后的事件仍会被过滤，不会重新打开已完成会话。
- [ ] 手动压缩行为不回退，完成后仍能看到合理提示。
- [ ] context usage indicator 的 token、percent、compaction count 仍正常刷新。

## 8. 测试计划

### 8.1 单元测试

建议补充或调整：

- `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts`
  - `compaction phase=start creates one structured system message`
  - `compaction phase=end updates the existing system message`
  - `duplicate compaction start does not append duplicate messages`
  - `compaction end without start does not append a late message`
  - `willRetry keeps context maintenance active`
  - `empty chat final after tool loop waits for recoverable retry`
  - `lifecycle fallback without chat final waits when history sync returns a short assistant segment after large tool results`
  - `lifecycle fallback retry wait accepts same-run lifecycle start before completing`
  - `lifecycle fallback timeout records retry-aware closed run for tool-work turns`
  - `lifecycle end does not flush final while retry wait is active`
  - `same runId lifecycle start reopens a recently closed retry candidate`
  - `same runId retry assistant text is not dropped as late output`
  - `manual stop still blocks same runId late lifecycle start`
  - `completed run without retry still drops late assistant text`
  - `retry final replaces or continues an interim assistant message before complete`

- `src/main/libs/openclawHistory.test.ts`
  - `filters internal compaction system labels`
  - `does not filter long user-visible system messages containing compaction`

- renderer 侧如已有测试框架可覆盖：
  - structured `context_compaction` message renders divider
  - legacy bare `Compaction` system message is hidden
  - usage count increase does not append a chat message

### 8.2 手动验证

手动验证路径：

1. 运行 `npm run electron:dev:openclaw`。
2. 构造一个会触发 OpenClaw 自动压缩的长上下文 Cowork 会话。
3. 观察压缩开始时消息流出现 active 分隔线。
4. 等待压缩结束和 retry 输出。
5. 确认最终回答下方没有额外 `Compaction` 卡片。
6. 切换会话再切回来，确认历史回放中的分隔线位置正确。

回归验证 2026-05-20 失败路径：

1. 使用能触发大量日志检索和 context overflow 的任务。
2. 观察日志中是否出现 `context overflow` / `auto-compaction succeeded` / 同 `runId` retry。
3. 确认 UI 不会停在“分析大致完成了...”这类中间态文本。
4. 确认后续真正最终回答继续流式显示。
5. 确认主进程日志不再出现同一 retry 输出被 `dropped late assistant text for a closed run` 大量丢弃。
6. 确认最终只 emit 一次 `complete`，且发生在最后一次 retry 完成后。

### 8.3 推荐命令

```bash
npm test -- openclawRuntimeAdapter
npm test -- openclawHistory
npx eslint src/main/libs/agentEngine/openclawRuntimeAdapter.ts src/main/libs/openclawHistory.ts src/renderer/services/cowork.ts src/renderer/components/cowork/CoworkSessionDetail.tsx
npm run build
```

如果全量 lint 暴露已有无关问题，应以 touched-file ESLint、相关测试和 build 结果作为本修复的主要验证信号。
