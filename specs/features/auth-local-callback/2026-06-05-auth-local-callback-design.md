# 智码 GLM Code 本地回调登录设计文档

## 1. 概述

### 1.1 背景

当前 智码 GLM Code 登录流程为：

```
客户端点击登录
  -> 主进程通过 shell.openExternal 打开网页登录页
  -> 用户在网页端完成登录
  -> 网页触发 lobsterai://auth/callback?code=<authCode>
  -> 浏览器弹出系统确认框，用户点击"打开 智码 GLM Code"
  -> Electron 通过 deep link 收到 code
  -> 主进程调用 /api/auth/exchange 换取 accessToken 与 refreshToken
```

该流程可用，但浏览器在打开 `lobsterai://` 自定义协议时会显示系统级确认弹窗。弹窗由浏览器控制，样式不可定制；首次登录时用户会看到一层额外确认，体验不够顺滑。

本需求希望改为 **localhost / 127.0.0.1 本地回调模式**：网页登录成功后直接重定向到客户端临时启动的本地 HTTP callback server，由客户端接收一次性 auth code 并完成登录。因为浏览器访问的是普通 HTTP 地址，而不是外部应用协议，所以不会触发"是否打开 智码 GLM Code"的系统确认框。

### 1.2 目标

- 使用 `http://127.0.0.1:<port>/auth/callback` 接收网页登录回调。
- 登录时由客户端临时启动本地 callback server，登录结束后立即关闭。
- 端口使用系统分配的动态空闲端口，避免固定端口冲突。
- 保留现有 `lobsterai://auth/callback` deep link 逻辑作为兼容或 fallback。
- 复用现有 `/api/auth/exchange`、token 持久化、刷新、用户信息加载逻辑。
- 网页端登录成功后展示用户友好的成功页，提示可以关闭浏览器页面或返回 智码 GLM Code。
- 客户端收到本地 callback 后主动恢复并聚焦 智码 GLM Code 主窗口，尽量让用户回到应用。
- 本地 callback 成功页短暂停留后自动跳回 portal 的 Electron 登录成功页，避免浏览器长期停留在 `127.0.0.1` 地址。

### 1.3 非目标

- 不美化或替换浏览器系统级外部应用确认框；本方案通过避开 deep link 来减少该弹窗出现。
- 不把 `accessToken` / `refreshToken` 放入浏览器 URL。
- 不复用 Vite dev server 端口，也不复用 OpenAI Codex OAuth 的 `1455` 端口。
- 不在 renderer 中直接启动 HTTP server；本地 callback server 只由主进程管理。

## 2. 用户场景

### 场景 1: 首次登录

**Given** 用户未登录 智码 GLM Code
**When** 用户在客户端点击登录按钮
**Then** 客户端启动一个只监听 `127.0.0.1` 的临时 HTTP server，并打开带 `redirect_uri` 的网页登录页

**When** 用户在网页端完成登录
**Then** 网页重定向到 `http://127.0.0.1:<port>/auth/callback?code=<authCode>&state=<state>`，客户端收到 code 后完成登录，浏览器页面显示"登录成功，可以关闭此页面"

### 场景 2: 端口冲突

**Given** 某个本地端口被其他程序占用
**When** 用户发起登录
**Then** 客户端使用 `server.listen(0, '127.0.0.1')` 让操作系统分配空闲端口，不依赖固定端口，因此不会因为预设端口被占用而失败

### 场景 3: 用户取消或超时

**Given** 用户打开网页登录页但未完成登录
**When** 登录等待超过超时时间，或用户再次点击登录启动新流程
**Then** 客户端关闭旧 callback server，清理 pending state，并返回可重试的错误状态

### 场景 4: 网页端暂未支持本地回调

**Given** 后端或网页端尚未支持 `redirect_uri=http://127.0.0.1:<port>/auth/callback`
**When** 用户点击登录
**Then** 客户端可继续使用现有 `lobsterai://auth/callback` deep link 流程作为 fallback，确保登录功能不回退

