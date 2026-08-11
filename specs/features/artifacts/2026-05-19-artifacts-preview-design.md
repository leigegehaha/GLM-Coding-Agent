# Artifacts 预览系统设计文档（2026-05-19）

本文档记录 智码 GLM Code 当前 Artifacts 功能的实现现状，重点覆盖 Cowork 会话中的文件预览、本地 Web 服务预览、浏览器标注和自动刷新链路。旧版设计文档见 `2026-05-07-artifacts-preview-design.md`，本文以当前代码为准。

---

## 1. 功能边界

Artifacts 面板是 Cowork 会话右侧的工作区，用于把会话中出现的文件、媒体、文档和本地服务 URL 转为可预览对象。当前实现不是独立的“代码块 artifact 系统”，而是围绕文件路径、工具写文件结果、`MEDIA:` token 和 localhost URL 做自动发现。

### 1.1 当前能力

| 能力 | 说明 |
|------|------|
| 文件预览 | 支持 HTML、SVG、图片、Markdown、文本、代码、Office/PDF 文档 |
| 本地服务预览 | 自动识别 `localhost` / `127.x.x.x` / `0.0.0.0` / `::1` URL，使用内置 WebView 预览 |
| 多标签 | 右上方标签栏可同时打开文件列表、浏览器和多个 artifact 文件 |
| 文件列表 | 支持按类型排序、分组、搜索和从预览内抽屉切换文件 |
| 自动刷新 | 预览中的本地文件发生变化后，通过主进程 `fs.watch` 触发刷新 |
| 浏览器辅助 | 支持导航、刷新、缩放、设备尺寸模拟、截图复制、元素标注并回填到输入框 |
| 外部打开 | 支持在默认应用、文件夹、系统浏览器中打开可用 artifact |

### 1.2 非当前能力

- 当前代码中没有启用 `parseCodeBlockArtifacts()` 一类的代码块 marker 解析流程。
- `ArtifactMarker` 类型仍存在于 `src/renderer/types/artifact.ts`，但当前主链路未使用。
- React/JSX artifact 没有独立运行时沙箱，`.jsx` / `.tsx` 目前归入 `code` 类型预览。

---

## 2. 核心文件

| 文件 | 职责 |
|------|------|
| `src/renderer/types/artifact.ts` | Artifact 类型、类型枚举和可预览类型集合 |
| `src/renderer/services/artifactParser.ts` | 从消息、工具输入和 URL 中解析 artifact |
| `src/renderer/store/slices/artifactSlice.ts` | artifact 列表、预览标签、面板开关和宽度状态 |
| `src/renderer/components/cowork/CoworkSessionDetail.tsx` | Cowork 中的 artifact 检测、加载、面板挂载和标签栏 |
| `src/renderer/components/artifacts/ArtifactPanel.tsx` | 右侧面板、文件预览、浏览器标签和操作按钮 |
| `src/renderer/components/artifacts/ArtifactRenderer.tsx` | 按 artifact 类型路由到具体渲染器 |
| `src/renderer/components/artifacts/renderers/*` | 各文件类型的具体预览器 |
| `src/main/libs/htmlPreviewServer.ts` | 本地 HTML/PPTX 预览 HTTP server |
| `src/shared/artifactPreview/constants.ts` | artifact preview IPC 和浏览器 partition 常量 |
| `src/shared/localWebServices/constants.ts` | 本地 Web 服务扫描 IPC 与数据结构 |

---

## 3. 类型模型

当前 artifact 类型集中定义在 `ArtifactTypeValue`：

```typescript
export const ArtifactTypeValue = {
  Html: 'html',
  Svg: 'svg',
  Image: 'image',
  Mermaid: 'mermaid',
  Code: 'code',
  Markdown: 'markdown',
  Text: 'text',
  Document: 'document',
  LocalService: 'local-service',
} as const;
```

`Artifact` 对象的关键字段：

| 字段 | 说明 |
|------|------|
| `id` | 前端生成的 artifact ID，按来源带不同前缀 |
| `messageId` | artifact 来源消息 ID |
| `sessionId` | 所属 Cowork 会话 |
| `type` | 渲染类型 |
| `title` | 展示标题 |
| `content` | 文本内容、data URL 或本地服务 URL |
| `fileName` | 文件名 |
| `filePath` | 本地文件路径，读文件和自动刷新依赖它 |
| `url` | 本地服务 artifact 的 URL |
| `createdAt` | 创建时间 |

`PREVIEWABLE_ARTIFACT_TYPES` 包含所有当前类型，包括 `local-service`。但 `local-service` 在文件预览区只显示 URL，实际交互会转到浏览器标签。

---

## 4. Artifact 发现链路

