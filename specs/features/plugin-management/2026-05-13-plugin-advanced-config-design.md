# 插件高级配置功能设计文档

## 1. 概述

### 1.1 问题/背景

插件管理功能（`2026-05-13-plugin-management-design.md`）已实现了插件的安装、卸载、启用/禁用。但 OpenClaw 插件通常还需要用户配置自定义参数（如 API Key、端口号、功能开关等）。

OpenClaw 的插件清单（`openclaw.plugin.json`）支持两个字段来声明可配置项：

- `configSchema` — JSON Schema (draft-07)，定义配置结构和类型
- `uiHints` — UI 元数据，为每个配置项提供 label、help、placeholder、sensitive、advanced 等信息

配置值存储在 `openclaw.json` 的 `plugins.entries[pluginId].config` 中。OpenClaw 自带的 web UI（`/automation` → Plugins tab）能够解析这些字段并动态渲染配置表单。智码 GLM Code 需要在自身的插件管理页面中提供同等能力。

### 1.2 目标

- 用户可在 智码 GLM Code 的插件管理页面中查看并编辑插件的自定义配置项
- 配置项根据插件清单中的 `configSchema` 动态渲染，无需为每个插件硬编码 UI
- 配置保存后同步到 `openclaw.json`，网关重启生效
- 没有 `configSchema` 的插件不显示配置入口

## 2. 用户场景

### 场景 1: 查看并修改插件配置

**Given** 用户已安装一个带有 `configSchema` 的插件（如 memory-lancedb）
**When** 用户在插件列表中点击该插件的齿轮图标
**Then** 页面切换为配置子页面，显示该插件的所有可配置字段（API Key、模型名、端口等）

### 场景 2: 保存配置

**Given** 用户在配置页面修改了若干字段
**When** 用户点击"保存"按钮
**Then** 配置写入 SQLite，同步到 `openclaw.json` 的 `plugins.entries[pluginId].config`，网关重启生效

### 场景 3: 无配置项的插件

**Given** 某插件的 `openclaw.plugin.json` 中没有 `configSchema`（或 properties 为空）
**When** 用户查看插件列表
**Then** 该插件行不显示齿轮图标，无法进入配置页面

### 场景 4: 有 configSchema 但无 uiHints 的插件

**Given** 某插件定义了 `configSchema` 但 `uiHints` 为空（常见情况：很多插件只在运行时 TypeScript 代码中定义 uiHints，不写入静态 JSON 清单）
**When** 用户点击齿轮图标进入配置页面
**Then** 系统自动从 JSON Schema properties 生成 UI 标签和控件类型，字段名自动人性化显示（camelCase → 空格分词首字母大写），敏感字段名自动识别

## 3. 功能需求

### FR-1: 配置 Schema 读取

- 从插件目录的 `openclaw.plugin.json` 读取 `configSchema` 和 `uiHints`
- 当 `uiHints` 缺失/不完整时，从 `configSchema.properties` 自动生成：
  - 属性名 humanize 为 label（`requestTimeoutMs` → `Request Timeout Ms`）
  - 含 key/secret/token/password 的字段名自动标记 `sensitive`
  - 嵌套 object 生成折叠组，递归处理子属性
- 返回合并后的 `{ configSchema, uiHints }` 给前端

### FR-2: 配置存储

- 在 `user_plugins` 表新增 `config TEXT` 列，存储 JSON 格式的配置
- 通过 `PRAGMA table_info` 检测并迁移（与现有迁移模式一致）
- 提供 `getUserPluginConfig(pluginId)` / `setUserPluginConfig(pluginId, config)` 方法

### FR-3: 配置同步到 openclaw.json

- `openclawConfigSync.ts` 的 `getUserPlugins` 回调扩展为返回 `{ pluginId, enabled, config? }`
- 生成 plugin entries 时，将 config 合并到 `plugins.entries[pluginId].config` 中
- 触发 `syncOpenClawConfig({ reason: 'plugin-config' })` 使网关重启生效

### FR-4: 配置 UI — 插件列表入口

