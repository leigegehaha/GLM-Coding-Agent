# 智码 GLM Code Cowork 派生到新工作树设计文档

## 1. 概述

### 1.1 问题/背景

`2026-05-29-cowork-session-fork-design.md` 定义了 Cowork 会话分叉的总体模型，并将实现拆成两期：

1. **派生到本地**：复制会话历史，创建新的 Cowork session，保持当前文件和工作树状态不变。
2. **派生到新工作树**：在 Git 仓库中创建新的 worktree，让分叉 session 在独立工作区继续。

第一期解决“从当前或早期消息继续另一条对话路线”的问题，但不提供文件隔离。对于已经生成或修改代码的会话，用户通常希望后续改动不要覆盖原工作区。第二期通过 Git worktree 提供这种隔离能力。

本设计文档聚焦第二期，不重复定义会话历史复制逻辑。

### 1.2 目标

第二期目标是：

1. 在 Git 仓库中支持“派生到新工作树”。
2. 新建 worktree 后，将分叉 session 的 `cwd` 指向该 worktree。
3. 后续 OpenClaw 工具调用、文件写入、命令执行都在新 worktree 中运行。
4. 非 Git 目录禁用“派生到新工作树”。
5. dirty repo 第一版只做明确提示，不自动 checkpoint commit。
6. worktree 创建失败时不创建半成品 session。
7. worktree session 删除时不默认删除 worktree，避免误删用户后续修改。
8. 整体语义与 Codex “派生到新工作树”保持一致：隔离后续工作，不表示恢复到某条消息当时的完整文件状态。

### 1.3 非目标

第二期不做以下事情：

- 不实现非 Git 目录的复制快照。
- 不自动提交 checkpoint commit。
- 不默认携带 dirty repo 的未提交改动。
- 不自动删除 worktree 或 branch。
- 不处理数据库、缓存、node_modules、外部服务等命令副作用。
- 不实现复杂的 worktree 管理 UI。

## 2. 产品语义

### 2.1 用户可见能力

在分叉确认弹窗中，当源 session 的 `cwd` 位于 Git 仓库时，展示两个选项：

- `派生到本地`
- `派生到新工作树`

`派生到新工作树` 的说明：

- 在新的 Git worktree 中从该消息继续。
- 后续文件修改会发生在新工作树中。
- 当前文件和工作树状态不会回滚到来源消息当时。
- 命令和外部副作用不会被复制或回滚。

### 2.2 非 Git 目录

如果当前 `cwd` 不是 Git 仓库：

- `派生到本地` 可用。
- `派生到新工作树` 禁用。
- 禁用提示：`当前文件夹不是 Git 仓库，无法创建独立工作树。`

### 2.3 Dirty Git 仓库

如果当前 Git 仓库存在未提交改动：

- 第一版仍允许创建新 worktree，但默认基于 `HEAD`。
- UI 必须提示：`当前未提交改动不会自动带入新工作树。`
- 用户可以取消，或选择继续。

后续可扩展 `includeUncommittedChanges`，但不进入第二期第一版。

## 3. 用户场景

### 场景 1: clean Git repo 中派生到新工作树

**Given** 当前 session 的 `cwd` 位于 clean Git repo
**When** 用户选择“派生到新工作树”
**Then** 智码 GLM Code 创建新的 Git worktree

**And** 创建新的 Cowork session

**And** 新 session 的 `cwd` 指向 worktree 路径

**And** 后续工具调用在 worktree 中执行

### 场景 2: 非 Git 目录禁用新工作树

**Given** 当前 session 的 `cwd` 不在 Git repo 中
**When** 用户打开分叉弹窗
**Then** “派生到新工作树”不可选

**And** UI 提示需要 Git 仓库才能创建新工作树

### 场景 3: dirty Git repo 提示风险

**Given** 当前 Git repo 有未提交改动
**When** 用户选择“派生到新工作树”
**Then** 智码 GLM Code 提示未提交改动不会自动带入新工作树

