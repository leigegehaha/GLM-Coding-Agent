# 启动阶段 OpenClaw Gateway 综合优化

## 1. 概述

### 1.1 问题/动机

应用启动时，OpenClaw gateway 进程需要 ~40s 完成初始化（主要耗时在 `authBootstrap` 33.8s）。在此期间，智码 GLM Code 主进程因多个异步流程并行执行，反复写入 `openclaw.json`，触发 gateway 在启动过程中做多余的 plugin reload。

观察到的现象：
- 启动阶段插件 `register()` 被调用 4 次（正常应为 1-2 次）
- Gateway 日志出现 `[reload] config change requires gateway restart ... deferring until N task run(s) complete`

### 1.2 根因分析

启动时序中存在两个问题：

**问题 1：media-generation 插件配置动态变化**

`lobster-media-generation` 插件的 `enabled` 字段依赖 `canUseMediaGeneration`（订阅状态），导致 entitlement 变化时插件配置发生变更，触发 gateway restart。而实际权限校验在 智码 GLM Code 回调侧已有兜底（`resolveMediaGenerationGate`），插件本身无需动态开关。

**问题 2：启动阶段缓存冷启动导致多余 sync**

| 缓存 | 初始值 | 首次真实值来源 | 结果 |
|------|--------|--------------|------|
| `cachedSubscriptionStatus` | `'free'` | renderer `auth:getUser` → quota | 必然变化 → 触发 sync |
| `serverModelMetadataCache` | 空 Map | renderer `auth:getModels` | 必然变化 → 触发 sync |

这些 sync 发生在 gateway 还在启动的 33.8s 窗口内，openclaw.json 的变更被 chokidar 检测到，导致 gateway 做额外的 plugin cache reload。

启动时序：
```
10:35:33  syncOpenClawConfig('startup')              ← 第1次写入
10:35:36  syncOpenClawConfig('im-gateway-start-batch')
10:35:36  startGateway() fork                        ← gateway 进程启动
10:35:36  syncOpenClawConfig('ensureRunning:mcpConfig')
          ┄┄ renderer 启动 ┄┄
10:35:44  syncOpenClawConfig('media-entitlement-changed')  ← 多余！
10:35:45  syncOpenClawConfig('server-models-updated')       ← 多余！
          ┄┄ gateway 还在 authBootstrap ┄┄
10:36:36  gateway ready
```

### 1.3 目标

1. `lobster-media-generation` 插件配置固定，不因 entitlement 变化触发 gateway restart
2. 启动阶段在首次 sync 之前预热 quota 和 model 缓存，使后续 renderer 触发的刷新不产生状态变化
3. 减少启动阶段插件 register 次数至正常水平（1-2 次）

## 2. 现状分析

### 2.1 相关 OpenClaw 问题

| Issue | 描述 |
|-------|------|
| openclaw/openclaw#87285 | Gateway frequent restarts: config reload too aggressive |
| openclaw/openclaw#75298 | Webhook plugin re-registers repeatedly whenever event loop saturates |
| openclaw/openclaw#80131 | per-request auth and tool bundling dominate gateway TTFT |

OpenClaw 侧 `plugins.*` 路径一律触发 gateway restart（`config-reload-plan.ts`），粒度过粗。但这是上游问题，本次优化从 智码 GLM Code 侧减少不必要的配置变更。

### 2.2 现有 syncOpenClawConfig 调用点（启动相关）

- `reason='startup'` — initApp 主流程
- `reason='im-gateway-start-batch:...'` — IM channel 启动
- `reason='ensureRunning:mcpConfig'` — 确保 gateway 运行前的 config 同步
- `reason='media-entitlement-changed'` — subscription 状态变化（多余）
- `reason='server-models-updated'` — 模型列表变化（多余）

## 3. 方案设计

### 3.1 Fix 1：media-generation 插件配置固定化

将 `lobster-media-generation` 的 `enabled` 始终设为 `true`，plugin config 的写入不再依赖 `canUseMediaGeneration` 条件。

