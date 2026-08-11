# OpenClaw 会话模型切换被 allowlist 拦截修复设计文档

## 1. 概述

### 1.1 问题

部分用户在任务对话里，第一次回复完成后，从底部模型选择列表切换模型会提示：

```text
模型切换失败，请稍后重试。
```

同一批模型在“新建任务”入口里切换看起来是成功的；并且有些电脑可以正常切换，有些电脑稳定失败。

已观察到的失败模型包括：

- `lobsterai-server/MiniMax-M2.7-YoudaoInner`
- `lobsterai-server/kimi-k2.6-inhouse-ZhiYun`
- `lobsterai-server/kimi-k2.6-YoudaoInner`
- `lobsterai-server/glm-5.1-YoudaoInner`
- `deepseek/deepseek-v4-pro`

这些模型在 智码 GLM Code 的可用模型列表和 OpenClaw `models.providers` catalog 中都存在，但在已有会话执行 `sessions.patch` 时被 OpenClaw gateway 拒绝。

### 1.2 根因

根因是 智码 GLM Code 生成 OpenClaw 配置时，把 `agents.defaults.models` 当成“每模型参数配置表”使用，但 OpenClaw 同时把这个字段解释为“允许切换的模型 allowlist”。

当前 智码 GLM Code 的配置生成逻辑：

1. `openclawConfigSync.ts` 遍历本地 provider 模型，只把带 `customParams` 的模型写入 `perModelCustomParams`。
2. 当 `perModelCustomParams` 非空时，把它写入 `agents.defaults.models`。
3. 没有 `customParams` 的模型即使存在于 `models.providers`，也不会进入 `agents.defaults.models`。

OpenClaw 的模型校验逻辑：

1. `agents.defaults.models` 为空时，`allowAny = true`，catalog 里的模型都允许。
2. `agents.defaults.models` 非空时，OpenClaw 只允许这个对象里的 key，再加默认模型和 fallback 模型。
3. `sessions.patch` 切换到不在 allowlist 的模型时返回 `INVALID_REQUEST`，错误为 `model not allowed: <provider>/<model>`。

因此，一旦用户电脑上存在任意模型的 `customParams`，或者历史配置里残留了非空的 `agents.defaults.models`，OpenClaw 就会从“允许全部模型”切换为“只允许少数模型”。这就是为什么有些电脑会复现、有些电脑不会复现。

### 1.3 证据链

日志显示模型本身是存在的：

```text
[ClaudeSettings] resolved raw API config ... "MiniMax-M2.7-YoudaoInner" ...
```

会话发送前或底部模型切换时，智码 GLM Code 正确把 UI 模型转换为 OpenClaw ref：

```text
model=lobsterai-server/MiniMax-M2.7-YoudaoInner source=sessionOverride
```

OpenClaw gateway 拒绝的真实错误是：

```text
sessions.patch ... errorCode=INVALID_REQUEST errorMessage=model not allowed: lobsterai-server/MiniMax-M2.7-YoudaoInner
```

这说明问题不是模型列表缺失、账号权限缺失、网络失败或前端 toast 误报，而是 OpenClaw 当前配置中的 allowed model set 不完整。

### 1.4 为什么新建任务看起来可以切换

底部模型选择在不同状态下走不同路径：

- 已有 `sessionId`：立即调用 `coworkService.patchSession(sessionId, { model })`，OpenClaw 会立刻校验模型是否 allowed，失败后前端回滚并 toast。
- 新建任务还没有 `sessionId`：只调用本地持久化选择逻辑，不会立即触发 OpenClaw `sessions.patch` 校验。

所以“新建任务切换成功”只是没有在当下触发 allowlist 校验，并不代表 OpenClaw runtime 一定接受该模型。

## 2. 用户场景

### 场景 A：有自定义参数的电脑切换普通模型

**Given** 用户在某个模型上配置过自定义参数
**And** OpenClaw 配置中生成了非空 `agents.defaults.models`
**When** 用户在已完成首轮回复的任务会话底部切换到未写入 `agents.defaults.models` 的模型
**Then** 当前会话模型切换应成功，不应出现 `model not allowed`

### 场景 B：没有自定义参数的电脑

**Given** 用户没有配置任何模型自定义参数
**When** 智码 GLM Code 同步 OpenClaw 配置
**Then** 可以继续不生成 `agents.defaults.models`
**And** OpenClaw 保持 `allowAny = true`

### 场景 C：服务端模型列表更新

**Given** 智码 GLM Code 从服务端拉到新的 `lobsterai-server` 模型
**When** 任意模型存在 `customParams`，需要生成 `agents.defaults.models`
**Then** 新服务端模型也应进入 allowlist，否则 UI 可见但会话切换会失败