Artifact 发现主要发生在 `CoworkSessionDetail.tsx`，分为会话稳定后的全量检测和流式过程中针对 `MEDIA:` token 的增量检测。

### 4.1 全量检测

当会话消息数量变化且不在 streaming 状态时，前端遍历当前会话消息：

1. Assistant 普通消息：
   - `parseLocalServiceUrlsFromText()` 识别 localhost URL 和 Markdown HTTP 链接。
   - `parseFileLinksFromMessage()` 识别 `[name](file://...)` 文件链接。
   - `stripFileLinksFromText()` 后再用 `parseFilePathsFromText()` 识别裸文件路径。
2. Tool result 消息：
   - `parseMediaTokensFromText()` 只识别显式 `MEDIA: <path>` token。
3. Tool use 消息：
   - `parseToolArtifact()` 识别写文件类工具：`write`、`writefile`、`write_file`。
   - 支持从 `file_path`、`path`、`filePath`、`target_file`、`targetFile` 取文件路径。
   - 工具结果标记 `metadata.isError` 时不生成 artifact。

### 4.2 流式增量检测

Streaming 过程中不会解析普通裸路径，避免 `ls` 等工具输出把大量无关路径变成 artifact。当前只对已 final 的 `tool_result` 解析 `MEDIA:` token，并读取对应文件。

### 4.3 路径解析和读取

文件路径会先做规范化：

- 去掉 `file:///`、`file://`、`file:/` 前缀。
- Windows drive path 去掉前置 `/`，如 `/D:/path` 转为 `D:/path`。
- 相对路径基于 `currentSession.cwd` 解析。

读取文件统一通过 preload 暴露的 `window.electron.dialog.readFileAsDataUrl()`。图片和文档保留 data URL；文本类 artifact 会把 base64 按 UTF-8 解码为字符串。

### 4.4 去重策略

Store 层的 `addArtifact()` 会做两类去重：

| 类型 | 去重 key | 行为 |
|------|----------|------|
| 本地服务 | 规范化 URL | 新 artifact 替换旧 artifact，并把已有预览 tab 指向新 ID |
| 文件 | 规范化 `filePath` | 新 artifact 替换旧 artifact，并保留预览 tab |

URL 规范化会小写 host、去掉路径尾部多余 `/`。文件路径规范化会统一分隔符并小写。

---

## 5. 支持类型和渲染器

| Artifact 类型 | 入口渲染器 | 主要扩展名 / 来源 | 说明 |
|---------------|------------|-------------------|------|
| `html` | `HtmlRenderer` | `.html`, `.htm` | 文件型 HTML 用本地 HTTP server，内联 HTML 用 sandbox iframe |
| `svg` | `SvgRenderer` | `.svg` | DOMPurify 清洗后渲染 |
| `image` | `ImageRenderer` | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` | data URL / 文件读取后展示 |
| `mermaid` | `MermaidRenderer` | `.mermaid`, `.mmd` | Mermaid 动态渲染 SVG |
| `markdown` | `MarkdownRenderer` | `.md` | 使用 `MarkdownContent`，支持相对本地文件链接解析 |
| `text` | `TextRenderer` | `.txt`, `.log` | 行号文本视图；CSV 内容可切换表格视图 |
| `code` | `CodeRenderer` | `.css`, `.jsx`, `.tsx` | 语法高亮；大文件走纯文本 fallback |
| `document` | `DocumentRenderer` | `.docx`, `.xlsx`, `.xls`, `.csv`, `.tsv`, `.pptx`, `.pdf` | 按扩展名分派 Office/PDF 子渲染器 |
| `local-service` | `BrowserTabContent` | localhost URL | 通过浏览器标签预览，不走普通文件渲染 |

---

## 6. 文档预览实现

### 6.1 DOCX

- 使用 `docx-preview` 动态导入。
- `breakPages: true`，渲染 header/footer/footnote/endnote。
- 固定白色文档页背景，外层灰色画布。
- 根据容器宽度用 `ResizeObserver` 调整缩放。

### 6.2 PDF

- 使用 `pdfjs-dist` 动态导入。
- Worker 通过 `new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url)` 配置。
- 每页使用独立 canvas，按容器宽度和 DPR 渲染。
- resize 测量带 200ms debounce，旧 render task 会 cancel。

### 6.3 XLSX / XLS / CSV / TSV

- 入口为 `SheetRenderer`。
- 文件内容通过 data URL 转 `ArrayBuffer`。
- 实际表格解析、虚拟滚动和 fallback 在 `renderers/sheet/` 下实现。

### 6.4 PPTX

PPTX 当前走 `LegacyPptxSubRenderer`：

- 使用 `pptx-preview` 动态导入。
- 渲染前通过 `fixPptxData()` 修复部分兼容性问题：
  - 重新用 DEFLATE 打包。
  - 移除指向缺失文件的 `[Content_Types].xml` override。
  - 将非标准媒体文件名复制为 `ppt/media/image*`，并补充 content type。
  - 为背景图片生成普通图片 fallback，提升 `pptx-preview` 可见性。
- iframe 内同时渲染缩略图和主幻灯片。
- 渲染失败时依次 fallback 到同目录 `slides/slideN.html`，再 fallback 到 PPTX XML 文本提取。

主进程中还保留 `createOfficePreviewSession()`，可为 PPTX 创建本地 HTTP 预览页，但当前 `PptxSubRenderer` 未直接使用它。

---

## 7. HTML 和本地文件预览服务

文件型 HTML 不直接用 `file://`，而是通过 `src/main/libs/htmlPreviewServer.ts` 启动本地 HTTP server：

