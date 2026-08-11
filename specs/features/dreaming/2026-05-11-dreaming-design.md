# Dreaming 记忆整理功能设计文档

## 1. 概述

### 1.1 背景

OpenClaw 提供了 **Dreaming** 功能——一个后台记忆整合系统。它通过三个阶段（Light / Deep / REM）定期处理短期记忆信号，将高价值条目提升为永久记忆，并生成人类可读的 Dream Diary（`DREAMS.md`）。

该功能默认关闭，需要在 `openclaw.json` 中配置 `dreaming` 字段才能启用。目前 智码 GLM Code 尚未提供该功能的 UI 入口。

参考文档：https://docs.openclaw.ai/concepts/dreaming

### 1.2 目标

在 智码 GLM Code 的 **设置 > 记忆** 页面中，新增 Dreaming 配置区域，允许用户：

- 启用/禁用 Dreaming
- 配置运行频率（cron 定时）
- 配置时区
- 可选覆盖 Dream Diary 生成模型

配置变更通过现有的 config sync 流程写入 `openclaw.json`，由 OpenClaw 运行时读取执行。

## 2. 用户场景

### 场景 1: 首次启用 Dreaming

**Given** 用户打开 设置 > 记忆 页面，Dreaming 功能默认关闭
**When** 用户点击 Dreaming 开关使其启用
**Then** 展开频率选择器（默认"每晚凌晨 3 点"）、时区输入、高级选项；用户点击保存后配置持久化并同步到 `openclaw.json`

### 场景 2: 调整运行频率

**Given** Dreaming 已启用，当前频率为"每晚凌晨 3 点"
**When** 用户从下拉框选择"每 6 小时"或切换到"自定义"模式输入 cron 表达式
**Then** 保存后 `openclaw.json` 中 `dreaming.frequency` 更新为对应的 cron 表达式

### 场景 3: 设置自定义 cron 表达式

**Given** 用户需要一个预设中没有的频率
**When** 用户在频率下拉框选择"自定义 Cron 表达式"，然后在输入框中输入如 `30 2 * * 1-5`
**Then** 保存后该自定义 cron 表达式被写入配置

### 场景 4: 覆盖 Dream Diary 模型

**Given** 用户希望使用特定模型生成 Dream Diary
**When** 用户展开高级选项，在"Dream Diary 模型"中输入模型 ID
**Then** 保存后 `openclaw.json` 中 `dreaming.model` 包含该模型 ID

### 场景 5: 禁用 Dreaming

**Given** Dreaming 当前启用
**When** 用户关闭 Dreaming 开关并保存
**Then** `openclaw.json` 中 `dreaming` 字段被移除，OpenClaw 不再执行后台记忆整理

## 3. 功能需求

### FR-1: 启用/禁用开关

- 在记忆设置页面新增 Dreaming section，包含一个开关控件
- 开关关闭时，下方配置项折叠隐藏
- 默认状态：关闭

### FR-2: 频率配置

- 提供下拉框，内置 5 个预设频率：
  - 每晚凌晨 3 点（`0 3 * * *`，默认）
  - 每晚午夜 12 点（`0 0 * * *`）
  - 每天两次（`0 0,12 * * *`）
  - 每 6 小时（`0 */6 * * *`）
  - 每周日凌晨 3 点（`0 3 * * 0`）
- 支持"自定义"选项，切换为文本输入框接受任意 5-field cron 表达式
- 若当前保存的值匹配预设，下拉框自动选中对应项；否则自动切换为自定义模式

### FR-3: 时区配置

- 文本输入框，接受 IANA 时区字符串（如 `Asia/Shanghai`）
- 留空时 placeholder 显示用户本地时区（通过 `Intl.DateTimeFormat().resolvedOptions().timeZone` 获取）
- 留空表示使用本地时区，配置同步时省略 `timezone` 字段

### FR-4: 模型覆盖（高级选项）

- 放在可折叠的"高级"区域中
- 文本输入框，接受模型 ID 字符串
- 留空表示使用主模型，配置同步时省略 `model` 字段

### FR-5: 配置持久化与同步

- 配置通过现有 CoworkStore（SQLite kv 表）持久化
- 保存时通过 `openclawConfigSync` 写入 `openclaw.json` 的 `dreaming` 字段
- 遵循现有数据流：UI → Settings.tsx → coworkService → CoworkStore → openclawConfigSync → openclaw.json → OpenClaw 重启

