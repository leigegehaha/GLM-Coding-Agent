# 首页输入区上下文布局优化设计文档

状态：Draft
日期：2026-05-11
分类：功能
参考：用户提供的 Codex 输入框参考图与当前 智码 GLM Code 首页截图
适用范围：桌面端 Cowork 首页空会话状态，不包含会话详情页输入区

## 1. 概述

### 1.1 问题/背景

当前 智码 GLM Code 首页里，模型选择器位于页面顶部 header 左侧；文件夹选择器位于大输入框内部左下；当前选中的 Agent 没有在输入区附近显式展示。用户希望首页输入区更接近参考图的信息层级：

- 模型选择器从页面顶部迁移到输入框内部工具栏，位置参考第一张图右下区域。
- 文件夹和当前选择的 Agent 放到输入框下方的灰色吸底区域。
- 输入区仍然是首页的视觉中心，但上下文信息从「分散在 header 和输入框内部」改为「聚合在输入框附近」。

### 1.2 目标

1. 首页 header 不再把模型选择器作为主要左侧内容展示。
2. 首页大输入框采用「白色输入主体 + 灰色吸底上下文栏」的两层结构。
3. 模型选择器放入白色输入主体的底部工具栏，靠近发送按钮，参考图一中 `5.5 超高` 的位置。
4. 文件夹选择器从白色输入主体移到灰色吸底上下文栏。
5. 当前选中的 Agent 在灰色吸底上下文栏中显式展示，并可作为 Agent 切换入口。
6. 发送、停止、附件、技能等现有核心能力保持可用。

### 1.3 非目标

- 不重做整个首页欢迎区、快捷动作区或安全防护状态。
- 不改变 Cowork session 创建、继续、停止、图片附件、技能注入和工作目录保存逻辑。
- 不改变 Agent 的数据模型、默认 Agent 规则或侧边栏 Agent 树行为。
- 不改变会话详情页的小输入框布局；本次只定义首页空会话态的大输入框。
- 不新增模型能力、模型配置或 Agent 设置能力，只调整现有入口的位置和层级。

## 2. 用户场景

### 场景 1: 在首页确认模型后发起任务

**Given** 用户打开 智码 GLM Code 首页，当前没有会话详情
**When** 用户查看大输入框底部工具栏
**Then** 用户能在发送按钮左侧附近看到当前模型，并可点击切换模型

### 场景 2: 在输入区下方确认工作目录和 Agent

**Given** 用户准备从首页发起任务
**When** 用户查看输入框下方灰色吸底区域
**Then** 用户能看到当前文件夹和当前选中的 Agent，并可分别点击切换

### 场景 3: 未选择文件夹时提交

**Given** 首页输入区要求选择工作目录
**When** 用户未选择文件夹就提交任务
**Then** 文件夹入口在灰色吸底区域显示现有必选提醒和抖动反馈，不把提醒放回白色输入主体

## 3. 功能需求

### FR-1: 首页 header 的模型入口迁移

首页空会话态下，`CoworkView` 的 `homeHeader` 不再展示左侧 `ModelSelector`。header 仍保留：

- 侧边栏折叠状态下的展开按钮、新建按钮和更新 badge。
- 右侧安全防护状态与系统窗口按钮。
- 原有拖拽区域和高度，避免破坏窗口行为。

会话详情页是否展示模型入口不在本次范围内。

### FR-2: 首页大输入框改为两层容器

首页输入区应形成一个整体容器：

```text
┌──────────────────────────────────────────────┐
│ 白色输入主体                                  │
│ placeholder / textarea                        │
│                                              │
│ + / 附件 / 技能                 模型 / 发送按钮 │
├──────────────────────────────────────────────┤
│ 灰色吸底上下文栏：文件夹 / 当前 Agent          │
└──────────────────────────────────────────────┘
```

要求：

- 白色输入主体维持当前大输入框的圆角、边框和阴影气质。
- 灰色上下文栏与输入主体同宽，视觉上贴在输入主体下方，形成参考图一的「吸底」效果。
- 灰色上下文栏不放进白色输入主体的边框内；它应是输入框下方的独立区域。
- 灰色上下文栏高度应紧凑，建议约 `40px`，不抢占输入主体空间。
- 上下文栏背景使用现有中性色 token，例如 `bg-surface-raised` 或相近 token，不新增独立色系。
- 输入主体和上下文栏之间的边界应轻，不要出现强分割线或卡片套卡片感。