- 在每个插件行中增加齿轮图标按钮（`Cog6ToothIcon`）
- 仅当 `hasConfig === true`（插件有 configSchema 且 properties 非空）时显示
- 位于删除按钮之前、开关之前

### FR-5: 配置 UI — 配置子页面

- 点击齿轮图标后，插件列表区域替换为配置子页面（非弹窗）
- 顶部：返回箭头 + 插件配置标题 + 插件 ID
- 中部：基于 `SchemaForm` 动态渲染的配置表单
- 底部：返回按钮 + 保存按钮（含 saving/saved 状态反馈）

### FR-6: SchemaForm 改造 — Schema 驱动渲染

原有 `SchemaForm` 是 hints 驱动（遍历 hints keys 决定渲染哪些字段），改为 schema 驱动：

| 改前 | 改后 |
|------|------|
| 遍历 `Object.keys(hints)` 发现字段 | 遍历 `schema.properties` 发现字段 |
| 没有 hint = 不渲染 | 没有 hint = 自动生成 label |
| hint.label 必填 | hint.label 可选，自动 fallback |
| 不显示帮助文本 | 支持 `hint.help` / `schema.description` |
| 不支持 placeholder | 支持 `hint.placeholder` / `schema.default` |

支持的字段类型：

| JSON Schema type | 渲染控件 |
|---|---|
| `boolean` | 开关 Toggle |
| `string` | 文本输入（sensitive 时为密码框 + 显隐切换） |
| `string` + `enum` | 下拉选择 |
| `number` / `integer` | 数字输入 |
| `array` | 多行文本域（每行一项） |
| `object` (嵌套) | 折叠组 + 子字段递归渲染 |

## 4. 实现方案

### 4.1 数据层

**coworkStore.ts:**

```sql
ALTER TABLE user_plugins ADD COLUMN config TEXT;
```

新增方法：
- `getUserPluginConfig(pluginId)` → `JSON.parse(row.config)`
- `setUserPluginConfig(pluginId, config)` → `JSON.stringify(config)` 写入

**sqliteStore.ts 迁移:**

```typescript
const pluginCols = this.db.pragma('table_info(user_plugins)');
if (!pluginCols.some(c => c.name === 'config')) {
  this.db.exec('ALTER TABLE user_plugins ADD COLUMN config TEXT;');
}
```

### 4.2 pluginManager.ts

新增方法：

- `getPluginConfigSchema(pluginId)` — 读取清单，合并/生成 uiHints，返回 `{ configSchema, uiHints }`
- `getPluginConfig(pluginId)` — 从 store 读取当前配置
- `savePluginConfig(pluginId, config)` — 写入 store

新增辅助函数：

- `generateHintsFromSchema(schema, existingHints, prefix)` — 递归遍历 JSON Schema properties，为缺失的 hint 自动生成条目
- `humanizeKey(key)` — camelCase/snake_case → 首字母大写空格分词

### 4.3 IPC 层

新增 handlers：

| IPC Channel | 参数 | 返回 |
|---|---|---|
| `plugins:get-config-schema` | `pluginId` | `{ success, schema?, config?, error? }` |
| `plugins:save-config` | `pluginId, config` | `{ ok, error? }` |

Preload 新增：
```typescript
getConfigSchema: (pluginId) => ipcRenderer.invoke('plugins:get-config-schema', pluginId),
saveConfig: (pluginId, config) => ipcRenderer.invoke('plugins:save-config', pluginId, config),
```

### 4.4 配置同步

`openclawConfigSync.ts` 中 `getUserPlugins` 签名扩展：

```typescript
// 改前
getUserPlugins: () => Array<{ pluginId: string; enabled: boolean }>
// 改后
getUserPlugins: () => Array<{ pluginId: string; enabled: boolean; config?: Record<string, unknown> }>
```

Plugin entries 生成时合并 config：

```typescript
this.getUserPlugins().map(p => [p.pluginId, {
  enabled: p.enabled,
  ...(p.config && Object.keys(p.config).length > 0 ? { config: p.config } : {}),
}])
```

