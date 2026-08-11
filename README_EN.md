<p align="center">
  <img src="public/logo.png" alt="Zhima GLM Code" width="112">
</p>

<h1 align="center">Zhima GLM Code</h1>

<p align="center">
  <strong>Give it a requirement. Get back working code.</strong><br>
  An open-source desktop coding agent that can read your project, use tools, run commands,
  verify changes, and keep moving until the job is done.
</p>

<p align="center">
  <a href="https://github.com/leigegehaha/GLM-Coding-Agent/releases/latest"><img src="https://img.shields.io/github/v/release/leigegehaha/GLM-Coding-Agent?style=flat-square&label=release&color=1677ff" alt="Latest release"></a>
  <a href="https://github.com/leigegehaha/GLM-Coding-Agent/releases"><img src="https://img.shields.io/github/downloads/leigegehaha/GLM-Coding-Agent/total?style=flat-square&label=downloads&color=22a06b" alt="Downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8a63d2?style=flat-square" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/macOS-Apple_Silicon-111111?style=flat-square&logo=apple" alt="macOS Apple Silicon">
  <img src="https://img.shields.io/badge/Windows-x64-0078d4?style=flat-square&logo=windows11" alt="Windows x64">
</p>

<p align="center">
  <a href="README.md">简体中文</a> · English ·
  <a href="https://glmcoding.cn/">Website</a> ·
  <a href="https://github.com/leigegehaha/GLM-Coding-Agent/releases/latest">Download</a> ·
  <a href="https://github.com/leigegehaha/GLM-Coding-Agent/issues">Issues</a>
</p>

---

Zhima GLM Code is not another AI chat tab. It enters a real workspace, understands an
existing codebase, edits files, runs terminal commands, drives browser workflows, and checks
its own work. Coding Boost is enabled by default, while one click switches the same app back
to a general-purpose agent for research, documents, automation, and daily work.

## Quick Links

