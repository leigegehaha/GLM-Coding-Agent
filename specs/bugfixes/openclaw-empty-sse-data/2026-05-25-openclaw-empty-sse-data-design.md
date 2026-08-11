# OpenClaw 空 SSE data 导致 JSON 解析错误修复设计文档

## 1. 概述

### 1.1 问题

用户在 智码 GLM Code Cowork 中执行一个较长任务时，工具调用本身已经成功，但界面随后展示系统错误：

```text
Unexpected end of JSON input
```

从截图看，错误出现在 `Process poll - good-river` 工具块之后。继续对话后，模型再次先查看当前进度，`process poll` 仍能返回结果，但随后又出现同样错误。

本问题不是 `run_sb_urls.py`、`gpt_image.py` 或 `process poll` 的业务脚本错误，而是 OpenClaw 在工具结果返回后继续请求模型时，解析模型流式响应失败。

### 1.2 现场证据

本次涉及的关键日志：

| 文件 | 作用 |
|---|---|
| `gateway-2026-05-21.log` | OpenClaw gateway / agent 运行日志 |
| `openclaw-2026-05-21.log` | OpenClaw 结构化日志 |
| `main-2026-05-21.log` | 智码 GLM Code 主进程透传和 session 状态日志 |

第一次失败链路：

1. `13:59:47` OpenClaw 执行 `write`，写入 `E:\工作\AI龙虾\projects\run_sb_urls.py`，结果 `err=false`。
2. `13:59:52` OpenClaw 执行 `python E:\工作\AI龙虾\projects\run_sb_urls.py`，结果 `err=false`。
3. `13:59:57` OpenClaw 开始 `process poll`。
4. `14:01:57` `process poll` 返回 `meta=good-river err=false`。
5. `14:02:17` OpenClaw stderr 打出：

```text
Could not parse message into JSON:
From chunk: [ 'data:' ]
```

6. 同一 run 随后结束为 `isError=true`：

```text
error=Unexpected end of JSON input rawError=Unexpected end of JSON input
```

7. gateway 发出 `stream=lifecycle phase=error error=Unexpected end of JSON input`，智码 GLM Code UI 显示该错误。

第二次继续对话后，链路相同：

1. `14:03:20` 开始新的 `process poll`。
2. `14:05:04` 返回 `meta=good-river err=false`。
3. `14:05:25` 再次出现 `From chunk: [ 'data:' ]`。
4. OpenClaw 再次把 run 标记为 `Unexpected end of JSON input`。

第三次在 `14:17:35`，新的 `custom_0/deepseek-v4-pro` run 刚开始不久就收到同样空 `data:`，说明问题不依赖某一个具体工具输出。

本次失败 run 使用的模型通道为：

| 字段 | 值 |
|---|---|
| provider | `custom_0` |
| model | `deepseek-v4-pro` |
| api | `openai-completions` |
| endpoint | `custom` |
| route | `proxy-like` |

### 1.3 根因

直接根因是 **OpenClaw 的 OpenAI-compatible SSE 解析路径把空 `data:` 当成 JSON 内容解析**。

OpenAI-compatible 流式响应中，正常数据帧通常应为：

```text
data: {"choices":[...]}
```

结束帧通常应为：

```text
data: [DONE]
```

但本次自定义模型通道实际返回了一个只有字段名、没有 payload 的 SSE 行：

```text
data:
```

当前解析器对 `data:` 后的空字符串执行了等价于 `JSON.parse('')` 的操作，于是抛出：

```text
Unexpected end of JSON input
```

因此，问题根因位于 **自定义 provider / AIGW / proxy 返回了不规范空 data 帧，以及 OpenClaw parser 没有容忍该空帧** 这一层。智码 GLM Code 主进程只是通过 lifecycle error fallback 把 OpenClaw 的错误透传到了 UI。

### 1.4 目标

修复目标：

1. OpenAI-compatible SSE parser 遇到 payload 为空的 `data:` 时，不应直接 `JSON.parse`，应按空帧跳过。
2. `data: [DONE]` 仍按正常结束帧处理。
3. 非空但非法的 JSON 仍必须报错，不能被静默跳过。
4. 如果上游持续只发送空 `data:`，不能无限等待，应通过 idle timeout 或连续空帧阈值给出明确错误。
5. 诊断日志应能说明“收到空 SSE data 帧”，并包含 provider/model/runId 等上下文，但不能刷屏。
6. 智码 GLM Code UI 不再直接暴露低层 `Unexpected end of JSON input`，至少应在兜底路径中显示更可诊断的模型流格式错误。

