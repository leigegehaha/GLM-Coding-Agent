# 智码 GLM Code 任务完成提醒设计文档

## 1. 概述

### 1.1 背景

当前 智码 GLM Code 的 Cowork 会话和其他后台任务可以在用户切换窗口、最小化应用或隐藏应用后继续执行。任务完成时，用户只有回到应用内查看会话状态，才能知道执行已经结束。

这会带来两个体验问题：

- 用户最小化应用后，需要反复手动检查任务是否完成。
- 多个任务完成后，缺少统一的未查看提醒状态，用户可能遗漏需要继续处理的结果。

本需求希望在任务完成后，为非前台使用场景提供轻量提醒：当 智码 GLM Code 不在用户当前焦点中时，通过系统通知、应用图标角标、任务栏提醒和系统托盘状态提示用户任务已经完成；用户回到应用并查看相关任务后，清除提醒状态。

### 1.2 目标

- Cowork 会话执行完成时，如果主窗口最小化、隐藏或未聚焦，触发任务完成提醒。
- 使用系统通知作为主要提醒方式，通知点击后打开 智码 GLM Code 并定位到对应会话。
- 提供任务完成通知开关：关闭时不做外部提醒，开启时仅在应用不在前台时提醒。
- 在支持的平台上显示应用图标角标或任务栏提醒，表示存在未查看的完成结果。
- 在系统托盘中展示未查看完成任务状态，并提供回到应用的入口。
- 用户查看对应会话后，清除该会话的未查看提醒；所有提醒被查看后清空全局角标和托盘提醒状态。
- 用户主动回到应用前台时，清空全局外部提醒状态，避免应用图标角标或任务栏提醒滞留。
- 保持提醒逻辑集中在主进程，renderer 只负责上报用户查看状态和响应会话跳转。
- 所有用户可见文案接入现有 i18n 系统。

### 1.3 非目标

- 不实现复杂通知中心或历史消息收件箱。
- 不为每一次流式 message update 弹通知，只在任务进入完成态时提醒。
- 不在前台活跃使用时弹系统通知，避免打扰用户。
- 不保证所有 Linux 桌面环境都支持角标或托盘高亮；Linux 以系统通知和托盘菜单为主要降级方案。
- 不改变 Cowork 引擎的执行流程、权限审批流程或消息存储结构。

### 1.4 产品决策

智码 GLM Code 当前通用设置页主要使用 switch 控件。为保持设置页一致性，本需求第一阶段只提供一个 `任务完成通知` 开关：

- 关闭：任务完成后不发送系统通知，也不创建外部角标/托盘提醒状态。
- 开启：仅当应用失焦、最小化或隐藏时发送任务完成通知，并创建未查看提醒状态。

不提供 `始终通知`、权限通知或问题通知设置。后续如果通知设置增多，可升级为独立通知分组或更细的通知偏好控件。

## 2. 用户场景

### 场景 1: 最小化后任务完成

**Given** 用户启动一个 Cowork 会话并最小化 智码 GLM Code
**When** Cowork 会话执行完成
**Then** 系统显示任务完成通知，应用图标或任务栏进入未查看提醒状态

**When** 用户点击通知
**Then** 智码 GLM Code 恢复到前台，并打开对应 Cowork 会话

### 场景 1a: 关闭窗口后点击通知

**Given** macOS 开发环境或其他场景下，用户点击关闭按钮导致主窗口被销毁但应用进程仍在运行
**When** 用户点击任务完成系统通知
**Then** 智码 GLM Code 重新创建主窗口，等待 renderer 通知跳转监听就绪后，再打开对应 Cowork 会话

### 场景 2: 应用在后台但未最小化

**Given** 智码 GLM Code 窗口仍然可见，但当前焦点在其他应用
**When** Cowork 会话执行完成
**Then** 智码 GLM Code 发送系统通知，并设置未查看完成任务状态

### 场景 3: 用户正在查看该会话

**Given** 智码 GLM Code 窗口处于前台
**When** 某个 Cowork 会话执行完成
**Then** 应用内状态正常更新，但不发送系统通知，也不设置外部角标提醒

