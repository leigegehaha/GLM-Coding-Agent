# IM 消息使用绑定 Agent 工作目录修复 Spec

## 1. 概述

### 1.1 问题

用户在 智码 GLM Code 中给微信、飞书等 IM 渠道完成绑定后，从 IM 中询问“当前的工作目录是哪里”，回复显示的是默认的 智码 GLM Code 目录，而不是用户在 智码 GLM Code 中选择的任务工作目录。

同一用户在 智码 GLM Code 桌面内新建任务并询问相同问题时，回复是正确的用户选择目录。

后续复查发现一个更具体的回归：IM 端现在不再总是回答 智码 GLM Code 默认目录，而是统一回答主 Agent 的工作目录。这个结果仍然不正确，因为微信、飞书、钉钉、网易 IM 等不同 IM 入口可以绑定到不同 Agent。IM 入站任务的 cwd 必须由“该 IM 账号/实例/会话路由到的 Agent”决定，不能统一使用 main Agent。

这个现象说明“桌面 Cowork 新建任务”和“IM 入站消息”实际走了不同的 cwd 注入路径。不能只看本地 `cowork_sessions.cwd` 是否正确，还必须确认 OpenClaw channel run 真正执行工具时使用的 cwd。

### 1.2 当前链路

桌面内新建任务链路：

1. `src/renderer/components/cowork/CoworkView.tsx` 从当前 Agent 的 `workingDirectory` 计算 `currentAgentWorkingDirectory`。
2. `cowork:session:start` 在 `src/main/main.ts` 中调用 `resolveSessionWorkingDirectory()`，按 `options.cwd -> agent.workingDirectory -> cowork_config.workingDirectory` 解析目录。
3. 新 session 创建时把解析结果写入 `cowork_sessions.cwd`。
4. `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` 在 `chat.send` 参数中写入 `cwd: session.cwd`。

所以桌面任务能正确回答 cwd，是因为每次由 智码 GLM Code 主动调用 `chat.send` 时都会显式传入 session cwd。

IM 入站消息链路：

1. 微信、飞书、钉钉等平台主要由 OpenClaw channel plugin 接收消息。
2. channel plugin 解析 route 和 `sessionKey` 后，调用 OpenClaw 的 channel reply dispatch，例如微信的 `dispatchReplyFromConfig()`、飞书的 `dispatchReplyFromConfig()`。
3. 智码 GLM Code 通过 `OpenClawChannelSessionSync` 发现 gateway 里的 channel session，并在本地创建或复用 Cowork session。
4. `OpenClawChannelSessionSync` 创建本地 session 时会调用 `getDefaultCwd(agentId)`，因此本地 `cowork_sessions.cwd` 可以是正确的。

关键差异是：第 4 步发生在 OpenClaw channel run 已经由 gateway 发起之后。本地 Cowork session 的 cwd 只是同步结果，不会反向影响已经开始的 IM 回复。

### 1.3 根因

根因不是单一的 Agent 绑定配置缺失，而是 IM channel run 的“路由到哪个 Agent”和“用哪个 cwd 执行”没有在同一处闭环。

具体证据：

- `OpenClawRuntimeAdapter.runTurn()` 会从 `session.cwd` 计算 `runCwd`，并把它传给 `chat.send`。这只覆盖 智码 GLM Code 桌面主动发起的任务。
- IM channel plugin 入站路径不经过 智码 GLM Code 的 `runtime.startSession()`，也不会使用 `OpenClawRuntimeAdapter` 的 `chat.send.cwd`。
- `OpenClawChannelSessionSync.resolveOrCreateSession()` 虽然会用 `getDefaultCwd(agentId)` 创建本地 session，但这是后置同步，不能改变 OpenClaw 已经用于执行的 cwd。
- 当前 `OpenClawConfigSync` 写出的 `agents.defaults.workspace` 是 智码 GLM Code 管理的 OpenClaw workspace，用于 Agent 记忆和 bootstrap 文件；用户选择的任务目录被写到 `agents.defaults.cwd` / `agents.list[].cwd`。
- 当前随包 OpenClaw v2026.4.14 的 plugin-sdk 类型已声明 `agents.defaults.cwd` / `agents.list[].cwd` 可作为 Agent run cwd，并且 reply run 参数也包含 `cwd`；因此 智码 GLM Code 侧必须确保配置写出和 runtime 刷新正确。
- `syncOpenClawConfig({ reason: 'agent-updated' })` 在 Agent 工作目录变化后默认不硬重启 gateway。即使未来 OpenClaw 支持 per-agent cwd，运行中的 channel runtime 也可能继续使用旧配置快照。

