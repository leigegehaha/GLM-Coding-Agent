# Qwen Coding Plan 下 qwen3.6-plus 被 OpenClaw 过滤修复设计文档

## 1. 概述

### 1.1 问题

用户在 智码 GLM Code 设置里启用 Qwen Coding Plan 后，同一套 API key 和 Coding Plan endpoint 下：

- `qwen3.5-plus` 可以正常工作
- `qwen3.6-plus` 在 OpenClaw gateway 启动 warmup 或正式会话中失败

典型错误：

```text
Agent failed before reply: Unknown model: qwen/qwen3.6-plus
```

这说明 Qwen Coding Plan 的基础调用链路是通的：密钥、baseURL、OpenAI-compatible API 格式、gateway 转发路径至少已经能支撑 `qwen3.5-plus`。当前问题更像是 OpenClaw runtime 对 `qwen3.6-plus` 做了过期的模型级拦截，而不是 Coding Plan endpoint 整体不可用。

### 1.2 根因

OpenClaw v2026.4.14 的 Qwen extension 中存在三处显式限制，使 Coding Plan endpoint 下的 `qwen3.6-plus` 在请求真正发往阿里前就被拦掉：

1. `extensions/qwen/models.ts`
   - `QWEN_MODEL_CATALOG` 已包含 `qwen3.6-plus`
   - 但 `buildQwenModelCatalogForBaseUrl()` 在 Coding Plan baseURL 下过滤掉 `QWEN_36_PLUS_MODEL_ID`
2. `extensions/qwen/index.ts`
   - `normalizeConfig()` 在 Coding Plan baseURL 下从显式 provider config 中删除 `qwen3.6-plus`
3. `extensions/qwen/index.ts`
   - `suppressBuiltInModel()` 对 Coding Plan 下的 `qwen3.6-plus` 直接返回 `Unknown model`

对应测试也固化了这个旧行为：

```text
provider-catalog.test.ts:
  only advertises qwen3.6-plus on Standard endpoints
```

因此，当前失败不是因为 智码 GLM Code 没有把 `qwen3.6-plus` 写入配置；即使写入了，也会被 OpenClaw runtime 过滤或 suppress。

### 1.3 核心判断

既然 `qwen3.5-plus` 在同一个 Coding Plan endpoint 下可用，最小修复不应优先改 provider id，也不应在 智码 GLM Code UI 里隐藏 `qwen3.6-plus`。

更直接的修复是：

```text
允许 Qwen Coding Plan endpoint 下的 qwen3.6-plus 进入 OpenClaw catalog，
并移除 OpenClaw 对该模型的本地 unknown-model suppression。
```

`bailian-coding-plan` provider id 与阿里文档更一致，但它不是解决当前报错的最短路径。当前 bug 的最近拦截点在 OpenClaw Qwen extension 的模型过滤逻辑。

## 2. 用户场景

### 场景 A：内置 Qwen Coding Plan 使用 qwen3.6-plus

**Given** 用户启用内置 Qwen provider 的 Coding Plan
**And** baseURL 为 `https://coding.dashscope.aliyuncs.com/v1` 或 `https://coding-intl.dashscope.aliyuncs.com/v1`
**When** 用户选择 `qwen3.6-plus` 新建 Cowork session
**Then** OpenClaw 不应报 `Unknown model: qwen/qwen3.6-plus`
**And** 请求应进入真实上游 API 调用

### 场景 B：内置 Qwen Coding Plan 继续使用 qwen3.5-plus

**Given** 用户启用 Qwen Coding Plan
**When** 用户选择 `qwen3.5-plus`
**Then** 现有成功路径保持不变

### 场景 C：Qwen Standard endpoint 使用 qwen3.6-plus

**Given** 用户关闭 Coding Plan，使用 Standard pay-as-you-go endpoint
**When** 用户选择 `qwen3.6-plus`
**Then** 行为保持不变，仍可进入 OpenClaw catalog

### 场景 D：上游真实拒绝 qwen3.6-plus

**Given** OpenClaw 已允许 `qwen3.6-plus` 通过本地 catalog 和 suppression
**When** 用户的阿里账号、套餐或 region 不支持该模型
**Then** 应展示上游返回的真实错误
**And** 不应再被本地伪装成 `Unknown model`

## 3. 功能需求

### FR-1：Coding Plan catalog 必须包含 qwen3.6-plus

`buildQwenProvider({ baseUrl: QWEN_BASE_URL })` 和 `buildQwenProvider({ baseUrl: QWEN_CN_BASE_URL })` 都必须包含：

```json
{
  "id": "qwen3.6-plus",
  "input": ["text", "image"]
}
```

`qwen3.5-plus`、`glm-5`、`kimi-k2.5` 等现有 Coding Plan 模型不能被移除。

### FR-2：normalizeConfig 不得删除 qwen3.6-plus

当用户配置中已经显式写入：

```json
{
  "models": [
    { "id": "qwen3.6-plus" }
  ],
  "baseUrl": "https://coding.dashscope.aliyuncs.com/v1"
}
```

