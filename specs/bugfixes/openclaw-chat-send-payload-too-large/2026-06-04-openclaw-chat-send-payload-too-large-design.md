# OpenClaw chat.send payload 过大导致网关 1009 断连修复设计文档

## 1. 概述

### 1.1 问题

用户在 智码 GLM Code Cowork 中一次性提交多张图片附件时，界面提示：

```text
AI 引擎连接中断，请重试。如果问题持续，请尝试重启应用。
```

并额外展示底层错误：

```text
gateway closed (1009):
```

从用户视角看，这像是 OpenClaw 引擎不稳定或连接异常；但实际问题是本次 `chat.send` WebSocket 消息整体过大，OpenClaw 网关拒收后主动关闭连接。

当前 智码 GLM Code 只校验了单张图片原始大小，不校验一次 `chat.send` 的总 payload 大小。多张图片各自没有超过单图限制，但合并为 base64 JSON payload 后超过 OpenClaw 网关 WebSocket 上限，最终触发 `1009`。

### 1.2 现场证据

本次用户提供的关键日志文件：

| 文件　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　| 作用　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　|
| -------------------------------------------------------------------| -----------------------------------------------------------------------------------------------|
| `1780471049120lobsterai-logs-20260603-151636/main-2026-06-03.log` | 智码 GLM Code 主进程日志，包含 OpenClaw stdout/stderr 透传、`chat.send` 附件诊断和网关 close code |

关键失败链路 1：

1. `15:09:44` 用户新建 Cowork session，prompt 长度 15，图片附件 8 张。
2. 智码 GLM Code 主进程收到 8 张图片，base64 长度分别为：

| 图片 | base64Length |
|---|---:|
| `generated-image-20260525-163814-1.png` | 1,606,400 |
| `generated-image-20260525-163944-1.png` | 1,516,864 |
| `generated-image-20260525-164305-1.png` | 2,147,108 |
| `generated-image-20260525-164759-1.png` | 2,264,976 |
| `generated-image-20260525-165326-1.png` | 11,950,524 |
| `generated-image-20260525-165403-1.png` | 5,747,224 |
| `generated-image-20260525-165518-1.png` | 11,409,160 |
| `generated-image-20260525-165727-1.png` | 10,678,296 |

3. base64 总长度约 47.3 MB。
4. `15:09:47` `chat.send` 发送前日志显示：

```text
[OpenClawRuntime] chat.send with attachments: 8 images
```

5. OpenClaw stderr 紧接着输出：

```text
[ws] error conn=... remote=127.0.0.1: Max payload size exceeded
```

6. 智码 GLM Code GatewayClient 收到：

```text
GatewayClient: onClose — code: 1009 reason:  settled: true
```

7. Cowork session 错误为：

```text
Error: gateway closed (1009):
```

关键失败链路 2：

1. `15:15:44` 用户继续同一 session，图片附件 4 张。
2. base64 长度分别为：

| 图片　　　　　　　　　　　　　　　　　　| base64Length |
| -----------------------------------------| -------------:|
| `chibi-husky.png`　　　　　　　　　　　 | 6,196,564   |
| `60s-illustration.png`　　　　　　　　　| 12,437,340  |
| `generated-image-20260525-165326-1.png` | 11,950,524  |
| `generated-image-20260525-165403-1.png` | 5,747,224   |

3. base64 总长度约 36.3 MB。
4. OpenClaw stderr 再次输出：

```text
[ws] error conn=... remote=127.0.0.1: Max payload size exceeded
```

5. GatewayClient 再次收到 close code `1009`。

成功对照：

1. `15:12:06` 用户继续 session，图片附件 1 张，base64 长度约 12.4 MB。
2. `chat.send` 成功，OpenClaw 输出：

```text
[gateway] Intercepted large image payload. Saved: media://inbound/image---19a689fa-301c-40fe-a2b2-16408ac4d544.png
```

