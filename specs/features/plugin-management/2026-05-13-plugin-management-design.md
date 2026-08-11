# 插件管理功能设计文档

## 1. 概述

### 1.1 问题/背景

当前 智码 GLM Code 没有通用的插件管理入口，用户无法自行安装或管理 OpenClaw 社区插件。存在以下局限：

- 没有 UI 层面的插件管理功能
- 用户无法自行安装其他 OpenClaw 社区插件
- 随着 OpenClaw 插件生态的发展，需要一个通用的插件管理入口

OpenClaw 本身已经提供了完善的插件系统，支持 ClawHub、npm、Git、本地路径等多种安装来源，并有标准的插件清单格式（`openclaw.plugin.json`）。智码 GLM Code 需要在 UI 层面对接这些能力。

**OpenClaw 插件参考文档：**
- https://docs.openclaw.ai/tools/plugin
- https://docs.openclaw.ai/plugins/manage-plugins
- https://docs.openclaw.ai/plugins/community

### 1.2 目标

- 在 Settings 中新增 "插件" 标签页，提供通用的插件管理入口
- 支持用户通过 UI 安装、卸载、启用/禁用任意符合 OpenClaw 规范的插件
- 支持 4 种安装来源：npm（含私有 registry）、ClawHub、Git URL、本地路径

## 2. 用户场景

### 场景 1: 查看已安装插件

**Given** 用户已安装了若干插件
**When** 用户打开 设置 → 插件
**Then** 看到所有已安装插件的列表，含名称、版本、来源标记、启用开关

### 场景 2: 安装 npm 插件（含私有 registry）

**Given** 用户需要安装一个来自私有 npm registry 的插件
**When** 用户点击"安装插件"，选择 npm 来源，输入包名、版本、Registry URL
**Then** 系统下载并安装插件，列表刷新显示新插件，网关重启加载

### 场景 3: 安装 ClawHub 社区插件

**Given** 用户想安装 OpenClaw 社区插件
**When** 用户点击"安装插件"，选择 ClawHub 来源，输入包名
**Then** 系统从 ClawHub 下载安装

### 场景 4: 安装本地插件

**Given** 开发者有本地开发的插件目录或 tgz 文件
**When** 用户选择"本地路径"来源，通过文件选择器选择目录/文件
**Then** 系统安装到运行时目录

### 场景 5: 启用/禁用插件

**Given** 用户已安装某插件且当前已启用
**When** 用户关闭该插件的开关
**Then** 配置同步到 openclaw.json，网关重启后该插件不再加载

### 场景 6: 卸载插件

**Given** 用户已安装某第三方插件
**When** 用户点击卸载
**Then** 插件文件从 third-party-extensions 移除，配置清理，列表刷新

## 3. 功能需求

### FR-1: 插件列表展示

- 显示所有已安装插件（用户安装 + bundled channel 插件）
- 每个插件显示：ID、版本、描述、来源标记、启用开关
- 用户安装的插件可卸载，bundled 插件不可卸载
- 有 `configSchema` 的插件显示齿轮配置入口（详见 advanced-config 文档）

### FR-2: 插件安装

支持 4 种来源：

| 来源 | 输入字段 | 底层执行 |
|------|----------|----------|
| npm | 包名 + 版本(可选) + Registry URL(可选) | `npm pack` → `openclaw plugins install <tgz>` |
| ClawHub | 包名 | `openclaw plugins install clawhub:<name>` |
| Git | Git URL (支持 @tag/branch/commit) | `git clone` → pack → install |
| 本地路径 | 文件选择（目录或 .tgz） | `openclaw plugins install <path>` |

安装过程提供进度反馈（loading 状态 + 日志）。

### FR-3: 插件卸载

- 从 third-party-extensions 目录移除插件文件
- 从 user_plugins 记录中删除
- 触发配置同步，网关重启

### FR-4: 插件启用/禁用

- 切换 enabled 状态
- 立即同步到 openclaw.json 的 `plugins.entries`
- 触发网关重启生效

### FR-5: 插件配置