## 3. 功能需求

### FR-1: 本地 callback server

- 登录开始时在主进程启动 HTTP server。
- 仅绑定 `127.0.0.1`，不监听 `0.0.0.0` 或局域网地址。
- 使用动态端口：`server.listen(0, '127.0.0.1')`。
- 只接受 `GET /auth/callback`。
- 收到 callback 后立即返回 HTML 成功或失败页。
- 登录完成、失败、超时或取消时关闭 server。

### FR-2: 登录 URL 构造

- `auth:login` 不再只打开 `loginUrl?source=electron`。
- 新流程应先启动本地 callback server，再将以下参数追加到网页登录 URL：
  - `source=electron`
  - `redirect_uri=http://127.0.0.1:<port>/auth/callback?return_to=<portalSuccessUrl>`
  - `state=<randomState>`
- 若原始登录 URL 已包含 query，追加参数时必须使用 `URL` / `URLSearchParams`，避免手写字符串拼接错误。

### FR-3: state 校验

- 每次登录生成随机 `state`。
- callback 必须携带相同 `state` 才处理 code。
- state 不匹配时返回失败页，不调用 `/api/auth/exchange`。

### FR-4: auth code 处理

- callback URL 中只接收一次性 `code`。
- 客户端收到 code 后复用现有 `auth:exchange` 等价逻辑调用 `/api/auth/exchange`。
- 只在主进程保存 token，保持现有 SQLite `auth_tokens` 存储方式。
- URL 中不得传递 `accessToken`、`refreshToken` 或其他长期凭证。

### FR-5: renderer 状态更新

- 成功换取 token 后，renderer 需要像现有 deep link 流程一样更新 Redux auth 状态、加载 server models、刷新 quota。
- 可选实现方式：
  - 主进程继续通过 `AuthIpcChannel.Callback` 将 code 发送给 renderer，由 renderer 调用现有 `handleCallback(code)`。
  - 或主进程直接 exchange 后新增 `auth:loginCompleted` 事件，把 user/quota 发送给 renderer。
- 为减少改动，推荐第一阶段复用现有 `AuthCallbackRouter` 的 delivery 模型：本地 callback 收到 code 后调用同一条 `deliverOrBuffer(code)` 路径。

### FR-6: deep link 兼容

- 保留现有 `lobsterai://auth/callback?code=...` 解析。
- macOS `open-url`、Windows/Linux `second-instance` 和 cold start 参数解析逻辑继续可用。
- 若本地回调启动失败或网页端未支持 `redirect_uri`，可以退回 deep link 流程。

### FR-7: 回到应用前台

- 本地 callback 收到合法 code 后，主进程应主动恢复并聚焦主窗口。
- 跨平台窗口行为：
  - Windows/Linux/macOS 通用：`restore()`、`show()`、`focus()`。
  - macOS 额外调用 `app.focus({ steal: true })`，提升从浏览器回到应用的成功率。
- 聚焦失败不应阻断登录，只记录 warn 日志。

## 4. 实现方案

### 4.1 新增本地登录回调模块

建议新建：

`src/main/libs/authLocalCallbackServer.ts`

职责：

- 创建和关闭临时 HTTP server。
- 生成并保存当前登录的 `state`。
- 暴露 `startAuthLocalCallback()`，返回：
  - `redirectUri`
  - `state`
  - `close()`
- 处理 `/auth/callback`：
  - 校验 path
  - 校验 state
  - 读取 code
  - 返回成功页或失败页
  - 通知主流程处理 code

参考实现可借鉴 `src/main/libs/openaiCodexAuth.ts` 中本地 callback server 的 HTML 响应、超时和 server close 模式，但端口策略不同：智码 GLM Code 登录使用动态端口；OpenAI Codex OAuth 因第三方注册限制必须使用固定 `1455`。

### 4.2 调整主进程登录入口

修改 `src/main/main.ts` 中 `ipcMain.handle('auth:login', ...)`：