权限校验由 智码 GLM Code 回调端兜底：
- `mcpBridgeServer.onMediaGeneration` — handler 未就绪时返回 error
- `resolveMediaGenerationGate()` — tool/action 级别拦截
- UI 层 — 未付费用户无法选择 media model

### 3.2 Fix 2：启动时预热 quota 和 model 缓存

在 `syncOpenClawConfig('startup')` 之前，并行请求 `/api/user/quota` 和 `/api/models/available`：

- 成功：填充 `cachedSubscriptionStatus`、`cachedMediaGenerationEntitled`、`serverModelMetadataCache`，使 startup sync 生成正确配置
- 失败：静默忽略，回退到当前行为（startup sync 用默认值，后续 renderer 触发补充 sync）

条件：仅在 `getAuthTokens()` 存在时执行（未登录用户跳过）。

超时：5s（`AbortSignal.timeout`），避免网络问题阻塞启动。

## 4. 实施步骤

### Step 1：media-generation 插件配置固定化（已完成）

文件：`src/main/libs/openclawConfigSync.ts`

- L1630：`enabled: canUseMediaGeneration` → `enabled: true`
- L1704：去掉 `canUseMediaGeneration &&` 条件

### Step 2：启动时预热缓存

文件：`src/main/main.ts`

在 `startCoworkOpenAICompatProxy()` 之后、`syncOpenClawConfig('startup')` 之前插入预热代码块：

```typescript
// ── Pre-warm quota & model caches so startup sync generates correct config ──
if (getAuthTokens()) {
  const serverBaseUrl = getServerApiBaseUrl();
  const warmupTimeout = 5000;
  await Promise.allSettled([
    // Quota → cachedSubscriptionStatus + cachedMediaGenerationEntitled
    (async () => {
      const resp = await fetchWithAuth(`${serverBaseUrl}/api/user/quota`, {
        signal: AbortSignal.timeout(warmupTimeout),
      });
      if (!resp.ok) return;
      const body = await resp.json();
      if (body.code !== 0 || !body.data) return;
      const quota = normalizeAuthQuota(body.data, { ... });
      const gateState = authQuotaGateStateFromQuota(quota);
      cachedSubscriptionStatus = gateState.subscriptionStatus;
      cachedMediaGenerationEntitled = gateState.mediaGenerationEntitled;
    })(),
    // Models → serverModelMetadataCache
    (async () => {
      const url = appendKeyfromQuery(`${serverBaseUrl}/api/models/available`);
      const resp = await fetchWithAuth(url, {
        signal: AbortSignal.timeout(warmupTimeout),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.code !== 0 || !data.data) return;
      updateServerModelMetadata(data.data);
    })(),
  ]);
}
```

## 5. 涉及文件

| 文件 | 改动 |
|------|------|
| `src/main/libs/openclawConfigSync.ts` | Fix 1: 插件配置固定化（2 行） |
| `src/main/main.ts` | Fix 2: 启动预热代码块 |
| `src/main/main.ts` | Fix 3: 预热提前 + agent model 迁移去重 |
| `src/main/libs/resolveStdioCommand.ts` | Fix 4: MCP resolve 去除 API config 依赖 |

## 6. 后续改动（2026-05-29）

### 6.1 Fix 3：预热提前至 agent model 迁移之前 + 去重

**问题**：`resolveDefaultAgentModelRef()` 和 `migrateAgentModelRefs()` 在预热代码块之前执行，此时 `serverModelMetadataCache` 为空，`resolveMatchedProvider` 无法匹配 `lobsterai-server` provider 的模型。另外 `migrateAgentModelRefs()` 内部重复调用了 `resolveDefaultAgentModelRef()`。

**改动**：
- 将启动顺序调整为：proxy → pre-warm → agent model migration → syncConfig
- `migrateAgentModelRefs()` 接受可选参数 `precomputedDefaultModelRef`，避免重复计算

文件：`src/main/main.ts`

### 6.2 Fix 4：resolveStdioCommand 去除对 getEnhancedEnv 的依赖

