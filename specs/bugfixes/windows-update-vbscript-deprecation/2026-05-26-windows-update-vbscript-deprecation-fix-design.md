# Windows 更新安装依赖 VBScript 修复设计文档

## 1. 概述

### 1.1 问题

用户反馈 智码 GLM Code 的 Windows 更新脚本仍在使用 VBScript，而 Windows 11 正在逐步淘汰 VBScript 支持。截图中出现两个关键信息：

1. Windows 兼容性提示检测到 `Wscript.exe` VBScript 使用。
2. Windows Script Host 报错无法找到临时文件中的 `VBScript` 脚本，路径形如 `%TEMP%\lobsterai-update-<timestamp>.vbs`。

代码现状与反馈一致。Windows 更新安装路径在 `src/main/libs/appUpdateInstaller.ts` 的 `installWindowsNsis()` 中会：

1. 生成 `%TEMP%\lobsterai-update-<timestamp>.ps1`。
2. 生成 `%TEMP%\lobsterai-update-<timestamp>.vbs`。
3. 通过 `wscript.exe` 运行 `.vbs`。
4. `.vbs` 再隐藏启动 `powershell.exe`，由 PowerShell 等待 智码 GLM Code 退出后打开 NSIS 安装器。

当前 VBS 内容本质上只是一个隐藏 PowerShell 窗口的 launcher：

```vbscript
CreateObject("WScript.Shell").Run "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File ""<scriptPath>""", 0, False
```

因此用户说的“智码 GLM Code 还在使用 vbs”是准确的。问题不在 NSIS 安装包本身，也不是手动下载链接，而是应用内“下载完成后点击立即更新”的 Windows 安装启动链路。

### 1.2 外部环境变化

微软已将 VBScript 列入 Windows 弃用能力。Windows 11 24H2 起，VBScript 作为 Feature on Demand 提供；后续阶段会默认禁用，再往后移除。参考微软官方说明：

<https://techcommunity.microsoft.com/t5/windows-it-pro-blog/vbscript-deprecation-timelines-and-next-steps/ba-p/4148301>

这意味着继续依赖 `wscript.exe` 会带来以下风险：

- 新版 Windows 弹出兼容性助手提示，打断更新体验。
- 企业或安全基线禁用 Windows Script Host 后，应用内更新安装失败。
- VBScript 默认禁用或移除后，当前更新链路不可用。
- 用户需要手动启用 VBScript FoD 才能更新，这不是可接受的产品方案。

### 1.3 根因

当前设计要解决的是 Windows 更新时的两个工程约束：

1. NSIS 安装器需要在 智码 GLM Code 当前进程退出后再运行，避免安装时文件仍被占用。
2. 等待和启动安装器的辅助脚本不应显示额外控制台窗口。

为此现有实现使用了“两层脚本”：

```text
智码 GLM Code main process
  -> wscript.exe lobsterai-update-<ts>.vbs
    -> powershell.exe -WindowStyle Hidden -File lobsterai-update-<ts>.ps1
      -> wait current app PID exits
      -> Start-Process <downloaded NSIS installer>
```

其中 PowerShell 脚本仍然承担真正的等待和启动安装器逻辑；VBScript 只负责隐藏启动 PowerShell。这个隐藏窗口目的合理，但使用 VBScript 作为 launcher 已经不符合 Windows 平台演进方向。

### 1.4 目标

P0 修复目标：

1. Windows 应用内更新安装流程不再生成或执行 `.vbs` 文件。
2. 不再调用 `wscript.exe` 或依赖 Windows Script Host / VBScript FoD。
3. 保留现有 PowerShell 等待当前 app 退出、再打开 NSIS 安装器的行为。
4. 保留安装器正常 UI，不切换为静默安装。
5. 保留隐藏等待脚本窗口的体验，不出现 PowerShell 控制台闪窗。
6. 若 launcher 启动失败，应在 app 退出前返回安装失败状态，避免用户看到应用关闭但安装器没有出现。

### 1.5 非目标

本次不做以下事情：

- 不迁移到 `electron-updater` 或重写更新系统。
- 不改变更新检查 API、下载缓存、ready file 持久化、自动/手动更新状态机。
- 不改 macOS DMG 安装流程。
- 不重写 NSIS 安装脚本中的 PowerShell 逻辑。
- 不把“提示用户启用 VBScript FoD”作为正式解决方案。
- 不改变企业配置中禁用更新的行为。

