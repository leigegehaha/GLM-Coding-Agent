# Windows 覆盖安装后微信登录态丢失修复 Spec

## 1. 概述

### 1.1 问题

用户反馈：Windows 覆盖安装 智码 GLM Code 后，打开“设置 → IM 机器人 → 微信”会显示连接失败，错误为 `not configured`，必须重新扫码后微信连接才恢复正常。

同一台机器上，飞书、钉钉、企业微信等其他 IM 渠道没有相同问题。覆盖安装后仍能读取原有配置并继续连接。

### 1.2 当前表现

用户侧表现：

1. 覆盖安装前微信已扫码连接成功。
2. 覆盖安装后，微信设置页仍能显示 Account ID。
3. 运行态显示连接失败，并展示 `not configured`。
4. 点击“重新扫码”后，连接恢复。

日志侧表现：

1. `openclaw-weixin` 插件正常加载，不是插件缺失。
2. OpenClaw gateway 正常启动，`channels.status` RPC 正常返回。
3. 微信 channel runtime 能看到账号 ID，但插件判定账号没有 token，因此 `configured=false`。

### 1.3 根因

根因是 Windows 安装脚本在每次覆盖安装时主动删除了微信插件的账号凭据目录。

当前 `scripts/nsis-installer.nsh` 中有一段微信专用清理逻辑：

```nsis
; ── Clean stale openclaw-weixin session data ──
DetailPrint "[Installer] Clearing stale Weixin session data"
nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -Command "\
  $$dirs = @(\
    (Join-Path $$env:USERPROFILE \".openclaw\openclaw-weixin\accounts\"),\
    (Join-Path $$env:APPDATA \"智码 GLM Code\openclaw\state\openclaw-weixin\accounts\")\
  );\
  foreach ($$d in $$dirs) {\
    if (Test-Path $$d) {\
      Remove-Item -Path $$d -Recurse -Force -ErrorAction SilentlyContinue;\
      Write-Output \"[Installer] Removed stale Weixin accounts: $$d\";\
    }\
  }"'
```

其中 `%APPDATA%\智码 GLM Code\openclaw\state\openclaw-weixin\accounts` 是 智码 GLM Code 管理的 OpenClaw 状态目录下的微信登录凭据目录。覆盖安装删除它后，本地 SQLite 里仍然保存 `weixin.accountId`，但插件读取不到对应账号 token，于是报 `not configured`。

### 1.4 为什么只有微信受影响

这不是 IM 配置整体丢失，而是微信渠道的登录态模型和 installer 清理逻辑叠加导致的问题。

飞书、钉钉、企业微信等渠道通常是配置型机器人：

1. 用户配置的是后台生成的稳定凭据，如 `appId`、`appSecret`、`botId`、`secret`。
2. 凭据保存在 智码 GLM Code 的 SQLite IM 配置中。
3. 启动或保存时，智码 GLM Code 将这些配置同步到 OpenClaw config 或 secret env。
4. 覆盖安装不会删除 SQLite，因此这些 IM 能重新生成运行时配置并连接。

微信 `openclaw-weixin` 是扫码登录态型账号：

1. 用户不输入稳定后台凭据。
2. 扫码后插件从微信 iLink 获取 `botToken`。
3. token 存在 `<OPENCLAW_STATE_DIR>/openclaw-weixin/accounts/{accountId}.json`。
4. 插件通过读取该 token 判断 `configured=true`。
5. 智码 GLM Code 本地 IM 配置只保存 `enabled`、`accountId`、`dmPolicy`、`allowFrom` 等控制配置，不保存真正的微信 token。

因此，installer 删除微信 accounts 目录等价于删除微信扫码登录态。飞书、钉钉、企业微信没有使用这个目录，也没有对应的 installer 删除逻辑，所以不受影响。

### 1.5 原清理逻辑的设计意图

从注释看，这段清理逻辑的初衷是解决旧微信 bot token 造成重新扫码被 iLink 服务拒绝的问题。

这个处理方向本身可以理解，但放在“每次覆盖安装”阶段风险过高：

1. 覆盖安装是正常升级路径，不应清除用户登录态。
2. 清理粒度是整个 accounts 目录，会影响所有已连接微信账号。
3. 清理发生在应用启动前，用户没有选择权，也无法恢复。
4. SQLite 里的 `accountId` 被保留，造成“看似配置仍在，实际 token 已丢”的不一致状态。

## 2. 用户场景

### 场景 A: 已连接微信后覆盖安装

**Given** 用户已经在 智码 GLM Code 中扫码连接微信
**When** 用户安装新版本覆盖旧版本
**Then** 微信登录态必须保留，打开 IM 设置时不应显示 `not configured`。