3. `15:12:53` 用户新建 session，图片附件 2 张，base64 总长度约 18.6 MB。
4. `chat.send` 成功，OpenClaw 分别保存两张 inbound image。

### 1.3 根因

直接根因是 **OpenClaw 网关 WebSocket 服务端拒收超过最大 payload 的 `chat.send` 请求，并用 close code `1009` 关闭连接**。

智码 GLM Code 当前存在两层校验：

1. 前端提交前通过 `validateCoworkImageAttachmentSize()` 校验单张图片。
2. 主进程 `cowork:session:start` / `cowork:session:continue` 再校验一次单张图片。

单张图片限制定义在：

```typescript
export const COWORK_IMAGE_ATTACHMENT_MAX_BYTES = 30 * 1000 * 1000;
```

但 OpenClaw 网关限制的是 **整条 WebSocket RPC 消息的 payload 大小**，不是单张图片原始大小。

本次 `chat.send` payload 至少包含：

- `sessionKey`
- `message`
- `deliver`
- `idempotencyKey`
- 可选 `cwd`
- `attachments`
- 每个 attachment 的 `type`
- 每个 attachment 的 `mimeType`
- 每个 attachment 的 base64 `content`
- GatewayClient 可能添加的外层 RPC frame 字段，例如 `id`、`method`、`params`

因此，多张图片在单张都不超过约 30 MB 的情况下，合并后的 JSON/WebSocket payload 仍可能超过 OpenClaw 网关上限。

### 1.4 目标

修复目标：

1. 在发送 `chat.send` 前估算本次完整请求 payload 大小。
2. 当本次消息超过安全上限时，阻止发送，不让 OpenClaw 网关被打断。
3. 用户提示应说明“本次消息过大”，并给出可操作建议：减少附件数量、压缩图片或拆分提交。
4. 提示中应说明单次消息整体上限约为 30 MB，但避免承诺精确文件大小等价于 30 MB。
5. 即使发送前估算漏判，收到 `gateway closed (1009)`、`Max payload size exceeded` 等错误时，也应分类为“消息过大”，而不是“AI 引擎连接中断”。
6. 诊断日志应记录估算 payload 大小、附件数量、base64 总长度和阈值，便于后续定位。
7. 保留现有单张图片大小限制，避免单张异常大图继续进入运行时。

### 1.5 非目标

本修复不做以下事情：

- 不修改 OpenClaw 网关的最大 payload 配置。
- 不依赖提升 `ws` 服务端 `maxPayload` 来解决问题。
- 不把前端图片总量硬限制为 20 MB。
- 不按图片数量做固定限制。
- 不在本次修复中实现自动图片压缩或缩放。
- 不改变模型多模态能力判断逻辑。
- 不改变图片附件持久化、缩略图预览和消息 metadata 展示逻辑。
- 不把所有网关断连都归类为消息过大。

## 2. 用户场景

### 场景 1: 多张图片合并后超过单次消息上限

**Given** 用户选择一个支持图片输入的模型
**And** 用户一次性添加多张图片
**And** 每张图片都没有超过单张图片限制
**When** 本次 `chat.send` 完整 payload 估算超过安全上限
**Then** 智码 GLM Code 应阻止发送
**And** 展示“本次消息过大，请减少附件数量、压缩图片或拆分为多次提交”
**And** OpenClaw 网关不应出现 `Max payload size exceeded`
**And** Cowork session 不应因为该请求进入假性的引擎断连错误

### 场景 2: 单张大图但 payload 未超过上限

**Given** 用户添加 1 张图片
**And** 图片没有超过单张图片限制
**And** 本次完整 payload 小于安全上限
**When** 用户发送消息
**Then** 智码 GLM Code 应允许发送
**And** OpenClaw 网关应继续执行现有 large image intercept 逻辑
**And** 不应因为粗暴总量限制误拦截

### 场景 3: 文字很长且带图片

