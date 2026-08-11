# 智码 GLM Code Cowork 上下文压缩接入设计文档

## 1. 概述

### 1.1 问题/背景

智码 GLM Code Cowork 当前已经基于 OpenClaw 运行对话与工具调用。OpenClaw 本身具备上下文自动压缩能力：当会话上下文接近或超过模型上下文窗口时，OpenClaw 可以压缩旧历史，保留摘要和最近消息，并继续重试原请求。

但 智码 GLM Code 当前对这个能力的产品接入还不完整：

- 对话界面没有直观展示当前上下文 token 使用量、上下文窗口大小和百分比。
- 用户无法在 智码 GLM Code 中主动触发 OpenClaw 压缩。
- OpenClaw 自动压缩发生后，智码 GLM Code 对话流中没有轻量提示，用户可能只感知到“等待变久”。
- 模型切换后，上下文窗口分母可能变化，顶部状态需要随当前模型重新计算。
- 之前 `lifecycle phase=error` fallback 会在 2 秒后主动 `chat.abort`，可能打断 OpenClaw 的自动压缩、重试或 failover 流程。
- OpenClaw 的 `Pre-compaction memory flush`、`NO_REPLY/no_reply`、memory daily file read/write 等内部维护消息可能通过 history 或 stream 暴露给 智码 GLM Code；这些内容不应作为正式聊天内容展示。
- OpenClaw Web UI 中的 `COMPACTION` 分隔符、assembled context 中的 `compactionSummary`、session checkpoint 是三个不同层级，智码 GLM Code 不能混为一谈。
- `reconcileWithHistory()` 可能替换 智码 GLM Code 本地 assistant message id，导致后续 usage/meta 回填写到旧 id，从而让 assistant 下方 token/meta 信息消失。

本分支已经先修复了最后一个问题：`lifecycle phase=error` fallback abort 从 2 秒延迟到 20 秒，并增加 runId guard，避免旧 run 的延迟 fallback 误伤新 run。

### 1.2 目标

本功能目标是以轻量方式接入 OpenClaw 上下文压缩能力，参考 Codex 的体验：

1. 在对话界面提供一个上下文使用量指示器，展示当前 token 占用百分比。
2. 悬停指示器时展示当前 used tokens、context window 和百分比。
3. 点击指示器可主动触发 OpenClaw 上下文压缩。
4. OpenClaw 自动压缩发生后，在对话流中展示一条轻量系统提示。
5. 手动压缩完成后，在对话流中展示一条轻量系统提示。
6. 模型切换后刷新上下文窗口和百分比展示。
7. 保留 OpenClaw 默认 200k context window 兜底策略，不在本功能中调整未知模型默认窗口。
8. 避免在 OpenClaw 自动压缩、重试或 failover 过程中被 智码 GLM Code 过早 abort。
9. 过滤 OpenClaw 内部 maintenance/silent 消息，避免 `Pre-compaction memory flush` 和 `NO_REPLY/no_reply` 出现在正式对话中。
10. 在确认 OpenClaw 正在做 memory flush / context maintenance 时保持 session running，并展示友好状态 `正在整理上下文...`。
11. 正确区分 checkpoint compaction 与 assembled context 中的 `compactionSummary`，避免误报“上下文已自动压缩”。
12. 在 history reconcile 后仍能把 usage/meta 写回当前最新 assistant 消息。
13. 从历史会话进入或切换会话时主动同步一次 OpenClaw context usage；同步失败或数据不完整时不展示圆环和 tooltip。

### 1.3 非目标

本设计第一版不做以下事情：

- 不实现复杂的 checkpoint 管理 UI。
- 不展示或编辑 compacted summary 的完整内容。
- 不修改 OpenClaw `models.json` 生成策略。
- 不把未知模型默认 context window 从 200k 改小。
- 不新增数据库 schema。
- 不实现自定义模型 context window 配置界面。
- 不在发送前强制拦截超过窗口的请求。
- 不做跨会话的上下文历史分析报表。
- 不把 OpenClaw assembled context 内部的 `compactionSummary` 直接渲染成一条用户可见消息。
- 不把 `NO_REPLY/no_reply` 作为“必然发生 checkpoint compaction”的信号；它只是 OpenClaw 的通用 silent token。

## 2. 用户场景

### 场景 1: 用户查看当前上下文使用量

**Given** 用户正在 Cowork 会话中对话
**When** 会话存在 OpenClaw token usage 数据
**Then** 输入框附近展示一个圆形上下文指示器

**And** 指示器按百分比展示当前上下文占用

**When** 用户悬停该指示器
**Then** tooltip 展示类似 `上下文：43% 已用，已用 86k tokens，共 200k`

**And** 指示器视觉颜色保持中性灰色，不因 warning/danger 阈值变色

**And** tooltip 只在 hover 时展示，点击后不应因 focus 状态常驻

**And** 如果没有 OpenClaw token usage 数据或缺少百分比，指示器不展示

### 场景 2: 用户主动压缩上下文

**Given** 用户看到上下文指示器
**When** 用户点击指示器
**Then** 智码 GLM Code 调用 OpenClaw 的压缩能力

**And** 压缩期间指示器展示 loading 状态

**And** 压缩完成后刷新 token 使用量

**And** 对话流中展示 `上下文已压缩。`

### 场景 3: OpenClaw 自动压缩后展示提示

**Given** 当前会话上下文接近或超过模型窗口
**When** OpenClaw 自动触发上下文压缩并成功完成
**Then** 智码 GLM Code 在对话流中展示 `OpenClaw 已自动压缩上下文。`

**And** 顶部上下文指示器刷新为压缩后的 token 使用量

### 场景 4: 模型切换后重新计算百分比

**Given** 当前会话已用 86k tokens，当前模型窗口为 200k
**When** 用户切换到窗口为 256k 的模型
**Then** 指示器应按 256k 重新计算百分比

**When** 用户切换到窗口更小的模型
**Then** 指示器应按新窗口展示更高百分比

**And** 不应继续展示旧模型下缓存的百分比

### 场景 5: 自动压缩或重试期间不被提前 abort

**Given** OpenClaw 收到 provider 的 context exceeded 或其他可恢复错误
**When** OpenClaw 进入自动压缩、重试或 failover 流程
**Then** 智码 GLM Code 不应在 2 秒后立即 `chat.abort`

**And** 只有当 20 秒后仍未收到正常 chat error/final/aborted 且当前 run 仍匹配时，才执行 lifecycle error fallback。

### 场景 6: 会话仍在运行时用户继续输入

**Given** OpenClaw 正在执行工具调用、自动压缩、重试或继续生成
**When** 用户误以为任务已结束并再次发送消息
**Then** 智码 GLM Code 应明确提示当前会话仍在运行

**And** 不应把该消息静默丢失

**And** 输入框应展示运行中状态，或禁用发送，或提供明确的“等待当前任务完成”提示

**And** 如果后续支持队列发送，也必须在 UI 中明确展示该消息处于等待状态。

### 场景 7: Pre-compaction memory flush 不污染聊天

**Given** OpenClaw 在压缩前触发 memory flush
**When** gateway history 或 stream 中出现内部 user prompt `Pre-compaction memory flush...`
**Then** 智码 GLM Code 不展示该 user prompt

**And** 如果 assistant 回复为纯 `NO_REPLY/no_reply`，智码 GLM Code 不展示该 assistant 消息

**And** 如果本轮确认发生了 memory daily file read/write，智码 GLM Code 保持 session running 并展示 `正在整理上下文...`

### 场景 8: OpenClaw 展示 COMPACTION 但没有 checkpoint

**Given** OpenClaw Web UI 在聊天中展示 `COMPACTION` 分隔符
**When** `sessions.list` 的 `compactionCheckpointCount` 仍为空或为 0，Sessions 页面显示 `COMPACTION none`
**Then** 智码 GLM Code 不插入“上下文已自动压缩”的 checkpoint 提示

**And** 智码 GLM Code 可继续展示 context usage 已超出窗口的 danger 状态

**And** 后续若出现真实 checkpoint count 增量，再插入自动压缩提示

### 场景 9: history reconcile 后 meta 仍可展示

**Given** `reconcileWithHistory()` 替换了本地消息尾部
**When** `chat.final` usage 或 delayed `chat.history` usage 回填到达
**Then** 智码 GLM Code 应校验 preferred assistant message id 是否仍存在

**And** 如果该 id 已失效，应回退到当前会话最新 assistant message

**And** assistant 消息下方仍展示 agent、input/output tokens、context percent、model 等 meta 信息

### 场景 10: 从历史会话进入后刷新 usage

**Given** 用户从侧边栏或历史列表进入一个已有 Cowork 会话
**When** 会话详情加载或 `sessionId` 切换
**Then** 智码 GLM Code 主动向 OpenClaw 同步一次 context usage

**And** 如果 OpenClaw 返回完整 token/percent 数据，输入框附近展示上下文圆环

**And** 如果 OpenClaw 暂时无法返回完整 usage，智码 GLM Code 不展示圆环，也不展示“不可用”tooltip

**And** 快速来回切换同一个会话时应做轻量 cooldown，避免频繁请求 OpenClaw

## 3. 功能需求

### FR-1: 上下文使用量数据模型

