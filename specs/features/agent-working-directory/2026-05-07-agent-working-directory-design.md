# Agent 独立工作目录设计文档

## 1. 概述

### 1.1 问题/背景

当前 智码 GLM Code 中用户在 Cowork 首页选择的工作目录来自全局 `cowork_config.workingDirectory`。当用户切换到任一 Agent 并修改工作目录时，实际修改的是同一份全局配置，因此所有 Agent 首页展示的工作目录都会同时变化。

这与 Agent 的产品语义不一致。用户创建多个 Agent 通常是为了让它们承担不同角色或面向不同项目，例如：

- `main` Agent 面向 智码 GLM Code 主工程。
- `docs` Agent 面向文档仓库。
- `ops` Agent 面向部署脚本目录。

这些 Agent 的默认模型、技能、人设已经是 Agent 级别配置，工作目录也应保持同样的隔离粒度。新建会话时可以使用当前 Agent 的默认工作目录，但会话创建后仍应把目录保存为 `cowork_sessions.cwd` 快照，避免后续修改 Agent 配置影响历史会话。

现有代码中已经有一部分正确基础：

- `cowork_sessions.cwd` 已经是 session 级别字段。
- `OpenClawRuntimeAdapter` 在发送 `chat.send` 时已经会读取 `session.cwd` 并传递给 OpenClaw。
- 问题主要集中在“新会话默认 cwd”和“首页目录选择控件”仍读写全局 `cowork_config.workingDirectory`。

### 1.2 目标

本功能的目标是：

1. 每个 Agent 拥有独立的默认工作目录。
2. 在任一 Agent 中切换工作目录，只影响当前 Agent，不影响其他 Agent。
3. 创建 Agent 时可以像指定默认模型一样指定默认工作目录。
4. 编辑 Agent 时可以修改该 Agent 的默认工作目录。
5. 新建 Cowork session 时使用当前 Agent 的默认工作目录，并写入 `cowork_sessions.cwd` 作为会话快照。
6. 继续会话时继续使用该 session 的 `cwd`，不跟随 Agent 默认目录变化。
7. IM / channel session 创建时按绑定 Agent 解析默认工作目录，而不是统一使用全局工作目录。
8. 保留旧的 `cowork_config.workingDirectory` 作为升级兼容 fallback，不再作为 Agent 首页目录切换的写入目标。

### 1.3 非目标

本设计不做以下事情：

- 不把 OpenClaw workspace 与用户项目 cwd 合并。OpenClaw workspace 仍用于 Agent 记忆、`AGENTS.md`、`IDENTITY.md` 等内部文件；用户项目 cwd 使用新增的 Agent 工作目录字段。
- 不迁移已有 `cowork_sessions.cwd`。历史会话目录本来就是会话快照，应保持原值。
- 不引入多工作区列表、项目收藏、目录权限策略等更大范围能力。
- 不移除 `cowork_config.workingDirectory` 字段，避免破坏旧数据和外部同步逻辑。

## 2. 用户场景

### 场景 1: 不同 Agent 使用不同默认工作目录

**Given** 用户有 Agent A 和 Agent B，二者默认工作目录分别为 `/repo/a` 和 `/repo/b`
**When** 用户切换到 Agent A 的 Cowork 首页
**Then** 目录选择器显示 `/repo/a`

**When** 用户切换到 Agent B 的 Cowork 首页
**Then** 目录选择器显示 `/repo/b`

### 场景 2: 在一个 Agent 中切换工作目录不影响其他 Agent

**Given** Agent A 默认工作目录为 `/repo/a`，Agent B 默认工作目录为 `/repo/b`
**When** 用户在 Agent A 首页把工作目录改为 `/repo/a-next`
**Then** Agent A 默认工作目录更新为 `/repo/a-next`

**And** Agent B 默认工作目录仍为 `/repo/b`

### 场景 3: 创建 Agent 时指定工作目录

**Given** 用户打开创建 Agent 弹窗
**When** 用户填写名称、默认模型、默认工作目录 `/repo/docs` 并保存
**Then** 新 Agent 被创建，默认工作目录为 `/repo/docs`

**And** 用户切换到该 Agent 后，Cowork 首页默认展示 `/repo/docs`

### 场景 4: 新建会话保存目录快照