当前逻辑：

```ts
const baseUrl = loginUrl || `${getServerApiBaseUrl()}/login`;
const finalUrl = `${baseUrl}?source=electron`;
await shell.openExternal(finalUrl);
```

目标逻辑：

```ts
const callback = await startAuthLocalCallback({
  onCode: code => authCallbackRouter.handleAuthCode(code),
});

const finalUrl = buildLoginUrl(baseUrl, {
  source: 'electron',
  redirect_uri: callback.redirectUri,
  state: callback.state,
});

await shell.openExternal(finalUrl);
```

实际实现时需要给 `AuthCallbackRouter` 增加一个直接投递 code 的方法，避免为了本地 callback 再伪造 `lobsterai://` URL。例如：

```ts
handleAuthCode(code: string): void {
  this.deliverOrBuffer(code);
}
```

### 4.3 URL 参数构造

新增 helper，避免 `?source=electron` 在 URL 已有 query 时生成错误地址：

```ts
function appendLoginParams(baseUrl: string, params: Record<string, string>): string {
  const url = new URL(baseUrl);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url.toString();
}
```

如果登录 URL 可能是相对路径，则先用服务端 base URL 解析为绝对 URL。

### 4.4 超时与并发控制

- 同一时间只允许一个 智码 GLM Code 登录 callback server。
- 如果用户重复点击登录：
  - 关闭旧 server；
  - 创建新 state 和新 server；
  - 打开新的网页登录 URL。
- 默认超时时间建议 5 分钟。
- 超时后关闭 server，并在日志中输出一条 warn：

```ts
console.warn('[AuthLocalCallback] login callback timed out, closed local server');
```

### 4.5 应用窗口聚焦

主进程维护统一的 `focusMainWindow(reason)` helper：

```ts
if (mainWindow.isMinimized()) mainWindow.restore();
if (!mainWindow.isVisible()) mainWindow.show();
if (!mainWindow.isFocused()) mainWindow.focus();
if (process.platform === 'darwin') app.focus({ steal: true });
```

调用时机：

- Windows/Linux 旧 deep link 进入 `second-instance` 后聚焦主窗口。
- 新本地 callback 收到合法 code 并投递给 renderer 后，立即聚焦主窗口。

macOS 仍可能受到系统抢焦点策略限制，但该处理能覆盖大多数浏览器登录后回到应用的场景。

### 4.6 成功页与跳回 Portal

本地 server 返回简单 HTML：

- 成功：`登录已完成，正在返回 智码 GLM Code 登录页。`
- 失败：`登录失败，请返回 智码 GLM Code 后重试。`
- 页面不包含 code、token 或敏感错误详情。
- HTML 中的用户可见文案在主进程内生成。若未来需要多语言，可接入 `src/main/i18n.ts`。

成功页会读取 `redirect_uri` 中携带的 `return_to` 参数，并在校验为有道域名后短暂停留再执行：

```ts
window.location.replace(returnTo);
```

`return_to` 白名单：

- 线上环境允许 `youdao.com` 与 `*.youdao.com`。
- 本地开发允许 `127.0.0.1` 与 `localhost`，用于 portal dev server 联调。
- 其他域名全部忽略，避免本地 callback server 变成开放跳转入口。

客户端生成的 `return_to` 指向：

```text
<portal login url>?source=electron&electronLogin=success
```

这样用户会短暂经过 `127.0.0.1` callback URL，但最终浏览器地址栏回到 portal 页面。

### 4.7 后端与网页端配合

网页端需要支持以下行为：

1. 接收 `redirect_uri` 参数。
2. 校验 `redirect_uri` 只允许 loopback 地址：
   - `http://127.0.0.1:<port>/auth/callback`
   - 可选允许 `http://localhost:<port>/auth/callback`
3. 登录成功后重定向：

```text
<redirect_uri>?code=<authCode>&state=<state>
```

4. 若未传 `redirect_uri`，保留现有 deep link：

```text
lobsterai://auth/callback?code=<authCode>
```