**Given** 用户输入较长文本
**And** 用户添加图片附件
**When** 文本、system prompt、附件 base64、JSON/RPC 包装合计超过安全上限
**Then** 智码 GLM Code 应提示本次消息过大
**And** 提示应使用“本次消息”，而不是只说“图片过大”

### 场景 4: 估算未覆盖真实 GatewayClient 包装

**Given** 发送前估算未超过安全阈值
**And** GatewayClient 或 OpenClaw 内部额外包装导致真实 payload 超限
**When** OpenClaw 网关返回 `Max payload size exceeded` 或 close code `1009`
**Then** 智码 GLM Code 应把错误分类为“本次消息过大”
**And** UI 不应显示通用“AI 引擎连接中断”

### 场景 5: 普通网关断连

**Given** OpenClaw 网关因为网络、服务重启或其他原因断开
**When** 错误不是 `1009`、`Max payload size exceeded`、`payload too large` 或同类消息
**Then** 智码 GLM Code 应继续使用现有网关断连、服务重启或网络错误提示
**And** 不应误提示“本次消息过大”

## 3. 功能需求

### FR-1: 发送前估算完整 chat.send RPC payload

在 `OpenClawRuntimeAdapter.runTurn()` 中构造 `chat.send` 参数后、调用 `client.request('chat.send', ...)` 前，应估算完整请求 payload 大小。

估算对象应尽量接近 GatewayClient 实际发送帧，而不是只计算 `params`：

```typescript
const chatSendParams = {
  sessionKey,
  message: outboundMessage,
  deliver: false,
  idempotencyKey: runId,
  ...(runCwd ? { cwd: runCwd } : {}),
  ...(attachments ? { attachments } : {}),
};

const estimatedFrameBytes = Buffer.byteLength(JSON.stringify({
  id: 'estimate',
  method: 'chat.send',
  params: chatSendParams,
}), 'utf8');
```

说明：

1. `Buffer.byteLength(..., 'utf8')` 能准确计算该 JSON 字符串的 UTF-8 字节数。
2. 图片 base64 是 ASCII，1 个字符约等于 1 字节。
3. 中文文本和其他非 ASCII 字符会按 UTF-8 多字节计算。
4. 该估算不能保证与 GatewayClient 内部最终帧 100% 等同，但足够接近。
5. 为避免边界误差，阈值必须留出安全余量。

### FR-2: 安全阈值应接近 OpenClaw 上限但保留余量

OpenClaw 网关日志表现出的上限约为 30 MB 级别。智码 GLM Code 应定义一个集中常量，例如：

```typescript
const OPENCLAW_CHAT_SEND_PAYLOAD_LIMIT_BYTES = 30 * 1000 * 1000;
const OPENCLAW_CHAT_SEND_PAYLOAD_SAFETY_MARGIN_BYTES = 500 * 1000;
const OPENCLAW_CHAT_SEND_PAYLOAD_SAFE_LIMIT_BYTES =
  OPENCLAW_CHAT_SEND_PAYLOAD_LIMIT_BYTES - OPENCLAW_CHAT_SEND_PAYLOAD_SAFETY_MARGIN_BYTES;
```

判断逻辑使用 safe limit：

```typescript
if (estimatedFrameBytes > OPENCLAW_CHAT_SEND_PAYLOAD_SAFE_LIMIT_BYTES) {
  throw new Error(buildChatSendPayloadTooLargeError(...));
}
```

阈值说明：

1. UI 文案展示“约 30 MB”，不展示 `29.5 MiB` 这类内部安全阈值。
2. 代码判断使用安全阈值，避免贴线通过后仍被网关关闭。
3. 不使用 20 MB 作为硬限制，避免过度拦截本来能成功的请求。

### FR-3: 错误信息必须可被分类为消息过大

发送前阻止时抛出的错误，应包含稳定可匹配的英文标记，例如：

```text
chat.send payload too large
```

同时包含诊断信息：

- estimated bytes
- safe limit bytes
- attachment count
- attachment base64 total bytes

示例：

```text
chat.send payload too large: estimated 38128542 bytes exceeds safe limit 30932992 bytes
```

