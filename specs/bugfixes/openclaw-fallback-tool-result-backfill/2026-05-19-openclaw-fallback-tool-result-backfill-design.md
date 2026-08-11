# OpenClaw tool result 回填边界修复设计文档

## 1. 概述

### 1.1 问题

用户在 智码 GLM Code Cowork 中执行 OpenClaw 任务后，tool result 回填出现两类相反表现：

1. **该补的结果没有补**：任务已经完成，最终 assistant 回复也已经完整展示，但部分 `Read` 工具块仍显示蓝点和 `执行中`。
2. **不该补的历史结果被补进来**：最终 assistant 回复之后，界面额外出现多个孤立的 `执行结果` 块，这些结果并不属于当前 turn 的工具调用。

本次现场截图中，红色箭头指向的 `Read` 工具调用显示：

- 工具名为 `Read`
- 路径为 `.cowork-temp/attachments/manual/gateway-2026-05-19-...log`
- 状态仍为 `执行中`

但从日志看，这一轮任务已经完成：

- `18:14:45.181` OpenClaw 发出 `stream=lifecycle phase=end`
- `18:14:45.793` embedded run done，`aborted=false`
- `18:14:45.988` 智码 GLM Code 记录 `agent lifecycle end fallback completed a turn that missed chat final`
- `18:14:46.021` 智码 GLM Code 发出 session complete

因此问题不是 run 仍在执行，而是 智码 GLM Code 本地消息中缺少对应的 `tool_result`，导致 renderer 把未配对的 `tool_use` 继续渲染为运行中。

第二个现场中，当前 turn 实际只执行了一个 `memory_search`，但 `chat.final` 后 智码 GLM Code 又从 `chat.history` 写入多个旧 `exec/read` 的 `tool_result`。这些结果没有本地配对的 `tool_use`，因此 renderer 走孤立结果分支，展示成多个 `执行结果` 块。

### 1.2 现场证据

#### 1.2.1 漏补当前 Read 结果

本次涉及的关键标识：

| 字段 | 值 |
|---|---|
| 智码 GLM Code sessionId | `269ed742-76f0-457a-bb54-c0ebd7fedd11` |
| OpenClaw sessionId | `8027de7b-5afb-41ae-b63f-7e982784fbad` |
| runId | `5542c40d-0207-4892-8ff5-8f4ab1f112c4` |
| 问题时间 | `2026-05-19 18:12:51` 至 `18:14:46` |

关键链路如下：

1. `18:12:51` OpenClaw 发出两个 `Read` 工具开始事件：
   - `call_00_MtKUqb1TzndQgo02F64w5571`
   - `call_01_Khyn5iRxDyQ8iECs35p07995`
2. `18:12:52` 至 `18:12:53` OpenClaw 记录这两个工具都已经 `embedded run tool end`。
3. 对这两个 tool call，gateway/main 日志中没有对应的 `stream=tool result:read` 事件，也没有 智码 GLM Code 的 `tool_result` 转发记录。
4. `18:14:46` lifecycle fallback 触发 `syncFinalAssistantWithHistory()`，此时 `chat.history` 已经包含完整历史：
   - `[14] role=assistant` 内包含两个 `toolCall` block，id 分别是 `call_00_MtKU...` 和 `call_01_Khyn...`
   - `[15] role=toolResult content=blocks:[text]`
   - `[16] role=toolResult content=blocks:[text]`
5. `syncFinalAssistantWithHistory()` 只同步了最终 assistant 文本，没有把 `[15]`、`[16]` 的 `toolResult` 回填为本地 `tool_result` 消息。
6. 前端 `buildDisplayItems()` 只能按 `metadata.toolUseId` 将 `tool_use` 和 `tool_result` 配对，缺少 `tool_result` 时就保持 `执行中`。

对比同一轮前面的读取工具：

- `call_00_GMGbx...`
- `call_01_tO9f...`
- `call_02_fv0o...`

这些工具都有实时 `stream=tool result:read`，并且后续通过 `chat.history` 增量回填了完整结果，因此 UI 可以正确结束工具状态。

#### 1.2.2 误补历史执行结果

第二次现场涉及的关键标识：

