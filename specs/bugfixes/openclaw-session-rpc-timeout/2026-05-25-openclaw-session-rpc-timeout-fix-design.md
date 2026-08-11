# OpenClaw Session RPC 超时导致提问不响应修复设计文档

## 1. 概述

### 1.1 问题

用户最近几次在 Cowork 会话中追问时，界面表现为长时间不响应；最后一次直接返回：

```text
gateway request timeout for sessions.patch
```

从日志看，这次失败不是模型没有生成回复，而是 智码 GLM Code 在真正调用 `chat.send` 之前，先执行 OpenClaw `sessions.patch` 更新会话模型。该 RPC 在客户端默认 30 秒内没有返回，导致 `runTurn()` 直接进入 error，用户消息没有被发送给模型。

### 1.2 结论

直接失败链路：

1. 用户点击发送或继续会话。
2. `OpenClawRuntimeAdapter.runTurn()` 将本地 session 状态置为 `running`。
3. 发送 `chat.send` 前，`ensureSessionModelForTurn()` 调用 `sessions.patch` 以确保 OpenClaw 当前 session 使用本地选中的模型。
4. OpenClaw gateway 的 `sessions.patch` 请求超过 30 秒未返回。
5. 智码 GLM Code 抛出 `gateway request timeout for sessions.patch`。
6. 当前 turn 结束为 error，`chat.send` 没有执行。

系统性原因是 OpenClaw gateway 的 session 存储/RPC 路径已经处于拥塞状态，尤其是 `sessions.json.lock` 长时间持有后阻塞了 session 读写类 RPC。日志中同一阶段还有大量 `sessions.list` 上下文用量刷新超时，说明这不是单次 patch 偶发失败，而是 session RPC 队列整体被拖慢。

### 1.3 日志证据

关键时间线：

```text
18:08:43 sessions.patch 2772ms
18:09:38 sessions.patch 7435ms
18:10:41 sessions.patch 16777ms
18:14:14 session-write-lock held 26493ms
18:14:27 failed to patch the session model before chat.send
18:14:58 sessions.patch 51030ms
18:15:52 failed to patch the session model before chat.send
18:16:15 session-write-lock held 57907ms
18:16:29 sessions.patch 103583ms
18:16:36 failed to patch the session model before chat.send
```

直接错误：

```text
[OpenClawRuntime] failed to patch the session model before chat.send: Error: gateway request timeout for sessions.patch
[Cowork] session error: Error: gateway request timeout for sessions.patch
```

同时出现的非关键 RPC 超时：

```text
[OpenClawRuntime] targeted context usage refresh failed ... gateway request timeout for sessions.list
[OpenClawRuntime] recent context usage refresh failed ... gateway request timeout for sessions.list
```

OpenClaw 侧也记录了 session 写锁异常：

```text
[session-write-lock] releasing lock held for 57907ms (max=15000ms):
/Users/wangning/Library/Application Support/智码 GLM Code/openclaw/state/agents/main/sessions/sessions.json.lock
```

这说明需要解决的是“关键发送路径被 session 存储拥塞拖死”，而不是单纯把错误提示翻译得更友好。

### 1.4 非根因

以下现象不是本次问题的根因：

- 不是模型供应商没有返回内容。失败发生在 `chat.send` 之前。
- 不是 qwen3.6 Plus 图像能力或 lifecycle fallback 问题。本次错误集中在 OpenClaw gateway RPC 和 session 写锁。
- 不是前端消息渲染卡住。主进程已经收到并上报了 `sessions.patch` timeout。
- 不是只需要增大 timeout。日志中 `sessions.patch` 最长已经到 `103583ms`，增大 timeout 只会让用户等待更久。

## 2. 用户场景

### 场景 A：Gateway session 存储短暂变慢

**Given** OpenClaw gateway 仍然可连接
**And** `sessions.patch` 因 session 写锁或队列延迟短暂超过 30 秒
**When** 用户继续一个已有 Cowork 会话
**Then** 如果本地已确认当前模型与目标模型一致，应允许继续 `chat.send`
**And** 不应因为非必要的模型 patch 超时直接丢弃用户问题

### 场景 B：用户刚切换了 session 级模型

**Given** 用户刚在当前会话显式切换模型
**When** 发送下一轮消息前需要保证 OpenClaw session 使用新模型
**Then** `sessions.patch` 仍然是强一致步骤
**And** 如果 patch 失败，不能静默用旧模型发送

