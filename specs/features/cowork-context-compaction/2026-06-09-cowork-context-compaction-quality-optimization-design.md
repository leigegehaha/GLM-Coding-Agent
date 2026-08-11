# 智码 GLM Code Cowork 上下文压缩质量优化设计文档

## 1. 概述

### 1.1 背景

`2026-05-08-cowork-context-compaction-design.md` 已完成 智码 GLM Code 对 OpenClaw 上下文压缩能力的产品接入：上下文使用量展示、手动压缩、自动压缩事件、maintenance/silent 消息过滤，以及压缩 retry 期间的运行态保护。

近期用户反馈：压缩后模型回复质量明显下降，感觉“大模型被搞傻了”。反馈中建议结合 RTK/插件能力，从“省 token”和“上下文维持”两个方向继续优化，后续也可考虑接入 claw3d 等更强能力。

本问题和第一版接入目标不同：第一版解决“压缩能不能触发、能不能展示、压缩期间 UI 是否正确”；本优化要解决“压缩后模型还能不能继续像压缩前一样理解任务”。

### 1.2 核心判断

压缩是有损过程。OpenClaw 默认 compaction summary 可以降低 token，但不一定保留 coding session 中最关键的可执行上下文，例如：

- 当前任务目标和完成标准。
- 用户明确约束和偏好。
- 已经尝试过的方案、失败原因和下一步计划。
- 最近修改的文件、函数、接口和配置。
- 工具结果中的具体错误、测试失败和日志片段。
- 本轮选择的 Kit/Skill/插件能力。
- 长任务中“正在做什么”和“不要重复做什么”。

因此，“压缩后变笨”大概率不是上下文圆环或 IPC 接入导致，而是模型压缩后只看到泛化摘要，缺少继续 coding 所需的结构化任务状态和可检索证据。

### 1.3 目标

1. 不替用户默认指定或切换 compaction model。
2. 在不改用户模型选择的前提下，提高压缩后任务连续性。
3. 让 智码 GLM Code 保存一份可控的任务连续性上下文，而不是完全依赖 OpenClaw summary。
4. 压缩后按需恢复关键原文证据，减少 summary 丢细节导致的退化。
5. 增加诊断能力，能判断一次压缩是成功、无 checkpoint、summary 过短，还是压缩后上下文仍超限。
6. 保持现有 OpenClaw compaction 接入和 UI 行为，避免大规模重写。

### 1.4 非目标

- 不默认设置 `agents.defaults.compaction.model` 为某个“更强模型”。
- 不默认替用户切换模型、provider 或 base URL。
- 不实现自定义模型能力评测或自动选择 compaction model。
- 不把完整历史重新塞回上下文。
- 不展示完整 compaction summary 给普通用户。
- 不把 OpenClaw assembled context 中的 `compactionSummary` 当成 智码 GLM Code 可见消息。
- 不把 RTK/RAG 作为第一步强依赖；第一阶段先做 continuity capsule 和诊断。

### 1.5 行业参考

`continuity capsule` 是 智码 GLM Code 对该能力的命名，本质属于行业内常见的 session-scoped short-term memory / context engineering 模式：

- LangGraph/LangChain memory：把 thread-scoped state 作为短期记忆，并通过 checkpointer 持久化；单份持续更新的 profile/state JSON 是常见模式。
  - https://docs.langchain.com/oss/python/concepts/memory
- Letta/MemGPT：通过 memory blocks 保留始终可见的结构化记忆，并在 compaction 后继续把关键 memory 注入上下文。
  - https://docs.letta.com/guides/core-concepts/stateful-agents
  - https://docs.letta.com/guides/core-concepts/memory/memory-blocks/
  - https://docs.letta.com/guides/core-concepts/messages/compaction/
- Semantic Kernel Chat History Reducer：用 truncation / summarization / token-based reducer 降低聊天历史，同时强调保留关键上下文、隐私和安全。
  - https://learn.microsoft.com/en-us/semantic-kernel/concepts/ai-services/chat-completion/chat-history
- MemGPT 论文：提出 virtual context management，在有限 context window 内管理热记忆和冷记忆。
  - https://arxiv.org/abs/2310.08560

智码 GLM Code 不直接引入这些框架，而是采用它们的核心原则：用一份短小、结构化、可持久化的任务状态补足压缩摘要的缺陷。

## 2. 什么能做，什么不能做

### 2.1 不能默认做

#### 不能默认指定更强的 compaction model

用户的模型是自定义的，智码 GLM Code 不知道哪个模型更适合压缩。强行把 `agents.defaults.compaction.model` 改成某个默认模型会带来问题：

