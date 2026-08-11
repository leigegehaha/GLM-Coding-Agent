# Kit 能力引用展示设计文档

## 1. 概述

### 1.1 问题/背景

当前 Kit（专家套件）已经支持在商店中安装，并在对话输入区选择后自动展开为一组 Skill，作为本轮 Cowork 的优先候选能力。这个实现解决了"一键安装和使用一组 Skill"的问题，但在消息展示层暴露了一个体验问题：

- 用户选择的是一个 Kit，例如"GitHub 专家套件"
- 为了让模型优先考虑 Kit 能力，提交链路会把 Kit 展开成多个底层 Skill
- 用户消息 metadata 中记录的是展开后的 `skillIds`
- 对话气泡展示时按 `skillIds` 渲染 Skill badge，结果用户看到的是整组底层 Skill，而不是自己选择的 Kit

这会让用户误以为自己直接选择了多个 Skill，也暴露了 Kit 的内部组织方式。更重要的是，后续 Kit 如果继续使用市场 API 中已经预留的 `mcpServers`、`connectors` 字段，单纯用 `skillIds` 表示 Kit 会变得不可扩展。

Codex 的插件引用方式提供了一个更合适的用户体验：用户可见层只显示一个插件引用，例如 `[@github](plugin://github@openai-curated)`，底层包含哪些 skills、MCP tools、apps/connectors 不直接暴露。智码 GLM Code 的 Kit 不应直接等同于 Codex plugin 或 OpenClaw plugin，但可以参考这种"用户可见引用 + 内部能力解析"的分层设计。

### 1.2 目标

1. 对话中选中 Kit 后，用户消息只展示 Kit 级别引用，不展开展示底层 Skill。
2. 保留当前 Kit 展开为 Skill，并进入 selected-skills 渐进式披露路由的能力。
3. 为后续 Kit 增加 `mcpServers`、`connectors` 预留统一模型。
4. 明确区分用户可见选择、消息持久化 metadata、运行时解析结果。
5. 支持 re-edit、历史会话、导出/复制等场景保持 Kit 引用语义稳定。

### 1.3 非目标

- 不实现 Codex plugin 兼容层；`plugin://github@openai-curated` 仅作为参考形态。
- 不改变当前 Skill bundle 的安装机制。
- 不在本次设计中实现 `mcpServers` 或 `connectors` 的完整安装逻辑，仅预留数据模型和解析边界。

## 2. 用户场景

### 场景 1: 使用 Kit 发送消息

**Given** 用户已安装"GitHub 专家套件"
**When** 用户在输入框选择该 Kit 并发送消息
**Then** 用户消息气泡中显示一个 Kit 引用 badge，例如 `@github` 或"GitHub 专家套件"，而不是显示该 Kit 包含的多个 Skill。

### 场景 2: Kit 仍然驱动底层能力

**Given** "GitHub 专家套件"内部包含多个 Skill
**When** 消息发送到 OpenClaw runtime
**Then** 本轮 selected-skills routing block 仍包含 Kit 展开的 Skill 轻量信息，模型可按需读取对应 `SKILL.md`，能力执行不退化。

### 场景 3: 用户同时选择 Kit 和单独 Skill

**Given** 用户选择一个 Kit，同时额外选择一个独立 Skill
**When** 用户发送消息
**Then** 消息气泡展示一个 Kit badge 和一个 Skill badge；Kit 内部展开出的 Skill 不单独展示。

### 场景 4: 重新编辑历史消息

**Given** 历史消息 metadata 中记录了 Kit 引用
**When** 用户点击重新编辑
**Then** 输入框恢复选中的 Kit，必要时也恢复单独选择的 Skill。

### 场景 5: 未来 Kit 包含 MCP 或 Connector

**Given** 某个 Kit 除了 Skill 之外还声明了 `mcpServers` 或 `connectors`
**When** 用户选择该 Kit 发送消息
**Then** 用户消息仍只展示 Kit 引用；执行层根据 Kit 安装记录解析出所需的 Skill、MCP server、Connector 等能力。

### 场景 6: 追问时重新选择 Kit

**Given** 用户上一轮选择了 Kit A
**When** 用户追问时选择 Kit B
**Then** 本轮消息只记录 Kit B 的 `kitIds` / `kitReferences`，selected-skills routing 也只使用 Kit B 展开的 Skill；Kit A 仅作为历史消息内容存在，不再作为本轮显式选择。

### 场景 7: 追问时再次选择同一个 Kit

