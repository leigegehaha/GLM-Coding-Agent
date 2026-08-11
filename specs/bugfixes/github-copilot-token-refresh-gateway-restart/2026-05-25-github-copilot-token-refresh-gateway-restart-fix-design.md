# GitHub Copilot Token 刷新触发 Gateway 重启修复设计文档

## 1. 概述

### 1.1 问题

用户未主动修改 OpenClaw、IM 或模型配置时，GitHub Copilot 的后台 token 刷新会引起 OpenClaw Gateway 硬重启。表现为 Gateway 收到 `SIGTERM`，随后 智码 GLM Code 主进程重新 fork gateway。

从日志看，本次重启不是 Gateway 崩溃，而是 智码 GLM Code 主进程主动执行：

```text
[CopilotTokenManager] refreshing Copilot API token...
[CopilotTokenManager] token refreshed, expires in 1799s
[GW-RESTART-DIAG] syncOpenClawConfig START reason=app-config-change restartIfRunning=true
[GW-RESTART-DIAG] sync() ok=true changed=false bindingsChanged=false
[GW-RESTART-DIAG] secretEnvVars unchanged
[GW-RESTART-DIAG] needsHardRestart=true (... restartFlag=true)
[GW-RESTART-DIAG] HARD RESTART EXECUTING
[gateway] signal SIGTERM received
```

`sync() changed=false` 和 `secretEnvVars unchanged` 说明 OpenClaw 配置文件与 Gateway 继承的 secret env 都没有真实变化；重启只由 `restartIfRunning=true` 推动。

### 1.2 根因

GitHub Copilot 的 token 生命周期被混入了持久配置生命周期：

1. `CopilotTokenManager` 在 main 进程中定时刷新短期 Copilot API token。
2. 刷新成功后，main 通过 `github-copilot:token-updated` IPC 广播 token 给 renderer。
3. `src/renderer/App.tsx` 监听该事件，并调用 `configService.updateConfig()` 把新 token 写回 `app_config.providers.github-copilot.apiKey`。
4. main 进程的 `store:set app_config` 看到 provider secret 变化，将其分类为需要 Gateway restart。
5. `syncOpenClawConfig()` 即使检测到 OpenClaw config/env 没变化，也因为调用方传入 `restartGatewayIfRunning: true` 执行硬重启。

关键边界是：Copilot API token 是短期运行时凭据，约 30 分钟刷新一次；它不应作为长期配置写入 `app_config`。OpenClaw Gateway 侧当前通过本地兼容代理访问 Copilot，配置里使用稳定的 `LOBSTER_PROXY_TOKEN`，并不依赖 `app_config.providers.github-copilot.apiKey` 中的短期 token。

### 1.3 范围

本次只解决 GitHub Copilot token 刷新导致 Gateway 重启的问题。

不在本次范围内：

- MiniMax OAuth 的 token 存储模型调整。
- OpenAI Codex OAuth 登录流程调整。
- 通用 provider secret impact 分类重构。
- IM、插件、系统代理等其它 Gateway restart 场景。

## 2. 用户场景

### 场景 1：GitHub Copilot token 自动刷新

**Given** 用户已登录 GitHub Copilot，OpenClaw Gateway 正在运行
**When** `CopilotTokenManager` 按计划刷新短期 Copilot API token
**Then** renderer 与本地 Copilot proxy 可以继续使用新 token，但不写 `app_config`，不触发 `app-config-change`，不重启 Gateway。

### 场景 2：用户首次登录 GitHub Copilot

**Given** 用户在设置页完成 GitHub Copilot 设备码登录
**When** 登录流程拿到 GitHub OAuth token 与首次 Copilot API token
**Then** 长期 GitHub OAuth token 按现有方式存储，provider 可启用，当前会话可立即使用 Copilot；是否需要保存 provider enabled 状态仍由设置页保存流程负责。

### 场景 3：用户退出 GitHub Copilot

**Given** 用户已登录 GitHub Copilot
**When** 用户在设置页点击退出登录
**Then** 清除 GitHub OAuth token 与运行时 Copilot token，禁用或清空 provider 本地状态；这是用户主动配置变更，可以走现有设置保存链路。

### 场景 4：Copilot 请求遇到 401/403 后刷新 token