| 字段 | 值 |
|---|---|
| 智码 GLM Code sessionId | `269ed742-76f0-457a-bb54-c0ebd7fedd11` |
| OpenClaw sessionId | `8027de7b-5afb-41ae-b63f-7e982784fbad` |
| runId | `7fe4252c-b5ee-4281-91a4-a30b584a2408` |
| 问题时间 | `2026-05-19 18:25:13` 至 `18:25:23` |

关键链路如下：

1. 当前 run 真正执行的工具只有一个 `memory_search`：
   - `18:25:13` `toolCallId=call_00_5TqUP31MIcRfPhaNtKCC9644`
   - `18:25:16` 收到 `stream=tool result:memory_search`
   - `18:25:18` 对该 tool call 做了增量 backfill
2. `18:25:23` 收到当前 run 的 `chat.final`，最终 assistant 文本长度为 598。
3. 随后 `handleChatFinal()` 请求 `chat.history`，并写入多个历史 tool result：
   - `call_01_0FS2dGB4CAGhmUGwXqOP7880`
   - `call_00_jUNngguDzeiBpNseGQF34861`
   - `call_01_mr0yzQDJxKXP237D5a1t5457`
   - `call_00_AcsWkZctv1SKjh7r3ZYa0714`
   - 以及其他旧 `exec` 调用
4. 这些 tool call 在同一份 `chat.history` 中属于更早的 assistant/toolResult 片段，不属于当前 turn 的 `memory_search`。
5. 前端 `buildDisplayItems()` 找不到这些 `tool_result` 对应的本地 `tool_use`，于是走 `renderOrphanToolResult()`，显示为截图中的孤立 `执行结果`。

### 1.3 根因

根因是 **tool result history 回填缺少统一的当前 turn 边界**。

该问题有两面：

1. **漏补**：lifecycle fallback 路径没有执行 tool result history backfill，导致当前 turn 已知 `tool_use` 的结果没有从 `chat.history` 补回本地消息。
2. **误补**：正常 `chat.final` 路径虽然执行了 backfill，但只要 history 中存在 `toolResult/tool` 且有文本，就会创建本地 `tool_result`，没有判断该 `toolCallId` 是否属于当前 `ActiveTurn` 已知的工具调用。

当前 `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` 中有两条收尾路径：

1. 正常 `handleChatFinal()`：
   - 收到 `chat.final`
   - 请求 `chat.history`
   - 遍历 `role === 'toolResult' || role === 'tool'`
   - 创建或更新本地 `tool_result` 消息
   - 但没有校验 `toolCallId` 是否存在于 `turn.toolUseMessageIdByToolCallId` 或 `turn.toolResultMessageIdByToolCallId`
   - 再完成 session
2. `completeChannelTurnFallback()`：
   - 收到 lifecycle end，但没有等到 `chat.final`
   - 对 managed session 调用 `syncFinalAssistantWithHistory()`
   - `syncFinalAssistantWithHistory()` 请求 `chat.history`
   - 只同步最终 assistant 文本
   - 不处理 history 中已有的 `toolResult`
   - 随后完成 session 并清理 active turn

第一个现场正好走了第二条路径。OpenClaw 的最终 `chat.history` 是完整的，但 智码 GLM Code fallback 同步没有消费里面的 `toolResult`，导致本地消息缺口保留下来。

第二个现场走了第一条路径。当前 turn 的 `memory_search` 已经完整结束，但 `chat.history` 窗口里还包含更早 turn 的旧 `toolResult`。由于回填逻辑没有当前 turn 归属校验，这些旧结果被写入当前 智码 GLM Code 消息流，形成孤立 `执行结果`。

这和 `2026-05-19-openclaw-compaction-retry-empty-reply-design.md` 属于同一类兼容问题：最近的改动增强了 lifecycle fallback / history sync 对最终 assistant 文本的兜底能力，但没有把正常 final 路径已有的 tool result backfill 能力一起下沉复用。

### 1.4 目标

修复目标：

