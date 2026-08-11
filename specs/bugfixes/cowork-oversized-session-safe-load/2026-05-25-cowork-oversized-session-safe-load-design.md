# Cowork 任务点击触发上下文查询卡死修复设计文档

## 1. 概述

### 1.1 问题

用户反馈某一个固定任务记录只要点击，整个 智码 GLM Code 应用就会卡死，无法继续操作。重启应用后，只要不点击该任务记录就正常；再次点击同一个任务记录后又会卡死。

本次日志中可定位到异常会话：

| 字段 | 值 |
|---|---|
| 智码 GLM Code sessionId | `d5bc36d4-57f7-4c4b-8248-f7ddc5727e12` |
| OpenClaw sessionId | `98850bbd-4ec0-4a87-8865-7069801f3ccd` |
| session key | `agent:pm:lobsterai:d5bc36d4-57f7-4c4b-8248-f7ddc5727e12` |
| 任务特征 | `外挂逆向大盘 Dashboard`、`PM 外挂逆向数据` |

日志显示该 session 的 OpenClaw transcript 已异常膨胀：

- `tokenCount=7881085`，远超 `contextWindow=200000`。
- `transcriptBytes=79721079`，接近 80 MB。
- 多次触发 `preflightCompaction`、`memoryFlush` 和 `forceFlushByTranscriptSize=true`。
- 同一个 session 的 context usage 定向查询在日志中反复出现。

当前最需要先修的不是完整的超大会话治理，而是 **点击任务记录后自动触发 context usage 查询，导致 OpenClaw gateway 对巨大 transcript 做 `sessions.list` 定向查询**。context usage 只是辅助展示信息，不应该影响任务记录打开。

### 1.2 根因

当前点击任务记录后，renderer 会立即触发上下文用量刷新：

1. 用户点击任务记录后，renderer 调用 `coworkService.loadSession(sessionId)`。
2. `loadSession()` 通过 IPC 调用 `cowork:getSession`，主进程从 SQLite 返回最近一页消息。
3. `loadSession()` 成功后立刻调用 `refreshContextUsageForSessionEntry(sessionId)`。
4. `CoworkSessionDetail` 在 `sessionId` 变化时也会调用 `refreshContextUsageForSessionEntry(sessionId)`。
5. `refreshContextUsageForSessionEntry()` 进入 `refreshContextUsage()`，通过 IPC 调用 `cowork:session:contextUsage`。
6. 主进程 `OpenClawRuntimeAdapter.getContextUsage()` 通过 gateway `sessions.list` 按 session key 做 targeted lookup。
7. 如果 targeted lookup 失败或超时，当前实现还会继续做 recent session lookup。

对异常 session 来说，这条链路会让点击操作触发 OpenClaw 对接近 80 MB transcript 的读取、解析或 token 估算。即使 renderer 有 1.5 秒 cooldown，也只是减少重复请求，不能避免首次点击被拖住。

### 1.3 目标

P0 修复目标：

1. 用户点击异常任务记录时，应用不能因为自动 context usage 查询而卡死。
2. 打开 session 只依赖本地 SQLite 的 session/message 加载，不依赖 OpenClaw context usage 查询。
3. context usage 获取不到时，可以不展示，不自动重试。
4. 自动 context usage 查询必须有短超时、in-flight 去重和失败抑制。
5. timeout/error 后返回缓存或 unavailable/null，不继续触发 gateway fallback 查询放大影响。
6. 正常 session 的点击、查看和继续对话行为不受影响。

### 1.4 非目标

P0 不做以下事情：

- 不实现完整“超大会话安全模式”。
- 不默认禁用异常 session 的继续对话。
- 不自动总结旧 session 并创建新 session。
- 不实现 OpenClaw JSONL transcript repair。
- 不重写 OpenClaw compaction / memory flush 策略。
- 不大范围重构消息渲染、tool result 截断或 artifact 解析。

这些能力可以作为 P1/P2 后续增强，但 P0 只解决“点击任务被自动 context usage 查询拖死”的直接触发链路。

## 2. 用户场景

### 场景 1: 点击正常任务记录

**Given** 用户点击一个普通 Cowork 任务记录
**When** session 本地消息加载成功
**Then** UI 正常打开会话
**And** 用户可以继续查看和对话
**And** 如果 context usage 能快速返回，则展示上下文用量

### 场景 2: 点击异常大任务记录

**Given** 某个 OpenClaw session transcript 异常巨大
**When** 用户点击该任务记录
**Then** UI 仍然打开会话详情
**And** 不因为 context usage 查询阻塞或卡死
**And** 如果上下文用量拿不到，则不展示
**And** 系统不自动反复重试 context usage