### 场景 D：第三方 provider 模型切换

**Given** 用户配置了 DeepSeek、MiniMax、Qwen 等第三方 provider
**When** 任意模型存在 `customParams`
**Then** 所有可选 provider/model 都应保留切换能力，不应只允许带自定义参数的模型

## 3. 功能需求

### FR-1：`agents.defaults.models` 一旦生成，必须完整覆盖可选模型

当 智码 GLM Code 需要写入 `agents.defaults.models` 时，不能只写带 `customParams` 的模型。

应以 `allProvidersMap` 中最终生成的 OpenClaw catalog 为准，为每个可选模型生成一个 allowlist entry：

```json
{
  "agents": {
    "defaults": {
      "models": {
        "lobsterai-server/MiniMax-M2.7-YoudaoInner": {},
        "lobsterai-server/kimi-k2.6-inhouse-ZhiYun": {},
        "deepseek/deepseek-v4-flash": {}
      }
    }
  }
}
```

### FR-2：保留 `customParams` 的 `extra_body` 透传能力

带 `customParams` 的模型仍然生成 `params.extra_body`：

```json
{
  "agents": {
    "defaults": {
      "models": {
        "deepseek/deepseek-v4-flash": {
          "params": {
            "extra_body": {
              "reasoning_effort": "high"
            }
          }
        },
        "lobsterai-server/MiniMax-M2.7-YoudaoInner": {}
      }
    }
  }
}
```

空对象表示“允许该模型但没有额外参数”，不能被省略。

### FR-3：没有自定义参数时保持现有行为

如果所有模型都没有 `customParams`，可以继续不写 `agents.defaults.models`，让 OpenClaw 使用 `allowAny = true`。

这能避免无意义扩大配置文件，也保持当前无自定义参数用户的行为不变。

### FR-4：前端失败回滚逻辑保留

`CoworkPromptInput` 当前在 `sessions.patch` 失败后回滚 `modelOverride` 并 toast，这是正确保护。

本次修复不应移除回滚；可以作为可选优化，把 `model not allowed` 映射成更明确的提示，但不能用前端吞错绕过后端校验。

### FR-5：模型列表与 OpenClaw allowlist 保持一致

后续如果 UI 模型列表来自 智码 GLM Code 的 `availableModels`，而 OpenClaw runtime 使用 `models.list` 或 `sessions.patch` 校验，就必须保证两边模型集合一致。

可选增强：在当前会话模型选择器中使用 OpenClaw `models.list` 的 allowed catalog 过滤模型，避免显示当前 runtime 不接受的模型。但主修复仍应在配置生成层解决 allowlist 不完整。

## 4. 实现方案

### 4.1 调整 OpenClaw 配置生成

涉及文件：

| 文件 | 改动 |
|---|---|
| `src/main/libs/openclawConfigSync.ts` | 生成完整 `agents.defaults.models` allowlist，而不是只写 `perModelCustomParams` |

推荐实现：

1. 保留当前收集 `customParams` 的逻辑，但变量语义从 `perModelCustomParams` 调整为“模型默认配置覆盖表”。
2. 在所有 provider 和服务端模型都写入 `allProvidersMap` 之后，根据 `allProvidersMap` 枚举完整模型 key。
3. 如果没有任何模型存在 `customParams`，继续不生成 `agents.defaults.models`。
4. 如果存在任意 `customParams`，则为所有 `allProvidersMap` 模型生成 entry：
   - 有 custom params：`{ params: { extra_body: { ...customParams } } }`
   - 无 custom params：`{}`
5. 生成 key 时使用 OpenClaw 实际 provider id 和 model id：`${providerId}/${model.id}`。

伪代码：

```typescript
const customModelDefaults = collectCustomModelDefaultsFromConfiguredProviders();
const shouldWriteModelDefaults = Object.keys(customModelDefaults).length > 0;

const modelDefaults = shouldWriteModelDefaults
  ? buildCompleteModelDefaultsFromProviders(allProvidersMap, customModelDefaults)
  : {};

// agents.defaults
...(shouldWriteModelDefaults ? { models: modelDefaults } : {})
```

注意：服务端模型的 metadata 来自 `getAllServerModelMetadata()`，它们当前会进入 `allProvidersMap['lobsterai-server'].models`，因此完整 allowlist 也必须覆盖这些模型。

### 4.2 不改变模型 ref 生成规则

前端 `toOpenClawModelRef()` 对服务端模型固定生成：

```text
lobsterai-server/<modelId>
```

这与 OpenClaw catalog 中的 provider/model 一致，本次不需要调整。

### 4.3 不改变 `sessions.patch` 调用链

