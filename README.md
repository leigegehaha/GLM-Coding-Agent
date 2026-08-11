<p align="center">
  <img src="public/logo.png" alt="智码 GLM Code" width="112">
</p>

<h1 align="center">智码 GLM Code</h1>

<p align="center">
  <strong>给它一句需求，还你一份能跑的代码。</strong><br>
  一款真正进入本地项目的开源桌面编程 Agent：读代码、调工具、跑命令、做验证，
  从理解需求一路干到交付。
</p>

<p align="center">
  <a href="https://github.com/leigegehaha/GLM-Coding-Agent/releases/latest"><img src="https://img.shields.io/github/v/release/leigegehaha/GLM-Coding-Agent?style=flat-square&label=release&color=1677ff" alt="最新版本"></a>
  <a href="https://github.com/leigegehaha/GLM-Coding-Agent/releases"><img src="https://img.shields.io/github/downloads/leigegehaha/GLM-Coding-Agent/total?style=flat-square&label=downloads&color=22a06b" alt="下载量"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8a63d2?style=flat-square" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/macOS-Apple_Silicon-111111?style=flat-square&logo=apple" alt="macOS Apple Silicon">
  <img src="https://img.shields.io/badge/Windows-x64-0078d4?style=flat-square&logo=windows11" alt="Windows x64">
</p>

<p align="center">
  简体中文 · <a href="README_EN.md">English</a> ·
  <a href="https://glmcoding.cn/">官网</a> ·
  <a href="https://github.com/leigegehaha/GLM-Coding-Agent/releases/latest">下载</a> ·
  <a href="https://github.com/leigegehaha/GLM-Coding-Agent/issues">反馈</a>
</p>

---

智码 GLM Code 不是又一个套壳聊天框。它能进入真实工作区，理解已有代码，修改文件，
执行终端命令，驱动浏览器流程，并对自己的改动做验证。编程增强默认开启；遇到调研、
文档、自动化等日常任务，也可以一键切回通用 Agent。

## 快捷入口