### 4.5 前端组件

**PluginsSettings.tsx 变更：**
- 新增 `configPluginId` state 控制子页面路由
- 每个插件行增加齿轮图标（条件渲染 `hasConfig`）
- `configPluginId` 非空时渲染 `<PluginConfigPage>` 替代列表

**新建 PluginConfigPage.tsx：**
- 接收 `pluginId` 和 `onBack` 回调
- `useEffect` 加载 schema + 当前 config
- `deepSet` 工具函数处理嵌套对象路径赋值
- 复用 `SchemaForm` 渲染动态表单
- 保存按钮调用 `plugins:save-config` 后触发配置同步

**SchemaForm.tsx 改造：**
- 新增 `collectFieldPaths()` 从 schema.properties 递归收集字段路径
- 新增 `getHint()` 自动生成缺失的 hint
- `renderField()` 增加 help 文本和 placeholder 支持
- 向后兼容：现有 NimInstanceSettings 等调用者不受影响

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 插件有 configSchema 但 properties 为空对象 | `hasConfig = false`，不显示齿轮 |
| 插件有 configSchema 但无 uiHints | 自动从 schema properties 生成完整 hints |
| uiHints 只覆盖部分属性 | 未覆盖的属性自动生成 hint，已有的保留 |
| 敏感字段（API Key 等） | 自动检测 key/secret/token/password 模式，或尊重 hint.sensitive，渲染为密码框 |
| 嵌套 object 属性 | 渲染为折叠组（`<details>`），子属性缩进显示 |
| 复杂 array（items 为 object） | 当前降级为多行文本域；后续可增强为结构化列表编辑 |
| 保存空配置 | 不写入 config 字段，不影响 openclaw.json |
| 预装插件（bundled）无齿轮 | 仅 user_plugins 表中的插件显示配置入口 |

## 6. 涉及文件

### 新增

| 文件 | 用途 |
|------|------|
| `src/renderer/components/plugins/PluginConfigPage.tsx` | 插件配置子页面 |

### 修改

| 文件 | 变更 |
|------|------|
| `src/main/libs/pluginManager.ts` | 扩展 PluginManifest 类型、新增 configSchema 读取和 hints 自动生成 |
| `src/main/coworkStore.ts` | UserInstalledPlugin 增加 config 字段、新增 getter/setter |
| `src/main/sqliteStore.ts` | user_plugins 表 config 列迁移 |
| `src/main/libs/openclawConfigSync.ts` | getUserPlugins 签名扩展、plugin entries 合并 config |
| `src/main/main.ts` | 新增 2 个 IPC handlers、getUserPlugins 回调传递 config |
| `src/main/preload.ts` | 暴露 getConfigSchema、saveConfig API |
| `src/renderer/components/im/SchemaForm.tsx` | 改为 schema 驱动渲染、自动生成 hints、增加 help/placeholder 支持 |
| `src/renderer/components/plugins/PluginsSettings.tsx` | 齿轮按钮、子页面路由 |
| `src/renderer/types/electron.d.ts` | hasConfig、getConfigSchema、saveConfig 类型声明 |
| `src/renderer/services/i18n.ts` | 配置相关 i18n 键（中英文） |

## 7. 验收标准

- [ ] 有 configSchema 的用户安装插件，列表中显示齿轮图标
- [ ] 无 configSchema（或 properties 为空）的插件，不显示齿轮图标
- [ ] 点击齿轮 → 配置子页面正确渲染，字段类型与 schema 匹配
- [ ] 有 uiHints 时优先使用 label/help/placeholder/sensitive
- [ ] 无 uiHints 时自动从 schema 生成可读的标签
- [ ] 敏感字段渲染为密码框，支持显隐切换
- [ ] 嵌套 object 渲染为折叠组
- [ ] 保存后 `openclaw.json` 中 `plugins.entries[pluginId].config` 正确更新
- [ ] 返回列表后再次进入配置页，已保存的值正确回显
- [ ] 现有使用 SchemaForm 的页面（NimInstanceSettings 等）不受影响
