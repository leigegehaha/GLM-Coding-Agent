# IM 当前轮回复组装夹带历史修复 Spec

## 1. 概述

### 1.1 问题

IM 会话完成后，智码 GLM Code 组装 outbound 回复时可能把历史 assistant 回复一起拼进当前回复，导致用户收到的内容包含旧问答、旧日志排查结果、旧问候语或重复段落。

第一份日志中的典型现象：

1. `IMCoworkHandler:handleComplete` 进入会话完成处理。
2. 完成日志中 `usedStoreMessages: true`，说明回复使用了 `coworkStore.getSession(sessionId).messages`。
3. `messageCount: 15`，明显不只是当前 turn 的消息。
4. `reply` 中混入多轮历史内容，例如早先的问候、生产环境错误日志排查、测试环境错误日志排查，以及后续任务排查结果。

这说明问题不是模型主动复述历史，而是 IM 完成阶段选错了消息范围。

### 1.2 根因

`src/main/im/imCoworkHandler.ts` 中 `handleComplete()` 当前优先使用整个 store session：

```typescript
const session = this.coworkStore.getSession(sessionId);
const storeMessages = session?.messages ?? [];
const messages = storeMessages.length > 0 ? storeMessages : accumulator.messages;
```

这段逻辑的初衷是：`reconcileWithHistory()` 后 store 里的 assistant 文本比 accumulator 中的流式快照更权威。

但 store messages 是整条 IM 会话历史，不是当前 turn。随后 `formatReply()` / `formatReplyRaw()` 从传入 messages 中提取 assistant 文本时，会把当前 turn 之前的 assistant 也纳入结果。

因此根因是：

```text
权威来源选择正确，但缺少 current-turn boundary。
```

正确行为应该是：

```text
使用 store 中当前 turn 的最终文本；
不能使用整个 store session 的所有历史文本。
```

## 2. 用户场景

### 场景 A: 连续两轮 IM 问答

**Given** 用户在同一个 IM 会话中连续发起两轮问题
**When** 第二轮问题处理完成
**Then** outbound 回复只包含第二轮答案，不包含第一轮答案。

### 场景 B: 当前 turn 包含工具调用

**Given** 当前 turn 中 assistant 先说明计划，然后执行 tool call，最后输出总结
**When** 会话完成
**Then** outbound 回复只包含当前 turn 内可见 assistant 文本，保留正确顺序，不夹带旧 tool result 或旧 assistant。

### 场景 C: store 已经过 `reconcileWithHistory()` 替换

**Given** 当前 turn 完成后，store 中 assistant 文本已被 `chat.history` 权威内容更新
**When** `IMCoworkHandler` 生成回复
**Then** 应使用 store 中当前 turn 的最终文本，而不是 accumulator 中较旧的流式快照，也不是整个 store session。

### 场景 D: 定时提醒后台投递

**Given** cron 触发 IM reminder background delivery
**When** assistant 输出提醒正文
**Then** reminder 仍可绕过 reminder commitment guard，但只发送本次 reminder turn 的 assistant 文本，不夹带历史内容。

## 3. 功能需求

### FR-1: `handleComplete()` 必须只格式化当前 turn 消息

`handleComplete()` 不得直接把整个 `storeMessages` 传给 `formatReply()` 或 `formatReplyRaw()`。

必须先选出当前 turn 范围：

```typescript
const messages = this.selectCurrentTurnMessages(sessionId, accumulator, storeMessages);
```

### FR-2: 优先使用 store 中的最终文本

current-turn selector 应优先回读 store 中对应消息的最终内容，避免 accumulator 中的流式快照不完整。

优先级：

1. accumulator 记录了当前 turn message ids，且这些 ids 能在 store 中命中：使用 store 中对应消息。
2. ids 因 `reconcileWithHistory()` full replace 不再稳定：按当前 turn boundary 从 store tail 中选择。
3. store 无法定位当前 turn：fallback 到 accumulator messages。

禁止 fallback 到整个 store session。

### FR-3: 以当前 inbound 消息作为 turn boundary

如果无法按 message id 匹配，应通过当前 turn 的 user/system 输入定位边界：