因此，桌面任务正确而 IM 错误是合理的：桌面任务有 per-run `chat.send.cwd`，IM channel run 只有 OpenClaw runtime 自己解析出来的 workspace/default cwd。

### 1.4 本轮复查结论

这次“所有 IM 都回答 main Agent 工作目录”的现象，说明前一轮只把 `agents.defaults.cwd` 改为 main Agent 工作目录并不够。它让 fallback cwd 从 智码 GLM Code 默认目录变成了 main Agent 目录，但没有保证非 main Agent 的 channel run 消费自己的 `agents.list[].cwd`。

当前定位到两个独立问题：

1. Agent 路由问题：IM 入站消息必须先按 `channel + accountId + peer` 解析到绑定 Agent。OpenClaw core `resolveAgentRoute()` 支持 `accountId: '*'` 的 channel 级通配绑定，但钉钉 connector 有一段自定义 binding 匹配逻辑，代码按字面比较 `match.accountId !== accountId`，不会把 `'*'` 当通配符。因此钉钉的平台级绑定可能直接落回 `cfg.defaultAgent || 'main'`。
2. cwd 解析问题：即使路由已经得到正确的 `route.agentId`，微信、飞书、网易 Bee、网易 IM 等 channel plugin 调用 `dispatchReplyFromConfig()` 时没有传入 `replyOptions.cwd`。随包 gateway bundle 中的 Agent 配置 helper 当前只暴露了 `workspace` / `agentDir` / model / tools 等字段，没有把 `agents.list[].cwd` 合并到 Agent runtime scope。结果是 channel reply run 仍可能使用 default cwd，也就是 main Agent cwd。

所以真正的修复边界是：每一条 IM 入站消息必须以 resolved `agentId` 为输入，显式解析 `resolvedRunCwd`，并把它传给实际 agent run。只修正 `openclaw.json`、只修正本地 Cowork session、只重启 gateway，都不能单独证明 IM 执行 cwd 已经正确。

## 2. 用户场景

### 场景 A: 微信绑定到主 Agent 后使用当前 Agent 工作目录

**Given** 用户在主 Agent 中选择工作目录 `/repo/user-project`，并绑定微信
**When** 用户在微信中发送“当前的工作目录是哪里”
**Then** 回复和工具执行 cwd 都应指向 `/repo/user-project`，而不是 智码 GLM Code 默认目录或 OpenClaw workspace。

### 场景 B: 飞书绑定到非 main Agent

**Given** Agent B 的默认工作目录为 `/repo/agent-b`，飞书绑定到 Agent B
**When** 用户在飞书中询问 cwd 或让 Agent 执行 `pwd`
**Then** OpenClaw 实际执行目录应为 `/repo/agent-b`。

### 场景 C: 修改 Agent 工作目录后继续从同一个 IM 对话提问

**Given** 某 IM 对话已经存在 channel session，原 cwd 为 `/repo/old`
**When** 用户在 智码 GLM Code 中把绑定 Agent 的工作目录改为 `/repo/new`
**Then** 后续 IM 消息不应继续沿用 `/repo/old` 或默认目录。

### 场景 D: 桌面任务行为不回退

**Given** 用户在 智码 GLM Code 桌面内新建任务
**When** 任务由 `cowork:session:start` 创建
**Then** 仍然通过 `chat.send.cwd` 使用 session 快照目录，不受 IM 修复影响。

### 场景 E: IM 发起任务的文件型结果落在 Agent 工作目录

**Given** Agent B 的默认工作目录为 `/repo/agent-b`，飞书绑定到 Agent B
**When** 用户在飞书里要求“生成一份总结文档/图片/PPT/数据文件”
**Then** 生成的最终文件应默认保存到 `/repo/agent-b` 或其子目录，而不是 智码 GLM Code 应用目录、OpenClaw workspace、`~/.openclaw/workspace-*` 或临时目录。

**And** IM 回复中提到的文件路径、媒体发送路径、本地 Cowork session 里的文件链接都应指向同一份用户工作目录内的结果文件。

## 3. 功能需求

### FR-1: IM channel run 必须使用绑定 Agent 的用户任务目录

OpenClaw channel run 的实际执行 cwd 必须先根据当前 IM 来源解析绑定 Agent，再按该 Agent 解析目录：

