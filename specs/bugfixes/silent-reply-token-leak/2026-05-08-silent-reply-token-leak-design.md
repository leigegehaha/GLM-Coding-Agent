# Silent Reply Token 泄漏修复 Spec

## 1. 概述

### 1.1 问题

IM 会话窗口中会同步显示不相关的模型回复，例如 `"NO_REPLY"`、`"NO_"` 等。

这些文本不是正常的模型回答，而是 OpenClaw 内部的**静默回复控制标记**。它们出现在 UI 中会造成用户困惑：为什么 AI 只回复了 "NO_REPLY"？这是什么意思？

### 1.2 根因

`NO_REPLY` 是 OpenClaw 的 `SILENT_REPLY_TOKEN`（定义在 `openclaw/src/auto-reply/tokens.ts`）。AI 在判定不需要向用户发送可见回复时输出此标记，典型场景包括：

- 群聊中未被 @ 提及的消息（baseline unmentioned channel chatter）
- 飞书文档评论场景，AI 已通过工具（如 `reply_comment`）完成回复，输出 `NO_REPLY` 防止重复发送
- 子代理完成事件后的静默收尾

**OpenClaw 侧已有的过滤**：在 `chat.history` API 响应和出站回复投递（IM 平台发送）中正确过滤了 `NO_REPLY`。但**实时流事件**（`chat.delta`、`chat.final`、agent `stream=assistant`）未过滤，原始文本直接传递到了 智码 GLM Code。

**智码 GLM Code 侧遗漏**：适配器 `openclawRuntimeAdapter.ts` 已有对同类控制标记 `HEARTBEAT_OK` 的完整过滤，覆盖了所有流式入口和历史同步。但缺少对 `NO_REPLY` 的等效处理，导致其通过了两层防线：

| 防线 | HEARTBEAT_OK | NO_REPLY（修复前） |
|---|---|---|
| 流式创建消息前拦截 | ✅ | ❌ |
| 流式前缀片段缓存 | 不适用（短 token） | ❌ |
| 历史条目过滤 (`shouldSuppressHeartbeatText`) | ✅ | ❌ |
| 历史同步 system 条目过滤 | ✅ | ❌ |

**流式泄漏路径**：

```
OpenClaw 流式输出: "N" → "NO" → "NO_" → "NO_R" → "NO_RE" → "NO_REPLY"
                        ↓
智码 GLM Code processAssistant/handleChatDelta:
  "NO_" → isSilentReplyText("NO_") = false → 创建消息 → emit 到 UI
  "NO_REPLY" → isSilentReplyText("NO_REPLY") = true → 仅清空 segmentText
                ❌ handleChatDelta 遗漏 deleteAssistantMessage 调用
```

两重缺陷叠加：

1. **前缀片段被放行**——`isSilentReplyText` 仅匹配完整 token，`"NO_"` 等流式前缀通过了检查
2. **handleChatDelta 有 bug**——即使完整 `"NO_REPLY"` 到达，该方法也只清空了 `currentAssistantSegmentText`，未调用 `deleteAssistantMessage` 删除已创建的消息（对比 `processAssistant` 正确处理了删除）

## 2. 用户场景

### 场景 A: 群聊未 @ 提及

**Given** 用户在某个 IM 群聊中开启了 智码 GLM Code 机器人
**When** 群内其他成员发送了一条未 @ 机器人的消息
**Then** 会话窗口中不应出现任何 AI 回复（包括 "NO_REPLY" 或 "NO_"）

### 场景 B: 飞书文档评论已由工具处理

**Given** 用户在飞书文档评论中 @ 了机器人请求修改文档
**When** AI 通过 `feishu_doc` 工具完成了修改，并通过 `reply_comment` 回复了用户
**Then** 会话窗口中不应显示 "NO_REPLY" 文本（工具已完成了用户可见的回复）

### 场景 C: 模型输出被截断

**Given** AI 开始输出 `NO_REPLY`，但流式输出被意外终止（如 token 限制）
**When** 最终到达的文本仅包含前缀片段（如 `"NO_"`）
**Then** 会话窗口中不应显示这些前缀片段

## 3. 功能需求

### FR-1: 完整 NO_REPLY 拦截