1. `HtmlRenderer` 调用 `window.electron.artifact.createPreviewSession(filePath)`。
2. 主进程创建随机 `sessionId` 和 `token`。
3. server 仅绑定 `127.0.0.1`，URL 形如 `http://127.0.0.1:<port>/<sessionId>/<fileName>?token=<token>`。
4. 资源请求必须携带 token，且路径必须位于 session root 目录下，防止目录穿越。
5. iframe 指向该 URL，以支持 HTML 相对资源、CSS、JS、图片等。
6. 组件卸载时调用 `destroyPreviewSession()` 清理 session。

内联 HTML 仍使用 `srcDoc` + `sandbox="allow-scripts"`。渲染前会注入 hash anchor 点击拦截脚本，使页面内 `#id` 跳转在 sandbox iframe 内工作。

---

## 8. 右侧面板和标签系统

### 8.1 Redux 状态

`artifactSlice` 维护：

| 字段 | 说明 |
|------|------|
| `artifactsBySession` | 每个会话的 artifact 列表 |
| `previewTabsBySession` | 每个会话打开的 artifact 预览标签 |
| `activePreviewTabIdBySession` | 每个会话当前激活的 artifact 标签 |
| `panelOpenBySession` | 每个会话面板开关状态 |
| `selectedArtifactId` | 当前选中的 artifact |
| `panelWidth` | 面板宽度，默认 560，范围 180 到 1000 |

### 8.2 特殊标签

除普通 artifact 文件标签外，UI 还有两个特殊标签：

| 标签 | 状态来源 | 用途 |
|------|----------|------|
| `fileList` | CoworkSessionDetail 本地 state + Redux 激活动作 | 展示当前会话所有可预览 artifact |
| `browser` | CoworkSessionDetail 本地 state + Redux 激活动作 | 运行内置浏览器预览本地服务或任意 URL |

特殊标签的开关、激活和地址状态以 session 为 key 保存在 `CoworkSessionDetail` 的 refs 中，切换会话时恢复。

### 8.3 面板布局

右侧面板挂在 Cowork 内容区右侧，包含 1px 拖拽手柄和固定宽度 aside：

- 拖动手柄向左扩大、向右缩小。
- 宽度由 `CoworkSessionDetail` 根据内容区宽度动态计算最小/最大值。
- 拖到最小宽度以下 48px 会关闭面板。
- 面板开关有 200ms 宽度和透明度过渡。

### 8.4 文件列表

`FileDirectoryView` 提供：

- 文件名搜索。
- 按类型排序和分组。
- 展示文件短路径。
- 预览内部可从右侧抽屉快速切换文件。

---

## 9. 浏览器标签

浏览器标签由 `BrowserTabContent` 实现，底层使用 Electron `<webview>`。

### 9.1 导航

地址输入规则：

| 输入 | 结果 |
|------|------|
| `http://` / `https://` / `file://` | 原样加载 |
| `localhost:5173` / `127.0.0.1:3000` | 自动补 `http://` |
| `example.com` | 自动补 `https://` |
| 普通文本 | 转为 Google 搜索 URL |

浏览器支持后退、前进、刷新/停止、外部浏览器打开。

### 9.2 本地服务发现

当浏览器标签为空页时，会展示本地服务列表：

- 主进程扫描常用端口：`3000-3010`、`3333`、`4000`、`4173`、`5000`、`5173-5180`、`8000`、`8080`、`8081`、`8888`。
- 每个端口用 `session.defaultSession.fetch()` 请求 `http://localhost:<port>/`。
- 只保留 `content-type` 包含 `text/html` 的响应。
- 标题从 `<title>` 提取，最长 80 字符。
- 浏览器标签还会合并当前会话内识别到的 local-service artifact，并把这些端口作为 preferred ports 优先扫描。
- 展示最多 10 个服务。

### 9.3 浏览器数据隔离

WebView 使用固定 partition：

