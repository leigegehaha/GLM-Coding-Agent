<p align="center">
  <img src="public/logo.png" alt="智码 GLM Code" width="96"><br>
  <strong>智码 GLM Code</strong>
</p>

<p align="center">
  An open-source desktop coding and general-purpose Agent maintained by 智码 GLM 科技.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://glmcoding.cn/"><img src="https://img.shields.io/badge/website-glmcoding.cn-1677ff" alt="智码 GLM Code website"></a>
</p>

English | [简体中文](README_zh.md)

## Overview

智码 GLM Code is a desktop Agent that works with real projects, local files,
terminal commands, browser workflows, documents, spreadsheets, slides, IM
channels, scheduled tasks, and project workspaces.

The desktop application is built with Electron, React, Redux Toolkit, and
Tailwind. OpenClaw provides the underlying Agent Runtime and Gateway. The
desktop layer owns local persistence, permissions, UI state, artifacts,
agents, memory, and IM bindings, while OpenClaw performs model inference,
tool calls, and task execution.

## Highlights

- Long-running tasks over local projects with real-time streaming feedback
- OpenAI, Anthropic, Gemini, DeepSeek, Qwen, GLM, Kimi, Ollama, and more
- Skills, MCP, browser automation, multi-agent execution, and context management
- HTML, SVG, image, video, Mermaid, Markdown, Office/PDF, and other artifacts
- WeChat, WeCom, DingTalk, Feishu/Lark, QQ, Telegram, Discord, NIM, POPO, and email
- OpenClaw Cron scheduled tasks, notifications, and run history
- Local SQLite sessions plus backup and restore

## Development

Requirements:

- Node.js `>=24.15.0 <25`
- npm
- Git and Corepack/pnpm for the first OpenClaw Runtime build

```bash
git clone https://github.com/leigegehaha/GLM-Coding-Agent.git glm-code
cd glm-code
npm install
npm run electron:dev:openclaw
```

Once the Runtime has been built, daily development can use:

```bash
npm run electron:dev
```

Useful commands:

```bash
npm test
npm run build
npm run compile:electron
npm run dist:mac
npm run dist:win
npm run dist:linux
```

## Branding and service configuration

- Website, terms, manuals, community, downloads, and store links use <https://glmcoding.cn/>.
- The downloaded source logo is `public/logo.webp`; the application asset is `public/logo.png`.
- Main-process endpoints can be overridden with `GLMCODE_SERVER_API_URL`,
  `GLMCODE_UPDATE_CHECK_URL`, `GLMCODE_MANUAL_UPDATE_CHECK_URL`,
  `GLMCODE_DOWNLOAD_URL`, `GLMCODE_SKILL_STORE_URL`,
  `GLMCODE_KIT_STORE_URL`, and `GLMCODE_PORTAL_URL`.
- Usage analytics are disabled by default. If explicitly enabled, the endpoint
  is hosted under `glmcoding.cn`.

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/main/` | Electron Main, SQLite, OpenClaw, IPC, IM, MCP, updates, artifacts |
| `src/renderer/` | React UI, Redux state, Cowork sessions, management views |
| `src/shared/` | Types and protocols shared across Electron processes |
| `SKILLs/` | Bundled skills |
| `openclaw-extensions/` | Local OpenClaw extensions |
| `scripts/` | Runtime build and cross-platform packaging scripts |

## License and attribution

智码 GLM Code is distributed under the [MIT License](LICENSE) and maintained
by 智码 GLM 科技.

This project is a derivative work based on LobsterAI, originally published by
NetEase Youdao under the MIT License. The original copyright notice and license
terms remain included as required. See [NOTICE.md](NOTICE.md) for attribution.

The upstream name is used for attribution only and does not imply endorsement
or official support for this derivative distribution.