### 场景 3: context usage 查询超时

**Given** renderer 发起 context usage 查询
**When** gateway 在短超时时间内没有返回
**Then** 主进程返回缓存或 unavailable/null
**And** renderer 记录该 session 的自动刷新失败状态
**And** 后续自动路径不再立即请求同一 session

### 场景 4: 用户手动刷新上下文用量

**Given** 自动 context usage 因超时或错误被抑制
**When** 用户手动触发刷新
**Then** 可以发起一次新的受限查询
**And** 仍然有短超时和 in-flight 去重
**And** 失败后不影响会话查看和继续对话

### 场景 5: 新一轮任务完成后刷新

**Given** 用户在 session 中继续对话并完成一轮新任务
**When** OpenClaw 返回新的完成事件或 context usage update
**Then** 可以清除该 session 的自动刷新抑制状态
**And** 允许一次新的受限 context usage 查询

## 3. 功能需求

### FR-1: `loadSession()` 不自动触发 context usage

`coworkService.loadSession(sessionId)` 成功加载 session 后，不应立即调用 `refreshContextUsageForSessionEntry(sessionId)`。

打开任务记录的主路径应只做：

1. `cowork:getSession`
2. `setCurrentSession(result.session)`
3. `setStreaming(...)`
4. `remoteManaged(...)`

context usage 是辅助信息，不属于 session 打开成功的必要条件。

### FR-2: 详情页切换 session 不立即触发 context usage

`CoworkSessionDetail` 当前在 `sessionId` 变化时调用 `coworkService.refreshContextUsageForSessionEntry(sessionId)`。

P0 应删除或改造该自动调用：

- 如果已有缓存，直接展示缓存。
- 如果没有缓存，不展示上下文用量。
- 不在组件 mount/session switch 时自动请求 gateway。

### FR-3: 自动 context usage 查询需要失败抑制

renderer 需要维护每个 session 的自动 context usage 状态：

- `inFlight`：同一 session 同时只能有一个查询。
- `lastAttemptAt`：限制请求频率。
- `suppressedUntil` 或 `unavailable`：timeout/error 后一段时间内不再自动刷新。

建议规则：

| 场景 | 行为 |
|---|---|
| 已有 in-flight 查询 | 复用或直接跳过 |
| 上次自动查询刚失败 | 自动路径跳过 |
| 用户手动刷新 | 允许绕过自动抑制，但仍受 in-flight 和 timeout 限制 |
| 新 run 完成 | 清除抑制，允许一次自动刷新 |

### FR-4: 主进程 context usage 查询必须快速失败

`OpenClawRuntimeAdapter.getContextUsage(sessionId)` 当前会先 targeted lookup，再 recent lookup。

P0 调整为：

1. targeted lookup 使用较短 timeout，例如 1500-2000 ms。
2. targeted lookup 成功则返回 live usage。
3. targeted lookup 超时或失败后，直接返回缓存或 unavailable/null。
4. 不再因为一次点击进入 recent session lookup fallback。

recent lookup 可以保留给后台同步或明确的列表刷新场景，但不应服务于“打开某个 session 后即时查询 context usage”的路径。

### FR-5: IPC 返回要区分 live/cache/unavailable

`cowork:session:contextUsage` 返回结果应能表达数据来源，避免 renderer 把上下文用量不可用当成异常重试。

建议返回：

```ts
export const CoworkContextUsageSource = {
  Live: 'live',
  Cache: 'cache',
  Unavailable: 'unavailable',
} as const;
export type CoworkContextUsageSource =
  typeof CoworkContextUsageSource[keyof typeof CoworkContextUsageSource];

export const CoworkContextUsageFailureReason = {
  Timeout: 'timeout',
  GatewayError: 'gateway_error',
} as const;
export type CoworkContextUsageFailureReason =
  typeof CoworkContextUsageFailureReason[keyof typeof CoworkContextUsageFailureReason];
```

注意：这些字符串用于状态判断，必须集中定义常量，不能在代码里散落裸字符串。

IPC 结果可以是：

```ts
type ContextUsageResult =
  | { success: true; usage: CoworkContextUsage | null; source: CoworkContextUsageSource }
  | { success: false; error: string; reason: CoworkContextUsageFailureReason };
```

如果返回 unavailable，renderer 应停止自动重试，并且不展示上下文用量。

### FR-6: context usage 展示允许缺省

UI 上下文用量不是必需信息。

当 source 为 `Unavailable` 或 usage 为 null：