### FR-3: 模型选择器放入白色输入主体底部右侧

模型选择器在首页大输入框中展示，位置参考图一：

- 位于输入主体底部工具栏右侧，发送按钮左侧。
- 与发送按钮、附件/技能按钮在同一工具栏水平线上。
- 下拉方向优先向上或自动，避免被输入框下方上下文栏和快捷动作遮挡。
- 模型切换仍调用当前 Agent 的 `persistAgentModelSelection`，保持「修改当前 Agent 默认模型」的现有语义。
- 持久化中应沿用现有 disabled 状态，避免用户连续切换。

### FR-4: 文件夹选择器移到灰色吸底上下文栏

文件夹入口从白色输入主体底部左侧移到灰色上下文栏内。

要求：

- 保留当前 `FolderSelectorPopover`、最近目录、打开文件夹、清空目录、目录必选校验等能力。
- 文案仍使用现有 i18n，例如 `noFolderSelected`、`coworkSelectFolderFirst`。
- 文件夹名称单行截断，不能撑宽输入容器。
- 文件夹入口表现为下拉选择器，应使用下拉箭头，不展示清空目录的 `x`。
- 文件夹 popover 需要在新位置正确锚定，不被灰色上下文栏裁剪。

### FR-5: 当前 Agent 显示在灰色吸底上下文栏

灰色上下文栏中新增当前 Agent 入口。

要求：

- 展示当前 Agent 的图标或默认图标，以及经过 `getAgentDisplayName` 处理后的名称。
- 默认 Agent 显示为现有 i18n 文案 `defaultAgentDisplayName`，避免直接暴露 `main`。
- Agent 名称单行截断。
- 点击 Agent 入口应打开 Agent 选择菜单，用户可以切换当前 Agent。
- 切换 Agent 后，输入区使用新 Agent 的工作目录和模型配置。
- 若当前 Agent 不存在或列表尚未加载，回退展示默认 Agent，不让布局空缺。

### FR-6: 工具栏左侧保留附件与技能入口

白色输入主体底部左侧保留现有操作：

- 附件按钮。
- 技能按钮。
- 已选技能 badge。

如果需要参考图一增加一个「+」样式入口，可以作为后续视觉优化，不在本 spec 的必要范围内。第一期不应因为图标重绘影响附件、技能、拖拽文件、粘贴图片等现有逻辑。

### FR-7: 仅首页大输入框启用新布局

`CoworkPromptInput` 当前同时服务首页大输入框和会话详情页普通输入框。本次布局应只作用于 `size="large"` 且首页使用场景：

- 首页：使用新两层布局、模型在输入主体内、文件夹和 Agent 在灰色上下文栏。
- 会话详情页：保持现有普通输入框行为。

如果组件内部需要新增模式，应使用明确 prop，例如 `contextLayout="home"`，避免通过 `sessionId` 或样式副作用判断。

### FR-8: i18n 与常量

新增用户可见文案必须加入 `src/renderer/services/i18n.ts` 的中英文区域。

预计新增 key：

| key | zh | en |
| --- | --- | --- |
| `coworkCurrentAgent` | 当前 Agent | Current Agent |
| `coworkSelectAgent` | 选择 Agent | Select Agent |

如果新增跨文件使用的布局模式、菜单模式或上下文项类型，应按仓库规则定义集中常量，避免裸字符串在多个文件中扩散。

## 4. 实现方案

### 4.1 CoworkView 首页 header 调整

在 `src/renderer/components/cowork/CoworkView.tsx` 中：

1. 从 `homeHeader` 左侧移除首页模型选择器。
2. 保留 `currentAgentSelectedModel`、`persistAgentModelSelection` 等状态计算，因为它们需要传给首页输入区。
3. 给 `CoworkPromptInput` 传入首页布局所需的信息：
   - 当前模型值。
   - 模型变更回调。
   - 模型持久化 disabled 状态。
   - 当前 Agent。
   - Agent 列表和切换回调，或让输入组件继续从 Redux 读取 Agent 状态。

### 4.2 CoworkPromptInput 布局拆分

在 `src/renderer/components/cowork/CoworkPromptInput.tsx` 中：

