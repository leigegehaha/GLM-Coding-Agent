# MCP 配置变更导致 OpenClaw Gateway 对话超时修复设计文档

## 1. 概述

### 1.1 问题

用户反馈：只要开启 MCP 后，在 Cowork 对话区发送消息，就稳定触发 OpenClaw gateway 相关超时。界面可能出现：

```text
OpenClaw gateway client connect timeout after 60000ms.
```

日志中同一类问题也表现为：

```text
gateway request timeout for sessions.patch
```

这两个错误发生的阶段不同：

| 表现 | 发生阶段 | 直接含义 |
|------|----------|----------|
| `OpenClaw gateway client connect timeout after 60000ms` | gateway client 等待 WebSocket `hello-ok` | 本地 gateway 可启动但客户端握手未完成 |
| `gateway request timeout for sessions.patch` | `chat.send` 前同步 session model | gateway client 已握手，但 session RPC 30 秒未返回 |

它们的共同根因是：MCP 开启或切换后，OpenClaw gateway 正处于 MCP 配置 reload/restart 窗口，智码 GLM Code 仍然允许用户立即发起对话，导致握手或关键 session RPC 卡住。

### 1.2 根因

智码 GLM Code 与 OpenClaw 对 MCP 配置变更的处理语义不一致。

当前 智码 GLM Code 侧 MCP handler 在 create/update/delete/toggle/retry 时调用：

```typescript
syncOpenClawConfig({ reason });
```

没有设置 `restartGatewayIfRunning`。`syncOpenClawConfig()` 当前 hard restart 判断只看：

- secret env vars 是否变化
- bindings 是否变化
- 调用方是否显式传入 `restartGatewayIfRunning: true`

因此 MCP 配置变化会被 智码 GLM Code 判断为：

```text
NO RESTART, hot-reload only
```

但 OpenClaw gateway 侧检测到同一个配置变化后，会认为 MCP 变更需要 gateway restart：

```text
[reload] config change requires gateway restart (mcp) — deferring until 7 task run(s) complete
```

也就是说：

1. 智码 GLM Code 把 MCP 配置写入 `openclaw.json` 后认为可以热加载。
2. OpenClaw runtime 认为 `mcp` 变更需要重启，并进入 reload/restart pending 状态。
3. 用户立即发起 Cowork 对话。
4. 智码 GLM Code 开始 `ensureGatewayClientReady()`、`sessions.patch`、`chat.send` 前置流程。
5. gateway 正在处理 MCP reload/restart 或处于 pending 状态，关键 RPC 无法及时返回。
6. 最终表现为 60 秒 gateway client connect timeout 或 30 秒 `sessions.patch` timeout。

### 1.3 日志证据

用户复现路径对应的关键时间线：

```text
11:17:06 MCP server "Tavily" starts managed launch resolution
11:17:09 MCP server "Context7" starts managed launch resolution
11:17:42 syncOpenClawConfig START reason=mcp-launch-ready:Tavily
11:17:42 OpenClawConfigSync mcp.servers: 1 server(s)
11:17:42 NO RESTART, hot-reload only
11:17:42 syncOpenClawConfig START reason=mcp-launch-manual-retry
11:17:43 syncOpenClawConfig START reason=mcp-launch-ready:Context7
11:17:43 OpenClawConfigSync mcp.servers: 2 server(s)
11:17:43 NO RESTART, hot-reload only
11:17:44 OpenClaw reload: config change requires gateway restart (mcp) — deferring until 7 task run(s) complete
```

随后用户切换 MCP 并发起对话：

```text
11:20:07 syncOpenClawConfig START reason=mcp-server-toggled
11:20:07 OpenClawConfigSync mcp.servers: 1 server(s)
11:20:08 NO RESTART, hot-reload only
11:20:20 GatewayClient onHelloOk — handshake succeeded
11:20:20 sessions.patch started before chat.send
11:20:25 OpenClaw reload: config change detected (meta.lastTouchedAt, mcp.servers.Tavily)
11:20:45 sessions.list timed out
11:20:50 sessions.patch failed after 30005ms
11:20:50 Cowork session error: gateway request timeout for sessions.patch
```

这说明失败不是模型供应商没有响应，也不是前端渲染问题，而是消息发送前 OpenClaw gateway 的本地 RPC 已经不可用或严重延迟。

### 1.4 非根因