1. 当 OpenClaw 漏发或延迟发送实时 `stream=tool result`，但最终 `chat.history` 中已有 `toolResult` 时，智码 GLM Code 应补齐本地 `tool_result` 消息。
2. 当 `chat.history` 包含旧 turn 的 `toolResult` 时，智码 GLM Code 不应把未知 `toolCallId` 写入当前本地消息流。
3. 正常 `chat.final` 和 lifecycle fallback 收尾必须使用同一套带边界约束的 tool result 回填逻辑。
4. UI 中已有 `tool_use` 能通过 `metadata.toolUseId` 配对到补齐的 `tool_result`，不再错误显示 `执行中`。
5. 不把真实缺失结果的工具调用强行标记为完成，只以当前 turn 已知 tool call 在 `chat.history` 中的权威 `toolResult` 为依据。
6. 不改变 OpenClaw 的工具执行协议，不依赖上游一定实时发送 `stream=tool result`。

### 1.5 非目标

本修复不做以下事情：

- 不改 renderer 的工具块配对和展示规则。
- 不把 session completed 作为工具完成的 UI 兜底。
- 不在前端伪造空 tool result。
- 不通过前端隐藏孤立 tool result 来掩盖 SQLite 中的脏数据。
- 不在主修复中清理历史会话里已经写脏的孤立 `tool_result`；历史数据清理应作为单独任务评估。
- 不调整 OpenClaw gateway 的事件发送策略。
- 不修改 `Read` 工具本身。

## 2. 用户场景

### 场景 1: lifecycle fallback 收尾时补齐 Read 结果

**Given** OpenClaw 某轮任务中存在 `Read` 工具调用
**And** 智码 GLM Code 已创建本地 `tool_use` 消息
**And** gateway 没有发送对应的实时 `stream=tool result:read`
**When** 该轮任务通过 lifecycle fallback 完成
**And** `chat.history` 中存在匹配 `toolCallId` 的 `toolResult`
**Then** 智码 GLM Code 应创建本地 `tool_result` 消息
**And** UI 中该 `Read` 工具块应显示为完成态，而不是 `执行中`

### 场景 2: 正常 chat.final 路径行为不回退

**Given** OpenClaw 正常发送 `chat.final`
**When** `handleChatFinal()` 请求 `chat.history`
**Then** 仍应回填缺失或更完整的 tool result 文本
**And** 不能因为抽取公共逻辑导致已有图片、文件或长文本 tool result 展示回退

### 场景 3: history 暂时不含 toolResult

**Given** 本地存在未配对的 `tool_use`
**When** fallback 收尾请求 `chat.history`
**And** history 中没有对应 `toolCallId` 的 `toolResult`
**Then** 不应伪造完成态
**And** 应保留现有消息状态，最多记录诊断日志

### 场景 4: 已存在短结果需要替换为完整结果

**Given** 实时 tool event 已创建一个空或截断的 `tool_result`
**When** final / fallback history 中返回更长的权威文本
**Then** 智码 GLM Code 应更新已有 `tool_result` 内容
**And** 发送 `messageUpdate` 让 renderer 展示完整结果

### 场景 5: chat.final 后 history 包含旧工具结果

**Given** 当前 turn 只执行了一个 `memory_search` 工具
**And** `chat.history` 窗口中还包含更早 turn 的多个 `read/exec` toolResult
**When** `handleChatFinal()` 从 `chat.history` 回填工具结果
**Then** 只允许处理当前 turn 已知的 `memory_search` toolCallId
**And** 不应为旧 `read/exec` toolCallId 新增本地 `tool_result`
**And** UI 不应额外出现孤立 `执行结果` 块

## 3. 功能需求

### FR-1: 抽取统一的 tool result history backfill

将 `handleChatFinal()` 中现有的 tool result history 回填逻辑抽为独立方法，例如：

```typescript
private syncToolResultsFromHistory(
  sessionId: string,
  turn: ActiveTurn,
  historyMessages: unknown[],
): void
```

该方法负责：

1. 遍历 `chat.history` 的 `messages`。
2. 识别 `role` 为 `toolResult` 或 `tool` 的消息。
3. 读取 `toolCallId` 或 `tool_call_id`。
4. 通过 `extractMessageText()` 提取文本结果。
5. 若本地已有结果但 history 文本更长，则更新。
6. 若本地缺少结果，但当前 turn 已有对应 `tool_use`，则创建 `type: 'tool_result'` 消息。
7. 更新 `turn.toolResultMessageIdByToolCallId` 和 `turn.toolResultTextByToolCallId`。
8. 通过 `emit('message')` 或 `emit('messageUpdate')` 通知 renderer。

