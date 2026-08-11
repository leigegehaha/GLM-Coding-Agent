# 尾部 NO_REPLY 泄漏修复（流式 + 历史同步）

## 1. 概述

### 1.1 问题

前序修复（2026-05-08）解决了纯 `NO_REPLY` 消息在流式和历史同步中的泄漏。但实际场景中，`NO_REPLY` 还会出现在**正常内容的末尾**，作为尾部追加的控制标记：

```
"These are just background notifications from earlier commands that I already handled.
The PPT was successfully created and delivered to the user. No action needed.

NO_REPLY"
```

这类消息绕过了现有的 `isSilentReplyText()` 检查（该正则 `/^\s*NO_REPLY\s*$/i` 仅匹配整条消息为 `NO_REPLY` 的情况）。

此外，由于消息是流式显示的，尾部 `NO_REPLY` 的逐字符到达会导致用户看到 `\nNO`、`\nNO_`、`\nNO_R`... 逐步出现在正文末尾。

### 1.2 根因

OpenClaw agent 在某些场景下（如子代理完成通知、已通过工具回复后的收尾），会在正常回复内容之后追加 `NO_REPLY` 作为静默标记。IM 平台插件（如飞书）的 `reply-dispatcher` 在 `onIdle` 阶段的 `isNoReplyLeak` 检测仅针对 `completedText` 为空的纯 `NO_REPLY` 场景，当前有内容 + 尾部 `NO_REPLY` 的情况被放过。

智码 GLM Code 侧：
- **历史同步**：`extractGatewayHistoryEntry()` 和 `shouldSuppressHeartbeatText()` 均使用精确匹配，无法识别含有正常前缀内容的尾部 `NO_REPLY`
- **流式路径**：`processAgentAssistantText()` 和 `handleChatDelta()` 将累积文本直接推送给 UI，未裁剪尾部的 `NO_REPLY` token 或其正在形成的前缀

## 2. 用户场景

### 场景 A: 子代理完成通知后追加 NO_REPLY

**Given** AI 在 IM 频道会话中通过子代理完成了 PPT 生成任务
**When** agent 输出总结性文本后追加 `NO_REPLY` 表示无需向 IM 平台回复
**Then** 智码 GLM Code 会话窗口应显示总结文本，但不应显示尾部的 `NO_REPLY`

### 场景 B: 流式过程中尾部前缀逐步出现

**Given** AI 回复正常内容后开始输出 `\nNO_REPLY`
**When** 流式 delta 逐字符到达（`\nNO` → `\nNO_` → `\nNO_R` → ...）
**Then** 用户在流式过程中不应看到 `\nNO`、`\nNO_` 等前缀片段闪现

### 场景 C: 尾部文本不是 NO_REPLY

**Given** AI 正常回复后换行输出 `NOTE: this is important`
**When** 流式到达 `\nNOT` 阶段
**Then** `\nNOT` 不应被误裁剪，完整内容正常显示

## 3. 功能需求

### FR-1: 历史消息去除尾部 NO_REPLY

从 gateway 历史提取 assistant 消息时，去除末尾 `\n...NO_REPLY` 部分，保留前面的有效内容。

### FR-2: 流式推送实时裁剪尾部 NO_REPLY 前缀

在流式文本推送给 UI 之前，裁剪末尾正在形成的 NO_REPLY 前缀（`\nNO`、`\nNO_`、`\nNO_RE` 等）。`turn.currentText` 保持原始值不变（供 text reset 检测和 high-water mark 使用），仅影响推送给 UI 的 `segmentText`。

### FR-3: handleChatFinal 最终文本去除

`handleChatFinal` 的最终文本在所有后续处理之前去除尾部 `NO_REPLY`。

## 4. 实现方案

### 4.1 新增工具函数 (`openclawHistory.ts`)

```typescript
// 匹配已完成消息的尾部 NO_REPLY（要求前置换行）
const TRAILING_SILENT_REPLY_RE = /\n\s*NO_REPLY\s*$/i;

// 用于历史消息和 final 文本：去除完整的尾部 NO_REPLY
export const stripTrailingSilentReplyToken = (text: string): string => {
  return text.replace(TRAILING_SILENT_REPLY_RE, '').trimEnd();
};

// 用于流式推送：同时去除完整 token 和正在形成的部分前缀
const TRAILING_SILENT_REPLY_PARTIAL_TOKENS = [
  'NO_REPLY', 'NO_REPL', 'NO_REP', 'NO_RE', 'NO_R', 'NO_', 'NO',
];

export const stripTrailingSilentReplyTail = (text: string): string => {
  // 先尝试完整 token
  const stripped = text.replace(TRAILING_SILENT_REPLY_RE, '');
  if (stripped !== text) return stripped.trimEnd();
  // 检查部分前缀：最后一个换行符后的内容
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) return text;  // 无换行 → 不裁剪
  const tail = text.slice(lastNewline + 1).trim().toUpperCase();
  if (!tail) return text;
  for (const token of TRAILING_SILENT_REPLY_PARTIAL_TOKENS) {
    if (tail === token) {
      return text.slice(0, lastNewline).trimEnd();
    }
  }
  return text;
};
```