1. 通过 `channel + accountId + peer` 得到 `resolvedAgentId`。
2. channel run 显式 cwd，如果 gateway 或 channel plugin 已传入该入口。
3. `agents.list[resolvedAgentId].cwd`，也就是该 Agent 的 `workingDirectory`。
4. 如果 `resolvedAgentId` 是 main/default Agent，才使用 `agents.defaults.cwd`。
5. legacy `cowork_config.workingDirectory`。
6. 最后才是 OpenClaw workspace fallback。

不能只更新 智码 GLM Code 本地 `cowork_sessions.cwd`，因为它不决定 IM 的真实执行目录。

非 main Agent 的 IM run 不允许在未检查自身 `cwd` 的情况下落到 `agents.defaults.cwd`。否则多个 IM 绑定到不同 Agent 时，都会表现为 main Agent 工作目录。

### FR-2: 不把 Agent workspace 当成用户任务目录

智码 GLM Code 之前已经把 OpenClaw workspace 与用户项目 cwd 解耦。修复不应简单地把 `agents.list[].workspace` 改成用户选择目录，否则会把 `AGENTS.md`、`IDENTITY.md`、`USER.md`、Agent 记忆和 inbound media 等 OpenClaw 工作区文件写入用户项目。

正确方向是让 OpenClaw channel dispatch 支持独立的 run cwd，语义上与桌面 `chat.send.cwd` 一致。

### FR-3: Agent 工作目录变化必须刷新 channel runtime

当 `agents:update` 的 `workingDirectory` 字段发生变化时，必须保证运行中的 OpenClaw gateway 能看到新 cwd。

可接受实现：

- 如果 OpenClaw 支持热更新 channel runtime cwd，则调用明确的 runtime refresh API，并验证后续 channel run 使用新 cwd。
- 如果没有明确热更新能力，则对 `workingDirectory` 变化调用 `syncOpenClawConfig({ restartGatewayIfRunning: true })`，复用现有 active workload deferred restart 机制。

普通的 Agent 名称、图标、pinned 状态变化不应无差别触发硬重启。

### FR-4: 已存在 IM session 不得永久保留旧 cwd

修改绑定 Agent 的工作目录后，已有 IM 对话需要有明确处理策略：

- 优先方案：OpenClaw session 每次 run 都从当前 Agent 配置解析 cwd；gateway 刷新后，同一个 `sessionKey` 的下一轮自然使用新 cwd。
- 如果 OpenClaw 把 cwd 固化在 session 上，则需要新增或使用 `sessions.patch` 的 cwd 能力，针对 `im_session_mappings.openclaw_session_key` 逐个更新。
- 如果 `sessions.patch` 不支持 cwd，则需要使受影响的 channel session 失效并重建，同时避免把旧历史误同步到新本地 session。

修复不能只让“新 IM 对话”正确，而让已有微信/飞书对话继续错误。

### FR-5: IM 任务文件型结果必须默认写入 Agent 工作目录

正常 IM 端发起的任务如果产生文件型结果，例如文档、图片、PPT、表格、压缩包、代码文件、报告附件等，默认落盘目录必须是绑定 Agent 的用户任务目录。

落盘规则：

1. Agent 生成相对路径时，必须相对于真实 run cwd 解析，因此自然落在 `agent.workingDirectory` 下。
2. Agent 未指定文件名但工具/skill 需要创建最终文件时，默认输出目录应为真实 run cwd，而不是 OpenClaw workspace 或进程 cwd。
3. IM 回复中发送的媒体或文件应引用工作目录中的最终产物；如果发送平台需要临时上传副本，可以复制到平台临时目录，但源文件必须保留在 Agent 工作目录。
4. 用户明确指定绝对输出路径时，可以按现有工具权限策略处理；但普通 IM 任务的默认路径不得漂移到 OpenClaw workspace。

这里的“最终结果”指用户可见、需要后续复用的成果文件；IM 入站附件、下载缓存、平台上传临时文件、Agent 记忆和 bootstrap 文件仍可留在 OpenClaw workspace 或临时目录。

### FR-6: 诊断必须显示真实运行 cwd 和输出路径

验收时应以 OpenClaw 实际工具 cwd 为准，而不是只看 UI 或 SQLite。

建议增加 debug 级诊断：

- channel run 解析出的 `agentId`、`sessionKey`、`resolvedCwd`。
- `OpenClawChannelSessionSync` 创建或复用本地 session 时的 `localSession.cwd` 与 `resolvedAgentCwd`。
- 文件型结果创建或发送时的 `outputPath`、`sourcePath`、`resolvedCwd`，避免只看到 IM 发送成功却不知道文件真实落点。
- Agent 工作目录变化后是否触发 gateway refresh/restart，以及是否存在 active workload deferred restart。