**Given** 用户上一轮选择了 Kit A
**When** 用户追问时再次选择 Kit A
**Then** 本轮消息再次记录 Kit A，并重新构建本轮 selected-skills routing block；展示上这一条用户消息仍显示 Kit A badge。

### 场景 8: 追问时不选择 Kit

**Given** 用户上一轮选择了 Kit A
**When** 用户追问时没有选择任何 Kit
**Then** 本轮消息不新增 Kit 引用，也不因为历史选择自动重复 Kit A 的 selected-skills routing；模型仍可根据对话历史继续回答，但没有新的 Kit 显式选择信号。

## 3. 功能需求

### FR-1: Kit 用户可见引用

- 每次用户选择 Kit 发送消息时，消息 metadata 应记录 Kit 级别引用。
- 引用至少包含：
  - `kind`: 引用类型，当前为 `kit`
  - `id`: Kit ID
  - `name`: 本地化后的完整名称
  - `uri`: 稳定引用 URI，例如 `kit://github@lobsterai-kits`
- UI 展示优先使用 Kit 引用，不从 Kit 的底层能力反推展示内容。

### FR-2: 直接 Skill 与 Kit 展开 Skill 分离

- `metadata.skillIds` 只表示用户直接选择的 Skill。
- Kit 展开出来的 Skill 不应写入用户可见的 `metadata.skillIds`。
- 本轮路由所需的 Skill 候选列表由内部解析结果提供，但不代表这些 Skill 正文会被注入上下文。

### FR-3: 通用能力解析模型

- Kit 安装记录应从单一 `skillIds` 升级为与市场 API 对齐的 `skills`、`mcpServers`、`connectors` 结构。
- 当前必须支持 Skill 能力，未来可扩展 MCP server、Connector。
- 解析结果只用于执行层，不直接驱动用户消息展示。
- Kit 市场 API 保留现有顶层 `skills`、`mcpServers`、`connectors` 字段；客户端内部类型也沿用这三类能力。

### FR-4: Cowork 会话提交链路

- Renderer 发送消息时应同时传递：
  - 用户直接选择的 Skill ID
  - 用户选择的 Kit ID
  - 由 Kit 解析出的运行时能力结果
- Main process 写入用户消息 metadata 时保留用户可见选择，不把运行时解析结果混入用户可见字段。
- 调用 OpenClaw runtime 时继续传递执行/metadata 所需的 runtime `skillIds`，并用这些 Skill 构建 selected-skills routing block，保证渐进式披露行为不变。
- Skill/Kit 选择是 turn-scoped：每轮只使用本轮输入框中 active 的 Skill/Kit，不从上一轮消息或 session metadata 自动继承。
- selected-skills routing prompt 是本轮 transient prompt，不应作为 session-level system prompt 持久化后在后续追问中自动复用。

### FR-5: Markdown 引用兼容

- Kit 引用可以序列化为 Markdown 链接，例如 `[@github](kit://github@lobsterai-kits)`。
- `MarkdownContent` 应允许并特殊渲染 `kit://` 内部协议。
- `plugin://` 仅作为 Codex 参考形态，不作为本次实现目标。
- 内部协议链接不应走系统浏览器打开逻辑。

### FR-6: 历史消息与 re-edit

- 历史消息读取时，如果存在 `metadata.kitReferences` 或 `metadata.kitIds`，展示层应优先展示 Kit badge。
- re-edit 时应恢复 `kitIds` 到 active kit 状态。

### FR-7: Kit 市场 API 结构

- 当前市场 API 已经预留 `skills`、`mcpServers`、`connectors`，结构可以继续使用。
- `skills` 继续保留当前 bundle + list 语义。
- `mcpServers`、`connectors` 目前可以为 `null`；客户端读取时统一归一化为空数组。
- `version` 根字段可以继续作为接口 schema 版本；每个 Kit 内部的 `version` 继续表示 Kit 业务版本。

## 4. 现状分析

### 4.1 当前数据模型

当前 `InstalledKit` 只记录 Skill：

```typescript
interface InstalledKit {
  id: string;
  version: string;
  installedAt: number;
  skillIds: string[];
}
```

当前 Kit 市场 API 使用顶层 `skills`、`mcpServers`、`connectors` 字段，其中 `mcpServers` 和 `connectors` 目前为 `null`。这个设计本身可以继续使用，因为它已经在 API 层预留了多类能力入口。

本次改造的重点不是强制修改市场 API，而是在客户端内部建立统一能力模型：