1. 把 `size="large"` 的渲染拆成更清晰的结构：
   - 输入主体 textarea。
   - 主体底部工具栏。
   - 灰色上下文栏。
2. `showModelSelector` 在首页大输入框中应为 true，模型选择器渲染到工具栏右侧。
3. `showFolderSelector` 在首页大输入框中仍为 true，但渲染位置从工具栏左侧移动到上下文栏。
4. 新增当前 Agent 上下文项，与文件夹入口并列。
5. 保持附件列表和图片 vision 提醒在整个输入容器上方，不进入灰色上下文栏。

### 4.3 Agent 选择菜单

建议新增轻量组件承载 Agent 菜单，例如：

- `src/renderer/components/cowork/AgentSelectorPopover.tsx`

要求：

- 复用现有 `agentService.switchAgent(agentId)`。
- 使用现有 Agent 图标展示组件，避免重复实现头像解析。
- 菜单宽度和视觉风格参考 `FolderSelectorPopover` 或 `ModelSelector`。
- 当前 Agent 行显示选中态。

### 4.4 样式约束

推荐视觉方向：

- 输入主体保持白色或当前 surface 色。
- 灰色上下文栏用浅灰底，宽度与输入主体一致。
- 所有上下文 chip 字号建议 `13px` 或现有 `text-xs/text-sm` 体系，不超过当前输入 placeholder 的视觉权重。
- 图标使用现有 heroicons 或项目已有图标组件，不手绘 SVG。
- 移动窄宽度下，文件夹和 Agent 可水平滚动或各自截断，但不能换行撑高输入区。

## 5. 边界情况

| 场景 | 处理方式 |
| --- | --- |
| 没有可用模型 | 沿用 `ModelSelector` 的 `modelSelectorNoModels` 展示逻辑，位置仍在输入主体底部右侧 |
| 模型正在持久化 | 模型选择器 disabled，发送逻辑保持现状 |
| 当前 Agent 无工作目录 | 文件夹入口显示 `noFolderSelected`，提交时仍触发必选提醒 |
| 当前 Agent 切换后有独立工作目录 | 灰色上下文栏立即展示新目录，提交使用新 Agent 的目录 |
| 当前 Agent 切换后模型不同 | 输入主体模型选择器立即展示新 Agent 的模型 |
| Agent 名称或目录很长 | 单行截断，不影响发送按钮位置 |
| 有附件或图片提示 | 附件卡片和图片提示仍展示在输入容器上方 |
| 小输入框或会话详情页 | 不应用新灰色上下文栏布局 |

## 6. 涉及文件

预计涉及：

- `src/renderer/components/cowork/CoworkView.tsx`
- `src/renderer/components/cowork/CoworkPromptInput.tsx`
- `src/renderer/components/cowork/FolderSelectorPopover.tsx`（仅当新锚点或裁剪需要适配）
- `src/renderer/components/cowork/AgentSelectorPopover.tsx`（新增，若实现 Agent 菜单）
- `src/renderer/services/i18n.ts`
- `src/renderer/utils/agentDisplay.ts`（复用，不一定修改）
- `src/renderer/components/agent/AgentAvatarIcon.tsx` 或 `src/renderer/components/icons/DefaultAgentIcon.tsx`（复用，不一定修改）

## 7. 验收标准

1. 首页空会话态顶部 header 不再显示 `Kimi K2.6` 这类模型选择器。
2. 首页大输入框底部右侧显示模型选择器，视觉位置接近参考图一的模型入口。
3. 文件夹入口不再出现在白色输入主体内部，而是在输入框下方灰色吸底区域。
4. 灰色吸底区域同时展示当前选中的 Agent。
5. 切换文件夹后，发起任务使用新目录，并保存到当前 Agent。
6. 切换 Agent 后，首页输入区的文件夹和模型随当前 Agent 更新。
7. 附件、技能、已选技能 badge、发送、停止、拖拽文件、粘贴图片仍可用。
8. 未选择文件夹时提交，必选提醒出现在灰色上下文栏对应位置。
9. 长目录、长 Agent 名称、长模型名称都不会挤压发送按钮或撑宽页面。
10. `./node_modules/.bin/eslint src/renderer/components/cowork/CoworkView.tsx src/renderer/components/cowork/CoworkPromptInput.tsx` 通过；若新增组件和 i18n 修改，也纳入同一次文件级 ESLint。