智码 GLM Code 需要为 Cowork session 维护上下文使用量状态：

```ts
type ContextUsageState = {
  sessionId: string;
  sessionKey?: string;
  model?: string;
  usedTokens?: number;
  contextTokens?: number;
  percent?: number;
  compactionCount?: number; // UI checkpoint count, must come from compactionCheckpointCount only
  status: 'unknown' | 'normal' | 'warning' | 'danger' | 'compacting';
  updatedAt: number;
};
```

百分比计算规则：

```ts
percent = contextTokens > 0 ? Math.round((usedTokens / contextTokens) * 100) : undefined;
```

状态建议：

- `unknown`: 缺少 used tokens 或 context window。
- `normal`: `< 70%`。
- `warning`: `70% - 90%`。
- `danger`: `>= 90%`。
- `compacting`: 正在执行手动压缩。

说明：

- `warning` / `danger` 是数据状态，可用于 tooltip、日志或后续策略判断；当前输入框圆环不再按这些状态变色。
- OpenClaw 自动 memory flush / pre-compaction / compaction stream 使用单独的 `contextMaintenanceSessionIds` 运行态，不复用手动压缩的 `compactingSessionIds`。

### FR-2: 数据来源优先级

上下文使用量数据按以下优先级更新：

1. OpenClaw `sessions.list` / session entry 中的 token 字段和 `contextTokens`。
2. 当前 turn 的 `chat.final` usage metadata。
3. 智码 GLM Code 本地 `models.json` 中的 `contextWindow` 作为分母兜底。
4. OpenClaw 默认 200k 作为最后兜底，由 OpenClaw 保持现有行为。

当 `sessions.list` 能提供 session 级 `contextTokens` 时，以它为准。

### FR-3: 上下文指示器 UI

在 Cowork 对话界面输入框附近增加一个圆形上下文指示器。

交互要求：

- 圆形进度展示当前百分比。
- 缺少 `percent` 时不展示圆环，也不展示“不可用”tooltip。
- 圆环始终使用中性灰色，不因 warning/danger 阈值变色。
- 不展示右上角红点或其他高占用徽标，避免和发送按钮、错误状态产生干扰。
- compacting 时可以保留旋转动画，但颜色仍保持中性灰色。
- 仅悬停展示 tooltip；点击后不应因 focus/focus-within 让 tooltip 常驻。
- tooltip 文案必须走 i18n。
- 不能遮挡输入框、模型选择、语音按钮等现有控件。
- 不引入复杂面板，第一版保持轻量。

tooltip 建议文案：

- `上下文：{percent}% 已用`
- `已用 {usedTokens} tokens，共 {contextTokens}`

当前实现 tooltip 不再追加“压缩上下文”或自动压缩说明，只保留百分比和 token 数。

### FR-4: 用户主动压缩

用户点击上下文指示器后，可以主动触发压缩。

第一版当前交互：

- 点击圆环直接触发手动压缩。
- tooltip 只展示 usage 信息，不追加“压缩上下文”命令文案。
- 不展示额外菜单，避免在输入区引入复杂交互。

主动压缩行为：

- 调用 OpenClaw `/compact` 或 gateway 对应 command。
- 压缩期间禁用重复点击。
- 压缩成功后刷新 `sessions.list`。
- 插入系统提示 `上下文已压缩。`
- 压缩失败时展示错误提示，不清理会话历史。

### FR-5: 自动压缩提示

当 OpenClaw 自动压缩发生后，智码 GLM Code 应在对话流中插入轻量系统提示：

```text
OpenClaw 已自动压缩上下文。
```

检测方式优先级：

1. 优先监听 OpenClaw gateway 明确的 compaction event。
2. 如果没有明确 event，则检测 `sessions.list` 中 `compactionCheckpointCount` 增加。
3. 如果只有 transcript/checkpoint 变化，也可作为后续补充，不作为第一版强依赖。

禁止事项：

- 不使用 `sessions.list` / session store 的内部 `compactionCount` 触发 UI 可见自动压缩提示。
- 不使用 OpenClaw Web UI 的 `COMPACTION` 分隔符作为 checkpoint 完成依据。
- 不使用 assembled context 中存在 `compactionSummary` 作为 checkpoint 完成依据。
- 不使用 `Pre-compaction memory flush` 或纯 `NO_REPLY/no_reply` 作为 checkpoint 完成依据。

提示去重要求：

- 同一个 session 的同一个 `compactionCheckpointCount` 只提示一次。
- 手动压缩成功提示和自动压缩提示不要重复。

### FR-6: 模型切换后刷新上下文窗口

模型切换后需要刷新上下文 usage：

1. 立即读取当前 session 的模型配置和 context window。
2. 重新计算 `usedTokens / contextTokens` 百分比。
3. 请求 OpenClaw `sessions.list` 或 session detail 以获得权威值。
4. 如果 OpenClaw 暂时没有刷新，先用本地模型 `contextWindow` 估算。

注意：

- 单条历史 assistant message 的 usage 可能对应旧模型。
- 会话顶部指示器应展示当前 session 当前模型对应的窗口。
- 不应只缓存百分比，应缓存 used tokens 和 context tokens 后动态计算。

### FR-7: 运行中状态与继续输入处理

当 OpenClaw session 仍在 running 时，智码 GLM Code 需要避免用户误判任务结束。

第一版建议：

- 会话 active turn 未结束时，输入框保持可见但发送按钮置为运行中/不可发送状态。
- 如果用户仍尝试发送，展示明确提示：`当前任务仍在运行，请等待完成后继续。`
- 不将用户输入静默吞掉。
- 不把 `Session ... is still running.` 这类底层错误直接作为主要用户体验文案。
- 如果 OpenClaw 正在自动压缩，优先展示更友好的状态：`正在压缩上下文并继续任务...`
- 任务真正结束前，消息列表和输入框附近都应有稳定 loading/working indicator。

后续可选增强：

- 支持“发送后排队”，当前 turn 完成后自动发送下一条用户消息。
- 队列消息必须在消息流中以 pending 状态展示，避免用户误以为没有发送。

### FR-8: 保持默认 200k 策略

本功能不修改未知模型默认 context window 策略。

原因：

- OpenClaw 默认 fallback 是 200k。
- 用户可能配置大量自定义模型，智码 GLM Code 无法精确知道所有模型窗口。
- 贸然改小默认窗口会影响常规模型体验，导致过早压缩。

后续如果服务端能提供 智码 GLM Code server 模型 metadata，可以优先让可控模型写准 `contextWindow`，但不属于本功能第一版。

### FR-9: lifecycle error fallback 修复

本分支已完成以下修复：

- 将 lifecycle error fallback abort 延迟从 2 秒改为 20 秒。
- 增加 `eventRunId` 参数，timer 触发时检查当前 active turn 是否仍包含原 runId。
- 如果用户在 fallback 等待期间开启了新 run，旧 timer 不会影响新 run。
- 保留用户手动 stop 时立即 `chat.abort` 的行为。
- 增加关键日志区分：
  - 用户手动 stop abort。
  - lifecycle error fallback 等待后 abort。

相关文件：

- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
- `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts`

### FR-10: OpenClaw silent / maintenance 消息过滤

智码 GLM Code 需要过滤以下 OpenClaw 内部消息：

1. assistant/system 角色的纯 `HEARTBEAT_OK`。
2. assistant/system 角色的纯 `NO_REPLY/no_reply`。
3. user 角色的 heartbeat prompt。
4. user 角色的 `Pre-compaction memory flush` prompt。
5. 已识别为 context maintenance 的 memory daily file read/write tool events。

识别规则应保持窄口径：

- `NO_REPLY/no_reply` 只有在整条文本为 silent token 时过滤。
- `Pre-compaction memory flush` 必须包含关键 marker，例如 `pre-compaction memory flush`、`store durable memories only in memory/`、`reply with no_reply`。
- memory maintenance tool 仅识别 `read` / `write` 且目标路径匹配 `memory/YYYY-MM-DD.md`。
- 普通 `write index.html`、普通 tool/tool_result、普通 assistant/user 消息不得被 suppress。

涉及路径：

- history reconcile: `extractGatewayHistoryEntry()` / `extractGatewayHistoryEntries()`
- transient session history
- channel sync history
- `handleChatDelta()`
- `processAgentAssistantText()`
- `handleChatFinal()`
- `syncFinalAssistantWithHistory()`

### FR-11: Pre-compaction memory maintenance 运行态

当满足以下条件时，智码 GLM Code 应进入 context maintenance running state：

1. 当前 active turn 收到 memory daily file read/write tool event。
2. 后续 `chat.final` 文本为纯 `NO_REPLY/no_reply`。

处理策略：

- 不创建或保留 assistant `NO_REPLY/no_reply` 消息。
- 不展示对应 memory maintenance tool_use/tool_result。
- session 保持 `running`。
- renderer 显示 i18n 文案：
  - zh: `正在整理上下文...`
  - en: `Organizing context...`
- 等待 OpenClaw 后续同 session run/lifecycle/tool/assistant 事件。
- 当前实现使用 `SILENT_MAINTENANCE_FOLLOWUP_GRACE_MS = 60_000` 作为 watchdog：
  - follow-up 事件到来则取消等待，继续真实任务输出。
  - 60 秒内无后续事件则安全 complete，避免永久 loading。