## 4. 实现方案

### 4.1 类型与存储层

**`src/main/coworkStore.ts`**：

- 新增 4 个默认常量：`DEFAULT_DREAMING_ENABLED` (false)、`DEFAULT_DREAMING_FREQUENCY` (`'0 3 * * *'`)、`DEFAULT_DREAMING_MODEL` (`''`)、`DEFAULT_DREAMING_TIMEZONE` (`''`)
- `CoworkConfig` interface 新增：`dreamingEnabled: boolean`、`dreamingFrequency: string`、`dreamingModel: string`、`dreamingTimezone: string`
- `CoworkConfigUpdate` 新增对应 4 个 key
- `getConfig()` 添加解析逻辑，`setConfig()` 添加持久化逻辑

**`src/renderer/types/cowork.ts`**：同步新增 4 个字段

### 4.2 Redux Store

**`src/renderer/store/slices/coworkSlice.ts`**：`initialState.config` 新增 4 个默认值

### 4.3 国际化

**`src/renderer/services/i18n.ts`**：新增 14 个 i18n key（zh + en），涵盖开关标签、提示文字、频率预设名称、时区和模型标签

### 4.4 DreamingSettingsSection 组件

**新建 `src/renderer/components/cowork/DreamingSettingsSection.tsx`**：

- 参照 `EmbeddingSettingsSection.tsx` 的模式
- Props：4 个值 + 4 个 onChange 回调
- 布局：Toggle → 频率选择器 → 时区输入 → 高级折叠区（模型覆盖）
- 频率选择器内部状态区分 preset / custom 模式

### 4.5 Settings.tsx 集成

**`src/renderer/components/Settings.tsx`** 的 6 处改动：

1. Import DreamingSettingsSection
2. 4 个 useState hook
3. useEffect 同步 + 依赖数组
4. hasCoworkConfigChanges 变更检测
5. handleSave 中 updateConfig 调用
6. coworkMemory case 中渲染组件（在 EmbeddingSettingsSection 之后）

### 4.6 Config Sync

**`src/main/libs/openclawConfigSync.ts`**：

在 plugin entries 构建之后（与 mcp-bridge、ask-user-question 同模式），向 `memory-core` plugin entry 注入 dreaming config：

```ts
// Sync Dreaming config into memory-core plugin
if (managedConfig.plugins) {
  const entries = plugins.entries;
  const existingMemoryCore = entries['memory-core'] ?? {};
  if (coworkConfig.dreamingEnabled) {
    entries['memory-core'] = {
      ...existingMemoryCore,
      config: {
        ...existingMemoryCoreConfig,
        dreaming: {
          enabled: true,
          frequency: coworkConfig.dreamingFrequency || '0 3 * * *',
          ...(coworkConfig.dreamingTimezone ? { timezone: coworkConfig.dreamingTimezone } : {}),
          ...(coworkConfig.dreamingModel ? { model: coworkConfig.dreamingModel } : {}),
        },
      },
    };
  }
}
```

生成的 `openclaw.json` 结构：

```json
{
  "plugins": {
    "entries": {
      "memory-core": {
        "config": {
          "dreaming": {
            "enabled": true,
            "frequency": "0 3 * * *",
            "timezone": "Asia/Shanghai",
            "model": "claude-sonnet-4-20250514"
          }
        }
      }
    }
  }
}
```

禁用时整个 `dreaming` 字段省略。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 用户输入无效 cron 表达式 | UI 层不做验证（与现有 TaskForm 一致），由 OpenClaw 运行时拒绝并报错 |
| 时区字段留空 | 配置同步时省略 `timezone` 字段，OpenClaw 使用系统本地时区 |
| 模型字段留空 | 配置同步时省略 `model` 字段，OpenClaw 使用主模型 |
| OpenClaw 未安装/未运行 | 配置正常保存到 SQLite，下次 OpenClaw 启动时读取 `openclaw.json` 生效 |
| 自定义 cron 恰好匹配预设值 | 下次加载时自动识别为预设模式，显示对应预设名称 |
| 无数据库迁移需要 | CoworkStore 使用 kv 表的 upsertConfig 模式，新 key 直接插入 |

## 6. 涉及文件