### 场景 C：上下文用量刷新大量并发

**Given** 多个 session 同时触发 context usage 刷新
**And** Gateway 已经出现 `sessions.list` timeout
**When** 用户发送新消息
**Then** 非关键 context usage 刷新应退避或合并
**And** 不能继续向 gateway 注入更多 `sessions.list` 压力

### 场景 D：Gateway RPC 健康度下降

**Given** 最近一段时间出现多个 `sessions.list`、`sessions.patch` 或 `chat.history` timeout
**When** 用户发起新 turn
**Then** 智码 GLM Code 应优先保护用户发送链路
**And** 应记录可诊断的健康状态和降级原因

## 3. 功能需求

### FR-1：发送路径不得无条件依赖重复 `sessions.patch`

`runTurn()` 发送前需要确保模型一致，但不能每轮都把 `sessions.patch` 作为无条件硬依赖。

需要区分：

| 模型来源 | 一致性要求 |
|---|---|
| `sessionOverride` 且最近一次 patch 未确认 | 必须 patch 成功后才能发送 |
| `sessionOverride` 且同模型已确认 patch 成功 | patch 超时时可降级继续发送 |
| agent 默认模型且未变化 | 可使用缓存跳过 patch |
| agent 默认模型已变化 | 应尝试 patch，失败时按风险决定是否继续 |

### FR-2：模型 patch 需要带状态缓存和失效语义

需要维护每个 session 的模型 patch 状态，而不是只有 `lastPatchedModelBySession` 字符串。

建议状态包含：

```typescript
type SessionModelPatchState = {
  model: string;
  confirmedAt: number;
  source: 'sessionOverride' | 'agentModel';
  sessionKey: string;
};
```

状态失效条件：

- 用户切换模型。
- sessionKey 变化。
- gateway 断线重连。
- OpenClaw runtime 重启。
- `sessions.patch` 返回明确失败。
- 收到 OpenClaw `sessions.changed` 后发现模型与本地期望不一致。

### FR-3：`sessions.patch` 超时应按语义降级

`sessions.patch` 失败不应一律导致 turn error。

建议规则：

1. 如果目标模型已经有新鲜 confirmed state，且本次只是冗余校准：
   - 记录 warn。
   - 继续 `chat.send`。
   - 标记本次使用 `modelPatchDegraded: true`，便于后续诊断。
2. 如果目标模型没有 confirmed state，或者用户刚显式切换模型：
   - 保持当前失败行为。
   - 不发送 `chat.send`，避免用错误模型回答。
3. 如果 gateway 已经处于 degraded 状态：
   - 优先跳过非关键 patch。
   - 对强一致 patch 给出更明确错误。

### FR-4：context usage 刷新必须限流、合并和退避

当前 renderer 和 main 会通过多条路径触发 `sessions.list`：

- session 详情进入时刷新 context usage。
- final 后按多个延迟重复刷新。
- 模型切换后刷新。
- context compaction 后刷新。
- channel session polling 每 10 秒执行 `sessions.list`。

需要为 `getContextUsage()` 和 channel polling 增加全局保护：

1. 同一 session 同一时间只允许一个 context usage 请求。
2. 多个 session 的 context usage 刷新需要全局并发上限。
3. `sessions.list` timeout 后进入退避窗口，例如 30 秒内只返回缓存或 unknown。
4. final 后的多次刷新在 gateway degraded 时取消后续 timer。
5. channel polling 发现 gateway degraded 时暂停一到多个周期。

### FR-5：Gateway RPC 健康状态需要可观测

智码 GLM Code 需要维护轻量 gateway RPC health state：

```typescript
type GatewayRpcHealth = {
  degradedUntil: number;
  consecutiveTimeouts: number;
  lastTimeoutMethod?: string;
  lastTimeoutAt?: number;
};
```

触发 degraded 的信号：

- `gateway request timeout for sessions.list`
- `gateway request timeout for sessions.patch`
- `gateway request timeout for chat.history`
- `chat.send` 前置 RPC 超过阈值

恢复条件：

- 退避窗口结束。
- 后续关键 RPC 成功。
- gateway 重连或 runtime 重启后重置状态。

### FR-6：错误信息要表达真实阶段

用户可见错误不应只显示底层 RPC 名称。对于发送前模型 patch 超时，建议映射为：

```text
OpenClaw 会话同步超时，消息尚未发送。请稍后重试或重启 OpenClaw Runtime。
```