日志必须符合现有日志规范：英文、自然语言、低频路径使用 debug，错误带 error object。

### FR-7: IM 绑定 Agent 与 cwd 解析必须同源

同一条 IM 入站消息中，以下值必须来自同一个 route 结果：

- `resolvedAgentId`
- `sessionKey`
- `resolvedRunCwd`
- 本地 `cowork_sessions.agentId`
- 本地 `cowork_sessions.cwd`

如果某个平台使用 OpenClaw core `resolveAgentRoute()`，就应从 `route.agentId` 解析 cwd。如果某个平台有自定义 binding 匹配逻辑，也必须保证该逻辑与 core routing 的 wildcard/priority 语义一致，不能一边用绑定 Agent 写 `sessionKey`，另一边用 main/default Agent 的 cwd。

## 4. 实现方案

### 4.1 确认 OpenClaw channel cwd 入口

先在随包 OpenClaw runtime 中确认 channel dispatch 是否已有可用 cwd 入口。

需要检查：

- `dispatchReplyFromConfig()` 是否可以接收类似 `cwd` / `workspaceDir` / run options 的参数。
- `agents.defaults.cwd` / `agents.list[].cwd` 是否被当前 runtime schema 接受并用于非 ACP channel run。
- `sessions.patch` 是否支持 cwd。

确认结果：

- 随包 OpenClaw v2026.4.14 的 `vendor/openclaw-runtime/current/dist/plugin-sdk/src/config/types.agent-defaults.d.ts` 已声明 `cwd` 是 “Optional runtime cwd for file tools and shell commands”。
- `vendor/openclaw-runtime/current/dist/plugin-sdk/src/config/types.agents.d.ts` 已声明 `agents.list[].cwd`。
- `vendor/openclaw-runtime/current/dist/plugin-sdk/src/auto-reply/get-reply-options.types.d.ts` 已声明 `GetReplyOptions.cwd`。
- `vendor/openclaw-runtime/current/dist/plugin-sdk/src/auto-reply/reply/agent-runner-utils.d.ts` 已声明 embedded run base params 包含 `cwd`。
- 微信 `openclaw-weixin/dist/src/messaging/process-message.js`、飞书 `openclaw-lark/src/messaging/inbound/dispatch.js`、网易 Bee `openclaw-netease-bee/src/inbound.ts` 都能解析 `route.agentId` / `sessionKey`，但调用 `dispatchReplyFromConfig()` 时没有传入 `replyOptions.cwd`。
- 钉钉 `dingtalk-connector` 没有走 core `resolveAgentRoute()`，而是自定义遍历 `cfg.bindings`。其 `match.accountId` 比较不支持 `'*'` 通配，且只解析 `agentWorkspaceDir`，没有解析 run cwd。
- gateway bundle 中当前 Agent scope helper 用于解析 `workspace` / `agentDir` / model / tools 等字段，但没有把 `agents.list[].cwd` 暴露为 Agent scope 字段。仅写出 `agents.list[].cwd` 不足以证明 channel run 会使用该 cwd。

因此配置写出是必要条件，但不是充分条件。后续实现必须让 channel reply run 在 dispatch 前得到明确的 `resolvedRunCwd`，并把它传入 `GetReplyOptions.cwd` 或 OpenClaw 等价 run 参数。

### 4.2 新增统一的 Agent run cwd 解析

需要在 OpenClaw channel runtime 或 智码 GLM Code 可维护的 channel glue 层新增统一解析函数，语义如下：

```text
explicit run cwd > agents.list[resolvedAgentId].cwd > agents.defaults.cwd when resolvedAgentId is main/default > legacy cowork cwd > agent workspace fallback
```

建议函数形态：

```text
resolveAgentRunCwd(cfg, resolvedAgentId, fallbackLegacyCwd?) -> string | undefined
```

要求：

- `workspace` 继续用于 Agent bootstrap、记忆、skills workspace 目录和附件落盘。
- `cwd` 只表示工具执行和“当前工作目录”的用户项目目录。
- 微信、飞书、钉钉、企业微信、QQ、Telegram、Discord、POPO、网易 IM 等 channel run 都应走同一套 cwd 解析，不能各自 fallback 到 main。
- cwd 必须在每轮 run 开始时解析，避免旧 session 永久固化旧目录。
- 文件写入、相对路径解析、`apply_patch`、文档/PPT/图片等技能的默认输出路径必须使用同一个 run cwd。
- 如果 `resolvedAgentId` 是非 main Agent，但它没有 `cwd`，允许 fallback 到 legacy 全局 cwd；但必须记录 debug，便于判断这是配置缺失而不是路由错误。

