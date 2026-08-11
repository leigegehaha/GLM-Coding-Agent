# 浏览器设置设计文档

## 1. 概述

### 1.1 问题/背景

智码 GLM Code 当前通过 OpenClaw 提供 `browser` 和 `web_fetch` 能力，但浏览器相关配置在 智码 GLM Code 中几乎没有产品化暴露。当前同步到 `openclaw.json` 的配置只有：

```typescript
browser: {
  enabled: true,
}
```

这导致用户遇到浏览器任务失败时无法在设置页自行调整，只能修改底层配置或关闭代理。

近期问题暴露出两个主要失败来源：

1. **全局系统代理与 browser 严格 SSRF 策略冲突**
   - 智码 GLM Code 的“使用系统代理”会把系统代理写入进程环境变量，并传给 OpenClaw gateway。
   - OpenClaw browser 默认将未配置的 `browser.ssrfPolicy` 解析为 fail-closed 严格策略。
   - 当 gateway 进程存在 `HTTP_PROXY` / `HTTPS_PROXY` 等环境变量时，browser 导航会报错：`strict browser SSRF policy cannot be enforced while env proxy variables are set`。
   - 对 智码 GLM Code 本地桌面应用来说，默认拦截牺牲了常见浏览器任务成功率。

2. **`web_fetch` 被用来抓搜索结果页，容易触发 429**
   - 当前 智码 GLM Code 管理配置中禁用了内置 `web_search`，agent 容易退化为用 `web_fetch` 抓 Google 搜索页。
   - Google 等站点会对代理出口、自动化请求或频繁访问返回 429 / CAPTCHA。
   - `SECURITY NOTICE / EXTERNAL_UNTRUSTED_CONTENT` 是 OpenClaw 对外部内容的安全包装，不是失败根因。

因此需要新增一个用户可见的“浏览器”设置页，优先管理 browser 的网络访问模式和少量可理解配置。默认策略应优先保证浏览器任务可用，同时提供用户主动开启的严格保护模式。`web_fetch` 继续使用默认配置，不在该页暴露底层参数。

### 1.2 目标

- 新增“浏览器”设置页，集中管理 browser 的常用配置。
- 保留“系统代理作为全局代理”的产品语义，不把代理限制到模型调用。
- 不默认开启系统代理；当用户已开启 智码 GLM Code 的“使用系统代理”时，browser 默认采用代理兼容策略，减少全局代理环境下的导航失败。
- 严格 SSRF / 内网访问防护改为用户主动开启，而不是默认阻断常见浏览器任务。
- 普通用户第一屏只暴露少量易理解选项：网络访问模式、允许页面内执行脚本、无界面运行浏览器、允许的域名、屏蔽的域名。
- 不展示“启用浏览器”“我的 Chrome”“远程 CDP”“网页抓取参数”等容易造成误解或隐藏失败的设置。

### 1.3 非目标

- 不在本次设计中实现完整搜索 provider 接入；仅预留入口并调整工具路由建议。
- 不保证 Google 搜索页、X 等反自动化站点一定可被 `web_fetch` 成功抓取。
- 不把所有 OpenClaw browser CLI 能力都暴露到设置页；低频和危险项放入高级区域。

### 1.4 产品设计原则

- **先让普通用户能用。** 默认页只提供和任务成功率直接相关的选择，不要求用户理解 SSRF、CDP、User-Agent、RFC 2544 等术语。
- **用用户语言包装底层配置。** 例如 UI 显示“优先保证网页能打开（推荐）”，实现上再映射到 `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork = true`。
- **只保留必要高级项。** 不把 CDP、User-Agent、RFC 2544、启动参数等底层能力放进普通设置页。
- **不主动改变全局代理状态。** 浏览器页只能选择是否跟随现有“使用系统代理”总开关，不负责自动打开系统代理。

## 2. 用户场景

### 场景 1: 开启系统代理后浏览器仍可打开网页

**Given** 用户开启了 智码 GLM Code 的“使用系统代理”
**When** agent 调用 browser 打开普通公网网页
**Then** 默认使用“优先保证网页能打开（推荐）”模式，browser 不应因为严格 SSRF 策略与 env proxy 冲突而直接失败

### 场景 2: 默认使用独立浏览器