### 1.5 非目标

本修复不做以下事情：

- 不修改 `run_sb_urls.py`、`gpt_image.py` 或用户业务脚本。
- 不调整 `process poll`、`exec`、`write` 等工具调用行为。
- 不把所有 JSON parse 错误都吞掉。
- 不把 provider 的 HTML 错误页、截断 JSON、鉴权错误或代理污染响应当作成功流。
- 不改变模型选择逻辑或 provider 配置结构。
- 不通过前端隐藏系统错误来伪装任务成功。

## 2. 用户场景

### 场景 1: 模型流中偶发空 data 帧

**Given** 用户使用 `custom_0/deepseek-v4-pro` 等 OpenAI-compatible 自定义模型
**And** 模型代理在正常 JSON chunk 之间返回一个空 `data:`
**When** OpenClaw 解析流式响应
**Then** OpenClaw 应跳过该空帧
**And** 后续合法 JSON chunk 应继续被消费
**And** 智码 GLM Code 不应显示 `Unexpected end of JSON input`

### 场景 2: 工具结果返回后继续生成

**Given** OpenClaw 已成功执行 `process poll` 并返回 `err=false`
**When** 模型继续生成下一步 assistant 回复
**And** provider 在流里插入空 `data:` 心跳或空帧
**Then** 当前 run 不应因此进入 `phase=error`
**And** 会话应继续等待模型输出或正常结束

### 场景 3: 非空非法 JSON

**Given** provider 返回了 `data: {bad-json`、`data: <html>` 或其他非空非法 payload
**When** OpenClaw 解析该帧
**Then** OpenClaw 必须抛出明确的 provider stream parse error
**And** 错误日志应包含安全截断后的 payload 预览或 hash
**And** 不能静默跳过该帧

### 场景 4: 上游持续发送空帧

**Given** provider 一直返回空 `data:`，没有任何合法 JSON chunk 或 `[DONE]`
**When** 超过配置的 idle timeout 或连续空帧阈值
**Then** OpenClaw 应中止当前模型流
**And** 对 智码 GLM Code 返回明确错误，例如“模型流式响应一直为空”
**And** 不应让 UI 无限 loading

### 场景 5: 标准 SSE comment 心跳

**Given** provider 使用标准 SSE comment 心跳，例如 `: ping`
**When** parser 遇到该行
**Then** parser 应忽略该 comment
**And** 不应把它当作 JSON 数据

## 3. 功能需求

### FR-1: 空 data payload 必须被识别并跳过

SSE parser 在处理 `data:` 行时，应先提取 payload 并执行 trim。

当 payload 为空字符串时：

1. 不调用 JSON parser。
2. 不生成 assistant delta。
3. 不结束 stream。
4. 增加当前 run 的 `emptyDataFrameCount` 或等效诊断计数。
5. 继续读取后续 SSE chunk。

示例：

```text
data:
```

以及：

```text
data:
```

都应作为空 data 帧处理。

### FR-2: `[DONE]` 必须保留现有结束语义

当 payload 为 `[DONE]` 时，parser 应按 OpenAI-compatible 流式响应结束处理。

空 data 帧跳过逻辑不能影响以下结束帧：

```text
data: [DONE]
```

也不能把 `[DONE]` 当作非法 JSON。

### FR-3: 非空非法 JSON 必须失败

仅允许跳过 payload 为空的 `data:`。

如果 payload trim 后非空，但不是 `[DONE]`，则必须继续按 JSON 解析。解析失败时应抛出明确错误，不应继续 silently ignore。

错误信息建议包含：

- provider
- model
- runId
- HTTP endpoint 类型或 route
- payload 预览的安全截断内容，或 payload hash

错误文案应避免只暴露 JavaScript 原生异常，例如 `Unexpected end of JSON input`，而应包装为：

```text
Model stream returned invalid JSON.
```

如果底层异常仍需保留，应作为 `cause` 或 debug 字段。

### FR-4: 持续空帧需要超时或阈值

跳过空 `data:` 后，必须避免一种新风险：provider 持续发送空帧导致 run 永远不结束。

建议策略：

1. 记录 `lastValidDataFrameAt`。
2. 记录 `consecutiveEmptyDataFrames`。
3. 如果没有任何合法 JSON chunk，并且连续空帧超过阈值，抛出明确错误。
4. 如果曾经有合法 chunk，但后续持续空帧超过 idle timeout，也应交给现有模型请求超时或新增 idle timeout 处理。