所有流式入口（`processAssistant`、`handleChatDelta`、`handleChatFinal`）和历史同步路径（`shouldSuppressHeartbeatText`、`reconcileWithHistory`）必须过滤完整的 `NO_REPLY` token（不区分大小写，允许前后空白）。

### FR-2: 流式前缀缓存

在流式输出过程中，如果累积文本是 `NO_REPLY` 的前缀片段（如 `"NO"`、`"NO_"`、`"NO_R"`），**不得创建或更新消息**。文本应缓存在 turn 状态中，待后续文本确认后：

- 确认为完整 `NO_REPLY` → 抑制
- 确认为其他正常内容（如 `"NO, I can't do that"`）→ 用完整累积文本创建消息

### FR-3: handleChatDelta 消除消息残留

`handleChatDelta` 在匹配到完整 `NO_REPLY` 或前缀片段时，必须调用 `deleteAssistantMessage` 删除已创建的消息，对齐 `processAssistant` 的行为。

### FR-4: 历史条目过滤

`shouldSuppressHeartbeatText` 过滤 assistant/system 角色的 `NO_REPLY` 消息，防止历史同步时重新引入。

## 4. 实现方案

### 4.1 新增工具函数 (`openclawHistory.ts`)

```typescript
// 完整 token 匹配（仅 NO_REPLY 本身 + 可选空白）
const SILENT_REPLY_RE = /^\s*NO_REPLY\s*$/i;
export const isSilentReplyText = (text: string): boolean =>
  SILENT_REPLY_RE.test(text.trim());

// 流式前缀检测（对齐 OpenClaw tokens.ts 语义）
export const isSilentReplyPrefixText = (text: string): boolean => {
  const trimmed = text.trimStart();
  if (!trimmed || trimmed.length < 2) return false;
  if (trimmed !== trimmed.toUpperCase()) return false;   // 仅全大写
  if (/[^A-Z_]/.test(trimmed)) return false;              // 仅 A-Z 和 _
  const tokenUpper = SILENT_REPLY_TOKEN.toUpperCase();
  if (!tokenUpper.startsWith(trimmed)) return false;      // 必须是前缀
  if (trimmed.includes('_')) return true;                  // 含下划线 → 安全匹配
  return trimmed === 'NO';                                 // 无下划线 → 仅允许 "NO"
};
```

前缀检测的安全设计：

| 输入 | 结果 | 理由 |
|---|---|---|
| `"NO_"` | true | 全大写 + 含下划线 + 是前缀 |
| `"NO"` | true | 全大写 + 是前缀 + bare NO 允许 |
| `"No"` | false | 含小写，避免误杀自然语言 "No" |
| `"NO,"` | false | 含标点，自然语言的特征 |
| `"NOT"` | false | 不是 NO_REPLY 的前缀 |
| `"N"` | false | 长度 < 2 |

### 4.2 流式入口改造 (`openclawRuntimeAdapter.ts`)

三个流式入口的检查链：

```
isHeartbeatAckText(text)  →  心跳抑制（已有）
  || isSilentReplyText(text)  →  完整 NO_REPLY 抑制（新增）
isSilentReplyPrefixText(text)  →  前缀缓存，不创建消息（新增）
  其他正常文本  →  正常创建/更新消息
```

**processAssistant**（agent 事件流）：

```typescript
// 已有：完整心跳 + 完整 NO_REPLY → 删除消息，return
if (isHeartbeatAckText(text) || isSilentReplyText(text)) {
  turn.currentText = text;
  turn.currentAssistantSegmentText = '';
  if (turn.assistantMessageId) {
    this.deleteAssistantMessage(sessionId, turn.assistantMessageId);
    turn.assistantMessageId = null;
  }
  return;
}
// 新增：前缀缓存 → 不创建消息，不 emit，仅更新 turn 状态
if (isSilentReplyPrefixText(text)) {
  turn.currentText = text;
  turn.currentAssistantSegmentText = '';
  if (turn.assistantMessageId) {
    this.deleteAssistantMessage(sessionId, turn.assistantMessageId);
    turn.assistantMessageId = null;
  }
  return;  // ← 关键：不走到 addMessage / emit('message')
}
```

**handleChatDelta**（chat.delta 事件流）：

