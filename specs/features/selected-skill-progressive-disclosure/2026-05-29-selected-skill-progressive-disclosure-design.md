# 选中 Skill 渐进式披露设计文档

## 1. 概述

### 1.1 问题/背景

当前首页 Cowork 输入框已经支持两种 Skill 使用方式：

1. 用户不选择 Skill 时，OpenClaw 通过原生 `skills.load.extraDirs`、`skills.entries` 和 Skill description 做自动路由。
2. 用户手动选择 Skill 后，Renderer 会把选中 Skill 的 `SKILL.md` 正文拼入本轮 `systemPrompt`。

第一种方式符合渐进式披露：模型先看 Skill 索引和描述，匹配后再读取对应的 `SKILL.md`。第二种方式会绕过这个机制，导致用户选择多个 Skill 时，多个 `SKILL.md` 正文一次性进入上下文。

这会带来几个问题：

- 选择多个 Skill 时上下文消耗线性增长，且很多 Skill 可能不会真正用于本轮请求。
- 长 Skill 会挤占用户任务、历史消息和工具结果上下文。
- 手动选择 Skill 的语义变成"强制加载全文"，而不是"优先使用这些能力"。
- Kit 展开为多个 Skill 后，问题会被放大，因为用户选择一个 Kit 可能间接选择多份 `SKILL.md`。

### 1.2 目标

1. 保留未选择 Skill 时的 OpenClaw 原生自动路由能力。
2. 用户手动选择 Skill 后，只注入轻量的 Skill 路由信息，不注入 `SKILL.md` 正文。
3. 手动选择的 Skill 作为本轮优先候选；如果匹配请求，模型再按需读取该 Skill 的 `SKILL.md`。
4. 保留消息上的 Skill badge 和历史 metadata 展示能力。
5. 支持新会话和继续会话，并避免每轮重复注入相同的大块内容。
6. 为 Kit 展开、多 Skill 选择和 Agent 默认 Skill 复用同一套轻量披露语义。

### 1.3 非目标

- 不改变 Skill 安装、启用、删除或市场升级机制。
- 不修改 `SKILL.md` 文件格式。
- 不实现新的 OpenClaw RPC 协议；优先基于现有 `chat.send` message 前缀和 OpenClaw 原生 skill loader 完成。
- 不在本次设计中改变用户可见的 Skill 选择 UI。
- 不移除消息 metadata 中用于展示和回放的 `skillIds`。

## 2. 用户场景

### 场景 1: 未选择 Skill，自动路由

**Given** 用户没有在首页输入框选择任何 Skill
**When** 用户发送一个明显匹配某个 Skill 的请求
**Then** OpenClaw 继续使用原生 Skill 自动路由能力，模型按 description 判断并按需读取匹配 Skill 的 `SKILL.md`。

### 场景 2: 选择一个 Skill 后发送请求

**Given** 用户选择了一个 Skill
**When** 用户发送与该 Skill 匹配的请求
**Then** 本轮 prompt 只包含该 Skill 的 `id`、`name`、`description`、`location` 等轻量信息，并要求模型在使用前读取对应 `SKILL.md`。

### 场景 3: 选择多个 Skill 后发送请求

**Given** 用户选择了多个 Skill
**When** 用户发送请求
**Then** 模型优先从选中的 Skill 中选择最具体、最匹配的一个读取；除非被读取的 Skill 明确要求组合其他 Skill，否则不预先读取多个 `SKILL.md`。

### 场景 4: 选中 Skill 不匹配请求

**Given** 用户选择了 Skill A
**When** 用户发送的请求明显不适合 Skill A，但适合另一个已启用 Skill B
**Then** 模型不应强行使用 Skill A，可回退到 OpenClaw 原生自动路由并使用 Skill B。

### 场景 5: 继续会话中选择新 Skill

**Given** 用户已经在某个 Cowork 会话中
**When** 用户在新一轮消息前选择 Skill
**Then** 本轮只注入新选择 Skill 的轻量路由信息；未选择时不刷新或覆盖原 session system prompt。

### 场景 6: 选择 Kit

**Given** 用户选择一个包含多个 Skill 的 Kit
**When** 用户发送请求
**Then** Runtime 可继续获得展开后的 Skill ID 用于能力匹配，但 prompt 中只出现这些 Skill 的轻量路由信息，不内联任何 Skill 正文。