1. 市场 API 负责描述 Kit 能包含什么。
2. 安装记录负责保存本地实际安装/启用后的能力 ID。
3. Cowork 提交链路负责把这些能力解析成运行时所需的 `ResolvedKitCapabilities`。

这样外部接口可以保持稳定，内部仍能避免继续把 Kit 简化成 `skillIds`。

### 4.2 当前提交链路

当前流程：

1. `CoworkPromptInput` 从 `activeKitIds` 查出已安装 Kit 的 `skillIds`
2. 将 `activeSkillIds` 和 Kit 展开出的 `skillIds` 合并成 `allSkillIds`
3. 根据 `allSkillIds` 构建 selected-skills routing prompt
4. `CoworkView` 再次把 Kit 展开为 `expandedSkillIds`
5. Main process 把 `options.activeSkillIds` 写入消息 metadata 的 `skillIds`
6. `UserMessageItem` 按 `metadata.skillIds` 渲染 Skill badge

问题出在第 4 到第 6 步：运行时需要的展开结果被当成用户可见选择持久化了。

选中 Skill 的 prompt 注入逻辑已经改为渐进式披露：提交链路只构建 selected-skills routing block，包含 Skill 的 `id`、`name`、`description`、`location`、`directory` 等轻量信息，不再内联完整 `SKILL.md` 正文。因此 Kit 优化不需要重新设计 Skill 加载方式，只需要确保 Kit 展开的 Skill 进入同一套 routing block，而不是进入用户可见 `metadata.skillIds`。

### 4.3 Plugin 概念边界

Codex plugin、OpenClaw plugin、智码 GLM Code Kit 是三个不同概念：

| 概念 | 归属 | 典型标识 | 说明 |
|------|------|----------|------|
| Codex plugin | Codex 客户端 | `plugin://github@openai-curated` | Codex 侧能力包，可包含 skills、MCP tools、apps/connectors |
| OpenClaw plugin | OpenClaw runtime | `openclaw.plugin.json` / `plugins.entries` | OpenClaw 运行时扩展 |
| 智码 GLM Code Kit | 智码 GLM Code | `kit://<id>@lobsterai-kits` | 智码 GLM Code 专家套件，可聚合多类能力 |

因此 Kit 的默认 URI 应使用 `kit://`，而不是直接复用 Codex 的 `plugin://`。

## 5. 方案设计

### 5.1 数据模型

新增通用引用类型：

```typescript
export interface KitReference {
  kind: 'kit';
  id: string;
  name?: string;
  uri: string;
  source?: string;
}
```

Kit 市场 API 类型保留当前结构：

```typescript
export interface KitSkillRef {
  id: string;
  name: string;
}

export interface KitSkillBundle {
  bundle: string;
  list: KitSkillRef[];
}

export interface MarketplaceKit {
  id: string;
  name: string | LocalizedText;
  description: string | LocalizedText;
  icon?: string;
  author?: string;
  version: string;
  downloadCount?: string;
  tryAsking?: Array<string | LocalizedText>;
  skills?: KitSkillBundle | null;
  mcpServers?: unknown[] | null;
  connectors?: unknown[] | null;
}
```

客户端内部安装记录也保留同一组能力字段：

```typescript
export interface InstalledKitSkills {
  skillIds: string[];
}

export interface InstalledKit {
  id: string;
  version: string;
  installedAt: number;
  skills: InstalledKitSkills | null;
  mcpServers: unknown[];
  connectors: unknown[];
}
```

归一化规则：

```typescript
function normalizeMarketplaceKitForInstall(
  kit: MarketplaceKit,
  installedSkillIds: string[],
): InstalledKit {
  return {
    id: kit.id,
    version: kit.version,
    installedAt: Date.now(),
    skills: installedSkillIds.length > 0 ? { skillIds: installedSkillIds } : null,
    mcpServers: Array.isArray(kit.mcpServers) ? kit.mcpServers : [],
    connectors: Array.isArray(kit.connectors) ? kit.connectors : [],
  };
}
```

说明：

- `skills.skillIds` 不能只从 `kit.skills.list` 直接保存，因为安装 zip 后实际目录名可能因冲突被重命名；应以安装完成后的实际目录名为准。
- `mcpServers: null` 和 `connectors: null` 在客户端归一化为空数组。
- `mcpServers`、`connectors` 的具体结构由市场 API 后续定义；在结构未定之前，客户端只做保存和透传，不发明 `app`、`plugin` 等额外分类。

运行时解析结果：

