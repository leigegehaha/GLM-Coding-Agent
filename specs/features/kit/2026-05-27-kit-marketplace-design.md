# Kit（专家套件）商店设计文档

## 1. 概述

### 1.1 背景

智码 GLM Code 已有 Skill（技能）体系，用户可以为 Agent 加载单个 Skill 来扩展能力。但在实际使用中，某些场景需要多个 Skill 协同工作才能完成较复杂的任务（如"翻译专家"需要术语库 + 翻译引擎 + 校对三个 Skill 配合）。单独安装和管理多个 Skill 的体验较碎片化，用户难以发现"哪些 Skill 组合在一起效果最好"。

Kit（专家套件）是在 Skill 之上的一层打包概念：一个 Kit 包含一组预配置的 Skill，用户一键安装即可获得完整的专家能力集合。

### 1.2 目标

1. 提供 Kit 商店（Marketplace），用户可浏览、搜索、安装和卸载 Kit
2. 在对话输入区域允许用户选择已安装的 Kit 作为当前对话的"专家模式"
3. Kit 选择后，其包含的所有 Skill 自动注入到对话上下文中
4. 支持 Kit 选择状态在会话切换时的持久化（draft persistence）
5. 支持"试问"（Try Asking）功能，引导用户快速体验 Kit 能力

## 2. 用户场景

### 场景 1: 浏览与安装 Kit

**Given** 用户进入侧边栏的"专家套件"页面
**When** 用户浏览 Kit 列表或搜索特定 Kit
**Then** 显示商店中所有可用 Kit 及其名称、描述、版本、包含的 Skill 数量等元信息；用户点击"安装"按钮后 Kit 被下载安装到本地

### 场景 2: 在对话中使用 Kit

**Given** 用户已安装至少一个 Kit
**When** 在对话输入框点击 Kit 按钮并选择一个或多个 Kit
**Then** 输入框上方显示已选中 Kit 的标签（Badge），发送消息时 Kit 中包含的 Skill 被自动加载到上下文

### 场景 3: Kit 的 Try Asking 引导

**Given** 用户在 Kit 详情页看到"试试问"列表
**When** 用户点击某个推荐问题
**Then** 若 Kit 已安装则自动填入输入框并跳转对话页面；若未安装则弹窗提示安装

### 场景 4: 卸载 Kit

**Given** 用户在 Kit 列表或详情页
**When** 点击卸载按钮
**Then** Kit 所包含的 Skill 文件被删除，安装记录被移除，Kit 从已安装列表消失

### 场景 5: Kit 选择跨会话持久化

**Given** 用户在某个对话会话中选中了 Kit
**When** 切换到其他会话再切回
**Then** 之前选中的 Kit 状态仍保留（存储在 draftKitIds 中）

## 3. 功能需求

### FR-1: Kit 商店数据获取

- 通过 Overmind 远程配置接口获取 Kit 目录（test/prod 环境区分）
- 目录结构包含 Kit 列表，每个 Kit 包含 `id`、`name`（支持多语言）、`description`、`icon`、`author`、`version`、`downloadCount`、`tryAsking`、`skills`（bundle URL + skill 列表）
- 前端缓存避免重复请求

### FR-2: Kit 安装

- 下载 Kit bundle（zip 文件）
- 解压后扫描其中的 SKILL.md 文件，识别 Skill 目录
- 将 Skill 目录复制到用户数据目录的 `SKILLs/` 下
- 在 `skills_state` 中将新 Skill 设为启用
- 在 SQLite 中记录 Kit 安装信息（id, version, installedAt, skillIds）
- 通知渲染进程 Skill 列表已变更

### FR-3: Kit 卸载

- 根据 Kit 安装记录中的 skillIds 删除对应 Skill 目录
- 从 `skills_state` 中移除对应条目
- 删除 Kit 安装记录
- 通知渲染进程

### FR-4: Kit 商店 UI（全页面）