同时保留原始错误到日志，便于继续定位：

```text
gateway request timeout for sessions.patch
```

### FR-7：OpenClaw runtime 侧需要补足锁诊断

智码 GLM Code 可以先做降级和限流，但根因仍在 OpenClaw session 写锁持有过久。

OpenClaw runtime 侧后续应增加：

- 锁获取等待耗时日志。
- 锁持有者或操作名。
- 写入 `sessions.json` 的 payload 尺寸和 session 数量摘要。
- 超过阈值时输出当前排队的 session RPC 方法摘要。

## 4. 实现方案

### 4.1 在 `OpenClawRuntimeAdapter` 增加模型 patch 状态机

涉及文件：

- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`

调整点：

1. 将 `lastPatchedModelBySession` 扩展为带时间、来源、sessionKey 的 confirmed state。
2. `patchSession()` 作为 UI patch 入口时，只有 OpenClaw `sessions.patch` 成功后才更新 confirmed state。
3. `runTurn()` 调用 `ensureSessionModelForTurn()` 时传入本轮是否允许 degraded send。
4. `ensureSessionModelForTurn()` 对 session override 做以下判断：
   - 没有 confirmed state：必须 patch 成功。
   - 有同 model、同 sessionKey、未过期 confirmed state：patch timeout 时允许继续。
   - 有不同 model 或不同 sessionKey：必须 patch 成功。
5. gateway 断线、重连、runtime 重启、sessionKey 变化时清理 confirmed state。

### 4.2 给发送前 patch 设置明确 timeout 和错误分类

当前 `client.request('sessions.patch', ...)` 未传 `timeoutMs`，使用 gateway client 默认 30 秒。

建议显式传入 timeout，并按错误分类处理：

```typescript
await client.request('sessions.patch', { key: sessionKey, model }, { timeoutMs: 30_000 });
```

分类函数：

```typescript
function isGatewayRequestTimeout(error: unknown, method?: string): boolean;
```

用途：

- 只对 timeout 类错误走 degraded 逻辑。
- 对 `INVALID_REQUEST`、`model not allowed` 等明确失败继续 hard fail。

### 4.3 增加 Gateway RPC health gate

在 `OpenClawRuntimeAdapter` 内部维护 `gatewayRpcHealth`：

1. 任意 session RPC timeout 时调用 `markGatewayRpcTimeout(method)`。
2. 在 `getContextUsage()` 和 `pollChannelSessions()` 前调用 `isGatewayRpcDegraded()`。
3. degraded 时：
   - `getContextUsage()` 返回缓存或 unknown，不发 `sessions.list`。
   - `pollChannelSessions()` 跳过本轮。
   - `ensureSessionModelForTurn()` 对可降级 patch 直接跳过或降低重试次数。

### 4.4 合并 context usage 请求

`getContextUsage(sessionId)` 增加 in-flight map：

```typescript
private contextUsageInFlight = new Map<string, Promise<CoworkContextUsage | null>>();
```

行为：

1. 同一 session 已有请求时复用 promise。
2. 请求结束后删除 map。
3. 全局可加简单队列或计数器，限制同时最多 1-2 个 `sessions.list`。
4. degraded 时不进入队列，直接返回 fallback usage。

Renderer 侧保留现有 cooldown，但最终保护应在 main/runtime 层，因为多个 renderer 入口和 IPC 都可能触发同类请求。

### 4.5 调整 final 后多次刷新策略

涉及文件：

- `src/renderer/services/cowork.ts`

当前 final 后会按 `[800, 2500, 6000, 12000]` 多次刷新。建议：

1. 如果第一次刷新返回 `status: 'unknown'` 且带有 `degraded` 标记，取消该 session 后续 final refresh timer。
2. 或由 main 返回缓存 usage，并在 degraded 时不触发更多请求。
3. 保留正常情况下的多次刷新，避免影响 context compaction 后准确性。

### 4.6 优化用户可见错误

涉及文件：

- `src/renderer/services/cowork.ts`
- `src/renderer/services/i18n.ts`

新增错误分类 key：

```text
coworkGatewaySessionSyncTimeout
```

中文：

```text
OpenClaw 会话同步超时，消息尚未发送。请稍后重试或重启 OpenClaw Runtime。
```

英文：

```text
OpenClaw session sync timed out, so the message was not sent. Please retry later or restart the OpenClaw runtime.
```

### 4.7 OpenClaw runtime 后续修复建议

如果可以修改 OpenClaw runtime，应优先在 session store 层处理：

1. 缩短 `sessions.json.lock` 持有时间。
2. 将大 payload 处理、事件广播、history backfill 等操作移出锁内。
3. 将 session read 和 write 分离，避免大量 `sessions.list` 被写锁长时间阻塞。
4. 对 `sessions.patch` 做轻量原子更新，避免全量读写整个 sessions 文件。
5. 输出锁持有者和排队 RPC 摘要，避免以后只能从外层 timeout 反推。

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| session override 第一次设置后立即发送 | 必须 patch 成功，不允许降级 |
| session override 同模型已确认，下一轮冗余 patch 超时 | 允许继续 `chat.send`，记录 degraded warn |
| agent 默认模型未变化 | 跳过 patch 或 patch 超时后继续 |
| agent 默认模型刚变化 | 尝试 patch，失败时根据是否已有确认状态决定是否继续 |
| `sessions.patch` 返回 `model not allowed` | 不降级，直接失败 |
| `sessions.patch` timeout 但随后迟到成功 | 迟到响应不应覆盖更新后的模型状态，需要按 sessionKey/model 校验后再确认 |
| gateway 断线重连 | 清空模型 patch confirmed state 和 RPC health |
| OpenClaw runtime 重启 | 清空模型 patch confirmed state 和 RPC health |
| context usage 刷新超时 | 返回缓存或 unknown，不影响用户发送 |
| channel polling 超时 | 进入退避，不影响已有会话发送 |
| `chat.send` 本身 timeout | 仍按现有 turn timeout/watchdog 处理，不被误判为可降级模型 patch |

## 6. 涉及文件

核心变更：

- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
- `src/renderer/services/cowork.ts`
- `src/renderer/services/i18n.ts`

测试：

- `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts`
- 如调整 renderer 错误分类，可补充对应 service 或 i18n 测试

OpenClaw runtime 后续建议：

- `vendor/openclaw-runtime/.../session-write-lock` 相关源码或上游 OpenClaw session store 模块

## 7. 验收标准

1. 在 gateway session RPC 偶发慢但模型已确认一致时，用户继续追问不会因为冗余 `sessions.patch` timeout 直接失败。
2. 用户刚显式切换模型后，如果 OpenClaw `sessions.patch` 失败，不会用旧模型静默发送。
3. 当 `sessions.list` 连续 timeout 时，context usage 刷新进入退避，不再密集打 gateway。
4. final 后的多次 context usage 刷新不会在 gateway degraded 状态下持续加压。
5. channel session polling 在 gateway degraded 状态下会暂停或退避。
6. 用户可见错误能区分“消息尚未发送的会话同步超时”和普通模型回复失败。
7. 日志能看到 degraded 触发、降级发送、退避跳过和恢复。
8. 不回退 IM 会话模型 patch、普通 Cowork 模型切换、context compaction usage 展示等既有行为。

## 8. 验证计划

### 8.1 单元测试

覆盖 `OpenClawRuntimeAdapter`：

1. `sessionOverride` 首次 patch timeout 时，`chat.send` 不应执行，并返回 error。
2. `sessionOverride` 同模型已有 confirmed state，冗余 patch timeout 时，仍执行 `chat.send`。
3. `sessions.patch` 返回 `model not allowed` 时，不允许降级。
4. gateway reconnect 后 confirmed state 被清空，下一轮必须重新 patch。
5. 多次并发 `getContextUsage(sessionId)` 只触发一次 `sessions.list`。
6. gateway degraded 时，`getContextUsage()` 返回 fallback，不调用 `sessions.list`。
7. gateway degraded 时，`pollChannelSessions()` 跳过本轮。

运行：

```bash
npm test -- openclawRuntimeAdapter
```

### 8.2 类型和构建

```bash
npm run compile:electron
npm run build
```

### 8.3 手动验证

1. 正常 gateway 下，已有会话连续追问，模型正确生效。
2. 切换模型后立即追问，OpenClaw session 使用新模型。
3. 模拟 `sessions.patch` timeout：
   - 未确认模型时发送失败，且提示消息尚未发送。
   - 已确认模型时可继续发送，并记录 degraded warn。
4. 模拟 `sessions.list` timeout，确认 context usage 不再连续刷屏。
5. 观察日志中不再出现大量连续 `targeted context usage refresh failed` 夹击用户发送路径。