```typescript
export interface ResolvedKitCapabilities {
  skillIds: string[];
  mcpServers: unknown[];
  connectors: unknown[];
}
```

消息 metadata 扩展：

```typescript
export interface CoworkMessageMetadata {
  skillIds?: string[]; // 仅用户直接选择的 Skill
  kitIds?: string[];
  kitReferences?: KitReference[];
  resolvedKitCapabilities?: ResolvedKitCapabilities; // 可选，仅调试/回溯，不用于默认展示
}
```

### 5.2 市场 API 示例

当前接口可以保持：

```json
{
  "version": 1,
  "kits": [
    {
      "id": "design",
      "skills": {
        "bundle": "https://example.com/design.zip",
        "list": [{ "id": "design-critique", "name": "/design-critique" }]
      },
      "mcpServers": null,
      "connectors": null
    }
  ]
}
```

客户端安装后写入内部安装记录：

```json
{
  "design": {
    "id": "design",
    "version": "1.0.0",
    "installedAt": 1780000000000,
    "skills": {
      "skillIds": [
        "accessibility-review",
        "design-critique"
      ]
    },
    "mcpServers": [],
    "connectors": []
  }
}
```

### 5.3 URI 设计

Kit 引用 URI：

```text
kit://<kit-id>@lobsterai-kits
```

示例：

```markdown
[@github](kit://github@lobsterai-kits)
```

规则：

- UI 如需展示 `@design` 这样的短标签，应由 `id` 推导，不在 metadata 中额外持久化。
- `uri` 只用于稳定标识和展示，不要求 OpenClaw runtime 直接识别。
- `kit://` 不应触发外部打开；点击行为可以是无操作、打开 Kit 详情，或显示 tooltip。
- `plugin://` 不作为本次实现目标，也不作为 Kit 默认 URI。

### 5.4 解析边界

新增一个 Kit capability resolver，负责从用户选择解析出运行时能力：

```typescript
function resolveSelectedKitCapabilities(
  kitIds: string[],
  installedKits: Record<string, InstalledKit>,
): ResolvedKitCapabilities
```

职责：

- 从 `installedKits[kitId].skills`、`mcpServers`、`connectors` 读取各类能力
- 对每类 ID 去重
- 忽略未安装或缺失记录的 Kit
- 不读取 UI 本地化信息，不生成用户可见 label

另有一个引用构建函数：

```typescript
function buildKitReferences(
  kitIds: string[],
  marketplaceKits: MarketplaceKit[],
): KitReference[]
```

职责：

- 生成 `kind: 'kit'`
- 生成 `name`、`uri`
- 只服务 metadata 和展示层，不参与能力执行

### 5.5 Cowork 提交链路

提交请求应从当前单一 `activeSkillIds` 拆成更清晰的结构：

```typescript
interface CoworkTurnCapabilitySelection {
  skillIds?: string[]; // 用户直接选择
  kitIds?: string[];
  kitReferences?: KitReference[];
  resolvedKitCapabilities?: ResolvedKitCapabilities;
}
```

Renderer 提交流程：

1. 读取 `activeSkillIds` 作为直接 Skill 选择。
2. 读取 `activeKitIds` 作为 Kit 选择。
3. 调用 resolver 得到 `resolvedKitCapabilities`。
4. 构建本轮候选 Skill 列表：
   - `directSkillIds + resolvedKitCapabilities.skillIds`
5. 使用候选 Skill 列表构建 selected-skills routing prompt，不内联 `SKILL.md` 正文。
6. 调用 start/continue session 时传递 `capabilitySelection`。

选择作用域：

- 新会话首轮：使用首页输入框当前选中的 Skill/Kit。
- 继续会话追问：只使用当前追问输入框新选中的 Skill/Kit。
- 继续会话未选择 Kit：`kitIds`、`kitReferences`、`resolvedKitCapabilities` 均为空，不从上一轮继承。
- 继续会话选择另一个 Kit：本轮 Kit 集合替换上一轮 Kit 集合，不做并集。
- 继续会话再次选择同一个 Kit：按一次新的显式选择处理，本轮重新生成 Kit 引用和 selected-skills routing。
- 发送成功后清空当前 draft 的 active Skill/Kit，和当前输入框已有行为保持一致，避免下一轮误继承。

Main process 写消息 metadata：

```typescript
const messageMetadata = {
  ...(selection.skillIds?.length ? { skillIds: selection.skillIds } : {}),
  ...(selection.kitIds?.length ? { kitIds: selection.kitIds } : {}),
  ...(selection.kitReferences?.length ? { kitReferences: selection.kitReferences } : {}),
  ...(selection.resolvedKitCapabilities ? { resolvedKitCapabilities: selection.resolvedKitCapabilities } : {}),
};
```

