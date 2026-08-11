# 插件更新检测设计文档

## 1. 概述

### 1.1 问题/背景

智码 GLM Code 支持从 npm 和 clawhub 安装第三方插件，但安装后没有任何版本更新检测机制。用户无法得知插件是否有新版本，也无法便捷地执行更新。

### 1.2 目标

- 支持用户手动检测已安装插件是否有新版本（npm 和 clawhub 来源）
- 检测到新版本后，用户确认即可一键更新
- 不做自动检测，避免不必要的网络请求和干扰

## 2. 用户场景

### 场景 1: 检测到可用更新

**Given** 用户已安装来自 npm 的插件 `nsp-clawguard@2.1.5`，npm 上最新版为 `2.2.0`
**When** 用户在插件设置页点击"检查更新"按钮
**Then** 系统对所有 npm/clawhub 插件并行查询最新版本，`nsp-clawguard` 旁显示 `→ 2.2.0` 更新标记

### 场景 2: 执行更新

**Given** 插件 `nsp-clawguard` 显示有可用更新 `2.1.5 → 2.2.0`
**When** 用户点击该插件的"更新"按钮并在确认弹窗中确认
**Then** 系统执行更新（复用安装流程），完成后版本号更新，gateway 自动重启

### 场景 3: 所有插件已是最新

**Given** 用户已安装的所有插件均为最新版
**When** 用户点击"检查更新"
**Then** 提示"所有插件已是最新版本"

### 场景 4: 检测失败（网络错误）

**Given** 用户网络不可用或目标 registry 不可达
**When** 用户点击"检查更新"
**Then** 对检测失败的插件显示错误信息，不影响其他插件的检测结果

## 3. 功能需求

### FR-1: 版本检测

- 支持 npm 和 clawhub 两种来源的版本检测
- npm：通过 `npm view {spec} version --registry={registry}` 查询
- clawhub：通过 HTTP GET `{clawhubBaseUrl}/api/v1/packages/{name}` 查询 `package.latestVersion`
- 并行检测所有符合条件的插件
- 单个插件检测超时 30 秒
- 使用已记录的 registry 信息（SQLite `user_plugins.registry` 列）

### FR-2: 版本对比

- 比较本地已安装版本与远程最新版本
- 字符串不等即视为有更新（不引入 semver 库）
- 本地版本为空时视为有可用更新

### FR-3: 更新执行

- 复用现有 `installPlugin()` 流程，不指定 version（即安装最新）
- 更新过程流式输出日志
- 更新完成后触发 gateway 配置同步和重启
- 更新 SQLite 中的版本记录

### FR-4: UI 交互

- 插件设置页 header 区域新增"检查更新"按钮
- 检测期间按钮显示加载状态
- 有更新的插件在列表中显示目标版本号和"更新"按钮
- 点击"更新"弹出确认对话框
- 确认后显示更新日志（复用现有 install-log 模式）

## 4. 实现方案

### 4.1 PluginManager 新增方法

文件：`src/main/libs/pluginManager.ts`

```typescript
export interface PluginUpdateInfo {
  pluginId: string;
  currentVersion: string | null;
  latestVersion: string | null;
  hasUpdate: boolean;
  error?: string;
}
```

新增方法：
- `checkPluginUpdates(pluginIds?: string[]): Promise<PluginUpdateInfo[]>` — 主入口
- `private checkNpmLatestVersion(spec: string, registry?: string): Promise<string>` — npm 版本查询
- `private checkClawHubLatestVersion(spec: string): Promise<string>` — clawhub 版本查询

npm 版本查询复用 `resolveNpmCommand()` 和 `runAsync()`，执行 `npm view {spec} version --json`。

clawhub 版本查询使用 Node.js `https` 模块，请求 `GET /api/v1/packages/{name}`，读取响应中 `package.latestVersion` 字段。base URL 默认 `https://clawhub.ai`，可被 `OPENCLAW_CLAWHUB_URL` 环境变量覆盖。

### 4.2 IPC Handler

文件：`src/main/ipcHandlers/plugins/handlers.ts`

新增：
- `plugins:check-updates` — 调用 `PluginManager.checkPluginUpdates()`
- `plugins:update` — 调用 `PluginManager.installPlugin()` 复用安装流程，更新后同步配置

### 4.3 Preload Bridge

文件：`src/main/preload.ts`

`window.electron.plugins` 新增：
- `checkUpdates(pluginIds?: string[])` → `ipcRenderer.invoke('plugins:check-updates', pluginIds)`
- `update(pluginId: string)` → `ipcRenderer.invoke('plugins:update', pluginId)`

### 4.4 Renderer UI

文件：`src/renderer/components/plugins/PluginsSettings.tsx`

- Header 新增"检查更新"按钮（ArrowPathIcon，检测中旋转动画）
- 新增 state：`checking`、`updateInfos`（Map<pluginId, PluginUpdateInfo>）、`updating`
- 插件列表项：有更新时显示 `→ {latestVersion}` 绿色标记 + "更新"按钮
- 更新确认弹窗：显示从哪个版本到哪个版本，确认后触发更新
- 更新日志复用现有 `installLog` + `onInstallLog` 模式

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 插件无 version 字段 | 跳过该插件，不报错 |
| npm 自定义 registry 不可达 | 该插件返回 error，其他插件不受影响 |
| clawhub API 返回 latestVersion 为 null | 视为无可用更新 |
| 更新过程中 gateway 持有文件锁 | 已有 staging-dir 模式规避（Windows 安全） |
| 更新后 configSchema 变更 | 保留用户旧 config 不动，可能出现 schema 不匹配但不致命 |
| source 为 local/git/openclaw | 不参与检测，界面不显示更新按钮 |
| 并发：用户连续点击检查按钮 | 检测进行中按钮 disabled |

## 6. 涉及文件

| 文件 | 改动 |
|------|------|
| `src/main/libs/pluginManager.ts` | 新增检测方法 |
| `src/main/ipcHandlers/plugins/handlers.ts` | 新增 IPC handler |
| `src/main/preload.ts` | bridge 扩展 |
| `src/renderer/components/plugins/PluginsSettings.tsx` | UI 实现 |
| i18n 文件 | 新增翻译 key |

## 7. 验收标准

- [ ] 点击"检查更新"，npm 来源插件能正确检测到最新版本
- [ ] 点击"检查更新"，clawhub 来源插件能正确检测到最新版本
- [ ] 使用自定义 registry 的 npm 插件能正确检测
- [ ] 检测结果正确区分"有更新"和"已是最新"
- [ ] 点击"更新"后弹出确认对话框
- [ ] 确认更新后流程正常完成，版本号更新
- [ ] 更新完成后 gateway 自动重启
- [ ] 网络超时/失败时有明确错误提示
- [ ] 检测期间 UI 有适当的加载状态反馈