**When** 用户确认继续
**Then** 智码 GLM Code 基于 `HEAD` 创建 worktree

### 场景 4: worktree 创建失败

**Given** branch 名称冲突、路径已存在或 Git 命令失败
**When** 用户选择“派生到新工作树”
**Then** 智码 GLM Code 不创建新 Cowork session

**And** UI 展示失败原因

**And** 如果已经创建了部分 worktree，主进程尝试清理

### 场景 5: 删除 worktree fork session

**Given** 用户删除一个 worktree fork session
**When** session 关联 `fork_workspace_path`
**Then** 第一版只删除 Cowork session

**And** 不自动删除 worktree 目录或 Git branch

**And** 后续版本可提供“同时移除工作树”的显式选项

## 4. 功能需求

### FR-1: Worktree capability 检测

新增主进程检测能力：

```ts
export const CoworkForkWorkspaceState = {
  None: 'none',
  GitClean: 'git_clean',
  GitDirty: 'git_dirty',
  NonGit: 'non_git',
} as const;
```

检测逻辑：

1. 源 session 不存在：返回错误。
2. 源 session `cwd` 为空：`None`。
3. `git rev-parse --show-toplevel` 失败：`NonGit`。
4. `git status --porcelain=v1` 非空：`GitDirty`。
5. 否则：`GitClean`。

### FR-2: Worktree 路径策略

推荐路径：

```text
{appUserData}/worktrees/{repoName}-{shortSessionId}
```

理由：

- 避免污染用户 repo。
- 便于 智码 GLM Code 后续做统一管理。
- 与 Codex `$CODEX_HOME/worktrees` 的思路一致。

路径要求：

- 必须是绝对路径。
- 如果目标路径已存在，追加短随机后缀。
- 路径写入 `cowork_sessions.fork_workspace_path`。

### FR-3: Branch 命名策略

推荐 branch：

```text
lobster/fork/{shortSessionId}
```

如果 branch 已存在：

```text
lobster/fork/{shortSessionId}-{shortRandom}
```

Branch 写入 `cowork_sessions.fork_git_branch`。

第一版使用 branch worktree，而不是 detached HEAD，便于用户后续 commit。

### FR-4: Worktree 创建

主进程服务接口：

```ts
interface CoworkWorktreeForkRequest {
  sourceSessionId: string;
}

interface CoworkWorktreeForkResult {
  cwd: string;
  branch: string;
  baseRef: string;
  repoRoot: string;
  dirty: boolean;
}
```

执行步骤：

1. 读取源 session。
2. 解析 repo root。
3. 检测 dirty 状态。
4. 生成 branch 和 worktree path。
5. 执行：

```bash
git worktree add -b <branch> <worktreePath> HEAD
```

6. 返回 worktree 信息。

命令执行必须使用参数数组，不拼接 shell 字符串。

### FR-5: Fork session 创建顺序

`cowork:session:fork` 在 `mode = worktree` 时：

1. 创建 worktree。
2. 调用 `CoworkStore.forkSession({ cwdOverride: worktreePath })`。
3. 返回新 session。

如果步骤 2 失败：

- 尝试执行 `git worktree remove <worktreePath>`。
- 如果清理失败，记录 warn，返回错误中包含残留路径。

### FR-6: OpenClaw 执行目录

无需改 OpenClawRuntimeAdapter 的核心逻辑。

现有逻辑会读取 `session.cwd` 并传给 `chat.send`。新 session 的 `cwd` 已经是 worktree path，因此后续工具调用自然在 worktree 中运行。

### FR-7: UI

分叉弹窗中新增选项：

- 标题：`派生到新工作树`
- 描述：`在新的工作树中从此处继续`

禁用状态：

- NonGit：禁用并提示非 Git。
- Running session：整个 fork 操作禁用或提示先停止。

Dirty 状态：