- 用户可能没有该模型权限。
- 用户可能使用私有 provider 或内网模型。
- 用户可能希望所有推理都走同一个自定义模型。
- 不同 provider 的模型 ID、上下文窗口、价格和能力不可统一假设。
- 自动切模型可能破坏企业配置或审计预期。

因此该项只能作为后续高级配置：

- 用户显式选择“压缩模型”。
- 默认值为空，表示沿用 OpenClaw 当前策略。
- UI 必须说明这是可选高级项。

第一版优化不做该配置。

#### 不能默认降低未知模型 context window

沿用原设计：未知模型不贸然改小 context window，也不改变 OpenClaw 默认兜底策略。压缩质量优化应通过更好的上下文组织实现，而不是靠更早压缩。

### 2.2 能做且应该做

1. 修复 context maintenance 事件转发链路，让整理上下文状态稳定展示。
2. 在压缩完成后读取 checkpoint metadata 做诊断。
3. 为每个 Cowork session 维护 智码 GLM Code 自己的 continuity capsule。
4. 压缩后继续会话时，把 continuity capsule 注入为隐藏 bridge。
5. 压缩后对 coding session 自动补充轻量 workspace state。
6. 后续先引入 Top-K Evidence，从 session 历史和工具结果中检索相关原文片段；效果不足时再升级到 RTK/RAG。
7. 后续加入压缩质量审计，检查 summary/capsule 是否漏掉关键任务状态。

## 3. 用户场景

### 场景 1: 压缩后继续 coding

**Given** 用户在长 Cowork 任务中已经触发上下文压缩
**When** 用户继续追问“继续刚才的实现”或“把测试也补上”
**Then** 模型仍能知道当前任务目标、已修改文件、下一步计划和未解决问题
**And** 不需要用户重新复述大量上下文

### 场景 2: 压缩摘要遗漏细节

**Given** OpenClaw compaction summary 只保留了泛化描述
**When** 用户后续问题需要具体文件、错误或工具结果
**Then** 智码 GLM Code 可以通过 continuity capsule 和检索结果补回关键证据
**And** 不把完整旧历史重新塞回上下文

### 场景 3: 压缩期间用户误判

**Given** OpenClaw 正在 memory flush、auto-compaction 或 retry
**When** renderer 收到 context maintenance 状态
**Then** 输入区和消息列表稳定展示 `正在整理上下文...`
**And** 用户不会误以为任务已结束

### 场景 4: 定位压缩质量问题

**Given** 用户反馈压缩后质量下降
**When** 开发者查看日志或诊断状态
**Then** 可以看到本次压缩是否产生 checkpoint、token 是否下降、summary 是否为空或过短、reason 是 manual 还是 overflow retry
**And** 日志不包含完整 prompt、完整模型回复、完整 summary 或 API key

## 4. 方案分层

### 4.1 第一阶段：链路和诊断

第一阶段目标是“知道发生了什么，并确保用户看得到整理上下文状态”。

#### FR-1: 补齐 contextMaintenance 转发链路

当前 OpenClaw runtime adapter 已 emit `contextMaintenance`，main process 也已监听 router 的 `contextMaintenance` 并转发 `cowork:stream:contextMaintenance`。

需要确保：

- `CoworkEngineRouter.bindRuntimeEvents()` 转发 runtime 的 `contextMaintenance`。
- renderer `coworkService` 收到后更新 `contextMaintenanceSessionIds`。
- `StreamingActivityBar` 优先显示 `coworkContextMaintenanceRunning`。

涉及文件：

- `src/main/libs/agentEngine/coworkEngineRouter.ts`
- `src/main/libs/agentEngine/coworkEngineRouter.test.ts`
- `src/main/main.ts`
- `src/renderer/services/cowork.ts`
- `src/renderer/components/cowork/CoworkSessionDetail.tsx`

#### FR-2: 压缩诊断 metadata

第二点本质是“安全结构化日志”，不是 UI 功能、不是新的持久化状态，也不改变 OpenClaw 的压缩行为。第一版只在压缩结束后补充可排查的元信息，让后续反馈能判断“有没有产生 checkpoint、summary 是否为空/过短、token 是否真的下降、是手动压缩还是自动 overflow/retry 压缩”。

在手动压缩和自动压缩完成后，尝试读取 OpenClaw checkpoint metadata：

- `sessions.compaction.list`
- `sessions.compaction.get`

记录安全诊断字段：

```ts
type ContextCompactionDiagnostic = {
  sessionId: string;
  sessionKey?: string;
  mode: 'manual' | 'auto';
  reason?: string;
  checkpointId?: string;
  checkpointCreatedAt?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  summaryChars?: number;
  hasSummary: boolean;
  compacted?: boolean;
  updatedAt: number;
};
```

日志规则：