- 不是 Qwen 模型接口直接超时。失败发生在 `chat.send` 之前。
- 不是 MCP npm 包解析慢本身直接阻塞了这次 `sessions.patch`。解析在 11:17 已完成；11:20 的失败发生在配置写入后 OpenClaw reload/restart 语义不一致阶段。
- 不是单纯把 timeout 调大就能解决。调大只会让用户在不稳定窗口等待更久。
- 不是本地端口完全不可连。11:20 日志中 gateway client 已经完成 `hello-ok`。

## 2. 用户场景

### 场景 A：用户开启 MCP 后立即发起对话

**Given** 用户在 MCP 管理页启用一个 MCP server
**And** OpenClaw gateway 当前正在运行
**When** 用户立即回到 Cowork 对话区发送消息
**Then** 智码 GLM Code 应等待 MCP 配置同步和 gateway restart/reconnect 完成
**And** 不应让消息进入 `sessions.patch` 后再 30 秒超时。

### 场景 B：MCP 启动解析完成后触发配置同步

**Given** npx MCP managed launch resolution 从 `installing` 变为 `ready`
**When** 智码 GLM Code 将优化后的 MCP 启动命令写入 `openclaw.json`
**Then** 该变更应按 OpenClaw gateway restart 语义处理
**And** Cowork 新 turn 应等待 gateway 达到可用状态。

### 场景 C：Gateway 正在执行已有任务

**Given** OpenClaw gateway 存在 active task run
**When** MCP 配置变化需要 restart
**Then** restart 应延迟到 active workload 结束
**And** 新的 Cowork turn 应看到明确的 pending 状态，而不是继续向 gateway 发送关键 RPC。

### 场景 D：Gateway client 握手被 restart 打断

**Given** 智码 GLM Code 正在等待 gateway client `hello-ok`
**When** MCP 配置变化触发 gateway restart 或连接关闭
**Then** 旧握手等待应立即失败或切换到新 gateway 的重连流程
**And** 不应无信息地等待 60 秒后报 connect timeout。

## 3. 功能需求

### FR-1：MCP 配置变化必须表达 restart impact

`OpenClawConfigSync.sync()` 需要返回足够的变更语义，至少能让主流程判断是否包含 MCP 相关变化。

建议扩展结果：

```typescript
type OpenClawConfigSyncResult = {
  ok: boolean;
  changed: boolean;
  configPath: string;
  error?: string;
  agentsMdWarning?: string;
  bindingsChanged?: boolean;
  changedTopLevelKeys?: string[];
  restartImpact?: OpenClawConfigImpact;
};
```

当 `changedTopLevelKeys` 包含 `mcp`，或具体变更路径包含 `mcp.servers.*` 时，`restartImpact` 应为 `Restart`。

### FR-2：MCP handler 不能 fire-and-forget 后立即放行对话

当前 MCP handler 通过 `syncMcpConfig()` fire-and-forget 触发配置同步。用户可以在配置同步、OpenClaw reload 或 restart 未完成时立即发起对话。

需要引入 gateway config apply barrier：

```typescript
type GatewayConfigApplyState = {
  pending: boolean;
  reason: string;
  startedAt: number;
  restartRequired: boolean;
  promise: Promise<void> | null;
};
```

Cowork 启动路径必须在以下操作前等待该 barrier：

- `ensureGatewayClientReady()`
- `sessions.patch`
- `chat.send`

### FR-3：MCP 变更应由 智码 GLM Code 主动执行 hard restart

对于 MCP create/update/delete/toggle/launch-ready/retry 等导致的 `mcp` 配置变化，智码 GLM Code 应主动进入已有 hard restart 流程，而不是依赖 OpenClaw 自己在 runtime 内部检测 reload。

期望行为：

1. 写入 `openclaw.json`。
2. 判断变更包含 `mcp`。
3. 如果 gateway running 且无 active workload，执行 hard restart。
4. 如果有 active workload，进入 智码 GLM Code 自己的 deferred restart 队列。
5. restart 完成后重新建立 gateway client。

这样可以避免两套状态机同时存在：

- 智码 GLM Code 认为 hot reload 完成
- OpenClaw 认为 restart deferred

### FR-4：Cowork 发送路径应识别 gateway restart pending

`ensureOpenClawRunningForCowork()` 当前在 gateway phase 为 `running` 时会直接返回，不会等待正在进行的 config sync 或 deferred restart。

需要增加：

1. 等待 pending config sync。
2. 如果 pending sync 判定需要 restart，等待 restart 完成。
3. 如果 restart 因 active workload deferred，返回明确错误或 UI 状态。
4. restart 完成后再进入 `connectGatewayIfNeeded()`。

