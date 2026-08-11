# 智码 GLM Code 工作目录与 OpenClaw Workspace 解耦设计文档

## 1. 概述

### 1.1 问题/动机

在 PR #1890 之前，智码 GLM Code 的 `workingDirectory` 同时承担两种职责：

1. 智码 GLM Code 用户选择的任务工作目录，用于桌面 Cowork 和 IM 会话的项目 cwd。
2. OpenClaw 的 `agents.defaults.workspace`，用于存放 `MEMORY.md`、`AGENTS.md`、`IDENTITY.md`、`USER.md`、`SOUL.md` 等 agent workspace 文件。

这种耦合会带来几个问题：

- 切换任务工作目录会把长期记忆、身份文件和 OpenClaw bootstrap 文件分散到不同项目目录。
- 用户只想切换项目 cwd 时，智码 GLM Code 需要同步 `MEMORY.md`、`IDENTITY.md` 并重写 `openclaw.json`。
- 个性化设置页面读写的是当前工作目录下的 bootstrap 文件，工作目录变化后用户看到的身份/记忆也随之变化。
- OpenClaw config 写入 `agents.defaults.workspace` 后，工作目录变化可能触发 gateway reload 或 hard restart。

### 1.2 目标

本轮解耦的产品目标是：

- 用户选择的 智码 GLM Code 工作目录只表达“当前任务在哪个项目目录执行”。
- OpenClaw workspace 只表达“agent 运行依赖的 profile/state 目录”，用于存放 `AGENTS.md`、`IDENTITY.md`、`USER.md`、`SOUL.md`、`MEMORY.md`、`memory/` 等文件。
- Agent 生成、读取、修改的用户项目文件必须落在用户选择的 智码 GLM Code 工作目录，而不是 OpenClaw workspace。
- 主 agent 的长期记忆和个性化文件集中存放在 智码 GLM Code 管理的固定 OpenClaw workspace。
- 迁移旧目录中的记忆和个性化文件，不删除源文件。
- 切换 智码 GLM Code 工作目录不应导致主 agent 的记忆文件迁移，也不应仅因 cwd 变化重写 OpenClaw config。
- 保持桌面 Cowork、IM 会话、OpenClaw native channel 会话的任务 cwd 行为可预测。

## 2. 现状分析

### 2.1 PR #1890 的实现

PR #1890 的核心提交为 `aa95848 feat: decouple main agent workspace from working directory`，后续两个提交清理了设置页里陈旧的存储路径展示。

该 PR 做了以下改动：

1. 在 `src/main/libs/openclawMemoryFile.ts` 新增 `getMainAgentWorkspacePath(stateDir)`，固定返回 `{STATE_DIR}/workspace-main`。
2. 将主 agent 的 `MEMORY.md`、bootstrap 文件读写入口改为使用 `getMainAgentWorkspacePath(getOpenClawEngineManager().getStateDir())`。
3. 在 `src/main/libs/openclawConfigSync.ts` 中把 OpenClaw `agents.defaults.workspace` 固定写成 `{STATE_DIR}/workspace-main`，并在该目录同步 `AGENTS.md` 和非 main agent 工作区文件。
4. 修改 `cowork:setConfig`：当 `workingDirectory` 变化时，只调用 `SkillManager.handleWorkingDirectoryChange()`，不再同步 `MEMORY.md`、不再确保 `IDENTITY.md`、也不再因为 working directory 变化触发 `syncOpenClawConfig()`。
5. 新增 `src/main/libs/openclawWorkspaceMigration.ts`，在应用启动时执行一次迁移：
   - `MEMORY.md` 使用 `syncMemoryFileOnWorkspaceChange(oldDir, newDir)` 做 merge-dedup。
   - `IDENTITY.md`、`USER.md`、`SOUL.md` 仅在目标文件不存在或为空时复制。
   - `memory/` 日志目录在目标目录不存在时整体复制。
   - 迁移完成后写入 SQLite kv flag。
6. Settings 页面移除“bootstrap storage path”相关展示文案，避免 UI 继续暗示文件跟随工作目录。

### 2.2 PR #1894 的实现

PR #1894 的提交为 `5b84ab8 fix: reorder workspace migration to copy memory/ before MEMORY.md sync`。