- 不展示 context usage 指示器；
- 不展示持续 spinner；
- 不自动发起下一次请求；
- 不影响输入框和继续对话。

### FR-7: 手动刷新仍可用但必须受限

如果 UI 已经有 context usage 指示器或刷新入口，手动刷新可以保留。

手动刷新规则：

- 可绕过自动抑制状态。
- 不可绕过 in-flight 去重。
- 不可绕过主进程短超时。
- 失败后隐藏上下文用量状态，不弹阻断式错误。

### FR-8: 新任务完成后可以重新允许一次自动刷新

当同一 session 产生新的 assistant final、complete 或 context maintenance 完成事件时，可以清理该 session 的 context usage 自动抑制状态。

这样可以避免一次历史坏 transcript 导致该 session 永久无法刷新，同时仍避免点击时反复触发高风险查询。

### FR-9: 日志要表达 context usage 被降级

新增日志遵守仓库日志规范：

- 使用英文。
- 以模块 tag 开头。
- 不在高频路径使用 info 级日志。
- timeout/error 包含 sessionId。
- 自动跳过可以用 debug，不要刷屏。

示例：

```ts
console.warn(`[OpenClawRuntime] context usage lookup timed out for session ${sessionId}; returning cached usage.`);
```

## 4. 实现方案

### 4.1 renderer 停止点击后自动查询

涉及文件：

- `src/renderer/services/cowork.ts`
- `src/renderer/components/cowork/CoworkSessionDetail.tsx`

调整点：

1. 删除 `loadSession()` 成功后的 `this.refreshContextUsageForSessionEntry(sessionId)`。
2. 删除或禁用 `CoworkSessionDetail` 中 `sessionId` 变化后自动调用 `refreshContextUsageForSessionEntry(sessionId)` 的 effect。
3. 保留其他明确语义的刷新入口，例如手动压缩后刷新、用户手动刷新、新 run 完成后刷新。

### 4.2 renderer 增加 in-flight 和失败抑制

涉及文件：

- `src/renderer/services/cowork.ts`

新增内部状态：

```ts
private contextUsageInFlightBySessionId = new Map<string, Promise<CoworkContextUsage | null>>();
private contextUsageAutoSuppressedUntilBySessionId = new Map<string, number>();
```

`refreshContextUsage()` 建议增加调用来源：

```ts
async refreshContextUsage(
  sessionId: string,
  options: {
    notifyCompaction?: boolean;
    mode?: 'auto' | 'manual' | 'postRun';
  } = {},
): Promise<CoworkContextUsage | null>
```

规则：

- `mode=auto` 时，如果 session 在抑制期内，直接返回 null。
- 已有 in-flight promise 时复用或跳过。
- IPC 返回 timeout/error/unavailable 时，写入抑制期。
- `mode=manual` 不检查抑制期，但仍复用 in-flight。
- `mode=postRun` 可以先清除抑制，再发起一次查询。

模式字符串也属于判定值，应集中定义常量。

### 4.3 主进程缩短 targeted lookup 并移除点击路径 fallback

涉及文件：

- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
- `src/main/libs/agentEngine/coworkEngineRouter.ts`
- `src/main/main.ts`
- `src/renderer/types/electron.d.ts`

调整点：

1. `listGatewaySessionsForUsage()` 支持传入 `timeoutMs`。
2. `getContextUsage(sessionId)` targeted lookup 使用短 timeout。
3. targeted lookup 失败后优先返回缓存的 context usage。
4. 没有缓存时返回 `{ usage: null, source: CoworkContextUsageSource.Unavailable }`。
5. 不再在该路径继续调用 `listGatewaySessionsForUsage({ activeMinutes: 120 })`。

如果仍需要 recent lookup，建议拆成单独方法，例如 `refreshRecentContextUsageCache()`，只用于后台列表缓存，不用于点击 session 后的即时查询。

### 4.4 UI 缺省展示

涉及文件：

- `src/renderer/components/cowork/ContextUsageIndicator` 相关组件
- `src/renderer/store/slices/coworkSlice.ts`
- `src/renderer/services/i18n.ts`

调整点：

1. context usage 为 null 或 source unavailable 时，不显示上下文用量组件。
2. 不把 unavailable 状态当错误 toast。
3. 不展示 `unknown`、`暂不可用` 等用户可见占位文案，避免造成困惑。
4. 不影响输入框可用性。

### 4.5 清理自动抑制状态

涉及文件：

- `src/renderer/services/cowork.ts`

在以下事件中清理当前 session 的抑制状态：