安全设计：

| 输入 | `stripTrailingSilentReplyTail` 结果 | 理由 |
|---|---|---|
| `"Content\n\nNO_REPLY"` | `"Content"` | 完整 token，去除 |
| `"Content\nNO"` | `"Content"` | 前缀匹配，裁剪 |
| `"Content\nNO_R"` | `"Content"` | 前缀匹配，裁剪 |
| `"say NO"` | `"say NO"` | 无前置换行，不裁剪 |
| `"Content\nNOT"` | `"Content\nNOT"` | 不是 NO_REPLY 前缀 |
| `"Content\nNORMAL"` | `"Content\nNORMAL"` | 不是 NO_REPLY 前缀 |
| `"NO_REPLY"` | `"NO_REPLY"` | 无前置换行（此场景由 `isSilentReplyText` 处理） |

### 4.2 历史提取层改造 (`openclawHistory.ts`)

**`extractGatewayHistoryEntry()`** — 对 assistant 角色的消息调用 `stripTrailingSilentReplyToken`：

```typescript
let text = extractGatewayMessageText(message).trim();
if (!text) return null;
if (role === 'assistant') {
  text = stripTrailingSilentReplyToken(text);
  if (!text) return null;
}
if (shouldSuppressHeartbeatText(role, text)) return null;
```

此改动自动覆盖所有调用 `extractGatewayHistoryEntries` 的路径：
- `reconcileWithHistory`
- `collectChannelHistoryEntries`（通过 `extractGatewayHistoryEntries`）
- `syncSystemMessagesFromHistory`

### 4.3 流式入口改造 (`openclawRuntimeAdapter.ts`)

#### 核心思路：双层文本状态

流式路径维护两层文本状态，实现"缓存前缀、只推送确认安全的内容"：

| 层 | 变量 | 含义 | 是否推送 UI |
|---|---|---|---|
| 原始层 | `turn.currentText` | gateway 累积的完整原始文本 | 否 |
| 展示层 | `turn.currentAssistantSegmentText` | 裁剪后推送给 UI 的文本 | 是 |

**原始层不做任何修改**——text reset 检测（`text.length < turn.agentAssistantTextLength`）、high-water mark 追踪、以及后续 `handleChatFinal` 的长度比较都依赖原始长度。

**展示层通过 `stripTrailingSilentReplyTail` 裁剪**——只有通过裁剪函数的文本才会被推送给 store 和 UI。

#### 流式时序示例

假设 agent 输出内容为 `"PPT已生成。\n\nNO_REPLY"`，流式 delta 按如下顺序到达：

```
Delta 1: "PPT已生成。"
Delta 2: "PPT已生成。\n"
Delta 3: "PPT已生成。\n\n"
Delta 4: "PPT已生成。\n\nN"        ← \n后出现单字符，不匹配前缀列表，正常显示
Delta 5: "PPT已生成。\n\nNO"       ← 匹配前缀 "NO"，裁剪为 "PPT已生成。"
Delta 6: "PPT已生成。\n\nNO_"      ← 匹配前缀 "NO_"，裁剪为 "PPT已生成。"
Delta 7: "PPT已生成。\n\nNO_R"     ← 匹配前缀 "NO_R"，裁剪为 "PPT已生成。"
Delta 8: "PPT已生成。\n\nNO_RE"    ← 匹配前缀 "NO_RE"，裁剪为 "PPT已生成。"
Delta 9: "PPT已生成。\n\nNO_REP"   ← 匹配前缀 "NO_REP"，裁剪为 "PPT已生成。"
Delta 10: "PPT已生成。\n\nNO_REPL"  ← 匹配前缀 "NO_REPL"，裁剪为 "PPT已生成。"
Delta 11: "PPT已生成。\n\nNO_REPLY" ← 匹配完整 token，裁剪为 "PPT已生成。"
```

用户看到的 UI 变化：`"PPT已生成。"` 从 Delta 1 显示后**始终保持不变**，尾部 NO_REPLY 的整个形成过程对用户完全不可见。

#### Delta 4 的 "N" 问题

注意 Delta 4 中 `\n\nN` 的 tail 为 `"N"`，不在前缀列表中（列表最短项是 `"NO"`），因此**不会被裁剪**。用户会在 Delta 4 瞬间看到 `"PPT已生成。\n\nN"`。

但这是正确的行为：
- 单个字符 `"N"` 可能是正常内容的开头（如 `"Nice work!"`、`"No problem"`）
- 如果贸然裁剪，当后续到达 `"NOTE: ..."` 时，用户会看到文本先消失再出现，体验更差
- `"N"` → `"NO"` 的转变在实际流式中几乎瞬间发生（同一 SSE chunk 或相邻 chunk），用户几乎无法感知

如果未来需要更激进地隐藏单字符 `"N"`，可将 `"N"` 加入前缀列表，但代价是 `"Nice..."` 等正常内容的首字符也会被暂时吞掉。当前方案选择**保守裁剪**——只在有足够置信度（≥2字符且匹配前缀）时才裁剪。

#### 非 NO_REPLY 尾部的恢复