如果 OpenClaw 不接受顶层 `agents.list[].cwd`，需要在 runtime schema 和类型中新增该字段；如果已有但未被 channel dispatch 使用，则补齐 dispatch 到 embedded run 的传递。

### 4.3 channel dispatch 必须显式传入 cwd

所有 IM 入站 dispatch 都必须在拿到 `resolvedAgentId` 后传入同一个 `resolvedRunCwd`。

core routing 平台的处理方式：

1. 调用 `resolveAgentRoute()` 得到 `route.agentId` 和 `route.sessionKey`。
2. 调用 `resolveAgentRunCwd(cfg, route.agentId, legacyCwd)`。
3. 调用 `dispatchReplyFromConfig()` 或 `dispatchReplyWithBufferedBlockDispatcher()` 时传入：

```text
replyOptions: { ...replyOptions, cwd: resolvedRunCwd }
```

需要覆盖的已确认入口：

- 微信：`vendor/openclaw-runtime/current/third-party-extensions/openclaw-weixin/dist/src/messaging/process-message.js`
- 飞书普通消息和评论消息：`vendor/openclaw-runtime/current/third-party-extensions/openclaw-lark/src/messaging/inbound/dispatch.js`
- 飞书系统命令路径：`vendor/openclaw-runtime/current/third-party-extensions/openclaw-lark/src/messaging/inbound/dispatch-commands.js`
- 网易 Bee：`vendor/openclaw-runtime/current/third-party-extensions/openclaw-netease-bee/src/inbound.ts`
- 网易 IM：`vendor/openclaw-runtime/current/third-party-extensions/openclaw-nim-channel/src/bot.ts`

更优方案是在 OpenClaw SDK 的 `dispatchReplyFromConfig()` 内部根据 `ctx.SessionKey` / `route.agentId` 自动解析 cwd，并允许 `replyOptions.cwd` 覆盖。这样各 channel plugin 不需要重复实现，且未来新增 IM 平台不容易漏。

### 4.4 修复自定义 binding 匹配与 wildcard 语义

钉钉 connector 当前自定义遍历 `cfg.bindings`，需要与 OpenClaw core routing 语义保持一致：

- `match.accountId === '*'` 必须作为 channel 级通配，而不是按字面字符串匹配。
- exact account binding 优先级应高于 channel wildcard binding。
- peer / group / team 级 binding 优先级应与 core `resolveAgentRoute()` 一致，避免 sessionKey 和 cwd 来源不一致。
- `matchedBy` debug 需要输出 exact account、channel wildcard、default 等信息。

如果短期内无法修改钉钉 connector，则 智码 GLM Code 写出 binding 时需要对这类自定义 matcher 平台生成它能识别的 binding 形态。但长期应收敛到 core routing，减少平台之间的路由差异。

### 4.5 智码 GLM Code 写出正确 cwd 配置

`src/main/libs/openclawConfigSync.ts` 和 `src/main/libs/openclawAgentModels.ts` 需要保持以下输出：

- `agents.defaults.workspace`：智码 GLM Code 管理的 main Agent workspace，例如 `{STATE_DIR}/workspace-main`。
- `agents.defaults.cwd`：main Agent 的 `workingDirectory`，为空时 fallback 到 legacy `cowork_config.workingDirectory`。
- `agents.list[].workspace`：每个 Agent 的 OpenClaw 管理 workspace，例如 `{STATE_DIR}/workspace-{agentId}`。
- `agents.list[].cwd`：该 Agent 的用户任务目录。

当前代码已经写出 per-agent `cwd`，且已把 `agents.defaults.cwd` 调整为优先使用 main Agent 的 `workingDirectory`。但这只是 OpenClaw channel dispatch 能解析 cwd 的输入，不是最终修复本身。

### 4.6 Agent 工作目录变化触发 runtime 刷新

`src/main/main.ts` 的 `AgentIpcChannel.Update` 需要识别 `updates.workingDirectory !== undefined` 且值实际变化。

处理策略：

1. 更新 Agent。
2. 调用 `syncOpenClawConfig({ reason: 'agent-working-directory-updated', restartGatewayIfRunning: true })`，或调用 OpenClaw 明确的 hot refresh API。
3. 如果存在 active workload，沿用现有 deferred restart，不中断正在运行的任务。
4. refresh/restart 完成前，UI 不应暗示 IM runtime 已立即生效。

