# MCP 启动解析优化设计文档

## 1. 概述

### 1.1 问题/背景

智码 GLM Code 当前通过 OpenClaw 执行 MCP。对于 stdio 类型的 MCP，用户常见配置是 `npx -y <package>@latest`。这类配置在 OpenClaw 首次启动 MCP 时会触发 npm 包解析、缓存检查、下载或安装等流程，容易拖慢首次响应。

日志排查显示，启动后首次响应慢主要卡在 OpenClaw MCP 工具物化阶段。由于当前使用的 OpenClaw 版本为 `v2026.4.14`，距离新版已有差距，且本地对 MCP 相关逻辑做过 patch，直接大幅升级 OpenClaw 或替换 OpenClaw MCP 运行时风险较高。

本方案在 智码 GLM Code MCP 管理侧增加“启动解析”能力：安装或启用 MCP 时，先由 智码 GLM Code 解析并本地化可优化的启动命令，再把最终可执行路径写给 OpenClaw。OpenClaw 仍负责实际 MCP 进程执行，智码 GLM Code 只负责把慢路径前置并持久化。

### 1.2 目标

- 对 `npx` stdio MCP 前置执行 npm 包解析与安装，避免每次 OpenClaw 启动 MCP 时重复走 `npx` 慢路径。
- 将解析结果持久化，后续 OpenClaw 配置同步直接使用稳定的 `node <absolute-bin-path>` 启动形式。
- 在 MCP 管理界面展示解析状态，失败时允许用户重试。
- 当前只实现 `npx` 优化，但数据结构和状态模型预留 `uvx`、`python` 等 resolver 扩展空间。
- 增加关键路径日志和计时，便于后续继续排查 MCP 启动耗时。

## 2. 用户场景

### 场景 1: 安装市场中的 npx MCP

**Given** 用户在 MCP 管理页安装一个 stdio MCP，命令为 `npx -y @upstash/context7-mcp@latest`
**When** 用户保存并启用该 MCP
**Then** 智码 GLM Code 后台进入启动解析阶段，执行 npm metadata 查询和本地安装，并在完成后把优化后的启动命令同步给 OpenClaw。

### 场景 2: 解析未完成时开始对话

**Given** 某个 npx MCP 正在安装或等待解析
**When** 用户立即发起 Cowork 会话
**Then** 智码 GLM Code 不阻塞当次会话启动，该 MCP 暂不写入 OpenClaw 配置；解析完成后再次触发配置同步。

### 场景 3: 解析失败后重试

**Given** 某个 npx MCP 因网络、npm registry 或包信息异常解析失败
**When** 用户在 MCP 管理页点击“重试”
**Then** 智码 GLM Code 重新执行该 MCP 的启动解析，并更新状态与 OpenClaw 配置同步结果。

### 场景 4: 不支持的 stdio 命令

**Given** 用户配置了暂不支持优化的 stdio 命令，例如复杂 `npx --package` 参数或 `uvx` 命令
**When** OpenClaw 配置同步发生
**Then** 智码 GLM Code 不破坏原始配置；不支持优化的命令回退到原始启动方式。

## 3. 功能需求

### FR-1: 启动解析状态持久化

系统应持久化每个 MCP server 的启动解析状态，包括：

- resolver 类型：`npx`、`uvx`、`python`、`raw`。
- 状态：`pending`、`installing`、`ready`、`failed`、`unsupported`。
- 源配置指纹，用于判断用户修改命令、参数、环境变量后旧解析结果是否失效。
- npm 包名、请求版本、解析版本、本地安装目录。
- 最终写给 OpenClaw 的 `command`、`args`、`env`。
- 错误信息和关键时间戳。

### FR-2: npx MCP 前置安装

当 MCP server 是启用状态、transport type 为 `stdio` 且 command 为 `npx` 或 `npx.cmd` 时，系统应尝试识别 `npx -y <package>@<version>` 形式，并执行：

1. `npm view <package>@<version> version --json`
2. `npm install --prefix <managed-dir> --omit=dev --no-audit --no-fund <package>@<version>`
3. 读取安装包 `package.json` 的 `bin` 字段。scoped npm 包必须按 `node_modules/@scope/name` 解析，不能去掉 `@scope` 前缀。
4. 生成 `node <absolute-bin-path> ...extraArgs` 作为 OpenClaw 启动命令

### FR-3: OpenClaw 配置同步使用 ready 结果

OpenClaw 配置同步时：