## 3. 功能需求

### FR-1: 选中 Skill 不再内联正文

- `CoworkPromptInput` 不应把 `skill.prompt` 拼入 `systemPrompt`。
- 选中 Skill prompt 只允许包含轻量 metadata：
  - `id`
  - `name`
  - `description`
  - `location`
  - `directory`
- `SKILL.md` 正文只能由模型在判断需要使用该 Skill 后，通过读取 `<location>` 获得。

### FR-2: 选中 Skill 作为优先候选

- 用户手动选择的 Skill 应被描述为"preferred candidates for this turn"。
- 如果用户请求匹配选中 Skill，模型应优先读取并使用选中 Skill。
- 如果选中 Skill 与请求不匹配，模型可以忽略选中 Skill，继续使用自动路由。
- 多个选中 Skill 同时匹配时，模型应选择最具体的一个优先读取。

### FR-3: 未选择 Skill 的自动路由保持不变

- 未选择 Skill 时不额外注入 selected-skills block。
- OpenClaw 的 `skills.load.extraDirs`、`skills.entries` 和 enabled 状态继续作为自动路由来源。
- 不恢复旧的全量 `<available_skills>` 注入到普通 Cowork 首页 prompt，避免干扰非 Claude 模型。

### FR-4: 新会话与继续会话行为一致

- 新会话：如果本轮有选中 Skill，将 selected-skills block 与用户配置的 base system prompt 合并。
- 继续会话：只有本轮有新选中 Skill 时才传入 selected-skills block。
- 继续会话无新选中 Skill 时，保持当前 `buildCoworkContinuationSystemPrompt()` 的语义，不发送新的 system prompt。

### FR-5: 消息 metadata 保持展示语义

- `activeSkillIds` 仍写入用户消息 metadata，用于 Skill badge、历史会话展示和 re-edit。
- metadata 中的 `skillIds` 不代表 `SKILL.md` 已经被注入上下文。
- Kit 展开产生的 runtime Skill ID 与用户直接选择的 Skill ID 需要在后续 Kit spec 中继续区分展示语义，本 spec 只约束 prompt 注入内容。

### FR-6: Prompt 内容可审计

- selected-skills block 必须有稳定标题和 XML-like 结构，方便测试和日志排查。
- block 中必须明确路径规则：
  - `<location>` 是 canonical `SKILL.md` 路径。
  - 相对路径按 `dirname(<location>)` 解析。
  - 不假设 Skill 位于当前 workspace。
- block 中必须明确约束：
  - 不要预读所有选中 Skill。
  - 只在需要使用某个 Skill 时读取对应 `SKILL.md`。
  - 只在被读取 Skill 明确引用其他 Skill 或文件时继续读取额外内容。

## 4. 现状分析

### 4.1 当前首页提交链路

当前流程：

1. `CoworkPromptInput` 从 Redux 读取 `activeSkillIds` 和 `activeKitIds`。
2. Kit 被展开为 `skillIds`，并与用户直接选择的 `activeSkillIds` 合并。
3. `buildInlinedSkillPrompt(skill)` 生成包含 `skill.prompt` 的 prompt 片段。
4. 多个 Skill prompt 用 `\n\n` 拼接成 `skillPrompt`。
5. `CoworkView` 调用 `buildCoworkSystemPrompt(skillPrompt, config.systemPrompt)`。
6. Main process 通过 `mergeCoworkSystemPrompt()` 追加 scheduled-task prompt。
7. `OpenClawRuntimeAdapter.buildOutboundPrompt()` 把最终 system prompt 包装成 `[智码 GLM Code system instructions]` 后放入 `chat.send.message`。

关键问题在第 3 步：`skill.prompt` 来自 `SKILL.md` 正文，用户选择越多，注入内容越大。

### 4.2 当前 OpenClaw 原生 Skill 配置

`OpenClawConfigSync` 已经把 智码 GLM Code Skill 目录同步给 OpenClaw：

```typescript
skills: {
  entries: {
    ...this.buildSkillEntries(),
    ...MANAGED_SKILL_ENTRY_OVERRIDES,
  },
  load: {
    extraDirs: this.resolveSkillsExtraDirs(),
    watch: true,
  },
}
```