推荐优先只允许 `127.0.0.1`，减少 localhost 被 hosts 或代理环境影响的可能性。

### 4.8 Portal 现状与兼容改造

当前网页端代码位于：

`/Users/admin/Desktop/disk/work/lobsterai-portal`

客户端当前打开的生产登录地址为：

```text
https://glmcoding.cn/portal#/login?source=electron
```

网页端登录主入口为：

`/Users/admin/Desktop/disk/work/lobsterai-portal/src/views/LoginView.vue`

现有逻辑：

- `route.query.source` 决定是否为 Electron 登录，默认值为 `portal`。
- `route.query.electronLogin === 'success'` 时显示 Electron 登录完成状态，不加载 URS SDK。
- Electron 登录完成状态页使用 智码 GLM Code 品牌图标与成功文案，并提供"返回网站首页"按钮。
- 普通 URS 登录成功后，`handleLoginSuccess()` 调用 `POST /api/auth/callback`，服务端返回 `data.authCode`。
- 当 `source === 'electron' && authCode` 时，页面创建隐藏 iframe：

```ts
iframe.src = `lobsterai://auth/callback?code=${authCode}`;
```

- 员工 OpenID 登录成功后，`handleOpenIdCallback()` 也使用同样的隐藏 iframe 触发 deep link。

为了兼容旧版本客户端，网页端不能直接删除 deep link 代码。推荐改造为：

```ts
function resolveElectronCallbackUrl(authCode: string): string {
  const localRedirectUri = route.query.redirect_uri as string | undefined;
  const state = route.query.state as string | undefined;

  if (localRedirectUri && isAllowedLoopbackCallback(localRedirectUri)) {
    const callbackUrl = new URL(localRedirectUri);
    callbackUrl.searchParams.set('code', authCode);
    if (state) callbackUrl.searchParams.set('state', state);
    return callbackUrl.toString();
  }

  return `lobsterai://auth/callback?code=${encodeURIComponent(authCode)}`;
}
```

然后把普通 URS 登录和 OpenID 登录中重复的 iframe 逻辑抽为一个 helper：

```ts
function notifyElectronClient(authCode: string): void {
  const callbackUrl = resolveElectronCallbackUrl(authCode);

  if (callbackUrl.startsWith('http://127.0.0.1:')) {
    window.location.href = callbackUrl;
    return;
  }

  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.src = callbackUrl;
  document.body.appendChild(iframe);
  setTimeout(() => iframe.remove(), 3000);
}
```

新旧客户端兼容关系：

| 客户端版本 | 打开的登录 URL | 网页端行为 |
|------------|----------------|------------|
| 旧版本 | `#/login?source=electron` | 没有 `redirect_uri`，继续使用 `lobsterai://auth/callback?code=...` |
| 新版本 | `#/login?source=electron&redirect_uri=http%3A%2F%2F127.0.0.1%3A<port>%2Fauth%2Fcallback&state=...` | 优先跳转本地 callback URL |
| Web 普通登录 | `#/login` 或 `#/login?source=portal` | 不通知客户端，按现有页面逻辑进入 `/profile` |

Portal 侧 loopback 校验建议：

- 只允许 `http:` 协议。
- hostname 只允许 `127.0.0.1`；如确需支持本地开发可额外允许 `localhost`。
- pathname 必须为 `/auth/callback`。
- port 必须存在且为 `1..65535`。
- 不允许 URL 自带 `username`、`accessToken`、`refreshToken` 等敏感参数。

注意：如果使用 `window.location.href = http://127.0.0.1:<port>/auth/callback?...`，网页端会离开 portal 登录页并进入客户端本地成功页。客户端本地 server 应返回友好 HTML，避免用户看到空白页。

### 4.9 OpenID 员工登录参数透传

OpenID 员工登录当前通过 `handleOpenIdLogin()` 跳转后端：

```ts
params.set('source', openidSource);
params.set('callbackUrl', callbackUrl);
window.location.href = `${API_BASE_URL}/api/auth/openid/login?${params.toString()}`;
```