UI 不应直接展示该英文错误，而应通过错误分类转换为用户友好文案。

### FR-4: UI 文案使用“本次消息过大”

新增 i18n key，例如：

```typescript
coworkErrorMessageTooLarge
```

中文推荐文案：

```text
本次消息过大，请减少附件、压缩图片或拆分提交。（单次整体需小于约 30MB）
```

如果调用方能提供估算大小，推荐更具体的文案：

```text
本次消息约 {size}，超过 AI 引擎单次接收上限（约 {limit}）。请减少附件数量、压缩图片，或拆分为多次提交。
```

英文推荐文案：

```text
This message is too large. Reduce attachments, compress images, or split it up. (Keep each message under about 30 MB.)
```

或带估算大小：

```text
This message is about {size}, exceeding the AI engine's per-message limit of about {limit}. Reduce the number of attachments or split it into multiple messages.
```

文案原则：

1. 使用“本次消息过大”，不只说“图片过大”。
2. 说明下一步动作：减少附件数量、压缩附件或拆分提交。
3. 使用“约 30MB”，避免精确承诺。
4. 不向普通用户展示 `1009`、`WebSocket`、`payload` 等底层术语。

### FR-5: 错误分类识别 1009 和 Max payload

更新 `src/common/coworkErrorClassify.ts`，新增或扩展规则，把以下错误归类为 `coworkErrorMessageTooLarge`：

```text
chat.send payload too large
Max payload size exceeded
gateway closed (1009)
message too big
payload too large
request entity too large
413
```

注意顺序：

1. `Max payload size exceeded`、`gateway closed (1009)` 应优先于通用 gateway disconnected。
2. `payload too large` 当前可能归入 input too long，应考虑迁移到 message too large，或让 `coworkErrorInputTooLong` 文案覆盖不够准确的问题。
3. `413` 可保留为 input too long，也可归入 message too large；如果迁移，需要确认其他 provider 413 的用户语义是否仍合理。

### FR-6: startSession 和 continueSession 都必须一致处理

本次修复涉及两条路径：

1. 新建会话：`runtime.startSession()` -> `runTurn()` -> `chat.send`
2. 继续会话：`runtime.continueSession()` -> `runTurn()` -> `chat.send`

由于最终都进入 `OpenClawRuntimeAdapter.runTurn()`，payload 大小校验应放在 `runTurn()` 的 `chat.send` 调用前，避免两条路径重复实现或遗漏。

UI 侧处理也必须覆盖：

1. `coworkService.startSession()` 返回失败时 toast。
2. `coworkService.continueSession()` 返回失败时系统消息。
3. runtime async error 通过 `cowork:stream:error` 返回时的系统消息。

### FR-7: 日志诊断需要记录摘要，不能打印完整 base64

当 payload 超限时，应记录一条 warn 或 error 诊断日志：

```text
[OpenClawRuntime] chat.send payload exceeded safe limit. Session <id>. Estimated 38128542 bytes. Safe limit 30932992 bytes. Attachments 4. Attachment base64 total 36335652 bytes.
```

日志要求：

1. 不打印完整 base64。
2. 可打印每张图片的 name、mimeType、base64Length。
3. 错误对象作为最后一个参数仅在捕获异常时使用。
4. 日志使用英文自然语言，符合项目日志规范。

## 4. 实现方案

### 4.1 新增 payload 限制工具函数

建议在 `src/shared/cowork/imageAttachments.ts` 或新增 `src/shared/cowork/chatPayload.ts` 中定义通用常量和格式化函数。

如果只在 OpenClaw runtime 使用，可先放在 `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` 附近，后续再抽取。

建议常量：

```typescript
const OPENCLAW_CHAT_SEND_PAYLOAD_LIMIT_BYTES = 30 * 1000 * 1000;
const OPENCLAW_CHAT_SEND_PAYLOAD_SAFETY_MARGIN_BYTES = 500 * 1000;
const OPENCLAW_CHAT_SEND_PAYLOAD_SAFE_LIMIT_BYTES =
  OPENCLAW_CHAT_SEND_PAYLOAD_LIMIT_BYTES - OPENCLAW_CHAT_SEND_PAYLOAD_SAFETY_MARGIN_BYTES;
```

