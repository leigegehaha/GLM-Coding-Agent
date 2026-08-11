# Managed Session 会话同步丢失重复字符修复 Spec

## 1. 概述

### 1.1 问题

用户在 智码 GLM Code 桌面端发起的会话（managed session）中，流式显示的文本会丢失重复字符。典型症状：

| 期望文本 | 实际显示 |
|---------|---------|
| `file:///Users/admin/report.pptx` | `file://Users/admin/report.pptx` |
| `.pptx` | `.ptx` |
| `http://` | `http:/` |

OpenClaw Dashboard 中通过 `chat.history` API 查看的历史记录是正确的，说明 LLM 原始响应没有问题。

### 1.2 根因

问题出在 OpenClaw 网关侧的流式文本缓冲区积累逻辑。

**网关代码**（`openclaw/src/gateway/server-chat.ts:90-107`）：

```typescript
function appendUniqueSuffix(base: string, suffix: string): string {
  if (!suffix) return base;
  if (!base) return suffix;
  if (base.endsWith(suffix)) return base;
  const maxOverlap = Math.min(base.length, suffix.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (base.slice(-overlap) === suffix.slice(0, overlap)) {
      return base + suffix.slice(overlap);  // ← 错误地吞掉重复字符
    }
  }
  return base + suffix;
}
```

该函数用于将 LLM 的流式 delta 累积到 `chatRunState.buffers` 中。当 token 边界恰好落在重复字符中间时（例如 `"file://"` + `"/Users"`），suffix-prefix overlap 检测会将合法的重复字符误判为文本重叠而吞掉。

**数据流影响**：

```
LLM 原始 delta → appendUniqueSuffix 累积到 buffer（此处损坏）
                                     ↓
    chat.delta 事件（损坏）← 150ms 节流广播 buffer 文本
    chat.final 事件（损坏）← turn 结束时直接读取 buffer 文本
    chat.history API（正确）← 直接读取 JSONL 文件中的 LLM 原始响应
```

**智码 GLM Code 侧的累积问题**：

智码 GLM Code 的 `mergeStreamingText` 曾有相同的 overlap 检测（commit d218d56b 已移除）。但由于接收的 `chat.delta` 数据本身已经被网关损坏，即使 智码 GLM Code 侧完美拼接也无法修复丢失的字符。

**最终校正的缺陷**：

当前分支已引入 `syncFinalAssistantWithHistory` 从 `chat.history` 获取权威文本进行校正。但校正时调用 `resolveAssistantSegmentText(turn, canonicalText)` 使用 `committedAssistantText` 做前缀裁剪——而 `committedAssistantText` 本身也是从损坏的流式数据中积累的，可能导致对权威文本的裁剪不准确。

## 2. 用户场景

### 场景 A: 单次回复中包含文件路径

**Given** 用户在桌面端要求 AI 创建一个 PPTX 文件
**When** AI 回复包含 `file:///Users/admin/report.pptx` 路径
**Then** UI 中显示完整的三斜线路径 `file:///`，而非 `file://`

### 场景 B: 多次 tool call 后的最终回复

**Given** 用户发起一个需要多次工具调用的任务
**When** AI 在工具调用后输出最终回复，其中包含重复字符（如 `.pptx`）
**Then** 最终回复文本与 OpenClaw Dashboard 一致，不丢字符

### 场景 C: chat.history 暂时不可用

**Given** turn 完成后 `chat.history` API 由于 I/O 延迟暂时取不到最新数据
**When** 重试机制在 870ms 内仍未获取到当前 turn 的数据
**Then** 保留本地流式文本原样（不替换为错误数据），不影响用户体验

## 3. 功能需求

### FR-1: 使用 chat.history 权威文本校正 managed session 最终 assistant 消息

turn 完成后，从 `chat.history` 获取当前 turn 内最后一个 assistant message 的原始文本，替换本地可能损坏的流式文本。

### FR-2: 不依赖 committedAssistantText 做前缀裁剪

对 managed session，直接从 history 中提取当前 turn 内最后一个 assistant message 的文本，而非用可能损坏的 `committedAssistantText` 对全文做 `startsWith` + `slice` 裁剪。

### FR-3: Turn boundary 安全保护

提取逻辑必须以最后一个 user message 为边界，确保不会因 history 延迟而将前一个 turn 的 assistant 文本误替换到当前 segment。

### FR-4: 精确比较避免无意义刷新

如果权威文本与本地文本完全一致（`===`），只更新 metadata（标记为 final），不触发 content 替换和 UI 重渲染。

## 4. 实现方案

### 4.1 新增 `extractLastAssistantSegmentInTurn` 工具函数

**位置**：`src/main/libs/agentEngine/openclawRuntimeAdapter.ts`（紧接 `extractCurrentTurnAssistantText` 之后）

