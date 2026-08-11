# TickWatchdog 误判断连设计文档

## 1. 概述

### 1.1 问题

当 AI Agent 执行产出大量输出的工具调用（如 `node -e` 生成 2MB+ JSON）时，OpenClaw gateway 的 `tick` 心跳事件被 event loop I/O 饿死，智码 GLM Code 客户端的 `TickWatchdog` 误判连接已死并主动断连，UI 显示"AI 引擎连接中断"。

**表现**：
- 工具执行正常进行中，UI 突然报错
- 日志显示 `[TickWatchdog] no tick received for 149s (threshold: 90s)`
- Gateway 进程实际存活且仍在推送 `update:exec` 事件

### 1.2 根因

三层因素叠加：

| 层面 | 问题 | 源码位置 |
|------|------|----------|
| OpenClaw exec 层 | stdout 每 8KB chunk 立即触发 `emitUpdate()`，无节流 | `bash-tools.exec-runtime.ts:605-608` |
| OpenClaw gateway 层 | tick 使用 `setInterval(30s)`，与 exec 事件共享 event loop，timer phase 被 poll phase I/O 饿死 | `server-maintenance.ts:62-66` |
| 智码 GLM Code 客户端 | `handleGatewayEvent` 仅在 `event === 'tick'` 时更新活跃时间戳，忽略其他事件 | `openclawRuntimeAdapter.ts:3806` |

**事件链**：
```
2.4MB stdout ÷ 8KB = ~300 chunks × 4 WS events/chunk ≈ 1200 events
→ gateway event loop 被 I/O 饱和
→ setInterval(tick) 3分37秒未能触发
→ 客户端 90s 阈值后误判连接死亡
→ 主动断连 (WS code=1006)
```

## 2. 用户场景

### 场景 1: 大输出工具调用

**Given** 用户向 Agent 发送消息触发 shell/exec 工具调用，该命令产出大量 stdout 输出（>1MB）
**When** 输出流式推送持续超过 90 秒
**Then** 连接不应断开，工具执行应正常完成

## 3. 功能需求

### FR-1: 任意 WS 事件均视为连接活跃证据

TickWatchdog 应将来自 gateway 的**任意** WS 事件（不限于 `tick`）视为连接存活的证据。只有在完全收不到任何事件超过阈值时，才触发重连。

## 4. 实现方案

将 `lastTickTimestamp` 的更新从仅 `tick` 事件移至 `handleGatewayEvent` 入口处：

```typescript
private handleGatewayEvent(event: GatewayEventFrame): void {
    this.lastTickTimestamp = Date.now(); // 任意事件 → 连接活跃

    if (event.event === 'tick') {
      return;
    }
    // ... 其余处理逻辑不变
}
```

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| Gateway 完全冻结（无任何事件） | `lastTickTimestamp` 停止更新 → 90s 后正常触发重连，行为不变 |
| Gateway 进程崩溃 | WS 层直接收到 close 事件 → 立即触发重连，不依赖 watchdog |
| 网络中断 | 无任何事件到达 → 90s 后 watchdog 触发，行为不变 |
| exec 大输出 + tick 饿死 | agent/tool 事件持续到达 → watchdog 不误触发 |

## 6. 涉及文件

- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` — `handleGatewayEvent` 方法

## 7. 验收标准

- 执行 `node -e "console.log(JSON.stringify(Array.from({length:12000},(_,i)=>({index:i,title:'test-'+i,content:'x'.repeat(180)}))))"` 等大输出命令时，不再触发"AI 引擎连接中断"
- Gateway 真正不可用时（kill 进程、冻结 event loop），重连仍在 90s 内触发

## 8. 已知伴生现象：sessions.list RPC 超时

### 8.1 现象

TickWatchdog 修复后，exec 大输出期间不再误断连，但日志中仍可观察到：

```
[OpenClawRuntime] gateway RPC timed out for sessions.list; session RPCs are degraded for 30000ms
[ChannelSync] channel session polling timed out; polling will back off temporarily
```

### 8.2 原因

`sessions.list` RPC 与 gateway 事件推送**共用同一条 WebSocket 连接**（见 `client-BvnkXDjJ.js:755-780`）。
exec 风暴期间 gateway event loop 被 I/O 饱和，无法在 5s（`CONTEXT_USAGE_LIST_TIMEOUT_MS`）内处理并应答入站 RPC 请求。

```
客户端 ──[req: sessions.list]──> gateway WS ──> gateway event loop (饱和)
                                                  ↓ 无法及时处理
客户端 5s 超时 → recordGatewayRpcFailure → 30s degraded 模式
```

与 TickWatchdog 的区别：
- TickWatchdog 问题是**客户端侧**误判（已修复）
- sessions.list 超时是**服务端侧**无法及时应答（gateway event-loop starvation）

### 8.3 维持现状的理由

| 考量 | 说明 |
|------|------|
| 用户影响为零 | sessions.list 用于 context token 查询和 channel session 发现，超时仅导致数据延迟刷新，不影响 agent/tool 执行流 |
| 现有防护已充分 | `isGatewayRpcDegraded()` 在首次超时后 30s 内跳过后续调用，避免无意义重试 |
| ChannelSync backoff | 超时后 polling 自动退避，exec 结束后下一周期恢复正常 |
| 根因在上游 | gateway event-loop starvation 需 openclaw 侧修复（#83366 OPEN），智码 GLM Code 侧无法从根本解决 |
| 改动风险 > 收益 | 增加"exec 期间跳过 poll"等逻辑会引入状态耦合，收益仅为减少 warn 日志 |

**结论**：当前行为符合预期设计，warn 日志作为可观测性信号保留，不做代码修改。

## 9. 上游参考

- [openclaw/openclaw#83366](https://github.com/openclaw/openclaw/issues/83366) — Gateway event-loop starvation (P1, OPEN)
- [openclaw/openclaw#56733](https://github.com/openclaw/openclaw/issues/56733) — Gateway alive but event loop frozen (P1, OPEN)
- [openclaw/openclaw#76086](https://github.com/openclaw/openclaw/pull/76086) — heartbeat cooldown (MERGED, 解决心跳 runaway 但不解决 tick starvation)