OpenClaw Qwen extension 的 `normalizeConfig()` 不应把该模型从 `providerConfig.models` 中过滤掉。

### FR-3：suppressBuiltInModel 不得拦截 qwen3.6-plus

Coding Plan baseURL 下的 `qwen3.6-plus` 不应再返回：

```text
Unknown model: qwen/qwen3.6-plus. qwen3.6-plus is not supported on the Qwen Coding Plan endpoint...
```

如果上游 API 实际不支持该模型，应由上游响应决定错误类型。

### FR-4：不改 智码 GLM Code 的 provider id 映射

本次修复不要求把 智码 GLM Code 的 `qwen-portal/qwen3.6-plus` 改成 `bailian-coding-plan/qwen3.6-plus`。

理由：

1. `qwen3.5-plus` 已经证明当前 Qwen Coding Plan provider 路径可用。
2. 当前报错发生在 OpenClaw 本地模型过滤阶段。
3. 引入 `bailian-coding-plan` 会扩大改动面，需要额外处理 provider alias、密钥映射、自定义 provider 冲突和 runtime provider 注册问题。

`bailian-coding-plan` 对齐可以作为后续规范化设计，不作为本 bug 的 MVP。

### FR-5：智码 GLM Code UI 不应主动隐藏 qwen3.6-plus

`src/shared/providers/constants.ts` 中 Qwen 默认模型已经包含：

```text
qwen3.6-plus
qwen3.5-plus
```

本次修复后，开启 Coding Plan 时不应因为 OpenClaw 旧限制在 UI 或 session 创建前主动禁用 `qwen3.6-plus`。

## 4. 实现方案

### 4.1 增加 OpenClaw runtime patch

在 智码 GLM Code 的 runtime patch 目录新增：

```text
scripts/patches/v2026.4.14/openclaw-qwen-coding-plan-qwen36-plus.patch
```

patch 内容作用于 OpenClaw source：

| 文件 | 改动 |
|---|---|
| `extensions/qwen/models.ts` | 取消 Coding Plan baseURL 下对 `qwen3.6-plus` 的 catalog 过滤 |
| `extensions/qwen/index.ts` | 取消 `normalizeConfig()` 删除 `qwen3.6-plus` |
| `extensions/qwen/index.ts` | 取消 `suppressBuiltInModel()` 对 Coding Plan `qwen3.6-plus` 的 unknown-model 拦截 |
| `extensions/qwen/provider-catalog.test.ts` | 更新测试期望：Coding Plan endpoint 也应 advertise `qwen3.6-plus` |

推荐以“删除限制逻辑”为主，而不是新增特殊 allowlist。

### 4.2 修改 `models.ts`

当前逻辑：

```typescript
export function isQwen36PlusSupportedBaseUrl(baseUrl: string | undefined): boolean {
  return !isQwenCodingPlanBaseUrl(baseUrl);
}

export function buildQwenModelCatalogForBaseUrl(
  baseUrl: string | undefined,
): ReadonlyArray<ModelDefinitionConfig> {
  return isQwen36PlusSupportedBaseUrl(baseUrl)
    ? QWEN_MODEL_CATALOG
    : QWEN_MODEL_CATALOG.filter((model) => model.id !== QWEN_36_PLUS_MODEL_ID);
}
```

目标逻辑：

```typescript
export function isQwen36PlusSupportedBaseUrl(_baseUrl: string | undefined): boolean {
  return true;
}

export function buildQwenModelCatalogForBaseUrl(
  _baseUrl: string | undefined,
): ReadonlyArray<ModelDefinitionConfig> {
  return QWEN_MODEL_CATALOG;
}
```

保留 `isQwen36PlusSupportedBaseUrl()` 导出可以降低 patch 风险，避免外部 import 断裂。后续升级 OpenClaw 时再考虑删除该 helper。

### 4.3 修改 `index.ts`

当前 `normalizeConfig()` 会删除 Coding Plan 下的 3.6：

```typescript
normalizeConfig: ({ providerConfig }) => {
  if (!isQwenCodingPlanBaseUrl(providerConfig.baseUrl)) {
    return undefined;
  }
  const models = providerConfig.models?.filter((model) => model.id !== QWEN_36_PLUS_MODEL_ID);
  return models && models.length !== providerConfig.models?.length
    ? { ...providerConfig, models }
    : undefined;
},
```

目标行为：

```typescript
normalizeConfig: () => undefined,
```

或者直接移除该 hook。为了 patch 稳定，MVP 可保留 hook 但返回 `undefined`。

当前 `suppressBuiltInModel()` 会制造本地 unknown model：

```typescript
suppressBuiltInModel: (ctx) => {
  // qwen3.6-plus + Coding Plan -> suppress true
}
```

目标行为：

```typescript
suppressBuiltInModel: () => undefined,
```

或者直接移除该 hook。

如果选择移除 hook，需要同步清理 `index.ts` 中不再使用的 `isQwenCodingPlanBaseUrl`、`QWEN_36_PLUS_MODEL_ID`、`isQwen36PlusUnsupportedForConfig()` 等 import/helper，避免 TypeScript `noUnusedLocals` 或 lint 失败。