建议 helper：

```typescript
function estimateJsonUtf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function formatApproxMegabytes(bytes: number): string {
  return `${(bytes / 1000 / 1000).toFixed(bytes >= 10 * 1000 * 1000 ? 1 : 2)}MB`;
}
```

注意：如果 helper 放到 shared，renderer 不能直接使用 Node `Buffer`，需要改用 `TextEncoder`：

```typescript
new TextEncoder().encode(JSON.stringify(value)).length
```

本次优先在 main process 中估算，使用 `Buffer.byteLength` 即可。

### 4.2 在 chat.send 前复用同一个 params 对象

当前 `runTurn()` 中先构造 `attachments`，再内联传给 `client.request()`：

```typescript
const sendResult = await client.request<Record<string, unknown>>('chat.send', {
  sessionKey,
  message: outboundMessage,
  deliver: false,
  idempotencyKey: runId,
  ...(runCwd ? { cwd: runCwd } : {}),
  ...(attachments ? { attachments } : {}),
}, { timeoutMs: 90_000 });
```

建议改为先构造 `chatSendParams`：

```typescript
const chatSendParams = {
  sessionKey,
  message: outboundMessage,
  deliver: false,
  idempotencyKey: runId,
  ...(runCwd ? { cwd: runCwd } : {}),
  ...(attachments ? { attachments } : {}),
};
```

估算、日志、实际发送都使用同一个对象：

```typescript
assertChatSendPayloadWithinLimit(sessionId, chatSendParams, attachments);

const sendResult = await client.request<Record<string, unknown>>(
  'chat.send',
  chatSendParams,
  { timeoutMs: 90_000 },
);
```

这样避免估算对象和真实发送对象漂移。

### 4.3 超限时清理 turn 状态

payload 校验发生在 `activeTurns.set()` 之后、`client.request()` 之前。若校验抛错，必须走现有 catch 或显式清理：

1. `cleanupSessionTurn(sessionId)`
2. 更新 session status 为 `error`
3. emit `error`
4. reject pending turn

推荐把 payload 校验放入现有 `try { client.request(...) } catch (error) { ... }` 覆盖范围内，沿用当前错误处理路径。

### 4.4 更新错误分类和 i18n

更新文件：

| 文件 | 变更 |
|---|---|
| `src/common/coworkErrorClassify.ts` | 新增 message-too-large 分类规则 |
| `src/common/coworkErrorClassify.test.ts` | 增加 `gateway closed (1009)`、`Max payload size exceeded`、`chat.send payload too large` 测试 |
| `src/renderer/services/i18n.ts` | 新增中英文 `coworkErrorMessageTooLarge` |
| `src/main/i18n.ts` | 如 IM 或 main process 也复用分类提示，则新增对应 key |

分类规则应在 gateway disconnected 前：

```typescript
[/chat\.send payload too large|Max payload size exceeded|gateway closed \(1009\)|message too big|payload too large/i, 'coworkErrorMessageTooLarge'],
```

### 4.5 保留单张图片限制

现有单张图片限制仍然有价值：

1. 防止单张极大图片占用 renderer/main 内存。
2. 防止单图即使拆分也无法发送。
3. 让用户在选中明显过大的单图时尽早得到反馈。

本次新增的是“单次消息总 payload”限制，不替代 `COWORK_IMAGE_ATTACHMENT_MAX_BYTES`。

## 5. 测试计划

### 5.1 单元测试

新增或更新测试：

