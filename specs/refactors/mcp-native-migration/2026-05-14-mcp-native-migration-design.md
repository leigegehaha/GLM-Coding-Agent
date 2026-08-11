# MCP 原生迁移设计文档

## 1. 概述

### 1.1 问题/动机

智码 GLM Code 在较早版本中自行实现了 MCP (Model Context Protocol) 集成方案（mcp-bridge），通过 HTTP callback 在 OpenClaw gateway 与 MCP 服务器之间中转工具调用。该方案随迭代暴露出多项问题：

- **Windows Electron stdin 兼容性差**：打包环境下 stdio transport 不稳定
- **abort 信号误触**：`req.close` vs `res.close` 导致工具调用被意外取消
- **WSL bash null byte 污染**：环境变量中的 `\x00` 导致 MCP 服务器发现 0 工具
- **gateway 硬重启**：工具清单变化时必须重启 gateway，中断对话
- **无自动重连/重试**：服务器断连后不会恢复
- **额外网络跳**：tool call 经 HTTP 中转增加延迟和故障点

OpenClaw 已内置成熟的 MCP Client 模式（`mcp.servers` 配置字段），支持：
- 懒加载（首次 listTools 时才连接）
- SHA1 指纹热重载（配置变更无需 gateway 重启）
- 会话隔离（每个 agent session 独立 runtime）
- 空闲 runtime GC
- 完整 transport 支持（stdio/SSE/streamable-http）

### 1.2 目标

1. 移除 mcp-bridge 中间层，改用 OpenClaw 原生 `mcp.servers` 配置
2. 保留 ask-user-question 功能（HTTP callback 机制不变）
3. 保留 stdio 命令预解析逻辑（Windows/macOS 打包兼容性）
4. 简化 UI 层（移除 bridge sync 状态展示）
5. 消除 MCP 配置变更导致的 gateway 硬重启

---

## 2. 现状分析

### 2.1 当前架构

```
McpStore (SQLite)
    ↓ getEnabledServers()
McpServerManager
    ├→ resolveStdioCommand() (Windows/macOS 命令解析)
    ├→ StdioClientTransport / SSEClientTransport / StreamableHTTPClientTransport
    ├→ client.listTools() → 工具发现
    └→ callTool() → 工具执行
          ↑
McpBridgeServer (HTTP localhost)
    ├→ POST /mcp/execute → callTool 代理
    └→ POST /askuser → 用户确认弹窗
          ↑
OpenClaw Gateway
    ├→ mcp-bridge plugin → 调用 /mcp/execute
    └→ ask-user-question plugin → 调用 /askuser
```

**配置注入路径**：
- `openclawConfigSync` 将工具清单注入 `openclaw.json` → `plugins.entries['mcp-bridge'].config.tools`
- gateway 启动时读取并固定配置 → 工具变化需硬重启

### 2.2 问题文件清单

| 文件 | 职责 | 问题 |
|------|------|------|
| `src/main/libs/mcpServerManager.ts` | 服务器连接 & 工具发现 | 整个类将被 OpenClaw 原生替代 |
| `src/main/libs/mcpBridgeServer.ts` | HTTP callback server | /mcp/execute 不再需要 |
| `src/main/libs/mcpLog.ts` | MCP 日志工具 | 仅被 mcpServerManager 使用 |
| `src/main/libs/openclawConfigSync.ts` | 配置同步 | mcp-bridge plugin 注入逻辑需替换 |
| `src/main/main.ts` | 主进程集成 | startMcpBridge/refreshMcpBridge 需重写 |

---

## 3. 方案设计

### 3.1 目标架构

```
McpStore (SQLite) — 不变
    ↓ getEnabledServers()
resolveStdioCommand() — 独立模块（从 mcpServerManager 提取）
    ↓ 预解析后的配置
openclawConfigSync
    ↓ 写入 openclaw.json → mcp.servers
OpenClaw Gateway（原生 MCP Client）
    ├→ 懒连接 MCP 服务器
    ├→ 工具发现 & 物化
    └→ 工具调用（进程内直连）

McpBridgeServer（简化为 AskUser-only）
    └→ POST /askuser → 用户确认弹窗
          ↑
OpenClaw Gateway
    └→ ask-user-question plugin → 调用 /askuser
```