### 4.7 已有 IM session 的 cwd 校正

Agent 工作目录变化后，读取 `im_session_mappings` 中绑定该 Agent 的 channel session：

- 如果 OpenClaw 支持 `sessions.patch({ key, cwd })`，则对每个 `openclaw_session_key` patch cwd。
- 如果 channel run 每轮都会从 Agent 配置重新解析 cwd，则只需要清理 智码 GLM Code 的 `OpenClawChannelSessionSync` cache，并在下一轮同步时校正本地 `cowork_sessions.cwd`。
- 如果两者都不支持，则需要设计 session reset：删除或忽略旧 channel session，创建新的本地 Cowork session，并确保不会把旧 gateway history 全量同步进新 session。

最小可接受行为是：工作目录变化后的下一条 IM 消息真实执行 cwd 正确。

### 4.8 文件型结果落盘策略

IM channel run 需要和桌面 Cowork run 保持同一类路径语义：

- 所有未显式指定绝对路径的最终成果文件都写入 `resolvedCwd`。
- 如果 skill 或工具使用自己的默认输出目录，需要把默认目录初始化为 `resolvedCwd`，或在调用前注入等价 cwd。
- 如果平台发送文件需要生成临时上传副本，上传副本可以在 OpenClaw temp 下，但原始成果必须保存在 `resolvedCwd`。
- 如果 OpenClaw channel plugin 会下载入站附件到 workspace，例如 `media/inbound`，这类输入缓存可以保持现状；但由 Agent 处理后产出的最终文件不能继续写回输入缓存目录。
- 智码 GLM Code 同步到本地 Cowork session 后，文件链接解析应继续使用 `cowork_sessions.cwd`，且该值应与本轮 `resolvedCwd` 一致。

需要重点检查的路径：

- 文档、PPT、表格、图片生成类 skills 的默认输出目录。
- OpenClaw file/write/edit/apply_patch 工具的 cwd。
- IM 平台媒体发送工具读取文件时的源路径。
- 智码 GLM Code `CoworkSessionDetail` 对相对文件链接的 cwd 解析。

### 4.9 避免伪修复

不接受以下方案作为最终修复：

- 只在 prompt 里告诉模型“当前目录是 X”。这会让回答看似正确，但工具实际 cwd 仍错误。
- 只更新 `cowork_sessions.cwd`。这不会影响 OpenClaw channel run。
- 只修复桌面 `chat.send.cwd`。该路径当前已正确。
- 把 `workspace` 直接改成用户项目目录。这样会破坏 OpenClaw workspace 与用户任务目录解耦，并污染用户项目。
- 只在 IM 回复中改写文件路径文本。这样用户看到的路径可能正确，但真实文件仍可能生成在 OpenClaw workspace 或临时目录。

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| Agent 没有配置工作目录 | fallback 到 legacy `cowork_config.workingDirectory`，仍为空则使用 OpenClaw workspace 并记录 debug |
| main Agent 配置了工作目录 | `agents.defaults.cwd` 和 main entry cwd 都应指向该目录 |
| 非 main Agent 配置了工作目录 | `agents.list[].cwd` 指向该目录，`workspace` 仍在 OpenClaw state 下 |
| 多个 IM 分别绑定不同 Agent | 每个 IM run 使用自己绑定 Agent 的 cwd，不能统一使用 main cwd |
| 平台级 binding 使用 `accountId: '*'` | core routing 应识别为 channel wildcard；自定义 matcher 也必须支持等价语义 |
| exact account binding 和平台级 binding 同时存在 | exact account binding 优先，cwd 也使用 exact binding 的 Agent |
| 修改工作目录时 gateway 有 active workload | 延迟 restart/refresh，避免中断任务 |
| 修改工作目录后同一个 IM 对话继续提问 | 下一轮真实工具 cwd 必须更新 |
| IM 任务生成文件型结果 | 默认保存到绑定 Agent 的工作目录；IM 上传临时副本不替代源文件 |
| IM 入站附件下载缓存 | 可以继续放在 OpenClaw workspace 或 media cache，不属于最终结果落盘 |
| 用户在 IM 中明确要求输出到某绝对路径 | 按工具权限与安全策略处理；默认输出仍不能漂移 |
| 旧 OpenClaw runtime 不支持 channel cwd | 需要降级提示或采用 session reset/workspace fallback，不能静默声称已修复 |
| IM 绑定 Agent 变化和 cwd 变化同时发生 | 先保证 route 到正确 Agent，再使用该 Agent 的 cwd |
| 用户项目目录不存在 | 智码 GLM Code 侧保存时或运行前应提示；不能让 OpenClaw静默 fallback 到默认目录 |

