# OpenAI ChatGPT OAuth 登录实现 Spec

## 问题描述

智码 GLM Code 原有 OpenAI 接入只支持自定义 API Key。新增 ChatGPT OAuth 登录后，需要满足以下要求：

1. 用户可在 `设置 → 模型 → OpenAI` 中选择 API Key 或 ChatGPT OAuth 两种认证方式
2. OAuth 登录成功后，OpenClaw Cowork 能使用 ChatGPT 账号调用 OpenAI/Codex 模型
3. 在开启系统代理的网络环境中，OAuth 模式与自定义 API Key 模式一样可用
4. OAuth 登录、退出登录后，设置页状态应即时更新，不应等待 OpenClaw 配置同步完成
5. 不污染用户本机已有 Codex CLI 登录状态，不覆盖 `~/.codex/auth.json`

## 核心结论

**OpenAI OAuth 登录不是把 ChatGPT token 当普通 OpenAI API Key 使用，而是走 OpenClaw/pi-ai 的 `openai-codex` provider。**

| 项 | API Key 模式 | OAuth 模式 |
|---|---|---|
| 智码 GLM Code provider | `openai` | `openai` |
| OpenClaw provider | `openai` | `openai-codex` |
| OpenClaw API | `openai-responses` / `openai-completions` | `openai-codex-responses` |
| Base URL | 用户配置，例如 `https://api.openai.com/v1` | `https://chatgpt.com/backend-api/codex` |
| 凭证来源 | `providers.openai.apiKey` | `<app userData>/codex/auth.json` |
| 配置中的 API Key | `${OPENAI_API_KEY}` | 无 API Key |
| 必要 Header | 无 | `chatgpt-account-id`, `originator: pi`, `OpenAI-Beta: responses=experimental` |
| Transport | OpenClaw 通用 OpenAI transport | pi-ai 原生 Codex transport |

---

## 总体架构

```
Settings.tsx
  → window.electron.openaiCodexOAuth.start()
  → IPC openai-codex-oauth:start
  → startOpenAICodexLogin()
  → System Browser: https://auth.openai.com/oauth/authorize
  → Local callback: http://localhost:1455/auth/callback
  → Token exchange: https://auth.openai.com/oauth/token
  → Write <userData>/codex/auth.json
  → Settings UI optimistic update
  → configService.updateConfig({ providers }) in background
  → Main store:set app_config
  → OpenClawConfigSync writes openclaw.json
  → OpenClaw gateway reads CODEX_HOME/auth.json
  → pi-ai openai-codex-responses native transport
```

### 设计原则

1. **OAuth token 不进入 renderer 配置。** Renderer 只保存 `authType: 'oauth'`，真实 token 只写入主进程管理的 `auth.json`。
2. **OpenAI API Key 模式完全保留。** OAuth 只在 OpenAI provider 显式选择 OAuth 时启用。
3. **OpenClaw 使用独立 Codex home。** `CODEX_HOME` 指向 智码 GLM Code app data 下的 `codex` 目录，避免影响系统 Codex CLI。
4. **Codex OAuth 走原生 transport。** 通用 OpenAI Responses 请求体会被 ChatGPT Codex 后端拒绝。
5. **UI 状态优先响应用户操作。** 配置同步和 gateway reload 不阻塞设置页登录/退出状态更新。

---

## 详细流程分析

### 登录流程

```
User clicks "ChatGPT 登录"
  → Settings.handleOpenAIOAuthLogin()
    → openaiOAuthPhase = pending
    → IPC openai-codex-oauth:start

Main process:
  → startOpenAICodexLogin()
    → generate PKCE verifier/challenge/state
    → start local callback server on localhost:1455
    → shell.openExternal(authorizeUrl)

Browser:
  → user completes ChatGPT auth
  → OpenAI redirects to http://localhost:1455/auth/callback?code=...&state=...

Local callback server:
  → validate callback path
  → validate state
  → respond HTML success page
  → exchange authorization code for tokens
  → parse id_token claims
  → extract email and chatgpt_account_id
  → write <userData>/codex/auth.json
  → resolve success to renderer

Renderer:
  → providers.openai.authType = 'oauth'
  → providers.openai.enabled = true
  → openaiOAuthStatus = loggedIn
  → openaiOAuthPhase = success
  → background persist config
```

### 退出登录流程

