# 输入框切换模型触发 OpenClaw Gateway 重启修复设计文档

## 1. 概述

### 1.1 问题

用户只是在 Cowork 输入框里切换了一下模型，OpenClaw gateway 就被 智码 GLM Code 主进程主动重启。

日志中的关键时间线：

```text
2026-05-19T00:27:30.555+08:00 syncOpenClawConfig START reason=agent-updated restartIfRunning=false
2026-05-19T00:27:30.595+08:00 top-level changed keys: agents,meta
2026-05-19T00:27:31.248+08:00 [reload] config hot reload applied (agents.list)
2026-05-19T00:27:31.263+08:00 SECRET ENV VARS CHANGED!
2026-05-19T00:27:31.263+08:00 modified: LOBSTER_APIKEY_SERVER prev=... next=...
2026-05-19T00:27:31.263+08:00 needsHardRestart=true (envChanged=true bindingsChanged=false configChanged=true restartFlag=false)
2026-05-19T00:27:31.263+08:00 HARD RESTART EXECUTING. reason=agent-updated
2026-05-19T00:27:31.265+08:00 [gateway] signal SIGTERM received
```

从日志看，gateway 不是自行崩溃，而是 main 进程在配置同步后主动执行 `stopGateway()` + `startGateway()`。

### 1.2 根因

这次重启由两个链路叠加触发：

1. **输入框无 session 时切模型会持久化 Agent 默认模型**

   Cowork 输入框的模型选择器在没有当前 `sessionId` 时，会调用 `persistAgentModelSelection()`，进而调用 `agentService.updateAgent(agentId, { model })`。main 进程收到 `agents.update` 后会执行：

   ```typescript
   syncOpenClawConfig({
     reason: 'agent-updated',
     restartGatewayIfRunning: false,
   });
   ```

   这个同步本身只改了 `agents` 和 `meta`，gateway 已经通过 hot reload 应用了 `agents.list`，按设计不需要重启。

2. **未实际使用的 `LOBSTER_APIKEY_SERVER` 仍参与 secret env diff**

   `lobsterai-server` 当前已经通过 token proxy 供 OpenClaw 访问。`openclaw.json` 中该 provider 的配置在 token proxy 可用时使用：

   ```text
   baseUrl: http://127.0.0.1:<token-proxy-port>/v1
   apiKey: ${LOBSTER_PROXY_TOKEN}
   ```

   但 `resolveAllProviderApiKeys()` 仍把当前登录态 `accessToken` 收集为 `SERVER`，随后 `collectSecretEnvVars()` 注入 `LOBSTER_APIKEY_SERVER`。当登录 token 因 401 被动刷新或主动刷新发生变化后，下一次任意配置同步都会发现：

   ```text
   LOBSTER_APIKEY_SERVER prev != next
   ```

   `syncOpenClawConfig()` 当前把任何 secret env 变化都视为硬重启条件：

   ```typescript
   const needsHardRestart =
     secretEnvVarsChanged
     || syncResult.bindingsChanged
     || (syncResult.changed && options.restartGatewayIfRunning);
   ```

   因此，一个本可 hot reload 的 `agent-updated` 被升级成了 gateway hard restart。

核心问题不是模型切换本身，而是 **动态 token 已迁移到 token proxy 后，旧的 `LOBSTER_APIKEY_SERVER` 仍被当成 gateway 进程启动环境的一部分参与重启判断**。

## 2. 用户场景

### 场景 A: 首页输入框切换 Agent 默认模型

**Given** gateway 正在运行，当前没有正在编辑的 Cowork session
**When** 用户在输入框模型选择器里切换模型
**Then** Agent 默认模型被保存，OpenClaw 配置热更新 `agents.list`
**And** gateway 不应收到 `SIGTERM`
**And** 已连接的 IM/channel sidecar 不应因为切模型被中断

### 场景 B: 已有 session 中切换本次会话模型

**Given** 用户打开已有 Cowork session
**When** 用户在输入框模型选择器里切换模型
**Then** 只调用 OpenClaw session patch 更新当前 session 的 `model`
**And** 不触发 `agents.update`
**And** 不触发 gateway hard restart

### 场景 C: lobsterai-server accessToken 刷新

**Given** `lobsterai-server` 通过 token proxy 访问真实服务端
**When** 登录 accessToken 因主动刷新或 401 被动刷新发生变化
**Then** token proxy 使用最新 token 转发请求
**And** 不因为 `LOBSTER_APIKEY_SERVER` 变化重启 gateway

### 场景 D: 修改真实需要进程环境的 secret

**Given** 用户修改自定义 provider 的 API key 或 IM channel secret
**When** 配置同步发现 OpenClaw 实际引用的 secret 发生变化
**Then** gateway 可以按现有规则 hard restart，以便新环境变量生效

