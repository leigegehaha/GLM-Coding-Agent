# 智码 GLM Code Cowork 会话分叉设计文档

## 1. 概述

### 1.1 问题/背景

智码 GLM Code Cowork 当前已经具备完整的本地会话、消息持久化、OpenClaw 工具调用和工作目录执行能力。用户在一个会话中经常会遇到以下需求：

- 从当前上下文出发尝试另一种实现方案。
- 在不破坏原会话的情况下继续探索。
- 对比多个 Agent 或模型在同一问题上的解法。
- 对已经较长的会话进行分支实验，而不是重新描述全部背景。

这类能力在 Codex 中对应 `thread/fork` 的产品语义：复制已有 thread 的 stored history，创建新的 thread id。需要注意的是，Codex 的 fork 不是文件系统快照；文件隔离由 Git worktree 这套独立机制承担。

智码 GLM Code 的架构与 Codex 类似：

- 本地持久化会话：`cowork_sessions` / `cowork_messages`
- 会话级工作目录快照：`cowork_sessions.cwd`
- 工具调用与命令执行：由 OpenClaw runtime 在 session cwd 内执行
- Git 项目可天然使用 worktree 实现并行工作区

因此，本功能不应把“分叉”设计成一个万能时间机器，而应明确拆成两个能力：

1. **分叉会话**：复制会话历史并创建新的 Cowork session。
2. **分叉工作区**：仅在 Git 仓库中创建独立 worktree，并让分叉 session 指向该 worktree。

### 1.2 目标

本功能目标是：

1. 支持用户从已有 Cowork session 分叉出一个新的 session。
2. 分叉 session 拥有新的 session id，与原 session 后续消息互不影响。
3. 分叉 session 记录来源关系，可展示 `forkedFromId` / 分叉来源。
4. 默认能力与 Codex `thread/fork` 对齐：复制 stored history，不复制文件系统。
5. 当前落地范围为“派生到本地”；Git worktree “在新工作区分叉”保留为 Phase 2 设计，当前产品决策为暂不实现。
6. 非 Git 目录仍允许“分叉会话”，但不提供可靠文件状态隔离。
7. 执行过本地命令的会话仍允许分叉会话，但 UI 明确说明命令副作用不会回滚或复制。
8. 分叉后继续发送消息时，OpenClaw 使用新的 session key，不污染原 OpenClaw session 历史。
9. 支持未来扩展到按某条消息或某个 turn 分叉。
10. 对已经发生 OpenClaw 上下文压缩的会话，分叉后应尽量继承压缩后的模型可见摘要，避免长会话分叉后只依赖最近几条消息。

### 1.3 非目标

本设计第一版不做以下事情：

- 不实现非 Git 目录的完整文件系统快照。
- 不承诺回滚数据库、缓存、外部 API 调用、后台进程、全局包安装等命令副作用。
- 不自动创建用户不可见的 Git checkpoint commit。
- 不把原 OpenClaw session key 复用给分叉 session。
- 不把 OpenClaw 原始 transcript 文件复制为新 智码 GLM Code session 的运行态来源；第一版只读取 checkpoint 摘要并显式桥接。
- 不在第一版实现复杂的分叉树可视化。
- 不在第一版自动清理用户已经手动修改过的 worktree。
- 不改变现有 Cowork session 的默认创建、继续和删除语义。

## 2. 与 Codex 的关联和技术选择

### 2.1 Codex 模型

Codex app-server 中的 `thread/fork` 语义是：

- 读取已有 thread 的 persisted rollout / stored history。
- 创建新的 thread id。
- 新 thread 的 `forkedFromId` 指向来源 thread。
- 可设置新的 cwd、权限、模型等 thread 配置。
- 如果源 thread 正在运行，则 fork 记录 interrupted snapshot。
- fork 不等同于文件系统快照。

Codex 的文件隔离由 worktree 机制承担：

- Git repo 可使用 Codex-managed worktree。
- 非版本控制项目直接在项目目录中运行。
- worktree 默认用于隔离后续代码文件修改。
- 命令执行产生的外部副作用不属于 fork 的可回放状态。

智码 GLM Code 采用同一边界：

```text
会话分叉 = 复制历史，创建新 session
工作区分叉 = Git repo 中创建 worktree
命令副作用 = 只记录和展示，不作为可复制环境状态
```

### 2.2 为什么不把 fork 做成文件快照

文件快照在非 Git 目录中看起来简单，但真实边界很复杂：