调用 OpenClaw runtime / prompt builder：

```typescript
const runtimeSkillIds = [
  ...(selection.skillIds ?? []),
  ...(selection.resolvedKitCapabilities?.skillIds ?? []),
];

const selectedSkillRoutingPrompt = buildSelectedSkillRoutingPrompt(
  resolveSkills(runtimeSkillIds),
);
```

说明：

- `runtimeSkillIds` 用于本轮能力路由和必要的 runtime metadata。
- `selectedSkillRoutingPrompt` 只包含 Skill 轻量 metadata，引导模型按需读取 `SKILL.md`。
- `messageMetadata.skillIds` 仍只记录用户直接选择的 Skill，不包含 Kit 展开的 Skill。
- `selectedSkillRoutingPrompt` 不应写入持久化的 session base system prompt；后续追问如果没有新选择，就不重复发送上一轮的 selected-skills block。

### 5.6 展示层

`UserMessageItem` 展示顺序：

1. `metadata.kitReferences` 中的 Kit 引用
2. `metadata.kitIds` 兜底生成 Kit badge
3. `metadata.skillIds` 中的直接 Skill badge

展示规则：

- Kit badge 使用 Kit 图标和 Kit 名称。
- Skill badge 只展示用户直接选的 Skill。
- `resolvedKitCapabilities` 不参与默认展示。
- badge tooltip 可显示"由专家套件提供"，但不列出全部底层能力，避免再次暴露内部结构。

### 5.7 MarkdownContent 内部协议渲染

`MarkdownContent` 当前只允许 `http`、`https`、`mailto`、`tel`、`file`、`localfile`。需要新增内部协议处理：

- `kit`

处理方式：

- `safeUrlTransform` 允许 `kit` 协议。
- `a` renderer 中识别内部协议，不走 `openExternal`。
- 内部协议链接渲染为 pill/badge 样式。
- 未识别的内部引用仍保持安全降级，不打开外部应用。

### 5.8 上线前数据重置策略

当前 Kit 能力引用能力尚未上线，不需要对旧的本地安装记录和消息 metadata 做生产兼容。实现时按新内部结构一次性切换：

- Kit 市场 API 可以继续使用当前顶层 `skills`、`mcpServers`、`connectors`。
- 本地 `kits_installed` 只写新的 `skills`、`mcpServers`、`connectors` 结构。
- 开发环境中已有的旧 `kits_installed` 数据可以清空或重新安装 Kit，不做运行时 fallback。
- 已有本地测试消息如果只有旧 `metadata.skillIds`，可接受按新逻辑无法恢复 Kit 级引用。

## 6. 涉及文件

### 新增文件

| 文件 | 说明 |
|------|------|
| `src/renderer/types/kitReference.ts` | 前端 Kit 引用类型 |
| `src/renderer/services/kitCapability.ts` | Renderer 侧 Kit capability resolver 和引用构建 |
| `src/main/libs/kitCapability.ts` | Main 侧 metadata 规范化与能力解析辅助工具 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/renderer/types/kit.ts` | `MarketplaceKit` 保留现有市场 API 字段；`InstalledKit` 使用 `skills`、`mcpServers`、`connectors` 结构 |
| `src/renderer/types/cowork.ts` | `CoworkMessageMetadata` 增加 `kitReferences`、`resolvedKitCapabilities`；会话请求类型增加 capability selection |
| `src/renderer/components/cowork/CoworkPromptInput.tsx` | 提交时区分直接 Skill、Kit 引用、运行时能力解析；用直接 Skill + Kit 展开 Skill 构建 selected-skills routing prompt |
| `src/renderer/components/cowork/CoworkView.tsx` | start/continue session 传递 capability selection；临时消息 metadata 不再把 Kit 展开 Skill 写入 `skillIds` |
| `src/main/main.ts` | Cowork IPC options 接收 capability selection；写入用户可见 metadata；runtime 调用使用解析后的候选 Skill |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | continuation 用户消息 metadata 支持 kitReferences/kitIds；runtime skillIds 继续只接收执行用列表 |
| `src/renderer/components/cowork/UserMessageItem.tsx` | 展示 `kitReferences`；仅展示直接 Skill |
| `src/renderer/components/cowork/CoworkSessionDetail.tsx` | re-edit 恢复 `kitIds` 和直接 `skillIds` |
| `src/renderer/components/MarkdownContent.tsx` | 支持 `kit://` 等内部协议的安全渲染 |
| `src/main/ipcHandlers/kits/handlers.ts` | 安装记录写入 `skills`、`mcpServers`、`connectors`，从市场 API 的 `skills` 安装 Skill bundle |
| `src/renderer/store/slices/kitSlice.ts` | active kit 状态继续保留；安装记录按新结构读取 |
| `src/renderer/services/i18n.ts` | 新增引用 badge tooltip 等文案 |