**Given** 用户打开浏览器设置页
**When** 用户保存任意浏览器设置
**Then** OpenClaw 使用 `openclaw` managed profile，不展示也不写入 `user` / existing-session profile

### 场景 3: 用户需要更强网络安全隔离

**Given** 用户担心 agent 被网页内容诱导访问本机或内网地址
**When** 用户开启“严格保护本机和内网”
**Then** browser 导航启用严格 SSRF 策略，默认阻止 private/internal/special-use 网络目标，并允许用户配置窄域名例外

### 场景 4: 用户需要控制脚本执行或无界面运行

**Given** 用户需要更保守的页面执行策略，或需要后台运行浏览器
**When** 用户修改“允许页面内执行脚本”或“无界面运行浏览器”
**Then** OpenClaw 只同步对应 browser 配置，不暴露 CDP、启动参数等高门槛设置

### 场景 5: 用户配置域名规则

**Given** 用户开启严格网络保护，或希望阻止特定域名
**When** 用户填写“允许的域名”或“屏蔽的域名”
**Then** 智码 GLM Code 保存清洗后的域名列表；允许列表同步到 browser SSRF policy，屏蔽列表作为 智码 GLM Code 侧规则预留

## 3. 功能需求

### FR-1: 新增设置页入口

- 在设置侧边栏新增“浏览器”。
- 页面采用少量常用项优先的布局，避免把底层 browser / web_fetch 参数暴露给普通用户。
- 基础区域只展示普通用户需要理解的选项：
  - 网络访问模式
- 高级区域只保留少量能解释清楚的配置：
  - 允许页面内执行脚本
  - 无界面运行浏览器
  - 安全和域名规则
- 所有文案进入 renderer i18n，中英文都要补齐。

### FR-2: 浏览器基础配置

- 不展示“启用浏览器工具”开关，智码 GLM Code 始终开启 browser tool。
- 不展示“使用哪种浏览器”选择，当前版本统一使用 智码 GLM Code 独立浏览器。
- 不展示“我的 Chrome / user profile”，避免用户选择后触发 existing-session attach 失败。
- 不展示“自定义浏览器 / 远程浏览器 / CDP / Browserless”等高级连接项。
- 默认值：
  - `enabled = true`
  - `defaultProfile = "openclaw"`

### FR-3: 网络策略配置

- 基础区域提供“网络访问模式”二选一：
  - 优先保证网页能打开（推荐）：默认值。跟随应用现有“使用系统代理”总开关，并使用代理兼容策略。
  - 严格保护本机和内网：用户主动开启后，阻止访问本机、内网和特殊地址段。
- “跟随应用全局代理”不作为独立开关暴露，避免用户误解为“默认开启系统代理”。
  - 在推荐模式下，browser / web_fetch 默认跟随 智码 GLM Code 现有的“使用系统代理”总开关。
  - 如果应用全局系统代理未开启，推荐模式不会主动打开系统代理。
- 在当前 OpenClaw 能力下：
  - 推荐模式可通过写入 `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork = true` 实现第一阶段兼容。
  - 严格保护模式写入 `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork = false`。
  - 当严格保护模式与系统代理同时开启时，UI 要提示可能重新出现 SSRF/env proxy 阻断。

### FR-4: 域名规则

- 域名规则属于高级设置，默认不在基础区域展示。
- 提供“允许的域名”列表。
  - 映射 `browser.ssrfPolicy.allowedHostnames` / `hostnameAllowlist`。
  - 支持 exact hostname 和 `*.example.com`。
- 提供“屏蔽的域名”列表。
  - OpenClaw 当前 browser 配置没有对应字段，第一阶段可仅作为 智码 GLM Code 侧配置预留。
  - 第二阶段在 OpenClaw browser 导航 guard 或 智码 GLM Code tool 调用前增加拦截。
- 屏蔽规则优先级高于允许规则。

### FR-5: 网页抓取配置

- 设置页不展示 `web_fetch` 配置。
- `web_fetch` 继续使用默认值，避免把 timeout、redirects、User-Agent、RFC 2544 fake-IP 等底层参数暴露给普通用户。
- 后续如需调试 `web_fetch`，应另设开发者/诊断入口，不放在浏览器基础设置页。
- OpenClaw 当前普通 `web_fetch` 没有配置化的 `useEnvProxy`，需要新增底层配置，例如：