- 需要排除 `node_modules`、`dist`、缓存、日志、临时文件等大目录。
- 需要处理二进制文件、权限、软链接、隐藏文件和平台差异。
- 无法可靠复制数据库、系统缓存、外部服务状态和后台进程。
- 大项目复制成本高，失败恢复和清理成本也高。

因此，智码 GLM Code 第一版不实现非 Git 文件快照。对于文件类任务，推荐用户使用 Git repo + worktree。

### 2.3 为什么不自动 checkpoint commit

当 Git 工作区有未提交改动时，可以通过 checkpoint commit 精确保存当前文件状态。但自动提交会改变用户 Git 历史，产品风险较高。

第一版不自动 checkpoint commit。dirty worktree 的处理策略为：

- 允许创建 worktree 时基于当前 `HEAD`。
- 如需复制未提交改动，可提供显式选项，使用 patch apply 方式把当前未提交 diff 应用到新 worktree。
- 该选项必须用户主动选择，并在失败时保留清晰错误。

### 2.4 Codex 分叉弹窗语义

Codex 在用户从早期消息创建分支时，会明确提示：

- 当前文件和工作树状态保持不变。
- 如果后续轮次更改过文件系统，新分支内容可能与当前磁盘内容不一致。
- 用户可以选择在本地继续，或在新工作树中继续。

智码 GLM Code 应采用同一产品语义：

```text
从早期消息分叉 = 对话历史回到该消息点
文件/工作树状态 = 保持用户当前磁盘状态
新工作树 = 后续写入隔离到 Git worktree，但仍不是任意历史时刻的文件快照
```

因此，消息级分叉不是“把文件恢复到该消息时刻”。它只是把新 session 的对话上下文截断到该消息，并在当前文件状态或新 worktree 中继续。

### 2.5 OpenClaw 压缩模型与源码确认

结合 OpenClaw 源码和 gateway schema，智码 GLM Code 不能把“UI 上的压缩分隔符”和“可用于分叉续写的压缩摘要”混为一谈：

- OpenClaw 在 `src/types/pi-agent-core.d.ts` 中扩展了 `compactionSummary` 角色，字段包括 `summary`、`tokensBefore`、`tokensAfter`、`firstKeptEntryId` 等。该角色属于 assembled/model-visible context 层。
- OpenClaw 在 `src/gateway/session-compaction-checkpoints.ts` 中持久化 `SessionCompactionCheckpoint`，并最多保留最近 25 个 checkpoint。
- checkpoint 结构定义在 `src/config/sessions/types.ts` 和 `src/gateway/protocol/schema/sessions.ts`，核心字段包括 `checkpointId`、`reason`、`tokensBefore`、`tokensAfter`、`summary`、`preCompaction`、`postCompaction`。
- gateway 暴露 `sessions.compaction.list` 和 `sessions.compaction.get`，可根据 session key 读取 checkpoint 列表和单个 checkpoint。
- gateway 还提供 `sessions.compaction.branch` / `sessions.compaction.restore`，但它们操作 OpenClaw transcript/session store，不等同于 智码 GLM Code 本地 Cowork session 分叉，第一版不直接采用。
- `chat.history` 面向普通聊天历史窗口，且 智码 GLM Code 当前的 `extractGatewayHistoryEntry()` 只接受 `user` / `assistant` / `system`，不会可靠保留 `compactionSummary`。

因此，智码 GLM Code 分叉压缩会话时应优先从 OpenClaw checkpoint metadata 读取 `summary`，而不是从聊天气泡、`COMPACTION` 分隔符或普通 `chat.history` 文本中推断。

## 3. 用户场景

### 场景 1: 纯讨论会话分叉

**Given** 用户在 Cowork 会话中讨论技术方案，尚未写文件或执行命令
**When** 用户点击“分叉会话”
**Then** 智码 GLM Code 创建一个新的 Cowork session

**And** 新 session 复制源 session 的用户和助手消息

**And** 新 session 的 `forkedFromId` 指向源 session

**And** 新 session 继续使用源 session 的 `cwd`

### 场景 2: Git 项目中分叉工作区

**Given** 当前 session 的 `cwd` 位于 Git 仓库中
**When** 用户选择“在新工作区分叉”
**Then** 智码 GLM Code 创建一个 Git worktree

**And** 新 session 的 `cwd` 指向该 worktree

**And** 新 session 复制源 session 历史

**And** 后续文件写入发生在新 worktree 中，不影响原工作区文件

**And** 该 worktree 基于当前 Git 可检出的状态创建，不表示恢复到某条历史消息当时的磁盘状态

### 场景 3: 非 Git 目录中分叉会话

