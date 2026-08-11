# MCP stdio 进程泄漏修复设计文档

## 1. 概述

### 1.1 问题

智码 GLM Code 桌面端运行期间，Node.js 进程不断增殖。每新建一个对话（无论是否用到 MCP 工具），都会额外产生 N 个 Node.js 子进程（N = 已配置的 stdio MCP server 数量）。这些进程永远不会被释放，直到用户退出应用。

典型表现：配置 3 个 MCP server，开 5 个对话 → 任务管理器中出现 15 个 Node.js 进程。

### 1.2 根因

OpenClaw 的 `SessionMcpRuntimeManager` 以 **sessionId** 为 key 管理 MCP 连接。每个 session 拥有独立的 stdio 子进程组。

智码 GLM Code 桌面端每个对话对应一个**独立的 gateway session key**（`agent:{agentId}:lobsterai:{uuid}`），新建对话 = 新 sessionId = 新 MCP 进程。

释放路径的缺陷：

| 路径 | 是否触发释放 | 原因 |
|------|---|---|
| Run 结束（`cleanupBundleMcpOnRunEnd`） | 否 | Gateway 模式下为 `false`，设计意图是同 session 内复用 |
| `sessions.delete` / `sessions.reset` | 否 | `ensureSessionRuntimeCleanup` 未调用 `disposeSessionMcpRuntime` |
| Session freshness 过期自动 rollover | 否 | 仅在 auto-reply 路径（IM 渠道）生效，desktop gateway RPC 路径不走此逻辑 |
| 用户手动删除对话 | 否 | `onSessionDeleted` 只清理 智码 GLM Code 侧状态，不通知 gateway |

结论：对于 智码 GLM Code 桌面端的 gateway 模式，**不存在任何有效的 MCP 进程释放路径**。

### 1.3 上游关联

openclaw/openclaw 仓库中的相关 issue：
- #70364 — MCP child process leak: sessions_send via gateway never calls disposeSessionMcpRuntime
- #70808 — Gateway never disposes stdio MCP runtimes on session end
- #82830 — MCP stdio server processes leak on Windows (fix in v2026.4.22+)

当前 runtime 版本 v2026.4.14 未包含修复。

## 2. 用户场景

### 场景 1: 正常多对话使用
**Given** 用户配置了 3 个 MCP server（Context7, mcp-19a3c673, Playwright）
**When** 用户在一次使用中依次新建 5 个对话（无论对话内容是否涉及 MCP）
**Then** 只应有 3 个 MCP 相关 Node.js 进程存在（全局共享），而非 15 个

### 场景 2: MCP 配置变更
**Given** 用户在设置中新增了一个 MCP server
**When** 下一个对话开始时
**Then** 旧的 3 个进程被释放，新的 4 个进程启动（配置指纹变化触发重建）

### 场景 3: 回到旧对话继续
**Given** 用户 10 分钟前创建了对话 A，之后创建了对话 B
**When** 用户切回对话 A 继续提问
**Then** 直接复用全局共享的 MCP 连接，无任何延迟或进程增加

## 3. 功能需求

### FR-1: 按配置指纹共享 MCP runtime

相同 MCP 配置（config fingerprint 相同）的所有 session 共享同一个 runtime 实例及其 stdio 子进程。

### FR-2: 引用计数管理生命周期

runtime 实例通过引用计数关联到使用它的 session。只有当最后一个 session 释放引用时，才真正 dispose runtime（关闭连接、杀进程）。

### FR-3: 配置变更自动迁移

当 session 检测到 fingerprint 变化时（MCP server 增删改），自动从旧 runtime 解引用，关联到新 runtime。旧 runtime 在引用归零后销毁。

### FR-4: 保持接口兼容

`SessionMcpRuntimeManager` 的对外接口（`getOrCreate`, `disposeSession`, `disposeAll`, `listSessionIds`）保持不变，外部调用者无需修改。

## 4. 实现方案

### 4.1 改动范围

仅修改 `src/agents/pi-bundle-mcp-runtime.ts` 中的 `createSessionMcpRuntimeManager()` 函数内部实现。

### 4.2 数据结构替换

```
// 旧
runtimesBySessionId: Map<sessionId, SessionMcpRuntime>
createInFlight: Map<sessionId, {promise, workspaceDir, configFingerprint}>

// 新
runtimesByFingerprint: Map<fingerprint, SessionMcpRuntime>
refsByFingerprint: Map<fingerprint, Set<sessionId>>
fingerprintBySessionId: Map<sessionId, fingerprint>
createInFlight: Map<fingerprint, Promise<SessionMcpRuntime>>
```

### 4.3 核心逻辑

**getOrCreate:**
1. 计算当前 fingerprint
2. 如果该 session 之前关联了不同 fingerprint → 解引用旧的（引用归零则 dispose）
3. 查 `runtimesByFingerprint[fingerprint]` → 命中则 addRef + markUsed + return
4. 查 `createInFlight[fingerprint]` → 命中则 await + addRef + return
5. 创建新 runtime → 存入 `runtimesByFingerprint` → addRef → return

**disposeSession:**
1. 查 `fingerprintBySessionId[sessionId]` → 得到 fingerprint
2. removeRef(fingerprint, sessionId)
3. 如果是最后一个引用 → dispose runtime + 从 `runtimesByFingerprint` 删除

### 4.4 交付形式

以 git patch 文件形式交付，位于 `scripts/patches/v2026.4.14/openclaw-mcp-shared-runtime.patch`，通过 `npm run openclaw:patch` 应用。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 并发创建（多个 session 同时首次请求相同 fingerprint） | `createInFlight` 按 fingerprint 去重，第二个等待第一个完成后共享 |
| disposeSession 被调用但还有其他 session 在用 | 仅移除引用，不 dispose runtime |
| disposeAll 被调用 | 清空所有 map，dispose 所有 runtime（gateway 关闭时） |
| 某个 MCP server 连接失败 | 与之前行为一致：跳过该 server，其余正常工作 |
| CLI 本地模式 `cleanupBundleMcpOnRunEnd=true` | disposeSession 被调用，若是唯一使用者则正常销毁 |
| 配置热更新导致 fingerprint 变化 | 下次 getOrCreate 时检测到变化，旧 runtime 在引用归零后清理 |

## 6. 涉及文件

| 文件 | 改动类型 |
|------|---------|
| `scripts/patches/v2026.4.14/openclaw-mcp-shared-runtime.patch` | 新增 patch |
| `src/agents/pi-bundle-mcp-runtime.ts`（openclaw 源码） | patch 目标 |

## 7. 验收标准

1. 配置 3 个 stdio MCP server，连续新建 5 个对话 → 任务管理器中始终只有 3 个对应 Node.js 进程
2. 在任意对话中发送涉及 MCP 的提问 → 工具正常调用
3. 在设置中新增/删除 MCP server 后发起新对话 → 进程数正确反映新配置
4. 退出应用 → 所有 MCP 子进程正常退出
5. `npm run openclaw:patch` 可正常应用 patch，无冲突