当前会话内切换模型必须继续调用 OpenClaw `sessions.patch`，因为它是让当前 runtime 会话即时生效的唯一来源。

需要修的是 patch 前的 OpenClaw 配置 allowlist，而不是改成只更新 智码 GLM Code SQLite。

### 4.4 可选：错误提示增强

如果 `coworkService.patchSession()` 返回错误包含 `model not allowed`，可以将 toast 从通用的“模型切换失败，请稍后重试”细化为：

```text
该模型当前未被 OpenClaw 配置允许，请刷新模型配置后重试。
```

该增强不是根治方案，不应作为本次修复的唯一改动。

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| 所有模型都没有 `customParams` | 不生成 `agents.defaults.models`，保持 `allowAny = true` |
| 只有一个模型有 `customParams` | 生成完整 allowlist，带参数模型写 `params.extra_body`，其他模型写 `{}` |
| 服务端模型没有本地 provider API key | 仍通过 `lobsterai-server` proxy provider 进入 allowlist |
| 服务端模型列表发生增删 | 下次配置同步后按最新 `allProvidersMap` 重建 allowlist |
| 用户删除某模型的 `customParams` 后仍有其他模型带参数 | 该模型保留 `{}`，继续 allowed |
| 用户删除所有 `customParams` | `agents.defaults.models` 应从生成配置中移除，恢复 allowAny |
| 历史 `openclaw.json` 已有不完整 `agents.defaults.models` | 下次 config sync 应覆盖为完整集合或移除该字段 |
| 模型存在于 UI 但不在 `allProvidersMap` | 不应进入 allowlist，应先修 provider catalog 生成 |
| OpenClaw `sessions.patch` 仍失败 | 保留前端回滚和 toast，日志继续记录真实 backend error |

## 6. 涉及文件

核心代码：

- `src/main/libs/openclawConfigSync.ts`
- `src/main/libs/claudeSettings.ts`（只读模型配置来源，通常不需要改）
- `src/renderer/components/cowork/CoworkPromptInput.tsx`（可选错误提示增强）
- `src/renderer/utils/openclawModelRef.ts`（不预期改动）

测试：

- `src/main/libs/openclawConfigSync.runtime.test.ts`

相关历史文档：

- `specs/features/model-custom-params/2026-05-19-model-custom-params-design.md`
- `specs/bugfixes/im-session-model-patch/2026-05-06-im-session-model-patch-design.md`

## 7. 测试计划

### 单元测试

在 `openclawConfigSync.runtime.test.ts` 增加覆盖：

1. 没有任何 `customParams` 时，`config.agents.defaults.models` 仍为 `undefined`。
2. 存在一个第三方 provider 模型带 `customParams` 时：
   - `config.agents.defaults.models` 包含该 provider 下所有可选模型。
   - 带参数模型包含 `params.extra_body`。
   - 不带参数模型为 `{}`。
3. 存在服务端模型且任意模型带 `customParams` 时：
   - `config.agents.defaults.models` 包含 `lobsterai-server/MiniMax-M2.7-YoudaoInner`。
   - `config.agents.defaults.models` 包含 `lobsterai-server/kimi-k2.6-inhouse-ZhiYun`。
   - 这些无自定义参数的服务端模型 entry 为 `{}`。
4. 删除所有 `customParams` 后重新 sync，`agents.defaults.models` 不再生成。

运行：

```bash
npm test -- openclawConfigSync
```

### 手工验证

1. 在设置里给任意模型添加自定义参数，例如 `{"reasoning_effort": "high"}`。
2. 启动 OpenClaw runtime，确认 `openclaw.json` 中 `agents.defaults.models` 包含所有可选模型。
3. 新建任务，用 `MiniMax-M2.7-YoudaoInner` 完成首轮对话。
4. 首轮回复完成后，从底部模型选择切换到 `kimi-k2.6-YoudaoInner`、`glm-5.1-YoudaoInner`、`deepseek/deepseek-v4-pro` 等模型。
5. 预期不再出现“模型切换失败”，gateway 日志不再出现 `model not allowed`。

## 8. 验收标准

1. 有 `customParams` 的用户电脑上，会话内模型切换不再因为 `model not allowed` 失败。
2. 无 `customParams` 的用户电脑行为保持不变。
3. 生成的 `openclaw.json` 中，`agents.defaults.models` 要么不存在，要么是完整可选模型集合。
4. `customParams` 的 `extra_body` 透传能力不回退。
5. 服务端模型和第三方 provider 模型都能在已有会话中成功 `sessions.patch`。
6. 失败时前端仍会回滚显示，不能留下 UI 与 OpenClaw runtime 不一致的状态。