**Given** 当前 session 的 `cwd` 不是 Git 仓库
**When** 用户打开分叉菜单
**Then** 智码 GLM Code 允许“分叉会话”

**And** 智码 GLM Code 禁用“在新工作区分叉”

**And** UI 提示“当前目录不是 Git 仓库，分叉不会复制文件状态”

### 场景 4: 执行过命令的会话分叉

**Given** 当前 session 中执行过本地命令
**When** 用户分叉会话或工作区
**Then** 智码 GLM Code 提示命令造成的环境变化不会随分叉回滚或复制

**And** 若创建 worktree，只承诺隔离后续 Git 工作区文件修改

### 场景 5: 从某条消息处分叉

**Given** 用户在历史消息上打开更多操作
**When** 用户选择“从这里分叉”
**Then** 智码 GLM Code 创建新的 session

**And** 只复制该消息及之前的消息

**And** `forkedFromMessageId` 记录来源消息

**And** 后续对话从该上下文继续

**And** 智码 GLM Code 提示当前文件和工作树状态不会回滚到该消息时刻

**And** 用户可选择“派生到本地”或在 Git 仓库中选择“派生到新工作树”

第一期可先实现 session 级分叉和“派生到本地”。消息级分叉可在第一期内作为同一套复制逻辑的扩展，但必须按稳定消息/turn 边界截断，不能复制未完成的流式状态。

### 场景 6: 源会话正在运行时分叉

**Given** 源 session 当前状态为 `running`
**When** 用户发起分叉
**Then** 智码 GLM Code 禁止直接分叉或提示先停止当前任务

第一版建议禁止 running session 分叉，避免复制未稳定的流式消息和工具状态。后续可参考 Codex 的 interrupted snapshot 机制扩展。

## 4. 功能需求

### FR-1: 分叉模式

定义两种用户可见模式：

```ts
export const CoworkForkMode = {
  Conversation: 'conversation',
  Worktree: 'worktree',
} as const;
export type CoworkForkMode = typeof CoworkForkMode[keyof typeof CoworkForkMode];
```

- `Conversation`: 只复制会话历史，沿用源 session 的 `cwd`。
- `Worktree`: 复制会话历史，并创建 Git worktree，新 session 指向 worktree。

### FR-2: 分叉状态检测

分叉入口需要展示 capability：

```ts
export const CoworkForkWorkspaceState = {
  None: 'none',
  GitClean: 'git_clean',
  GitDirty: 'git_dirty',
  NonGit: 'non_git',
} as const;
export type CoworkForkWorkspaceState =
  typeof CoworkForkWorkspaceState[keyof typeof CoworkForkWorkspaceState];
```

检测结果用于 UI：

- `git_clean`: 可直接创建 worktree。
- `git_dirty`: 可创建 worktree，但需要用户选择是否带上未提交改动。
- `non_git`: 禁用 worktree 分叉。
- `none`: session 没有有效 cwd，只允许纯会话分叉或禁用。

### FR-3: 工具副作用检测

智码 GLM Code 需要为 session 计算工具副作用级别：

```ts
export const CoworkSessionEffectLevel = {
  ReadOnly: 'read_only',
  WorkspaceWrite: 'workspace_write',
  CommandExec: 'command_exec',
  ExternalSideEffect: 'external_side_effect',
} as const;
export type CoworkSessionEffectLevel =
  typeof CoworkSessionEffectLevel[keyof typeof CoworkSessionEffectLevel];
```

第一版可基于 `cowork_messages.metadata.toolName` 和 message type 进行启发式判断：

- `read_only`: 只有普通对话、读取文件、搜索、列表等。
- `workspace_write`: 出现写文件、编辑、apply patch、artifact 保存等。
- `command_exec`: 出现 shell、exec、npm、git 等命令执行工具。
- `external_side_effect`: 出现 IM、网络发布、远端 API、外部系统写入等工具。

该判断用于提示，不用于阻止会话分叉。

### FR-4: 会话分叉数据模型

`cowork_sessions` 增加字段：

```sql
ALTER TABLE cowork_sessions ADD COLUMN parent_session_id TEXT;
ALTER TABLE cowork_sessions ADD COLUMN forked_from_message_id TEXT;
ALTER TABLE cowork_sessions ADD COLUMN forked_at INTEGER;
ALTER TABLE cowork_sessions ADD COLUMN fork_mode TEXT NOT NULL DEFAULT 'none';
ALTER TABLE cowork_sessions ADD COLUMN fork_workspace_path TEXT;
ALTER TABLE cowork_sessions ADD COLUMN fork_git_branch TEXT;
ALTER TABLE cowork_sessions ADD COLUMN fork_git_base_ref TEXT;
```