```typescript
// 修复：完整心跳 + 完整 NO_REPLY → 补充 deleteAssistantMessage
if (isHeartbeatAckText(streamedText) || isSilentReplyText(streamedText)) {
  turn.currentAssistantSegmentText = '';
  if (turn.assistantMessageId) {
    this.deleteAssistantMessage(sessionId, turn.assistantMessageId);  // ← 修复
    turn.assistantMessageId = null;
  }
  return;
}
// 新增：前缀缓存
if (isSilentReplyPrefixText(streamedText)) {
  turn.currentAssistantSegmentText = '';
  if (turn.assistantMessageId) {
    this.deleteAssistantMessage(sessionId, turn.assistantMessageId);
    turn.assistantMessageId = null;
  }
  return;
}
```

**handleChatFinal**（最终消息）：

```typescript
if (isHeartbeatAckText(finalText)
    || isSilentReplyText(finalText)
    || isSilentReplyPrefixText(finalText)) {  // ← 新增：截断的 "NO_" 也抑制
  // 删除消息 + 完成会话
}
```

### 4.3 历史同步改造

**`shouldSuppressHeartbeatText`**：扩展为同时抑制 `NO_REPLY`：

```typescript
if ((role === 'assistant' || role === 'system')
    && (isHeartbeatAckText(text) || isSilentReplyText(text))) {
  return true;
}
```

此改动自动覆盖：
- `extractGatewayHistoryEntry` — 解析历史消息时过滤
- `reconcileWithHistory` — 权威/本地条目对齐时过滤
- `collectChannelHistoryEntries` — 收集 channel 历史时过滤
- `extractCurrentTurnAssistantText` — 提取当前轮次文本时过滤

**`reconcileWithHistory` 的 system 条目**：额外添加 `isSilentReplyText` 检查（该路径直接调用 `isHeartbeatAckText` 而非 `shouldSuppressHeartbeatText`）。

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| 流式输出 `"NO_"` → `"NO_REPLY"` 完整到达 | 前缀阶段缓存；完整 token 到达时抑制，删除已有消息 |
| 流式输出 `"NO_"` → 模型中断，后续未到达 | `handleChatFinal` 的前缀检查捕获 `"NO_"`，删除消息 |
| 流式输出 `"NO, I can't do that"` | `"NO"` 阶段缓存，`"NO,"` 退出前缀状态，用完整文本创建消息，不丢内容 |
| 流式前缀通过 `handleChatDelta` 到达，完整 token 通过 `processAssistant` 到达 | 两个入口的前缀检查都会阻止消息创建/更新 |
| `handleChatDelta` 先创建了消息，后续 `processAssistant` 或 `handleChatFinal` 到达完整 token | 完整 token 检查的 `deleteAssistantMessage` 清理 |
| IM channel 历史同步中出现 `NO_REPLY` 消息 | `shouldSuppressHeartbeatText` 过滤 |
| `reconcileWithHistory` 的 system 条目中出现 `NO_REPLY` | 独立 `isSilentReplyText` 检查过滤 |
| 用户消息内容恰好是 `"NO_REPLY"` | `shouldSuppressHeartbeatText` 仅过滤 assistant + system，不过滤 user 角色 |

## 6. 涉及文件

- `src/main/libs/openclawHistory.ts` — 新增 `isSilentReplyText`、`isSilentReplyPrefixText`，更新 `shouldSuppressHeartbeatText`
- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` — `processAssistant`、`handleChatDelta`、`handleChatFinal`、`reconcileWithHistory` 四处增加检查
- `src/main/libs/openclawHistory.test.ts` — 新增 12 个测试用例

## 7. 验收标准

1. IM 群聊未 @ 机器人时，会话窗口不出现 `"NO_REPLY"` 或 `"NO_"` 等文本
2. 飞书文档评论场景，AI 工具处理完成后，窗口不显示静默回复标记
3. 流式输出过程中，`"NO_"` 等前缀片段不闪现、不残留
4. 模型回复恰好以 "NO" 开头再接正常内容（如 `"NO, this is wrong"`）时，完整内容正常显示
5. 应用重启后，IM channel 历史同步不重新引入静默回复标记
6. `npm test -- openclawHistory` 全部通过
7. `npm run lint` 修改文件无错误