## 3. 功能需求

### FR-1: token proxy 可用时不注入动态 `LOBSTER_APIKEY_SERVER`

当 `getOpenClawTokenProxyPort()` 可用时，`lobsterai-server` provider 的 OpenClaw 配置使用 `${LOBSTER_PROXY_TOKEN}`，不再引用 `${LOBSTER_APIKEY_SERVER}`。

此时 `collectSecretEnvVars()` 不应收集当前登录 accessToken 到 `LOBSTER_APIKEY_SERVER`，避免 rolling token 成为 gateway 重启条件。

### FR-2: 保留 token proxy 不可用时的兼容路径

如果 token proxy 未启动或不可用，`lobsterai-server` 仍可回退到旧路径：

```text
apiKey: ${LOBSTER_APIKEY_SERVER}
```

只有这种情况下，才需要把 `accessToken` 作为 `LOBSTER_APIKEY_SERVER` 注入 gateway 环境，并允许它参与 hard restart 判断。

### FR-3: secret env diff 只考虑当前配置实际引用的变量

硬重启判断应避免被未引用的历史 env var 影响。

推荐在 `syncOpenClawConfig()` 中读取当前 `openclaw.json`，扫描 `${VAR_NAME}` 占位符，过滤 `collectSecretEnvVars()` 的比较集合：

```text
referencedEnvVars = scanEnvPlaceholders(openclaw.json)
effectiveNextEnv = pick(nextSecretEnvVars, referencedEnvVars)
effectivePrevEnv = pick(prevSecretEnvVars, referencedEnvVars)
secretEnvVarsChanged = effectiveNextEnv != effectivePrevEnv
```

这样可以覆盖两类问题：

1. `LOBSTER_APIKEY_SERVER` 这类已迁移但仍残留在收集逻辑里的变量
2. 未来其他被移除或迁移的 secret env，不再误触发重启

### FR-4: token 刷新入口保持统一

当前主动刷新路径 `refreshOnce()` 会在刷新后调用 `syncOpenClawConfig({ reason: 'token-refresh:*', restartGatewayIfRunning: false })`，但 `fetchWithAuth()` 的 401 被动刷新只更新本地 token，不走统一入口。

建议把 401 被动刷新也改为复用 `refreshOnce('passive')` 或同等的单一刷新函数，避免：

1. rolling refresh token 被并发消费
2. OpenClaw env 快照与最新 token 状态错位
3. 后续任意配置同步背锅触发 hard restart

### FR-5: 明确输入框切模型的产品语义

本次日志中，输入框无 session 时切模型会保存 Agent 默认模型。这可以保留，但需要确认这是期望语义。

如果产品语义是“切换输入框模型只影响下一次会话，不修改 Agent 默认配置”，则应把无 session 时的切模型改为 draft/session-level selection，不调用 `agentService.updateAgent()`。

无论选择哪种产品语义，都不应因为该操作导致 gateway 重启。

## 4. 实现方案

### 4.1 去掉 token proxy 模式下的 `LOBSTER_APIKEY_SERVER`

涉及文件：

| 文件 | 变更 |
|---|---|
| `src/main/libs/claudeSettings.ts` | `resolveAllProviderApiKeys()` 在 token proxy 可用时不返回 `SERVER` |
| `src/main/libs/openclawConfigSync.ts` | 复用 `getOpenClawTokenProxyPort()` 判断是否需要 legacy server token env |
| `src/main/libs/openclawConfigSync.test.ts` | 增加 token proxy 模式下不注入 `LOBSTER_APIKEY_SERVER` 的单测 |

推荐逻辑：

```typescript
const shouldInjectServerApiKey = !getOpenClawTokenProxyPort();
if (shouldInjectServerApiKey && tokens?.accessToken && serverBaseUrl) {
  result.SERVER = tokens.accessToken;
}
```

注意 `claudeSettings.ts` 当前已经有注释说明 `lobsterai-server token is now managed by the token proxy`，但实现仍返回 `SERVER`。修复时应让代码与注释一致。

### 4.2 只比较实际引用的 secret env

涉及文件：

| 文件 | 变更 |
|---|---|
| `src/main/main.ts` | `syncOpenClawConfig()` 比较 env 前过滤未引用变量 |
| `src/main/libs/openclawConfigSync.ts` 或新 helper | 提供扫描 `${VAR}` 占位符的工具函数 |
| `src/main/libs/openclawConfigSync.test.ts` | 覆盖未引用 env 变化不触发 hard restart |

扫描范围建议包括整个 `openclaw.json` 序列化后的字符串。只识别安全格式：

```regexp
/\$\{([A-Z0-9_]+)\}/g
```

不要尝试解析任意 shell 语法，只处理 OpenClaw 配置中已有的 `${VAR}` 占位符。