## 2. 用户场景

### 场景 1：Windows 11 24H2 禁用 VBScript 后安装更新

**Given** 用户使用 Windows 11 24H2，VBScript FoD 未启用或被企业策略禁用
**When** 智码 GLM Code 下载更新完成，用户点击立即更新
**Then** 应用不生成 `.vbs`，不调用 `wscript.exe`，不弹出 Windows 兼容性助手或 Windows Script Host 错误
**And** 智码 GLM Code 退出后 NSIS 安装器正常出现。

### 场景 2：普通 Windows 10/11 环境安装更新

**Given** 用户系统仍支持 VBScript
**When** 用户点击立即更新
**Then** 行为与现有体验一致：等待脚本隐藏执行，安装器正常显示
**And** 不因为去掉 VBS 改变安装路径、快捷方式、开始菜单、安装后运行等 NSIS 行为。

### 场景 3：PowerShell launcher 启动失败

**Given** 系统无法启动 `powershell.exe`，或脚本文件写入失败
**When** 用户点击立即更新
**Then** 智码 GLM Code 不应先退出
**And** 更新状态进入安装失败，UI 可显示现有 `updateInstallFailed` 文案并允许用户重试或手动安装。

### 场景 4：当前 app 退出较慢

**Given** 当前 智码 GLM Code 进程退出需要清理 OpenClaw Gateway、IM Gateway 或文件句柄
**When** launcher 已启动
**Then** PowerShell 脚本继续按现有逻辑等待当前 app PID，最多等待既有超时时间
**And** 等待结束后启动 NSIS 安装器。

### 场景 5：下载好的 ready update 跨重启安装

**Given** 更新文件已下载并持久化为 ready file
**When** 用户重启应用后点击立即更新
**Then** 新 launcher 对 persisted ready file 同样生效，不要求重新下载。

## 3. 功能需求

### FR-1：不得再生成或执行 VBS

Windows 更新安装路径不得再写入：

```text
%TEMP%\lobsterai-update-<timestamp>.vbs
```

也不得再调用：

```text
wscript.exe
cscript.exe
```

`rg "wscript|cscript|\\.vbs|VBScript" src/main/libs/appUpdateInstaller.ts` 应找不到新的运行时依赖。

### FR-2：直接以隐藏窗口启动 PowerShell launcher

主进程应直接 detached spawn PowerShell：

```ts
spawn('powershell.exe', [
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-WindowStyle',
  'Hidden',
  '-File',
  scriptPath,
], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
```

关键点：

- 使用参数数组，不拼接整条命令，降低路径包含空格、中文或特殊字符时的转义风险。
- 设置 `windowsHide: true`，避免 PowerShell 控制台闪窗。
- 保留 `detached: true` 和 `unref()`，使等待脚本不依赖 智码 GLM Code 主进程生命周期。
- 使用 `-NoProfile`，避免用户 PowerShell profile 影响更新脚本。

### FR-3：保留现有 PowerShell 等待和安装逻辑

现有 `.ps1` 的核心行为应保留：

1. 写入 `%TEMP%\lobsterai-update-<timestamp>.log`。
2. 记录当前 app PID。
3. 最多等待当前 PID 退出。
4. 使用 `Start-Process -FilePath $installerPath` 打开 NSIS 安装器。

本次不改变安装器参数，不添加 `/S`，不绕过 NSIS 的正常 UI。

### FR-4：启动确认后再退出 app

主进程不应在无法确认 launcher 启动成功时立即 `app.quit()`。

建议封装一个小 helper：

```ts
async function spawnDetachedWindowsUpdateLauncher(scriptPath: string): Promise<number | undefined>
```

行为：

- `spawn()` 同步抛错时，直接 reject。
- 子进程触发 `error` 事件时，reject。
- 子进程触发 `spawn` 事件后，调用 `unref()` 并 resolve launcher PID。
- resolve 后再调用 `app.quit()`。

这样可以避免 PowerShell 不存在或策略拦截时，应用先退出但安装器没有启动。

### FR-5：日志文案要反映真实 launcher

现有日志：

```text
[AppUpdate] Launching installer via wscript.exe...
```