说明：

- 这不是纯定时器方案，而是事件驱动为主、timer 兜底。
- 该 watchdog 只用于 confirmed maintenance / silent follow-up 等内部维护路径，不用于普通 assistant final；普通 `chat.final` completion grace 当前为 `800ms`。
- 如果 OpenClaw 后续提供明确 `memoryFlush.end` / `willContinue` / `followupRunId` 语义，应改为完全事件驱动，timer 仅保留异常 watchdog。

### FR-12: Usage/meta 回填必须处理消息 id 替换

`reconcileWithHistory()` 可能用 authoritative gateway history 替换本地 user/assistant 消息尾部，因此 active turn 保存的 `assistantMessageId` 可能在最终 usage 回填时已经失效。

处理策略：

1. usage/meta 回填前先检查 preferred assistant message id 是否仍存在且类型为 assistant。
2. 如果 preferred id 已失效，回退到当前 session 最新 assistant message。
3. 对 `applyUsageMetadataFromFinal()` 和 `syncUsageMetadata()` 两条路径都适用。
4. 回填成功后通过 `messageUpdate` 通知 renderer，保持 token/meta 展示。

该修复避免以下用户可见问题：

- assistant 下方 agent name、input/output tokens、context percent、model 不展示。
- final payload 本身有 usage，但 UI 看起来像没有 usage。

## 4. 实现方案

### 4.1 Main Process: OpenClaw runtime adapter

涉及文件：

- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
- `src/main/libs/agentEngine/coworkEngineRouter.ts`
- `src/main/preload.ts`
- `src/main/main.ts`

建议职责：

1. 维护 session context usage cache。
2. 从 gateway event、`sessions.list` 和 final usage 更新 token 数据。
3. 检测 `stream: "compaction"` 事件或 `compactionCheckpointCount` 变化并发出 context usage update event。
4. 提供手动 compact 方法给 IPC。

当前实现事件：

```ts
this.emit('contextUsageUpdate', sessionId, usage);
```

说明：

- OpenClaw runtime adapter 监听 OpenClaw gateway 的 `stream: "compaction"` agent event。
- `data.phase === "start"` 时保持 session 为 `running`，避免自动压缩期间 loading 丢失。
- `data.phase === "end"` 且 `completed === true` 时立即刷新 context usage，并在短延迟后再刷新一次，以覆盖 session store 稍晚落盘的情况。
- `CoworkEngineRouter` 转发 `contextUsageUpdate` 到 main process。
- main process 通过 `cowork:stream:contextUsage` IPC 推送给 renderer。

### 4.2 IPC / Preload

当前新增或扩展 Cowork IPC：

- `cowork:session:contextUsage`
  - renderer/preload: `window.electron.cowork.getContextUsage(sessionId)`
  - main: `getCoworkEngineRouter().getContextUsage(sessionId)`
  - runtime: 通过 OpenClaw `sessions.list` 查找当前 session key，并返回 `CoworkContextUsage`
- `cowork:session:compactContext`
  - renderer/preload: `window.electron.cowork.compactContext(sessionId)`
  - main: `getCoworkEngineRouter().compactContext(sessionId)`
  - runtime: 调用 OpenClaw `sessions.compact`
- `cowork:stream:sessionStatus`
  - main 主动推送 session running/completed/error 状态变化，用于修复 loading 丢失。
- `cowork:stream:contextUsage`
  - main 主动推送 OpenClaw compaction event 后刷新得到的 usage。
- `cowork:stream:contextMaintenance`
  - main 主动推送 context maintenance running 状态。
  - renderer 用于展示 `正在整理上下文...` / `Organizing context...`。
  - 仅在确认 memory daily file read/write maintenance 时使用，不用于普通 tool run。

如果现有 `cowork` stream event 已能承载 session update，也可以复用现有事件，避免新增过多 IPC channel。

### 4.3 Renderer 状态

涉及文件：

- `src/renderer/store/slices/coworkSlice.ts`
- `src/renderer/services/cowork.ts`
- `src/renderer/types/cowork.ts`

建议在 cowork slice 中增加：

```ts
contextUsageBySessionId: Record<string, ContextUsageState>;
```

状态更新来源：

- 初始化/切 session 时主动 refresh。
- `CoworkSessionDetail` 根据 `sessionId` mount/switch 时主动 refresh，用于覆盖当前 session 已在 Redux 中但详情视图重新进入的历史会话路径。
- 收到 main process context usage update。
- 收到 model switch 成功事件后 refresh。
- 手动 compact 成功后 refresh。
- 收到 OpenClaw `stream: "compaction"` end/completed 后由 main 主动 refresh 并推送。
- 收到 assistant/tool/user stream message 时，如果当前 session 仍在运行，保守恢复 `running` 状态。
- 收到 `Session ... is still running.` 并发保护错误时，不标记为终止性 error，而是恢复 running 并提示用户等待。
- 收到 `cowork:stream:contextMaintenance` 时维护 `contextMaintenanceSessionIds`。
- context maintenance active 时，StreamingActivityBar 优先展示 `coworkContextMaintenanceRunning`。

当前实现细节：

- `refreshContextUsageForSessionEntry(sessionId)` 专门用于历史进入/切换会话时同步 usage。
- 该入口带 `SESSION_ENTRY_CONTEXT_USAGE_REFRESH_COOLDOWN_MS = 1500` 的 per-session cooldown，避免快速来回切换时重复请求 OpenClaw。
- `refreshContextUsage()` 对 IPC 不存在、OpenClaw 返回失败、usage 为空和 IPC throw 都返回 `null`，不会展示不可用 tooltip，也不会产生未处理 promise rejection。
- usage 只写入 renderer Redux `contextUsageBySessionId` 运行期缓存；当前不新增数据库 schema，不持久化 usage 快照。
- runtime `getContextUsage(sessionId)` 优先按当前 OpenClaw session key 调用 `sessions.list({ search: key, limit: 5 })` 做 targeted lookup；命中后直接返回，减少历史会话首次进入时“先查近期活跃列表、再查历史”的额外延迟。
- targeted lookup 失败或未命中时，再回退到 `sessions.list({ activeMinutes: 120, limit: 120 })` 查近期活跃会话，最后才使用模型 context window cache 返回 unknown usage。
- usage lookup 日志记录解析路径和耗时，便于排查历史会话圆环延迟；日志只包含 session id、路径和耗时，不记录 prompt 或模型回复内容。

### 4.4 Renderer UI

涉及文件：

- `src/renderer/components/cowork/CoworkView.tsx`
- `src/renderer/components/cowork/CoworkSessionDetail.tsx`
- `src/renderer/components/cowork/CoworkPromptInput.tsx`
- 可新增 `ContextUsageIndicator.tsx`

建议新增组件：

```tsx
<ContextUsageIndicator
  usage={usage}
  compacting={compacting}
  onCompact={handleCompact}
  onRefresh={handleRefresh}
/>
```

UI 要求：

- 使用现有主题变量和 Tailwind 风格。
- 圆形指示器尺寸稳定，不因 tooltip 或状态变化导致输入框跳动。
- 圆环固定为中性灰色，显示进度但不按 warning/danger 变色。
- 不展示高占用红点；高占用状态只体现在 tooltip 数字或后续策略里。
- tooltip 仅由 hover 触发，不使用 focus-within 触发，避免点击后 tooltip 常驻。
- 缺少 `percent` 时组件返回 `null`，不显示空圈或“不可用”提示。
- tooltip 和按钮文案走 `i18n`。
- 不影响移动/窄宽布局；空间不足时只展示图标，tooltip 仍可访问。

### 4.5 对话提示

自动/手动压缩成功后，建议插入 `system` 类型消息。

元数据建议：

```ts
metadata: {
  kind: 'context_compaction',
  mode: 'auto' | 'manual',
  compactionCount, // 第一版保存用于去重的 checkpoint count
}
```

插入策略：

- 只对当前 智码 GLM Code session 插入。
- 同一个 checkpoint count 去重。
- 如果压缩发生时用户正在等待回复，提示应出现在对应 turn 的消息流中，但不打断 assistant streaming。
- 压缩提示属于 `context_compaction` system message，渲染时应拆成独立后续 turn，避免插入到 assistant 正文与文件/链接卡片之间。
- `Pre-compaction memory flush`、memory daily file read/write、纯 `NO_REPLY/no_reply` 不插入 `system` 或 assistant 消息。

### 4.6 手动压缩调用

OpenClaw 支持 `/compact` 命令，同时源码确认 gateway 有专用 RPC：

```ts
client.request('sessions.compact', {
  key: sessionKey,
});
```

对应 OpenClaw 源码：

- `/Users/zhiqiangliu/Desktop/disk/WORK/claw/openclaw/src/gateway/server-methods/sessions.ts`
- `/Users/zhiqiangliu/Desktop/disk/WORK/claw/openclaw/src/gateway/protocol/schema/sessions.ts`

`sessions.compact` 参数：

```ts
{
  key: string;
  maxLines?: number;
}
```

`sessions.compact` 返回：

```ts
{
  ok: boolean;
  key: string;
  compacted: boolean;
  reason?: string;
  result?: {
    tokensAfter?: number;
    summary?: string;
  };
}
```