| Goal                  | Link                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Download the app      | [GitHub Releases](https://github.com/leigegehaha/GLM-Coding-Agent/releases/latest)                                                                                 |
| Use Zhima Coding Plan | [Product page](https://glmcoding.cn/) · [Register](https://glmcoding.cn/register) · [Sign in](https://glmcoding.cn/login) · [Plans](https://glmcoding.cn/#pricing) |
| Use enterprise tokens | [GLM Claude enterprise token service](https://glmclaude.com/)                                                                                                      |
| Find more skills      | [ClawHub](https://clawhub.ai/) · [Bundled skills](SKILLs/)                                                                                                         |
| Join the project      | [Open an issue](https://github.com/leigegehaha/GLM-Coding-Agent/issues) · [Contributor guide](AGENTS.md) · [MIT License](LICENSE)                                  |

## Recommended Model Services

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>For individual developers: Zhima Coding Plan</strong><br><br>
      Flexible plans billed by API calls or tokens for individual developers and creators.
      It is a cost-effective fit for everyday coding, bug fixing, refactoring, testing, and
      personal projects. Sign in from the desktop app to inspect quotas and configure the
      plan API key and default model in one click.<br><br>
      <a href="https://glmcoding.cn/"><strong>Explore Coding Plan →</strong></a> ·
      <a href="https://glmcoding.cn/register">Create an account</a>
    </td>
    <td width="50%" valign="top">
      <strong>For teams and enterprises: high-TPM token service</strong><br><br>
      Built for high-concurrency coding, team agents, and enterprise workloads with high TPM
      and enterprise node deployment. Domestic models are available at roughly 15%-50% of
      regular pricing, while international models can be roughly 1%-20%, making it a strong
      option when throughput, stability, and cost all matter.<br><br>
      <a href="https://glmclaude.com/"><strong>Visit GLM Claude →</strong></a>
    </td>
  </tr>
</table>

> Model availability, nodes, TPM, discounts, billing, and service terms may change. Refer to
> each service website for current details.

## Download

The current public build is **v2026.7.31**. Read the full notes on the
[release page](https://github.com/leigegehaha/GLM-Coding-Agent/releases/tag/v2026.7.31).

| Platform | Package                      | Download                                                                                                                                       |
| -------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | Apple Silicon (arm64), DMG   | [Download for macOS](https://github.com/leigegehaha/GLM-Coding-Agent/releases/download/v2026.7.31/GLMCode-darwin-arm64-2026.7.31-official.dmg) |
| Windows  | Windows 10/11 x64, installer | [Download for Windows](https://github.com/leigegehaha/GLM-Coding-Agent/releases/download/v2026.7.31/GLMCode-Setup-x64-2026.7.31-official.exe)  |

> The current packages are unsigned preview builds. macOS may ask you to confirm the app in
> Privacy & Security, and Windows may show a SmartScreen notice. Review release checksums
> before installing. Linux users can build from source.

## Install with an Agent

If you are using Codex, Claude Code, or another agent with network, terminal, and local file
access, paste the prompt below as a single message. The agent will detect the platform,
download the matching package from the official release, verify it, and help complete setup.

```text
Install Zhima GLM Code on this computer. Do not only describe the steps; perform the download and installation.

Official repository: https://github.com/leigegehaha/GLM-Coding-Agent

Follow these requirements exactly:
1. Detect the operating system and CPU architecture first. Supported packages are macOS Apple Silicon (arm64) and Windows x64 only.
2. Resolve the latest release through the official repository's GitHub Releases API. Do not download from search results, mirrors, or third-party links.
3. On macOS, select the DMG whose name contains darwin-arm64. On Windows x64, select the GLMCode-Setup-x64 EXE.
4. Download the installer into the current user's Downloads directory and report its version, filename, source URL, and size.
5. Calculate SHA-256. If the GitHub Release API provides a digest, require an exact match and stop immediately on mismatch.
6. Ask for my confirmation before running the installer or copying the app into Applications. Do not install silently or change security policies.
7. Do not disable or bypass Gatekeeper, SmartScreen, antivirus, or other system protections. Explain any manual confirmation I need to perform.
8. After installation, launch Zhima GLM Code, confirm the installed path and version, and explain how to sign in to Coding Plan or configure my own API key.
9. Stop and clearly explain the reason if the platform is unsupported, verification fails, or the download source cannot be confirmed.
```

This prompt authorizes only the Zhima GLM Code installation. It does not authorize removing
other versions, changing system security settings, or installing unrelated dependencies.
You must still approve any operating-system permission dialogs yourself.

## Start in Three Steps

1. **Install the desktop app** from the latest release.
2. **Connect a model** by signing in to Zhima Coding Plan or adding your own provider and API key.
3. **Choose a project folder** and describe the result you want. Coding Boost starts automatically.

Turn Coding Boost off from the chat input whenever a task is better suited to a general
agent. Registration and purchases open on [glmcoding.cn](https://glmcoding.cn/), while active
plan usage is available inside the app under **Settings → Plan Management**.

## Highlights

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>Codebase-native execution</strong><br><br>
      Select a local project and let the agent inspect, edit, search, run commands, and
      validate changes with live tool and progress output.
    </td>
    <td width="50%" valign="top">
      <strong>Coding Boost, on by default</strong><br><br>
      Engineering prompts and built-in workflows cover onboarding, planning, implementation,
      debugging, refactoring, review, testing, and PR delivery.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Reasoning you can dial in</strong><br><br>
      Change thinking mode and effort directly in chat. Model-aware profiles are included
      for GLM-5.2, Claude Opus, Kimi K3, DeepSeek V4, and compatible reasoning models.
    </td>
    <td width="50%" valign="top">
      <strong>Zhima Coding Plan in one click</strong><br><br>
      Sign in with your <a href="https://glmcoding.cn/">glmcoding.cn</a> account, inspect
      plans, quotas, reset windows, and API keys, then connect a plan with GLM-5.2 selected
      by default.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>A skill ecosystem that keeps growing</strong><br><br>
      Install bundled skills or discover more from the curated Zhima catalog and
      <a href="https://clawhub.ai/">ClawHub</a>. Remote search, pagination, refresh, import,
      and skill security checks are built in.
    </td>
    <td width="50%" valign="top">
      <strong>Bring your own model</strong><br><br>
      Use Zhima Coding Plan or configure OpenAI-, Anthropic-, and OpenAI-compatible APIs.
      Provider presets cover GLM, DeepSeek, Kimi, Qwen, Gemini, Ollama, and more.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>More than code</strong><br><br>
      Browser automation, web research, MCP servers, voice input, and rich previews for
      HTML, SVG, Mermaid, images, video, Markdown, PDF, Word, Excel, and PowerPoint.
    </td>
    <td width="50%" valign="top">
      <strong>Agents that stay on the job</strong><br><br>
      Create specialized agents, run subagents, keep durable memory, schedule recurring
      tasks, and connect work to WeChat, WeCom, DingTalk, Feishu, QQ, Telegram, Discord,
      email, and other channels.
    </td>
  </tr>
</table>

## Capability Map

| Area                 | Available today                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| Coding workspace     | Local folder selection, file CRUD, full-text search, terminal execution, verification, streaming progress  |
| Sessions and context | History, search, context usage, compaction, conversation forks, attachments, images, and cancellation      |
| Coding Boost         | Engineering system prompt enabled by default, with a per-session general-agent toggle                      |
| Thinking mode        | Model-aware levels including off, low, medium, high, xhigh, adaptive, and max where supported              |
| Models               | Zhima Coding Plan, custom keys, OpenAI/Anthropic-compatible APIs, and local Ollama models                  |
| Skills               | Bundled skills, Zhima catalog, ClawHub search and pagination, GitHub/URL/local import, updates, and audits |
| MCP and plugins      | MCP marketplace, JSON import, npm/npx/HTTP servers, plus OpenClaw plugin install and updates               |
| Agents and memory    | Custom agents, model/skill binding, subagents, durable memory, semantic recall, and memory CRUD            |
| Automation           | Cron tasks, templates, run history, background heartbeat, and persistent monitoring                        |
| Channels             | WeChat, WeCom, DingTalk, Feishu/Lark, QQ, Telegram, Discord, NIM, POPO, and email                          |
| Artifacts            | HTML, React, SVG, Mermaid, Markdown, code, images, video, PDF, and Office previews                         |
| Data and UX          | Local SQLite, backup and restore, diagnostics, updates, Chinese/English UI, themes, and skins              |

## Built-in Coding Workflow

Coding Boost is backed by routable engineering skills rather than a single generic prompt.

| Stage      | Skills                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Understand | [Codebase onboarding](SKILLs/codebase-onboarding/) · [Planning](SKILLs/create-plan/)                                             |
| Build      | [Feature implementation](SKILLs/implement-feature/) · [Frontend design](SKILLs/frontend-design/)                                 |
| Debug      | [Systematic debugging](SKILLs/systematic-debugging/) · [Playwright](SKILLs/playwright/)                                          |
| Verify     | [Safe refactoring](SKILLs/safe-refactoring/) · [Code review](SKILLs/code-review/) · [Test and verify](SKILLs/test-and-verify/)   |
| Deliver    | [Git/PR workflow](SKILLs/git-pr-workflow/) · [Engineering retrospective](SKILLs/engineering-retrospective/)                      |
| Improve    | [Coding memory](SKILLs/coding-memory-curator/) · [Skill vetting](SKILLs/skill-vetter/) · [Skill creation](SKILLs/skill-creator/) |

## Things to Ask

```text
Read this repository and explain its startup path, core modules, and the areas most likely to break.
```

```text
Reproduce this login bug, find the root cause, add a regression test, fix it, and run verification.
```

```text
Turn this requirement into a releasable feature. Plan first, then provide a change summary and evidence.
```

```text
Every weekday at 9 AM, review project issues and create a short priority briefing.
```

## Models and Runtime

- [Zhima Coding Plan](https://glmcoding.cn/) is an optional hosted service for individual
  developers. The app can sign in, display quota windows, and configure a plan API key in one click.
- [GLM Claude](https://glmclaude.com/) provides high-TPM tokens and enterprise nodes for
  teams and high-concurrency coding workloads.
- Bring-your-own-key remains available. Provider definitions live in
  [`src/shared/providers/`](src/shared/providers/).
- Reasoning controls appear only for supported models; available levels depend on provider APIs.
- The agent runtime is based on [OpenClaw](https://github.com/openclaw/openclaw). Its pinned
  version is recorded in [`package.json`](package.json) and prepared by packaging scripts.

## Privacy and Security

- **Local-first data:** conversations, agents, settings, and task metadata are stored in a
  local SQLite database with backup and restore support.
- **Secure plan credentials:** managed Coding Plan API credentials use OS-backed encrypted storage.
- **Permission-aware tools:** sensitive operations can request confirmation before execution.
- **Telemetry off by default:** analytics stay disabled unless explicitly enabled.

### Security boundary

The Electron renderer uses process isolation and sandboxing, but agent file operations and
terminal commands run locally with the permissions of your current OS account. This is **not
an isolated code-execution sandbox**. Use a dedicated working directory, review permission
requests, and do not run untrusted prompts or repositories without understanding the risk.

Model requests are sent to whichever provider you configure. Zhima account and Coding Plan
features communicate with `glmcoding.cn`; the open-source desktop app can also use your own
compatible provider.

## Develop Locally

Requirements: Node.js `>=24.15.0 <25`, npm, Git, and Corepack/pnpm for the first OpenClaw
runtime build.

```bash
git clone https://github.com/leigegehaha/GLM-Coding-Agent.git glm-code
cd glm-code
npm ci
npm run electron:dev:openclaw
```

After the runtime has been prepared, use `npm run electron:dev` for daily development.

```bash
npm test                  # Run the Vitest suite
npm run build             # Build the renderer
npm run compile:electron  # Compile Electron main/preload
npm run dist:mac          # Package macOS
npm run dist:win          # Package Windows
npm run dist:linux        # Package Linux
```

## Project Map

| Path                                           | Responsibility                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| [`src/main/`](src/main/)                       | Electron lifecycle, SQLite, credentials, OpenClaw, IPC, IM, MCP, updates |
| [`src/renderer/`](src/renderer/)               | React UI, Redux state, conversations, agents, settings, artifacts        |
| [`src/shared/`](src/shared/)                   | Cross-process types, constants, protocols, and provider definitions      |
| [`SKILLs/`](SKILLs/)                           | Bundled coding, productivity, document, browser, and memory skills       |
| [`openclaw-extensions/`](openclaw-extensions/) | Product-specific OpenClaw extensions                                     |
| [`scripts/`](scripts/)                         | Runtime preparation, validation, and cross-platform packaging            |

## Open Source and Support

- Services: [Personal Coding Plan](https://glmcoding.cn/) ·
  [Register](https://glmcoding.cn/register) ·
  [Enterprise tokens](https://glmclaude.com/)
- Project: [GitHub](https://github.com/leigegehaha/GLM-Coding-Agent) ·
  [Releases](https://github.com/leigegehaha/GLM-Coding-Agent/releases) ·
  [Issues](https://github.com/leigegehaha/GLM-Coding-Agent/issues)
- Development: [Contributor guide](AGENTS.md) · [Bundled skills](SKILLs/) ·
  [Attribution](NOTICE.md) · [MIT License](LICENSE)

Focused issues and pull requests are welcome. Include validation steps and before/after
screenshots for UI work; call out platform impact for Electron, IPC, storage, or runtime changes.

## License

Zhima GLM Code is maintained by 智码 GLM 科技 and released under the
[MIT License](LICENSE).

This project is a derivative work based on LobsterAI, originally published by NetEase Youdao
under the MIT License. The original copyright notice is preserved as required. See
[NOTICE.md](NOTICE.md) for attribution. Upstream attribution does not imply endorsement or
official support for this distribution.
