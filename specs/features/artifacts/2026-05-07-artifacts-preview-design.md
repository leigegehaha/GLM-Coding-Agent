# Artifact 预览系统设计文档（2026-05-07）

本文档描述 智码 GLM Code 的 Artifact 预览系统设计，包括文件类型检测、渲染架构、状态管理和各格式的渲染策略。

---

## 1. 概述

### 1.1 目标

在 Cowork 对话中，AI 产出的代码、文档、图表等内容能够以可视化形式实时预览，无需用户离开应用打开外部工具。

### 1.2 设计原则

| 原则 | 说明 |
|------|------|
| **纯前端渲染** | 所有预览在 Renderer 进程完成，不依赖后端服务或 native 库 |
| **懒加载** | 重型渲染库（PDF.js、xlsx、pptx-preview）通过动态 `import()` 按需加载 |
| **安全隔离** | HTML/SVG 通过 DOMPurify 清洗或 iframe sandbox 隔离 |
| **不跟随主题** | Office 文件（docx/xlsx/pptx/pdf）预览固定白色背景，不跟随系统 dark mode |

### 1.3 支持的文件类型

| 渲染器 | 扩展名 | 渲染库 |
|--------|--------|--------|
| HtmlRenderer | `.html`, `.htm` | iframe sandbox |
| SvgRenderer | `.svg` | DOMPurify + 缩放 |
| ImageRenderer | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` | 原生 img + 缩放 |
| MermaidRenderer | `.mermaid`, `.mmd` | mermaid.js |
| MarkdownRenderer | `.md` | react-markdown |
| TextRenderer | `.txt`, `.log` | 行号显示 |
| CodeRenderer | `.css`, `.jsx`, `.tsx` | react-syntax-highlighter |
| DocumentRenderer (DOCX) | `.docx` | docx-preview |
| DocumentRenderer (XLSX) | `.xlsx`, `.xls`, `.csv`, `.tsv` | xlsx + @tanstack/react-virtual |
| DocumentRenderer (PPTX) | `.pptx` | pptx-preview |
| DocumentRenderer (PDF) | `.pdf` | pdfjs-dist v4 |

---

## 2. 架构

### 2.1 数据流

```
消息内容
  │
  ├─ parseCodeBlockArtifacts()    ← 代码块标记检测
  ├─ parseFilePathsFromText()     ← 裸文件路径检测
  ├─ parseFileLinksFromMessage()  ← Markdown 文件链接检测
  └─ parseToolArtifact()          ← 工具输出检测
  │
  ▼
Artifact 对象（type, content, filePath, fileName）
  │
  ▼
Redux Store (artifactSlice)
  │
  ▼
ArtifactPanel → ArtifactRenderer → 具体渲染器组件
```

### 2.2 类型系统

```typescript
// src/renderer/types/artifact.ts
type ArtifactType = 'html' | 'svg' | 'image' | 'mermaid' | 'code' | 'markdown' | 'text' | 'document';
type ArtifactSource = 'codeblock' | 'tool';

interface Artifact {
  id: string;
  messageId: string;
  sessionId: string;
  type: ArtifactType;
  title: string;
  content: string;       // 内嵌内容（data URL 或文本）
  language?: string;     // 代码语言标识
  fileName?: string;     // 文件名
  filePath?: string;     // 本地文件路径
  source: ArtifactSource;
  createdAt: number;
}
```

### 2.3 状态管理

```typescript
// src/renderer/store/slices/artifactSlice.ts
interface ArtifactState {
  artifactsBySession: Record<string, Artifact[]>;  // sessionId → artifacts
  selectedArtifactId: string | null;
  isPanelOpen: boolean;
  activeTab: 'preview' | 'code';
  panelView: 'files' | 'preview';
  panelWidth: number;    // MIN=420, DEFAULT=560, MAX=1000
}
```

### 2.4 文件结构

```
src/renderer/
├── types/artifact.ts              # 类型定义
├── store/slices/artifactSlice.ts  # Redux 状态
├── services/artifactParser.ts     # 检测与解析
└── components/artifacts/
    ├── ArtifactPanel.tsx           # 面板容器（文件列表 + 预览区）
    ├── ArtifactRenderer.tsx        # 类型路由
    ├── ArtifactBadge.tsx           # 消息中的 artifact 标记
    ├── ArtifactPreviewCard.tsx     # 缩略预览卡片
    ├── FileDirectoryView.tsx       # 文件列表侧栏
    └── renderers/
        ├── HtmlRenderer.tsx
        ├── SvgRenderer.tsx
        ├── ImageRenderer.tsx
        ├── MermaidRenderer.tsx
        ├── MarkdownRenderer.tsx
        ├── TextRenderer.tsx
        ├── CodeRenderer.tsx
        └── DocumentRenderer.tsx    # DOCX/XLSX/PPTX/PDF 统一入口