- 可以记录 `summaryChars`、`tokensBefore`、`tokensAfter`、`reason`、`checkpointId`。
- 不记录完整 summary。
- 不记录完整 prompt、完整模型回复、工具结果正文或 secret。
- warn/error 必须包含 error 对象作为最后一个参数。

状态保存：

- 第一版只输出安全结构化日志，不写数据库，不增加 renderer 状态。
- 如果后续要 UI 展示最近压缩诊断，再考虑 SQLite schema。

### 4.2 第二阶段：Continuity Capsule

第二阶段目标是“压缩后仍有任务连续性”。它不是替代 OpenClaw compaction，也不是再做一份完整聊天摘要，而是维护一张 智码 GLM Code 自己的“当前任务工作卡片”。

核心策略：

- 每个 Cowork session 只维护一份滚动更新的 capsule。
- capsule 记录任务状态，不记录完整历史。
- 关键事件后覆盖更新，不保存无限版本。
- 压缩后继续会话时，把最新 capsule 注入为隐藏 bridge。
- 未发生压缩或 capsule 为空时，不额外加重普通 prompt。

#### FR-3: 定义 智码 GLM Code continuity capsule

为 Cowork session 维护一份结构化任务状态：

```ts
type CoworkContinuityCapsule = {
  version: 1;
  sessionId: string;
  revision: number;
  updatedAt: number;
  lastSource: 'user_message' | 'post_run' | 'tool_result' | 'pre_compaction' | 'post_compaction' | 'manual' | 'fork';
  lastSourceMessageId?: string;
  lastCompactedAt?: number;
  currentObjective?: string;
  userConstraints: string[];
  decisions: string[];
  completedFacts: string[];
  recentActions: string[];
  touchedFiles: Array<{
    path: string;
    reason?: string;
  }>;
  keySymbols: Array<{
    name: string;
    file?: string;
    reason?: string;
  }>;
  verification: string[];
  nextSteps: string[];
  recentFailures: Array<{
    command?: string;
    summary: string;
  }>;
  activeCapabilities: Array<{
    kind: 'skill' | 'kit' | 'mcp' | 'tool';
    id: string;
    name?: string;
  }>;
  openQuestions: string[];
};
```

字段定位：

- `currentObjective`：当前用户目标和完成标准。
- `userConstraints`：用户明确说过的约束、偏好和禁区。
- `decisions`：已经确认的设计/实现决定，避免压缩后反复推翻。
- `completedFacts`：已经完成且可作为后续问答依据的状态事实，例如“英文版已集成到同一个 index.html 的 EN 切换里”，避免压缩后把“没有独立文件”误判为“没有完成”。
- `recentActions`：最近已经完成的动作。
- `touchedFiles` / `keySymbols`：最近相关文件和关键符号，只记录路径/名称和原因。
- `verification` / `recentFailures`：跑过的命令、测试结论和失败摘要。
- `nextSteps`：压缩后继续时最该执行的下一步。
- `openQuestions`：尚未确认的问题，避免模型压缩后自行猜测。

生成原则：

- 只保存任务状态，不保存大段聊天。
- 优先保留文件路径、函数名、命令、错误摘要、决策和 TODO。
- 不保存 secret、token、完整日志、完整 tool result。
- 单个 capsule 有上限，MVP 建议 2k-4k 字符，最多不超过 6k 字符。
- 每类字段有数量上限，例如 constraints 8 条、decisions 12 条、files 20 个、nextSteps 8 条。
- 更新是覆盖式 merge，不无限增长。
- 重复内容按规范化文本去重，较新的状态覆盖较旧状态。

#### FR-4: Capsule 生成时机

第一版更新时机：

1. 用户发新消息后：
   - 更新 `currentObjective`、`userConstraints`、`openQuestions`。
   - 只处理低频消息级事件，不处理 token delta。
2. assistant 完成一轮后：
   - 更新 `decisions`、`recentActions`、`nextSteps`。
   - 以 session complete / turn complete 为边界。
3. 工具调用完成后：
   - 如果涉及文件读写、命令、测试、构建，更新 `touchedFiles`、`verification`、`recentFailures`。
   - 只记录摘要和路径，不记录完整 stdout/stderr。
4. 手动 compact 前：
   - 强制刷新一次 capsule，确保压缩前任务状态最新。
5. 自动 compaction：
   - `phase=start` 时尽力刷新一次。
   - `phase=end completed=true` 后可补一次 checkpoint/usage 相关 metadata。
6. fork session 时：
   - 从源 session 复制最新 capsule，并裁剪为新 session 的初始 capsule。

更新节流：

- 不在 stream delta、polling tick 或每个小工具事件上写库。
- 同一 turn 内可以先在内存聚合，turn 完成后一次性持久化。
- compaction 前刷新应有短超时，失败不阻塞原 compaction。