### FR-5：Gateway client 握手前 close 不能只等待 60 秒

当前 gateway client 在 `onClose` 且 `settled=false` 时，会记录“connection closed before handshake, waiting for auto-reconnect”，最终依赖 60 秒 timeout。

当 close 原因来自 智码 GLM Code 主动 hard restart 或 MCP config apply barrier 时，应立即取消旧 `gatewayReadyPromise`，并在新 gateway ready 后创建新的 client。

期望规则：

| close 场景 | 处理方式 |
|------------|----------|
| 普通网络抖动 | 允许 auto reconnect |
| 智码 GLM Code 主动 restart | reject 旧 ready promise，并等待新 gateway |
| MCP config apply barrier active | reject 或挂接到 barrier 后重新建连 |
| token/connection info 变化 | 丢弃旧 client，使用新 connection info |

### FR-6：`sessions.patch` 超时前需要避开 reload 窗口

`sessions.patch` 是 `chat.send` 前的关键 RPC。进入该 RPC 前需要确认：

- 没有 pending MCP config sync。
- 没有 pending gateway restart。
- gateway client 最近一次 `hello-ok` 发生在当前 gateway generation。
- 当前 gateway generation 不早于最近一次 MCP config apply generation。

建议维护 gateway generation：

```typescript
type GatewayGenerationState = {
  generation: number;
  lastRestartReason?: string;
  lastReadyAt?: number;
  lastMcpConfigAppliedAt?: number;
};
```

### FR-7：用户可见错误要区分“正在应用 MCP 配置”和“gateway RPC 超时”

如果用户在 MCP 配置应用期间发起对话，应优先展示明确状态：

```text
OpenClaw 正在应用 MCP 配置，请稍后重试。
```

只有在 gateway 已经 ready 且无 pending config apply 时，才显示底层 RPC timeout。

日志仍需保留原始错误：

```text
gateway request timeout for sessions.patch
OpenClaw gateway client connect timeout after 60000ms
```

## 4. 实现方案

### 4.1 扩展 OpenClaw 配置同步结果

涉及文件：

- `src/main/libs/openclawConfigSync.ts`
- `src/main/main.ts`

`OpenClawConfigSync.sync()` 当前已经在日志中计算 top-level changed keys：

```text
top-level changed keys: mcp,meta
```

需要把这份信息作为结构化结果返回，而不是只写日志。主流程根据结果判断：

```typescript
const mcpChanged = syncResult.changedTopLevelKeys?.includes('mcp') === true;
const needsHardRestart =
  secretEnvVarsChanged ||
  syncResult.bindingsChanged === true ||
  syncResult.restartImpact === OpenClawConfigImpact.Restart ||
  options.restartGatewayIfRunning === true;
```

MCP 变化的 restart 语义应集中定义，避免各调用方靠 reason 字符串推断。

### 4.2 串行化 config sync 与 gateway restart

涉及文件：

- `src/main/main.ts`
- `src/main/ipcHandlers/mcp/handlers.ts`
- `src/main/mcp/mcpRuntime.ts`

在主进程维护一个配置应用锁：

```typescript
let openClawConfigApplyPromise: Promise<void> | null = null;
let openClawConfigApplyState: GatewayConfigApplyState | null = null;
```

所有 `syncOpenClawConfig()` 调用进入同一个串行队列，避免 MCP launch-ready、manual-retry、toggle 在数秒内反复写配置并触发多轮 reload 判断。

MCP handler 仍可以快速返回 UI 更新，但必须将 pending barrier 暴露给 Cowork 启动路径。Cowork 发送前需要等待 barrier 或得到明确的 pending 错误。

### 4.3 MCP 调用方传递语义，而不是隐式 hot reload

MCP 相关调用应传递配置影响类型。

建议将 `syncOpenClawConfig` options 扩展为：

```typescript
type SyncOpenClawConfigOptions = {
  reason: string;
  restartGatewayIfRunning?: boolean;
  expectedImpact?: OpenClawConfigImpact;
};
```

MCP create/update/delete/toggle/retry/launch-ready 调用传：

```typescript
expectedImpact: OpenClawConfigImpact.Restart
```

即使最终文件内容没有变化，也不会触发 restart；只有实际 `mcp` 变化时才进入 restart。

### 4.4 Cowork 启动等待 gateway config barrier

涉及文件：