阈值可以复用 OpenClaw 现有模型 stream timeout；如果没有合适机制，可新增一个较保守的内部常量，例如：

```typescript
const MAX_CONSECUTIVE_EMPTY_SSE_DATA_FRAMES = 20;
```

或按时间判断：

```typescript
const MODEL_STREAM_NO_VALID_DATA_TIMEOUT_MS = 60_000;
```

具体数值应结合现有 provider timeout 体系确定，避免把正常慢模型误杀。

### FR-5: 诊断日志需要限流

收到空 `data:` 时应保留诊断能力，但不能每个空帧都打 info/warn。

建议日志策略：

1. 每个 run 第一次遇到空 data 帧时记录一条 debug 或 warn。
2. run 结束时如果空 data 帧数量大于 0，可在 debug 中记录汇总。
3. 如果触发阈值或 timeout，则用 warn/error 记录明确失败原因。

日志示例：

```text
[OpenAICompatibleStream] skipped an empty SSE data frame for custom_0/deepseek-v4-pro.
```

日志应使用英文，且遵守仓库日志规范：自然语言、单行、包含必要上下文、不在热路径刷 info。

### FR-6: 智码 GLM Code 侧兜底错误提示应更可诊断

如果 OpenClaw 仍然向 智码 GLM Code 抛出底层 parse 错误，`OpenClawRuntimeAdapter` 可以在不吞错的前提下把用户可见文案包装得更明确。

示例：

```text
模型流式响应格式异常：收到空的 SSE data 帧。
```

或：

```text
模型流式响应格式异常：provider 返回了非法 JSON。
```

这只是体验兜底。真正修复仍应发生在 OpenClaw 的 SSE parser 层。

## 4. 实现方案

### 4.1 修复位置

优先修复 OpenClaw runtime / gateway 中的 OpenAI-compatible streaming parser。

从日志看，错误发生在：

```text
provider=custom_0 api=openai-completions endpoint=custom route=proxy-like
```

因此重点路径是自定义 provider 的 OpenAI-compatible streaming 适配层，而不是 智码 GLM Code 的 `OpenClawRuntimeAdapter`、renderer 或工具展示层。

如果该 parser 位于 OpenClaw 独立仓库或 bundled runtime 中，应在 OpenClaw 源码修复后更新 智码 GLM Code `package.json` 中 pinned OpenClaw 版本，并通过 智码 GLM Code 集成测试验证。

### 4.2 解析逻辑调整

建议在 SSE `data:` 行进入 JSON parse 前增加空 payload 分支：

```typescript
const payload = extractSseDataPayload(line).trim();

if (!payload) {
  markEmptyDataFrame();
  continue;
}

if (payload === '[DONE]') {
  finishStream();
  continue;
}

let message: unknown;
try {
  message = JSON.parse(payload);
} catch (error) {
  throw createProviderStreamParseError({
    provider,
    model,
    runId,
    payloadPreview: truncatePayload(payload),
    cause: error,
  });
}
```

如果当前 parser 是按完整 SSE event 而不是单行处理，也应保持相同语义：

1. 收集一个 event 中的所有 `data:` 行。
2. 拼接后 trim。
3. 拼接结果为空时跳过。
4. 拼接结果为 `[DONE]` 时结束。
5. 其他非空 payload 才进入 JSON parse。

### 4.3 空帧计数和超时

每个模型 stream 应维护以下轻量状态：

- `emptyDataFrameCount`
- `consecutiveEmptyDataFrames`
- `lastValidDataFrameAt`
- `hasReceivedValidDataFrame`

处理规则：

1. 收到空 data 帧：增加空帧计数和连续空帧计数。
2. 收到合法 JSON：清零连续空帧计数，更新 `lastValidDataFrameAt`。
3. 收到 `[DONE]`：正常结束。
4. 超过连续空帧阈值或 idle timeout：抛出 provider stream empty-data error。

如果 provider 偶发空帧后继续返回合法 JSON，run 应正常进行。

### 4.4 错误分类

建议区分三类错误：

| 类型 | 触发条件 | 行为 |
|---|---|---|
| Empty data frame | 单个 payload 为空的 `data:` | 跳过，记录限流诊断 |
| Empty stream timeout | 持续只有空 `data:`，无合法 JSON 或 `[DONE]` | 报明确错误，结束 run |
| Invalid JSON payload | payload 非空但 JSON parse 失败 | 报明确错误，保留 cause |

这样可以避免把本次空心跳问题和真实 provider 响应损坏混为一类。

### 4.5 智码 GLM Code 兜底映射

