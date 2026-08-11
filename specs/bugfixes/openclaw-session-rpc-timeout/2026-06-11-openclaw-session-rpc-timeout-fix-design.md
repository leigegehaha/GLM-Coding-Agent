# OpenClaw 发送前会话同步超时丢消息修复设计文档（迭代）

## 1. 概述

### 1.1 问题

Windows 用户反馈：每次发消息都报错，内容为：

```text
OpenClaw 会话同步超时，消息尚未发送。请稍后重试或重启 OpenClaw Runtime。
```

底层错误与 2026-05-25 设计文档处理的是同一条链路：

```text
[OpenClawRuntime] failed to patch the session model before chat.send: Error: gateway request timeout for sessions.patch
[Cowork] session error: Error: gateway request timeout for sessions.patch
```

即 `runTurn()` 在 `chat.send` 之前执行 `ensureSessionModelForTurn()` 同步会话模型，`sessions.patch` 30 秒超时后，`sessionOverride` 来源直接抛错，本轮终止，用户消息被丢弃。

### 1.2 与 2026-05-25 设计的关系

上一版设计已经落地：模型 patch confirmed state、gateway RPC health gate（degraded 退避）、context usage 限流、错误分类 key `coworkGatewaySessionSyncTimeout`。它解决的是"同模型冗余 patch 在拥塞时拖死发送"。

本次事故暴露了它的两个遗留缺口：

1. **无 confirmed state 时的首次 patch 没有任何容错。** confirmed state 在 gateway client stop 时被 `clear()`（`openclawRuntimeAdapter.ts` 的 `stopGatewayClient` 路径），因此**每次 runtime 重启后的第一条消息**都必须完成一次 patch 往返，30 秒超时一刀切，在 gateway 冷启动/冻结时必然失败。
2. **错误文案建议"重启 OpenClaw Runtime"形成恶性循环。** 重启后 gateway 有 26~95 秒的冷启动窗口，窗口内发的第一条消息正好命中缺口 1。事故日志中用户 1 小时内重启 8 次，5 次超时报错中 4 次发生在重启后的冷启动窗口内。

### 1.3 根因与日志证据

本次事故（2026-06-11，Windows）的直接根因是 **gateway 进程整体周期性冻结**，而非上一版的 session 写锁拥塞：

- gateway 日志出现 10 次以上 35~107 秒的完全静默窗口，期间内部定时器 tick、正常 2~30ms 即可响应的 `sessions.list` 全部停摆；
- 超时的 `sessions.patch` 在 gateway 解冻后**实际都成功完成**：

```text
[ws] ⇄ res ✓ sessions.patch 40967ms id=f27090df…1459
[ws] ⇄ res ✓ sessions.patch 56300ms id=ab32e7fe…51f1
```

- 正常时段同一 patch 仅需 29~33ms；
- 冻结的同一时间窗内，Electron 主进程定时器毫秒级准点触发（排除整机卡死），被卡住的均为 gateway 进程内的本地操作（排除外网网络问题）；
- gateway 冷启动耗时 26~95 秒（startup profile：`authBootstrap 28401ms`、`postAttachRuntime 60487ms`），bundle import 4~6.5 秒，所有 I/O 环节一致性地慢 10~100 倍。

结论：该机器存在进程级资源饥饿（内存换页/磁盘饱和/杀软实时扫描叠加），属环境问题，智码 GLM Code 无法在代码层根治；但发送链路应当对"引擎慢"具备容错——**gateway 是自愈的、patch 是幂等的且最终会成功，客户端却在 30 秒就放弃并丢弃消息**，这是本次要修复的缺陷。

### 1.4 非根因 / 非目标

- 不是模型供应商问题。同日志中另有 `deepseek-v4-flash` 的 HTTP 401（用户配置的 DeepSeek API key 无效），与本问题完全独立，不在本设计范围内。
- 不是 session 写锁拥塞复发。本次 gateway 端无 `session-write-lock` 告警，冻结是全进程性的。
- 不重做 2026-05-25 设计中的 degraded/confirmed state 机制，本次只做增量修补。

### 1.5 本次明确不做的方案（评审中被剔除）

| 备选方案 | 剔除原因 |
|---|---|
| patch 超时后自动重试一次 | patch 幂等且 gateway 自愈，单纯拉长超时窗口的效果与重试等价，重试只多防 WS 断连丢请求的小概率场景，不值得增加队列内重试的复杂度 |
| confirmed state 跨重启持久化（写 SQLite）+ 轮询校验 | 风险最高：需信任本地记录跳过与 gateway 的核对，用户清空 OpenClaw state 目录或版本迁移 session store 时可能用错误模型发送，必须配套校验自愈机制，复杂度收益比不划算 |
| 引擎 warming 就绪门禁（握手后探活通过才置 running） | 改动面大（状态机 + UI + i18n），独立迭代再做 |
| OpenClaw `chat.send` 协议增加 model 字段，消除发送前 patch 往返 | 根治方案，但需 OpenClaw 仓库联动 + 升级锁定版本，作为长期方向单列 |