**Given** Copilot 请求返回认证错误
**When** renderer 或 proxy 调用 `github-copilot:refresh-token` 进行按需刷新
**Then** 请求重试使用刷新后的 token；按需刷新不写 `app_config`，不触发 Gateway restart。

## 3. 功能需求

### FR-1：短期 Copilot API token 不得写入 `app_config`

`CopilotTokenManager` 自动刷新后的 token 只属于运行时状态。刷新成功后不得通过 `configService.updateConfig()` 写入：

```text
app_config.providers.github-copilot.apiKey
```

### FR-2：renderer 仍能获得最新 token

保留 `github-copilot:token-updated` IPC 广播，renderer 收到后可以更新内存态，例如：

- 当前页面的 GitHub Copilot provider runtime credential。
- `apiService` 或请求重试所需的临时 token。

但这个更新必须是内存级别，不触发 `localStore.setItem('app_config', ...)`。

### FR-3：OpenClaw Gateway 继续通过稳定代理访问 Copilot

OpenClaw config 中 GitHub Copilot provider 应继续使用本地兼容代理与稳定 token：

```text
provider: github-copilot / lobsterai-copilot
baseUrl: local proxy /v1/copilot
apiKey: ${LOBSTER_PROXY_TOKEN}
```

Gateway 不应因为 Copilot API token 轮换而重启。真正请求 Copilot 时，由本地 proxy 从 `CopilotTokenManager` 获取最新 token。

### FR-4：首次登录和退出登录仍可持久化稳定状态

本次修复不能破坏设置页中 GitHub Copilot 的登录状态显示与启用状态保存：

- GitHub OAuth token 继续存储在 `github_copilot_github_token`。
- provider 的 `enabled`、`models`、可展示状态可继续持久化。
- 短期 Copilot API token 不再作为 provider `apiKey` 的长期来源。

### FR-5：避免把其它 OAuth 方案混入本次修复

OpenAI Codex OAuth 与 MiniMax OAuth 现有行为不作为本次改动目标：

- OpenAI Codex OAuth 已经把 token 写入独立 auth 文件，`app_config` 只表达 `authType: oauth`。
- MiniMax OAuth 当前没有后台定时刷新并频繁写回 `app_config` 的链路。

本次只调整 GitHub Copilot 自动 token refresh 的持久化边界。

## 4. 实现方案

### 4.1 调整 renderer 的 Copilot token update 监听

当前 `App.tsx` 的监听逻辑会在收到 `github-copilot:token-updated` 后写回配置：

```typescript
void configService.updateConfig({
  providers: {
    ...currentConfig.providers,
    'github-copilot': {
      ...copilotProvider,
      apiKey: token,
      ...(baseUrl ? { baseUrl } : {}),
    },
  },
});
```

建议改为只更新运行时状态，不调用 `configService.updateConfig()`。

可选实现：

1. 给 `apiService` 增加一个专用方法，例如 `setProviderRuntimeCredential(provider, credential)`。
2. 或在 GitHub Copilot 请求路径上始终通过 main 进程 `github-copilot:refresh-token` / token manager 获取 token，而不是依赖 `app_config`。
3. 如果 renderer 需要立即用新 token 发普通 chat 请求，可只更新内存中的 provider runtime overlay，不写 local store。

### 4.2 保留 main 进程 token manager 作为唯一短期 token 来源

`src/main/libs/copilotTokenManager.ts` 继续负责：

- 持有当前短期 Copilot API token。
- 按过期时间主动刷新。
- 按需刷新认证失败的请求。
- 向 renderer 广播 token 更新。

它不负责，也不应间接导致，`app_config` 的 provider secret 更新。

### 4.3 保护 GitHub Copilot provider 的持久配置语义

GitHub Copilot provider 的持久配置应尽量只保存稳定信息：

```typescript
{
  enabled: boolean;
  baseUrl?: string; // 可选，只有用户显式改变稳定 endpoint 时保存
  models: ProviderModelConfig[];
}
```

`apiKey` 不再代表当前短期 Copilot API token。为兼容旧配置，可以在读取配置时忽略或迁移已有的 `providers.github-copilot.apiKey`：

- 第一阶段可以停止继续写入，保留旧字段不使用。
- 后续可在配置迁移中清理旧 token 字段，避免长期落盘短期 token。

### 4.4 不改变 OpenClaw provider 生成逻辑

`openclawConfigSync.ts` 中 GitHub Copilot provider 现有方向是合理的：