如果 compact 前生成失败：

- 不阻塞 OpenClaw 原始 compaction。
- 记录 warn。
- 后续仍可用 post-run 或 checkpoint summary 生成。

#### FR-5: Capsule 生成方式

第一版不引入额外模型选择。

候选实现：

1. 规则提取：
   - 从当前 session messages 提取最近 user/assistant。
   - 从 tool_use/tool_result metadata 提取工具名、文件路径、命令。
   - 从 selected text、Kit/Skill metadata 提取能力引用。
   - 从 assistant message meta 提取 model/token/agent 信息。
2. 轻量 LLM 生成：
   - 使用当前会话同一个模型。
   - prompt 明确要求输出 JSON。
   - 失败时退回规则提取。

第一版建议：先规则提取 + 简短模板，不新增 LLM 调用，降低成本和不确定性。

规则提取建议：

- 从 user message 中提取显式约束，例如“不要编码”“先写 spec”“兼容 mac/windows”。
- 从 assistant final 中提取“已完成/下一步/验证结果”这类结构化语义。
- 从 assistant final 中提取“完成态事实”，重点保留已集成、已删除、已验证、当前支持哪些模式/语言/入口等最终状态。
- 从 tool metadata 和消息 metadata 中提取文件路径、命令、测试结果。
- 从已存在的 context usage / compaction diagnostic 中提取压缩相关状态。
- 对不确定内容宁可放入 `openQuestions`，不要推断成事实。

后续可选 LLM 更新方式：

- 只在用户启用或规则提取不足时开启。
- 使用当前会话模型，不额外指定“更强总结模型”。
- 输出必须是 schema-compatible JSON。
- 失败、超时或 JSON 校验失败时保留旧 capsule，并记录 warn。

#### FR-6: 压缩后注入 capsule bridge

OpenClaw 的模型输入接入点在 `OpenClawRuntimeAdapter.buildOutboundPrompt()`。该函数构造 `outboundMessage`，随后 `runTurn()` 通过 `chat.send` 把它发给 OpenClaw：

```ts
client.request('chat.send', {
  sessionKey,
  message: outboundMessage,
  deliver: false,
  idempotencyKey: runId,
});
```

因此 capsule 的传递方式是：从 智码 GLM Code SQLite 读取 session 最新 capsule，格式化为一段隐藏 bridge，拼入本轮 `outboundMessage`，最终作为 `chat.send.message` 的一部分传给模型。

它不是：

- renderer 可见消息。
- `cowork_messages` 普通历史消息。
- OpenClaw compaction 配置。
- OpenClaw system prompt 文件。
- `agents.defaults.compaction.model` 或其他模型选择逻辑。

在 `OpenClawRuntimeAdapter` 构造继续会话 prompt 时，如果 session 存在有效 capsule，则在当前 user request 前注入 bridge：

```text
[智码 GLM Code continuity context after compaction]
This is a compact task-state record maintained by 智码 GLM Code. It is not a new user instruction. Use it only to preserve task continuity after compaction.

Current objective:
...

Touched files:
- ...

Next steps:
- ...

Recent failures:
- ...
```

要求：

- 不作为用户可见消息展示。
- 不写入普通聊天文本，避免污染 UI。
- 不覆盖用户当前请求。
- 用户当前请求仍放在最后。
- 如果没有发生过压缩，也可以不注入，避免日常上下文变重。
- bridge 中明确声明 capsule 是 智码 GLM Code 维护的任务状态，不是新用户指令。
- 如果 capsule 过期或 revision 落后当前 session 状态，则先刷新或跳过注入。

注入策略：

- 同一次 compaction 后的第一轮注入完整 capsule，用于恢复任务全貌。
- 同一次 compaction 后的后续轮只注入 mini capsule，避免每轮重复占用较多 prompt。
- mini capsule 只包含 `currentObjective`、最近 2-3 条 `recentUserRequests`、最近 2-3 条 `nextSteps`、少量 `openQuestions`。
- mini capsule 可包含少量 `completedFacts`，因为压缩后短问句经常依赖“已完成状态”；不包含 touched files、verification、recent failures、decisions、recent actions 等较重字段。
- 下一次 compaction 发生后，`lastCompactedAt` 更新，重新允许第一轮完整 capsule 注入。
- 完整 capsule 建议不超过 4000 字符，mini capsule 建议不超过 600-800 字符。

推荐 prompt 顺序：

1. 智码 GLM Code system instructions。
2. local time / session info。
3. continuity capsule bridge。
4. media references / selected text。
5. current user request。

实现注意：