| 文件 | 操作 |
|------|------|
| `src/main/coworkStore.ts` | 修改（类型定义 + 默认值 + 读写逻辑） |
| `src/renderer/types/cowork.ts` | 修改（类型同步 + Dreaming 内容展示数据类型） |
| `src/renderer/store/slices/coworkSlice.ts` | 修改（Redux 默认值） |
| `src/renderer/services/i18n.ts` | 修改（国际化 key，含 Tab 名称和内容展示文案） |
| `src/renderer/components/cowork/DreamingSettingsSection.tsx` | **新建**（UI 组件，含配置表单和内容展示） |
| `src/renderer/components/Settings.tsx` | 修改（记忆页 Tab 化 + 集成点） |
| `src/main/libs/openclawConfigSync.ts` | 修改（config sync 逻辑） |
| `src/main/main.ts` | 修改（新增 dreaming:status / dreaming:diary IPC 通道） |
| `src/main/preload.ts` | 修改（暴露 getDreamingStatus / getDreamDiary 方法） |

## 7. 验收标准

1. 设置 > 记忆页面显示 Dreaming section，默认关闭
2. 开启开关后，频率选择器、时区输入、高级区域正常展开
3. 选择预设频率 / 输入自定义 cron / 填写时区和模型 → 保存 → 重新打开设置后值保持不变
4. 保存后检查 `openclaw.json`，`dreaming` 字段正确包含 `enabled`、`frequency`，以及非空的 `timezone`、`model`
5. 关闭开关 → 保存 → `openclaw.json` 中无 `dreaming` 字段
6. 中英文切换后所有标签/提示正确显示
7. 设置 > 记忆页面三个 Tab（记忆条目管理 / Embedding 语义搜索 / Dreaming 记忆整理）正常切换
8. Dreaming Tab 内，启用后显示场景/日记/高级三个子 Tab，内容为只读展示

---

## 8. 增补：记忆页 Tab 化 + Dreaming 内容展示 (2026-05-11)

### 8.1 背景

原有设计将三个子模块（记忆条目管理、Embedding、Dreaming）平铺显示，滚动体验差。需重构为 Tab 切换形式，并在 Dreaming Tab 中增加对标 OpenClaw 后台 `/dreaming` 页面的只读内容展示。

### 8.2 记忆页 Tab 化

参照 **设置 > 个性化** 的 `bootstrapTab` 实现模式：

- 新增 state: `memoryTab: 'entries' | 'embedding' | 'dreaming'`
- 三个 Tab: 记忆条目管理 / Embedding 语义搜索 / Dreaming 记忆整理
- Tab 按钮样式与个性化页一致 (`bg-primary-muted text-primary border-b-2 border-primary`)

### 8.3 Dreaming 内容展示

在 Dreaming 配置表单下方，增加内容展示区，包含三个子 Tab：

#### 场景 Tab

- 状态指示（活跃/空闲），带彩色圆点
- 已提升计数、时区
- 三阶段状态：Light / Deep / REM 的启用状态和下次运行时间

#### 日记 Tab

- 解析 `DREAMS.md` 内容（与 OpenClaw `parseDiaryEntries` 逻辑一致）
- 按日期切分，逆序展示，日期 chip 导航
- `flattenDiaryBody` 清洗：移除结构化标题、源引用标记、列表标记
- 支持刷新

#### 高级 Tab

- 三段式列表：已扎根信号 / 等待中条目 / 今日已提升
- 等待中条目支持按"最近"和"信号"两种排序
- 每条目显示 snippet、源位置、信号计数
- 仅只读展示，不包含操作按钮

### 8.4 IPC 通道

| 通道 | 方法 | 说明 |
|------|------|------|
| `cowork:dreaming:status` | `doctor.memory.status` | 获取 dreaming 状态、阶段信息、短期/已提升条目 |
| `cowork:dreaming:diary` | `doctor.memory.dreamDiary` | 获取 Dream Diary 文件内容 |

通过现有 `openClawRuntimeAdapter.getGatewayClient().request()` 调用。

### 8.5 新增类型

`src/renderer/types/cowork.ts` 新增：

- `DreamingPhaseInfo`: 阶段配置（enabled, cron, nextRunAtMs）
- `DreamingEntry`: 短期/已提升条目（key, path, snippet, 各类信号计数等）
- `DreamingStatusData`: 完整状态数据
- `DreamDiaryData`: 日记文件数据（found, path, content, updatedAtMs）