**问题**：每次 `syncOpenClawConfig` 时，`getResolvedMcpServers()` 对每个 stdio MCP server 调用 `resolveStdioCommand()`，其中 `getEnhancedEnv()` 触发完整的 API config 解析（`resolveCurrentApiConfig → resolveMatchedProvider → tryLobsteraiServerFallback`）。3 次 sync × 3 个 MCP servers = 9 次多余的 provider 解析。

**分析**：`resolveStdioCommand` 调用 `getEnhancedEnv()` 只使用了返回值中的 `LOBSTERAI_NPM_BIN_DIR`，该值仅依赖 `process.resourcesPath`，是打包时的固定路径，不需要 API config、proxy 解析等开销。

**改动**：引入轻量函数 `getPackagedNpmBinDir()` 替代 `getEnhancedEnv()`：

```typescript
function getPackagedNpmBinDir(): string | undefined {
  if (!app.isPackaged) return undefined;
  const npmBinDir = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'npm', 'bin');
  return fs.existsSync(npmBinDir) ? npmBinDir : undefined;
}
```

文件：`src/main/libs/resolveStdioCommand.ts`

### 6.3 效果

启动期间 `tryLobsteraiServerFallback` 调用次数：

| 场景 | 优化前 | 优化后 |
|------|--------|--------|
| `resolveDefaultAgentModelRef` | 1 | 1（但 cache 已热，正常 match） |
| `migrateAgentModelRefs` | 1（重复） | 0（复用结果） |
| `syncOpenClawConfig('startup')` 内 MCP resolve | 3 | 0 |
| `syncOpenClawConfig('im-gateway-start-batch')` 内 MCP resolve | 3 | 0 |
| `syncOpenClawConfig('ensureRunning:mcpConfig')` 内 MCP resolve | 3 | 0 |
| sync 本身的 `resolveRawApiConfig` | 3 | 3（正常路径） |
| 渲染进程 `checkApiConfig` | 2 | 2（正常路径） |
| **合计** | ~15 | ~6 |

### 6.4 Fix 5：dev 模式下 npm shim 路径修复

**问题**：`moltbot-popo` 插件启动时调用 `execFileSync("npm", ["install", "-g", "@fabric/cli", ...])` 安装 fabric-cli。Gateway 进程通过 npm.cmd shim 执行 npm，shim 内部引用 `%LOBSTERAI_NPM_BIN_DIR%\npm-cli.js`。但 dev 模式下 `npmBinDir` 为 `undefined`，导致 env var 为空字符串，路径解析为 `D:\npm-cli.js`（cwd 盘符根），报 `Cannot find module 'D:\npm-cli.js'`。

**根因**：`fee342d0` 引入 gateway node/npm shim 注入时，`npmBinDir` 仅在 `app.isPackaged` 时赋值，dev 模式遗漏。

**改动**：

文件：`src/main/libs/openclawEngineManager.ts`

```typescript
// Before
const npmBinDir = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'npm', 'bin')
  : undefined;

// After
const npmBinDir = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'npm', 'bin')
  : path.join(app.getAppPath(), 'node_modules', 'npm', 'bin');
```

**验证**：启动后 gateway 日志中 `fabric-cli installed successfully` 取代此前的 `fabric-cli install failed: Cannot find module 'D:\npm-cli.js'`。

## 7. 验证计划

1. **正常启动**：观察 `main-*.log` 中 `syncOpenClawConfig START`，启动阶段不应出现 `media-entitlement-changed` 或 `server-models-updated`
2. **Gateway 日志**：`gateway-*.log` 中 plugin registration 次数从 4 降至 1-2
3. **网络异常回退**：断网启动时行为与当前一致（预热超时后正常启动）
4. **未登录用户**：无 auth token 时跳过预热，行为不变
5. **登出/登入**：entitlement 变化仍正确同步（不影响运行时 sync 逻辑）
6. **MCP server 正常启动**：3 个 stdio MCP server（Context7、Tavily、Playwright）仍正确解析 npx 命令
7. **Fallback 日志减少**：启动期间 `lobsterai-server fallback activated` 日志从 ~15 次降至 ~6 次
8. **fabric-cli 安装**：dev 模式启动后 gateway 日志显示 `fabric-cli installed successfully`（或 `fabric-cli detected`）