```
User clicks "退出登录"
  → Settings.handleOpenAIOAuthLogout()
    → providers.openai.authType = 'apikey'
    → providers.openai.enabled = providers.openai.apiKey.trim().length > 0
    → openaiOAuthStatus = loggedIn false
    → openaiOAuthPhase = idle
    → background persist config
    → IPC openai-codex-oauth:logout

Main process:
  → logoutOpenAICodex()
    → delete <userData>/codex/auth.json
```

**注意：** 设置页先更新本地 UI 状态，再执行文件删除和配置同步。这样用户不需要等待 OpenClaw config sync 或 gateway reload。

### 状态同步流程

```
Settings opens OpenAI provider tab
  → IPC openai-codex-oauth:status
  → readOpenAICodexAuthFile()
  → if auth.json exists and valid:
       openaiOAuthStatus = loggedIn
    else:
       openaiOAuthStatus = loggedOut
       if providers.openai.authType === 'oauth':
         providers.openai.authType = 'apikey'
```

该逻辑用于修复外部删除 `auth.json` 后，设置页仍显示 OAuth 已登录的过期状态。

---

## OpenClaw 配置生成

### Provider 映射

OpenAI provider 的最终映射由 `buildProviderSelection()` 决定：

```typescript
if (providerName === ProviderName.OpenAI && authType === 'oauth') {
  return PROVIDER_REGISTRY[`${ProviderName.OpenAI}:oauth`];
}
```

OAuth descriptor：

```typescript
{
  providerId: OpenClawProviderId.OpenAICodex,
  resolveApi: () => OpenClawApi.OpenAICodexResponses,
  normalizeBaseUrl: () => 'https://chatgpt.com/backend-api/codex',
  resolveApiKey: () => undefined,
}
```

生成的 OpenClaw provider 形态：

```json
{
  "models": {
    "providers": {
      "openai-codex": {
        "baseUrl": "https://chatgpt.com/backend-api/codex",
        "api": "openai-codex-responses",
        "auth": "oauth",
        "headers": {
          "chatgpt-account-id": "<account id from auth.json>",
          "originator": "pi",
          "OpenAI-Beta": "responses=experimental"
        },
        "request": {
          "proxy": {
            "mode": "env-proxy"
          }
        },
        "models": [
          {
            "id": "gpt-5.4",
            "api": "openai-codex-responses",
            "input": ["text", "image"]
          }
        ]
      }
    }
  }
}
```

### 系统代理处理

当 智码 GLM Code 设置中启用系统代理，并且目标 base URL 不是 loopback 地址时，OpenClaw provider 写入：

```json
{
  "request": {
    "proxy": {
      "mode": "env-proxy"
    }
  }
}
```

OAuth 模式还会为 `openai-codex/<model>` 写入模型级 override：

```json
{
  "params": {
    "transport": "sse"
  }
}
```

这样避免 WebSocket 路径绕过代理或触发不一致行为，同时让 pi-ai 原生 Codex SSE transport 使用 OpenClaw 的代理环境。

---

## Token 存储与安全边界

### 存储位置

OAuth token 写入：

```
<Electron app userData>/codex/auth.json
```

主进程启动 OpenClaw gateway 时注入：

```typescript
CODEX_HOME: getCodexHomeDir()
```

因此 OpenClaw/pi-ai 会从 智码 GLM Code 管理的 `CODEX_HOME/auth.json` 读取 ChatGPT OAuth token。

### auth.json 格式

```json
{
  "OPENAI_API_KEY": null,
  "auth_mode": "chatgpt",
  "tokens": {
    "id_token": "<jwt>",
    "access_token": "<access token>",
    "refresh_token": "<refresh token>",
    "account_id": "<chatgpt account id>"
  },
  "last_refresh": "<iso timestamp>"
}
```

### 安全约束

1. 文件权限尽量设为 `0600`
2. token 不写入 renderer `providers` 配置
3. token 不写入 OpenClaw `openclaw.json`
4. 日志不打印 access token / refresh token / id token
5. 不读写用户真实 `~/.codex/auth.json`

---

## 模型引用与 UI 状态

### Model ref

OAuth 模式下，OpenAI 模型在 OpenClaw 中必须使用：

```
openai-codex/<model-id>
```

而不是：

```
openai/<model-id>
```

Renderer 和 main process 都需要知道 OpenAI OAuth 对应的 OpenClaw provider id：

```typescript
if (providerName === ProviderName.OpenAI && providerConfig.authType === 'oauth') {
  return OpenClawProviderId.OpenAICodex;
}
```