### 场景 4: 多个任务完成

**Given** 用户连续启动多个 Cowork 会话后切到其他应用
**When** 多个会话陆续完成
**Then** 系统通知可分别提示任务完成，应用角标显示未查看完成任务数量

**When** 用户查看其中一个完成会话
**Then** 该会话的未查看状态被清除，角标数量减少

**When** 所有完成会话都被查看
**Then** 应用角标、任务栏提醒和托盘提醒状态全部清除

**When** 用户通过 Dock、任务栏、通知或托盘主动回到 智码 GLM Code 前台
**Then** 全局外部提醒状态被清除，避免已回到应用后角标继续显示

### 场景 5: 用户从托盘回到应用

**Given** 至少有一个未查看的完成任务
**When** 用户点击托盘图标或托盘菜单中的查看入口
**Then** 智码 GLM Code 恢复并聚焦主窗口，默认打开最近完成且未查看的 Cowork 会话

## 3. 功能需求

### FR-1: 完成事件识别

- Cowork 引擎流事件进入 `complete` 时，主进程记录该 session 的完成提醒候选状态。
- 只有 session 存在且完成事件未重复处理时，才创建未查看提醒。
- 同一个 session 多次收到完成事件时不得重复增加未查看计数。
- 如果会话被停止、删除或执行失败，不应按完成提醒处理；失败提醒可作为后续独立需求。

### FR-2: 前后台判断

- 主进程在完成事件发生时判断主窗口状态。
- 以下任一条件成立时，视为需要外部提醒：
  - 主窗口不存在。
  - 主窗口最小化。
  - 主窗口不可见或隐藏。
  - 主窗口未聚焦。
- 如果主窗口存在、可见且聚焦，只更新应用内完成状态，不触发系统通知、角标或托盘提醒。

### FR-3: 系统通知

- 使用 Electron 主进程通知能力发送系统通知。
- 通知标题建议为 `任务已完成`。
- 通知正文使用固定隐私安全文案，例如 `有任务已完成，点击查看结果`。
- 通知不得展示用户问题、会话标题、任务摘要、敏感输出内容、完整提示词、token 或本地路径等隐私信息。
- 通知点击后：
  - 恢复并聚焦主窗口；如果主窗口已销毁但应用进程仍在运行，应重新创建主窗口。
  - 等待 renderer 注册通知跳转监听后再发送会话跳转事件，避免窗口重建时 IPC 过早投递。
  - 切换到 Cowork 页面。
  - 打开对应 session。
- 如果系统通知不可用或权限被拒绝，应降级为角标和托盘提醒，不阻断任务完成流程。
- 系统通知是否发送必须受用户设置 `taskCompletionNotificationsEnabled` 控制。
- 主进程需要保留活动 `Notification` 对象引用，确保 macOS 通知进入通知中心后点击事件仍可回调。
- 活动通知引用必须有上限，并在点击、清空、session 查看或删除时释放，避免长期内存增长。

### FR-3a: 通知设置

- 在 Settings 的通用页增加 `任务完成通知` 设置，位置建议放在 `跳过未执行任务` 附近，作为任务运行相关设置。
- `任务完成通知` 使用 switch 控件，保持与当前通用设置页一致。
- 开关默认开启。
- 开启后，仅当应用失焦、最小化或隐藏时发送任务完成通知。
- 关闭后，任务完成不发送系统通知，也不创建外部角标/托盘提醒状态。
- 设置变更保存到 `app_config.notificationSettings`，由主进程提醒管理器读取。
- 所有设置项标题、描述和选项必须接入 renderer i18n。
- 主进程发送通知时使用 main i18n 文案。

### FR-4: 应用图标与任务栏提醒

- macOS 使用 `app.dock.setBadge(String(count))` 显示未查看完成任务数量。
- Windows 优先使用 `BrowserWindow.setOverlayIcon(...)` 显示提醒图标；必要时使用 `win.flashFrame(true)` 提醒用户。
- Linux 支持能力不统一，允许只使用系统通知和托盘状态。
- 当未查看完成任务数量为 0 时：
  - macOS 清空 dock badge。
  - Windows 清空 overlay icon，并停止 flashFrame。
  - Linux 清空可用的提醒状态。