### 3.2 配置格式

**openclaw.json 中的 MCP 配置**：
```json
{
  "mcp": {
    "servers": {
      "memory-server": {
        "command": "C:/Users/.../node.exe",
        "args": ["npx-cli.js", "@anthropic-ai/mcp-server-memory"],
        "env": { "ELECTRON_RUN_AS_NODE": "1" }
      },
      "remote-docs": {
        "url": "https://mcp.example.com",
        "headers": { "Authorization": "Bearer ${API_TOKEN}" }
      },
      "streaming-api": {
        "url": "https://api.example.com/mcp",
        "transport": "streamable-http"
      }
    }
  },
  "plugins": {
    "entries": {
      "ask-user-question": {
        "enabled": true,
        "config": {
          "callbackUrl": "http://127.0.0.1:54321/askuser",
          "secret": "${LOBSTER_MCP_BRIDGE_SECRET}"
        }
      }
    }
  }
}
```

### 3.3 转换逻辑

McpStore 记录 → OpenClaw 格式映射：

| transportType | 输出字段 |
|---------------|---------|
| `stdio` | `{ command, args, env }` (预解析后) |
| `sse` | `{ url, headers }` |
| `http` | `{ url, headers, transport: "streamable-http" }` |

---

## 4. 实施步骤

### Step 1: 提取 resolveStdioCommand 为独立模块

**新建** `src/main/libs/resolveStdioCommand.ts`

从 `mcpServerManager.ts` (L210-312) 提取：
- `resolveStdioCommand()` 主函数
- `isNodeCommand()`、`findSystemNodePath()`、`getElectronNodeRuntimePath()`
- `ensureWindowsHideInitScript()`、`prependRequireArg()`
- `getEnhancedEnv()` 引用
- `ResolvedStdioCommand` 类型

### Step 2: 修改 openclawConfigSync.ts

**移除**：
- `McpBridgeConfig` 类型 (L54-59)
- `McpToolManifestEntry` import (L29)
- `normalizeMcpToolInputSchemaForOpenAI()` (L888-910)
- `normalizeMcpBridgeToolManifestEntry()` (L912-917)
- `getMcpBridgeConfig` 依赖 (L952, 976, 1001)
- `hasMcpBridgePlugin` 检测 (L1202) & plugin entry (L1426)
- mcp-bridge config 注入块 (L1472-1492)
- `mcpBridgeConfigChanged` 检测 (L2034-2057)
- `OpenClawConfigSyncResult.mcpBridgeConfigChanged` 字段

**新增**：
- 依赖: `getResolvedMcpServers?: () => ResolvedMcpServer[]`
- 依赖: `getAskUserCallbackUrl?: () => string | null`
- `buildOpenClawMcpServers()` 转换函数
- `managedConfig.mcp = { servers: ... }` 写入

**保留**：
- ask-user-question plugin entry (改用 `getAskUserCallbackUrl`)
- `LOBSTER_MCP_BRIDGE_SECRET` env var 注入
- `getMcpBridgeSecret` 依赖
- `mcporter` disabled entry (更新注释)

### Step 3: 简化 McpBridgeServer

**移除**：
- `McpServerManager` 构造函数参数和 private field
- `handleMcpExecute()` 方法
- `/mcp/execute` 路由
- `callbackUrl` getter
- `mcpLog`/`sanitizeForLog` imports

**保留**：
- `/askuser` 端点、secret 验证、callbacks
- 构造函数简化为 `constructor(secret: string)`

### Step 4: 重写 main.ts MCP 逻辑