1. 找到当前 turn 对应的最后一个 user/system 消息。
2. 从该边界开始收集当前 turn 的 user/system、assistant、tool_use、tool_result 消息。
3. 如果当前 turn 是 reminder execution，则以 reminder system/user 消息作为边界。
4. 如果找不到边界，则使用 accumulator 中本次收集到的 assistant 消息。

### FR-4: 回复格式化只处理可见 assistant 文本

选出 current-turn messages 后，格式化阶段仍需过滤：

1. 排除 `metadata.isThinking`。
2. 排除 `tool_use`、`tool_result`。
3. 排除 heartbeat/silent reply token。
4. 保留当前 turn 内多段 assistant 的顺序。

### FR-5: thinking 内容不得进入 IM outbound

thinking/reasoning 内容只允许用于 Cowork UI 内部展示或调试，不允许通过 IM outbound 发给用户。

需要覆盖两种形态：

1. 结构化 thinking message：`message.type === 'assistant'` 且 `message.metadata?.isThinking === true`。
2. 文本泄漏形态：assistant content 中包含 `<think>...</think>`、`<thinking>...</thinking>` 或同类 reasoning 包裹文本。

结构化 thinking 应直接跳过。文本泄漏应在格式化前剥离；如果剥离后没有可见内容，则按空回复策略处理。

### FR-6: reminder guard 行为不回退

普通 IM turn 仍走 `analyzeIMReply()`，保证未成功创建 cron 的“我会提醒你”类承诺继续被 guard。

已确认是 reminder execution/background delivery 的 turn 继续走 `formatReplyRaw()`，但输入也必须是 current-turn messages。

## 4. 实现方案

### 4.1 扩展 `MessageAccumulator`

在 `src/main/im/imCoworkHandler.ts` 中扩展 accumulator，用于记录本轮消息范围：

```typescript
interface MessageAccumulator {
  messages: CoworkMessage[];
  resolve?: (text: string) => void;
  reject?: (error: Error) => void;
  timeoutId?: NodeJS.Timeout;
  turnStartedAt?: number;
  inboundMessageId?: string;
  seenMessageIds?: Set<string>;
  backgroundDelivery?: {
    conversationId: string;
    platform: Platform;
  };
}
```

创建 accumulator 时记录 `turnStartedAt`。`handleMessage()` 收到 runtime message 时，把 message 放入 `messages`，同时记录 message id。

### 4.2 新增 current-turn selector

新增私有方法：

```typescript
private selectCurrentTurnMessages(
  sessionId: string,
  accumulator: MessageAccumulator,
  storeMessages: CoworkMessage[],
): CoworkMessage[] {
  const byId = this.selectStoreMessagesByAccumulatorIds(accumulator, storeMessages);
  if (byId.length > 0) return byId;

  const byTurnTail = this.selectStoreMessagesByTurnBoundary(accumulator, storeMessages);
  if (byTurnTail.length > 0) return byTurnTail;

  return accumulator.messages;
}
```

选择器只负责范围选择，不负责 reminder guard 或 assistant 文本分析。

### 4.3 按 accumulator ids 回读 store

如果 accumulator 中的 message id 在 store 中仍存在，则按 accumulator 顺序回读：

```typescript
private selectStoreMessagesByAccumulatorIds(
  accumulator: MessageAccumulator,
  storeMessages: CoworkMessage[],
): CoworkMessage[] {
  const ids = accumulator.messages.map((message) => message.id).filter(Boolean);
  if (ids.length === 0) return [];

  const storeById = new Map(storeMessages.map((message) => [message.id, message]));
  return ids
    .map((id) => storeById.get(id))
    .filter((message): message is CoworkMessage => Boolean(message));
}
```

这个路径可以保留 store 的最终 assistant 文本，同时不会扩大到历史消息。

但 by-id 结果只有在以下条件之一满足时才可以直接使用：

1. accumulator 中的消息 id 全部在 store 中命中。
2. by-id 结果已经包含可见 assistant 文本。

如果只命中了当前 turn 的 `tool_use` / `tool_result`，但 final assistant 因 `reconcileWithHistory()` full replace 换了 id，不能提前返回；必须继续走 turn boundary fallback，否则会漏掉最终回答。