## 6. 涉及文件

| 文件 | 预期改动 |
|---|---|
| `src/main/libs/openclawConfigSync.ts` | `agents.defaults.cwd` 优先取 main Agent 工作目录；继续写出 per-agent cwd |
| `src/main/libs/openclawAgentModels.ts` | 保持 Agent entry 的 `workspace` 与 `cwd` 分离 |
| `src/main/main.ts` | Agent `workingDirectory` 变化时触发 gateway refresh/hard restart |
| `src/main/libs/openclawChannelSessionSync.ts` | 复用 session 时检测本地 `session.cwd` 与当前 Agent cwd 是否漂移，并校正或重建 |
| `src/main/im/imStore.ts` | 如需批量处理已有 IM session，提供按 agent/platform 查询 mapping 的能力 |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 如 OpenClaw 支持 `sessions.patch.cwd`，暴露/调用 cwd patch；增加真实 cwd 诊断 |
| `src/common/openclawSession.ts` | 如需 patch cwd，扩展 `OpenClawSessionPatch` 类型 |
| `vendor/openclaw-runtime/current/dist/plugin-sdk` 或上游 OpenClaw SDK | 新增/修正 `resolveAgentRunCwd`，并在 `dispatchReplyFromConfig()` 中按 `ctx.SessionKey` / `agentId` 自动解析 cwd |
| `vendor/openclaw-runtime/current/third-party-extensions/openclaw-weixin` | dispatch 前按 `route.agentId` 解析 cwd，或依赖 SDK 统一解析 |
| `vendor/openclaw-runtime/current/third-party-extensions/openclaw-lark` | 普通消息、评论消息、系统命令 dispatch 都必须传递/继承 `resolvedRunCwd` |
| `vendor/openclaw-runtime/current/third-party-extensions/openclaw-netease-bee` | dispatch 前按 `route.agentId` 解析 cwd，或依赖 SDK 统一解析 |
| `vendor/openclaw-runtime/current/third-party-extensions/openclaw-nim-channel` | dispatch 前按 `route.agentId` 解析 cwd，或依赖 SDK 统一解析 |
| `vendor/openclaw-runtime/current/third-party-extensions/dingtalk-connector` | 自定义 binding matcher 支持 `accountId: '*'`，并用 matched Agent 解析 run cwd |
| `SKILLs/` 与 OpenClaw skills 输出路径 | 检查文件型成果的默认输出目录是否继承 run cwd |
| IM 平台发送/上传工具 | 保证发送源文件来自 Agent 工作目录中的最终产物，临时上传副本不作为唯一结果 |
| `vendor/openclaw-runtime/current` 或上游 OpenClaw | channel dispatch 支持 per-agent run cwd，而不是只使用 workspace |

## 7. 验收标准

1. 微信绑定 main Agent，main Agent 工作目录为 `/repo/a`，微信询问“当前的工作目录是哪里”时，真实工具 cwd 与回复均为 `/repo/a`。
2. 飞书绑定 Agent B，Agent B 工作目录为 `/repo/b`，飞书中执行 `pwd` 或等价问题时使用 `/repo/b`。
3. 微信绑定 Agent A、飞书绑定 Agent B，两个 Agent 工作目录不同；两个 IM 同时询问 cwd 时，分别回答各自 Agent 的目录。
4. 钉钉平台级 binding 使用 `accountId: '*'` 时，能 route 到绑定 Agent，而不是 main Agent。
5. 修改 Agent 工作目录后，不新建 IM 对话，继续在同一个微信/飞书对话里询问 cwd，下一轮使用新目录。
6. 从微信/飞书发起文件型任务，例如“生成一份 markdown 总结并保存”，最终文件默认出现在绑定 Agent 的工作目录。
7. IM 回复中发送或引用的文件路径对应工作目录中的真实文件，不只是临时上传副本。
8. 智码 GLM Code 桌面新建任务仍使用 `cowork_sessions.cwd` 快照，并通过 `chat.send.cwd` 生效。
9. OpenClaw workspace 文件仍写入 智码 GLM Code 管理目录，不污染用户项目目录。
10. 生成的 `openclaw.json` 中 `workspace` 与 `cwd` 语义清晰分离。
11. 相关单元测试和手动 IM 验证通过。

## 8. 验证计划

### 单元测试

建议新增或更新：

```bash
npm test -- openclawConfigSync
npm test -- openclawAgentModels
npm test -- openclawChannelSessionSync
```