### 4.3 统一 token refresh

涉及文件：

| 文件 | 变更 |
|---|---|
| `src/main/main.ts` | `fetchWithAuth()` 的 401 分支复用统一 refresh 函数 |
| `src/main/libs/openclawTokenProxy.ts` | 保持通过 token getter 动态取最新 accessToken |

推荐把 `refreshOnce()` 提升为 `fetchWithAuth()` 也能调用的共享闭包或 main 模块级 helper，保证主动刷新、手动刷新、401 被动刷新都走同一套去重逻辑。

### 4.4 保留 Agent 配置热更新

涉及文件：

| 文件 | 变更 |
|---|---|
| `src/main/main.ts` | 保持 `agent-updated` 默认 `restartGatewayIfRunning=false` |
| `src/renderer/components/cowork/CoworkPromptInput.tsx` | 暂不改 UI 语义，除非产品确认切模型不应保存 Agent |

`agent-updated` 的预期行为是：

```text
agents/model changed
  -> syncOpenClawConfig(reason=agent-updated, restartGatewayIfRunning=false)
  -> gateway hot reload applies agents.list
  -> no hard restart if no actually referenced secret changed
```

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| token proxy 正常运行 | 不注入 `LOBSTER_APIKEY_SERVER`，不因 accessToken rolling refresh 重启 |
| token proxy 启动失败 | 回退注入 `LOBSTER_APIKEY_SERVER`，保持旧路径可用 |
| 用户修改自定义 provider API key | 该 env 被 `openclaw.json` 引用，允许 hard restart |
| 用户新增启用 provider | 新 provider 的 env 被引用，允许 hard restart |
| 用户修改 Agent 模型、名称、prompt、skills | `agents.list` hot reload，不 hard restart |
| 用户修改 Agent working directory | 维持现有 `restartGatewayIfRunning=true` 策略，避免 workspace 相关状态漂移 |
| 历史 `openclaw.json` 仍引用 `${LOBSTER_APIKEY_SERVER}` | 自动把该变量纳入比较和注入，保持兼容 |
| `LOBSTER_PROVIDER_API_KEY` legacy var 变化 | 若配置不再引用它，不应触发 hard restart |

## 6. 验收标准

1. 输入框无 session 时切换模型，main 日志出现 `syncOpenClawConfig START reason=agent-updated`，但不出现 `HARD RESTART EXECUTING`。
2. 同一次操作中 gateway 日志不出现 `signal SIGTERM received`。
3. gateway 日志仍应出现配置 hot reload，例如 `config hot reload applied (agents.list)`。
4. accessToken 被动刷新或主动刷新后，再切换 Agent 模型，不因 `LOBSTER_APIKEY_SERVER` 变化触发重启。
5. 修改真实自定义 provider API key 时，仍能触发 hard restart，并且重启后请求使用新 key。
6. token proxy 不可用的回退场景下，`lobsterai-server` 仍能通过 `${LOBSTER_APIKEY_SERVER}` 工作。
7. 单测覆盖：
   - token proxy 模式不收集 `LOBSTER_APIKEY_SERVER`
   - 未引用 env 变化不触发 hard restart
   - 被引用 env 变化仍触发 hard restart
   - `agent-updated` 只变更 `agents` 时不 hard restart

## 7. 涉及文件

| 文件 | 说明 |
|---|---|
| `src/renderer/components/cowork/CoworkPromptInput.tsx` | 输入框模型选择的触发入口；本次可只作为验证链路，不必改 |
| `src/renderer/components/cowork/usePersistAgentModelSelection.ts` | 无 session 时持久化 Agent 模型的 hook |
| `src/main/main.ts` | `agents.update` IPC、`syncOpenClawConfig()`、token refresh 入口 |
| `src/main/libs/claudeSettings.ts` | `resolveAllProviderApiKeys()` 当前仍返回 `SERVER` accessToken |
| `src/main/libs/openclawConfigSync.ts` | `lobsterai-server` provider 已使用 token proxy 与 `${LOBSTER_PROXY_TOKEN}` |
| `src/main/libs/openclawTokenProxy.ts` | token proxy 动态获取最新登录 token |
| `src/main/libs/openclawConfigSync.test.ts` | 建议新增 env 收集和 hard restart 判定相关测试 |

## 8. 不在本次范围

1. 不改变 OpenClaw gateway 自身的 hot reload 行为。
2. 不清理所有历史 stale plugin entry；插件 stale entry 是独立问题，不是这次重启的直接原因。
3. 不强制改变输入框切模型是否保存 Agent 默认模型的产品语义；该点需要产品确认后再单独设计。
4. 不调整 IM/channel sidecar 的启动策略，只避免无必要的 gateway 重启。