```typescript
tools: {
  web: {
    fetch: {
      useEnvProxy: true,
    },
  },
}
```

### FR-6: 诊断能力

- 设置页不展示诊断按钮，保持页面聚焦在少量可理解配置上。
- 诊断 IPC 可以保留给后续开发者入口或问题排查使用。
- 如后续重新加入诊断，应避免展示 CDP、profile、executable path 等底层术语给普通用户。

### FR-7: 浏览器高级配置

高级配置只包含：

- 允许页面内执行 JS，映射 `browser.evaluateEnabled`。
- 无界面运行浏览器，映射 `browser.headless`。
- 允许的域名，映射 `browser.ssrfPolicy.allowedHostnames` / `hostnameAllowlist`。
- 屏蔽的域名，第一阶段作为 智码 GLM Code 侧配置预留。

以下项目不在设置页展示，也不应继续从旧配置同步到 OpenClaw，避免隐藏配置继续影响用户：

- `browser.defaultProfile = "user"` / “我的 Chrome”
- `browser.enabled = false`
- `browser.executablePath`
- `browser.cdpUrl`
- `browser.attachOnly`
- `browser.remoteCdpTimeoutMs`
- `browser.remoteCdpHandshakeTimeoutMs`
- `browser.extraArgs`
- `tools.web.fetch.*` 高级参数

### FR-8: 配置保存与生效

- 设置保存到 SQLite `app_config`。
- 保存后通过 `OpenClawConfigSync` 生成 `openclaw.json`。
- 影响 OpenClaw gateway 启动参数或配置解析的设置保存后提示需要重启 gateway。
- 可以复用现有“保存设置后同步 OpenClaw 配置并重启 gateway”的链路。

## 4. 实现方案

### 4.1 配置模型

在 `AppConfig` 中新增 `browserWebAccess` 配置。实现时不要使用裸字符串作为状态值，应按 AGENTS.md 要求定义集中常量。

建议结构：

```typescript
export const BrowserProfileMode = {
  Managed: 'managed',
  User: 'user',
  Custom: 'custom',
} as const;

export const BrowserNetworkMode = {
  ProxyCompatible: 'proxy-compatible',
  Strict: 'strict',
} as const;

export const BrowserSnapshotMode = {
  Default: 'default',
  Efficient: 'efficient',
} as const;

export type BrowserWebAccessConfig = {
  browserEnabled: boolean;
  profileMode: BrowserProfileMode;
  networkMode: BrowserNetworkMode;
  followGlobalProxy: boolean;
  allowedHostnames: string[];
  blockedHostnames: string[];
  snapshotMode: BrowserSnapshotMode;
  evaluateEnabled: boolean;
  executablePath?: string;
  cdpUrl?: string;
  headless?: boolean;
  attachOnly?: boolean;
  remoteCdpTimeoutMs?: number;
  remoteCdpHandshakeTimeoutMs?: number;
  extraArgs?: string[];
  webFetch: {
    enabled: boolean;
    followGlobalProxy: boolean;
    timeoutSeconds?: number;
    maxRedirects?: number;
    maxChars?: number;
    userAgent?: string;
    readability?: boolean;
    allowRfc2544BenchmarkRange?: boolean;
  };
};
```

默认值：

| 字段 | 默认值 |
|------|--------|
| `browserEnabled` | `true` |
| `profileMode` | `managed` |
| `networkMode` | `proxy-compatible` |
| `followGlobalProxy` | `true`（仅跟随应用总开关，不主动开启系统代理） |
| `allowedHostnames` | `[]` |
| `blockedHostnames` | `[]` |
| `snapshotMode` | `efficient` |
| `evaluateEnabled` | `true` |
| `webFetch.enabled` | `true` |
| `webFetch.followGlobalProxy` | `true`（仅跟随应用总开关，不主动开启系统代理） |
| `webFetch.readability` | `true` |

### 4.2 OpenClaw browser 配置映射

`OpenClawConfigSync` 根据 `browserWebAccess` 生成：

```typescript
browser: {
  enabled: true,
  defaultProfile: 'openclaw',
  evaluateEnabled,
  ...(headless ? { headless: true } : {}),
  ssrfPolicy: buildBrowserSsrFPolicy(browserWebAccess),
}
```

