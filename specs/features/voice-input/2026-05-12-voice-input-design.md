# 语音输入功能设计文档

## 1. 概述

### 1.1 背景

OpenClaw Web UI 的聊天输入框左下角提供了一个麦克风按钮，支持语音转文字输入。

最初方案：移植 OpenClaw 的 `SpeechRecognition` API 方案。但 Electron 基于 Chromium（非 Chrome），不内置 Google Speech 服务的 API 密钥，`SpeechRecognition` 会报 `network` 错误无法使用。

最终方案：**利用操作系统原生语音听写**。Windows 10/11 自带 Win+H 语音听写功能，macOS 自带 Fn+Fn 听写功能。Electron 渲染的输入框是标准文本框，系统听写可直接将识别文字输入进去。

### 1.2 目标

- 在 智码 GLM Code 聊天输入框添加语音输入按钮
- 点击按钮触发操作系统原生语音听写
- 系统听写直接将文字输入到聚焦的输入框中

## 2. 用户场景

### 场景 1: 语音输入消息
**Given** 用户在聊天输入页面
**When** 用户点击输入框左下角的麦克风按钮
**Then** 输入框获得焦点，系统语音听写 UI 弹出，用户说话后文字自动输入到输入框

### 场景 2: 追加输入
**Given** 输入框已有文字内容
**When** 用户点击麦克风按钮触发语音听写
**Then** 系统听写将文字追加到光标位置，不覆盖原有文字

### 场景 3: remoteManaged 模式
**Given** 当前为 remoteManaged 模式
**When** 用户查看输入框
**Then** 与文件按钮一致，不显示语音按钮

## 3. 功能需求

### FR-1: 麦克风按钮
- 位于聊天输入框 toolbar 左侧，在文件附件按钮之后
- 使用 mic 图标（stroke-based SVG）
- 点击后先聚焦 textarea，再触发系统听写

### FR-2: 系统听写触发
- Windows：通过主进程 IPC 模拟 Win+H 按键
- macOS：通过主进程 IPC 模拟 Fn+Fn 按键
- 使用 PowerShell P/Invoke（Windows）或 AppleScript（macOS）模拟按键

### FR-3: i18n
- `voiceInput`: "语音输入" / "Voice input"

## 4. 实现方案

### 4.1 MicrophoneIcon 组件

新建 `src/renderer/components/icons/MicrophoneIcon.tsx`，使用 OpenClaw 的 mic SVG path，遵循项目现有图标组件模式（参照 `PaperClipIcon.tsx`）。

### 4.2 triggerSystemDictation

新建 `src/renderer/hooks/useSpeechToText.ts`，导出 `triggerSystemDictation()` 函数：
- 调用 `window.electron.voice.triggerDictation()` IPC
- 主进程通过 PowerShell/AppleScript 模拟系统快捷键

### 4.3 IPC 层

- **主进程** `src/main/main.ts`：注册 `voice:triggerDictation` handler
  - Windows：通过 PowerShell 调用 `keybd_event` P/Invoke 模拟 Win+H
  - macOS：通过 `osascript` 模拟 Fn 键
- **Preload** `src/main/preload.ts`：暴露 `window.electron.voice.triggerDictation()`
- **类型** `src/renderer/types/electron.d.ts`：添加 `voice` 接口类型

### 4.4 CoworkPromptInput 集成

修改 `src/renderer/components/cowork/CoworkPromptInput.tsx`：
- 在 `largeInputActions` 中 PaperClip 按钮之后添加麦克风按钮
- 在 normal 布局中同样位置添加麦克风按钮
- 点击时：先 `textareaRef.current?.focus()` 聚焦输入框，再调用 `triggerSystemDictation()`

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 系统未开启语音听写 | Windows 会自动提示用户开启 |
| 模拟按键失败 | console.warn 记录，不影响应用 |
| streaming 中 | 按钮 disabled |
| remoteManaged 模式 | 按钮不显示（与文件按钮一致） |
| 非 Windows/macOS 平台 | IPC 返回 unsupported，按钮点击无效果 |

## 6. 涉及文件

| 操作 | 文件 |
|------|------|
| 新建 | `src/renderer/components/icons/MicrophoneIcon.tsx` |
| 新建 | `src/renderer/hooks/useSpeechToText.ts` |
| 修改 | `src/renderer/components/cowork/CoworkPromptInput.tsx` |
| 修改 | `src/renderer/services/i18n.ts` |
| 修改 | `src/main/main.ts` |
| 修改 | `src/main/preload.ts` |
| 修改 | `src/renderer/types/electron.d.ts` |

## 7. 验收标准

- [ ] 聊天输入框左下角出现麦克风图标（在文件附件按钮旁）
- [ ] 点击麦克风按钮后系统语音听写 UI 弹出
- [ ] 说话后文字自动输入到聊天输入框
- [ ] 大输入框和小输入框两种布局均正常工作
- [ ] remoteManaged 模式下按钮不显示
- [ ] streaming 中按钮 disabled