如果新客户端登录 URL 携带 `redirect_uri` 与 `state`，员工登录链路也需要保留这些参数。推荐：

- Portal 在 `handleOpenIdLogin()` 调用后端 `/api/auth/openid/login` 时带上 `redirect_uri` 和 `state`。
- 后端把这两个值放入 OpenID 流程 state 或服务端 session 中。
- 后端 302 回到 portal `callbackUrl` 时继续带回 `authCode`，Portal 再按 4.7 的统一 helper 通知客户端。

这样普通 URS 登录与 OpenID 登录都能支持新本地回调，同时旧客户端仍走 deep link。

## 5. 端口策略

### 5.1 不使用 智码 GLM Code 应用端口

不要复用 Vite dev server 的 `5175` 端口：

- `5175` 只在开发模式中存在。
- 生产应用没有 Vite dev server。
- 登录 callback 属于主进程能力，应独立于 renderer dev server。

### 5.2 不使用 OpenAI Codex OAuth 端口

不要复用 `1455`：

- `src/main/libs/openaiCodexAuth.ts` 已使用该端口处理 ChatGPT/Codex OAuth。
- 该流程因 OpenAI 注册的 redirect URI 限制必须固定端口。
- 智码 GLM Code 自有登录没有必要引入该冲突点。

### 5.3 推荐动态端口

使用：

```ts
server.listen(0, '127.0.0.1')
```

由操作系统分配空闲端口。启动成功后通过 `server.address()` 读取实际端口，生成：

```text
http://127.0.0.1:<actualPort>/auth/callback
```

这样端口冲突概率最低，也不需要维护端口保留表。

## 6. 涉及文件

| 文件 | 操作 |
|------|------|
| `src/main/libs/authLocalCallbackServer.ts` | 新建，本地 callback server、state 校验、HTML 响应、超时和关闭逻辑 |
| `src/main/libs/authCallbackRouter.ts` | 修改，增加直接处理 auth code 的公开方法 |
| `src/main/main.ts` | 修改 `auth:login`，启动本地 callback server，打开带 `redirect_uri` 的网页登录 URL，并在 callback 成功后聚焦主窗口 |
| `src/main/preload.ts` | 原则上无需修改；若新增 login 状态事件则需要暴露 |
| `src/renderer/services/auth.ts` | 原则上无需修改；继续调用 `window.electron.auth.login(loginUrl)` 并监听现有 callback |
| `src/shared/auth/constants.ts` | 如新增 IPC 事件或状态常量，则在此集中定义 |
| `src/main/libs/authLocalCallbackServer.test.ts` | 新建，覆盖 callback path、state、code、server close 等逻辑 |
| `src/main/libs/authCallbackRouter.test.ts` | 修改，覆盖直接投递 code 的 buffer/deliver 行为 |
| `/Users/admin/Desktop/disk/work/lobsterai-portal/src/views/LoginView.vue` | 修改，优先使用 `redirect_uri` 通知新客户端，并保留 deep link 兼容旧客户端 |
| `/Users/admin/Desktop/disk/work/lobsterai-portal/docs/server-integration/*` | 可选修改，补充 portal 与后端对 `redirect_uri` / `state` 的协作说明 |

## 7. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 用户关闭浏览器未完成登录 | 本地 server 等待至超时后自动关闭 |
| 用户重复点击登录 | 关闭旧 server，创建新 server 和新 state |
| callback 缺少 code | 返回失败页，不 exchange |
| callback state 不匹配 | 返回失败页，不 exchange |
| 非 `/auth/callback` 路径 | 返回 404 |
| server 启动失败 | 记录 warn/error，可 fallback 到 deep link 登录 |
| 网页端没有传回 state | 第一阶段可视为失败；如需灰度兼容，可用配置开关临时放宽 |
| 浏览器显示 `127.0.0.1` 地址 | 成功页文案解释登录已完成；页面不展示敏感信息 |
| 系统代理开启 | loopback 地址不应走远端代理；客户端只监听 127.0.0.1 |
| Windows 默认浏览器登录 | 使用普通 HTTP loopback callback；窗口恢复通过 Electron `restore/show/focus` 完成 |