覆盖点：

- main Agent `workingDirectory` 写入 `agents.defaults.cwd`。
- non-main Agent 同时写出 managed `workspace` 和用户 `cwd`。
- Agent 工作目录变化时触发 `restartGatewayIfRunning` 或等价 refresh。
- `OpenClawChannelSessionSync` 复用已有 mapping 时发现 cwd drift 并校正本地 session。
- `resolveAgentRunCwd(cfg, agentB)` 返回 `agents.list[agentB].cwd`，不会返回 `agents.defaults.cwd`。
- core `resolveAgentRoute()` 得到 Agent B 后，`dispatchReplyFromConfig()` 的 run params 含 Agent B cwd。
- 钉钉自定义 binding matcher 对 `accountId: '*'` 的行为与 core routing 一致。
- exact account binding 覆盖平台级 wildcard binding，并使用 exact binding Agent 的 cwd。
- IM channel run 中相对输出路径解析到 Agent cwd。
- 文件发送工具读取的源文件路径位于 Agent cwd，上传临时副本不作为唯一落盘结果。

### 手动验证

1. 在 智码 GLM Code 中选择一个非默认目录，例如 `/tmp/lobsterai-cwd-check-a`。
2. 绑定微信到当前 Agent。
3. 从微信发送：“请用 pwd 或当前运行环境告诉我当前工作目录。”
4. 检查回复、OpenClaw approval request 或 debug 日志中的 cwd 是否为 `/tmp/lobsterai-cwd-check-a`。
5. 把同一 Agent 的工作目录改为 `/tmp/lobsterai-cwd-check-b`。
6. 不删除微信对话，继续发送同一问题。
7. 验证下一轮真实 cwd 为 `/tmp/lobsterai-cwd-check-b`。
8. 从微信发送：“生成一个 cwd-check.md，内容写当前工作目录，并保存。”
9. 验证 `/tmp/lobsterai-cwd-check-b/cwd-check.md` 存在，且 OpenClaw workspace 或临时目录中没有唯一成果副本。
10. 对飞书重复同样流程。
11. 再配置一个不同目录的 Agent B，并把飞书绑定到 Agent B、微信保留在 Agent A。
12. 分别在微信和飞书发送同一条 cwd 检查消息，确认二者返回不同目录。
13. 如果钉钉使用平台级绑定，检查日志中的 `matchedBy` 不是 default，且 run cwd 是绑定 Agent 的目录。

### 配置验证

检查 `openclaw.json` 中 main Agent 和目标 Agent：

```json
{
  "agents": {
    "defaults": {
      "workspace": "/.../openclaw/state/workspace-main",
      "cwd": "/repo/main"
    },
    "list": [
      {
        "id": "agent-b",
        "workspace": "/.../openclaw/state/workspace-agent-b",
        "cwd": "/repo/agent-b"
      }
    ]
  }
}
```

如果 `workspace` 被写成用户项目目录，说明修复破坏了 workspace/cwd 解耦。如果 `cwd` 正确但 IM 实际工具 cwd 仍错误，说明 OpenClaw channel dispatch 还没有消费该字段。

## 9. 本次实现落点

本次实现采用“智码 GLM Code 配置写出 + OpenClaw runtime patch + channel plugin post-install patch”的组合：

1. 智码 GLM Code 继续写出 `agents.defaults.cwd` 和 `agents.list[].cwd`，并在 main Agent 工作目录变化时触发 gateway restart/refresh。
2. `scripts/patches/v2026.4.14/openclaw-im-bound-agent-run-cwd.patch` 在 OpenClaw 中新增 `resolveAgentRunCwd()`，并让 `getReplyFromConfig()` 按当前 `agentId` 解析 run cwd。这样微信、飞书、网易 Bee、网易 IM 等通过 SDK dispatch 的 channel run 不需要各自重复传 `replyOptions.cwd`。
3. `scripts/ensure-openclaw-plugins.cjs` 增加 DingTalk post-install patch，让 `dingtalk-connector` 自定义 matcher 正确识别 `match.accountId === "*"`，避免平台级绑定落回 main Agent。
4. `OpenClawChannelSessionSync` 复用已有 IM mapping 时会校正本地 `cowork_sessions.cwd`，保证 UI 与真实 Agent cwd 方向一致。

验证重点仍然是 OpenClaw 实际工具 cwd，而不是仅看本地 SQLite。发布构建需要重新执行 OpenClaw runtime 构建链路，使新的 runtime patch 和 DingTalk post-install patch 进入随包产物。