### 4.4 按 turn boundary 从 store tail 选择

当 ids 不稳定时，从 store 中定位当前 turn：

```typescript
private selectStoreMessagesByTurnBoundary(
  accumulator: MessageAccumulator,
  storeMessages: CoworkMessage[],
): CoworkMessage[] {
  const boundary = this.findCurrentTurnBoundary(accumulator, storeMessages);
  if (boundary < 0) return [];
  return storeMessages.slice(boundary).filter((message) => (
    message.type === 'user' ||
    message.type === 'system' ||
    message.type === 'assistant' ||
    message.type === 'tool_use' ||
    message.type === 'tool_result'
  ));
}
```

这里需要保留 boundary user/system 消息。普通回复格式化会忽略它们；reminder background delivery 需要它们让 `isReminderSystemTurn()` 判断本 turn 是否真的是提醒触发。

边界查找优先级：

1. `inboundMessageId` 命中 store。
2. accumulator 中最后一个 user/system 消息的内容与 store tail 匹配。
3. `turnStartedAt` 之后的最后一个 user/system 消息。

如果这些都失败，返回空数组，让调用方 fallback 到 accumulator。

### 4.5 修改 `handleComplete()`

将当前逻辑：

```typescript
const messages = storeMessages.length > 0 ? storeMessages : accumulator.messages;
```

改为：

```typescript
const messages = this.selectCurrentTurnMessages(sessionId, accumulator, storeMessages);
```

日志也应改为输出 selector 来源，而不是只输出 `usedStoreMessages`：

```text
[IMCoworkHandler] session complete reply selected:
sessionId=..., source=store-by-id, selected=3, store=15, accumulator=4
```

不要在 info 日志中输出完整 reply 内容，避免用户 IM 内容过长或敏感。

### 4.6 保持 `formatReply()` 和 `formatReplyRaw()` 职责清晰

`formatReply()` 继续调用 `analyzeIMReply(messages)`，但前提是 messages 已经是 current-turn scope。

`formatReplyRaw()` 继续只抽取 assistant 文本，供 reminder execution 使用，但同样不承担历史过滤职责。

### 4.7 显式处理 thinking 内容

当前 `analyzeIMReply()` 已经跳过 `metadata.isThinking`：

```typescript
if (message.type === 'assistant' && message.content && !message.metadata?.isThinking) {
  const normalized = message.content.trim();
  if (normalized) {
    assistantParts.push(normalized);
  }
}
```

本次修复需要把这个约束固定为 IM outbound 合同：

1. `formatReply()` 路径继续依赖 `analyzeIMReply()` 过滤结构化 thinking。
2. `formatReplyRaw()` 路径也必须保持 `!message.metadata?.isThinking` 过滤，避免 reminder execution 把 thinking 发出去。
3. 如发现 OpenClaw/provider 把 reasoning 包在普通 assistant content 中，应在 IM 格式化层增加统一 sanitizer：

```typescript
const stripThinkingBlocks = (text: string): string => text
  .replace(/<think>[\s\S]*?<\/think>/gi, '')
  .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
  .trim();
```

sanitizer 应只用于 IM outbound 文本，不改写 Cowork store 原始消息，避免影响 UI 历史和调试信息。

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| 当前 turn 没有 assistant 输出 | 返回 `DEFAULT_IM_EMPTY_REPLY` 或已有空回复策略 |
| store 中存在多轮历史 | 只按 selector 返回 current-turn messages |
| accumulator ids 在 store 中仍存在 | 按 id 回读 store，保留最终文本 |
| `reconcileWithHistory()` full replace 导致 id 不匹配 | 使用 turn boundary tail |
| turn boundary 无法定位 | fallback 到 accumulator messages |
| accumulator 中只有 assistant 流式消息 | 使用 accumulator，不读取整个 store |
| reminder execution | 只绕过 guard，不绕过 current-turn selection |
| thinking 消息 | 不进入最终 outbound 回复 |
| assistant content 中夹 `<think>...</think>` | IM outbound 前剥离 thinking block，不改写 store |
| thinking 剥离后没有可见文本 | 返回空回复策略，不发送 reasoning |
| tool result 很长 | 不进入最终 outbound 回复，除非以后产品明确要求 |
| heartbeat/silent reply | 不发送给 IM 用户 |