- 收到新的 `complete` stream event。
- 手动 compaction 成功。
- 用户手动点击刷新。
- session 切换不清理抑制，避免来回点击坏 session 反复触发。

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| 点击巨大历史 session | 打开本地消息，不自动查 context usage |
| targeted lookup 超时 | 返回 cache 或 unavailable/null，不做 recent fallback |
| context usage unavailable | 不展示，不 spinner，不重试 |
| 同 session 多处同时刷新 | in-flight 去重 |
| 自动刷新失败 | 写入抑制期，后续自动路径跳过 |
| 用户手动刷新 | 可发起一次受限查询 |
| 新 run 完成 | 清除抑制，允许一次 postRun 刷新 |
| 正常 session | 可在 postRun 或手动路径刷新 context usage |
| gateway 未启动 | 返回 unavailable/null，不影响打开会话 |

## 6. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/renderer/services/cowork.ts` | 停止 loadSession 自动刷新、增加 in-flight 和失败抑制 |
| `src/renderer/components/cowork/CoworkSessionDetail.tsx` | 移除 sessionId 切换后的自动 context usage 查询 |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | context usage 短超时、返回 cache/unavailable、移除点击路径 recent fallback |
| `src/main/main.ts` | IPC 返回 source/reason |
| `src/main/libs/agentEngine/coworkEngineRouter.ts` | 透传新的 context usage 结果 |
| `src/renderer/types/electron.d.ts` | 同步 IPC 类型 |
| `src/renderer/types/cowork.ts` | 新增 context usage source/reason/mode 类型 |
| `src/shared/cowork/constants.ts` | 新增 context usage source/reason/mode 常量 |
| `src/renderer/services/i18n.ts` | 原则上不新增上下文用量不可用文案，拿不到时直接不展示 |

## 7. 测试计划

### 7.1 单元测试

新增或更新测试：

1. `loadSession()` 成功后不调用 `refreshContextUsageForSessionEntry()`。
2. `CoworkSessionDetail` 切换 sessionId 不自动触发 context usage。
3. `refreshContextUsage({ mode: 'auto' })` 在抑制期内不调用 IPC。
4. 同一 session 多次刷新时只产生一个 in-flight IPC。
5. IPC 返回 timeout/unavailable 后写入自动抑制状态。
6. `mode: 'manual'` 可绕过自动抑制，但仍复用 in-flight。
7. `OpenClawRuntimeAdapter.getContextUsage()` targeted lookup 超时后返回 unavailable/cache。
8. `getContextUsage()` targeted lookup 失败后不再调用 recent lookup。

### 7.2 手动验证

1. 使用真实问题 session 复现点击。
2. 确认点击后 5 秒内应用仍可操作。
3. 确认点击路径不产生 OpenClaw `sessions.list` context usage 查询，或查询超时后不会再次自动请求。
4. 确认上下文用量不可用时不会展示占位文案或持续 spinner。
5. 点击其他正常任务，确认能正常打开并继续对话。
6. 完成一轮新任务后，确认允许一次受限的 postRun context usage 刷新。

## 8. 验收标准

- [ ] 点击异常 session 不会因为 context usage 查询导致应用卡死。
- [ ] `loadSession()` 不再自动刷新 context usage。
- [ ] `CoworkSessionDetail` 切换 sessionId 不再自动刷新 context usage。
- [ ] context usage targeted lookup 使用短超时。
- [ ] targeted lookup 超时/失败后返回 cache 或 unavailable/null。
- [ ] 点击路径不再进入 recent lookup fallback。
- [ ] 自动 context usage 失败后不会立即重试同一 session。
- [ ] context usage unavailable 不显示占位文案或持续 spinner，不阻塞输入。
- [ ] 手动刷新仍可用，但有超时和 in-flight 去重。
- [ ] 正常 session 的查看和继续对话不受影响。

## 9. 后续迭代

P1 可以继续做超大会话的消息渲染防护：

1. 对单条超大 tool result 做默认截断。
2. 导航 rail 不处理完整大文本。
3. metadata JSON 解析容错。
4. 当前页 IPC payload 大小上限。

P2 可以做异常 session 恢复能力：

1. 从 SQLite `cowork_messages` 分页生成 `Recovered summary`。
2. 基于摘要创建新的干净 session 继续对话。
3. 支持不完整打开坏 session 的导出、删除、归档。

P3 再处理 OpenClaw transcript 层面：

1. 对超大 JSONL transcript 做离线 repair/export。
2. compaction 成功后真正降低 transcript 体积。
3. memory flush 模式限制普通项目写入，避免反复失败。
4. 当 transcript 超过硬阈值时，OpenClaw 主动停止继续运行并要求用户新建 session。