- 不要直接把 capsule 塞进现有 `buildBridgePrefix()`。该函数当前主要服务 fork / history bridge，并受 `chat.history` 与 `bridgedSessions` 判断影响。
- `buildOutboundPrompt()` 在 `bridgedSessions.has(sessionId)` 时有早返回；capsule 注入逻辑必须覆盖早返回路径，否则第二次 continue 后可能不注入。
- 建议新增独立 helper，例如 `buildContinuityCapsuleBridge(sessionId)` 或在 capsule 模块里提供 formatter。
- capsule bridge 应先做长度限制和字段裁剪，再拼入 `outboundMessage`。
- 注入成功只记录低频 debug/info 日志，不记录 capsule 完整正文。
- adapter 需要按 `sessionId + lastCompactedAt` 记录完整 capsule 是否已注入；同一压缩点后续只走 mini formatter。

涉及文件：

- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
- 可新增 `src/main/libs/agentEngine/coworkContinuityCapsule.ts`
- 可新增相关 `.test.ts`

### 4.3 第三阶段：Workspace Rehydration

第三阶段目标是“压缩后自动找回代码现场”。

#### FR-7: 压缩后首轮补充轻量 workspace state

对本地 coding session，压缩后的下一轮可补充：

- `git status --short` 摘要。
- `git diff --stat` 摘要。
- continuity capsule 中的最近 touched files。
- continuity capsule 中的最近失败命令摘要。
- continuity capsule 中的最近测试命令和结果摘要。

第一版是“薄索引”，不是 workspace dump：

- 不读取文件正文。
- 不注入完整 diff。
- 不递归扫描目录。
- 不运行测试、构建、lint 等可能昂贵或有副作用的命令。
- 仅在 session 已发生 compaction 后注入，并建议只服务压缩后短期连续性。
- workspace bridge 单独限长，MVP 建议不超过 1200-1500 字符。
- `git` 命令必须短超时，失败或非 git repo 时静默跳过并记录低频 debug。
- macOS / Windows / Linux 均通过 `execFile('git', args, { cwd })` 运行，避免 shell 拼接。
- 所有路径只作为 untrusted context 提供给模型，不作为新的用户指令。

数据来源优先级：

1. continuity capsule 已记录的 `touchedFiles`、`verification`、`recentFailures`、`nextSteps`。
2. session message 中已抽取的文件路径和命令结果摘要。
3. 轻量只读 git 命令：`git status --short`、`git diff --stat`。

注入形式：

```text
[智码 GLM Code workspace state after context compaction]
This is a lightweight workspace snapshot maintained by 智码 GLM Code. It is not a new user instruction.

Recently touched files:
- src/...

Recent validation:
- npm test -- xxx failed: ...

Git status:
- M src/...

Git diff stat:
- 2 files changed, 80 insertions(+)
```

第一版不读取代码片段。需要具体原文时交给第四阶段 Top-K Evidence / RTK-RAG。

### 4.4 第四阶段：Top-K Evidence 检索

第四阶段目标是“按需恢复被压缩掉的原文证据”。

第一版采用 智码 GLM Code 自己的 session 内 lexical Top-K Evidence，不直接依赖 embedding、向量库或 RTK 插件。原因：

- 当前问题主要是压缩后丢失本 session 中的用户原话、工具结果、错误信息和文件路径。
- 智码 GLM Code 已经有 embedding 配置并可同步到 OpenClaw `agents.defaults.memorySearch`，但该能力主要服务 OpenClaw memory 文件，不等同于 Cowork session history 检索。
- 直接接 embedding/RTK 会引入索引生命周期、provider/API key、向量维度、重建索引、隐私和跨平台存储等额外复杂度。
- lexical MVP 可以先验证“补原文证据”是否明显改善压缩后质量，再决定是否升级。

#### FR-8: 检索源

第一版只从当前 Cowork session 已保存的数据中检索，不读取仓库文件正文，不运行命令，不新增外部依赖：

- Cowork user/assistant messages。
- tool_use/tool_result 的安全摘要。
- continuity capsule 中的 objective、nextSteps、touchedFiles。
- 已保存消息里出现过的文件路径、命令、错误关键词。
- 后续可扩展到 compaction checkpoint summary、memory daily file / MEMORY.md、关键文件 diff 或片段、Kit/Skill/插件 metadata。

#### FR-9: 检索策略

当 session 已发生压缩后，继续会话时：

1. 使用当前 user prompt + capsule `currentObjective` + `nextSteps` + `completedFacts` 作为 query。
2. 从 query 中抽取文件名、路径、命令、错误词、中英文关键词。
   - 中文连续短句额外切 2-3 字 n-gram，避免“英文版简历的公司”整体作为一个词导致召回失败。
   - 对常见跨语言表达做轻量同义词扩展，例如“英文/英语/EN/English”、“日语/日本語/JA”、“简历/resume”、“公司/工作经历/experience/org”。
   - query 包含 capsule 的 `completedFacts`，让检索优先找回已完成状态的确认消息。