当前 智码 GLM Code 第一版使用专用 `sessions.compact` RPC，不通过发送 `/compact` 文本模拟用户消息，避免污染聊天历史。

手动压缩流程：

1. 用户点击 `ContextUsageIndicator`。
2. 如果当前会话仍在 `running`、streaming 或 context maintenance 中，不发起压缩，toast 提示 `coworkContextCompactBlockedRunning`。
3. renderer 使用应用内 `Modal` 弹出确认文案，不使用 native `window.confirm`。
4. `coworkService.compactContext(sessionId)` 设置 `compactingSessionIds`，并启动 watchdog 兜底清理。
5. preload 调用 `cowork:session:compactContext`。
6. main 调用 `CoworkEngineRouter.compactContext(sessionId)`。
7. OpenClaw runtime adapter 解析 智码 GLM Code session 对应的 OpenClaw `sessionKey`。
8. 调用 OpenClaw `sessions.compact`。
9. 成功后刷新 `getContextUsage(sessionId)`。
10. renderer 插入 `system` 消息：
   - compacted: `上下文已压缩。`
   - noop: `当前上下文无需压缩。`
11. 无论成功失败都清理 compacting 状态；如果 RPC/IPC 异常导致 Promise 未正常 settle，watchdog 会自动清理 stale compacting 状态，避免输入交互长期被软拦截。

压缩期间发送策略：

- 不因为 `compactingSessionIds` 把发送按钮硬禁用，避免异常状态导致按钮永久不可用。
- 用户在手动压缩期间提交消息时，`coworkService.continueSession()` 做软拦截，toast 提示 `coworkContextCompactingSendBlocked`，不创建用户消息、不切换成 error，且 `CoworkPromptInput` 必须保留当前输入内容与附件。
- OpenClaw 源码中 `queueEmbeddedPiMessage()` 在 `handle.isCompacting()` 时会返回 false，因此不能假设 compacting 期间的用户消息一定会被 OpenClaw 排队。
- OpenClaw `sessions.compact` 在 manual compact 且未传 `maxLines` 时会先调用 `interruptSessionRunIfActive(...)`，所以 智码 GLM Code 不允许在任务仍运行时主动压缩，避免打断正在执行的用户任务。

### 4.7 OpenClaw 已确认 API 与事件

本节基于本地 OpenClaw 源码确认：

```text
/Users/zhiqiangliu/Desktop/disk/WORK/claw/openclaw
```

#### 4.7.1 `sessions.list`

OpenClaw `sessions.list` 返回 session index，关键字段来自：

- `src/gateway/session-utils.types.ts`
- `src/gateway/session-utils.ts`
- `src/gateway/server-methods/sessions.ts`

智码 GLM Code 当前使用字段：

```ts
{
  key: string;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  modelProvider?: string;
  model?: string;
  status?: 'running' | 'done' | 'failed' | 'killed' | 'timeout';
  compactionCheckpointCount?: number;
  latestCompactionCheckpoint?: {
    checkpointId: string;
    reason: 'manual' | 'auto-threshold' | 'overflow-retry' | 'timeout-retry';
    createdAt: number;
    tokensBefore?: number;
    tokensAfter?: number;
  };
}
```

注意：

- `sessions.list` 对 UI 可见的是 `compactionCheckpointCount`，不是 store 内部的 `compactionCount`。
- store 内部的 `compactionCount` 会在 manual/auto compaction 后递增，但 first-version UI 以 `compactionCheckpointCount` 和 `latestCompactionCheckpoint` 作为更可展示的 checkpoint 依据。
- 2026-05-09 实测确认：memory flush 或内部计数变化可能让 `compactionCount` 变化，但 OpenClaw Sessions 页面仍显示 `COMPACTION none`；因此 智码 GLM Code 已改为只使用 `compactionCheckpointCount` 触发自动压缩提示。
- `contextTokens` 是运行时估算/报告值，不能当作严格模型窗口保证；最终分母仍以 OpenClaw 返回值优先。

#### 4.7.2 `sessions.compact`

OpenClaw 专用手动压缩 RPC：

```ts
client.request('sessions.compact', {
  key: sessionKey,
});
```

行为：

- 如果 session 没有 `sessionId`，返回 `compacted: false, reason: "no sessionId"`。
- 如果没有 transcript，返回 `compacted: false, reason: "no transcript"`。
- 如果未传 `maxLines`，走 embedded manual compaction。
- 成功后 OpenClaw session store 会更新：
  - `compactionCount += 1`
  - 清理旧的 `inputTokens/outputTokens`
  - 如果有 `tokensAfter`，写入 `totalTokens` 并标记 `totalTokensFresh`

#### 4.7.3 `stream: "compaction"` agent event

OpenClaw 自动压缩会发明确 agent event，来源：

- `src/agents/pi-embedded-subscribe.handlers.compaction.ts`

事件形态：

```ts
// start
{
  stream: 'compaction',
  data: { phase: 'start' },
}

// end
{
  stream: 'compaction',
  data: {
    phase: 'end',
    willRetry: boolean,
    completed: boolean,
  },
}
```

智码 GLM Code 处理策略：

- `phase=start`: session 维持 `running`，向 renderer 推送 `cowork:stream:sessionStatus`。
- `phase=end`: session 仍维持 `running`，因为 `willRetry=true` 时 OpenClaw 会继续同一任务。
- `phase=end && completed=true`: 主动刷新 context usage 并发送 `cowork:stream:contextUsage`。
- 自动压缩提示由 renderer 根据 `compactionCheckpointCount` 增量去重插入，避免只依赖普通聊天文本或 `COMPACTION` 分隔符。

### 4.8 `chat.final` 与 loading 状态修复

人工测试确认 OpenClaw 可能在同一 run 内出现：

```text
chat.final -> context overflow -> auto-compaction -> retry -> tool/assistant stream continues
```

因此 `chat.final` 不能作为唯一最终完成信号。当前实现：

1. `handleChatFinal()` 不再立即 `emit('complete')`。
2. 先调用 `deferChatFinalCompletion()`，延迟 `CHAT_FINAL_COMPLETION_GRACE_MS = 800`。
3. 如果 grace window 内同一 active turn 收到以下事件，则取消 completed 并恢复 running：
   - `chat.delta`
   - `stream: "assistant"`
   - `stream: "tool"` / `stream: "tools"`
   - `stream: "compaction"`
   - 非 `phase=end` 的 lifecycle event
4. 如果 grace window 内没有后续活动，则正常完成：
   - session status 更新为 `completed`
   - emit `complete`
   - cleanup active turn

该策略覆盖 2026-05-08 日志中 `19:54:03 chat.final` 后 `19:54:05 overflow retry` 的场景，同时避免正常完成路径长期卡住。

### 4.9 Silent maintenance run 处理

2026-05-09 实测中，OpenClaw 在上下文接近阈值时会先做 memory flush：

```text
memoryFlush triggered
OpenClaw inserts internal user turn: Pre-compaction memory flush...
assistant final: NO_REPLY
seconds later: follow-up run continues the original user request
```

智码 GLM Code 当前处理：

1. `openclawHistory.ts` 过滤 history 中的内部 prompt 和 silent token。
2. `openclawRuntimeAdapter.ts` 在 stream path 过滤 `NO_REPLY/no_reply`，避免短暂闪现。
3. `isContextMaintenanceToolEvent()` 识别 read/write `memory/YYYY-MM-DD.md`。
4. 对已识别 maintenance tool 的 `toolCallId` 记录到 `contextMaintenanceToolCallIds`，确保 start/update/result 都被 suppress。
5. `handleChatFinal()` 遇到 `NO_REPLY/no_reply`：
   - 如果本轮有 context maintenance tool，则进入 60 秒 follow-up grace。
   - 否则仅作为普通 silent token suppress，并正常结束。
6. context maintenance active 时通过 `cowork:stream:contextMaintenance` 通知 renderer。

边界：

- 普通 `NO_REPLY/no_reply` 只代表 silent token，不代表 pre-compaction。
- 普通 `write` 文件不会触发 maintenance 逻辑。
- heartbeat 仍按原有 heartbeat suppress 逻辑处理。

### 4.10 Compaction summary、COMPACTION 分隔符与 checkpoint 的区别

OpenClaw 里至少存在三种容易混淆的“压缩”信号：

1. **assembled context 中的 `compactionSummary`**
   - OpenClaw 在构造 prompt/context 时插入的摘要段。
   - `context-diag` 里会看到 `roleCounts=...,compactionSummary:1,...`。
   - OpenClaw Chat UI 可能显示 `COMPACTION` 分隔符。
   - 不一定对应新的 checkpoint。
2. **session checkpoint compaction**
   - `sessions.list` 返回 `compactionCheckpointCount` 和 `latestCompactionCheckpoint`。
   - Sessions 页面显示 checkpoint 数量和 `Show checkpoints`。
   - 智码 GLM Code 自动压缩提示只认这一层。
3. **memory flush / pre-compaction maintenance**
   - `Pre-compaction memory flush` 内部 user prompt。
   - memory daily file read/write。
   - assistant 可能回复 `NO_REPLY/no_reply`。
   - 这是压缩前维护动作，不等于 checkpoint 已完成。