- 若 `ready` 状态与当前源配置指纹匹配，则写入优化后的 `command/args/env`。
- 若状态为 `pending` 或 `installing`，则跳过该 MCP，并异步继续解析。
- 若状态为 `installing` 但当前进程没有对应 in-flight 任务，且记录更新时间已超过安装超时宽限，应视为历史中断状态并重新触发解析，避免应用重启或安装进程异常退出后永久卡住。
- 若状态为 `failed`，则跳过该 MCP，避免当次会话继续被慢路径或失败路径拖住。
- 若状态为 `unsupported`，则回退原始命令。

### FR-4: UI 状态展示和重试

MCP 管理页应展示启动解析状态：

- 等待解析
- 正在安装
- 已优化
- 安装失败
- 使用原始命令

当状态为安装失败时，应提供重试入口。状态变化通过主进程事件通知 renderer 刷新。

### FR-5: 关键路径日志

主进程应记录以下计时日志：

- MCP 启动解析开始与完成耗时。
- npm metadata 查询耗时。
- npm install 耗时。
- OpenClaw 配置同步时 enabled、optimized、raw、skipped 统计和耗时。
- 解析失败时的错误对象与耗时。

## 4. 实现方案

### 4.1 数据表

新增 SQLite 表 `mcp_launch_resolutions`，以 `server_id` 为主键，存储启动解析结果。MCP server 删除时同步删除对应解析记录。

### 4.2 解析管理器

新增 `McpLaunchResolverManager`，负责：

- 判断 server 是否可优化。
- 根据源配置指纹判断 ready 结果是否可复用。
- 串行化同一 server 的解析任务，避免重复安装。
- 执行 npm 查询、安装、bin 解析。
- 将解析状态写入 `McpStore`。
- 状态变化后通知 UI 并触发 OpenClaw config sync。

### 4.3 IPC 与 UI

新增 MCP IPC 常量并集中管理，避免裸字符串：

- `mcp:list`
- `mcp:create`
- `mcp:update`
- `mcp:delete`
- `mcp:setEnabled`
- `mcp:retryLaunchResolution`
- `mcp:fetchMarketplace`
- `mcp:changed`

renderer MCP service 增加 `retryLaunchResolution` 和 `onChanged`。MCP 管理页订阅变化事件并刷新列表。

### 4.4 OpenClaw 配置写入

OpenClaw 仍是 MCP 的最终执行方。智码 GLM Code 只在写入 OpenClaw 配置前把 server 配置转换为更稳定的启动路径：

```text
npx -y package@latest
```

转换为：

```text
node <userData>/openclaw/mcp-packages/<server>/<package>/node_modules/<package>/<bin>
```

这样后续 OpenClaw 不再需要每次通过 `npx` 解析包。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| npm 不可用 | 记录 failed，UI 展示失败并允许重试 |
| npm install 超时 | 记录 failed，不阻塞当次会话 |
| 包没有 bin 字段 | 记录 failed |
| 包有多个 bin 字段 | 优先选择与包名匹配的 bin，否则选择第一个 |
| scoped npm 包 | 安装路径按 `node_modules/@scope/name` 解析 |
| 用户修改 command/args/env | 源配置指纹变化，旧 ready 结果失效并重新解析 |
| 历史 `installing` 记录 | 若无当前 in-flight 任务且已超时，重新触发解析 |
| 当前命令不是 npx | 标记或视为 unsupported/raw，保留原始启动方式 |
| npx 参数形态暂不支持 | 回退原始启动方式，避免破坏已有 MCP |

## 6. 涉及文件

- `src/main/mcpLaunchResolution.ts`
- `src/main/mcpLaunchResolverManager.ts`
- `src/main/mcpLaunchResolverManager.test.ts`
- `src/main/mcpStore.ts`
- `src/main/sqliteStore.ts`
- `src/main/main.ts`
- `src/main/preload.ts`
- `src/shared/mcp/constants.ts`
- `src/renderer/services/mcp.ts`
- `src/renderer/types/mcp.ts`
- `src/renderer/types/electron.d.ts`
- `src/renderer/components/mcp/McpManager.tsx`
- `src/renderer/services/i18n.ts`

## 7. 验收标准

- 新增或启用 `npx -y <package>@latest` MCP 后，MCP 管理页展示“正在安装”，完成后展示“已优化”。
- `mcp_launch_resolutions` 中存在该 server 的 ready 记录，并包含最终 `command/args`。
- OpenClaw 配置同步日志包含 optimized/raw/skipped 统计。
- npm 解析失败时，MCP 管理页展示“安装失败”，点击重试后重新解析。
- 解析失败或安装中不阻塞 Cowork 首次响应。
- scoped npm 包安装成功后能正确读取 `node_modules/@scope/name/package.json` 并生成 ready 记录。
- 应用重启或进程中断留下的陈旧 `installing` 记录会在后续配置同步时自动重试。
- 不支持的 stdio 命令继续按原始命令写入 OpenClaw。
- `npm run build -- --mode development` 通过。