**Given** Agent A 当前默认工作目录为 `/repo/a`
**When** 用户在 Agent A 下新建 Cowork session
**Then** 新 session 的 `cwd` 保存为 `/repo/a`

**When** 用户之后把 Agent A 默认工作目录改为 `/repo/a-next`
**Then** 旧 session 继续使用 `/repo/a`

**And** 新 session 使用 `/repo/a-next`

### 场景 5: 升级旧版本后不丢失目录

**Given** 旧版本只有全局 `cowork_config.workingDirectory = /repo/old`
**When** 用户升级到支持 Agent 独立工作目录的新版本
**Then** 现有 Agent 初始默认工作目录回填为 `/repo/old`

**And** 后续每个 Agent 可以独立修改自己的目录

### 场景 6: IM 绑定 Agent 使用自己的工作目录

**Given** IM 平台绑定到 Agent B，Agent B 默认工作目录为 `/repo/b`
**When** OpenClaw channel session 被同步到 智码 GLM Code 本地 session
**Then** 该 session 的 `cwd` 应为 `/repo/b`

**And** 不应使用其他 Agent 的目录或全局 fallback 目录。

## 3. 功能需求

### FR-1: Agent 数据模型增加默认工作目录

Agent 需要新增 `workingDirectory` 字段：

- 类型为 string。
- 空字符串表示未显式配置。
- 创建、更新、列表、详情接口均应返回该字段。
- 前端 Redux 中的 Agent summary 也应包含该字段，保证切换 Agent 时无需额外请求即可展示目录。

### FR-2: 数据迁移兼容旧全局目录

数据库迁移需要新增 `agents.working_directory` 列。

迁移策略：

1. 新列默认值为空字符串。
2. 升级时读取 `cowork_config.workingDirectory`。
3. 对现有 `working_directory` 为空的 Agent 回填该全局目录。
4. 不修改已有 `cowork_sessions.cwd`。

回填是为了保持升级后的首次体验与旧版本一致；从升级完成后开始，用户修改任一 Agent 的目录应只影响该 Agent。

### FR-3: 新建 session 时按 Agent 解析默认目录

`cowork:session:start` 应使用统一解析顺序：

1. 调用方显式传入的 `options.cwd`。
2. 当前 `agentId` 对应的 `agent.workingDirectory`。
3. 旧全局 `cowork_config.workingDirectory`。
4. 仍为空则返回“请先选择任务文件夹”的错误。

解析后的目录需要继续走现有 `resolveTaskWorkingDirectory()` 校验，确保目录存在且不是 Windows drive root。

### FR-4: 会话目录保持快照语义

创建 session 时把解析后的目录写入 `cowork_sessions.cwd`。

继续会话、停止会话、导出结果、文件路径解析等现有 session 级行为继续读取 `currentSession.cwd`，不读取 Agent 当前默认目录。

### FR-5: Cowork 首页目录选择器改为 Agent 级读写

首页 `CoworkPromptInput` 的 `workingDirectory` 应来自当前 Agent：

- `currentAgent.workingDirectory`
- 如果为空，则显示 legacy fallback `config.workingDirectory`

用户在首页选择新目录时，应调用 `agents:update` 更新当前 Agent 的 `workingDirectory`，而不是调用 `cowork:config:set` 修改全局配置。

成功更新后：

- Redux 中当前 Agent 的 `workingDirectory` 立即更新。
- 当前 Agent 新建 session 使用新目录。
- 其他 Agent 的目录不变化。

### FR-6: 创建和编辑 Agent 支持工作目录

Agent 创建弹窗和设置面板应增加默认工作目录控件。

交互要求：

- 控件位置建议放在“Agent 默认模型”附近。
- 支持选择目录和清空目录。
- 创建 Agent 时将 `workingDirectory` 写入 `CreateAgentRequest`。
- 编辑 Agent 时将 `workingDirectory` 写入 `UpdateAgentRequest`。
- 用户可见文案必须走 i18n，中英文都要补齐。

### FR-7: OpenClaw config 写出 per-agent cwd

OpenClaw workspace 与 cwd 需要保持清晰分工：

- `workspace` 仍指向 智码 GLM Code 管理的 OpenClaw Agent workspace，例如 `{STATE_DIR}/workspace-main` 或 `{STATE_DIR}/workspace-{agentId}`。
- `cwd` 表示该 Agent 默认用户项目目录。

