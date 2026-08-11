# 模型自定义参数透传

## 1. 概述

### 1.1 问题/背景

模型提供商会不断引入新的 API 参数（如 DeepSeek 的 `reasoning_effort` 新增 `smart` 选项、Anthropic 的 `thinking` 配置等）。这些参数通常是模型/提供商特有的，智码 GLM Code 无法为每个新参数都预设 UI 字段。

OpenClaw 的 `agents.defaults.models["provider/model"].params` 支持部分参数透传，但内部使用白名单机制，仅允许 `temperature`、`maxTokens` 等少数已知参数。其他参数（如 `enable_thinking`、`reasoning_effort`）会被静默忽略。

本功能通过 智码 GLM Code 侧 patch OpenClaw runtime，增加 `extra_body` 通用透传机制，将 `params.extra_body` 中的字段直接合并到 API 请求 body，绕过白名单限制。

### 1.2 目标

- 在模型配置页面增加一个 JSON 文本框，允许用户为每个模型填写自定义参数
- 这些参数通过 OpenClaw 的 `agents.defaults.models` 配置透传至模型请求
- 无需更新代码即可适配未来的新参数

## 2. 用户场景

### 场景 1：配置 DeepSeek 推理强度

**Given** 用户已配置 DeepSeek 提供商并添加了 `deepseek-r1` 模型
**When** 用户编辑该模型，在"自定义参数"文本框中输入 `{"reasoning_effort": "smart"}`
**Then** 该参数保存到模型配置，并在每次调用该模型时透传至 API 请求

### 场景 2：JSON 格式校验

**Given** 用户正在编辑模型的自定义参数
**When** 用户输入非法 JSON（如 `{reasoning_effort: smart}`）并点击保存
**Then** 表单显示错误提示，不保存

### 场景 3：空参数

**Given** 用户不需要自定义参数
**When** 自定义参数文本框留空
**Then** 模型正常保存，不生成额外的 `params` 配置

## 3. 功能需求

### FR-1 类型扩展

在 `ProviderConfig` 的模型定义中增加 `customParams?: Record<string, unknown>` 字段。

### FR-2 UI 文本框

在模型编辑表单中（上下文窗口滑块之后、操作按钮之前）增加一个多行文本框：
- 标签："自定义参数" / "Custom Params"
- placeholder 示例：`{"reasoning_effort": "high"}`
- 使用等宽字体

### FR-3 JSON 校验

保存时校验文本框内容：
- 空字符串 → 合法，不保存 customParams
- 合法 JSON 对象 → 保存
- 非法 JSON 或非对象类型（数组、字符串等）→ 显示错误提示

### FR-4 配置同步

在 `openclawConfigSync.ts` 生成 OpenClaw 配置时，将所有包含 `customParams` 的模型汇总为 `agents.defaults.models` 结构。`customParams` 包装在 `extra_body` 内，由 OpenClaw patch 的 `createExtraBodyWrapper` 将其合并到 API 请求 body：

```json
{
  "agents": {
    "defaults": {
      "models": {
        "deepseek/deepseek-r1": {
          "params": {
            "extra_body": {
              "reasoning_effort": "smart"
            }
          }
        }
      }
    }
  }
}
```

## 4. 实现方案

### 4.1 数据流

```
用户输入 JSON → Settings.tsx 状态
                      ↓
                handleSaveNewModel() 解析校验
                      ↓
                ProviderConfig.models[].customParams 持久化
                      ↓
                claudeSettings.ts resolveAllEnabledProviderConfigs() 读取
                      ↓
                openclawConfigSync.ts 收集 customParams，包装为 params.extra_body
                      ↓
                openclaw.json agents.defaults.models[key].params.extra_body 写入
                      ↓
                OpenClaw resolveExtraParams() 读取
                      ↓
                createExtraBodyWrapper() 通过 onPayload 将 extra_body 合并到 API 请求 body
```

### 4.2 各层改动

| 文件 | 改动 |
|------|------|
| `src/shared/providers/types.ts` | `models[]` 增加 `customParams?: Record<string, unknown>` |
| `src/main/libs/claudeSettings.ts` | `ProviderModelConfig` / `ProviderModelInputConfig` 增加 `customParams` 字段 |
| `src/main/libs/openclawConfigSync.ts` | 收集 `customParams`，包装为 `extra_body` 并生成 `agents.defaults.models` |
| `src/renderer/components/Settings.tsx` | 增加 `newModelCustomParams` 状态，编辑/保存/重置逻辑 |
| `src/renderer/components/settings/ModelSettingsSection.tsx` | 增加 JSON 文本框 UI |
| `src/renderer/services/i18n.ts` | 增加中英文翻译 |

### 4.3 OpenClaw Runtime Patch

OpenClaw v2026.4.14 的 `extra-params.ts` 使用白名单，仅透传 `temperature`、`maxTokens` 等 6 个参数，其他参数被静默丢弃。通过 patch 增加 `extra_body` 通用透传机制：

**Patch 文件**：`scripts/patches/v2026.4.14/openclaw-extra-body-passthrough.patch`

**改动位置**：`src/agents/pi-embedded-runner/extra-params.ts`

- 新增 `createExtraBodyWrapper()` 函数：使用 `streamWithPayloadPatch` 的 `onPayload` 回调，将 `extra_body` 对象通过 `Object.assign` 合并到 API 请求 body
- 在 `applyPostPluginStreamWrappers()` 中调用：检测 `effectiveExtraParams.extra_body`，经 `sanitizeExtraParamsRecord()` 过滤 `__proto__`/`prototype`/`constructor` 等危险 key 后应用

该模式与已有的 `parallel_tool_calls` 透传模式一致，不修改白名单核心逻辑。

## 5. 边界情况

| 场景 | 处理方式 |
|------|----------|
| 非法 JSON | 保存时弹出校验错误，阻止保存 |
| JSON 数组或原始类型 | 视为非法，只接受 JSON 对象 |
| 空对象 `{}` | 等同于空字符串，不写入 customParams |
| 编辑已有模型时回填 | `handleEditModel` 将 `customParams` 格式化为 pretty-print JSON 回填到文本框 |
| 模型无 customParams | `agents.defaults.models` 不为该模型生成条目 |
| 所有模型均无 customParams | 不生成 `agents.defaults.models` 段 |

## 6. 涉及文件

- `src/shared/providers/types.ts`
- `src/main/libs/claudeSettings.ts`
- `src/main/libs/openclawConfigSync.ts`
- `src/renderer/components/Settings.tsx`
- `src/renderer/components/settings/ModelSettingsSection.tsx`
- `src/renderer/services/i18n.ts`
- `scripts/patches/v2026.4.14/openclaw-extra-body-passthrough.patch`（OpenClaw runtime patch）

## 7. 验收标准

1. 模型编辑表单中显示"自定义参数"文本框
2. 输入合法 JSON 对象后保存成功，模型配置中包含 `customParams`
3. 输入非法 JSON 时保存被阻止，显示错误提示
4. 文本框为空时保存正常，不写入多余字段
5. 编辑已有含 customParams 的模型时，文本框正确回填 JSON 内容
6. 生成的 `openclaw.json` 中 `agents.defaults.models` 正确包含对应模型的 `params.extra_body`
7. 通过 OpenClaw patch 的 `createExtraBodyWrapper`，`extra_body` 中的参数被正确合并到模型 API 请求 body 中