3. 对 session 历史消息切片并打分。
4. 文件名/路径命中给高分，命令和错误命中给中高分，普通关键词命中给基础分，较新的消息有轻微加权。
   - assistant 的完成态确认消息轻微加权，例如包含“已/完成/支持/集成/正常/verified/completed/supports”的最终回复。
5. 检索 top-K 片段，MVP 建议最多 3 条。
6. 控制总长度，MVP 建议 1500-2000 字符；单片段建议 400-600 字符。
7. 注入 `[智码 GLM Code retrieved evidence after context compaction]`。
8. 不注入低分片段，不注入空 evidence。

MVP 不使用 embedding、不使用 SQLite FTS、不接 RTK 插件。后续如果 lexical 效果不足，再升级到 SQLite FTS、OpenClaw memorySearch、embedding 或 RTK 插件。

#### FR-10: RTK/插件能力边界

RTK/插件不能替代 continuity capsule：

- capsule 保存“任务状态”。
- 检索保存“证据原文”。

两者同时存在时，prompt 顺序建议：

1. system instructions
2. selected Kit/Skill routing
3. continuity capsule
4. workspace rehydration
5. relevant retrieved evidence
6. current user request

RTK/embedding 后续升级边界：

- OpenClaw memorySearch / memory-core 可作为长期记忆检索来源，但首版不把 Cowork session history 写入 memory 文件。
- embedding provider 配置可复用现有设置，但必须是用户显式启用后的增强路径。
- 第三方 memory / vector 插件只作为后续可选适配层，不作为压缩连续性 MVP 的硬依赖。
- 所有检索结果仍必须通过 智码 GLM Code 的长度限制、安全声明和 prompt bridge 注入，不能作为用户新指令。

## 5. 与现有 OpenClaw 能力的关系

### 5.1 OpenClaw compaction summary

继续使用 OpenClaw 原生 compaction，不替换它。

智码 GLM Code 增加的 continuity capsule 是补充层：

- OpenClaw summary 负责压缩旧对话。
- 智码 GLM Code capsule 负责保留 coding 任务状态。
- Top-K Evidence / RAG evidence 负责按需找回原文细节。

capsule bridge 通过 智码 GLM Code 发出的 `chat.send.message` 进入模型上下文。它不要求 OpenClaw 增加新 API，也不修改 OpenClaw 的 compaction summary 生成逻辑。

### 5.2 OpenClaw checkpoint API

已有可用 API：

- `sessions.compaction.list`
- `sessions.compaction.get`

当前 fork bridge 已使用 checkpoint summary。优化中可复用相关逻辑，但不要把 fork bridge 和同 session post-compaction bridge 混在一起。

建议拆出通用 helper：

```ts
getLatestCompactionCheckpoint(sessionId, beforeCreatedAt?)
```

fork 和诊断都复用该 helper。

注意：

- fork bridge 是把源 session 的 checkpoint summary 带到新 fork session。
- continuity capsule bridge 是把当前 session 的任务状态带入 post-compaction continuation。
- 两者可以同时出现在 prompt 中，但应由不同 helper 构造，避免 fork/history 判断影响 capsule 注入。

### 5.3 OpenClaw config

第一版不修改：

- `agents.defaults.compaction.model`
- 未知模型默认 context window
- provider 配置

后续高级设置可选：

- 用户手动选择 compaction model。
- 用户手动设置 keep recent token 策略。
- 用户手动设置是否启用 continuity capsule / retrieval。

## 6. 数据与持久化

### 6.1 第一版持久化策略

第一版建议把 capsule 作为 session 级滚动状态持久化，而不是作为普通消息写入历史。

优先方案：

1. 如果 `cowork_sessions` 已有可扩展 JSON metadata / extra 字段：
   - 在该 JSON 中新增 `continuityCapsule`。
   - 不新增表，不改现有消息语义。
2. 如果没有合适字段：
   - 新增轻量表 `cowork_session_capsules`。
   - 每个 `session_id` 只保存一行最新 capsule。
   - 使用 upsert 覆盖更新。

建议表结构：

```ts
type CoworkSessionCapsuleRow = {
  sessionId: string;
  version: number;
  revision: number;
  capsuleJson: string;
  updatedAt: number;
  lastSource: string;
  lastCompactedAt?: number;
}
```

优点：