`buildBrowserSsrFPolicy` 规则：

| 用户选择 | 内部模式 | 输出 |
|------|------|------|
| 优先保证网页能打开（推荐） | `proxy-compatible` | `{ dangerouslyAllowPrivateNetwork: true }` |
| 严格保护本机和内网，无允许域名 | `strict` | `{ dangerouslyAllowPrivateNetwork: false }` |
| 严格保护本机和内网，有允许域名 | `strict` | `{ dangerouslyAllowPrivateNetwork: false, hostnameAllowlist, allowedHostnames }` |

说明：第一阶段使用 OpenClaw 现有 `dangerouslyAllowPrivateNetwork` 字段解决 env proxy 与 browser SSRF 的冲突。第二阶段可推动 OpenClaw 增加更准确的 `browser.networkMode = "proxy-compatible"` 语义，避免长期依赖带有 `dangerously` 命名的字段。

### 4.3 Browser target 策略

智码 GLM Code 当前版本不支持 sandbox browser，因此设置页不提供 sandbox / host / node 的目标选择。

- 所有 `browser` 工具调用必须显式使用 `target="host"`。
- 不允许模型主动使用 `target="sandbox"` 或 `target="node"`。
- 如果 OpenClaw 返回 `Sandbox browser is unavailable`，应使用同样参数改为 `target="host"` 重试。
- 该策略先通过 智码 GLM Code 托管的 AGENTS 指令下发；如果后续仍出现模型误传 `target="sandbox"`，再推动 OpenClaw browser 插件增加 智码 GLM Code 侧的 target override 或禁用 sandbox target。

### 4.4 web_fetch 配置映射

生成：

```typescript
tools: {
  web: {
    fetch: {
      enabled,
      timeoutSeconds,
      maxRedirects,
      maxChars,
      userAgent,
      readability,
      useEnvProxy: followGlobalProxy && useSystemProxy,
      ssrfPolicy: {
        allowRfc2544BenchmarkRange,
      },
    },
  },
}
```

需要在 OpenClaw 中补齐：

- `types.tools.ts` 增加 `tools.web.fetch.useEnvProxy?: boolean`。
- zod schema 和 generated schema 接受该字段。
- `web-fetch.ts` 在调用 `fetchWithWebToolsNetworkGuard` 时传入 `useEnvProxy: fetch?.useEnvProxy === true`。
- 测试覆盖：
  - `useEnvProxy=false` 时保持 strict pinned dispatcher。
  - `useEnvProxy=true` 且存在 env proxy 时使用 trusted env proxy mode。

### 4.5 设置页 UI

`Settings.tsx` 增加新的 tab：

```typescript
type TabType = ... | 'browserWebAccess';
```

推荐新增独立组件：

| 文件 | 职责 |
|------|------|
| `src/renderer/components/settings/BrowserWebAccessSettings.tsx` | 设置页主体 |
| `src/renderer/components/settings/browserWebAccessConstants.ts` | 前端常量、默认值、选项 |
| `src/renderer/components/settings/browserWebAccessTypes.ts` | 类型定义 |

UI 交互：

- 第一屏避免出现底层术语，推荐布局：

| 区域 | 控件 | 默认 | 说明 |
|------|------|------|------|
| 网络 | 网络访问模式 | 优先保证网页能打开（推荐） | 另一个选项为“严格保护本机和内网” |
| 高级设置 | 允许页面内执行脚本 | 开启 | 关闭后更保守，但复杂网页操作可能不可用 |
| 高级设置 | 无界面运行浏览器 | 关闭 | 适合自动化环境，日常桌面使用不建议开启 |
| 高级设置 | 允许的域名 | 空 | 严格保护模式下仍允许访问的域名 |
| 高级设置 | 屏蔽的域名 | 空 | 预留为 智码 GLM Code 侧导航拦截规则 |

- 网络模式使用分段选择：
  - 优先保证网页能打开（推荐）
  - 严格保护本机和内网
- hostnames 去空格、去协议、去路径。

文案要求：