`openclawConfigSync.ts` 在构建 `agents.list` 时应为每个 Agent 写入自己的 `cwd`：

```json
{
  "id": "docs",
  "workspace": "/.../openclaw/state/workspace-docs",
  "cwd": "/repo/docs",
  "model": {
    "primary": "provider/model"
  }
}
```

`agents.defaults.cwd` 可以继续作为 legacy fallback，但不应再成为所有 Agent 唯一目录来源。

### FR-8: IM / channel session 使用绑定 Agent 的目录

`OpenClawChannelSessionSync` 当前通过 `getDefaultCwd()` 统一获取目录。它需要改为可按 Agent 解析：

```ts
getDefaultCwd: (agentId?: string) => string
```

创建 channel session 时：

1. 从 session key 或平台绑定解析 `agentId`。
2. 读取该 Agent 的 `workingDirectory`。
3. 为空时 fallback 到 legacy 全局目录或 home 目录。

这样 IM 侧绑定到不同 Agent 时，也能获得不同 cwd。

### FR-9: Enterprise config 同步不覆盖本地目录

Enterprise config 同步 Agent 时，应保留本地已有 `workingDirectory`，除非企业配置未来显式提供 Agent 工作目录字段。

避免因为企业配置只包含 name/model/skills 等字段，就把用户本地设置的 Agent 工作目录覆盖为空。

## 4. 实现方案

### 4.1 数据库与 Store

涉及文件：

- `src/main/sqliteStore.ts`
- `src/main/coworkStore.ts`
- `src/main/agentManager.ts`

改动点：

1. `agents` 表新增 `working_directory TEXT NOT NULL DEFAULT ''`。
2. migration 中检测列是否存在，不存在则 `ALTER TABLE`。
3. migration 后读取 `cowork_config.workingDirectory`，对空值 Agent 进行回填。
4. `Agent` interface 增加 `workingDirectory`。
5. `CreateAgentRequest` 和 `UpdateAgentRequest` 增加 `workingDirectory`。
6. `listAgents()`、`getAgent()`、`createAgent()`、`updateAgent()`、`mapAgentRow()` 读写该字段。
7. `AgentManager.createAgent()` 对 `workingDirectory` 做 trim。

### 4.2 主进程目录解析

涉及文件：

- `src/main/main.ts`

建议新增 helper：

```ts
const resolveAgentWorkingDirectory = (
  agentId: string | undefined,
  explicitCwd?: string,
): string => {
  const explicit = explicitCwd?.trim();
  if (explicit) return explicit;

  const resolvedAgentId = agentId?.trim() || 'main';
  const agentCwd = getAgentManager().getAgent(resolvedAgentId)?.workingDirectory?.trim();
  if (agentCwd) return agentCwd;

  return getCoworkStore().getConfig().workingDirectory.trim();
};
```

`cowork:session:start` 使用该 helper 后再调用 `resolveTaskWorkingDirectory()`。

`selectedWorkspaceRoot` 命名建议改为 `selectedTaskDirectory` 或 `rawTaskDirectory`，避免继续混用 workspace 概念。

### 4.3 Renderer Agent 类型与状态

涉及文件：

- `src/renderer/types/agent.ts`
- `src/renderer/store/slices/agentSlice.ts`
- `src/renderer/services/agent.ts`
- `src/renderer/types/electron.d.ts`
- `src/main/preload.ts`

改动点：

1. 前端 `Agent` 和 `AgentSummary` 增加 `workingDirectory`。
2. `agentService.loadAgents()`、`createAgent()`、`updateAgent()`、`addPreset()` 映射该字段。
3. `window.electron.agents.create/update` 类型增加 `workingDirectory`。
4. Redux `updateAgent` 时把新的 `workingDirectory` 合并到 summary。

### 4.4 Cowork 首页目录选择

涉及文件：

- `src/renderer/components/cowork/CoworkView.tsx`
- `src/renderer/components/cowork/CoworkPromptInput.tsx`

`CoworkView` 中新增有效目录计算：

```ts
const currentAgentWorkingDirectory =
  currentAgent?.workingDirectory?.trim() || config.workingDirectory || '';
```

新建临时 session 和实际 `startSession()` 都使用 `currentAgentWorkingDirectory`。