- 侧边栏新增"专家套件"入口，点击展示全页面 Kit 管理视图
- 列表视图：双列网格卡片，显示 Kit 名称、描述、版本、Skill 数量、官方标记
- 详情视图：返回按钮、Kit 头部信息、完整描述、Try Asking 列表、包含 Skill 列表
- 搜索过滤：按名称和描述搜索
- 安装/卸载操作带 loading 状态

### FR-5: Kit 选择 Popover（对话输入区域）

- 对话输入框工具栏增加 Kit 按钮
- 点击弹出 Popover，显示已安装 Kit 列表
- 支持多选，选中的 Kit 以 CheckIcon 标记
- 底部提供"管理套件"入口跳转全页面管理
- 选中 Kit 后输入框上方显示 ActiveKitBadge，点击可取消选中

### FR-6: Kit → Skill 展开与注入

- 发送消息时，将 `activeKitIds` 展开为对应的 `skillIds`
- 与用户单独选择的 `activeSkillIds` 合并后去重
- 合并后的 Skill 列表注入到会话创建/续发消息请求中
- Kit ID 也同时传递给后端（`activeKitIds` 字段），用于统计和回溯

### FR-7: Draft 持久化

- Kit 选择状态存储在 `coworkSlice.draftKitIds[draftKey]`
- 切换会话时从 draftKitIds 恢复 Kit 选择
- 与 draftPrompts、draftAttachments 使用相同的 draftKey 机制

## 4. 实现方案

### 4.1 数据模型

```typescript
// 商店中的 Kit 定义
interface MarketplaceKit {
  id: string;
  name: string | LocalizedText;
  description: string | LocalizedText;
  icon?: string;
  author?: string;
  version?: string;
  downloadCount?: string;
  tryAsking?: (string | LocalizedText)[];
  skills?: { bundle: string; list: { id: string; name: string }[] };
  mcpServers?: any;
  connectors?: any;
}

// 本地安装记录
interface InstalledKit {
  id: string;
  version: string;
  installedAt: number;
  skillIds: string[];  // 实际安装到 SKILLs/ 目录下的 folder 名列表
}
```

### 4.2 主进程（Electron Main）

| IPC Handle | 说明 |
|---|---|
| `kits:fetchStore` | 从 Overmind 拉取 Kit 目录 JSON |
| `kits:listInstalled` | 从 SQLite 读取已安装 Kit Map |
| `kits:install` | 下载 bundle zip → 解压 → 复制 Skill → 记录 → 通知 |
| `kits:uninstall` | 删除 Skill 文件 → 清除记录 → 通知 |

数据源 URL:
- test: `https://glmcoding.cn/openapi/get/luna/hardware/lobsterai/test/kit-store`
- prod: `https://glmcoding.cn/openapi/get/luna/hardware/lobsterai/prod/kit-store`

安装流程：下载 zip → 临时目录解压 → 扫描 `SKILL.md` 识别 Skill 目录 → 拷贝到 `{userData}/SKILLs/` → 写入 `skills_state` 和 `kits_installed` → 触发 `skills:changed` 事件 → 清理临时文件。

### 4.3 渲染进程

| 模块 | 职责 |
|---|---|
| `kitSlice` (Redux) | 管理 `installedKits`、`marketplaceKits`、`activeKitIds` 状态 |
| `coworkSlice` 扩展 | 新增 `draftKitIds` 字段实现 Kit 选择持久化 |
| `KitService` | 封装 IPC 调用，提供缓存 |
| `KitsView` | 全页面 Kit 管理入口 |
| `KitsManager` | 列表/详情/搜索/安装卸载逻辑 |
| `KitsPopover` | 输入框旁 Kit 选择弹窗 |
| `KitsButton` | 工具栏触发按钮 |
| `ActiveKitBadge` | 输入框上方已选 Kit 标签 |

### 4.4 Sidebar 集成