**移除**：
- `McpServerManager` import、全局变量
- `startMcpBridge()` (L1522-1609)
- `refreshMcpBridge()` (L1646-1694)
- `broadcastMcpBridgeSync()` / `mcpBridgeRefreshPromise`
- `getMcpBridgeConfig` callback (L1160-1169)
- `syncOpenClawConfig()` 中 `mcpBridgeConfigChanged` → 硬重启逻辑
- IPC: `mcp:refreshBridge` (L2932-2939)
- Events: `mcp:bridge:syncStart` / `mcp:bridge:syncDone`

**新增**：
- `startAskUserServer()` — 仅启动 HTTP + 注册 askUser 回调
- `getResolvedMcpServers()` — 获取 enabled servers + resolveStdioCommand
- 传入 configSync deps: `getResolvedMcpServers`, `getAskUserCallbackUrl`

**修改**：
- IPC handlers (create/update/delete/setEnabled): 操作 store 后直接 `syncOpenClawConfig()`
- bootstrap: `startMcpBridge()` → `startAskUserServer()`

### Step 5: 简化 Renderer 层

- `src/renderer/services/mcp.ts` — 移除 `refreshBridge()`、`onBridgeSyncStart/Done()`
- `src/renderer/components/mcp/McpManager.tsx` — 移除 bridgeSyncing 状态、sync overlay、result banner
- `src/main/preload.ts` — 移除对应 IPC expose
- `src/renderer/types/electron.d.ts` — 移除对应类型

### Step 6: 删除废弃文件

- `src/main/libs/mcpServerManager.ts`
- `src/main/libs/mcpLog.ts`
- `src/main/libs/mcpLog.test.ts`

---

## 5. 涉及文件

| 文件 | 操作 |
|------|------|
| `src/main/libs/resolveStdioCommand.ts` | **新建** |
| `src/main/libs/openclawConfigSync.ts` | 重点修改 |
| `src/main/libs/mcpBridgeServer.ts` | 简化 |
| `src/main/main.ts` | 重点修改 |
| `src/renderer/services/mcp.ts` | 简化 |
| `src/renderer/components/mcp/McpManager.tsx` | 简化 |
| `src/main/preload.ts` | 简化 |
| `src/renderer/types/electron.d.ts` | 简化 |
| `src/main/libs/mcpServerManager.ts` | **删除** |
| `src/main/libs/mcpLog.ts` | **删除** |
| `src/main/libs/mcpLog.test.ts` | **删除** |

---

## 6. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 无 enabled MCP 服务器 | 不写入 `mcp.servers` 字段（或写入空对象） |
| stdio 服务器系统 Node.js 不存在 | 预解析逻辑回退到 Electron runtime + WARN 日志 |
| MCP 服务器名称含特殊字符 | OpenClaw 内部做名称安全化（`serverName___toolName`）|
| 旧版 openclaw.json 残留 mcp-bridge 字段 | configSync 全量覆写 plugins.entries，不会残留 |
| 用户 disable 所有服务器 | `mcp.servers` 为空对象或不写入 |
| 配置变更后工具变化 | OpenClaw SHA1 指纹检测，下次 agent session 自动 reload |

---

## 7. 验证计划

1. **编译检查**: `npm run build` 无 TypeScript 错误
2. **openclaw.json 校验**: 启动应用，检查生成的 openclaw.json 包含正确的 `mcp.servers`，不包含 `plugins.entries['mcp-bridge']`
3. **stdio MCP 服务器**: 添加 `npx @anthropic-ai/mcp-server-memory`，确认预解析正确、工具可用
4. **远程 MCP 服务器**: 添加 SSE/HTTP 类型服务器，确认连接和工具调用正常
5. **ask-user-question**: 触发需要用户确认的操作，确认弹窗正常显示和响应
6. **热重载**: 添加/移除 MCP 服务器后无需 gateway 重启，工具在下次对话中可用
7. **UI 简化**: 确认不再有 sync 遮罩/spinner，配置操作响应即时
8. **回归测试**: `npm run test` 确认无回归