- 基础区域不直接显示 `SSRF`、`CDP`、`env proxy`、`RFC 2544`。
- 高级区域也尽量不展示这些术语，只在必要说明中使用用户能理解的描述。
- 推荐项需要明确标注“推荐”，避免用户需要理解底层差异才能选择。

### 4.6 诊断 IPC

新增 browser diagnostic IPC，避免前端直接理解 OpenClaw browser HTTP API。

建议接口：

| IPC Channel | 参数 | 返回 |
|-------------|------|------|
| `openclaw:browser:getStatus` | `{ profile?: string }` | browser status |
| `openclaw:browser:listProfiles` | none | profiles |
| `openclaw:browser:test` | `{ profile?: string }` | 分步诊断结果 |
| `openclaw:browser:resetProfile` | `{ profile: 'openclaw' }` | reset result |

诊断结果结构：

```typescript
export const BrowserDiagnosticStep = {
  GatewayStatus: 'gateway-status',
  Profiles: 'profiles',
  BrowserStatus: 'browser-status',
  BrowserStart: 'browser-start',
  OpenTestPage: 'open-test-page',
} as const;
```

每一步返回 `status: 'success' | 'warning' | 'error'`、`message` 和可选 `details`。

### 4.7 工具路由提示

更新 OpenClaw system prompt 片段：

- 搜索发现优先使用可用搜索工具或 browser。
- 不要用 `web_fetch` 抓 Google 搜索结果页作为搜索工具替代。
- 已知文章 URL、文档 URL、轻量页面使用 `web_fetch`。
- 登录态、JS-heavy、反自动化页面使用 `browser`。
- 使用 `browser` 时必须显式设置 `target="host"`，因为 智码 GLM Code 当前不支持 sandbox browser。

这不能彻底解决 Google 429，但能减少错误工具选择导致的失败。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 系统代理开启 + “优先保证网页能打开（推荐）” | browser 写入 `dangerouslyAllowPrivateNetwork: true`，优先保证可用 |
| 系统代理开启 + “严格保护本机和内网” | UI 显示风险提示；保存后允许用户主动承担可能失败的结果 |
| 旧配置里保存过“我的 Chrome” | 同步时强制写入独立浏览器 `defaultProfile: "openclaw"` |
| 旧配置里保存过 remote CDP、浏览器路径或启动参数 | 设置页不展示，且同步时不继续写入 OpenClaw |
| `web_fetch` 抓 Google 搜索页返回 429 | 归类为目标站点/反自动化失败，提示改用 browser 或搜索 provider |
| 模型生成 `browser target="sandbox"` | 不提供用户选择；托管 AGENTS 指令要求改用 `target="host"`，遇到 sandbox unavailable 后用 host 重试 |
| “严格保护本机和内网”允许列表为空 | 默认阻止 private/internal/special-use 地址 |
| 域名同时出现在允许和屏蔽列表 | 屏蔽优先 |
| Windows 路径中的反斜杠 | 输入保留原文，写入前不做破坏性规范化 |
| 设置保存后 gateway 正在运行 | 使用现有重启流程；若重启失败，设置保留但提示未生效 |

## 6. 涉及文件

### 智码 GLM Code

| 文件 | 变更 |
|------|------|
| `src/renderer/config.ts` | 增加 `browserWebAccess` 默认配置和类型 |
| `src/renderer/components/Settings.tsx` | 增加设置页 tab |
| `src/renderer/components/settings/BrowserWebAccessSettings.tsx` | 新增设置页组件 |
| `src/renderer/services/i18n.ts` | 新增中英文文案 |
| `src/main/main.ts` | 扩展 `AppConfigSettings`，新增 browser diagnostic IPC |
| `src/main/preload.ts` | 暴露 browser diagnostic API |
| `src/main/libs/openclawConfigSync.ts` | 生成 browser 和 tools.web.fetch 配置；下发 browser 必须使用 `target="host"` 的托管策略 |
| `src/main/libs/systemProxy.ts` | 复用系统代理状态；必要时暴露当前代理解析结果 |

### OpenClaw runtime

| 文件 | 变更 |
|------|------|
| `src/config/types.tools.ts` | 增加 `tools.web.fetch.useEnvProxy` |
| `src/config/zod-schema.agent-runtime.ts` | 接受 `useEnvProxy` |
| `src/agents/tools/web-fetch.ts` | 将配置传给 `fetchWithWebToolsNetworkGuard` |
| `src/agents/tools/web-tools.fetch.test.ts` | 覆盖 env proxy 模式 |
| `extensions/browser/src/browser/config.ts` | 第二阶段可新增更准确的 browser network mode |