```typescript
persist:lobster-artifact-browser
```

主进程在 `will-attach-webview` 中强制：

- `nodeIntegration = false`
- `contextIsolation = true`
- `sandbox = true`
- `webSecurity = true`
- 禁用 preload、plugins、popups
- 阻止 `javascript:` src

用户可从浏览器菜单清理该 partition 的 cookies 和 cache。

### 9.4 设备尺寸和缩放

浏览器菜单可打开设备工具栏：

- 预设包含 Responsive、4K、Laptop、iPad、Surface Duo、iPhone、Pixel、Samsung 等。
- 宽高可手动输入，范围 50 到 9999。
- 设备 scale 支持 `25%` 到 `200%`。
- 浏览器 zoom 独立支持 `25%` 到 `300%`。

### 9.5 截图和标注

浏览器标签支持两类反馈：

| 功能 | 行为 |
|------|------|
| 截图 | 调用 `webview.capturePage()`，通过主进程 clipboard IPC 写入剪贴板 |
| 标注 | 向页面注入临时脚本，悬停高亮元素，点击后填写注释，再截图并回填到 Cowork 输入框 |

标注回填内容包括：

- 截图 data URL，作为 inline image attachment。
- 页面 URL 和标题。
- 被标注区域的矩形坐标、尺寸、颜色。
- 被标注元素的 tag、文本摘要、字体、宽高。
- 用户输入的注释文本。

---

## 10. 自动刷新

当选中的 artifact 有 `filePath` 时，`ArtifactPanel` 会调用：

- `window.electron.artifact.watchFile(filePath)`
- `window.electron.artifact.onFileChanged(callback)`
- 卸载或切换时调用 `unwatchFile(filePath)`

主进程使用 `fs.watch()` 监听文件变化，只处理 `change` 事件，并做 300ms debounce。变化事件通过 `artifact:file:changed` 广播到所有窗口。Renderer 收到与当前 watched path 匹配的事件后重新读取文件内容并更新 store。

HTML 文件型预览收到 content 版本变化后会 reload iframe；其他渲染器依赖 artifact content 更新后重新渲染。

---

## 11. 安全边界

| 场景 | 安全措施 |
|------|----------|
| 主应用窗口 | `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true` |
| 内联 HTML | iframe `sandbox="allow-scripts"`，没有 `allow-same-origin` |
| 文件型 HTML | 本地 HTTP server 绑定 `127.0.0.1`，session token 校验，rootDir path traversal 防护 |
| WebView 浏览器 | 固定 partition，禁用 node/preload/plugins/popups，阻止 `javascript:` src |
| SVG | DOMPurify 清洗 |
| PPTX iframe | sandbox iframe 中运行 `pptx-preview` |
| CSP | artifact sandbox 和本地预览 server 在主进程响应头逻辑中有专门豁免 |

---

## 12. 当前技术债和注意事项

1. `artifact:watchFile`、`artifact:unwatchFile`、`artifact:file:changed` 仍是裸字符串 IPC，未迁移到 `ArtifactPreviewIpc` 常量。
2. `ArtifactMarker` 类型和旧设计中的代码块 artifact marker 逻辑不一致，需要确认是保留未来能力还是删除。
3. `createOfficePreviewSession()` 目前没有被 PPTX 主渲染路径使用，属于保留能力。
4. `local-service` 在 `ArtifactRenderer` 中只是 URL 占位显示，真实打开逻辑分散在 `ArtifactPreviewCard`、`ArtifactPanel` 和 `CoworkSessionDetail`。
5. 本地服务扫描只请求 `localhost`，对 `127.0.0.1` / `0.0.0.0` / `::1` URL 的 artifact 发现能识别，但主动扫描不会逐 host 扫描。
6. 文本 CSV 表格视图是轻量 split 实现，不处理带引号逗号、转义换行等完整 CSV 语义；文档类 `.csv` / `.tsv` 由 Sheet renderer 处理。

---

## 13. 建议验证清单

修改 artifacts 功能后建议至少验证：

1. Assistant 消息中出现 `http://localhost:5173` 后，消息卡片生成 local-service artifact，点击能打开浏览器标签。
2. Assistant 消息中出现 `[report](file:///.../report.pdf)` 后，文件列表出现 PDF，预览能渲染并能在文件夹中显示。
3. 写文件工具生成 `.html` 后，右侧打开 HTML，页面相对 CSS/JS/图片能通过本地 server 加载。
4. 修改当前预览文件后，右侧内容能在 300ms debounce 后刷新。
5. 浏览器标签能截图复制，标注后能把图片附件和注释文本插入输入框。
6. `npm run lint` 保持通过；涉及 parser 时补充或更新 `src/renderer/services/artifactParser.test.ts`。