### FR-5: 系统托盘提醒状态

- 如果应用已经启用系统托盘，任务完成后托盘应进入提醒状态。
- 托盘 tooltip 显示未查看完成任务数量，例如 `智码 GLM Code - 1 个任务已完成`。
- 托盘菜单增加或更新查看入口，例如 `查看完成的任务`。
- 点击托盘图标时，如果存在未查看完成任务，优先打开最近完成的未查看 Cowork 会话。
- 如果当前应用尚未创建托盘，应先确认现有托盘架构；本需求不强制新增常驻托盘架构，第一阶段可只接入已有托盘。

### FR-6: 查看状态清理

- renderer 在用户打开或切换到某个 Cowork session 时，通过 IPC 通知主进程该 session 已查看。
- 主进程清除该 session 的未查看完成状态。
- 清理后重新计算全局未查看数量，并更新 dock badge、overlay icon、flashFrame 和托盘状态。
- 删除 session 时，也必须清除对应的未查看提醒状态。
- 用户主动聚焦主窗口时，清除全局外部提醒状态。该清理只影响角标、任务栏、托盘和系统通知引用，不改变 Cowork session 的业务数据。

### FR-7: IPC 与常量

- 新增 IPC channel 必须定义在对应模块的 constants 文件中，不能使用裸字符串。
- renderer 调用 IPC 时必须通过 preload 暴露的 `window.electron` API，不直接访问 Electron。
- 推荐新增 IPC：
  - `cowork:session:markViewed`
  - `cowork:session:openFromNotification`
  - `cowork:session:openFromNotificationReady`
- 如果已有会话选择或导航 IPC 可以复用，应优先复用现有通道。
- renderer 注册通知跳转监听后，需要通过 ready IPC 通知主进程；主进程在窗口加载完成且 renderer ready 后，再发送打开 session 事件。

### FR-8: i18n

- 所有用户可见通知标题、正文、托盘 tooltip 和托盘菜单文案都必须接入 i18n。
- 主进程文案使用 `src/main/i18n.ts`。
- renderer 文案使用 `src/renderer/services/i18n.ts`。
- 新增 key 必须同时提供中文和英文翻译。

## 4. 实现方案

### 4.1 新增任务完成提醒管理器

建议新建：

`src/main/libs/taskCompletionNotifier.ts`

职责：

- 维护未查看完成任务集合。
- 接收 Cowork `complete` 事件。
- 判断是否需要外部提醒。
- 发送系统通知。
- 更新 dock badge、任务栏 overlay、flashFrame 和托盘状态。
- 处理通知点击后的窗口恢复和 session 跳转。
- 处理 session viewed / deleted 后的提醒清理。

核心状态建议：

```ts
interface PendingCompletionNotification {
  sessionId: string;
  completedAt: number;
}

const pendingCompletions = new Map<string, PendingCompletionNotification>();
```

通知设置建议定义集中默认值，避免配置散落：

```ts
export interface NotificationSettings {
  taskCompletionNotificationsEnabled: boolean;
}

export const defaultNotificationSettings: NotificationSettings = {
  taskCompletionNotificationsEnabled: true,
};
```

### 4.2 接入 Cowork complete 事件

在 `CoworkEngineRouter` 或主进程统一接收 stream event 的位置接入提醒逻辑。

目标流程：

```text
OpenClaw runtime complete
  -> CoworkEngineRouter emits complete event
  -> main process persists / forwards complete state
  -> TaskCompletionNotifier.handleComplete(session)
  -> notify renderer as before
```

提醒逻辑不能影响原有 complete 事件投递。通知发送失败时只记录 warn，不应导致会话状态异常。

### 4.3 窗口恢复与会话跳转

新增统一 helper：