### 4.4 更新提示文案

`extensions/qwen/index.ts` 中 Coding Plan note 当前只列：

```text
Models: qwen3.5-plus, glm-5, kimi-k2.5, MiniMax-M2.5, etc.
```

应更新为包含 `qwen3.6-plus`：

```text
Models: qwen3.6-plus, qwen3.5-plus, glm-5, kimi-k2.5, MiniMax-M2.5, etc.
```

这不是功能必要条件，但能避免后续误判。

### 4.5 智码 GLM Code 主工程不做 provider id 重写

本 spec 不修改以下逻辑：

| 文件 | 保持不变 |
|---|---|
| `src/shared/providers/constants.ts` | Qwen 继续使用 `OpenClawProviderId.Qwen` / `qwen-portal` |
| `src/main/libs/openclawConfigSync.ts` | `ProviderName.Qwen` 继续写入当前 Qwen provider selection |
| `src/renderer` 模型选择逻辑 | 继续按当前 provider/model ref 生成 session override |

如果修复后仍出现 provider alias 相关问题，再单独写 provider id 对齐 spec；不要把两个问题合并，避免扩大回归面。

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| 阿里账号没有 qwen3.6-plus Coding Plan 权限 | 透出上游错误，不在本地报 `Unknown model` |
| `qwen3.5-plus` 现有成功路径 | 必须保持不变 |
| Standard endpoint 下的 `qwen3.6-plus` | 必须保持不变 |
| 自定义 provider 使用普通非阿里 endpoint 且模型名为 `qwen3.6-plus` | 不受 OpenClaw Qwen extension 影响，保持 `custom_N/qwen3.6-plus` |
| 后续 OpenClaw upstream 已支持该模型 | patch 应能干净移除，测试仍表达目标行为 |
| 阿里官方推荐 `bailian-coding-plan` provider id | 作为后续规范化，不阻塞本次最小修复 |

## 6. 验收标准

### 6.1 OpenClaw extension 单元测试

更新 `extensions/qwen/provider-catalog.test.ts`：

1. `buildQwenProvider()` 默认 Coding Plan global endpoint 下包含 `qwen3.6-plus`
2. `buildQwenProvider({ baseUrl: QWEN_BASE_URL })` 包含 `qwen3.6-plus`
3. `buildQwenProvider({ baseUrl: QWEN_CN_BASE_URL })` 包含 `qwen3.6-plus`
4. `buildQwenProvider({ baseUrl: QWEN_STANDARD_GLOBAL_BASE_URL })` 继续包含 `qwen3.6-plus`
5. 原测试名 `only advertises qwen3.6-plus on Standard endpoints` 改为 `advertises qwen3.6-plus on Coding Plan and Standard endpoints`

新增或调整 `index.ts` 相关测试：

1. Coding Plan baseURL + `qwen3.6-plus` 不触发 `suppressBuiltInModel`
2. `normalizeConfig()` 不删除显式配置中的 `qwen3.6-plus`

### 6.2 智码 GLM Code runtime patch 验证

执行：

```bash
npm run openclaw:ensure
npm run openclaw:patch
```

确认 patch 能在 pinned `openclaw.version = v2026.4.14` 上干净应用。

如果只验证 OpenClaw extension 测试，可在 OpenClaw source 中运行对应测试：

```bash
cd ../openclaw
npm test -- extensions/qwen/provider-catalog.test.ts
```

具体测试命令以 OpenClaw 仓库当前 test script 为准。

### 6.3 手动验证

1. 在 智码 GLM Code 设置页启用 Qwen Coding Plan。
2. baseURL 使用 `https://coding.dashscope.aliyuncs.com/v1`。
3. 选择 `qwen3.6-plus` 新建 Cowork session。
4. 确认不再出现：

```text
Unknown model: qwen/qwen3.6-plus
```

5. 确认 gateway 日志中请求进入 LLM 调用阶段。
6. 切回 `qwen3.5-plus`，确认仍可正常回复。

## 7. 非目标

本次不做以下改动：

1. 不新增 `bailian-coding-plan` provider id。
2. 不把 智码 GLM Code 的 Qwen provider 从 `qwen-portal` 改名。
3. 不在 UI 中隐藏或禁用 `qwen3.6-plus`。
4. 不实现多 Qwen provider 凭证冲突处理。
5. 不通过调用上游 `/models` 动态决定是否显示 `qwen3.6-plus`。

## 8. 实施顺序

1. 新增 OpenClaw runtime patch，取消 Qwen Coding Plan 下的 `qwen3.6-plus` 过滤。
2. 更新 OpenClaw Qwen provider catalog 测试。
3. 增加 `normalizeConfig` / `suppressBuiltInModel` 的回归测试。
4. 运行 `npm run openclaw:patch` 验证 patch 可应用。
5. 重新构建或同步 OpenClaw runtime。
6. 手动验证 Qwen Coding Plan 下 `qwen3.6-plus` 和 `qwen3.5-plus` 都可进入真实请求链路。