## 7. 边界情况

| 场景 | 处理方式 |
|------|----------|
| Kit 已选择但安装记录缺失 | 展示 Kit 引用可保留，resolver 跳过缺失能力并提示或静默降级 |
| Kit 卸载后历史消息仍引用它 | 历史消息按 `metadata.kitReferences` 展示，不依赖当前安装状态 |
| Kit 名称在商店中变更 | 历史消息优先使用 metadata 中保存的 `name`；当前选择使用最新 marketplace 名称 |
| 多个 Kit 包含同一个 Skill | 候选 `skillIds` 去重，展示仍显示两个 Kit 引用 |
| 用户直接选择的 Skill 同时属于某 Kit | 直接 Skill badge 仍展示一次；runtime 去重 |
| 追问选择不同 Kit | 本轮 Kit 替换上一轮 Kit，不自动合并 |
| 追问再次选择同一 Kit | 视为本轮新的显式选择，重新生成 Kit 引用和 routing block |
| 追问不选择 Kit | 不继承上一轮 Kit；只保留历史对话文本带来的上下文 |
| 市场 API 的 `mcpServers` / `connectors` 为 `null` | 客户端归一化为空数组 |
| `kit://` 链接被复制到普通 Markdown 环境 | 作为普通链接文本保留，不影响 智码 GLM Code 内部渲染 |
| MCP/Connector 能力暂未实现 | `mcpServers`、`connectors` 允许为空数组；resolver 返回空数组 |

## 8. 验收标准

1. 选择单个 Kit 发送消息后，用户消息只显示一个 Kit badge。
2. 同一条消息中，Kit 底层 Skill 不再作为 Skill badge 展示。
3. 用户直接选择的 Skill 仍正常显示为 Skill badge。
4. Kit 和直接 Skill 同时选择时，展示为 Kit badge + Skill badge。
5. selected-skills routing prompt 仍包含 Kit 展开后的 Skill 轻量信息，现有 Kit 能力不退化。
6. 新消息 metadata 中包含 `kitIds` 和 `kitReferences`。
7. 新消息 metadata 中的 `skillIds` 只包含用户直接选择的 Skill。
8. re-edit 历史消息能恢复 Kit 选择状态。
9. `kit://` Markdown 链接在 智码 GLM Code 内部渲染为安全的 Kit 引用，不打开外部浏览器。
10. Kit 市场 API 保留顶层 `skills`、`mcpServers`、`connectors`，客户端按同名字段保存内部安装记录。
11. 本地安装记录不再写旧版顶层 `skillIds`。
12. 数据模型可以表达未来的 `mcpServers`、`connectors`。
13. 追问选择 Kit B 时，本轮 metadata 和 routing 只包含 Kit B，不包含上一轮 Kit A。
14. 追问未选择 Kit 时，本轮不发送上一轮 Kit 的 selected-skills routing block。

## 9. 验证计划

### 单元测试

- `kitCapability` resolver：
  - 解析新 `skills.skillIds`
  - 多 Kit 去重
  - 缺失 Kit 安全跳过
- `UserMessageItem` 或展示工具函数：
  - kitReferences 优先展示
  - 直接 Skill 和 Kit 展开 Skill 不混淆
- `MarkdownContent`：
  - `kit://` 协议不会被过滤
  - `kit://` 不走外部打开逻辑

### 手工验证

1. 安装一个包含多个 Skill 的 Kit。
2. 选择该 Kit 发送消息，确认输入区和消息气泡都只显示 Kit。
3. 确认本轮 system prompt 只包含 selected-skills routing 信息，不内联 Kit 内部 Skill 的 `SKILL.md` 正文。
4. 确认实际回复仍能按需读取并调用 Kit 对应 Skill 的能力。
5. 同时选择 Kit 和一个独立 Skill，确认展示和能力都正确。
6. 重新编辑该消息，确认 Kit 和独立 Skill 都恢复。
7. 重启应用后打开历史会话，确认 Kit 引用展示稳定。