## 2. 用户场景

### 场景 A：gateway 冷启动/冻结期间发送消息

**Given** OpenClaw runtime 刚重启或 gateway 进程正处于冻结窗口
**And** `sessions.patch` 需要 40~60 秒才能完成
**When** 用户发送消息
**Then** 发送流程应等待至多 90 秒，patch 完成后正常执行 `chat.send`
**And** 用户全程只看到运行中状态，不报错、不丢消息

### 场景 B：gateway 持续不可用超过容忍窗口

**Given** `sessions.patch` 超过 90 秒仍未返回
**When** 发送流程最终失败
**Then** 错误提示告知用户"稍候重发"，并提示排查内存/磁盘/杀软
**And** 不再建议重启 OpenClaw Runtime

### 场景 C：用户在等待窗口内手动停止会话

**Given** 发送前 patch 正在等待（最长 90 秒）
**When** 用户点击停止
**Then** patch 返回后本轮静默中止，不执行 `chat.send`，不报错
**And** 会话状态保持停止后的 idle

### 场景 D：UI 中切换会话模型

**Given** 用户在会话设置中切换模型（`patchSession()` 入口）
**When** gateway 响应缓慢
**Then** 仍维持 30 秒超时快速失败，用户可手动重试
**And** 不受本次发送链路超时调整影响

## 3. 功能需求

### FR-1：发送前模型同步的超时从 30 秒放宽到 90 秒

仅适用于 `ensureSessionModelForTurn()` 的发送前同步路径。90 秒依据：事故中观测到的 patch 实际完成时长上限为 56.3 秒，60 秒仅剩 3.7 秒余量；90 秒可稳定覆盖全部观测样本，代价仅为极端失败场景下用户多等待 60 秒。

其余 `sessions.patch` 调用点（UI 模型切换 `patchSession()`、默认值）维持 30 秒不变。

### FR-2：等待窗口内的手动停止必须生效

发送前 patch 等待结束后、继续执行之前，检查该会话是否在本轮开始之后被手动停止（`stoppedSessions` 时间戳晚于本轮 `turnStartedAtMs`）。若已停止：静默中止本轮，不执行 `chat.send`，不 emit error，不改写会话状态（`stopSession()` 已将其置为 idle）。

背景：等待窗口从 30 秒扩大到 90 秒后，"用户等不及点停止，patch 完成后消息仍被发出"的窗口同步放大 3 倍，必须补上此防护。

### FR-3：错误文案不再引导重启，并给出环境排查指引

`coworkGatewaySessionSyncTimeout` 的 key 与触发条件不变（错误 message 仍为 `gateway request timeout for sessions.patch`，`coworkErrorClassify.ts` 的正则无需改动），仅更新文案：

中文：

```text
OpenClaw 引擎响应缓慢，消息尚未发送。请等待 1~2 分钟后重新发送；若频繁出现，请检查系统内存与磁盘占用，并将 智码 GLM Code 加入杀毒软件白名单。
```

英文：

```text
The OpenClaw engine is responding slowly and your message has not been sent. Please wait a minute or two and resend. If this happens frequently, check system memory and disk usage, and add 智码 GLM Code to your antivirus allowlist.
```

理由：日志证明重启会制造新的冷启动失败窗口，"重启 Runtime"是反向引导。

## 4. 实现方案

### 4.1 新增发送路径专用超时常量

文件：`src/main/libs/agentEngine/openclawRuntimeAdapter.ts`

```typescript
private static readonly SESSION_PATCH_TIMEOUT_MS = 30_000;        // 既有，UI patch 与默认值继续使用
private static readonly SESSION_PATCH_SEND_TIMEOUT_MS = 90_000;   // 新增，仅发送前同步使用
```

`ensureSessionModelForTurn()` 内部队列任务中的 `requestSessionPatchWithProfile({ ..., timeoutMs })` 改为传 `SESSION_PATCH_SEND_TIMEOUT_MS`（当前代码约 2979 行处）。其余调用点不动。

注意：`requestSessionPatchWithProfile()` 既有的慢日志（`SESSION_PATCH_SLOW_LOG_MS = 5_000`，≥5 秒输出 warn 并带 elapsed）已能记录"被拉长的等待救回了多少次发送"，无需新增埋点。

### 4.2 等待后的停止检查

文件：`src/main/libs/agentEngine/openclawRuntimeAdapter.ts`

`runTurn()` 中 `await this.ensureSessionModelForTurn(...)` 成功返回后（约 3111 行调用点之后）、构建 outbound prompt 之前，增加检查：

```typescript
const stoppedAt = this.stoppedSessions.get(sessionId);
if (stoppedAt !== undefined && stoppedAt >= firstResponseTiming.turnStartedAtMs) {
  console.log(`[OpenClawRuntime] turn aborted after model sync because the user stopped session ${sessionId} while waiting.`);
  return;
}
```

依据现状：`stopSession()` 在 `activeTurns` 尚未建立时（即等待 patch 期间）仍会无条件写入 `stoppedSessions` 并把会话状态置为 idle，因此该时间戳是等待期内捕获停止的唯一可靠信号。