```typescript
/**
 * Extract the text of the LAST assistant message in the current turn from chat.history.
 * Unlike extractCurrentTurnAssistantText (which concatenates ALL assistant segments),
 * this returns only the final segment — suitable for replacing the last assistant message
 * in managed sessions without relying on committedAssistantText for prefix slicing.
 */
const extractLastAssistantSegmentInTurn = (messages: unknown[]): string => {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isRecord(msg) && (msg as Record<string, unknown>).role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  const startIdx = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
  let lastAssistantText = '';
  for (let i = startIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRecord(msg)) continue;
    const role = typeof msg.role === 'string' ? msg.role.trim().toLowerCase() : '';
    if (role !== 'assistant') continue;
    let text = extractMessageText(msg).trim();
    text = stripTrailingSilentReplyToken(text);
    if (text && !shouldSuppressHeartbeatText('assistant', text)) {
      lastAssistantText = text;  // 只保留最后一个，不拼接
    }
  }
  return lastAssistantText;
};
```

与 `extractCurrentTurnAssistantText` 的区别：

| | `extractCurrentTurnAssistantText` | `extractLastAssistantSegmentInTurn` |
|---|---|---|
| 用途 | 验证 turn 是否有 assistant 输出 | 提取最后一个 segment 的权威文本 |
| 多 assistant messages | 全部拼接（`join('\n\n')`） | 只取最后一个 |
| 用于 | `canonicalText` 空值检查 | 替换本地最后一条 assistant message |

### 4.2 修改 `syncFinalAssistantWithHistory` 的 segment 提取逻辑

**位置**：`syncFinalAssistantWithHistory` 方法中原 `resolveAssistantSegmentText` 调用处

```typescript
// 对 managed session：从 history 取当前 turn 内最后一个 assistant message 文本。
// 不依赖 committedAssistantText（committed 来自流式积累，可能因网关 overlap 检测而损坏）。
const canonicalSegmentText = isManagedSessionKey(turn.sessionKey)
  ? extractLastAssistantSegmentInTurn(historyMessages!)
  : this.resolveAssistantSegmentText(turn, canonicalText);
```

Channel session 保持原有 `resolveAssistantSegmentText` 逻辑不变。

### 4.3 既有重试机制保障

`syncFinalAssistantWithHistory` 已有的重试逻辑（`retryDelaysMs = [0, 120, 250, 500]`）确保：

1. 首次立即尝试（delay=0ms）
2. history 暂时无数据 → 等 120ms 重试
3. 仍无数据 → 等 250ms、500ms
4. 所有重试均失败 → `canonicalText` 为空 → 方法提前返回，不修改本地数据

### 4.4 分支已有的 managed/channel 路由改动

`handleChatFinal` 中已将 managed session 从 `reconcileWithHistory`（全量替换）改为 `syncFinalAssistantWithHistory`（只校正最终 assistant 文本）：

```typescript
if (isManagedSessionKey(turn.sessionKey)) {
  await this.syncFinalAssistantWithHistory(sessionId, turn);
} else {
  await this.reconcileWithHistory(sessionId, turn.sessionKey);
}
```

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 单 segment（无 tool call） | `committedAssistantText` 为空，新旧逻辑结果一致 |
| 多 segment（有 tool call） | 新逻辑直接取 history 最后一个 assistant，不受 committed 损坏影响 |
| history 延迟，当前 turn 数据未写入 | `canonicalText` 为空 → 方法提前返回，不修改本地 |
| history 中最后一个 assistant 是前一个 turn 的 | 不会发生：turn boundary 以 last user message 为界 |
| 权威文本与本地一致 | 只更新 metadata（`isFinal: true`），不替换 content |
| 网关未损坏文本（无重复字符） | 比较结果为相等，无操作 |
| turn token 已过期（新 turn 已开始） | `isCurrentTurnToken` 检查失败 → 方法提前返回 |

## 6. 涉及文件

- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` — 新增 `extractLastAssistantSegmentInTurn`，修改 `syncFinalAssistantWithHistory` 的 segment 提取逻辑，`handleChatFinal` 中 managed/channel 路由
- `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts` — 新增单 segment 和多 segment 修复场景的测试

## 7. 验收标准

1. `npm test -- openclawRuntimeAdapter` 全部通过
2. 桌面端发起会话，让 AI 生成含 `file:///` 路径的内容，turn 结束后 UI 文本与 OpenClaw Dashboard 一致
3. 发起包含 tool call 的会话，tool call 后的最终 assistant 文本不丢字符
4. 已 committed 的 segment（tool call 前的文本）不被影响或替换
5. 会话结束后消息标记为 `isFinal: true, isStreaming: false`