2026-05-09 实测中，OpenClaw Chat UI 显示 `COMPACTION` 分隔符，并且 context usage 达到约 `80.3k / 60k`；但 Sessions 页面 `COMPACTION none`，`compactionCheckpointCount` 仍为空。因此 智码 GLM Code 不应插入“上下文已自动压缩”提示。

### 4.11 Usage/meta 回填容错

`handleChatFinal()` 当前会先 reconcile gateway history，再写 usage/meta。reconcile 可能替换消息 id，导致 `turn.assistantMessageId` 失效。

当前实现新增 helper：

```ts
resolveAssistantMessageIdForUsage(sessionId, preferredMessageId)
```

逻辑：

1. 如果 preferred id 仍存在且是 assistant，使用 preferred id。
2. 否则扫描当前 session messages，取最新 assistant message。
3. 两条 usage 路径都使用该 helper：
   - `applyUsageMetadataFromFinal()`
   - `syncUsageMetadata()`

这保证了 assistant 底部 meta 不会因为 history reconcile 替换消息 id 而消失。

## 5. 本分支已完成改动

### 5.1 延迟 lifecycle error fallback abort

已完成：

- `LIFECYCLE_ERROR_FALLBACK_DELAY_MS = 20_000`。
- `handleAgentLifecycleEvent(sessionId, data, eventRunId?)` 捕获 runId。
- timer 触发时重新读取 active turn。
- 如果当前 turn 不包含原 runId，则直接跳过。
- fallback abort 日志改为说明“等待 retry grace window 后 abort”。

收益：

- OpenClaw 有时间执行自动压缩、重试和 failover。
- 保留死锁兜底能力。
- 避免旧 timer 影响新 turn。

### 5.2 手动 stop 日志

已完成：

- 用户主动停止时增加日志：`user requested stop, aborting gateway run ...`。

收益：

- 后续排查 `chat.abort` 来源时，可以区分用户主动 stop 和自动 fallback abort。

### 5.3 回归测试

已完成测试：

- `lifecycle error fallback waits before aborting a gateway run`
  - 2 秒后不会 abort。
  - 20 秒后仍未恢复才 abort。
- `lifecycle error fallback ignores a later run for the same session`
  - 旧 run 的 timer 不会 abort 新 run。
- `chat final completes after the retry grace window`
  - 普通 `chat.final` 在 800ms grace 后仍会正常完成。
- `chat final completion is canceled when the same run continues streaming`
  - `chat.final` 后同一 run 继续产生 stream 时，不会把 UI 置为 completed。
  - session 保持 `running`，active turn 不被清理。

验证命令：

```bash
npm test -- openclawRuntimeAdapter
npx tsc -p electron-tsconfig.json --noEmit
npx tsc -p tsconfig.json --noEmit
npx eslint src/main/libs/agentEngine/openclawRuntimeAdapter.ts src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts
```

### 5.4 Context usage 与手动压缩接入

已完成：

- 新增 `CoworkContextUsage` 类型，包含：
  - `sessionId`
  - `sessionKey`
  - `usedTokens`
  - `contextTokens`
  - `percent`
  - `compactionCount`
  - `latestCompactionCheckpointId`
  - `latestCompactionReason`
  - `latestCompactionCreatedAt`
  - `model`
  - `status`
  - `updatedAt`
- OpenClaw runtime adapter 新增：
  - `getContextUsage(sessionId)`
  - `compactContext(sessionId)`
  - `contextUsageUpdate` event
- main process 新增 IPC：
  - `cowork:session:contextUsage`
  - `cowork:session:compactContext`
  - `cowork:stream:contextUsage`
- preload 暴露：
  - `getContextUsage`
  - `compactContext`
  - `onStreamContextUsage`
- renderer store 新增：
  - `contextUsageBySessionId`
  - `compactingSessionIds`
  - `notifiedCompactionBySessionId`
- renderer service 新增：
  - `refreshContextUsage`
  - `compactContext`
  - compaction 去重提示逻辑
- UI 新增：
  - `ContextUsageIndicator`
  - `CoworkSessionDetail` 输入区附近接入 indicator
  - 点击确认后触发手动 compact
  - 圆环固定灰色，去掉高占用红点，tooltip 仅 hover 展示
  - 历史会话进入/切换时触发一次 OpenClaw usage 同步
- i18n 新增中英文文案：
  - context usage tooltip
  - manual compact confirm
  - compacting 状态
  - manual/auto compact system message
  - context maintenance 状态：`正在整理上下文...` / `Organizing context...`

### 5.5 OpenClaw compaction event 接入

已完成：

- adapter 监听 `stream: "compaction"`。
- `phase=start` 时推送 running 状态。
- `phase=end` 时保持 running，避免 `willRetry=true` 期间 loading 消失。
- `phase=end && completed=true` 后刷新 context usage。
- context usage 通过 `cowork:stream:contextUsage` 推送给 renderer。
- renderer 根据 usage 中的 checkpoint count 增量插入自动压缩提示。

### 5.6 运行中状态与重复发送处理

已完成：

- `ensureActiveTurn()` 创建或重建 turn 时会 emit `sessionStatus: running`。
- renderer 监听 `cowork:stream:sessionStatus` 并同步 Redux session status。
- renderer 收到 user/assistant/tool stream message 时会保守恢复 running。
- `messageUpdate` 仅在非 final metadata 时恢复 running，避免 usage 回填把 completed 会话误拉回 running。
- 收到 `Session ... is still running.` 这类并发保护错误时：
  - 不标记为 error。
  - 恢复 running。
  - 展示友好提示 `当前任务仍在运行，请等待完成后继续。`
- 输入框在 streaming 时按发送快捷键，也展示同一友好提示，避免用户以为消息被吞。

### 5.7 Silent / pre-compaction maintenance 过滤

已完成：

- `openclawHistory.ts`
  - 新增 `isSilentTokenText(text)`，识别纯 `NO_REPLY/no_reply`。
  - 新增 `isPreCompactionMemoryFlushPromptText(text)`，识别 OpenClaw 内部 `Pre-compaction memory flush` user prompt。
  - `shouldSuppressHeartbeatText()` 扩展为 suppress assistant/system 的 `HEARTBEAT_OK` / `NO_REPLY`，以及 user 的 heartbeat prompt / pre-compaction prompt。
- `openclawRuntimeAdapter.ts`
  - assistant stream、chat delta、chat final 路径 suppress 纯 `NO_REPLY/no_reply`。
  - memory daily file read/write 被识别为 context maintenance tool event。
  - maintenance tool 的 start/update/result 都不作为正式 tool_use/tool_result 展示。
  - confirmed maintenance + `NO_REPLY` final 保持 running，并进入 60 秒 follow-up grace。
  - follow-up 事件到来后取消 maintenance waiting，继续正常真实输出。
- renderer
  - 新增 `contextMaintenanceSessionIds`。
  - 新增 `cowork:stream:contextMaintenance` IPC。
  - StreamingActivityBar 在 context maintenance active 时展示 `正在整理上下文...`。

已完成测试：

- history 过滤纯 silent token assistant messages。
- history 过滤 pre-compaction memory flush user messages。
- detector 边界测试。
- reconcileWithHistory 过滤 pre-compaction prompt + `NO_REPLY`。
- collectChannelHistoryEntries 过滤 `NO_REPLY`。
- memory maintenance `NO_REPLY` 不 emit assistant message，且保持 running 等待 follow-up。
- follow-up run 开始后取消 maintenance waiting。
- 普通 `write` 文件不触发 maintenance 逻辑。

### 5.8 Checkpoint 误判修复

已完成：

- `buildContextUsageFromSessionRow()` 不再把 OpenClaw 内部 `compactionCount` 当作 UI 可见 checkpoint count。
- 自动压缩提示只依据 `compactionCheckpointCount`。
- 如果 OpenClaw Chat UI 显示 `COMPACTION` 分隔符，但 Sessions 页面仍是 `COMPACTION none`，智码 GLM Code 不插入“上下文已自动压缩”提示。

已完成测试：

- `compactionCount: 1` 且无 `compactionCheckpointCount` 时，`CoworkContextUsage.compactionCount` 为 undefined。
- 同时存在 `compactionCount` 和 `compactionCheckpointCount` 时，只使用 `compactionCheckpointCount`。

### 5.9 Assistant meta 回填修复

已完成：

- 新增 `resolveAssistantMessageIdForUsage(sessionId, preferredMessageId)`。
- `applyUsageMetadataFromFinal()` 和 `syncUsageMetadata()` 写 meta 前都会校验 preferred id。
- preferred id 失效时，回退到当前 session 最新 assistant message。
- 回填成功后继续通过 `messageUpdate` 通知 renderer。

已完成测试：

- preferred assistant message id 被 history reconcile 替换后，usage/meta 仍能写到最新 assistant message。

### 5.10 历史会话 usage 同步与圆环交互修复

已完成：