- 不污染普通聊天历史。
- UI/message render 不需要过滤新的隐藏消息。
- history reconcile 不会误删或误展示 capsule。
- 每个 session 单行覆盖，容量可控。
- 老用户覆盖安装时可以通过普通 SQLite migration 增量创建表，已有 session 默认无 capsule，不影响原功能。

注意：

- migration 必须幂等，使用 `CREATE TABLE IF NOT EXISTS`。
- 读取 capsule 失败时按无 capsule 处理，不阻塞会话。
- 写入 capsule 失败时记录 warn，不影响 start/continue/compact 主流程。
- 删除 session 时同步删除 capsule 行。
- fork 时复制源 session capsule，并更新 `sessionId`、`revision`、`lastSource='fork'`。
- 导出/导入如果后续需要支持 capsule，再单独设计格式。

备选方案：

- 如果希望零 schema 改动，可暂时只存 runtime memory。但应用重启、崩溃、升级后会丢，不建议作为正式方案。
- 不建议把 capsule 作为隐藏 system message 存进 `cowork_messages`，因为它会增加 render/reconcile/fork/filter 的复杂度，也容易被误当成普通历史。

版本策略：

- `version` 用于 capsule schema 版本。
- `revision` 每次覆盖更新递增。
- 第一版不保存 revision 历史。
- 如果后续需要审计，可单独增加低频 debug log，不把多版本 capsule 存入主表。

### 6.2 新增常量

遵守仓库字符串常量规范，不使用多处裸字符串。

建议扩展：

- `src/common/coworkSystemMessages.ts`
  - `CoworkSystemMessageKind.ContextContinuityCapsule`

如果新增 source/status，也用 `as const` 对象定义。

## 7. 实现计划

### Phase 0: 已发现的小修

- 补齐 `CoworkEngineRouter` 的 `contextMaintenance` 转发。
- 增加 router 单测。

该项是运行态显示修复，不是压缩质量主体。

### Phase 1: 压缩诊断

涉及文件：

- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
- `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts`

任务：

1. 抽出 checkpoint lookup helper。
2. manual compact 后读取 checkpoint metadata。
3. auto compaction completed 后读取 checkpoint metadata。
4. 输出安全诊断日志。
5. 增加测试覆盖：
   - checkpoint 有 summary。
   - checkpoint 无 summary 但可 get。
   - checkpoint lookup 失败不影响主流程。

### Phase 2: Continuity Capsule MVP

涉及文件：

- `src/main/libs/agentEngine/coworkContinuityCapsule.ts`
- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
- `src/main/coworkStore.ts`
- `src/main/sqliteStore.ts`
- 相关测试文件

任务：

1. 定义 `CoworkContinuityCapsule` schema 和长度/数量上限。
2. 新增 session 级 capsule 持久化读写：
   - 优先复用 session metadata JSON。
   - 若不可用，则新增 `cowork_session_capsules` 表和幂等 migration。
3. 实现规则提取和覆盖式 merge：
   - 用户消息更新目标、约束、问题。
   - turn complete 更新决策、已完成动作、下一步。
   - tool result 更新文件、验证和失败摘要。
4. compaction 前强制刷新 capsule。
5. compaction 后记录 `lastCompactedAt` / source metadata。
6. 新增独立 capsule bridge formatter，并在 `buildOutboundPrompt()` 中注入最新 capsule。
7. fork 时复制并裁剪源 session capsule。
8. session 删除时清理 capsule。
9. 异常只 warn，不阻断 start/continue/compact。
10. 测试覆盖：
   - capsule 包含关键文件、nextSteps、recentFailures。
   - capsule 按 session 单行覆盖更新，不无限增长。
   - post-compaction continue 的 `chat.send.message` 包含 capsule bridge。
   - `bridgedSessions` 早返回路径仍能按需注入 capsule。
   - 无 capsule 时行为不变。
   - 写入/读取失败不影响主流程。
   - migration 对老用户数据幂等。

### Phase 3: Workspace State MVP

任务：

1. 从 tool metadata/message 中提取 touched files。
2. 从最近 tool result 中提取 validation summary。
3. 注入轻量 workspace state。
4. 不自动运行昂贵命令。

### Phase 4: Top-K Evidence MVP

任务：

1. 设计 session 消息和工具结果的轻量 evidence 切片结构。
2. 实现运行时 lexical scoring，不新增数据库表，不接 embedding。
3. 只在 post-compaction continuation 启用 top-K evidence injection。
4. 严格限制 evidence 数量和总长度，避免抵消 compaction 收益。
5. 记录安全诊断日志：候选数、命中数、注入长度，不记录 evidence 正文。
6. 后续根据效果再评估 SQLite FTS、OpenClaw memorySearch、embedding 或 RTK 插件。

## 8. Prompt 设计草案

### 8.1 Capsule bridge