```ts
function focusMainWindow(reason: string): void {
  const targetWindow = getOrCreateMainWindow(reason);
  if (!targetWindow) return;
  if (targetWindow.isMinimized()) targetWindow.restore();
  if (!targetWindow.isVisible()) targetWindow.show();
  targetWindow.focus();
  if (process.platform === 'darwin') {
    app.focus({ steal: true });
  }
}
```

通知点击或托盘查看入口触发时：

```text
focusMainWindow('task completion notification')
  -> cache pending session id
  -> wait for main window load and renderer notification-ready IPC
  -> mainWindow.webContents.send(coworkOpenSessionChannel, sessionId)
```

renderer 收到打开 session 事件后，切换到 Cowork 页面并选中对应 session。若当前应用已有类似导航事件，应复用现有事件。

### 4.4 查看状态清理

主进程需要知道用户何时查看了带有未查看提醒的 Cowork session，用于清理角标、任务栏和托盘提醒状态。

建议由 renderer 在以下时机上报：

- Cowork 页面选中 session 时。
- 应用从后台恢复且 Cowork 当前 session 未变化时，可再次上报当前 session 已查看。

主进程不需要用“当前正在查看的 session”决定是否创建外部提醒。创建提醒只取决于窗口是否不在前台，以及 `taskCompletionNotificationsEnabled` 是否开启。

主进程可以保存最近查看状态或直接按 IPC 参数清理：

```ts
let activeViewedCoworkSessionId: string | null = null;
```

当收到 viewed 事件且 `pendingCompletions` 中存在该 session 时，清理该 session 的未查看提醒并刷新全局提醒状态。

当主窗口获得焦点时，主进程清理所有外部提醒状态，确保用户回到应用后 macOS Dock badge、Windows overlay / flashFrame 和托盘提醒不会继续滞留。

`taskCompletionNotificationsEnabled` 对完成提醒的影响：

- `false`：不发送系统通知，第一阶段也不创建外部提醒状态。
- `true`：沿用前后台判断，只有主窗口不存在、失焦、最小化或隐藏时提醒。

默认开启，且开启后的触发条件为应用失焦。

### 4.4a Settings UI 集成

当前 `src/renderer/components/Settings.tsx` 的 `general` tab 已包含语言、开机自启动、防止休眠、跳过未执行任务等全局设置，且主要使用 switch 控件。通知设置建议放在通用页中靠近 `跳过未执行任务` 的位置，使用与现有设置一致的行式布局：

```text
任务完成通知        [toggle]
应用不在前台时，任务完成后显示系统提醒
```

保存流程：

- renderer 从 `app_config.notificationSettings` 初始化状态。
- 点击保存时把 normalized notification settings 一并写入 `app_config`。
- 主进程通过 store watcher 或 notifier getter 读取最新设置。
- 如果设置从开启切换为关闭，立即清理系统通知角标、任务栏和托盘提醒状态。

### 4.5 平台能力封装

提醒管理器内部按平台封装能力：

- `updateDockBadge(count)`：仅 macOS 生效。
- `updateWindowsOverlay(count)`：仅 Windows 生效。
- `updateTrayState(count)`：在已有 tray 实例存在时生效。
- `clearAttentionState()`：count 为 0 时统一清理。

Windows overlay icon 可先使用现有应用资源或新增小尺寸 PNG。若第一阶段没有合适资源，可以先使用 `flashFrame(true)`，后续再补 overlay icon。

### 4.6 托盘菜单集成

如果项目已有 tray 初始化逻辑，应把提醒状态作为 tray menu 构建参数之一。

菜单建议：

```text
查看完成的任务
---
显示 智码 GLM Code
退出
```

当没有未查看完成任务时，隐藏或禁用 `查看完成的任务`。

托盘点击行为建议：

- 有未查看完成任务：打开最近完成的未查看 session。
- 没有未查看完成任务：保持现有显示/隐藏窗口行为。

### 4.7 日志

新增日志必须遵循主进程 logging guidelines：

```ts
console.log('[TaskCompletionNotifier] recorded 1 completed session notification');
console.warn('[TaskCompletionNotifier] system notification is not available');
console.error('[TaskCompletionNotifier] failed to update tray reminder:', error);
```