- `coworkService.loadSession()` 成功加载历史会话后调用 `refreshContextUsageForSessionEntry(sessionId)`。
- `CoworkSessionDetail` 在 `sessionId` mount/switch 时也调用 `refreshContextUsageForSessionEntry(sessionId)`，覆盖“当前 session 已在 Redux 中、详情视图重新进入”的路径。
- `refreshContextUsageForSessionEntry()` 使用 1.5 秒 per-session cooldown，避免快速来回切换时重复请求 OpenClaw。
- runtime usage 查询优先使用 targeted `sessions.list(search=sessionKey)`，避免历史会话先 miss 近期 active list 后再二次查询造成可见延迟。
- targeted lookup 未命中或异常时，仍回退到近期 active list 和本地 context window cache，不影响当前会话或历史会话的基本展示。
- `refreshContextUsage()` 兜住 IPC 不存在、OpenClaw 返回失败、usage 为空和 IPC throw；失败时只返回 `null` 并保持圆环隐藏。
- `ContextUsageIndicator` 在缺少 `percent` 时不渲染，避免展示“上下文使用量暂不可用”的 tooltip。
- tooltip 只通过 hover 展示，不再使用 `group-focus-within`，避免点击圆环后 tooltip 常驻。
- 圆环视觉固定为灰色；去掉 warning/danger 变色和右上角高占用红点。
- compacting 状态仍可旋转，但颜色保持灰色。

边界说明：

- 当前 usage 是 renderer Redux 内存缓存，不持久化到数据库；应用重启或 renderer 刷新后需要重新向 OpenClaw 同步。
- 快速切换历史会话时，异步返回按 `sessionId` 写入 `contextUsageBySessionId`，不会覆盖当前会话内容。

## 6. 测试计划

### 6.1 Unit Tests

需要覆盖：

- context usage 百分比计算。
- used/context 缺失时为 unknown。
- warning/danger 状态阈值。
- context usage 缺少 `percent` 时圆环不展示。
- 圆环固定灰色，不按 warning/danger 状态变色。
- tooltip 只 hover 展示，点击后不会常驻。
- 历史会话进入/切换时触发 usage refresh，并带 per-session cooldown。
- 历史会话 usage 优先通过 targeted session key lookup 命中，不先依赖近期 active list。
- targeted usage lookup 未命中时，仍会回退到近期 active list 和 unknown usage。
- context usage refresh 失败或 IPC throw 时安全返回 `null`。
- compaction checkpoint count 增加只插入一次自动压缩提示。
- 手动压缩成功插入手动提示，且提示显示在当前消息正文和文件/链接卡片之后。
- 手动压缩期间误发送会保留输入框内容和附件。
- 模型切换后用新 context window 重新计算。
- 手动 compact 过程中重复点击被忽略。
- compact API 失败时展示错误且不清理 session。
- `chat.final` 后同 run 继续 stream 时取消 completed。
- `stream: "compaction"` start/end 期间保持 running。
- `NO_REPLY/no_reply` 在 stream/final/history/channel sync 中不展示。
- memory maintenance `NO_REPLY` 保持 running 并等待 follow-up。
- 普通 tool write 不误触发 maintenance。
- `compactionCount` 不触发自动压缩提示，只有 `compactionCheckpointCount` 触发。
- usage/meta 回填在 assistant id 被替换后仍能落到最新 assistant。

### 6.2 Integration Tests

需要覆盖：

- `sessions.list` 返回 token 数据后，renderer 收到 context usage update。
- 从历史会话进入时，renderer 主动调用 `cowork:session:contextUsage` 并更新圆环。
- `chat.final` usage 更新后，当前 session 指示器刷新。
- `stream: "compaction"` end/completed 后触发 usage refresh。
- `compactionCheckpointCount` 从 0 到 1 时插入自动压缩提示。
- 切换模型后触发 refresh。
- lifecycle error fallback 不会在 2 秒打断 OpenClaw 恢复流程。
- `chat.final` 后 800ms grace 内出现 overflow retry stream 时，输入框和 loading 保持 running。
- pre-compaction memory flush 后不展示内部 prompt、memory tool、`NO_REPLY`。
- OpenClaw Chat UI 显示 `COMPACTION` 但 Sessions 页面 checkpoint 为 none 时，智码 GLM Code 不提示“已自动压缩”。
- history reconcile 发生后，assistant 底部 token/meta 仍显示。

### 6.3 Manual QA

手动验证场景：

1. 正常短会话拿到 usage 后显示灰色上下文圈。
2. 长会话仍显示灰色圆环，tooltip 中百分比和 token 数正确。
3. hover tooltip 数字正确，点击后鼠标移开 tooltip 消失。
4. 点击手动压缩，压缩中 loading，完成后提示和百分比刷新。
5. 自动压缩触发后，对话流出现提示。
6. 切换大窗口模型，百分比下降。
7. 切换小窗口模型，百分比上升。
8. 手动 stop 仍立即停止。
9. IM/channel session 不因新事件崩溃。
10. macOS 和 Windows 下 UI 布局稳定。
11. 重启或刷新 renderer 后首次进入历史会话，OpenClaw 返回 usage 前不展示圆环；返回完整 usage 后展示圆环。

## 7. 兼容性与风险

### 7.1 老用户覆盖安装

第一版不改数据库 schema，不迁移历史数据，不改变 OpenClaw state 文件格式。

因此老用户覆盖安装主要风险来自 UI 新状态缺省值，需保证：

- 没有 usage 数据或缺少 `percent` 时不展示圆环，而不是报错或展示“不可用”提示。
- 没有 sessionKey 时不调用 compact。
- OpenClaw gateway 不支持 compact API 时给出可恢复错误。

### 7.2 自定义模型

自定义模型 context window 可能不准确。

第一版策略：

- 保持 OpenClaw 默认 200k 兜底。
- 不对未知模型强行改小窗口。
- context exceeded 后依赖 OpenClaw overflow recovery 和 智码 GLM Code 延迟 abort 修复。

开发测试策略：

- 测试期间曾临时将 智码 GLM Code 同步给 OpenClaw `models.json` 的 `contextWindow` override 设为 `60_000`，用于更容易触发 memory flush / pre-compaction / overflow 相关路径。
- 该测试 override 已在发布前移除，生产逻辑恢复为：仅当 provider 本身声明 `modelDefaults.contextWindow` 时同步该值；未知模型不强行写入窗口，继续由 OpenClaw 使用默认 `200k` 兜底。
- 测试覆盖值仅影响 智码 GLM Code 同步给 OpenClaw 的模型配置；如果 OpenClaw provider catalog 对某模型有更高优先级，最终分母仍应以 OpenClaw `sessions.list` 返回的 `contextTokens` 为准。
- 即使 OpenClaw 在测试期间按 `60_000` 计算 usage 和阈值，底层 provider/model 可能实际可接收超过 60k 的上下文；因此 `80k / 60k` 不必然意味着 provider 已拒绝，也不必然意味着 checkpoint compaction 已生成。

### 7.3 性能与内存

需要避免：

- 对所有 sessions 高频轮询。
- 每条 stream delta 都触发 renderer 重渲染。
- tooltip 或 indicator 状态变化导致输入框布局抖动。

建议：

- 只刷新当前 session 的 context usage。
- 历史会话进入/切换时刷新 usage 需要短 cooldown，避免快速切换造成重复请求。
- `sessions.list` refresh 节流。
- usage 状态按 sessionId 覆盖写，不保留无限历史。

### 7.4 日志

关键日志建议：

- 手动 compact 开始/成功/失败。
- 自动 compaction event 完成。
- 自动 compaction checkpoint count 增加。
- context usage refresh 失败。
- context usage lookup 命中路径和耗时。
- lifecycle fallback abort。
- 用户手动 stop abort。

日志要求：

- 使用 `console.log/warn/error`。
- 英文日志。
- 不记录 prompt、token、apiKey、完整模型响应等敏感内容。

## 8. 待确认问题

1. 已确认：OpenClaw gateway 有明确 compaction event：`stream: "compaction"`，`phase=start/end`。
2. 已确认：手动 compact 有专用 gateway API：`sessions.compact`。
3. 已确认：`sessions.list` 关键字段包括 `totalTokens`、`inputTokens`、`outputTokens`、`contextTokens`、`compactionCheckpointCount`、`latestCompactionCheckpoint`。
4. 已确认：OpenClaw store 内部维护 `compactionCount`；gateway list 对 UI 暴露 `compactionCheckpointCount` 和 `latestCompactionCheckpoint`。第一版 UI 以 checkpoint count 去重。
5. 已确认：OpenClaw gateway 暴露 `sessions.compaction.list` / `sessions.compaction.get`，可读取 checkpoint 列表和单个 checkpoint 的 `summary`、`tokensBefore`、`tokensAfter`、`preCompaction`、`postCompaction` 等 metadata。
6. 已确认：OpenClaw gateway 还暴露 `sessions.compaction.branch` / `sessions.compaction.restore`，但它们操作 OpenClaw transcript/session store，不等同于 智码 GLM Code Cowork 会话分叉。
7. 已确认：OpenClaw `compactionSummary` 是 assembled/model-visible context 的角色，不应与 UI `COMPACTION` 分隔符或 智码 GLM Code 的轻量系统提示混为一谈。
8. 已处理：自动压缩期间可能与 `chat.final` / retry stream 交错，智码 GLM Code 通过 800ms deferred completion 和 stream cancel 处理。
9. 仍需手测：OpenClaw 压缩失败时的错误形态是否稳定可识别。
10. 第一版已定：上下文圈放在 `CoworkSessionDetail` 输入框发送按钮左侧，保持轻量。
11. 第一版已定：会话 running 时不支持 pending queue；输入保持可见，发送按钮走 streaming/stop 状态，强行发送时给等待提示。
12. 第一版已定：手动 compact 期间不硬禁用发送按钮；发送动作走软拦截和 toast，并用 watchdog 兜底清理 compacting 状态。
13. 第一版已定：任务 running/context maintenance 时不允许主动 compact，因为 OpenClaw manual `sessions.compact` 可能先中断 active run。
14. 与会话分叉的关联：分叉压缩后的会话时，应优先读取 `sessions.compaction.list/get` 中最新 checkpoint 的 `summary` 作为 fork bridge，而不是从普通聊天历史或 UI 分隔符推断摘要。