目录选择回调改为：

```ts
onWorkingDirectoryChange={async (dir: string) => {
  await agentService.updateAgent(currentAgentId, { workingDirectory: dir });
}}
```

`CoworkPromptInput` 本身不需要知道目录属于全局还是 Agent，它继续通过 props 展示和返回目录即可。

### 4.5 Agent 创建与设置 UI

涉及文件：

- `src/renderer/components/agent/AgentCreateModal.tsx`
- `src/renderer/components/agent/AgentSettingsPanel.tsx`
- `src/renderer/components/cowork/FolderSelectorPopover.tsx`
- `src/renderer/services/i18n.ts`

实现建议：

1. `AgentCreateModal` 增加 `workingDirectory` state。
2. 弹窗打开时默认值可取当前 Agent 的 `workingDirectory` 或 legacy `config.workingDirectory`。
3. Basic tab 中在默认模型下方增加“默认工作目录”控件。
4. 控件复用现有 `FolderSelectorPopover`，避免重复实现目录选择逻辑。
5. `isDirty()`、`resetForm()`、提交 payload 都包含 `workingDirectory`。
6. `AgentSettingsPanel` 加载 Agent 详情时设置 `workingDirectory` state，并纳入 dirty detection。
7. 保存时传入 `workingDirectory: workingDirectory.trim()`。
8. i18n 新增中英文 key，例如：
   - `agentDefaultWorkingDirectory`
   - `agentDefaultWorkingDirectoryPlaceholder`
   - `agentDefaultWorkingDirectoryHint`

### 4.6 OpenClaw 配置同步

涉及文件：

- `src/main/libs/openclawAgentModels.ts`
- `src/main/libs/openclawConfigSync.ts`
- `src/main/libs/openclawConfigSync.test.ts`

`buildAgentEntry()` 增加 `cwd` 写出：

```ts
...(agent.workingDirectory?.trim()
  ? { cwd: path.resolve(agent.workingDirectory.trim()) }
  : {}),
```

注意：

- `workspace` 仍由调用方传入，用于 OpenClaw agent workspace。
- `cwd` 只在非空时写出。
- 主 Agent 和非主 Agent 都要支持。

`managedConfig.agents.defaults.cwd` 可保留 legacy fallback，但后续新 session 的准确目录应来自 Agent entry 或 `chat.send.cwd`。

### 4.7 Channel Session Sync

涉及文件：

- `src/main/libs/openclawChannelSessionSync.ts`
- `src/main/main.ts`

把依赖接口从：

```ts
getDefaultCwd: () => string;
```

改为：

```ts
getDefaultCwd: (agentId?: string) => string;
```

创建 session 时传入当前解析到的 `agentId`。

`main.ts` 注入逻辑：

```ts
getDefaultCwd: (agentId?: string) => {
  const resolvedAgentId = agentId?.trim() || 'main';
  const agentCwd = getCoworkStore().getAgent(resolvedAgentId)?.workingDirectory?.trim();
  return agentCwd || getCoworkStore().getConfig().workingDirectory || os.homedir();
}
```

### 4.8 旧全局配置的后续定位

`cowork_config.workingDirectory` 后续只承担兼容职责：

- 旧数据升级回填来源。
- Agent 未配置目录时的 fallback。
- 可能的 enterprise / deep link / 外部入口 fallback。

正常 UI 流程不再通过 `coworkService.updateConfig({ workingDirectory })` 修改它。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| Agent 工作目录为空 | fallback 到 legacy `cowork_config.workingDirectory`；仍为空则提交时报错 |
| Agent 工作目录不存在 | 新建 session 时由 `resolveTaskWorkingDirectory()` 报错 |
| 选择 Windows drive root | 沿用现有 drive root 禁止逻辑 |
| 删除当前 Agent | 现有逻辑切回 `main`；目录展示使用 `main.workingDirectory` |
| 编辑 Agent 时清空目录 | 允许清空；新 session 使用 legacy fallback 或要求重新选择 |
| 创建 preset Agent | 默认回填当前 legacy/global 目录或调用方提供的默认目录 |
| Enterprise 同步 Agent | 不覆盖本地 `workingDirectory`，除非企业配置明确提供 |
| 历史 session | 不迁移、不跟随 Agent 默认目录变化 |
| 当前已有临时 session | 临时 session 的 `cwd` 使用提交时计算出的当前 Agent 目录 |
| IM 绑定 Agent 无目录 | fallback 到 legacy global 或 home，避免 channel session 创建失败 |