## 8. 测试计划

### 8.1 单元测试

1. `authLocalCallbackServer` 启动后返回 `127.0.0.1` redirect URI，端口为实际动态端口。
2. `GET /auth/callback?code=abc&state=<valid>` 调用 `onCode('abc')`。
3. state 不匹配时不调用 `onCode`，返回失败 HTML。
4. 缺少 code 时不调用 `onCode`，返回失败 HTML。
5. 非 `/auth/callback` path 返回 404。
6. `close()` 可重复调用且不会抛错。
7. 超时后 server 自动关闭。
8. `AuthCallbackRouter.handleAuthCode()` 在 renderer ready 前会 buffer，在 ready 后会发送 `auth:callback`。

### 8.2 集成测试

1. 启动 Electron dev app。
2. 点击登录，确认系统浏览器打开的网页登录 URL 包含 `source=electron`、`redirect_uri`、`state`。
3. 模拟网页重定向到 `redirect_uri?code=test-code&state=<state>`。
4. 确认 renderer 收到 callback，并调用现有 `auth:exchange`。
5. 确认登录成功后 Redux auth 状态、quota、server models 与现有 deep link 流程一致。
6. 确认本地 callback server 在成功后关闭，再访问同一 callback URL 应连接失败或无响应。
7. 在 portal 登录页使用 `#/login?source=electron&redirect_uri=http%3A%2F%2F127.0.0.1%3A<port>%2Fauth%2Fcallback&state=abc`，普通 URS 登录成功后跳转到本地 callback URL。
8. 在 portal 登录页使用 `#/login?source=electron`，普通 URS 登录成功后仍触发 `lobsterai://auth/callback?code=...`。
9. 员工 OpenID 登录成功后同样遵循 `redirect_uri` 优先、deep link fallback 的规则。
10. 新本地 callback 收到合法 code 后，智码 GLM Code 主窗口会从最小化/后台状态恢复到前台。

### 8.3 回归测试

1. 现有 `lobsterai://auth/callback?code=...` deep link 仍可触发登录。
2. 应用未启动时由 deep link 冷启动，仍能 buffer auth code。
3. macOS `open-url` 与 Windows/Linux `second-instance` 逻辑不受影响。
4. 退出登录、token refresh、`auth:getUser`、`auth:getQuota` 行为不变。

## 9. 验收标准

1. 用户点击客户端登录后，浏览器打开网页登录页，不直接触发浏览器"打开 智码 GLM Code"系统确认框。
2. 网页登录成功后，浏览器跳转到 `127.0.0.1` 成功页，页面提示登录完成。
3. 客户端自动完成登录，用户信息和额度正常显示。
4. 登录过程中不使用固定端口；多次登录不会因为端口占用失败。
5. 登录成功、失败、取消或超时后，本地 callback server 均被关闭。
6. URL 中只出现一次性 auth code，不出现 accessToken 或 refreshToken。
7. 现有 deep link 登录路径仍可用。
8. `npm run lint` 通过。
9. 相关单元测试通过。

## 10. 实施步骤

1. 新建 `authLocalCallbackServer` 模块，实现动态端口、state 校验、HTML 响应和关闭逻辑。
2. 扩展 `AuthCallbackRouter`，增加直接投递 auth code 的方法，并补充测试。
3. 修改 `auth:login`，先启动本地 callback server，再打开携带 `redirect_uri` 和 `state` 的登录 URL。
4. 与网页端联调 `redirect_uri` 参数透传和 loopback 白名单校验。
5. 保留 deep link fallback，灰度观察登录成功率和错误日志。
6. 验收通过后，将网页登录完成页中的"打开 智码 GLM Code"引导降级为 fallback 入口。