### 兼容旧引用

历史上可能已经保存了 `openai/gpt-5.3-codex` 这类旧 ref。运行时需要兼容并修正：

```
openai/<codex model> → openai-codex/<codex model>
```

否则登录成功后仍可能按 API Key provider 路由，请求打到错误 endpoint。

### 设置页体验优化

登录成功后：

```typescript
setProviders(nextProviders);
setOpenaiOAuthStatus({ loggedIn: true, email });
setOpenaiOAuthPhase({ kind: 'success', email });
persistOpenAIProvidersConfigInBackground(nextProviders);
```

退出登录后：

```typescript
setProviders(nextProviders);
setOpenaiOAuthStatus({ loggedIn: false });
setOpenaiOAuthPhase({ kind: 'idle' });
persistOpenAIProvidersConfigInBackground(nextProviders);
await window.electron.openaiCodexOAuth.logout();
```

核心是 UI 状态更新不再等待 `configService.updateConfig()`，因为后者会触发 OpenClaw config sync 和 gateway reload，可能耗时数秒。

---

## 关键问题与修复

### 问题 1：OAuth 请求仍报 `403 Country, region, or territory not supported`

#### 现象

```
provider=openai
api=openai-responses
endpoint=openai-public
error=403 Country, region, or territory not supported
```

#### 根因

OAuth 模式仍然被路由到普通 OpenAI public endpoint 或普通 OpenAI provider，没有切换到 ChatGPT Codex backend。

#### 修复

1. 新增 OpenClaw provider id：`openai-codex`
2. 新增 OpenClaw API：`openai-codex-responses`
3. `ProviderName.OpenAI + authType: 'oauth'` 映射到 `openai-codex`
4. base URL 固定为 `https://chatgpt.com/backend-api/codex`
5. 运行时通过 `CODEX_HOME/auth.json` 读取 OAuth token

### 问题 2：OAuth 请求返回 HTML 403

#### 现象

```
Authentication failed with an HTML 403 response from the provider.
rawError=403 <html>...
```

#### 根因

请求打到了 `https://chatgpt.com/backend-api/responses` 这类错误路径。ChatGPT Codex backend 需要 `/backend-api/codex/responses`。

#### 修复

OpenAI OAuth provider base URL 改为：

```
https://chatgpt.com/backend-api/codex
```

并补充 Codex backend 必要 headers：

```typescript
{
  'chatgpt-account-id': accountId,
  originator: 'pi',
  'OpenAI-Beta': 'responses=experimental',
}
```

### 问题 3：OAuth 请求返回 400 schema/tool payload

#### 现象

```
error=LLM request failed: provider rejected the request schema or tool payload.
rawError=400 status code (no body)
```

#### 根因

OpenClaw 将 `openai-codex-responses` 当作普通 OpenAI Responses transport 处理，发送 public Responses API 风格 payload。

ChatGPT Codex backend 要求 pi-ai 原生 Codex provider 的 payload/header contract，例如：

- `instructions` 单独传递 system prompt
- `store: false`
- `tool_choice: 'auto'`
- `parallel_tool_calls: true`
- `include: ['reasoning.encrypted_content']`
- Codex-specific headers

#### 修复

在 OpenClaw 版本补丁中让 `openai-codex-responses` 不再返回通用 Responses transport：

```typescript
case "openai-responses":
  return createOpenAIResponsesTransportStreamFn();
case "openai-codex-responses":
  return undefined;
```

这样 `openai-codex-responses` 会回到 pi-ai 原生 provider。

补丁文件：

```
scripts/patches/v2026.4.14/openclaw-codex-use-native-transport.patch
```

---

## 涉及文件清单