## 7. 实施步骤

### 阶段 1: 最小可用

1. 新增 智码 GLM Code `browserWebAccess` 配置模型和默认值。
2. 新增“浏览器”设置页。
3. 第一屏只实现普通用户选项：网络访问模式、允许页面内执行脚本、无界面运行浏览器、允许的域名、屏蔽的域名。
4. `OpenClawConfigSync` 固定写入 browser enabled、managed defaultProfile、ssrfPolicy、evaluateEnabled、headless。
5. 在“优先保证网页能打开（推荐）”模式下，解决系统代理导致 browser 直接失败的问题。
6. 在托管 AGENTS 指令中固定 `browser target="host"`，避免当前不支持的 sandbox browser 调用。
7. 不展示“我的 Chrome”、CDP、启动参数、网页抓取等高级入口。

### 阶段 2: web_fetch 代理兼容

1. 在 OpenClaw 增加 `tools.web.fetch.useEnvProxy`。
2. 智码 GLM Code 根据全局代理和默认配置写入该配置，不在浏览器设置页展示。
3. 补充 `web_fetch` 代理模式测试。
4. 更新工具路由提示，减少用 `web_fetch` 抓搜索结果页。

### 阶段 3: 高级能力

1. 域名屏蔽列表的实际导航拦截。
2. 开发者诊断入口。
3. 搜索 provider 设置入口。
4. 更细粒度的 OpenClaw browser `networkMode`，替代 `dangerouslyAllowPrivateNetwork` 的产品语义。

## 8. 验收标准

- 默认配置下，设置页 tab 和标题显示“浏览器”。
- 默认配置下，设置页只显示网络访问模式、允许页面内执行脚本、无界面运行浏览器、允许的域名、屏蔽的域名。
- 默认配置下，设置页不出现 `SSRF`、`CDP`、`env proxy`、`RFC 2544`、User-Agent、启动参数等底层术语。
- 默认配置下，OpenClaw browser 始终启用并使用独立浏览器 `defaultProfile: "openclaw"`。
- 默认配置下，托管 AGENTS 指令要求 `browser` 工具调用显式使用 `target="host"`，不暴露 sandbox target 选择。
- 开启系统代理后，browser 打开 `https://example.com` 不再因 `strict browser SSRF policy cannot be enforced while env proxy variables are set` 失败。
- 开启“严格保护本机和内网”后，browser 对 private/internal/special-use 地址执行严格拦截。
- 设置页不展示“我的 Chrome”，即使旧配置保存过 `profileMode: "user"`，同步到 `openclaw.json` 时也使用 `defaultProfile: "openclaw"`。
- 设置页不展示 `web_fetch` 配置。
- `web_fetch.useEnvProxy` 开启时，OpenClaw 普通 web_fetch 请求使用 env proxy 模式。
- 所有新增用户可见文案均走 i18n。
- 配置状态值使用集中 `as const` 常量，不引入裸字符串判定。

## 9. 验证计划

- 单元测试：
  - `OpenClawConfigSync` 生成不同 browser 网络模式配置。
  - `OpenClawConfigSync` 固定生成 managed browser profile。
  - `OpenClawConfigSync` 不从隐藏旧配置写入 CDP、executable path、attachOnly、extraArgs 等 browser 字段。
  - `OpenClawConfigSync` 生成 web_fetch 默认配置。
  - hostname 列表清洗和校验。
  - `web_fetch.useEnvProxy` 的 OpenClaw runtime 行为。
- 手动验证：
  - 系统代理关闭：browser 打开 `https://example.com`。
  - 系统代理开启 + “优先保证网页能打开（推荐）”：browser 打开 `https://example.com`。
  - 系统代理开启 + “严格保护本机和内网”：确认显示风险提示，且内网/本机访问被拦截。
  - 旧配置中存在 `profileMode: "user"` 时，保存/同步后 browser 仍使用 managed profile。
  - `web_fetch` 普通文章 URL 可返回正文，Google 搜索页 429 时提示为目标站点限制。