该方法必须是 **当前 turn 有界回填**：

- 允许更新：`turn.toolResultMessageIdByToolCallId.has(toolCallId)`。
- 允许创建：`turn.toolUseMessageIdByToolCallId.has(toolCallId)`。
- 必须跳过：既没有本地 `tool_use`，也没有本地 `tool_result` 的未知 `toolCallId`。

新增比较/构造 role 字符串时，应遵守仓库字符串常量规范。若当前模块没有可复用常量，可以在本模块内新增局部 `as const` 常量对象，避免在多个路径继续散落裸字符串。

### FR-2: 不为未知 toolCallId 创建孤立结果

无论是正常 `chat.final`，还是 lifecycle fallback，都不得为未知 `toolCallId` 新增 `tool_result`。

未知 `toolCallId` 指：

```typescript
!turn.toolUseMessageIdByToolCallId.has(toolCallId)
&& !turn.toolResultMessageIdByToolCallId.has(toolCallId)
```

这些 history 结果大概率来自：

- 上一轮或更早 turn；
- `chat.history` limit 覆盖到的旧工具结果；
- 自动压缩前后的历史窗口；
- 旧会话中已经存在但当前 turn 没有本地消息上下文的工具调用。

对未知 `toolCallId`，应直接跳过，不写 SQLite，不 emit `message`，不触发 artifact 检测。

### FR-3: handleChatFinal 使用公共 backfill 方法

`handleChatFinal()` 不再保留内联的 tool result 回填循环。

正常 final 路径应改为：

1. 请求 `chat.history`。
2. 调用 `syncToolResultsFromHistory(sessionId, turn, history.messages)`。
3. 继续执行 assistant final text、usage metadata 和 session completion 的既有逻辑。

行为应与当前实现等价或更严格，不能减少已有的 `tool_result` 创建、更新和事件通知。

同时，正常 final 路径必须新增 unknown toolCallId guard，避免继续把旧 history 结果写成孤立 `执行结果`。

### FR-4: syncFinalAssistantWithHistory 也必须同步 tool result

`syncFinalAssistantWithHistory()` 当前已经在 retry loop 中拿到了 `historyMessages`，并且会 dump history roles。

当确认当前 `turnToken` 仍有效后，应在合适位置调用 `syncToolResultsFromHistory()`：

- 建议在通过 `isCurrentTurnToken()` 检查之后、assistant text 对齐之前调用。
- 这样即使 `canonicalText` 为空或 assistant 文本后续提前返回，也能补齐当前 turn 已知 tool call 在 history 中已经存在的 tool result。
- 不能在 turn token 已过期后写入消息，避免旧 run 污染新 turn。
- 仍需复用 unknown toolCallId guard，避免 fallback 路径补进旧 history 结果。

### FR-5: 只根据权威 history 补齐，不做 UI 完成态猜测

如果 `chat.history` 中没有当前 turn 已知 `toolCallId` 的 `toolResult`，不得因为 session completed 就创建空 `tool_result`。

这样可以保留真实异常的可见性：

- OpenClaw 工具结果确实丢失
- history 写入失败
- tool call id 无法匹配
- 上游协议结构变化

这些情况应保持可诊断，而不是被前端完成态掩盖。

### FR-6: 日志表达自然语言和关键上下文

新增日志应遵守仓库日志规范：

- 使用英文。
- 使用 `[OpenClawRuntime]` tag。
- 不在高频流式路径使用 info 级别。
- 成功补齐可使用 debug 或低频 info。
- warn/error 应包含 `sessionId`、`toolCallId` 等必要上下文，并把 error 对象作为最后一个参数。

建议替换现有偏调试风格的日志：

```text
[OpenClawRuntime] backfilled a missing tool result from chat history.
```

并在参数中附带 `toolCallId`、`len`、`prevLen`。

对于跳过未知 `toolCallId`，可使用 debug 级别低频日志，避免每次 final 因旧 history 窗口产生大量 info 日志。

## 4. 实现方案

### 4.1 新增 history role 常量

**文件**：`src/main/libs/agentEngine/openclawRuntimeAdapter.ts`

在模块 helper 区域新增局部常量：