## 6. 涉及文件

- `src/main/im/imCoworkHandler.ts`
  - 扩展 `MessageAccumulator`
  - 修改 `handleMessage()`
  - 修改 `handleComplete()`
  - 新增 current-turn selector 及辅助方法
- `src/main/im/imCoworkHandler.test.ts`
  - 增加当前 turn selection、历史隔离、reminder background delivery 回归测试
- `src/main/im/imReplyGuard.ts`
  - 已过滤 `metadata.isThinking`；如补 sanitizer，应确认它只分析传入 scope，不承担历史过滤

## 7. 测试计划

### 7.1 单元测试

`imCoworkHandler.test.ts` 新增：

1. store 中含历史 assistant + 当前 assistant 时，只回复当前 assistant。
2. accumulator id 能在 store 命中时，使用 store 中对应消息的最终内容。
3. accumulator id 不命中时，按当前 user/system boundary 从 store tail 选择。
4. boundary 无法定位时，fallback 到 accumulator，不读取整个 store。
5. background reminder 只发送本次 reminder 输出，不夹历史。
6. thinking、tool_use、tool_result 不进入普通 IM 最终回复。
7. `formatReplyRaw()` reminder execution 也不发送 `metadata.isThinking` 内容。
8. assistant content 中含 `<think>内部推理</think>最终答案` 时，IM outbound 只包含 `最终答案`。
9. thinking 剥离后为空时，不发送 reasoning，走空回复策略。
10. reminder 创建失败 guard 仍生效，不因 selector 改动回退。

运行：

```bash
npm test -- imCoworkHandler
```

### 7.2 日志回放测试

基于第一份日志构造 fixture：

1. store session 中包含 15 条历史消息。
2. accumulator 中只包含当前 turn 的 messages。
3. `handleComplete()` 执行后，reply 不包含早先问候、生产环境日志总结、上一轮测试环境总结。
4. selector 日志显示 `store=15` 但 `selected` 只覆盖当前 turn。

### 7.3 手动验证

对共用 `IMCoworkHandler` 的 IM 平台做连续两轮问答：

```text
feishu, weixin, wecom, dingtalk, qq, telegram, discord, nim, popo
```

验证重点是 outbound 回复范围：

1. 第二轮回复不包含第一轮答案。
2. 当前 turn 有 tool call 时，最终回复不夹历史 tool result。
3. Cowork UI 中完整历史仍存在，只有 IM outbound 被限制为当前 turn。
4. reminder execution 仍能正常发送提醒正文。

## 8. 验收标准

1. `handleComplete()` 不再用整个 store session 生成 IM outbound 回复。
2. 第一份日志对应场景中，`reply` 不再包含多轮历史内容。
3. 连续 IM 问答时，第二轮 outbound 只包含第二轮答案。
4. store 仍可作为当前 turn 最终文本来源，不回退到不完整流式快照。
5. reminder guard 行为保持不变。
6. reminder execution/background delivery 不夹带历史内容。
7. thinking/reasoning 内容不会进入普通 IM 回复或 reminder background delivery。
8. 新增单元测试通过。
9. 日志能看出 selector 来源和 selected/store/accumulator 数量，但不输出完整敏感内容。

## 9. 不采用的方案

### 9.1 只在 `analyzeIMReply()` 中去重

不采用。`analyzeIMReply()` 无法可靠判断哪些 assistant 属于历史 turn。历史过滤必须发生在消息范围选择阶段。

### 9.2 直接改为只用 accumulator

不作为首选。accumulator 可能包含流式中间态，store 在 `reconcileWithHistory()` 后更接近权威最终文本。正确方案是“用 store 的当前 turn”，不是完全放弃 store。

### 9.3 在最终回复中按文本相似度删除重复段落

不采用。相似度去重会误删用户需要的重复内容，也无法处理旧问答夹带。根因是 turn boundary 缺失，应修范围选择。

### 9.4 改提示词要求模型不要复述历史

不采用。日志显示异常来自本地组装阶段，不是模型策略问题。