应改为描述 PowerShell launcher，例如：

```text
[AppUpdate] Launching installer via hidden PowerShell script...
```

日志仍需遵守仓库日志规范：英文、`[AppUpdate]` tag、错误日志带 error object。

### FR-6：不引入用户可见新文案

理想情况下本次不需要新增 i18n 文案。launcher 启动失败可以复用现有安装失败状态：

- `updateInstallFailed`
- `updateRetry`

错误详情继续进入 `state.errorMessage`，供日志和调试使用。

### FR-7：保持跨路径兼容

以下路径必须正确处理：

- 用户名包含空格。
- 用户名或 temp 路径包含中文。
- 下载的安装器路径包含空格。
- 安装器文件在 `%APPDATA%` 或 Electron `userData` 派生目录下。

实现上应继续在 `.ps1` 内使用单引号转义 `psEscape()` 保存 `$installerPath` 和 `$logPath`，PowerShell 入口则用 `-File` 参数数组传入 `scriptPath`。

## 4. 实现方案

### 4.1 最小改动方案

修改 `src/main/libs/appUpdateInstaller.ts` 的 `installWindowsNsis()`：

1. 删除 `vbsPath` 变量。
2. 删除 `vbsScript` 构造和 `fs.promises.writeFile(vbsPath, ...)`。
3. 将 `spawn('wscript.exe', [vbsPath], ...)` 替换为 `spawn('powershell.exe', args, options)`。
4. 增加 launcher 启动成功确认。
5. 日志从 `wscript.exe` 改为 hidden PowerShell script。
6. `app.quit()` 保持在 launcher 启动成功之后。

推荐流程：

```text
write ps1
  -> spawn hidden detached powershell.exe -File ps1
  -> wait launcher spawn success
  -> launcher.unref()
  -> app.quit()
```

### 4.2 备选方案评估

| 方案 | 结论 | 原因 |
|---|---|---|
| 直接 spawn hidden PowerShell | 推荐 | 改动最小，去除 VBS，保留现有等待逻辑 |
| `cmd.exe /c start` 启动 PowerShell | 不推荐作为首选 | 可能出现 cmd 窗口闪烁，引用规则更复杂 |
| 直接 spawn NSIS 安装器后 `app.quit()` | 暂不采用 | 会跳过现有等待脚本，可能重新引入 app 未完全退出时安装的问题 |
| 打包一个原生 launcher exe | P1 备选 | 可减少对 PowerShell 的依赖，但新增构建、签名和安全审计成本 |
| 迁移 `electron-updater` | 不适合 P0 | 当前已有自定义更新 API、缓存、状态机和 NSIS 行为，迁移范围过大 |
| 要求用户启用 VBScript FoD | 不作为产品方案 | 与 Windows 弃用路线相反，企业环境也可能无法启用 |

### 4.3 PowerShell 依赖说明

本次只是移除 VBScript，并不移除 PowerShell。当前项目的 Windows 安装器脚本 `scripts/nsis-installer.nsh` 已经大量使用 PowerShell 处理进程停止、技能备份、资源解包和 Defender exclusion 等安装动作。

因此 P0 目标是解决 VBScript deprecation 导致的更新启动失败，而不是把 Windows 安装链路改造成完全无 PowerShell。

如果后续遇到企业环境禁用 PowerShell 的反馈，需要另起 spec 处理安装器脚本整体替代方案。

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| Windows Script Host 被禁用 | 不受影响，因为不再调用 `wscript.exe` |
| VBScript FoD 未安装 | 不受影响，因为不再生成 `.vbs` |
| PowerShell 启动失败 | `installReadyUpdate()` 返回失败，app 不退出 |
| PowerShell 已启动但脚本内部失败 | 写入 `%TEMP%\lobsterai-update-<ts>.log`，现有 UI 可能已退出；这是当前架构限制，可通过日志诊断 |
| 当前 app 120 秒内未退出 | 保留现有等待上限逻辑，等待结束后继续启动安装器 |
| 安装器路径包含空格/中文 | PowerShell 脚本内继续使用 `psEscape()`，入口用参数数组 |
| 旧版本遗留 `.vbs` 临时文件 | 不需要专门清理；新版本不再创建即可 |
| 多次点击立即更新 | 现有 `AppUpdateStatus.Installing` 状态应避免重复进入；本次不改变状态机 |
| macOS 更新 | 不走 `installWindowsNsis()`，不受影响 |
| 更新 URL 不是直接 `.exe` | 仍走现有 `canPredownload()` / 打开下载页逻辑，不受影响 |

