<p align="center">
  <img src="public/logo.png" alt="智码 GLM Code" width="96"><br>
  <strong>智码 GLM Code</strong>
</p>

<p align="center">
  智码 GLM 科技推出的开源桌面智能编码与全场景 Agent。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://glmcoding.cn/"><img src="https://img.shields.io/badge/官网-glmcoding.cn-1677ff" alt="智码 GLM Code 官网"></a>
</p>

[English](README.md) | 简体中文

## 产品简介

智码 GLM Code 是一个可以进入真实工作环境的桌面 Agent，能够处理本地项目、
文件、终端命令、浏览器流程、文档、表格、幻灯片、IM 渠道、定时任务和项目工作区。

应用使用 Electron、React、Redux Toolkit 和 Tailwind 构建，OpenClaw 是底层
Agent Runtime 与 Gateway。桌面端负责本地持久化、权限、界面状态、Artifacts、
Agents、记忆和 IM 绑定，OpenClaw 负责模型推理、工具调用和任务执行。

## 核心能力

- 面向本地项目和文件的长任务执行与实时流式反馈
- OpenAI、Anthropic、Gemini、DeepSeek、Qwen、GLM、Kimi、Ollama 等模型接入
- Skills、MCP、浏览器自动化、多 Agent 与上下文管理
- HTML、SVG、图片、视频、Mermaid、Markdown、Office/PDF 等 Artifacts
- 微信、企微、钉钉、飞书、QQ、Telegram、Discord、NIM、POPO 和邮件渠道
- OpenClaw Cron 定时任务、通知和运行历史
- 本地 SQLite 会话存储、数据备份和恢复

## 开发环境

- Node.js `>=24.15.0 <25`
- npm
- 首次构建 OpenClaw Runtime 时需要 Git、Corepack/pnpm 和网络连接

```bash
git clone https://github.com/leigegehaha/GLM-Coding-Agent.git glm-code
cd glm-code
npm install
npm run electron:dev:openclaw
```

日常开发在 Runtime 已存在时可运行：

```bash
npm run electron:dev
```

常用命令：

```bash
npm test
npm run build
npm run compile:electron
npm run dist:mac
npm run dist:win
npm run dist:linux
```

## 品牌与服务配置

- 官网、协议、手册、社区、下载和商店入口统一位于 <https://glmcoding.cn/>。
- Logo 原始文件保存在 `public/logo.webp`，应用使用的 PNG 位于 `public/logo.png`。
- Main 进程服务地址可通过 `GLMCODE_SERVER_API_URL`、
  `GLMCODE_UPDATE_CHECK_URL`、`GLMCODE_MANUAL_UPDATE_CHECK_URL`、
  `GLMCODE_DOWNLOAD_URL`、`GLMCODE_SKILL_STORE_URL`、
  `GLMCODE_KIT_STORE_URL` 和 `GLMCODE_PORTAL_URL` 覆盖。
- 使用统计默认关闭；用户明确开启后，统计入口指向 `glmcoding.cn`。

## 目录概览

| 路径 | 说明 |
| --- | --- |
| `src/main/` | Electron Main、SQLite、OpenClaw、IPC、IM、MCP、更新与 Artifacts |
| `src/renderer/` | React UI、Redux 状态、Cowork 会话和管理界面 |
| `src/shared/` | Main 与 Renderer 共享的类型和协议 |
| `SKILLs/` | 内置 Skills |
| `openclaw-extensions/` | 本地 OpenClaw 扩展 |
| `scripts/` | Runtime 构建和跨平台打包脚本 |

## 开源协议与版权

智码 GLM Code 采用 [MIT License](LICENSE) 发布，由智码 GLM 科技维护。

本项目基于 NetEase Youdao 开源的 LobsterAI 项目修改和再开发。依照 MIT License，
原版权声明和许可文本继续保留。详细来源和衍生版权说明见 [NOTICE.md](NOTICE.md)。

上游名称仅用于依法说明来源，不代表上游作者对本衍生版本提供背书或官方支持。