这意味着未手动选择 Skill 时，OpenClaw 已经可以通过原生 Skill loader 和 description 做自动路由。手动选择 Skill 不需要再复制一份 `SKILL.md` 正文进入 system prompt。

### 4.3 `skillIds` 当前用途

当前 `OpenClawRuntimeAdapter` 接收 `options.skillIds` 后，主要用于用户消息 metadata：

```typescript
metadata.skillIds = options.skillIds
```

`chat.send` 仍只发送 `message`、`cwd`、`attachments` 等参数，没有把 `skillIds` 作为结构化 runtime 参数传给 OpenClaw。因此本次优化不能只传 `skillIds`，还需要在 `message` 前缀中放入轻量 selected-skills routing block，让模型知道用户本轮显式选择了哪些 Skill。

## 5. 方案设计

### 5.1 Selected Skill Routing Prompt

将当前 `buildInlinedSkillPrompt()` 改为轻量 prompt builder，例如：

```typescript
const buildSelectedSkillRoutingPrompt = (skills: Skill[]): string | undefined => {
  if (skills.length === 0) return undefined;

  return [
    '## Selected skills for this turn',
    'The user selected these skills as preferred candidates for this turn.',
    'If one selected skill clearly applies, read its SKILL.md at <location> before using it.',
    'If no selected skill applies, ignore this block and continue normal automatic skill routing.',
    'Do not read every selected skill up front. Choose the most specific matching skill first.',
    '',
    '<selected_skills>',
    ...skills.map(skill => [
      '  <skill>',
      `    <id>${skill.id}</id>`,
      `    <name>${skill.name}</name>`,
      `    <description>${skill.description}</description>`,
      `    <location>${skill.skillPath}</location>`,
      `    <directory>${getSkillDirectoryFromPath(skill.skillPath)}</directory>`,
      '  </skill>',
    ].join('\n')),
    '</selected_skills>',
  ].join('\n');
};
```

实际实现时应对 XML-like 文本做最小转义，避免 Skill 名称或描述中的 `<`、`&` 破坏结构。

### 5.2 新会话 Prompt 组装

新会话保留现有调用结构，只替换 `skillPrompt` 的含义：

```text
selectedSkillRoutingPrompt + config.systemPrompt
```

变化前：

```text
full SKILL.md body for selected skill A

full SKILL.md body for selected skill B

base system prompt
```

变化后：

```text
selected skill routing metadata for A and B

base system prompt
```

Main process 继续追加 scheduled-task prompt，OpenClaw adapter 继续通过 `[智码 GLM Code system instructions]` 前缀发送，不需要修改 IPC 契约。

### 5.3 继续会话 Prompt 组装

继续会话使用当前策略：

- 有本轮新选中 Skill：发送 selected-skills routing block。
- 无本轮新选中 Skill：返回 `undefined`，让 Main process 使用 existing session prompt，不额外覆盖。

需要注意：如果 Main process 当前会在 `options.systemPrompt ?? existingSession?.systemPrompt` 中回退到旧 system prompt，应确保无新 Skill 时不会因为旧 session prompt 包含历史 selected-skills block 而重复注入。可通过当前 `buildCoworkContinuationSystemPrompt()` 返回 `undefined` 保持该语义。

### 5.4 自动路由与手动选择的优先级

最终模型侧指令应表达以下顺序：

1. 如果用户明确选择了 Skill，先判断选中 Skill 是否适合本轮请求。
2. 如果 exactly one selected Skill clearly applies，读取它的 `SKILL.md`。
3. 如果 multiple selected Skills apply，选择最具体的一个读取。
4. 如果 selected Skill 不适合，忽略 selected block，继续使用 OpenClaw 原生自动路由。
5. 不要因为用户选择了 Skill 就跳过 description 匹配或强行使用。

这个语义比"选中即全文注入"更接近 Codex 的渐进式披露，同时保留用户选择的优先级信号。

### 5.5 Kit 与 Agent 默认 Skill

当前 Kit 会在提交时展开成 Skill ID。为了最小化本次改造范围：

- 本 spec 允许继续把 Kit 展开的 Skill 纳入 selected-skills routing block。
- 这些 Skill 仍只出现 metadata，不出现正文。
- 后续可结合 Kit 能力引用设计，把"用户直接选择 Skill"和"Kit 展开 Skill"在 metadata 展示层进一步分离。