- `src/main/main.ts`
- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`

在以下路径前加入等待：

- `ensureOpenClawRunningForCowork()`
- `openClawRuntimeAdapter.connectGatewayIfNeeded()`
- `openClawRuntimeAdapter.startSession()` / `continueSession()` 进入 `sessions.patch` 前

建议行为：

1. 如果 pending barrier 可在合理时间内完成，等待完成。
2. 如果 barrier 是 deferred restart 且 active workload 未结束，返回明确错误。
3. 如果 barrier 失败，返回 config apply 失败错误，不继续 `sessions.patch`。

### 4.5 重置 gateway client 与 session RPC 降级状态

涉及文件：

- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`

当 hard restart 开始时：

1. 调用 `disconnectGatewayClient()`。
2. reject 或取消当前未完成的 `gatewayReadyPromise`。
3. 清理 gateway RPC degraded 状态。
4. 清理 session model patch confirmed cache，避免新 gateway 使用旧确认状态。
5. restart 完成后按新 generation 创建 gateway client。

### 4.6 日志与诊断

需要新增关键日志，便于确认修复是否生效：

```text
[OpenClawConfigApply] queued config sync reason=mcp-server-toggled impact=restart
[OpenClawConfigApply] mcp config changed, hard restart required
[OpenClawConfigApply] waiting for gateway restart before cowork turn
[OpenClawConfigApply] gateway restart completed, generation=12
[OpenClawRuntime] sessions.patch skipped until config apply barrier completed
```

日志必须是英文自然语句，遵守主进程 logging 规范。

## 5. 边界情况

| 场景 | 处理方式 |
|------|----------|
| MCP toggle 后配置内容未变化 | 不重启 gateway，只完成 barrier |
| 多个 MCP launch-ready 连续触发 | 合并或串行执行 config sync，最多触发一次必要 restart |
| MCP 解析仍在 installing | 暂不写入该 server，解析完成后再次进入 config apply |
| Gateway 有 active task run | deferred restart；新 Cowork turn 返回 pending 状态或等待到上限 |
| Gateway client 正在等待 `hello-ok` | restart 时取消旧等待，避免 60 秒 timeout |
| `sessions.patch` 已经发出后 gateway reload | 记录 RPC timeout，并将 gateway 标记 degraded；后续 turn 先等待 barrier |
| 用户手动重启 gateway | 清理 pending barrier 和旧 gateway client，按新 generation 建连 |
| OpenClaw reload 仍自行检测到 mcp restart | 智码 GLM Code 日志应能显示是否漏判 MCP restart impact |

## 6. 涉及文件

- `src/main/ipcHandlers/mcp/handlers.ts`
- `src/main/mcp/mcpRuntime.ts`
- `src/main/main.ts`
- `src/main/libs/openclawConfigSync.ts`
- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
- `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts`
- `src/main/libs/openclawConfigSync.runtime.test.ts`
- `src/shared/mcp/constants.ts`
- `src/renderer/services/mcp.ts`
- `src/renderer/components/mcp/McpManager.tsx`
- `src/renderer/services/i18n.ts`

## 7. 验收标准

- 启用、停用、重试 MCP 后，日志中不再出现 智码 GLM Code 判断 `NO RESTART, hot-reload only` 但 OpenClaw 随后输出 `config change requires gateway restart (mcp)` 的矛盾状态。
- 用户启用 MCP 后立即发起 Cowork 对话，不再出现 `OpenClaw gateway client connect timeout after 60000ms`。
- 用户启用 MCP 后立即发起 Cowork 对话，不再因为 `model sync before chat.send` 阶段的 `sessions.patch` timeout 直接失败。
- MCP launch-ready 连续触发时，配置同步被串行化或合并，不会在 1 秒内反复写入 `mcp.servers` 并触发多次 reload 判断。
- Gateway 有 active workload 时，MCP restart 被明确 deferred；新 Cowork turn 不进入 `sessions.patch`，而是等待或返回可理解的 pending 状态。
- Gateway restart 后，旧 gateway client ready promise 被取消或重建，不会把旧连接的 pre-handshake close 表现成 60 秒 timeout。
- `sessions.patch` 只在 gateway config apply barrier 完成、gateway generation ready 后执行。
- MCP 配置内容未变化时不触发无意义 restart。
- 相关新增日志使用英文、自然句子，并带有可定位的模块标签。
- `npm test -- openclawRuntimeAdapter` 通过。
- `npm test -- openclawConfigSync` 通过。
- `npm run lint` 通过。