- `resolveRuntimeBaseUrl()` 指向本地 OpenAI-compatible proxy。
- `resolveApiKey()` 使用 `${LOBSTER_PROXY_TOKEN}`。

因此本次不需要让 OpenClaw config 直接感知 Copilot API token。

### 4.5 防御性检查

虽然根因应在 renderer 不写 `app_config` 处解决，但建议增加一个防御性回归检查：

- Copilot token refresh 不应触发 `store:set app_config`。
- 即便未来误触发 app config 写入，若 OpenClaw config/env 没变化，也不应因为 Copilot 短期 token 轮换执行 hard restart。

第二点可作为后续通用 provider secret impact 优化，不要求本次必须落地。

## 5. 边界情况

| 场景 | 处理方式 |
| --- | --- |
| renderer 未打开但 token 自动刷新 | main 进程 token manager 正常刷新；无 renderer 接收广播也不影响 proxy 使用 |
| 多窗口同时打开 | main 广播 token 更新；每个窗口只更新内存态，不写 `app_config` |
| token 刷新失败 | 保持现有 retry 与错误日志；不写配置，不重启 Gateway |
| Gateway 正在运行 Copilot 请求 | 请求通过本地 proxy 获取最新 token；token refresh 不要求 Gateway restart |
| 用户手动切换 GitHub Copilot provider 启用状态 | 这是稳定配置变更，可继续由设置页保存 `app_config` |
| 旧配置里已有 Copilot `apiKey` | 先停止继续写入；读取时不把该字段作为 OpenClaw Gateway env 变化依据 |

## 6. 涉及文件

### `src/renderer/App.tsx`

- 修改 `githubCopilot.onTokenUpdated` listener。
- 从“写入 `app_config`”改为“更新运行时 token 状态”。

### `src/renderer/services/api.ts`

- 如需 renderer 直接发 Copilot 请求，可增加或复用运行时 token 覆盖能力。
- 确保 Copilot 401/403 retry 后不把刷新 token 写入持久配置。

### `src/main/libs/copilotTokenManager.ts`

- 保留 token refresh、调度、广播能力。
- 不新增写 `app_config` 的逻辑。

### `src/main/libs/coworkOpenAICompatProxy.ts`

- 确认 GitHub Copilot proxy 请求始终从 `CopilotTokenManager` 获取当前 token。
- 不依赖 renderer 写入的 provider `apiKey`。

### `src/main/libs/openclawConfigSync.ts`

- 预期无需修改核心 provider 生成逻辑。
- 如发现历史 `apiKey` 仍被用于 Copilot env diff，应增加忽略或迁移策略。

### `src/main/libs/openclawConfigImpact.test.ts` 或新增相关测试

- 覆盖 Copilot token refresh 不应升级为 Gateway restart 的回归场景。

## 7. 验收标准

1. GitHub Copilot 自动 token refresh 后，日志中不出现由该刷新触发的：
   - `syncOpenClawConfig START reason=app-config-change`
   - `HARD RESTART EXECUTING`
   - gateway `signal SIGTERM received`
2. GitHub Copilot 请求在 token refresh 后仍能成功使用新 token。
3. GitHub Copilot 401/403 按需刷新仍可重试请求。
4. 设置页首次登录 GitHub Copilot、退出登录、启停 provider 的行为不回退。
5. OpenClaw Gateway 的 GitHub Copilot provider 仍使用本地 proxy 与 `${LOBSTER_PROXY_TOKEN}`。
6. 本次改动不影响 OpenAI Codex OAuth 和 MiniMax OAuth 现有流程。

## 8. 验证计划

### 单元测试

- 覆盖 `github-copilot:token-updated` 后不调用 `configService.updateConfig()` 的 renderer 行为，或覆盖等价的 runtime token overlay 行为。
- 覆盖 Copilot provider 的 OpenClaw config 仍输出 proxy base URL 与 `${LOBSTER_PROXY_TOKEN}`。

### 手动验证

1. 登录 GitHub Copilot。
2. 启动 OpenClaw Gateway。
3. 手动触发或等待 `CopilotTokenManager` refresh。
4. 确认 Gateway 没有收到 `SIGTERM`。
5. 使用 GitHub Copilot provider 发起一次请求，确认成功。
6. 在设置页退出登录再登录，确认 UI 状态与请求能力正常。