说明：

- `parent_session_id`: 来源 session id。
- `forked_from_message_id`: 消息级分叉时的来源消息 id，session 级分叉为空。
- `forked_at`: 分叉时间。
- `fork_mode`: `none` / `conversation` / `worktree`。
- `fork_workspace_path`: worktree 目录。
- `fork_git_branch`: worktree 对应 branch，若 detached 可为空。
- `fork_git_base_ref`: 创建 worktree 的 base ref，例如 `HEAD` 或 commit hash。

如果希望降低 `cowork_sessions` 膨胀，也可新建 `cowork_session_forks` 表。第一版建议直接加列，读取列表更简单。

### FR-5: 分叉会话复制规则

新增 `CoworkStore.forkSession()`：

```ts
interface CoworkForkSessionOptions {
  sourceSessionId: string;
  forkMode: CoworkForkMode;
  forkedFromMessageId?: string | null;
  title?: string;
  cwdOverride?: string;
  workspacePath?: string | null;
  gitBranch?: string | null;
  gitBaseRef?: string | null;
}
```

复制规则：

- 新 session 生成新的 id。
- `status` 设为 `idle`。
- `claude_session_id` 设为 `NULL`。
- `pinned` 设为 `0`，`pin_order` 设为 `NULL`。
- 复制 `cwd`、`system_prompt`、`model_override`、`execution_mode`、`active_skill_ids`、`agent_id`。
- 如果传入 `cwdOverride`，新 session 使用该目录。
- 复制消息时生成新的 message id。
- 保留 `type`、`content`、`metadata`、`created_at`、`sequence`。
- 如果 `forkedFromMessageId` 存在，只复制 sequence 小于等于来源消息 sequence 的消息。
- 不复制当前未完成的 streaming assistant message。
- 不复制 pending permission 状态。

### FR-6: OpenClaw session key 隔离

分叉 session 必须使用新的 智码 GLM Code session id。

OpenClawRuntimeAdapter 当前基于 `sessionId + agentId` 生成 managed session key。只要分叉 session 使用新 id，就会自然获得独立 OpenClaw session key。

分叉实现不应：

- 复用源 session 的 OpenClaw session key。
- 将源 session 的 active turn 状态带到新 session。
- 把源 session 的 pending approval 映射到新 session。

分叉后第一次继续会话时，现有 `buildOutboundPrompt()` 会在新 OpenClaw session 无 history 时，将本地 `session.messages` 作为 context bridge 注入。这正好匹配会话分叉语义。

### FR-6A: 压缩摘要桥接

当源会话已经发生 OpenClaw checkpoint compaction 时，仅复制 `cowork_messages` 不足以完整恢复模型上下文。第一版增强需要在分叉时读取最新 checkpoint summary，并将它作为新会话的显式桥接上下文保存下来。

新增内部 metadata kind：

```ts
export const CoworkForkContextKind = {
  CompactionSummary: 'fork_compaction_summary',
} as const;
```

建议新 session 中写入一条 `system` 消息：

```ts
{
  type: 'system',
  content: '<checkpoint.summary>',
  metadata: {
    kind: 'fork_compaction_summary',
    sourceSessionId,
    sourceSessionKey,
    checkpointId,
    checkpointReason,
    checkpointCreatedAt,
    tokensBefore,
    tokensAfter,
  }
}
```

处理规则：

- 该消息默认不以普通聊天气泡展示；renderer 可以用轻量 divider 或完全隐藏。
- `CoworkStore.forkSession()` 不直接依赖 OpenClaw gateway。摘要读取由 main process / OpenClawRuntimeAdapter 完成后，以 `forkContextMessages` 形式传入 store。
- 如果源 session 没有 OpenClaw session key、gateway 未运行、接口不可用、无 checkpoint、或 checkpoint 无 summary，分叉继续走现有最近消息 bridge，不阻断用户。
- 如果是消息级分叉，只有当 checkpoint 创建时间或 checkpoint 对应序列边界不晚于 `forkedFromMessageId` 时才注入摘要；第一版无法精确映射时保守策略为：只在 session-level fork 或从最新 assistant 消息 fork 时注入摘要。
- 不把 `compactionSummary` 当作普通 `assistant` 或 `system` 历史复制，不从 `chat.history` 的普通消息窗口推断摘要。
- 分叉后首轮继续时，`buildBridgePrefix()` 应优先读取 `fork_compaction_summary`，并在最近消息 bridge 之前注入：

```text
[Compacted context from the source 智码 GLM Code conversation]
The source conversation was compacted by OpenClaw. Use this summary as prior context:
<summary>
```