Agent 默认 Skill 可复用同一策略：默认 Skill 在输入框恢复为 active skill 后，发送时同样只生成轻量 routing block。

## 6. 涉及文件

| 文件 | 变更说明 |
|------|---------|
| `src/renderer/components/cowork/CoworkPromptInput.tsx` | 将 `buildInlinedSkillPrompt()` 替换为 selected skill routing prompt builder，不再读取 `skill.prompt` 注入正文 |
| `src/renderer/components/cowork/skillSystemPrompt.ts` | 保留 prompt 合并逻辑；必要时重命名参数以反映其内容是 routing prompt 而非全文 skill prompt |
| `src/renderer/components/cowork/skillSystemPrompt.test.ts` | 增加新会话和继续会话 selected-skills routing 行为测试 |
| `src/renderer/types/skill.ts` | 注释更新：`prompt` 是本地管理用的 `SKILL.md` 正文，不应直接作为 Cowork prompt 注入 |
| `src/main/skillManager.ts` | 可选：保留 `prompt` 字段以兼容管理页和自动路由，不作为首页选择注入来源 |

## 7. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 选中的 Skill 已被删除 | `setSkills` 清理无效 active ID；提交时找不到的 ID 直接跳过 |
| Skill disabled 但仍在 activeSkillIds | 输入框展示层只允许 enabled Skill；提交时也应过滤 disabled Skill |
| Skill description 很长 | 可保留完整 description；如后续发现过长，再增加长度上限和截断标记 |
| Skill 名称/描述包含 XML 特殊字符 | selected-skills block 中做 XML-like 转义 |
| 多个 Skill 同名 | 使用 `id` 和 `location` 作为稳定标识 |
| `skillPath` 为空或异常 | 跳过该 Skill，避免生成不可读取的 location |
| Kit 展开大量 Skill | 只注入 metadata，成本显著低于正文；后续可增加 Kit 层 selected reference 优化 |
| 模型没有按要求读取 `SKILL.md` | 通过 prompt 约束和验收测试检查 block 文案；必要时后续引入结构化 OpenClaw selected skills 参数 |

## 8. 验收标准

1. 用户选择一个 Skill 后，发往 OpenClaw 的 outbound message 不包含该 Skill 的 `SKILL.md` 正文。
2. 用户选择多个 Skill 后，outbound message 只包含 selected-skills metadata，不随 `SKILL.md` 正文长度线性增长。
3. selected-skills block 包含每个选中 Skill 的 `id`、`name`、`description`、`location`、`directory`。
4. selected-skills block 明确要求模型按需读取 `SKILL.md`，且不要预读全部选中 Skill。
5. 未选择 Skill 时，不生成 selected-skills block，自动路由行为保持不变。
6. 继续会话未选择新 Skill 时，不发送新的 system prompt。
7. 用户消息仍展示选中 Skill badge，历史消息 metadata 不回退。
8. Kit 展开后的 Skill 不再导致多个 `SKILL.md` 正文注入上下文。

## 9. 验证计划

### 9.1 单元测试

- 为 selected skill routing prompt builder 增加测试：
  - 空数组返回 `undefined`
  - 单 Skill 输出 metadata 和 location
  - 不包含 `skill.prompt`
  - XML-like 特殊字符被转义
- 更新 `skillSystemPrompt.test.ts`：
  - 新会话可合并 selected routing prompt 和 base system prompt
  - 继续会话无 selected routing prompt 时返回 `undefined`

### 9.2 集成验证

1. 安装或启用一个包含明显正文标记的测试 Skill。
2. 首页选择该 Skill 并发送消息。
3. 检查 OpenClaw runtime `chat.send params` 对应 outbound message：
   - 包含 selected-skills block。
   - 包含 `location`。
   - 不包含测试 Skill 正文标记。
4. 不选择 Skill 发送同类请求，确认 OpenClaw 仍可自动路由。
5. 选择多个 Skill 和一个 Kit，确认 prompt 长度只随 metadata 增长，不出现多份 `SKILL.md` 正文。

### 9.3 回归验证

- Skill badge 展示正常。
- re-edit 后 active skill 状态恢复正常。
- 图片附件、media generation、scheduled task prompt 不受影响。
- 非 Claude 模型不再收到旧的 Claude SDK tool-calling auto-routing prompt。