若短期内无法升级 OpenClaw runtime，可在 智码 GLM Code 侧做低风险兜底：

1. 当 lifecycle error message 精确等于 `Unexpected end of JSON input`。
2. 且 OpenClaw stderr 近期出现 `From chunk: [ 'data:' ]`。
3. UI 展示更明确的错误文案。

该兜底不应把 session 标记为成功，也不应自动重试。它只改善用户可见诊断。

长期仍应以 OpenClaw parser 修复为准。

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| `data:` 后 payload 为空 | 跳过，不 JSON.parse |
| `data:    ` 只有空白 | trim 后为空，跳过 |
| `data: [DONE]` | 正常结束 stream |
| `data: {bad-json` | 非空非法 JSON，报 provider stream parse error |
| `data: <html>502 Bad Gateway</html>` | 非空非法 JSON，报错并保留安全预览 |
| SSE comment `: ping` | 跳过，不作为 data 处理 |
| 空 data 帧夹在合法 JSON chunk 中间 | 跳过空帧，继续处理后续合法 chunk |
| provider 持续发送空 data 帧 | 超过阈值或 timeout 后报明确错误 |
| stream 直接关闭且没有 `[DONE]` | 按现有异常结束规则处理；如果无有效 chunk，应报 empty stream |
| 多个 `data:` 行组成一个 SSE event | 拼接后再判断空、`[DONE]` 或 JSON |

## 6. 涉及文件

优先涉及 OpenClaw runtime / gateway 源码：

- OpenAI-compatible provider stream parser
- custom provider `openai-completions` route
- gateway / embedded agent 模型流错误包装逻辑
- 对应 parser 单元测试

智码 GLM Code 仓库可能涉及：

- `package.json`：更新 OpenClaw pinned version
- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`：可选的用户可见错误文案兜底
- `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts`：如果增加 智码 GLM Code 侧错误映射，需要补测试
- `specs/bugfixes/openclaw-empty-sse-data/`：本设计文档

如果 OpenClaw parser 不在当前仓库内，本 spec 应作为升级 OpenClaw runtime 前的修复依据。

## 7. 验收标准

### AC-1: 空 data 帧不再导致 JSON parse error

构造或回放如下流：

```text
data:

data: {"choices":[{"delta":{"content":"继续"}}]}

data: [DONE]
```

parser 应跳过第一帧，并正常输出 `继续`。

### AC-2: 非空非法 JSON 仍然报错

构造如下流：

```text
data: {bad-json
```

parser 必须报错，且错误不应被吞掉或转换成成功空回复。

### AC-3: 持续空帧不会无限 loading

构造持续空 `data:` 的流。

期望：

- 不抛原生 `Unexpected end of JSON input`。
- 超过阈值或 timeout 后报明确 empty stream / empty data 错误。
- 智码 GLM Code session 不应永久保持 running。

### AC-4: 真实任务链路不再误报

使用 2026-05-21 日志中相同形态的任务：

1. `write` 成功。
2. `exec` 成功。
3. `process poll` 返回 `good-river err=false`。
4. provider 插入一个空 `data:`。

期望：

- OpenClaw 不发出 `phase=error error=Unexpected end of JSON input`。
- 智码 GLM Code 不展示该系统错误。
- 后续合法模型输出正常进入会话。

### AC-5: 日志可诊断且不刷屏

当 run 遇到空 data 帧时：

- 每个 run 最多记录少量限流日志。
- 日志包含 provider/model/runId 或等效上下文。
- 不在每个 chunk 打 info 级日志。

## 8. 验证计划

1. 为 OpenClaw SSE parser 增加单元测试：
   - empty `data:` skipped
   - whitespace-only `data:` skipped
   - `[DONE]` handled
   - invalid non-empty JSON rejected
   - valid chunk after empty data still emitted
   - continuous empty data triggers timeout or threshold error
2. 使用本次日志抽取的 `From chunk: [ 'data:' ]` 场景做 fixture replay。
3. 在 智码 GLM Code 中使用自定义 OpenAI-compatible provider 做一次手动验证：
   - 长任务工具调用后继续生成。
   - 插入空 data 心跳。
   - 确认 UI 不出现 `Unexpected end of JSON input`。
4. 如果修改了 `OpenClawRuntimeAdapter` 的错误文案兜底，运行：

```bash
npm test -- openclawRuntimeAdapter
```

5. 若升级 OpenClaw pinned version，运行：

```bash
npm run build
```

并手动验证 Cowork 基本流程：发送消息、工具调用、process poll、错误展示。