该 PR 发现 `syncMemoryFileOnWorkspaceChange()` 会在目标 workspace 中创建空的 `memory/` 目录。如果先同步 `MEMORY.md`，再调用 `copyDirIfNeeded(oldMemoryDir, newMemoryDir)`，后者会因为目标目录已经存在而跳过旧 `memory/` 的复制。

它做了两件事：

1. 将 `memory/` 目录复制移动到 `MEMORY.md` 同步之前。
2. 将迁移 key 从 `migration.mainAgentWorkspace.v1.completed` 升级到 `migration.mainAgentWorkspace.v2.completed`，期望已经跑过 v1 的用户可以重试。

### 2.3 当前路径语义

当前代码中实际存在三类路径：

| 概念 | 当前字段/函数 | 当前用途 |
|------|---------------|----------|
| 智码 GLM Code 任务工作目录 | `CoworkConfig.workingDirectory`、`CoworkSession.cwd` | UI 选择的任务目录，保存到 session，IM 会话也依赖它 |
| OpenClaw 主 agent workspace | `getMainAgentWorkspacePath(stateDir)` | 固定为 `{STATE_DIR}/workspace-main`，保存记忆和 bootstrap 文件 |
| OpenClaw runtime workspace/cwd | `openclaw.json` 的 `agents.defaults.workspace` | 当前也被写成 `{STATE_DIR}/workspace-main` |

目标语义应该是：第二行的 OpenClaw workspace 默认固定为 `{STATE_DIR}/workspace-main`，只保存 OpenClaw 依赖的 MD 文件和 `memory/`；第三行的 runtime cwd 则应由 智码 GLM Code session cwd 决定。

这里的关键问题不是 `{STATE_DIR}/workspace-main` 这个默认位置，而是当前 OpenClaw 文档和源码仍将 `agents.defaults.workspace` 定义为 agent 的工具 cwd 和上下文 workspace。因此 PR #1890 固定 OpenClaw workspace 的方向是正确的，但在缺少独立 task cwd 通道时，也会改变 OpenClaw 工具实际运行目录。

## 3. 方案评估

### 3.1 当前方案的优点

- 主 agent 的 `MEMORY.md`、`IDENTITY.md`、`USER.md`、`SOUL.md` 不再随用户工作目录漂移。
- 切换 智码 GLM Code 工作目录不会立即触发 OpenClaw config sync，减少 gateway reload/restart 风险。
- Settings 页面读写固定 OpenClaw 依赖文件，产品概念更接近“全局个性化”。
- 迁移过程不删除旧文件，失败时不会破坏用户原始项目目录。

### 3.2 当前方案的不妥之处

#### 问题 1: 只固定 OpenClaw workspace 还不足以保证用户文件落到任务目录

`openclawConfigSync.ts` 将 `agents.defaults.workspace` 固定为 `{STATE_DIR}/workspace-main`，这符合“OpenClaw workspace 只放 OpenClaw 依赖文件”的目标。但当前 OpenClaw agent runtime 仍将该字段作为工具和上下文的唯一工作目录。

同时，智码 GLM Code 在 `cowork:session:start` 里虽然保存了 `taskWorkingDirectory` 并向 runtime 传入 `workspaceRoot`，但 `OpenClawRuntimeAdapter.startSession()` 没有把 `workspaceRoot` 继续传给 `runTurn()`，`chat.send` 请求也没有携带 cwd 或 workspace override。

结果是：用户选择 `/path/to/project` 后，UI 和数据库里 session cwd 是项目目录，但 OpenClaw read/write/edit/exec/apply_patch 的默认目录可能变成 `{STATE_DIR}/workspace-main`。这会导致桌面 Cowork、IM 会话和 OpenClaw native channel 会话都无法可靠操作用户选择的项目。

#### 问题 2: PR #1894 不能修复已经命中 v1 bug 的用户

PR #1894 将迁移 key 升级到 v2，但 `copyDirIfNeeded()` 仍然在目标 `memory/` 目录存在时直接跳过。

如果用户已经跑过 v1，v1 可能已经由 `syncMemoryFileOnWorkspaceChange()` 创建了一个空的 `{STATE_DIR}/workspace-main/memory/`，然后错误地跳过旧 `memory/` 复制。v2 再次运行时，目标目录仍然存在，所以仍然会跳过复制。