| 测试文件 | 用例 |
|---|---|
| `src/common/coworkErrorClassify.test.ts` | `gateway closed (1009)` 归类为 `coworkErrorMessageTooLarge` |
| `src/common/coworkErrorClassify.test.ts` | `Max payload size exceeded` 归类为 `coworkErrorMessageTooLarge` |
| `src/common/coworkErrorClassify.test.ts` | `chat.send payload too large` 归类为 `coworkErrorMessageTooLarge` |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts` | payload 未超限时允许调用 `chat.send` |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts` | payload 超过 safe limit 时不调用 `chat.send`，并 emit 友好可分类错误 |

如果 `runTurn()` 直接测试成本较高，可抽取纯函数测试：

1. `estimateChatSendFrameBytes(params)`
2. `buildChatSendPayloadTooLargeError(...)`
3. `isChatSendPayloadWithinLimit(...)`

### 5.2 手动验证

手动验证流程：

1. 启动 `npm run electron:dev`。
2. 选择支持图片输入的模型。
3. 添加 1 张约 12 MB base64 payload 的图片，确认可发送。
4. 添加 2 张合计约 18 MB base64 payload 的图片，确认可发送。
5. 添加多张合计超过约 30 MB payload 的图片，确认发送前被 智码 GLM Code 阻止。
6. 确认 UI 显示：

```text
本次消息过大，请减少附件、压缩图片或拆分提交。（单次整体需小于约 30MB）
```

7. 确认主进程日志没有 OpenClaw `Max payload size exceeded`。
8. 确认网关没有因为该次请求发生 `onClose code: 1009`。

### 5.3 回归验证

回归场景：

1. 无附件普通文本消息正常发送。
2. 单张小图正常发送。
3. 多张小图但总 payload 未超限正常发送。
4. 非图片文件路径附件仍按现有逻辑追加到 prompt，不受图片 base64 payload 估算影响。
5. 模型不支持图片时，图片作为普通文件路径处理，仍遵循现有提示和附件路径逻辑。
6. OpenClaw 服务重启仍显示服务重启提示，不误判为消息过大。
7. 普通网络断连仍显示网关连接或网络错误，不误判为消息过大。

## 6. 风险与权衡

### 6.1 估算不是真实 GatewayClient 帧的字节级复刻

`Buffer.byteLength(JSON.stringify({ id, method, params }), 'utf8')` 对估算对象是准确的，但 GatewayClient 真实请求帧可能包含额外字段或不同字段名。

缓解方式：

1. 使用完整 RPC frame 形状估算，而不是只估算 params。
2. 使用 `30 MB - 0.5 MB` 的 safe limit。
3. 保留 `1009` / `Max payload size exceeded` 兜底错误分类。

### 6.2 过早阻止可能挡住边界成功请求

如果 safe limit 留得过大，可能拦住少量本可成功的贴线请求。

权衡：

1. 贴线请求即使成功也容易受 JSON 包装、cwd、文本长度变化影响。
2. 失败会导致网关断连和 session error，用户体验更差。
3. 0.5 MB 安全余量相对 30 MB 较小，可接受。

### 6.3 不自动压缩图片

自动压缩能进一步改善体验，但会带来新问题：

1. 用户可能希望模型分析原图细节。
2. PNG、JPEG、透明通道、EXIF 等处理需要更多策略。
3. 自动压缩需要明确 UI 告知或设置项。

本次修复优先解决错误提示和网关保护，后续可单独设计“发送前压缩图片附件”功能。

## 7. 验收标准

本修复完成后应满足：

1. 多图合并 payload 超过安全上限时，智码 GLM Code 不再把请求发给 OpenClaw 网关。
2. UI 显示“本次消息过大”类提示，而不是“AI 引擎连接中断”。
3. 主进程日志记录 payload 估算值、safe limit、附件数量和 base64 总长度。
4. `gateway closed (1009)` 和 `Max payload size exceeded` 在兜底路径中也显示消息过大提示。
5. 1 张或 2 张未超限图片仍可正常发送，并继续触发 OpenClaw 的 inbound image 保存逻辑。
6. 现有单张图片约 30 MB 限制仍生效。
7. 相关单元测试通过。