## 6. 涉及文件

| 文件 | 改动内容 |
|------|----------|
| `src/main/sqliteStore.ts` | `agents.working_directory` 建表、迁移、旧全局目录回填 |
| `src/main/coworkStore.ts` | Agent 类型、CRUD、row mapping 增加 `workingDirectory` |
| `src/main/agentManager.ts` | 创建和更新 Agent 时规范化目录字段 |
| `src/main/main.ts` | 新建 session 和 channel sync 注入按 Agent 解析 cwd |
| `src/main/preload.ts` | IPC 类型和参数透传增加 `workingDirectory` |
| `src/main/libs/openclawAgentModels.ts` | OpenClaw agent entry 写出 per-agent `cwd` |
| `src/main/libs/openclawConfigSync.ts` | defaults fallback 与 per-agent cwd 同步 |
| `src/main/libs/openclawChannelSessionSync.ts` | channel session cwd 解析改为按 Agent |
| `src/renderer/types/agent.ts` | Agent 类型增加 `workingDirectory` |
| `src/renderer/types/electron.d.ts` | agents create/update IPC 类型增加 `workingDirectory` |
| `src/renderer/store/slices/agentSlice.ts` | Agent summary 增加 `workingDirectory` |
| `src/renderer/services/agent.ts` | Agent load/create/update 映射目录字段 |
| `src/renderer/components/cowork/CoworkView.tsx` | Cowork 首页目录使用当前 Agent 配置 |
| `src/renderer/components/agent/AgentCreateModal.tsx` | 创建 Agent 时支持指定目录 |
| `src/renderer/components/agent/AgentSettingsPanel.tsx` | 编辑 Agent 时支持修改目录 |
| `src/renderer/services/i18n.ts` | 新增中英文 UI 文案 |

## 7. 验收标准

### 7.1 自动化验证

| 验收项 | 建议测试 |
|--------|----------|
| Agent CRUD 保存目录 | `src/main/coworkStore.test.ts` |
| 数据库迁移回填旧目录 | `src/main/coworkStore.test.ts` 或 `sqliteStore` 迁移测试 |
| 新建 session 使用 Agent 目录 | main IPC handler 相关测试或 store/runtime 单测 |
| OpenClaw config 写出 per-agent cwd | `src/main/libs/openclawConfigSync.test.ts` |
| channel session 使用绑定 Agent 目录 | `openclawChannelSessionSync` 单测 |
| 前端 Agent 状态包含目录 | reducer/service 单测或现有 renderer 测试补充 |

推荐运行：

```bash
npm test -- coworkStore
npm test -- openclawConfigSync
npm run lint
```

### 7.2 手动验证

| 验收项 | 验证方法 |
|--------|----------|
| Agent A/B 目录隔离 | 创建两个 Agent，分别选择不同目录，切换后确认互不影响 |
| 创建 Agent 指定目录 | 创建时设置目录，保存后切到该 Agent，Cowork 首页显示该目录 |
| 编辑 Agent 修改目录 | 在 Agent 设置中修改目录，回到 Cowork 首页确认生效 |
| 新旧 session 快照 | 旧 session 创建后修改 Agent 目录，继续旧 session 确认仍使用旧 cwd |
| 新 session 使用新目录 | 修改 Agent 目录后新建 session，确认 `currentSession.cwd` 是新目录 |
| 旧数据升级 | 使用已有全局工作目录的数据库启动，确认现有 Agent 都有初始目录 |
| IM 绑定目录 | 将 IM 绑定到非 main Agent，创建 channel session 后检查 session `cwd` |

### 7.3 日志与行为要求

- 修改 Agent 工作目录不应触发所有 Agent 的目录 UI 同步变化。
- 修改 Agent 工作目录不应迁移 OpenClaw memory/bootstrap 文件。
- 修改 Agent 工作目录不应把 `agents.defaults.workspace` 改成用户项目目录。
- 新增日志如有必要，应符合 `AGENTS.md` logging guidelines，使用英文、自然句、带模块 tag。