如果尾部最终不是 NO_REPLY（如 `"Content\nNOTE: important"`），流式过程：

```
Delta 1: "Content\nNO"      ← 匹配前缀 "NO"，裁剪 → UI 显示 "Content"
Delta 2: "Content\nNOT"     ← "NOT" 不在前缀列表 → UI 显示 "Content\nNOT"
Delta 3: "Content\nNOTE"    ← "NOTE" 不在前缀列表 → UI 显示 "Content\nNOTE"
Delta 4: "Content\nNOTE: important" → UI 显示完整内容
```

Delta 1 裁剪后 UI 显示 `"Content"`，Delta 2 不裁剪后 UI 显示 `"Content\nNOT"`——用户看到 `\nNOT` 瞬间出现。这比看到 `\nNO` 再消失更自然，因为从 `\nNO` → `\nNOT` 在流式中通常是同一个 SSE event 或相邻毫秒级的 event。

#### 代码改动

**`processAgentAssistantText()`** — 推送 UI 前裁剪，原始值不变：

```typescript
turn.currentText = text;  // 保持原始值（供 text reset、hwm 使用）
const displayText = stripTrailingSilentReplyTail(text);
turn.currentAssistantSegmentText = this.resolveAssistantSegmentText(turn, displayText);
```

**`handleChatDelta()`** — 同理：

```typescript
const displayStreamedText = stripTrailingSilentReplyTail(streamedText);
const segmentText = this.resolveAssistantSegmentText(turn, displayStreamedText);
```

#### 与前序修复的协作

前序修复（2026-05-08）处理的是**整条消息**为 `NO_REPLY` 的场景：

```
流式: "NO" → "NO_" → "NO_REPLY"（整条消息）
处理: isSilentReplyPrefixText 缓存 → isSilentReplyText 抑制 → deleteAssistantMessage
```

本次修复处理的是**正常内容 + 尾部 NO_REPLY** 的场景：

```
流式: "Content" → "Content\nNO" → "Content\nNO_REPLY"（尾部追加）
处理: stripTrailingSilentReplyTail 裁剪展示文本 → 用户始终只看到 "Content"
```

两者互不冲突：
- 前序的 `isSilentReplyText` / `isSilentReplyPrefixText` 检查**先于**本次的 strip 逻辑执行
- 如果整条消息是 `NO_REPLY`，前序逻辑直接 return，不会走到本次的 strip 代码
- 如果消息有正常前缀内容，前序逻辑不匹配，继续走到本次的 strip 裁剪

### 4.4 Final 文本和历史提取改造

**`handleChatFinal()`**：

```typescript
const rawFinalText = this.resolveFinalTurnText(turn, payload.message);
const finalText = stripTrailingSilentReplyToken(rawFinalText);
```

**`extractCurrentTurnAssistantText()`**：

```typescript
let text = extractMessageText(msg).trim();
text = stripTrailingSilentReplyToken(text);
if (text && !shouldSuppressHeartbeatText('assistant', text)) {
  textParts.push(text);
}
```

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| 流式输出 `"Content\nNO"` → `"Content\nNO_REPLY"` | `\nNO` 阶段裁剪不推送；完整 token 到达后 strip 掉 |
| 流式输出 `"Content\nNO"` → `"Content\nNOTE: important"` | `\nNO` 阶段裁剪；`\nNOT` 到达后不匹配前缀列表，完整文本恢复显示 |
| 历史同步中出现 `"Content\n\nNO_REPLY"` | `extractGatewayHistoryEntry` 提取时 strip，存储为 `"Content"` |
| assistant 消息仅含 `"\nNO_REPLY"` | strip 后为空，`extractGatewayHistoryEntry` 返回 null |
| user 消息尾部含 `\nNO_REPLY` | 不做 strip（仅处理 assistant 角色） |
| `NO_REPLY` 是整条消息（无前置换行） | 由已有的 `isSilentReplyText` 处理，`stripTrailingSilentReplyToken` 不影响 |
| `turn.currentText` 原始值保持 | text reset 检测、high-water mark 等内部逻辑不受裁剪影响 |

## 6. 涉及文件

- `src/main/libs/openclawHistory.ts` — 新增 `stripTrailingSilentReplyToken`、`stripTrailingSilentReplyTail`；修改 `extractGatewayHistoryEntry`
- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` — 修改 `processAgentAssistantText`、`handleChatDelta`、`handleChatFinal`、`extractCurrentTurnAssistantText` 四处
- `src/main/libs/openclawHistory.test.ts` — 新增 20+ 测试用例

## 7. 验收标准

1. 含正常内容 + 尾部 `NO_REPLY` 的 assistant 消息，显示时仅展示正常内容
2. 流式过程中 `\nNO`、`\nNO_` 等前缀片段不闪现
3. 尾部为 `\nNOT`、`\nNORMAL` 等非 NO_REPLY 前缀的文本不被误裁剪
4. 纯 `NO_REPLY` 消息的已有抑制逻辑不受影响
5. user 消息不受任何 strip 影响
6. `npm test -- openclawHistory` 全部通过（40 个测试）
7. `npm run lint` 修改文件无错误