```

---

## 3. Artifact 检测

### 3.1 检测方式

| 方式 | 触发条件 | 示例 |
|------|----------|------|
| 代码块标记 | `` ```artifact:html title="My Page" `` | 显式声明 |
| 语言推断 | `` ```html `` / `` ```mermaid `` | 根据语言映射 |
| 文件路径 | 消息中出现 `/path/to/file.docx` | 正则匹配 |
| Markdown 链接 | `[文件名](file:///path/to/file.pdf)` | 链接解析 |
| 工具输出 | Write/WriteFile 工具结果 | 工具类型判断 |

### 3.2 类型映射

**语言 → 类型**：`html`→html, `svg`→svg, `mermaid`→mermaid, `jsx`/`tsx`→code, `md`→markdown

**扩展名 → 类型**：`.docx`/`.xlsx`/`.pptx`/`.pdf`/`.csv`/`.tsv`/`.xls`→document, `.png`/`.jpg`/`.gif`/`.webp`→image

### 3.3 二进制文件检测

`BINARY_DOCUMENT_EXTENSIONS = ['.docx', '.xlsx', '.pptx', '.pdf']`

二进制文件通过 Electron IPC `readFileAsDataUrl` 读取为 base64 data URL，再转换为 ArrayBuffer 供渲染库使用。

---

## 4. 文档渲染器详细设计

### 4.1 DOCX — docx-preview

| 项目 | 值 |
|------|-----|
| 库 | `docx-preview` ^0.3.7 |
| 原理 | JSZip 解压 → 解析 WordprocessingML → DOM 渲染 |
| 分页 | 仅支持显式分页符（`breakPages: true`），不支持内容溢出自动分页 |
| 自适应 | ResizeObserver + CSS zoom 缩放至容器宽度 |
| 样式 | 每个 `<section class="docx-preview">` 独立白色背景 + 阴影 |

**已知限制**：`docx-preview` 没有完整排版引擎，不能根据内容高度自动分页。文档中没有显式 `<w:br w:type="page"/>` 时，内容连续显示。

### 4.2 XLSX — xlsx + @tanstack/react-virtual

| 项目 | 值 |
|------|-----|
| 库 | `xlsx` ^0.18.5 + `@tanstack/react-virtual` |
| 原理 | SheetJS 解析 OOXML → 虚拟滚动表格渲染 |
| 行数 | 无限制（虚拟滚动） |
| 样式 | 支持单元格背景色、字体颜色、加粗 |
| 合并单元格 | 支持（`colSpan` + `hidden` 机制） |
| 多 Sheet | Tab 切换 |
| CSV/TSV | 自动检测并转为 xlsx 格式渲染 |

**列宽计算**：`COL_WIDTH = max(100, min(200, floor(800 / colCount)))`，header 和 body 共用固定列宽确保对齐。

### 4.3 PPTX — pptx-preview + 三级 fallback

| 项目 | 值 |
|------|-----|
| 库 | `pptx-preview` ^1.0.7 |
| 渲染方式 | offscreen DOM → innerHTML 注入 iframe |
| 自适应 | ResizeObserver + CSS zoom |
| Fallback 链 | Canvas → HTML slide 文件 → XML 文本提取 |

**文件修复**：使用 JSZip 重新打包 PPTX（修复 DEFLATE 压缩和无效 Content_Types.xml），解决 PptxGenJS 生成的文件兼容性问题。

### 4.4 PDF — pdfjs-dist v4

| 项目 | 值 |
|------|-----|
| 库 | `pdfjs-dist` ^4.10.38 |
| 渲染方式 | 每页独立 Canvas + HiDPI 缩放 |
| Worker | `pdf.worker.mjs`（Vite `new URL()` 模式加载） |
| 自适应 | ResizeObserver + debounce(200ms, 5px 阈值) |
| 并发控制 | `renderTask.cancel()` 取消旧渲染，`ctx.setTransform()` 防止变换累积 |

**版本选择**：v5.x 使用了 `Map.prototype.getOrInsertComputed`（ES 提案阶段），Electron 的 Chromium 不支持。降级到 v4.x 确保兼容。

---

## 5. 面板 UI