- 支持读取插件清单中的 `configSchema` 和 `uiHints`
- 有配置项的插件在列表中显示齿轮图标，点击进入配置子页面
- 配置保存到 user_plugins 表的 config 列，同步到 openclaw.json
- 详细设计见 `2026-05-13-plugin-advanced-config-design.md`

## 4. 实现方案

### 4.1 数据层 — user_plugins 表

在 `sqliteStore.ts` 中创建 SQLite 表，`coworkStore.ts` 中实现 CRUD 方法：

```sql
CREATE TABLE IF NOT EXISTS user_plugins (
  plugin_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,        -- 'npm' | 'clawhub' | 'git' | 'local'
  spec TEXT NOT NULL,          -- 安装时的原始 specifier
  registry TEXT,               -- 可选的 npm registry URL
  version TEXT,                -- 已安装的版本号
  enabled INTEGER DEFAULT 1,   -- 1=启用, 0=禁用
  installed_at INTEGER NOT NULL,
  config TEXT                   -- JSON 格式的插件自定义配置
);
```

CRUD 方法（coworkStore.ts）：
- `listUserPlugins(): UserInstalledPlugin[]`
- `addUserPlugin(plugin: UserInstalledPlugin): void` — 使用 UPSERT 支持覆盖安装
- `removeUserPlugin(pluginId: string): void`
- `setUserPluginEnabled(pluginId: string, enabled: boolean): void`
- `getUserPlugin(pluginId: string): UserInstalledPlugin | undefined`
- `getUserPluginConfig(pluginId: string): Record<string, unknown> | null`
- `setUserPluginConfig(pluginId: string, config: Record<string, unknown>): void`

### 4.2 插件管理核心 — pluginManager.ts

新建 `src/main/libs/pluginManager.ts`，封装 `PluginManager` 类：

- `installPlugin(params, onLog?)`: 根据 source 类型调用不同的安装流程，通过回调实时输出安装日志
  - npm: `spawn('npm.cmd', ['pack', spec, '--registry=...'])` → `runOpenClawCli(['plugins', 'install', tgzPath])`
  - clawhub: `runOpenClawCli(['plugins', 'install', 'clawhub:' + name])`
  - git: clone → pack → install
  - local: `runOpenClawCli(['plugins', 'install', path])`
- `uninstallPlugin(pluginId)`: 删除 extensions 目录 + 清理记录
- `listPlugins()`: 合并 bundled manifests + user_plugins 记录，返回 `PluginListItem[]`
- `setPluginEnabled(pluginId, enabled)`
- `getPluginConfigSchema(pluginId)`: 读取插件清单，返回 `{ configSchema, uiHints }`
- `getPluginConfig(pluginId)` / `savePluginConfig(pluginId, config)`

使用 `vendor/openclaw-runtime/current/openclaw.mjs` 作为 CLI 入口（与 ensure-openclaw-plugins.cjs 一致）。

### 4.3 IPC 层

Main process handlers:
- `plugins:list` → 返回所有已安装插件列表
- `plugins:install` → 触发安装流程，返回结果；安装过程通过 `plugins:install-log` 事件推送日志
- `plugins:uninstall` → 触发卸载
- `plugins:set-enabled` → 切换启用状态
- `plugins:get-config-schema` → 返回插件的 configSchema + uiHints + 当前配置
- `plugins:save-config` → 保存插件配置并触发配置同步

Preload 暴露:
```typescript
plugins: {
  list: () => ipcRenderer.invoke('plugins:list'),
  install: (params) => ipcRenderer.invoke('plugins:install', params),
  uninstall: (pluginId) => ipcRenderer.invoke('plugins:uninstall', pluginId),
  setEnabled: (pluginId, enabled) => ipcRenderer.invoke('plugins:set-enabled', pluginId, enabled),
  getConfigSchema: (pluginId) => ipcRenderer.invoke('plugins:get-config-schema', pluginId),
  saveConfig: (pluginId, config) => ipcRenderer.invoke('plugins:save-config', pluginId, config),
  onInstallLog: (callback) => {
    ipcRenderer.on('plugins:install-log', handler);
    return () => ipcRenderer.removeListener('plugins:install-log', handler);
  },
}
```