- 最近消息 bridge 仍保留，用于提供压缩后发生的近端对话和当前分叉点附近上下文。

OpenClaw gateway 读取策略：

1. 使用源 智码 GLM Code session id 和 agent id 解析 OpenClaw managed session key。
2. 调用 `sessions.compaction.list({ key })`。
3. 取按 `createdAt` 最新的 checkpoint，优先使用返回项中的 `summary`。
4. 如果 list 返回项不含完整 summary，但有 `checkpointId`，再调用 `sessions.compaction.get({ key, checkpointId })`。
5. 对 summary 做长度上限保护，例如 40k 字符；超出时截断并在 metadata 中记录 `truncated: true`。

该能力是 Phase 1 的增强，不依赖 Git worktree。

### FR-7: Git worktree 创建（Phase 2 Deferred）

新增主进程服务：

```ts
interface CoworkWorktreeForkRequest {
  sourceSessionId: string;
  includeUncommittedChanges?: boolean;
}

interface CoworkWorktreeForkResult {
  cwd: string;
  branch?: string | null;
  baseRef: string;
}
```

创建策略：

1. 解析源 session `cwd`。
2. 使用 `git rev-parse --show-toplevel` 判断 Git repo。
3. 使用 `git status --porcelain=v1` 判断 dirty 状态。
4. 生成 branch 名称：`lobster/fork/<short-session-id>`。
5. 生成 worktree 路径：`{userData}/worktrees/<session-id>` 或 `{repoParent}/.lobsterai/worktrees/<session-id>`。
6. 执行 `git worktree add -b <branch> <worktreePath> HEAD`。
7. 如果 `includeUncommittedChanges = true`：
   - 导出 tracked diff: `git diff --binary HEAD`
   - 记录 untracked 文件列表。
   - 在新 worktree 中 `git apply --index?` 或普通 `git apply` 应用 diff。
   - 复制 untracked 文件到对应路径。

该能力当前不进入实现范围。若后续恢复 Phase 2，可先只实现 clean repo worktree，dirty repo 显示提示并要求用户选择“不带未提交改动”或取消。`includeUncommittedChanges` 可作为第二阶段。

### FR-8: IPC

所有 IPC channel 必须使用集中常量，不写裸字符串。

建议扩展 `src/shared/cowork/constants.ts`：

```ts
export const CoworkIpcChannel = {
  MediaStatusPollUpdate: 'cowork:media:statusPollUpdate',
  ForkSession: 'cowork:session:fork',
  GetForkCapability: 'cowork:session:forkCapability',
} as const;
```

新增 API：

```ts
interface CoworkForkCapabilityResult {
  success: boolean;
  workspaceState?: CoworkForkWorkspaceState;
  effectLevel?: CoworkSessionEffectLevel;
  canForkConversation?: boolean;
  canForkWorktree?: boolean;
  warnings?: string[];
  error?: string;
}

interface CoworkForkSessionRequest {
  sessionId: string;
  mode: CoworkForkMode;
  forkedFromMessageId?: string | null;
  includeUncommittedChanges?: boolean;
}

interface CoworkForkSessionResult {
  success: boolean;
  session?: CoworkSession;
  warnings?: string[];
  error?: string;
}
```

主进程处理：

- `GetForkCapability`: 只检测状态，不修改文件系统。
- `ForkSession`: 根据 mode 执行会话复制或 worktree 创建 + 会话复制。

### FR-9: Renderer service 与 Redux

`coworkService` 增加：

```ts
getForkCapability(sessionId: string): Promise<CoworkForkCapabilityResult>
forkSession(request: CoworkForkSessionRequest): Promise<CoworkSession | null>
```

成功分叉后：

- dispatch `addSession(newSession)`。
- 切换到新 session。
- 清空新 session 的 draft。
- 刷新 session list。
- toast 展示成功提示。

### FR-10: UI 入口

第一版 UI 入口：

- Session item 菜单增加“分叉会话”。
- Session detail header 增加 fork icon。

菜单行为：

- `分叉会话`: 所有非 running session 可用。
- `在新工作区分叉`: 仅 Git repo 可用。
- 非 Git 时展示 disabled item 或 tooltip。
- dirty Git 时展示确认弹窗。

确认弹窗内容需要清楚区分：

- 会话历史会复制。
- 当前文件和工作树状态保持不变，不会回滚到来源消息当时。
- 如果来源消息之后修改过文件，新分支上下文可能与当前磁盘内容不一致。
- worktree 只隔离 Git 工作区文件。
- 命令和外部副作用不会回滚或复制。