不允许在高频流式 update 中打印 info 级日志。只在完成提醒创建、清理、通知失败等关键事件记录日志。

## 5. 数据与持久化

第一阶段建议未查看提醒状态只保存在内存中：

- 应用运行期间完成的任务可以提醒。
- 应用重启后不恢复旧的未查看角标。
- 避免新增数据库迁移和状态一致性复杂度。

如果后续希望跨重启保留未查看完成任务，可在 `cowork_sessions` 中增加 `completedViewedAt` 或新增提醒状态表。该增强不属于第一阶段范围。

通知偏好需要持久化到现有 `app_config`：

```json
{
  "notificationSettings": {
    "taskCompletionNotificationsEnabled": true
  }
}
```

读取配置时必须 normalize，兼容旧配置缺失该字段的情况。

## 6. 测试计划

### 6.1 单元测试

- `TaskCompletionNotifier` 重复 complete 事件不会重复计数。
- `markSessionViewed(sessionId)` 会清除对应提醒。
- 删除 session 会清除对应提醒。
- count 从 1 变为 0 时会调用清理方法。
- 窗口前台且正在查看同一 session 时不会创建外部提醒。

测试文件使用 `.test.ts` 并与源文件 co-locate。

### 6.2 手动验证

- macOS：
  - 最小化窗口后完成 Cowork，会出现系统通知和 dock badge。
  - 点击通知后应用恢复到前台并打开对应 session。
  - 点击关闭按钮导致窗口销毁但进程仍在时，点击新系统通知可以重建窗口并打开对应 session。
  - 系统通知进入通知中心后，点击新通知仍能打开应用；主进程日志可看到通知点击和打开 session 记录。
  - 查看 session 后 dock badge 清空。
- Windows：
  - 后台完成 Cowork，会出现系统通知。
  - 任务栏 flash 或 overlay 状态生效。
  - 查看 session 后提醒清空。
- Linux：
  - 后台完成 Cowork，会出现系统通知。
  - 托盘 tooltip 或菜单状态按可用能力更新。
- 前台正在查看 session 时，完成后不弹系统通知。
- 多个 session 完成后，角标数量正确递增和递减。
- 用户主动回到应用前台后，角标、任务栏提醒和托盘提醒状态清空。
- 通知文案不展示用户问题、任务摘要、本地路径或模型输出内容。
- 关闭 `任务完成通知` 后，后台任务完成不弹系统通知。
- 开启 `任务完成通知` 后，前台完成不弹通知，后台完成弹通知。

## 7. 风险与兼容性

- 系统通知权限由操作系统控制，用户关闭通知后只能依赖角标和托盘状态。
- Windows overlay icon 需要准备合适资源；没有资源时可以先用 flashFrame 降级。
- Linux 桌面环境能力差异较大，不应把角标作为 Linux 验收硬要求。
- 通知点击后的页面跳转依赖 renderer 导航事件，需要保证页面未初始化完成时可以缓存或延迟处理。
- macOS 通知横幅收起或进入通知中心时可能触发 Electron `close` 事件，不应仅因为 `close` 就释放通知对象引用，否则后续点击可能无法进入主进程 click handler。
- 如果未来支持多窗口，需要把 active viewed session 从全局单值扩展为按窗口维度维护。

## 8. 分阶段实施建议

### Phase 1: 基础提醒

- 新增通知设置 UI 和 `app_config.notificationSettings` 持久化。
- 接入 Cowork complete 事件。
- 实现系统通知。
- 实现 macOS dock badge 和 Windows flashFrame。
- 实现通知点击恢复窗口并打开 session。
- 实现窗口销毁后的通知点击重建主窗口，并通过 renderer ready IPC 避免跳转事件丢失。
- 实现查看后清除提醒。

### Phase 2: 托盘增强

- 接入已有 tray 菜单。
- 增加 tooltip 状态和查看完成任务入口。
- 支持点击托盘打开最近完成的未查看 session。

### Phase 3: 平台细化

- Windows 增加 overlay icon 资源。
- 根据需要持久化未查看完成状态。
- 增加用户设置：是否显示角标、是否播放声音。