| 想做什么             | 入口                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 下载最新版           | [GitHub Releases](https://github.com/leigegehaha/GLM-Coding-Agent/releases/latest)                                                                             |
| 使用智码 Coding Plan | [产品首页](https://glmcoding.cn/) · [注册账号](https://glmcoding.cn/register) · [登录](https://glmcoding.cn/login) · [查看套餐](https://glmcoding.cn/#pricing) |
| 使用企业 Token 服务  | [GLM Claude 企业级 Token 服务](https://glmclaude.com/)                                                                                                         |
| 获取更多技能         | [ClawHub](https://clawhub.ai/) · [查看内置技能](SKILLs/)                                                                                                       |
| 参与开源             | [提交 Issue](https://github.com/leigegehaha/GLM-Coding-Agent/issues) · [贡献指南](AGENTS.md) · [MIT License](LICENSE)                                          |

## 模型服务推荐

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>个人编程：智码 Coding Plan</strong><br><br>
      面向个人开发者和独立创作者，提供按 API 调用次数或 Token 计费的灵活方案，价格划算，
      适合日常写代码、修 Bug、重构、测试和个人项目。登录桌面端后可以查看套餐与配额，
      并一键完成 API Key 和默认模型配置。<br><br>
      <a href="https://glmcoding.cn/"><strong>了解 Coding Plan →</strong></a> ·
      <a href="https://glmcoding.cn/register">注册账号</a>
    </td>
    <td width="50%" valign="top">
      <strong>团队与企业：高 TPM Token 服务</strong><br><br>
      面向高并发 Coding 任务、团队 Agent 和企业工作负载，提供高 TPM 与企业节点部署。
      国产模型价格约为常规价格的 1.5 折至 5 折，国外模型约为 0.1 折至 2 折，
      适合对吞吐、稳定性和成本都有要求的场景。<br><br>
      <a href="https://glmclaude.com/"><strong>访问 GLM Claude →</strong></a>
    </td>
  </tr>
</table>

> 模型范围、节点、TPM、折扣、计费方式和可用性可能随服务调整，请以对应官网的实时信息为准。

## 下载

当前公开版本为 **v2026.7.31**，完整更新说明见
[Release 页面](https://github.com/leigegehaha/GLM-Coding-Agent/releases/tag/v2026.7.31)。

| 平台    | 安装包                      | 下载                                                                                                                                      |
| ------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | Apple Silicon（arm64），DMG | [下载 macOS 版](https://github.com/leigegehaha/GLM-Coding-Agent/releases/download/v2026.7.31/GLMCode-darwin-arm64-2026.7.31-official.dmg) |
| Windows | Windows 10/11 x64，安装程序 | [下载 Windows 版](https://github.com/leigegehaha/GLM-Coding-Agent/releases/download/v2026.7.31/GLMCode-Setup-x64-2026.7.31-official.exe)  |

> 当前安装包为未签名预览版。macOS 可能要求在“隐私与安全性”中确认打开，Windows
> 可能显示 SmartScreen 提示。安装前可在 Release 页面核对校验值。Linux 用户可从源码构建。

## 三步开始

1. **安装桌面端**：从最新 Release 下载对应系统的安装包。
2. **连接模型**：登录智码 Coding Plan，或添加自己的模型渠道和 API Key。
3. **选择项目目录**：告诉 Agent 你想得到什么结果，编程增强会自动开启。

普通调研、写作或办公任务，可以随时在聊天输入区关闭编程增强。注册和购买套餐会跳转
至 [glmcoding.cn](https://glmcoding.cn/)；已有套餐可在软件的 **设置 → 套餐管理** 中查看
与一键配置。

## 核心能力

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>不是陪聊，是真进代码库</strong><br><br>
      选择一个本地项目，Agent 就能检索和编辑文件、执行命令、调用工具、验证结果，
      全程实时展示进度与工具调用。
    </td>
    <td width="50%" valign="top">
      <strong>编程增强，默认满电</strong><br><br>
      升级后的工程提示词配合内置工作流，覆盖代码库理解、方案规划、功能实现、系统调试、
      安全重构、代码审查、测试验证和 PR 交付。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>思考不靠玄学，强度由你调</strong><br><br>
      在聊天输入区直接切换思考模式和强度。内置 GLM-5.2、Claude Opus、Kimi K3、
      DeepSeek V4 及兼容推理模型的差异化档位。
    </td>
    <td width="50%" valign="top">
      <strong>智码 Coding Plan，一键上车</strong><br><br>
      使用 <a href="https://glmcoding.cn/">glmcoding.cn</a> 账户登录，在软件内查看套餐、
      配额、重置周期和 API Key，一键接入软件，并默认选择 GLM-5.2。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>技能会生长，能力不封顶</strong><br><br>
      除了内置技能，还能从智码精选和 <a href="https://clawhub.ai/">ClawHub</a> 发现更多能力。
      支持远程搜索、分页加载、刷新缓存、GitHub/ClawHub 导入、一键安装与技能安全检查。
    </td>
    <td width="50%" valign="top">
      <strong>模型自由，不锁生态</strong><br><br>
      可使用智码 Coding Plan，也可自带 API Key，接入 OpenAI、Anthropic 及 OpenAI
      兼容协议。预置 GLM、DeepSeek、Kimi、Qwen、Gemini、Ollama 等渠道。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>写代码之外，也能把活干完</strong><br><br>
      支持浏览器自动化、联网调研、MCP、语音输入，以及 HTML、SVG、Mermaid、图片、
      视频、Markdown、PDF、Word、Excel、PowerPoint 等丰富预览。
    </td>
    <td width="50%" valign="top">
      <strong>让 Agent 持续工作，而不是用完即走</strong><br><br>
      创建专属 Agent、调度子 Agent、沉淀长期记忆、运行定时任务，还可接入微信、企微、
      钉钉、飞书、QQ、Telegram、Discord、邮件等消息渠道。
    </td>
  </tr>
</table>

## 功能全景

| 模块         | 当前能力                                                                              |
| ------------ | ------------------------------------------------------------------------------------- |
| 编程工作区   | 本地目录选择、文件 CRUD、全文检索、终端执行、改动验证、长任务流式反馈                 |
| 会话与上下文 | 会话历史、搜索、上下文用量、压缩、分支会话、附件、图片输入与中途停止                  |
| 编程增强     | 默认开启工程系统提示词；可按会话切换回通用 Agent 模式                                 |
| 思考模式     | 按模型展示可用档位，支持关闭、低、中、高、超高、自适应或 Max 等配置                   |
| 模型接入     | 智码 Coding Plan、自定义 API Key、OpenAI/Anthropic 兼容协议与 Ollama 本地模型         |
| Skills       | 内置编程和办公技能、智码精选、ClawHub 远程搜索与分页、GitHub/URL/本地导入、升级与审计 |
| MCP 与插件   | MCP 市场、JSON 批量导入、npm/npx/HTTP 服务，以及 OpenClaw 插件安装、配置和更新        |
| Agent 与记忆 | 自定义 Agent、模型和技能绑定、子 Agent、长期记忆、语义检索与记忆条目管理              |
| 自动化       | Cron/定时任务、任务模板、运行历史、后台心跳与持续关注                                 |
| 消息渠道     | 微信、企微、钉钉、飞书/Lark、QQ、Telegram、Discord、NIM、POPO 与邮件                  |
| 产物与预览   | HTML、React、SVG、Mermaid、Markdown、代码、图片、视频、PDF 与 Office 文档             |
| 数据与体验   | 本地 SQLite、备份恢复、诊断日志、自动更新、中英文界面、浅色/深色主题与自定义皮肤      |

## 内置编程技能链

编程增强不是一句“请认真写代码”的提示词，而是一组可以被 Agent 主动路由的工程技能：

| 阶段     | 技能                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------ |
| 读懂项目 | [代码库导览](SKILLs/codebase-onboarding/) · [制定计划](SKILLs/create-plan/)                                              |
| 开始实现 | [功能实现](SKILLs/implement-feature/) · [前端设计](SKILLs/frontend-design/)                                              |
| 定位问题 | [系统化调试](SKILLs/systematic-debugging/) · [Playwright 验证](SKILLs/playwright/)                                       |
| 控制质量 | [安全重构](SKILLs/safe-refactoring/) · [代码审查](SKILLs/code-review/) · [测试验证](SKILLs/test-and-verify/)             |
| 完成交付 | [Git/PR 工作流](SKILLs/git-pr-workflow/) · [工程复盘](SKILLs/engineering-retrospective/)                                 |
| 持续进化 | [编程记忆整理](SKILLs/coding-memory-curator/) · [技能安全审查](SKILLs/skill-vetter/) · [创建技能](SKILLs/skill-creator/) |

## 可以这样使用

```text
先通读这个仓库，告诉我它的启动链路、核心模块和最容易踩坑的地方。
```

```text
复现这个登录问题，找到根因，补回归测试，修好后跑完整验证。
```

```text
把这份需求实现成可发布功能。先给计划，完成后提供变更摘要和验证证据。
```

```text
每天早上 9 点检查项目 Issue，把高优先级问题整理成一份中文简报。
```

## 模型与服务

- [智码 Coding Plan](https://glmcoding.cn/) 是面向个人编程用户的可选在线模型套餐。桌面端可用邮箱和密码
  登录、查看调用量和周期配额，并把对应 API Key 一键配置到软件。
- [GLM Claude](https://glmclaude.com/) 提供面向团队和企业高并发 Coding 任务的高 TPM
  Token 服务与企业节点方案。
- 不使用智码套餐也可以自带密钥。渠道定义集中在
  [`src/shared/providers/`](src/shared/providers/)，支持多个国内外模型服务。
- 支持思考的模型会在聊天区显示思考强度控件；实际可用档位取决于模型和服务商协议。
- Agent Runtime 基于 [OpenClaw](https://github.com/openclaw/openclaw)，当前固定版本记录在
  [`package.json`](package.json) 中，由构建脚本自动准备和打包。

## 为真实工作而生

- **本地优先**：会话、Agent、设置和任务元数据保存在本地 SQLite，支持备份与恢复。
- **套餐密钥安全存储**：托管的 Coding Plan API 凭证使用操作系统加密存储，不写入源码仓库。
- **敏感操作可确认**：工具执行支持权限确认，让最终决定权留在用户手里。
- **统计默认关闭**：只有用户明确开启后才会发送使用统计。
- **开放运行时**：桌面端基于 Electron、React 与 OpenClaw Agent Runtime 构建，
  使用清晰的 IPC 边界和随应用打包的 Gateway。

### 安全边界

Electron 渲染进程启用了进程隔离与沙箱，但 Agent 的文件操作和终端命令会以当前系统用户
权限在本机执行，**它不是隔离的代码执行沙箱**。建议使用明确的工作目录，认真查看权限
确认，不要在不了解风险时运行不可信提示词或陌生仓库。

模型请求会发送到你所配置的模型服务商。智码账户与 Coding Plan 功能会访问
`glmcoding.cn`；不使用智码套餐时，也可以通过兼容模型渠道使用开源桌面端。

## 本地开发

环境要求：Node.js `>=24.15.0 <25`、npm、Git；首次构建 OpenClaw Runtime 还需要
Corepack/pnpm 和网络连接。

```bash
git clone https://github.com/leigegehaha/GLM-Coding-Agent.git glm-code
cd glm-code
npm ci
npm run electron:dev:openclaw
```

Runtime 准备完成后，日常开发可直接运行 `npm run electron:dev`。

```bash
npm test                  # 运行 Vitest 测试
npm run build             # 构建 Renderer
npm run compile:electron  # 检查并编译 Electron Main/Preload
npm run dist:mac          # 打包 macOS
npm run dist:win          # 打包 Windows
npm run dist:linux        # 打包 Linux
```

## 项目地图

| 路径                                           | 职责                                                           |
| ---------------------------------------------- | -------------------------------------------------------------- |
| [`src/main/`](src/main/)                       | Electron 生命周期、SQLite、凭证、OpenClaw、IPC、IM、MCP 与更新 |
| [`src/renderer/`](src/renderer/)               | React 界面、Redux 状态、会话、Agent、设置与 Artifacts          |
| [`src/shared/`](src/shared/)                   | 跨进程类型、常量、协议与模型渠道定义                           |
| [`SKILLs/`](SKILLs/)                           | 内置编程、效率、文档、浏览器与记忆技能                         |
| [`openclaw-extensions/`](openclaw-extensions/) | 智码专用 OpenClaw 扩展                                         |
| [`scripts/`](scripts/)                         | Runtime 准备、质量验证与跨平台打包                             |

## 开源与反馈

- 服务：[个人 Coding Plan](https://glmcoding.cn/) · [注册](https://glmcoding.cn/register) ·
  [企业 Token 服务](https://glmclaude.com/)
- 项目：[GitHub 仓库](https://github.com/leigegehaha/GLM-Coding-Agent) ·
  [Releases](https://github.com/leigegehaha/GLM-Coding-Agent/releases) ·
  [Issues](https://github.com/leigegehaha/GLM-Coding-Agent/issues)
- 开发：[贡献指南](AGENTS.md) · [内置 Skills](SKILLs/) · [版权与来源](NOTICE.md) ·
  [MIT License](LICENSE)

欢迎提交范围清晰的 Issue 和 Pull Request。涉及界面调整时，请附验证步骤和前后截图；
涉及 Electron、IPC、存储或运行时行为时，请明确说明影响范围和验证平台。

## 开源协议

智码 GLM Code 由智码 GLM 科技维护，采用 [MIT License](LICENSE) 开源。你可以自由使用、
复制、修改、合并、发布和分发，但需保留许可证及版权声明。

本项目基于 NetEase Youdao 开源的 LobsterAI 修改和再开发，原项目同样采用 MIT License。
依照许可证要求，原版权声明继续保留。详细归属见 [NOTICE.md](NOTICE.md)。上游名称仅用于说明
来源，不代表其对本发行版本提供背书或官方支持。