弹窗建议选项与 Codex 对齐：

- `派生到本地`: 在当前本地工作目录中从该消息继续。
- `派生到新工作树`: 在新的 Git worktree 中从该消息继续；仅 Git 仓库可用。

所有用户可见文案必须走 i18n，中文和英文都要补齐。

### FR-11: 列表和详情展示来源

分叉 session 可在详情顶部轻量展示：

- `从「{sourceTitle}」分叉`
- 点击可跳转源 session。

Session list 第一版可不显示分叉关系，避免列表过度拥挤。

### FR-12: 删除与清理

删除普通 fork session：

- 删除 session 和 messages。
- 不影响源 session。

删除 worktree fork session：

- 第一版不自动删除 worktree，避免误删用户修改。
- 删除时如果 session 有 `fork_workspace_path`，弹窗提供复选项：
  - `同时移除工作区`
- 用户勾选后执行：
  - `git worktree remove <path>`
  - 如果 branch 没有被用户保留，可提示是否删除 branch。

自动清理作为后续能力，不进入第一版。

## 5. 技术实现方案

### 5.1 数据库迁移

修改 `src/main/sqliteStore.ts`：

- 为 `cowork_sessions` 添加 fork 相关列。
- 兼容旧数据库，使用 `PRAGMA table_info(cowork_sessions)` 判断列是否存在。
- 默认 `fork_mode = 'none'`。

### 5.2 CoworkStore

修改 `src/main/coworkStore.ts`：

- 扩展 `CoworkSession` / `CoworkSessionSummary` 类型。
- `createSession()` 返回 fork 字段默认值。
- `getSession()` / `listSessions()` 查询 fork 字段。
- 新增 `forkSession()`。
- 新增 `getMessageSequence(sessionId, messageId)` 或内部查询，用于消息级分叉。

复制消息建议使用事务：

```ts
this.db.transaction(() => {
  insertSession.run(...);
  for (const message of sourceMessages) {
    insertMessage.run(newMessageId, newSessionId, ...);
  }
})();
```

### 5.3 Worktree 服务

新增文件建议：

- `src/main/libs/coworkFork/worktreeForkService.ts`
- `src/main/libs/coworkFork/worktreeForkService.test.ts`
- `src/main/libs/coworkFork/constants.ts`

职责：

- 检测 Git repo。
- 检测 dirty 状态。
- 创建 worktree。
- 可选应用未提交改动。
- 返回结构化结果和错误。

命令执行要求：

- 不使用 shell 字符串拼接执行 Git 命令。
- 使用 `child_process.spawn` / `execFile` 参数数组。
- 日志使用 `console.log/warn/error`，遵守 main process logging 规范。
- 错误日志必须包含 error 对象。

### 5.4 IPC handlers

修改 `src/main/main.ts`：

- 增加 fork capability handler。
- 增加 fork session handler。
- worktree 模式先创建 worktree，再调用 `coworkStore.forkSession()`。
- 如果创建 worktree 成功但 fork session 失败，需要尝试回滚 worktree 创建，失败则记录 warn。

错误处理：

- 源 session 不存在：返回 `success: false`。
- 源 session running：返回 `success: false`，提示先停止当前任务。
- 非 Git 目录选择 worktree：返回 `success: false`。
- dirty repo 且未确认：返回 `success: false`，提示需要确认。

### 5.5 Preload 与类型

修改：

- `src/main/preload.ts`
- `src/renderer/types/electron.d.ts`
- `src/renderer/types/cowork.ts`

暴露：

```ts
window.electron.cowork.getForkCapability(options)
window.electron.cowork.forkSession(options)
```

### 5.6 Renderer service

修改 `src/renderer/services/cowork.ts`：

- 增加 capability 获取。
- 增加 fork session。
- 成功后 dispatch `addSession()`。
- 对错误和 warnings 做 toast 展示。

### 5.7 UI

修改：

- `src/renderer/components/cowork/CoworkSessionItem.tsx`
- `src/renderer/components/cowork/CoworkSessionList.tsx`
- `src/renderer/components/cowork/CoworkSessionDetail.tsx`
- 新增 `CoworkForkSessionModal.tsx` 或轻量确认 modal。

交互建议：

1. 用户点击 fork。
2. 前端调用 `getForkCapability()`。
3. 如果只有 conversation 模式，直接确认。
4. 如果可 worktree，展示两项选择。
5. 用户确认后调用 `forkSession()`。
6. 成功切换到新 session。

### 5.8 i18n

新增 renderer i18n keys：