## 6. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/main/libs/appUpdateInstaller.ts` | 删除 VBS launcher，改为隐藏 detached PowerShell launcher |
| `src/main/libs/appUpdateInstaller.test.ts` | 可选新增，覆盖 Windows launcher 参数构造和启动失败行为 |
| `specs/bugfixes/windows-update-vbscript-deprecation/2026-05-26-windows-update-vbscript-deprecation-fix-design.md` | 本设计文档 |

预期不需要改动：

- `src/main/libs/appUpdateCoordinator.ts`
- `src/renderer/components/update/AppUpdateModal.tsx`
- `src/renderer/services/i18n.ts`
- `scripts/nsis-installer.nsh`
- `electron-builder.json`

## 7. 测试计划

### 7.1 单元测试

如果抽出 helper，建议覆盖：

1. Windows launcher 参数包含 `-NoProfile`、`-ExecutionPolicy Bypass`、`-WindowStyle Hidden`、`-File <scriptPath>`。
2. launcher options 包含 `detached: true`、`stdio: 'ignore'`、`windowsHide: true`。
3. `spawn` 触发 `spawn` 事件后 resolve，并调用 `unref()`。
4. `spawn` 同步失败或触发 `error` 后 reject。
5. `installWindowsNsis()` 不写 `.vbs` 文件，不调用 `wscript.exe`。

### 7.2 静态检查

运行：

```bash
rg "wscript|cscript|\\.vbs|VBScript" src/main/libs/appUpdateInstaller.ts
```

期望：没有运行时依赖命中。

运行：

```bash
npm run compile:electron
```

期望：Electron main process 编译通过。

### 7.3 Windows 手动验证

在 Windows 11 24H2 或已禁用 VBScript FoD 的环境验证：

1. 准备一个可检测到新版本的 智码 GLM Code build。
2. 等待或手动触发更新下载。
3. 点击立即更新。
4. 确认不会出现 Windows 兼容性助手的 `Wscript.exe VBScript` 提示。
5. 确认不会出现 Windows Script Host 的 `.vbs` 错误。
6. 确认 `%TEMP%` 下没有新生成的 `lobsterai-update-<ts>.vbs`。
7. 确认 `%TEMP%\lobsterai-update-<ts>.ps1` 和 `.log` 存在。
8. 确认 智码 GLM Code 退出后 NSIS 安装器正常出现。
9. 完成安装后确认桌面快捷方式、开始菜单、安装后运行行为不回退。

补充验证：

1. Windows 用户名包含中文或空格。
2. 安装目录包含空格。
3. 从 persisted ready update 状态点击安装。
4. 模拟 PowerShell 启动失败，确认 app 不退出且 UI 进入安装失败。

## 8. 验收标准

- [ ] `installWindowsNsis()` 不再创建 `.vbs` 文件。
- [ ] Windows 更新安装流程不再调用 `wscript.exe` 或 `cscript.exe`。
- [ ] Windows 11 24H2 禁用 VBScript 时，点击立即更新不会弹兼容性助手或 Windows Script Host 错误。
- [ ] PowerShell 等待脚本隐藏执行，不出现控制台闪窗。
- [ ] 智码 GLM Code 当前进程退出后，NSIS 安装器正常出现。
- [ ] 安装器仍以正常交互 UI 运行，不变为静默安装。
- [ ] 安装完成后的快捷方式、开始菜单和安装后运行行为不回退。
- [ ] launcher 启动失败时 app 不提前退出，更新状态进入安装失败。
- [ ] macOS 更新流程不受影响。

## 9. 后续迭代

P1 可以考虑将 Windows update launcher 从 PowerShell 脚本升级为一个很小的 signed native helper：

1. helper 接收 app PID、installer path、log path。
2. helper 等待 PID 退出后 ShellExecute 安装器。
3. helper 随应用签名和打包，避免脚本执行策略影响。

但 P1 会引入新的二进制构建、签名、杀毒误报和跨版本兼容成本，不适合本次最小修复。