### 场景 B: 覆盖安装后启动 OpenClaw gateway

**Given** 用户的 `%APPDATA%\智码 GLM Code\openclaw\state\openclaw-weixin\accounts` 中存在微信 token 文件
**When** 覆盖安装完成并启动 智码 GLM Code
**Then** OpenClaw gateway 应能从原状态目录读取 token，并让 `openclaw-weixin` 账号保持 `configured=true`。

### 场景 C: 用户主动重新扫码

**Given** 用户点击“重新扫码”
**When** 新扫码流程确实需要清理旧账号冲突
**Then** 系统可以在扫码流程中做定向清理或替换，但不能在覆盖安装阶段无条件删除所有账号。

### 场景 D: 旧版本已经删除过 token

**Given** 用户已经安装过包含清理逻辑的版本，微信 token 已被删除
**When** 用户升级到修复后的版本
**Then** 如果 app-managed 状态目录中没有可用 token，系统无法凭 `accountId` 恢复微信登录态，应提示用户重新扫码一次。

## 3. 功能需求

### FR-1: 覆盖安装不得删除 app-managed 微信账号凭据

Windows installer 不得删除：

```text
%APPDATA%\智码 GLM Code\openclaw\state\openclaw-weixin\accounts
```

该目录属于用户数据，不属于安装产物。

### FR-2: 不再在安装阶段做微信登录态修复

安装阶段只负责替换应用二进制和资源文件，不负责修复微信登录冲突。

如果存在旧 token 冲突，应由应用内流程处理：

1. 用户点击重新扫码。
2. 扫码 API 返回“已连接过此 OpenClaw”或类似冲突状态。
3. 应用根据明确的错误类型执行定向恢复、覆盖或引导用户确认。

### FR-3: 不读取 standalone OpenClaw 状态目录

智码 GLM Code 管理的 OpenClaw runtime 启动时会显式设置：

```text
OPENCLAW_STATE_DIR=%APPDATA%\智码 GLM Code\openclaw\state
```

因此 智码 GLM Code 的微信登录态边界应限定在：

```text
%APPDATA%\智码 GLM Code\openclaw\state\openclaw-weixin\accounts
```

修复方案不应主动读取、复制或删除：

```text
%USERPROFILE%\.openclaw\openclaw-weixin\accounts
```

该目录属于 standalone OpenClaw 的默认状态目录。智码 GLM Code 读取它可能误用用户另一个 OpenClaw 实例的微信账号，造成账号串用、状态污染或安全边界不清。

当前 installer 中对 `%USERPROFILE%\.openclaw\openclaw-weixin\accounts` 的删除也应移除。移除理由不是为了迁移该目录，而是为了避免 智码 GLM Code installer 破坏 standalone OpenClaw 的用户数据。

### FR-4: 微信配置缺 token 时给出明确诊断

当本地配置存在 `weixin.enabled=true` 和 `weixin.accountId`，但 OpenClaw runtime 返回 `not configured` 或 `configured=false` 时，UI 不应只展示原始错误。

推荐提示：

```text
微信登录凭据缺失，请重新扫码连接。
```

这能区分“没有配置账号”和“账号 ID 还在但 token 丢失”。

### FR-5: 不影响其他 IM 渠道

修复不得改变飞书、钉钉、企业微信、QQ、POPO、NIM、邮箱等渠道的现有配置保存、启动和重启逻辑。

## 4. 实现方案

### 4.1 移除 installer 中的微信 accounts 删除逻辑

从 `scripts/nsis-installer.nsh` 删除“Clean stale openclaw-weixin session data”整段。

删除目标包括：

1. 对 `%USERPROFILE%\.openclaw\openclaw-weixin\accounts` 的 `Remove-Item`。
2. 对 `%APPDATA%\智码 GLM Code\openclaw\state\openclaw-weixin\accounts` 的 `Remove-Item`。
3. 对应的 `DetailPrint "[Installer] Clearing stale Weixin session data"`。

这是本问题的最小必要修复。

### 4.2 不做跨目录登录态恢复

本次修复不从 `%USERPROFILE%\.openclaw` 恢复微信 token。

原因：

1. 该目录不是 智码 GLM Code 管理的状态目录。
2. 用户可能同时安装 standalone OpenClaw，里面的微信 token 不一定属于 智码 GLM Code。
3. 自动复制 token 会让两个运行环境共享或串用同一微信登录态。
4. 对已经被旧 installer 删除的 智码 GLM Code token，如果 app-managed 目录中没有备份，无法安全自动恢复。

因此本次恢复策略是：