- `coworkForkSession`
- `coworkForkWorkspace`
- `coworkForkFromHere`
- `coworkForkCreated`
- `coworkForkFailed`
- `coworkForkRunningBlocked`
- `coworkForkNonGitWarning`
- `coworkForkCommandSideEffectWarning`
- `coworkForkWorkspaceDescription`
- `coworkForkConversationDescription`
- `coworkForkDirtyGitTitle`
- `coworkForkDirtyGitMessage`
- `coworkForkSourceLabel`

中英文必须同时添加。

## 6. 数据流

### 6.1 分叉会话

```text
Renderer
  -> getForkCapability(sessionId)
  <- capability
  -> forkSession({ mode: conversation })
Main
  -> CoworkStore.forkSession()
  -> insert new cowork_sessions row
  -> copy cowork_messages
Renderer
  <- new session
  -> addSession + setCurrentSession
```

### 6.2 分叉工作区

```text
Renderer
  -> forkSession({ mode: worktree })
Main
  -> WorktreeForkService.createWorktree(source.cwd)
  -> CoworkStore.forkSession({ cwdOverride: worktreePath })
Renderer
  <- new session
  -> addSession + setCurrentSession
OpenClaw
  -> next turn uses new sessionId-derived sessionKey
  -> chat.send cwd = new worktree path
```

## 7. 风险与边界

### 7.1 文件状态边界

“分叉会话”不保证文件状态一致。它只复制聊天上下文，并保持当前磁盘上的文件和工作树状态不变。

当用户从早期消息分叉时，新的对话上下文会回到早期消息，但文件系统不会回到早期状态。如果来源消息之后发生过文件修改，新分支看到的对话上下文可能与当前文件内容不一致。

对于后续还要继续改代码的任务，UI 应推荐“派生到新工作树”。但 worktree 也只隔离后续 Git 工作区文件修改，不表示完整环境快照。

### 7.2 命令副作用边界

本地命令可能影响：

- 数据库
- 缓存
- node_modules
- 系统配置
- 后台进程
- 外部服务

这些状态不属于 fork 的可复制范围。智码 GLM Code 只提示，不承诺回滚。

### 7.3 Dirty Git 边界

dirty repo 的精确状态复制需要额外处理。第一版保守处理，不自动 checkpoint commit。

### 7.4 Worktree 删除风险

worktree 可能包含用户后续修改。删除 session 时默认不删除 worktree，必须用户明确勾选。

## 8. 测试计划

### 8.1 单元测试

- `CoworkStore.forkSession()` 复制 session 字段。
- `CoworkStore.forkSession()` 复制消息并生成新 message id。
- 消息级分叉只复制指定 sequence 之前的消息。
- fork session 不复制 pinned 状态。
- fork session 状态为 `idle`。
- fork metadata 正确写入。
- fork 会话存在 `fork_compaction_summary` 时，`buildBridgePrefix()` 将摘要放在最近消息 bridge 之前。
- `fork_compaction_summary` 不作为普通聊天气泡展示。
- checkpoint summary 超长时截断并保留 metadata 标记。
- Phase 2 恢复时：Git capability 检测 clean repo / dirty repo / non-Git cwd。

### 8.2 集成测试

- IPC `cowork:session:fork` 成功返回新 session。
- running session 分叉被拒绝。
- session 删除不影响 parent session。
- 源会话存在 OpenClaw checkpoint summary 时，fork session 写入隐藏摘要桥接消息。
- OpenClaw checkpoint 接口不可用或返回空 summary 时，fork 仍成功，且回退到最近消息 bridge。
- 消息级早期分叉不会错误注入晚于分叉点的 checkpoint summary。
- Phase 2 恢复时：worktree 模式在 Git repo 中创建新 cwd，且 worktree 创建失败时不创建半成品 session。

### 8.3 手动测试

- 纯讨论会话分叉后继续聊天。
- 执行过命令的会话分叉时出现风险提示。
- 分叉 session 首轮继续时，OpenClaw 能读到历史上下文。
- 对已经产生 checkpoint compaction 的长会话分叉，首轮继续时模型能引用压缩摘要中的关键信息。
- Phase 2 恢复时：文件修改会话在 Git repo 中 worktree 分叉后继续写文件，确认原工作区不变；非 Git 目录中 worktree 分叉按钮禁用；删除 worktree fork session 时不自动删除工作区。

## 9. 实施计划

**Goal:** Add Codex-style local Cowork session fork support to 智码 GLM Code, while keeping Git worktree workspace isolation as a deferred Phase 2 design.