### 5.1 布局

```
┌─────────────────────────────────────────────────┐
│ [拖拽手柄] │ 文件列表(180px) │ 预览区(flex-1) │
│             │                  │               │
│  ← 可拖拽 → │ FileDirectoryView│  Header       │
│             │                  │  (文件名+操作) │
│             │  - 文件1 ✓       │               │
│             │  - 文件2         │  Content      │
│             │  - 文件3         │  (渲染器)     │
│             │                  │               │
└─────────────────────────────────────────────────┘
```

### 5.2 面板宽度

- 最小：420px
- 默认：560px
- 最大：1000px（或 `window.innerWidth - 480px`，取较小值）

### 5.3 操作按钮

| 按钮 | 条件 | 行为 |
|------|------|------|
| 复制 | 有 content | 复制到剪贴板 |
| 在浏览器打开 | html/svg/mermaid | 生成 HTML 打开 |
| 用默认应用打开 | document 类型 | `shell.openPath()` |
| 在 Finder 中显示 | 有 filePath | `shell.showItemInFolder()` |
| 关闭 | 始终 | 关闭面板 |

### 5.4 Tab 切换

- **Preview**：可视化预览（对 PREVIEWABLE_ARTIFACT_TYPES）
- **Code**：原始内容语法高亮显示

---

## 6. 安全策略

| 类型 | 措施 |
|------|------|
| HTML | `sandbox="allow-scripts"` 或 `sandbox="allow-scripts allow-same-origin"`（仅本地文件） |
| SVG | DOMPurify 移除所有 script 内容 |
| Mermaid | `securityLevel: 'strict'` |
| Office/PDF | 纯 Canvas/DOM 渲染，无脚本执行 |

---

## 7. 依赖清单

| 包名 | 版本 | 用途 | 加载方式 |
|------|------|------|----------|
| `docx-preview` | ^0.3.7 | DOCX 高保真渲染 | 动态 import |
| `xlsx` | ^0.18.5 | Excel/CSV 解析 | 动态 import |
| `pptx-preview` | ^1.0.7 | PPT 渲染 | 动态 import |
| `pdfjs-dist` | ^4.10.38 | PDF Canvas 渲染 | 动态 import |
| `@tanstack/react-virtual` | latest | XLSX 虚拟滚动 | 静态 import |
| `dompurify` | ^3.3.1 | SVG/HTML 清洗 | 静态 import |
| `mermaid` | ^10.9.5 | 图表渲染 | 动态 import |
| `react-markdown` | ^10.0.0 | Markdown 渲染 | 静态 import |
| `react-syntax-highlighter` | ^15.6.1 | 代码高亮 | 静态 import |
| `jszip` | (pptx-preview 依赖) | PPTX 修复 | 动态 import |

---

## 8. 文件清单

| 文件 | 职责 |
|------|------|
| `src/renderer/types/artifact.ts` | ArtifactType、Artifact 接口定义 |
| `src/renderer/services/artifactParser.ts` | 检测、解析、类型映射 |
| `src/renderer/store/slices/artifactSlice.ts` | Redux 状态管理 |
| `src/renderer/components/artifacts/ArtifactPanel.tsx` | 面板容器 |
| `src/renderer/components/artifacts/ArtifactRenderer.tsx` | 类型路由 |
| `src/renderer/components/artifacts/ArtifactBadge.tsx` | 消息标记 |
| `src/renderer/components/artifacts/ArtifactPreviewCard.tsx` | 缩略卡片 |
| `src/renderer/components/artifacts/FileDirectoryView.tsx` | 文件列表 |
| `src/renderer/components/artifacts/renderers/DocumentRenderer.tsx` | Office+PDF 渲染 |
| `src/renderer/components/artifacts/renderers/HtmlRenderer.tsx` | HTML 渲染 |
| `src/renderer/components/artifacts/renderers/SvgRenderer.tsx` | SVG 渲染 |
| `src/renderer/components/artifacts/renderers/ImageRenderer.tsx` | 图片渲染 |
| `src/renderer/components/artifacts/renderers/MermaidRenderer.tsx` | Mermaid 渲染 |
| `src/renderer/components/artifacts/renderers/MarkdownRenderer.tsx` | Markdown 渲染 |
| `src/renderer/components/artifacts/renderers/TextRenderer.tsx` | 文本渲染 |
| `src/renderer/components/artifacts/renderers/CodeRenderer.tsx` | 代码渲染 |
| `src/renderer/services/i18n.ts` | 国际化文本 |