因此，key bump 只会让迁移函数重新进入，但不会恢复已经被空目录挡住的旧 daily memory。

#### 问题 3: 迁移没有覆盖完整 workspace 文件

迁移注释说要移动主 agent workspace 文件，但当前只复制：

- `MEMORY.md`
- `memory/`
- `IDENTITY.md`
- `USER.md`
- `SOUL.md`

没有迁移用户可能编辑过的：

- `AGENTS.md` 的用户内容区
- `TOOLS.md`
- `BOOTSTRAP.md`
- 其他 OpenClaw workspace 级别用户文件

其中 `AGENTS.md` 尤其重要。后续 `syncAgentsMd()` 会在新目录生成 managed section，但如果旧工作目录的 `AGENTS.md` 有用户自定义内容，新目录没有对应文件时会退回 bundled template，用户内容会丢失在新 workspace 语义里。

#### 问题 4: 迁移幂等性粒度过粗

当前使用单个 `migration.mainAgentWorkspace.v2.completed` 标记整个迁移完成。只要函数跑到最后，就会标记完成，即使中间某些文件复制失败或被跳过。

更稳妥的迁移应该按 artifact 记录状态，至少区分：

- `MEMORY.md` merge 是否完成
- `memory/` 是否完成递归合并
- bootstrap 文件是否完成
- `AGENTS.md` 用户区是否完成

否则一个非致命 warn 就可能变成永久跳过。

#### 问题 5: Enterprise config 仍然混用 workspace 和 workingDirectory

`enterpriseConfigSync.ts` 仍然把外部 `openclaw.json` 的 `agents.defaults.workspace` 写回 智码 GLM Code `workingDirectory`。在新的语义下，如果 `agents.defaults.workspace` 表示固定的 OpenClaw workspace，这个同步会把 智码 GLM Code 任务目录改成 OpenClaw 私有目录。

这说明当前解耦没有形成端到端的数据模型，只是在部分调用点替换了路径。

## 4. 推荐方案

### 4.1 明确定义三个路径概念

后续实现应显式区分三类路径，并避免继续用 `workspace` 同时表达多种含义：

| 新概念 | 建议命名 | 所有者 | 说明 |
|--------|----------|--------|------|
| 任务工作目录 | `taskWorkingDirectory` | 智码 GLM Code session | 用户选择的项目目录，是工具读写和命令执行的 cwd |
| OpenClaw workspace | `mainOpenClawWorkspace` | 智码 GLM Code/OpenClaw | 保存 `MEMORY.md`、`memory/`、`AGENTS.md`、`IDENTITY.md`、`USER.md`、`SOUL.md` 等 OpenClaw 依赖文件 |
| Runtime cwd | `runtimeCwd` | OpenClaw run | 当前 turn 实际使用的工具 cwd，应由 session cwd 决定 |

智码 GLM Code 现有 `CoworkConfig.workingDirectory` 可以保留作为兼容字段，但代码内部新增 helper 或注释时应称为 task directory，不再称为 OpenClaw workspace。

### 4.2 OpenClaw 侧增加一等 runtime cwd 能力

根本修复需要 OpenClaw 支持 workspace 与 runtime cwd 分离。建议保留 OpenClaw `workspace` 作为 OpenClaw 依赖文件目录，默认值为 `{STATE_DIR}/workspace-main`；再新增用于工具执行和用户文件落盘的 cwd 字段：

```json5
{
  "agents": {
    "defaults": {
      "workspace": "/Users/me/Library/Application Support/智码 GLM Code/openclaw/state/workspace-main",
      "cwd": "/Users/me/project"
    }
  }
}
```

运行时规则：

1. `workspace` 只作为 bootstrap/context/memory 等 OpenClaw 依赖文件目录。
2. `cwd` 或 per-run `runtimeCwd` 作为 read/write/edit/exec/apply_patch 的默认目录、媒体相对路径和用户文件落盘目录。
3. 如果未配置 `cwd`，为了兼容 OpenClaw 独立使用，回退到 `workspace`。
4. `chat.send` 或 `sessions.patch` 支持 owner-only 的 per-run `cwd`，并在 session 创建时持久化，以保证继续会话、compaction、follow-up 都使用同一个任务目录。