**Architecture:** Implement fork as a main-process CoworkStore operation that creates a new session and copies persisted messages. For compacted OpenClaw sessions, read checkpoint summary metadata through the gateway and persist it as hidden bridge context in the fork. Keep OpenClaw session isolation by using the new 智码 GLM Code session id and existing session-key derivation. Git worktree isolation is deferred.

**Tech Stack:** Electron IPC, TypeScript, SQLite, React, Redux Toolkit, Git CLI, Vitest

### Phase 1: 派生到本地

第一期目标是对齐 Codex 弹窗中的“派生到本地”：

- Add fork metadata columns to `cowork_sessions`.
- Add shared constants and renderer/main types.
- Implement `CoworkStore.forkSession()`.
- Add IPC `ForkSession` for conversation mode.
- Implement fork capability detection for warnings only.
- Add confirmation modal with Codex-style file/worktree warning.
- Add renderer service method.
- Add UI menu entry and success flow.
- Support session-level fork first; message-level fork may be included only if it truncates on stable message/turn boundaries.
- Sanitize copied message metadata so runtime ids, streaming flags, pending approvals, media task ids, and tool-use bindings do not leak into the fork.
- Add checkpoint summary bridge for compacted OpenClaw sessions by reading `sessions.compaction.list/get` before creating the fork.
- Inject `fork_compaction_summary` before the recent-message context bridge on the first turn of the forked session.
- Add unit tests.

### Phase 2: 派生到新工作树

第二期目标是对齐 Codex 弹窗中的“派生到新工作树”。当前产品决策为暂不实现该阶段，保留设计用于后续恢复：

- Implement `WorktreeForkService`.
- Add clean Git repo worktree creation.
- Wire worktree mode into fork IPC.
- Persist `fork_workspace_path`, `fork_git_branch`, `fork_git_base_ref`.
- Disable new-worktree option for non-Git directories.
- Show dirty Git warnings; first implementation may create the worktree from `HEAD` without carrying uncommitted changes.
- Add manual tests for file isolation.

### Deferred Follow-Ups

- Add explicit option to include uncommitted changes by patch application.
- Add richer turn-level fork controls if message-level truncation proves ambiguous.
- Add source session jump UI.
- Add optional worktree cleanup flow.

## 10. 文件结构

- Modify: `src/shared/cowork/constants.ts`
- Modify: `src/main/sqliteStore.ts`
- Modify: `src/main/coworkStore.ts`
- Modify: `src/main/main.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/types/cowork.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Modify: `src/renderer/services/cowork.ts`
- Modify: `src/renderer/store/slices/coworkSlice.ts`
- Modify: `src/renderer/components/cowork/CoworkSessionItem.tsx`
- Modify: `src/renderer/components/cowork/CoworkSessionList.tsx`
- Modify: `src/renderer/components/cowork/CoworkSessionDetail.tsx`
- Modify: `src/renderer/services/i18n.ts`
- Modify: `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
- Modify: `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts`
- Modify: `src/renderer/components/cowork/messageDisplayUtils.ts`
- Deferred if Phase 2 resumes: `src/main/libs/coworkFork/constants.ts`
- Deferred if Phase 2 resumes: `src/main/libs/coworkFork/worktreeForkService.ts`
- Deferred if Phase 2 resumes: `src/main/libs/coworkFork/worktreeForkService.test.ts`
- Deferred if Phase 2 resumes: `src/renderer/components/cowork/CoworkForkSessionModal.tsx`
- Create: `src/main/coworkForkSession.test.ts`

## 11. Open Questions

- 压缩摘要桥接消息是否完全隐藏，还是在 UI 中显示一条“已继承源会话压缩摘要”的轻量 divider？
- 消息级早期分叉如何精确判断 checkpoint 是否早于分叉点？是否需要在 智码 GLM Code 本地记录 checkpoint 与 message sequence 的映射？
- OpenClaw checkpoint summary 为空但 `compactionSummary` 存在于 transcript/context 时，是否需要额外读取 transcript，还是继续回退到最近消息 bridge？
- Worktree path 应放在 app userData 下，还是 repo 相邻 `.lobsterai/worktrees` 下？当前 Phase 2 暂缓。
- Dirty repo 第一版是否只允许不带未提交改动，还是直接实现 patch apply？当前 Phase 2 暂缓。
- User shell command 是否应该复制到 fork 历史中作为上下文展示，还是像 Codex 一样从 persisted turn view 中过滤？
- Worktree fork session 删除时，是否需要默认提示清理工作区？当前 Phase 2 暂缓。
- 是否需要在 session list 中显示 fork badge，还是只在 session detail 顶部显示来源？