## 9. 人工测试观察与日志时间线

### 9.1 任务运行中的中间观察

基于 2026-05-08 的人工测试截图，在任务尚未结束时观察到以下现象：

1. OpenClaw Web UI 在上下文达到约 `177k / 200k`、`89% context used` 时展示高风险状态。
2. OpenClaw 出现 `Pre-compaction memory flush` 提示，说明自动压缩前的记忆刷新流程已启动。
3. 后续 OpenClaw Web UI 中可能出现 `COMPACTION` 分隔标记，但仅凭该标记不能判断压缩已完成。
4. 当时最新截图中 token 仍为约 `177k / 200k`、`89% context used`，因此在任务未结束阶段不能确认 OpenClaw 已完成实际压缩。
5. 判断自动压缩完成应优先依赖明确 compaction event、`compactionCheckpointCount` 递增，或 token 占用显著下降，而不是只依赖 `Pre-compaction memory flush` 或 `COMPACTION` 标记。
6. 日志显示同一 run 在较长时间内持续收到 OpenClaw 工具调用和 assistant stream 事件，说明任务仍在执行。
7. 智码 GLM Code 端在继续执行期间缺少稳定的 running/loading 表达，用户容易误以为任务已结束。
8. 用户在任务仍 running 时继续发送消息时出现 `Session ... is still running.` 是并发保护提示，不应直接移除。
9. 关键问题是 running/loading 状态没有正确展示，导致输入框未能按预期禁用，用户才会触发该保护提示。
10. 用户切换到其他会话后再切回，loading 状态恢复正常，说明持久化 session 状态大概率仍为 `running`，问题更可能发生在当前页面实时 stream 状态同步链路。
11. 现有 renderer 在 `loadSession()` 时会按 `result.session.status === 'running'` 重新设置 `isStreaming`，因此切换会话可以修正 UI；但当前会话持续收到工具调用或 assistant stream 时，`isStreaming` 可能没有被重新置为 true 或被提前置为 false。
12. 主进程日志显示 run `b194e0b0-4fe9-4f9d-ac1f-6d02da348cfe` 在 `19:42:42` 收到 lifecycle `start`，到 `20:23` 仍持续收到 tool/assistant stream，未观察到对应 lifecycle `end` 或 `error`。
13. `20:00:55` 和 `20:01:08` 的 `Session ... is still running.` 与用户在任务仍运行时继续发送相吻合，说明该提示来自并发保护，不是任务终止信号。
14. 主进程日志持续出现 `CoworkForwarder forwarding message ... windowCount=1`，说明主进程仍在向 renderer 转发消息；如果 UI 当时没有及时展示，问题更可能在 renderer 状态应用、当前会话消息渲染或局部状态同步，而不是 OpenClaw 停止执行。
15. 当时日志中没有看到该 run 的明确 compaction 完成信号，且 token 仍停留在 `177k / 200k` 量级，因此在任务运行中不能把这次现象直接归因于已完成自动压缩。
16. 进一步代码排查显示，初始 loading 丢失发生在用户再次发送之前：`19:54:03` 智码 GLM Code 收到 `chat.final` 并 emit `complete`，renderer 因此把当前会话置为 completed，`isStreaming` 变为 false。
17. `19:54:05` OpenClaw 随后检测到 context overflow，并进入 auto-compaction/retry 流程；后续同一个 run 继续产生 tool/assistant stream。
18. `19:58:35` main 侧通过 `ensureActiveTurn()` 重新创建 active turn，并把 main store 中的 session 状态更新为 `running`，但当前没有对应的 status IPC 事件同步给 renderer。
19. renderer 的 `onStreamMessage` 目前只有收到 `user` 消息才 `updateSessionStatus(... running)`，普通 assistant/tool stream 不会把 UI 重新拉回 running；因此后续消息继续展示，但输入框和 loading 可能仍停留在 completed/idle 状态。
20. `20:00:55` 和 `20:01:08` 的 `Session ... is still running.` 是 loading 丢失后的后续症状：用户看到可发送后再次发送，触发并发保护；该错误不应再把 UI 当作终止性 error 处理。
21. 因此 loading 丢失的最可能根因是“OpenClaw 在 context overflow/auto-compaction/retry 前后出现 chat.final/后续 stream 的组合，智码 GLM Code 过早 complete 了 renderer 状态，而后续 active turn 重建没有同步 running 状态给 renderer”。

因此第一版除上下文圈和压缩提示外，还需要处理 active turn/running session 的状态展示与重复发送提示，否则用户仍会在自动压缩或长工具调用阶段误操作。

### 9.2 任务结束后的最终确认

任务最终于 2026-05-08 20:36 左右结束。结合日志、OpenClaw session 文件和 OpenClaw Sessions 页面，可以确认本次确实触发并完成了 OpenClaw 自动压缩。

关键证据：

1. OpenClaw Sessions 页面显示当前 session 有 `1 checkpoint`，compaction 标签为 `overflow retry`。
2. OpenClaw Sessions 页面 token 从压缩前超过/接近 `200k`，最终变为约 `138985 / 200000`。
3. OpenClaw session 文件中存在 `type: "compaction"` 记录，时间为 `2026-05-08T11:54:35.994Z`，即北京时间 `2026-05-08 19:54:35`。
4. 该 compaction 记录中 `tokensBefore` 为 `202172`，说明压缩触发时上下文已经超过 200k。
5. OpenClaw 生成了 checkpoint 文件：

```text
/Users/zhiqiangliu/Library/Application Support/智码 GLM Code/openclaw/state/agents/main/sessions/b1a58bee-1aee-41fd-bfe1-490f3c186667.checkpoint.70b36695-0e4f-4567-a7e3-c29f0d8181bc.jsonl
```

6. 主 session 文件在 `2026-05-08 20:36` 更新完成，checkpoint 文件在 `2026-05-08 19:54` 生成，符合“压缩后继续执行同一任务”的时间线。

相关文件规模：

```text
checkpoint file: 695 KB, 151 lines, updated at 19:54
main session file: 1.0 MB, 297 lines, updated at 20:36
```

结论：

- OpenClaw 的自动压缩能力在本次测试中生效。
- 压缩不是以普通 user/assistant 聊天气泡展示，而是以 `type: "compaction"` 会话记录、checkpoint 文件、Sessions 页面 `checkpoint / overflow retry` 信息体现。
- OpenClaw 对话 UI 中可能只展示轻量 `COMPACTION` 分隔符，或主要在 Sessions 列表和 `Show checkpoints` 中体现；智码 GLM Code 不能依赖普通聊天消息来判断压缩发生。
- 智码 GLM Code 需要主动对接 compaction metadata，才能在自身对话流中展示用户可理解的“已自动压缩上下文”提示。

### 9.3 本次压缩与运行状态异常的时间线

测试 session 信息：

```text
智码 GLM Code sessionId: eedbc56e-9d03-4281-a5b6-199c1513865d
OpenClaw session file id: b1a58bee-1aee-41fd-bfe1-490f3c186667
OpenClaw runId: b194e0b0-4fe9-4f9d-ac1f-6d02da348cfe
Model: deepseek/deepseek-v4-pro
```

时间线：

1. `19:41:51` OpenClaw 插入 `Pre-compaction memory flush` 内部消息，用于压缩前记忆刷新。
2. `19:42:42` OpenClaw 开始 embedded run，进入正常工具调用和生成流程。
3. `19:54:03` OpenClaw 对同一 run 发送 `chat.final`，智码 GLM Code 收到后 emit `complete`，renderer 将当前会话置为 completed，`isStreaming` 变为 false。
4. `19:54:05` OpenClaw 随后检测到 context overflow，并进入自动压缩和 retry 流程。
5. `19:54:35` OpenClaw 写入 `type: "compaction"` 记录，并生成 checkpoint；压缩前 token 为 `202172`。
6. `19:58:35` 智码 GLM Code main 侧在后续 OpenClaw stream 到来时重新创建 ActiveTurn，并将 main store 中 session 状态改回 `running`。
7. `20:00:55` 和 `20:01:08` 用户因前端 input 已恢复可发送而再次发送消息，触发 `Session ... is still running.` 并发保护提示。
8. `20:34 - 20:35` OpenClaw 仍持续发送 tool/assistant stream，说明任务一直在继续执行。
9. `20:36:07` OpenClaw embedded run agent end，`isError=false`。
10. `20:36:08` OpenClaw session state 从 `processing` 变为 `idle`，reason 为 `run_completed`。
11. `20:36:10` OpenClaw embedded run done，`aborted=false`。
12. `20:36:11` 智码 GLM Code 通过 lifecycle end fallback 完成 missed `chat.final` 的最终同步。
13. `20:36:12` 智码 GLM Code usage sync 完成，日志显示 `in=361 out=302 ctx=0% cacheRead=138624 agent=main`。