| 文件 | 角色 |
|------|------|
| `src/main/libs/openaiCodexAuth.ts` | ChatGPT OAuth PKCE 登录、callback server、token exchange、auth.json 读写、logout |
| `src/main/main.ts` | 注册 `openai-codex-oauth:*` IPC handler |
| `src/main/preload.ts` | 向 renderer 暴露 `window.electron.openaiCodexOAuth` |
| `src/renderer/types/electron.d.ts` | 声明 OAuth IPC API 类型 |
| `src/renderer/components/Settings.tsx` | OpenAI API Key/OAuth UI、登录/退出、状态刷新、乐观 UI 更新 |
| `src/shared/providers/constants.ts` | 定义 `OpenAICodex` provider id 和 `OpenAICodexResponses` API |
| `src/main/libs/openclawConfigSync.ts` | OAuth provider 映射、Codex base URL、headers、系统代理、model override |
| `src/main/libs/openclawEngineManager.ts` | 启动 OpenClaw gateway 时注入 `CODEX_HOME` |
| `src/main/libs/claudeSettings.ts` | 将 OpenAI OAuth provider 暴露给模型/Agent 配置解析 |
| `src/main/libs/openclawAgentModels.ts` | OpenClaw agent model ref 解析与旧 ref 兼容 |
| `src/renderer/App.tsx` | 可用模型列表中的 OpenClaw provider id 映射 |
| `src/renderer/utils/openclawModelRef.ts` | `openai` / `openai-codex` 模型引用匹配 |
| `src/renderer/store/slices/modelSlice.ts` | 模型状态保存 OpenClaw provider id |
| `scripts/patches/v2026.4.14/openclaw-codex-use-native-transport.patch` | OpenClaw runtime 补丁，禁止 Codex 走通用 Responses transport |

---

## IPC 接口

### `openai-codex-oauth:start`

启动浏览器 OAuth 登录流程。

返回：

```typescript
| { success: true; email: string | null; accountId: string | null; expiresAt: number }
| { success: false; error: string }
```

### `openai-codex-oauth:cancel`

取消正在进行的登录流程，关闭本地 callback server。

### `openai-codex-oauth:logout`

删除 app-managed `auth.json`。

### `openai-codex-oauth:status`

读取当前 ChatGPT OAuth 登录状态。

返回：

```typescript
| { loggedIn: true; email: string | null; accountId: string | null; expiresAt: number }
| { loggedIn: false }
```

---

## 验证方法

### 自动化验证

```bash
npm test -- openclawConfigSync.runtime openclawAgentModels
npm run build
git diff --check
```

### 功能验证

1. 打开 `设置 → 模型 → OpenAI`
2. 选择 `ChatGPT 登录`
3. 完成浏览器 OAuth 登录
4. 返回 智码 GLM Code，设置页应立即显示已登录状态
5. 保存或直接使用 OpenAI 模型启动 Cowork 对话
6. 检查日志应出现：

```
provider=openai-codex
api=openai-codex-responses
endpoint=openai-codex
```

7. 开启系统代理后重复发送消息，确认不再出现：

```
403 Country, region, or territory not supported
403 <html>...
400 status code (no body)
```

### 回归验证

| 场景 | 预期 |
|------|------|
| OpenAI API Key 模式 | 仍使用 `openai/<model>` 和用户 API Key |
| OpenAI OAuth 模式 | 使用 `openai-codex/<model>` 和 ChatGPT OAuth |
| MiniMax OAuth | 不受影响 |
| OAuth 登录后刷新设置页 | 状态仍为已登录 |
| 删除 `auth.json` 后进入 OpenAI tab | 状态回到未登录 / API Key |
| OAuth 退出登录 | 设置页立即切换，不等待 OpenClaw 同步 |
| 系统 Codex CLI 已登录 | 智码 GLM Code 不覆盖 `~/.codex/auth.json` |

---

## 已知边界

1. OAuth callback 固定使用 `http://localhost:1455/auth/callback`，该端口被占用时登录会失败。
2. OAuth token refresh 依赖 OpenClaw/pi-ai 读取 `auth.json` 后的 provider 行为；智码 GLM Code 当前只负责初次 token exchange 和本地持久化。
3. `chatgpt-account-id` 来自 id token claims；如果 token payload 缺失该字段，Codex headers 不完整，后端可能拒绝请求。
4. OAuth 模式依赖 ChatGPT/Codex backend，不等价于 OpenAI public API 的 OAuth 支持。
5. 设置页 UI 乐观更新后，如果后台配置同步失败，会显示通用保存失败提示；token 文件本身仍以主进程操作结果为准。

---

## 后续优化建议

1. 增加主进程 OAuth 状态变更事件，让多个设置窗口或未来 UI 面板无需主动查询状态。
2. 在 OAuth status 中返回更明确的过期/可刷新状态，区分“未登录”和“token 文件损坏”。
3. 为 `openai-codex-oauth:start/logout/status` 增加轻量单元测试或 IPC mock 测试。
4. 在设置页展示端口占用错误的更友好引导，例如提示用户关闭正在运行的 Codex CLI 登录流程。
5. 增加 OpenClaw runtime patch 的上游同步跟踪，减少后续升级时的维护成本。