1. 修复 installer，停止继续删除 app-managed token。
2. 对已经丢失 token 的用户，给出明确提示，引导重新扫码。
3. 如后续确实需要迁移 standalone OpenClaw 状态，必须作为单独的用户显式导入流程设计，不能自动执行。

### 4.3 UI 诊断文案优化

在微信设置页已有 `shouldShowWeixinError` 分支下，识别 `not configured`。

当满足以下条件时：

1. `weixinOpenClawConfig.enabled === true`
2. `weixinAccountId` 非空
3. `weixinLastError` 包含 `not configured`

展示本地化文案：

```text
微信登录凭据缺失，请重新扫码连接。
```

英文：

```text
WeChat login credentials are missing. Please scan the QR code again.
```

### 4.4 将清理行为迁移到扫码修复流程

如果仍需处理旧 token 引起的扫码冲突，不应在 installer 中清理。

推荐后续单独实现：

1. `web.login.start` 或 `web.login.wait` 返回明确冲突状态。
2. 主进程根据冲突账号 ID 定向清理单个账号文件。
3. 重新发起扫码或提示用户确认。
4. 日志记录清理原因、账号 ID 和清理路径。

这部分不是本次最小修复的必要条件，可以作为后续增强。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 用户已被旧 installer 删除 token | 无法从 `accountId` 反推 token；如果 app-managed 状态目录中没有可用 token，只能提示重新扫码 |
| app-managed token 存在 | 覆盖安装后必须保留，不做任何删除 |
| `%USERPROFILE%\.openclaw` 中存在微信 token | 不读取、不复制，避免和 standalone OpenClaw 状态冲突 |
| token 文件损坏或 JSON 解析失败 | 不迁移，提示重新扫码 |
| 用户主动关闭微信渠道 | 不做恢复，不展示 token 缺失错误 |
| 多微信账号 | 不批量删除；覆盖安装必须保留所有 app-managed account files |
| 重新扫码返回已连接过此 OpenClaw | 走扫码流程内的定向处理，不依赖 installer 清理 |

## 6. 涉及文件

- `scripts/nsis-installer.nsh`：移除覆盖安装时的微信 accounts 删除逻辑。
- `src/main/libs/openclawEngineManager.ts`：提供 智码 GLM Code app-managed OpenClaw stateDir，明确状态目录边界。
- `src/main/im/imGatewayManager.ts`：微信状态查询、扫码、token 缺失诊断的主入口。
- `src/main/im/imStore.ts`：读取 `weixin.accountId` 和 `enabled`。
- `src/renderer/components/im/IMSettings.tsx`：优化 `not configured` 的用户可见文案。
- `src/renderer/services/i18n.ts`：新增中英文文案。

## 7. 验收标准

### 7.1 覆盖安装保留微信登录态

1. 在 Windows 上安装旧版本或当前版本。
2. 打开 IM 设置，扫码连接微信。
3. 确认 `%APPDATA%\智码 GLM Code\openclaw\state\openclaw-weixin\accounts` 下存在账号 token 文件。
4. 覆盖安装修复后的版本。
5. 启动 智码 GLM Code。
6. 打开“设置 → IM 机器人 → 微信”。
7. 预期：不显示 `not configured`，微信仍为已连接或能自动恢复连接。

### 7.2 飞书等其他 IM 不回退

1. 配置飞书、钉钉或企业微信。
2. 覆盖安装修复后的版本。
3. 启动 智码 GLM Code。
4. 预期：原有 IM 配置仍在，连接行为与修复前一致。

### 7.3 已丢失 token 的用户得到明确提示

1. 手动模拟只保留 `weixin.accountId`，删除 app-managed token 文件。
2. 启动 智码 GLM Code 并打开微信设置。
3. 预期：UI 提示微信登录凭据缺失，需要重新扫码，而不是只展示原始 `not configured`。

### 7.4 installer 不再输出微信账号清理日志

覆盖安装日志中不应再出现：

```text
[Installer] Clearing stale Weixin session data
[Installer] Removed stale Weixin accounts
```

## 8. 不做事项

1. 不把微信 bot token 迁入 SQLite。微信插件已经有自己的多账号和状态持久化模型，迁移成本和兼容风险较高。
2. 不在 installer 中做任何用户登录态清理。
3. 不尝试从 `accountId` 重新生成 token。token 只能通过扫码或已有 token 文件恢复。
4. 不改变飞书、钉钉、企业微信等配置型 IM 的存储模型。

## 9. 推荐实施顺序

1. 先移除 installer 删除微信 accounts 的逻辑，阻止后续覆盖安装继续破坏登录态。
2. 增加 UI 诊断文案，让已受影响用户能明确知道需要重新扫码。
3. 后续再把“旧 token 冲突清理”迁移到重新扫码流程中做定向处理。