这样 智码 GLM Code 可以做到：

- `workspace` 固定写 `{STATE_DIR}/workspace-main`。
- 桌面 Cowork 每个 session 将 `CoworkSession.cwd` 传给 `chat.send.cwd`。
- IM 会话创建时也传入 resolved task cwd。
- Native channel 会话没有显式 task cwd 时，使用 智码 GLM Code 当前配置的默认 task directory，而不是 OpenClaw workspace。

### 4.3 智码 GLM Code 侧调整

在 OpenClaw 支持上述能力后，智码 GLM Code 应按以下方式落地：

1. `openclawConfigSync.ts`
   - 写入 `agents.defaults.workspace = getMainAgentWorkspacePath(stateDir)`。
   - 写入 `agents.defaults.cwd = coworkConfig.workingDirectory` 作为默认 task cwd fallback。
   - `syncAgentsMd()`、bootstrap read/write、memory UI 继续使用 OpenClaw workspace。
2. `OpenClawRuntimeAdapter`
   - `startSession()` 和 `continueSession()` 读取 `CoworkSession.cwd`。
   - `chat.send` 携带 `cwd: session.cwd`。
   - 删除未使用的 `workspaceRoot` 透传，或改名为 `taskWorkingDirectory` 并真正使用。
3. `cowork:setConfig`
   - 变更 task directory 不需要迁移记忆。
   - 如果 OpenClaw config 只保存 fallback workspace，可以选择同步但不要求 gateway hard restart。
4. `enterpriseConfigSync.ts`
   - 只从企业配置中的明确 task cwd 字段同步 智码 GLM Code `workingDirectory`。
   - 不再把 OpenClaw workspace 写入 `workingDirectory`。

### 4.4 迁移修正

迁移逻辑应改成“合并”而不是“目标存在则跳过”：

1. `memory/` 目录递归合并：
   - 目标文件不存在：直接复制。
   - 目标文件存在且内容相同：跳过。
   - 目标文件存在且内容不同：保留目标文件，将源文件复制为 `<name>.migrated-<timestamp>` 或写入冲突子目录。
   - 目标目录为空但源目录非空时必须复制，修复 v1/v2 已命中用户。
2. `AGENTS.md` 迁移：
   - 读取旧文件中 managed marker 之前的用户内容。
   - 如果新文件没有用户内容，则迁移过去。
   - 如果新文件已有用户内容且不同，生成冲突备份。
3. `TOOLS.md`、`BOOTSTRAP.md`：
   - 按 bootstrap 文件同样的“空目标才复制，冲突则备份”策略处理。
4. 迁移状态：
   - 使用 per-artifact migration keys 或一个 JSON 状态对象。
   - 只有必需 artifact 完成或明确无源文件时才标记对应项完成。
   - 失败项下次启动继续重试。

### 4.5 短期止血方案

如果短期无法修改 OpenClaw API，不建议只在 智码 GLM Code 侧把 `agents.defaults.workspace` 固定到 `{STATE_DIR}/workspace-main` 后直接发布。固定到 `{STATE_DIR}/workspace-main` 本身是正确目标，但它必须和 runtime cwd 分离一起生效。更安全的临时方案是：

1. 同步 patch OpenClaw bundled runtime，让 `chat.send.cwd` 或等价字段真正控制工具默认 cwd。
2. 在 OpenClaw patch 没有落地前，如果必须防止用户文件写错位置，可以临时保持 `agents.defaults.workspace` 指向用户任务工作目录；这是止血兼容，不是目标设计。
3. 将主 agent 记忆和 OpenClaw 依赖文件固定目录作为 智码 GLM Code 内部存储，但通过明确的 OpenClaw runtime cwd 支持后再接入 runtime。
4. 如果必须让 OpenClaw 读取固定记忆目录，应优先在 OpenClaw 增加 workspace/cwd 分离能力，而不是用提示词要求 agent 自己读绝对路径。

目标状态仍然是：OpenClaw workspace 默认在 `{STATE_DIR}/workspace-main`，用户生成文件默认在 智码 GLM Code task cwd。

## 5. 实施步骤