关键日志摘录：

```text
19:54:03 handleChatFinal: sessionId=eedbc56e... runId=b194e0b0...
19:54:03 IMCoworkHandler:handleComplete sessionId=eedbc56e...
19:54:05 context overflow detected (attempt 1/3); attempting auto-compaction for deepseek/deepseek-v4-pro
19:58:35 re-creating ActiveTurn for follow-up turn, sessionId=eedbc56e...
19:58:35 creating turn ... runId=b194e0b0...
20:00:55 Session eedbc56e... is still running.
20:01:08 Session eedbc56e... is still running.
20:36:07 embedded run agent end ... isError=false
20:36:08 session state ... prev=processing new=idle reason="run_completed"
20:36:10 embedded run done ... aborted=false
20:36:11 agent lifecycle end fallback: completing turn that missed chat final
20:36:12 syncUsageMetadata success ... in=361 out=302 ctx=0% cacheRead=138624
```

### 9.4 根因判断

本次用户感知到的“任务还在跑，但 智码 GLM Code loading 丢失、输入框恢复可发送”不是 OpenClaw 任务停止，也不是 `Session ... is still running.` 提示本身导致的。

更准确的根因是：

1. OpenClaw 在 context overflow / auto-compaction / retry 前后出现了 `chat.final` 后继续同一 run stream 的组合。
2. 智码 GLM Code renderer 收到第一次 `complete` 后提前把 UI 状态改成 idle。
3. 后续 main 侧虽然通过 `ensureActiveTurn()` 重新创建 ActiveTurn，并把 store 中 session 状态改回 running，但没有向 renderer 发送明确的 session status update。
4. renderer 当前只有在收到 `user` 类型 stream message 时会主动 `updateSessionStatus(... running)`，assistant/tool stream 不会把 UI 重新拉回 running。
5. 因此后续 assistant/tool 消息可以继续展示，但输入框和 loading 状态可能仍停留在 idle，导致用户可以点击发送。

所以 `Session ... is still running.` 是 loading 丢失后的并发保护症状，不应移除。真正要修复的是运行状态同步链路。

### 9.5 与 20 秒 lifecycle fallback 修复的关系

本次测试也验证了本分支已完成的 20 秒 lifecycle error fallback 修复是必要的。

如果仍保持旧逻辑：收到 `lifecycle phase=error` 后 2 秒就发送 `chat.abort`，那么在 OpenClaw 刚检测到 context overflow 并准备自动压缩/retry 时，智码 GLM Code 很可能会提前 abort gateway run。

可能后果：

- OpenClaw 自动压缩尚未完成就被打断。
- 用户看到 context exceeded 或任务失败。
- gateway run 可能因为被中途打断而进入未释放或不一致状态。
- 后续消息可能无法正常发送。

当前 20 秒策略的意义：

- 给 OpenClaw 自动压缩、retry、failover 留出恢复窗口。
- 如果同一 run 在恢复窗口内继续 stream 或结束，则不误杀。
- 如果 20 秒后仍无正常 final/error/abort 且 runId 仍匹配，再执行兜底 abort。
- runId guard 可避免旧 timer 误伤新 run。

### 9.6 后续实现建议

基于本次实测，第一版实现除上下文圈、主动压缩、自动压缩提示外，还应覆盖以下状态同步修复：

1. main 侧 `ensureActiveTurn()` 或等价位置在重新创建 active turn 时，应向 renderer 发送当前 session 已恢复 running 的状态事件。
2. renderer 收到当前 session 的 assistant/tool stream 时，如果当前 UI 状态为 completed/idle，应保守地自愈为 running。
3. renderer 收到 `Session ... is still running.` 这类并发保护错误时，不应将其视为终止性 error；应保持或恢复 running 状态，并提示用户等待。
4. `chat.final` 不应在 OpenClaw 同一 run 仍可能 auto-compaction/retry 的情况下成为唯一的最终完成依据；需要结合 lifecycle end、run done 或后续 stream 来避免过早 complete。
5. 自动压缩提示应优先依赖 OpenClaw `stream: "compaction"` event、`type: "compaction"` transcript entry、checkpoint metadata 或 `compactionCheckpointCount`，而不是依赖普通消息文本。

### 9.7 2026-05-09 60k 窗口测试观察

测试背景：

- 测试时本地曾将 智码 GLM Code 同步给 OpenClaw 的 context window override 设为 `60_000`，用于更快复现相关路径；该 override 已在发布前移除。
- 测试 session key：

```text
agent:main:lobsterai:dcf99a2a-8f05-4375-a749-bf4beeb6c836
```

#### 9.7.1 Memory flush / pre-compaction 路径

日志中观察到：

```text
memoryFlush check:
  tokenCount=43720
  contextWindow=60000
  threshold=36000

OpenClaw 插入内部 user turn:
  Pre-compaction memory flush...

assistant final:
  NO_REPLY

约 9 秒后 OpenClaw 自动启动新 run 继续原始用户请求。
```

结论：

- 超过 `threshold=36000` 后，OpenClaw 会先触发 pre-compaction memory flush。
- memory flush 不等于 checkpoint compaction 已完成。
- `NO_REPLY/no_reply` 是 OpenClaw silent token，不应展示为正式 assistant 消息。
- 智码 GLM Code 需要在 confirmed maintenance 期间保持 running，并显示“正在整理上下文...”，否则用户会误以为任务停止。

#### 9.7.2 COMPACTION 分隔符但无 checkpoint

测试截图中 OpenClaw Chat UI 显示 `COMPACTION` 分隔符，且 context usage 达到：

```text
80.3k / 60k
100% context used
```

但 OpenClaw Sessions 页面显示：

```text
TOKENS: 80262 / 60000
COMPACTION: none
```

日志中同时出现：

```text
context-diag:
  roleCounts=assistant:16,compactionSummary:1,toolResult:12,user:4
```

结论：

- OpenClaw Chat UI 的 `COMPACTION` 分隔符可表示 assembled context 中存在 `compactionSummary`。
- `compactionSummary:1` 表示 prompt/context 构造时使用了摘要段，不等于 session checkpoint。
- Sessions 页面 `COMPACTION none` 和缺失 `compactionCheckpointCount` 说明没有生成可展示 checkpoint。
- 智码 GLM Code 不应在该情况下插入“上下文已自动压缩”提示。
- 60k 是 OpenClaw 侧用于 usage/阈值计算的测试窗口；底层 qwen provider 可能仍可接收超过 60k 的实际上下文，因此 `80k / 60k` 不必然触发 provider hard error。

#### 9.7.3 Assistant meta 消失

测试发现 智码 GLM Code 端 assistant 回复下方 meta 信息不展示，而 OpenClaw 端可以看到类似：

```text
智码 GLM Code 13:47 ↑80.4k ↓391 100% ctx qwen3.6-plus
```

根因：

1. `handleChatFinal()` 先执行 `reconcileWithHistory()`。
2. reconcile 可能替换本地 user/assistant 消息尾部，生成新的 message id。
3. 后续 usage/meta 仍使用 `turn.assistantMessageId`，该 id 可能已经失效。
4. `updateMessage()` 写不到当前最新 assistant message，renderer 也收不到对应 `messageUpdate`。

修复：

- 新增 `resolveAssistantMessageIdForUsage(sessionId, preferredMessageId)`。
- preferred id 存在且仍为 assistant 时使用 preferred id。
- preferred id 失效时回退到最新 assistant message。
- `applyUsageMetadataFromFinal()` 和 `syncUsageMetadata()` 均使用该 helper。

#### 9.7.4 本轮确认的产品语义

智码 GLM Code 侧应展示的内容：

- 普通 user/assistant 聊天。
- 普通 tool_use/tool_result。
- checkpoint compaction 确认后的轻量系统提示。
- context maintenance 期间的运行态提示。
- assistant message meta：agent、input/output/cache tokens、context percent、model。

智码 GLM Code 侧不应展示的内容：

- `Pre-compaction memory flush` 内部 user prompt。
- 纯 `NO_REPLY/no_reply` assistant/system 消息。
- memory daily file read/write maintenance tool_use/tool_result。
- 仅由 assembled context `compactionSummary` 引发的 “已自动压缩”消息。

### 9.8 当前验证命令

最新相关验证命令：

```bash
npm test -- openclawHistory openclawRuntimeAdapter
npm test -- openclawRuntimeAdapter
npx tsc -p electron-tsconfig.json --noEmit
npx tsc -p tsconfig.json --noEmit
```

已覆盖：

- history silent/pre-compaction 过滤。
- adapter chat.final grace、lifecycle end immediate flush、tool continuation cancel。
- memory maintenance `NO_REPLY` suppress 和 60 秒 follow-up grace。
- 普通 write 不触发 maintenance。
- `compactionCount` 不作为 checkpoint count。
- usage/meta fallback 到最新 assistant message。