```text
[智码 GLM Code continuity context after context compaction]
This is a compact task-state record maintained by 智码 GLM Code. Use it to preserve continuity after previous chat history was compressed. Prefer concrete file paths, decisions, failures, and next steps from this section over vague assumptions.

Current objective:
{currentObjective}

User constraints:
- {constraint}

Key files and symbols:
- {file}: {reason}
- {symbol} ({file}): {reason}

Decisions:
- {decision}

Recent actions:
- {recentAction}

Next steps:
- {nextStep}

Recent failures or validation:
- {verification}
- {command}: {summary}

Active capabilities:
- {kind}:{id} {name}

Open questions:
- {question}
```

### 8.2 Capsule extraction prompt（后续可选）

如果后续引入 LLM 生成 capsule，prompt 必须要求结构化 JSON，并强调：

- 保留具体文件路径、函数名、命令、错误摘要。
- 不要写泛泛总结。
- 不要存 secret。
- 不要编造不存在的信息。
- 如果不确定，放入 `openQuestions`。

第一版不依赖该 LLM prompt。

## 9. 验收标准

### 9.1 功能验收

- context maintenance 状态能从 runtime 传到 renderer。
- 手动 compact 后有安全诊断日志。
- 自动 compaction completed 后有安全诊断日志。
- 压缩后继续会话时，prompt 中包含 智码 GLM Code continuity capsule。
- capsule 不作为普通消息出现在 UI 中。
- 未发生压缩的普通会话 prompt 不额外变重。
- 用户模型配置不被自动修改。

### 9.2 质量验收

构造长 coding session：

1. 用户要求修改 A/B/C 文件。
2. 工具运行中产生一次失败测试。
3. assistant 形成下一步计划。
4. 触发手动或自动压缩。
5. 用户发送“继续”。

期望：

- 模型能说出下一步要改哪些文件。
- 模型不重复已经完成的步骤。
- 模型能引用最近失败测试或错误摘要。
- 模型知道用户之前的强约束。

### 9.3 回归验收

- `npm test -- coworkEngineRouter`
- `npm test -- openclawRuntimeAdapter`
- `npm test -- coworkStore`
- `npx tsc -p electron-tsconfig.json --noEmit`
- `npx tsc -p tsconfig.json --noEmit`

## 10. 风险与缓解

### 风险 1: Capsule 本身过长

缓解：

- 字符上限。
- 每类字段数量上限。
- 优先保留 nextSteps、recentFailures、touchedFiles。

### 风险 2: Capsule 过期

缓解：

- 每次 complete 或 compaction 更新。
- 注入时标记 `updatedAt`。
- 如果 session 后续状态变化，覆盖旧 capsule。

### 风险 3: Capsule 编造信息

缓解：

- 第一版规则提取优先。
- LLM 生成时必须允许 `openQuestions`，禁止猜测。
- 只从已有消息、metadata、工具结果摘要中提取。

### 风险 4: Capsule 持久化影响老用户升级或 session 删除

缓解：

- migration 幂等，已有 session 默认无 capsule。
- 读取失败按无 capsule 处理，写入失败只 warn。
- 删除 session 时同步删除 capsule 行。
- 测试 migration、删除、fork 和历史 reload 行为。

### 风险 5: 检索注入带来 prompt injection

缓解：

- 检索内容标记为 untrusted evidence。
- 不把旧 tool result 当作新指令。
- 优先注入文件路径、错误和事实摘要，不注入大段任意文本。

## 11. 开放问题

1. `cowork_sessions` 是否已有合适 JSON metadata 字段可复用；如果没有，第一版使用 `cowork_session_capsules` 表。
2. Capsule 是否只在发生 compaction 后注入，还是长任务 warning/danger 时也注入。
3. 第一版是否允许执行轻量 `git status --short`，还是只从已有工具记录提取 workspace state。
4. Top-K Evidence 第一版采用 session 内 lexical retrieval；SQLite FTS、现有 embedding 配置和 RTK 插件都作为后续升级方向。
5. 是否需要在设置中暴露“启用压缩连续性增强”开关。

## 12. 结论

本优化不应从“替用户选更强压缩模型”开始。由于 智码 GLM Code 支持自定义模型和 provider，默认切换 compaction model 不可靠也不合适。

推荐路线：

1. 先补齐运行态链路和压缩诊断。
2. 再做 智码 GLM Code 自己的 continuity capsule。
3. 然后补 workspace rehydration。
4. 最后先接 Top-K Evidence 检索，把被压缩掉的关键原文按需找回；再根据效果评估是否升级 RTK/RAG。

这条路线可以在不改变用户模型选择的前提下，改善压缩后的任务连续性和模型回复质量。