侧边栏新增"专家套件"导航项，位于"技能"和"MCP"之间，使用 `SidebarKitsIcon`。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 网络不可用无法获取商店 | 返回空列表，不影响已安装 Kit 的使用 |
| Bundle zip 中无 SKILL.md | 安装失败，返回错误提示 |
| 安装目标目录已存在同名文件夹 | 自动追加后缀（`-1`, `-2`...）避免冲突 |
| Kit 卸载后仍被某会话 draft 引用 | `setInstalledKits` reducer 自动清理不再存在的 activeKitIds |
| Windows 系统解压文件属性问题 | 安装后用 `attrib` 命令移除只读/系统/隐藏属性 |
| Try Asking 点击但 Kit 未安装 | 弹出确认对话框，用户确认后先安装再执行 |
| 商店接口返回异常结构 | 安全解析，字段缺失时降级为空 |

## 6. 涉及文件

### 新增文件

| 文件 | 说明 |
|---|---|
| `src/main/ipcHandlers/kits/handlers.ts` | Kit IPC handlers（fetch/install/uninstall） |
| `src/main/ipcHandlers/kits/index.ts` | handlers barrel export |
| `src/renderer/components/kits/KitsView.tsx` | Kit 全页面容器 |
| `src/renderer/components/kits/KitsManager.tsx` | Kit 列表与详情管理 |
| `src/renderer/components/kits/KitsPopover.tsx` | 输入区 Kit 选择弹窗 |
| `src/renderer/components/kits/KitsButton.tsx` | 工具栏 Kit 按钮 |
| `src/renderer/components/kits/ActiveKitBadge.tsx` | 已选 Kit Badge |
| `src/renderer/components/kits/index.ts` | barrel export |
| `src/renderer/components/icons/SidebarKitsIcon.tsx` | Kit 侧边栏图标 |
| `src/renderer/services/kit.ts` | KitService 封装 |
| `src/renderer/store/slices/kitSlice.ts` | Kit Redux 状态 |
| `src/renderer/types/kit.ts` | Kit 类型定义 |

### 修改文件

| 文件 | 变更 |
|---|---|
| `src/main/main.ts` | 注册 Kit IPC handlers |
| `src/main/preload.ts` | 暴露 `kits` API 到渲染进程 |
| `src/main/libs/endpoints.ts` | 新增 `getKitStoreUrl` |
| `src/renderer/App.tsx` | 路由集成 KitsView |
| `src/renderer/components/Sidebar.tsx` | 新增 Kit 导航项 |
| `src/renderer/components/cowork/CoworkPromptInput.tsx` | 集成 KitsButton、ActiveKitBadge、Kit→Skill 展开逻辑 |
| `src/renderer/components/cowork/CoworkView.tsx` | 会话创建时传递 activeKitIds |
| `src/renderer/components/cowork/CoworkSessionDetail.tsx` | Kit 相关状态恢复 |
| `src/renderer/store/index.ts` | 注册 kitSlice |
| `src/renderer/store/slices/coworkSlice.ts` | 新增 draftKitIds 字段和 reducer |
| `src/renderer/services/i18n.ts` | 新增 Kit 相关国际化文案 |
| `src/renderer/services/endpoints.ts` | 新增 Kit store URL |
| `src/renderer/types/cowork.ts` | 扩展 session 创建参数 |
| `src/renderer/types/electron.d.ts` | 新增 kits IPC 类型声明 |

## 7. 验收标准

1. 侧边栏"专家套件"入口可正常打开 Kit 商店页面
2. 商店页面正确展示 Kit 列表（双列卡片），包含名称、描述、版本、Skill 数量
3. 搜索功能按名称/描述过滤 Kit
4. 点击 Kit 卡片进入详情页，展示完整信息和 Try Asking 列表
5. 安装 Kit 后对应 Skill 出现在用户 SKILLs 目录且启用
6. 卸载 Kit 后 Skill 文件和安装记录被清除
7. 对话输入框 Kit 按钮可弹出已安装 Kit 列表，支持多选
8. 选中 Kit 后输入框显示 ActiveKitBadge
9. 发送消息时 Kit 中的 Skill 被正确注入上下文
10. 切换会话后 Kit 选择状态正确恢复（draft 持久化）
11. Try Asking 点击后正确导航至对话页面并填入文本
12. 未安装 Kit 时 Try Asking 弹出安装确认框