- 显示 warning block。
- 文案说明未提交改动不会自动带入新工作树。

### FR-8: i18n

新增或补充 keys：

- `coworkForkToWorktree`
- `coworkForkToWorktreeDescription`
- `coworkForkWorktreeNonGitDisabled`
- `coworkForkWorktreeDirtyTitle`
- `coworkForkWorktreeDirtyMessage`
- `coworkForkWorktreeCreateFailed`
- `coworkForkWorktreeCreated`

中英文必须同时添加。

## 5. 技术实现

### 5.1 文件结构

- Create: `src/main/libs/coworkFork/worktreeForkService.ts`
- Create: `src/main/libs/coworkFork/worktreeForkService.test.ts`
- Create: `src/main/libs/coworkFork/constants.ts`
- Modify: `src/main/main.ts`
- Modify: `src/main/coworkStore.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/types/cowork.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Modify: `src/renderer/services/cowork.ts`
- Modify: `src/renderer/components/cowork/CoworkForkSessionModal.tsx`
- Modify: `src/renderer/services/i18n.ts`

### 5.2 Git 命令封装

`WorktreeForkService` 应封装 Git 命令：

```ts
class WorktreeForkService {
  getCapability(cwd: string): Promise<CoworkForkWorkspaceState>;
  createWorktree(request: CoworkWorktreeForkRequest): Promise<CoworkWorktreeForkResult>;
}
```

内部 helper：

- `runGit(args, cwd)`
- `resolveRepoRoot(cwd)`
- `readHeadSha(cwd)`
- `isDirty(cwd)`
- `createUniqueBranchName(sessionId)`
- `createUniqueWorktreePath(repoRoot, sessionId)`

### 5.3 日志规范

主进程日志：

- 成功创建 worktree：`console.log('[CoworkFork] created worktree for session ...')`
- Git 检测失败但可恢复：`console.warn(...)`
- worktree 创建失败：`console.error('[CoworkFork] failed to create worktree:', error)`

遵守现有 logging guidelines：

- 英文日志。
- 错误对象作为最后一个参数。
- 不输出大段 diff。

## 6. 错误处理

### 6.1 常见错误

- `cwd` 不存在。
- `cwd` 不是 Git repo。
- Git executable 不存在。
- branch 已存在。
- worktree path 已存在。
- repo 当前有 lock。
- worktree add 失败。

### 6.2 用户提示

错误信息应转换为用户可理解文案：

- `当前文件夹不是 Git 仓库，无法创建新工作树。`
- `创建工作树失败，请检查 Git 状态后重试。`
- `目标工作树路径已存在，请重试。`

具体 Git stderr 可放到 DevTools 或日志，不直接展示大段原始输出。

## 7. 测试计划

### 7.1 单元测试

- clean repo 返回 `GitClean`。
- dirty repo 返回 `GitDirty`。
- non-Git cwd 返回 `NonGit`。
- branch 名称冲突时生成新 branch。
- worktree path 冲突时生成新路径。
- `createWorktree()` 返回 cwd、branch、baseRef。

### 7.2 集成测试

- `cowork:session:fork` with worktree mode 创建新 session。
- 新 session `cwd` 为 worktree path。
- worktree 创建失败时不创建 session。
- fork session 失败时尝试清理已创建 worktree。

### 7.3 手动测试

- 在 clean Git repo 中派生到新工作树，继续让 OpenClaw 修改文件。
- 确认原工作区文件不变。
- 在 non-Git 目录中确认按钮禁用。
- 在 dirty Git repo 中确认 warning 展示。
- 删除 worktree fork session 后，worktree 仍保留。

## 8. Deferred

后续可单独设计：

- Dirty repo 携带未提交改动。
- worktree 删除和 branch 删除 UI。
- worktree 列表与管理页。
- worktree 与 PR / commit 流程联动。
- 多 worktree 同源 session 的树状视图。