```typescript
const OpenClawHistoryRole = {
  Tool: 'tool',
  ToolResult: 'toolResult',
} as const;
type OpenClawHistoryRole = typeof OpenClawHistoryRole[keyof typeof OpenClawHistoryRole];
```

如果后续也要收敛 assistant/user/system 等 role，可以在同一对象中扩展，但本修复只需要覆盖新增/抽取的 tool result 判断。

### 4.2 抽取 `syncToolResultsFromHistory`

**文件**：`src/main/libs/agentEngine/openclawRuntimeAdapter.ts`

建议实现轮廓：

```typescript
private syncToolResultsFromHistory(
  sessionId: string,
  turn: ActiveTurn,
  historyMessages: unknown[],
): void {
  for (const msg of historyMessages) {
    if (!isRecord(msg)) continue;

    const role = typeof msg.role === 'string' ? msg.role.trim() : '';
    if (role !== OpenClawHistoryRole.ToolResult && role !== OpenClawHistoryRole.Tool) {
      continue;
    }

    const toolCallId = typeof msg.toolCallId === 'string'
      ? msg.toolCallId.trim()
      : typeof msg.tool_call_id === 'string'
        ? msg.tool_call_id.trim()
        : '';
    if (!toolCallId) continue;

    const text = extractMessageText(msg);
    if (!text.trim()) continue;

    const existingResultMsgId = turn.toolResultMessageIdByToolCallId.get(toolCallId);
    const hasKnownToolUse = turn.toolUseMessageIdByToolCallId.has(toolCallId);
    if (!hasKnownToolUse && !existingResultMsgId) {
      continue;
    }

    const existingText = turn.toolResultTextByToolCallId.get(toolCallId) ?? '';
    if (text.length <= existingText.length) continue;

    const isError = Boolean(msg.isError);
    const metadata = {
      toolResult: text,
      toolUseId: toolCallId,
      isError,
      isStreaming: false,
      isFinal: true,
    };

    if (existingResultMsgId) {
      this.store.updateMessage(sessionId, existingResultMsgId, { content: text, metadata });
      turn.toolResultTextByToolCallId.set(toolCallId, text);
      this.emit('messageUpdate', sessionId, existingResultMsgId, text);
      continue;
    }

    const resultMessage = this.store.addMessage(sessionId, {
      type: 'tool_result',
      content: text,
      metadata,
    });
    turn.toolResultMessageIdByToolCallId.set(toolCallId, resultMessage.id);
    turn.toolResultTextByToolCallId.set(toolCallId, text);
    this.emit('message', sessionId, resultMessage);
  }
}
```

实际实现时可以沿用当前 `handleChatFinal()` 中的 metadata shape，避免影响 renderer 展示。

关键点：

- `existingResultMsgId` 表示当前 turn 已经有本地 result，可更新。
- `hasKnownToolUse` 表示当前 turn 已经有本地 use，可创建缺失 result。
- 两者都不存在时必须跳过，防止旧 history result 变成孤立 `执行结果`。

### 4.3 改造 `handleChatFinal`

**文件**：`src/main/libs/agentEngine/openclawRuntimeAdapter.ts`

当前 `handleChatFinal()` 在 `turn.toolUseMessageIdByToolCallId.size > 0` 时会单独请求 `chat.history` 并内联回填。

改造后：

1. 保留请求 `chat.history` 的触发条件。
2. 请求成功后只做：

```typescript
if (Array.isArray(history?.messages)) {
  this.syncToolResultsFromHistory(sessionId, turn, history.messages);
}
```

3. 保留 catch，但日志改为自然语言。

### 4.4 改造 `syncFinalAssistantWithHistory`

**文件**：`src/main/libs/agentEngine/openclawRuntimeAdapter.ts`

在 retry loop 中拿到 `history.messages` 后，已有逻辑会检查：

```typescript
if (!this.isCurrentTurnToken(sessionId, turn.turnToken)) {
  return;
}
```

建议在这个检查之后调用：

```typescript
this.syncToolResultsFromHistory(sessionId, turn, history.messages);
```

这样 lifecycle fallback 即使最终没有收到 `chat.final`，也能从同一份权威 history 中补齐 tool result。

需要注意：