### 阶段一：修复迁移和测试

1. 为 `openclawWorkspaceMigration.ts` 增加单测。
2. 修复 `memory/` 合并逻辑，覆盖“目标空目录已存在”的场景。
3. 迁移 `AGENTS.md` 用户区、`TOOLS.md`、`BOOTSTRAP.md`。
4. 调整 migration key 状态粒度，失败项可重试。

### 阶段二：修复路径模型

1. 在 智码 GLM Code 代码中引入 `taskWorkingDirectory` 与 `mainOpenClawWorkspace` helper。
2. 清理 `workspaceRoot` 这种容易误导的参数名。
3. 增加测试证明 `workingDirectory` 变化不会改变 OpenClaw 依赖文件位置。
4. 增加测试证明 session cwd 会传给 OpenClaw runtime。

### 阶段三：OpenClaw 协议支持

1. OpenClaw 增加 `cwd` 配置或等价字段。
2. OpenClaw `chat.send`/session entry 增加 owner-only per-run cwd override。
3. OpenClaw runtime 区分 bootstrap/memory workspace 和 tool cwd。
4. 智码 GLM Code 改为使用新协议。

## 6. 涉及文件

PR #1890 已涉及：

- `src/main/libs/openclawConfigSync.ts`
- `src/main/libs/openclawMemoryFile.ts`
- `src/main/libs/openclawWorkspaceMigration.ts`
- `src/main/main.ts`
- `src/renderer/components/Settings.tsx`
- `src/renderer/services/i18n.ts`

建议继续涉及：

- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
- `src/main/libs/enterpriseConfigSync.ts`
- `src/main/libs/openclawWorkspaceMigration.test.ts`
- `src/main/libs/openclawConfigSync.runtime.test.ts`
- `src/main/libs/openclawMemoryFile.test.ts`
- OpenClaw gateway protocol and agent runtime files

## 7. 验证计划

### 单元测试

- `getMainAgentWorkspacePath()` 始终返回 `{STATE_DIR}/workspace-main`。
- memory UI 和 bootstrap IPC 始终读写 OpenClaw workspace。
- 迁移可以从旧工作目录复制 `MEMORY.md`、`memory/`、`IDENTITY.md`、`USER.md`、`SOUL.md`、`AGENTS.md` 用户区。
- 当目标 `memory/` 已存在但为空时，迁移仍会复制旧 daily notes。
- 当目标文件存在且内容不同，迁移不会覆盖，必须保留冲突备份。
- `openclawConfigSync` 写入 OpenClaw workspace 和 task cwd 时语义正确。
- `OpenClawRuntimeAdapter` 向 OpenClaw 发送当前 `CoworkSession.cwd`。

### 手工验证

- 选择项目 A，启动 Cowork，让 agent 执行 `pwd`，结果应为项目 A。
- 切换到项目 B，启动新 Cowork，让 agent 执行 `pwd`，结果应为项目 B。
- 回到项目 A 的旧 session 继续对话，让 agent 执行 `pwd`，结果仍为项目 A。
- 在 Settings 修改记忆或身份文件，切换工作目录后内容不变化。
- 从旧版本升级后，旧工作目录中的 `MEMORY.md`、`memory/` daily notes、`AGENTS.md` 用户内容都出现在 OpenClaw workspace 或冲突备份中。
- IM 会话和 OpenClaw native channel 会话使用配置的 task directory，而不是 `{STATE_DIR}/workspace-main`。

## 8. 验收标准

1. 智码 GLM Code 用户工作目录不再决定主 agent 记忆和 OpenClaw 依赖文件的位置。
2. OpenClaw workspace 只保存 OpenClaw 依赖的 MD 文件和 `memory/`，不作为用户生成文件的默认落盘目录。
3. OpenClaw 工具实际 cwd 等于用户选择或 session 保存的任务目录。
4. 切换工作目录不会丢失或切换 Settings 页面中的长期记忆、身份和 persona。
5. 旧版本用户升级后不会丢失 `memory/` daily notes 或 `AGENTS.md` 用户内容。
6. 迁移失败可重试，不会因为单个全局 migration key 永久跳过。
7. Enterprise config 不再把 OpenClaw workspace 写回 智码 GLM Code task working directory。