### 4.4 配置同步整合

在 `openclawConfigSync.ts` 中新增 `getUserPlugins` 依赖注入：

- 返回 `Array<{ pluginId, enabled, config? }>`
- 在 plugin entries 生成时，将用户安装的插件合并到 `plugins.entries`
- 每个插件的 enabled 状态和 config 同步到 `openclaw.json`
- 安装/卸载/启用禁用/配置保存后均触发 `syncOpenClawConfig()`

### 4.5 UI 层

**Settings.tsx 变更:**
- TabType: 新增 `'plugins'`
- Tab 使用 `PuzzlePieceIcon` 图标
- 对应 case 渲染 `<PluginsSettings>` 组件

**新建 PluginsSettings.tsx:**
- 插件列表组件（卡片式展示）
- 安装对话框（Modal，来源切换 + 输入表单）
- 安装过程实时日志显示（通过 `onInstallLog` 事件）
- 操作按钮（安装中 loading / 成功 / 失败状态）
- 卸载确认对话框
- 齿轮配置入口（有 configSchema 的插件）→ 切换到 `<PluginConfigPage>` 子页面
- i18n 支持（中英文）

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 插件安装失败（网络/格式错误） | 显示错误信息，不写入 user_plugins |
| 安装同名插件覆盖 | UPSERT 覆盖安装，更新 user_plugins 记录的 version |
| bundled 插件尝试卸载 | UI 上隐藏卸载按钮，仅允许启用/禁用 |
| 私有 registry 不可达 | 超时报错，提示检查网络/地址 |
| 插件缺少 openclaw.plugin.json | OpenClaw CLI 会返回错误，透传给用户 |
| Gateway 重启期间操作 | 安装/卸载后统一触发 syncOpenClawConfig |
| 打包后的 app 安装插件 | 使用 `resources/cfmind/third-party-extensions/` 目录 |

## 6. 涉及文件

### 新增

| 文件 | 用途 |
|------|------|
| `src/main/libs/pluginManager.ts` | 插件安装/卸载/列表/配置核心逻辑 |
| `src/renderer/components/plugins/PluginsSettings.tsx` | 插件管理 UI 组件 |
| `src/renderer/components/plugins/PluginConfigPage.tsx` | 插件配置子页面 |

### 修改

| 文件 | 变更 |
|------|------|
| `src/renderer/components/Settings.tsx` | 新增 plugins Tab，渲染新组件 |
| `src/renderer/services/i18n.ts` | 插件相关 i18n 字符串（中英文） |
| `src/renderer/types/electron.d.ts` | 新增 plugins API 类型声明 |
| `src/renderer/components/im/SchemaForm.tsx` | 改为 schema 驱动渲染，支持自动生成 hints |
| `src/main/main.ts` | 新增 plugins:* IPC handlers |
| `src/main/coworkStore.ts` | user_plugins CRUD 方法 + UserInstalledPlugin 类型 |
| `src/main/sqliteStore.ts` | user_plugins 表创建 + config 列迁移 |
| `src/main/preload.ts` | 暴露 plugins API |
| `src/main/libs/openclawConfigSync.ts` | getUserPlugins 依赖注入 + plugin entries 合并 |
| `vite.config.ts` | 构建配置调整 |

## 7. 验收标准

- [ ] 设置中新增 "插件" 标签页可见（PuzzlePieceIcon 图标）
- [ ] 已安装插件在列表中显示，含 ID、版本、来源、启用开关
- [ ] npm 安装：输入包名 + 版本 + 可选 registry → 安装成功 → 列表刷新
- [ ] ClawHub 安装：输入 clawhub 包名 → 安装成功
- [ ] 本地路径安装：选择目录/tgz → 安装成功
- [ ] 安装过程实时显示日志输出
- [ ] 启用/禁用：切换后 openclaw.json entries 更新 → 网关重启生效
- [ ] 卸载：确认对话框 → 文件移除 + 配置清理 + 列表刷新
- [ ] 有 configSchema 的插件显示齿轮配置入口
- [ ] 安装失败时正确报错，不污染数据