- 如果后续 `canonicalText` 为空并提前返回，tool result 仍可以被补齐。
- 如果多次 retry loop 拿到同一份 history，helper 的长度比较会保证幂等。
- 如果 turn 已被新的事件替换，`isCurrentTurnToken()` 会阻止写入。

### 4.5 前端无需修改

**文件**：`src/renderer/components/cowork/CoworkSessionDetail.tsx`

当前 `buildDisplayItems()` 的配对规则是合理的：

1. `tool_use` 根据 `message.metadata.toolUseId` 建立 group。
2. `tool_result` 根据同一个 `toolUseId` 回填到 group。
3. 没有 `tool_result` 时，`ToolCallGroup` 显示运行中。

修复后只要后端补齐 `tool_result`，现有 UI 会自然从 `执行中` 变为完成态。

同时，后端不再写入未知 `toolCallId` 的 `tool_result` 后，正常新会话不应再触发 `renderOrphanToolResult()`。该分支仍可保留，用于兼容历史脏数据、导入数据或真实异常数据。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 实时 tool result 正常到达 | helper 看到 history 文本不更长时不重复创建 |
| 实时 tool result 为空，history 有完整文本 | 更新已有 `tool_result` 并发送 `messageUpdate` |
| 实时 tool result 缺失，history 有当前 turn 已知 toolCallId 的完整文本 | 创建新的 `tool_result` 并发送 `message` |
| history 有旧 turn 的 `toolResult`，当前 turn 没有对应 `tool_use` | 跳过，不创建孤立 `tool_result` |
| history 中没有匹配 `toolCallId` | 不创建空结果，保留诊断可能性 |
| history 中 `toolResult` 文本为空 | 不创建或更新，避免空结果覆盖真实状态 |
| history 多次同步同一 tool result | 通过 `text.length <= existingText.length` 保持幂等 |
| 当前 turn token 过期 | 不写入消息，避免旧 run 污染新 turn |
| tool result 标记 `isError` | metadata 保留 `isError`，前端按现有规则展示 |
| 已经写脏的旧会话存在孤立 `tool_result` | 主修复不删除；如需清理，另建迁移/修复任务 |
| channel session fallback | `completeChannelTurnFallback()` 对 channel session 仍走 `reconcileWithHistory()`，本修复主要覆盖 managed session；若未来 channel 也复用 `syncFinalAssistantWithHistory()`，helper 可直接复用 |

## 6. 涉及文件

| 文件 | 改动 |
|------|------|
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 抽取 tool result history backfill helper；`handleChatFinal()` 与 `syncFinalAssistantWithHistory()` 复用；日志调整 |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts` | 新增 lifecycle fallback 缺失 tool result 的回归测试；新增 history 混入旧 toolResult 时不创建 orphan result 的测试；可补充已有短结果被 history 完整结果替换的测试 |
| `src/renderer/components/cowork/CoworkSessionDetail.tsx` | 不需要改动，仅作为验收确认点 |

## 7. 验收标准

1. `npm test -- openclawRuntimeAdapter` 通过。
2. 新增测试覆盖：managed session 中已有 `tool_use`、未收到实时 `tool_result`、最终 `chat.history` 有匹配 `toolResult`、并通过 `completeChannelTurnFallback()` 完成时，本地会创建 `tool_result`。
3. 新增测试覆盖：`chat.history` 同时包含当前 turn toolResult 和旧 turn toolResult 时，只回填当前 turn 已知 toolCallId，不新增 orphan `tool_result`。
4. 新增测试覆盖：已有空或短 `tool_result` 时，history 中更长文本能更新本地消息并触发 `messageUpdate`。
5. 使用第一个日志复现场景时，`call_00_MtKU...` 和 `call_01_Khyn...` 对应的 `Read` 工具块不再停留 `执行中`。
6. 使用第二个日志复现场景时，当前 run 只执行 `memory_search` 的情况下，final 后不会额外出现多个旧 `exec/read` 的孤立 `执行结果`。
7. 正常实时 `stream=tool result:read` 到达的工具块不重复显示结果。
8. `chat.history` 中没有当前 turn 对应 `toolResult` 的工具调用不会被伪造完成态。
9. session completed 后，当前 turn 已知且 history 中已有结果的 tool call 都能在 UI 中显示完成态。
