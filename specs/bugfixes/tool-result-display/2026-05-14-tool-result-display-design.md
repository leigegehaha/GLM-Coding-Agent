# Tool Result 展示修复设计文档

## 1. 概述

### 1.1 问题

流式对话中，工具调用的结果文本和媒体文件无法正确展示：

1. **Tool result 文本丢失**：OpenClaw gateway 的 agent 流式事件不携带 tool result 的完整文本（`data.result` 为空或被截断），导致 智码 GLM Code 前端的 tool result 消息内容为空。
2. **图片不展示**：`image_generate` 等工具在 tool result 中通过 `MEDIA:` token 返回生成的图片路径，但 智码 GLM Code 无法识别和展示这些图片。

### 1.2 根因

- Gateway 的 agent 事件协议在流式传输时会剥离 tool result 文本以减少带宽，完整文本仅保留在 `chat.history` 中。
- `MEDIA:` token 是 OpenClaw 工具结果中的自定义格式（如 `MEDIA:C:\Users\...\image.png`），智码 GLM Code 前端的 artifacts 系统此前未覆盖该格式。

## 2. 用户场景

### 场景 1: 使用 image_generate 工具生成图片

**Given** 用户在对话中请求生成图片，agent 调用了 `image_generate` 工具
**When** 工具执行完成，返回包含 `MEDIA:/path/to/image.png` 的 tool result
**Then** 图片以 ArtifactPreviewCard 卡片形式展示在对话中，点击可在 artifact panel 中预览；tool result 的 `<pre>` 块中不显示原始 `MEDIA:` token 文本

### 场景 2: 使用其他工具（如 bash、web_search）

**Given** 用户在对话中使用了返回文本结果的工具
**When** 工具执行完成，流式事件中 tool result 文本被 gateway 截断
**Then** 在 `chat.final` 事件后，从 `chat.history` 回填完整的 tool result 文本，前端正确展示

## 3. 功能需求

### FR-1: 从 chat.history 回填 tool result 文本

在 `handleChatFinal` 时，若当前 turn 有 tool 调用，请求 `chat.history` 获取权威的 tool result 文本，回填到本地消息存储中。

### FR-2: 通过 artifacts 系统展示 MEDIA 文件

在前端 artifact 检测管线中解析 `MEDIA:` token，提取文件路径，生成对应类型的 artifact（image、document 等），统一通过 ArtifactPreviewCard 展示。

### FR-3: 在 tool result 显示中剥离 MEDIA token

tool result 消息在 `<pre>` 块中显示时，应剥离 `MEDIA:` token 文本，避免用户看到原始格式。DB 中的 `msg.content` 保持不变，仅显示时过滤。

## 4. 实现方案

### 4.1 chat.history 回填（后端）

**文件**: `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`

在 `handleChatFinal` 中，当 `turn.toolUseMessageIdByToolCallId.size > 0` 时：

1. 请求 `chat.history`（`limit: 20`，`timeoutMs: 5000`）
2. 遍历返回的消息，匹配 `role === 'toolResult' || role === 'tool'` 且有 `toolCallId` 的条目
3. 若 history 中的文本比本地已有的更长，更新或创建 `tool_result` 消息

### 4.2 MEDIA token 解析（前端）

**文件**: `src/renderer/services/artifactParser.ts`

新增 `parseMediaTokensFromText()` 函数：
- 正则：`/\bMEDIA:\s*`?([^\s`\n]+)`?/gi`
- 提取文件路径，通过 `getArtifactTypeFromExtension()` 判定类型
- 返回 `Artifact[]`，`source: 'tool'`

**文件**: `src/renderer/components/cowork/CoworkSessionDetail.tsx`

在 artifact 检测的 `tool_result` 分支中，调用 `parseMediaTokensFromText()`，与现有的 `parseFilePathsFromText()` 并列，共享去重逻辑。

### 4.3 显示过滤

**文件**: `src/renderer/components/cowork/CoworkSessionDetail.tsx`

在 `normalizeToolResultText()` 中添加 MEDIA token 剥离：
```
result.replace(/\n?MEDIA:\s*`?[^\s`\n]+`?/gi, '').trimEnd()
```

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| MEDIA 路径指向的文件不存在 | artifact 加载失败时标记为已加载，不重试 |
| 单次 turn 返回多张图片 | 每个 MEDIA token 独立生成 artifact，按 filePath 去重 |
| MEDIA 路径指向非图片文件（如 .pdf） | `getArtifactTypeFromExtension()` 自动映射到对应类型 |
| chat.history 请求超时或失败 | catch 后仅 warn 日志，不阻塞主流程 |
| tool result 文本中无 MEDIA token | `parseMediaTokensFromText()` 返回空数组，无副作用 |
| 已有 artifact 路径与 MEDIA 路径重复 | `normalizeFilePathForDedup()` 去重，不会产生重复卡片 |

## 6. 涉及文件

| 文件 | 改动 |
|------|------|
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 回填逻辑、移除后端 MEDIA 处理、清理调试日志、limit 调整 |
| `src/renderer/services/artifactParser.ts` | 新增 `parseMediaTokensFromText()` |
| `src/renderer/components/cowork/CoworkSessionDetail.tsx` | 集成 MEDIA 解析、显示过滤 |

## 7. 验收标准

- [ ] 使用 `image_generate` 工具生成图片时，图片以 ArtifactPreviewCard 展示
- [ ] 点击卡片可在 artifact panel 中预览图片
- [ ] tool result 的 `<pre>` 块中不显示 `MEDIA:...` 原始文本
- [ ] assistant 消息中不再追加 `![](file://...)` markdown 图片
- [ ] 其他工具的 tool result 展示不受影响
- [ ] `npm run lint` 和 TypeScript 编译通过