### 4.3 文案更新

| 文件 | 位置 | 改动 |
|---|---|---|
| `src/main/i18n.ts` | zh 段 `coworkGatewaySessionSyncTimeout`（约 66 行） | 替换为 FR-3 中文文案 |
| `src/main/i18n.ts` | en 段（约 347 行） | 替换为 FR-3 英文文案 |
| `src/renderer/services/i18n.ts` | zh 段（约 1240 行） | 同上 |
| `src/renderer/services/i18n.ts` | en 段（约 3751 行） | 同上 |

key 不变，`src/common/coworkErrorClassify.ts` 及其测试无需改动。

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| patch 在 30~90 秒之间完成 | 发送正常继续，慢日志记录 elapsed，用户无感知（仅 spinner 时间变长） |
| patch 超过 90 秒仍未返回 | 维持现有失败路径：session 置 error，emit 原始错误，前端按既有 key 显示新文案 |
| 等待期间用户停止会话 | 按 FR-2 静默中止，不发送、不报错 |
| 等待期间用户删除会话 | `stopSession`/删除路径同样写入 `stoppedSessions` 或导致 store 中 session 缺失，中止检查后续的 store 操作天然失败终止，无需额外处理 |
| 同模型冗余 patch 超时（已有 confirmed state） | 沿用 2026-05-25 设计的降级逻辑（`confirmedAfterFailure` 分支），继续发送，不受本次改动影响 |
| `AgentModel` 来源 patch 超时 | 行为不变（本就不抛错），仅同样受益于更长的等待窗口 |
| UI 切换模型（`patchSession()`）遇到慢 gateway | 维持 30 秒快速失败，用户可重试 |
| `sessions.patch` 返回明确业务错误（如 model not allowed） | 非超时错误，立即失败，不等待 90 秒 |
| 迟到的 patch 响应（客户端已超时、gateway 后续完成） | 与现状一致：gateway 端 session store 已更新，下一轮 patch 幂等覆盖，无需处理 |

## 6. 涉及文件

核心变更：

- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` — 新增常量、发送路径超时调整、停止检查
- `src/main/i18n.ts` — 中英文案
- `src/renderer/services/i18n.ts` — 中英文案

测试：

- `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts`

不改动：

- `src/common/coworkErrorClassify.ts`（key 与正则不变）
- `patchSession()` 等其他 `sessions.patch` 调用点

## 7. 验收标准

1. gateway 冷启动或冻结导致 `sessions.patch` 在 90 秒内完成时，用户消息正常发出，不出现"会话同步超时"报错。
2. `sessions.patch` 超过 90 秒仍失败时，报错文案为新文案，不再出现"重启 OpenClaw Runtime"字样。
3. 用户在发送等待期内点击停止后，消息不会被发出，界面无错误提示。
4. UI 模型切换的超时行为与改动前一致（30 秒）。
5. 既有的冗余 patch 降级、degraded 退避、context usage 限流等 2026-05-25 设计的行为不回退。

## 8. 验证计划

### 8.1 单元测试

文件：`src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts`，mock gateway client 的 `request`：

1. 发送路径的 `sessions.patch` 调用收到 `timeoutMs: 90_000`；`patchSession()` 路径仍为 `timeoutMs: 30_000`。
2. mock patch 延迟 45 秒（fake timers）后成功 → `chat.send` 被执行，无 error 事件，confirmed state 已记录。
3. mock patch 抛出 `gateway request timeout for sessions.patch`（无 confirmed state、`sessionOverride` 来源）→ 抛错且错误 message 不变，session 置 error。
4. patch 等待期间调用 `stopSession()` → patch 完成后 `chat.send` 不被调用，无 error 事件。

运行：

```bash
npm test -- openclawRuntimeAdapter
```

### 8.2 类型与构建

```bash
npm run lint
npm run compile:electron
npm run build
```

### 8.3 手动验证

1. 正常 gateway 下收发消息、UI 切换模型后发送，行为无回归。
2. 模拟冻结：用 Process Explorer（Windows）或 `kill -STOP`（macOS）挂起 gateway 进程约 45 秒后恢复，验证消息延迟发出且不报错。
3. 挂起超过 90 秒，验证新文案展示正确（中英文）。
4. 挂起期间点击停止，恢复后验证消息未发出、无报错。

## 9. 后续方向（不在本次范围）

按优先级：

1. **协议根治**：OpenClaw `ChatSendParamsSchema` 增加可选 `model`/`provider` 字段，发送自带模型覆盖，彻底删除发送前 patch 往返（需 OpenClaw 仓库联动并升级 `package.json` 锁定版本）。
2. **warming 就绪门禁**：gateway 握手后以轻量 RPC 探活通过才置 running，UI 在此之前提示"引擎启动中"并缓存用户消息。
3. **环境诊断提示**：gateway 启动耗时 >30 秒或 TickWatchdog 检测到长空窗时，在设置页提示用户检查内存/磁盘占用与杀软白名单。
