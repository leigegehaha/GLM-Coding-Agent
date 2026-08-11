# 微信扫码成功后 Gateway 不重启导致消息不通修复 Spec

## 1. 概述

### 1.1 问题

用户在 IM 设置中完成微信扫码后，界面提示“与微信连接成功”，但随后通过微信发消息没有进入 智码 GLM Code。用户再次打开钉钉配置测试时，发现钉钉配置完成后会重启 OpenClaw gateway，并且钉钉消息可以正常触发任务。

日志能复现这个差异：

1. 微信扫码链路成功返回 `connected=true`。
2. 微信扫码成功后的配置同步只打印 `NO RESTART, hot-reload only`。
3. 点微信“保存”后也只触发普通配置写入或 hot reload，没有 gateway hard restart。
4. 钉钉配置完成时，因为新增/变化了 secret env，触发 `needsHardRestart=true` 和 `HARD RESTART EXECUTING`。
5. gateway 重启后可以看到 `dingtalk-connector` 启动并收到入站消息。

这会造成用户感知上的矛盾：微信 UI 显示已经连接，但 OpenClaw 的微信 channel runtime 没有以新账号状态重新启动，所以消息监听不可用。

### 1.2 关键日志证据

微信扫码成功但未重启：

```text
[IMGatewayManager] Weixin QR login wait result: {"connected":true,"message":"✅ 与微信连接成功！","accountId":"7cc5674238ca@im.bot"}
[GW-RESTART-DIAG] syncOpenClawConfig START reason=im-weixin-qr-login-connected restartIfRunning=false
[GW-RESTART-DIAG] needsHardRestart=false (... configChanged=false restartFlag=false)
[GW-RESTART-DIAG] NO RESTART, hot-reload only. reason=im-weixin-qr-login-connected
```

随后保存微信配置仍未重启：

```text
[GW-RESTART-DIAG] syncOpenClawConfig START reason=im-config-change restartIfRunning=false
[GW-RESTART-DIAG] top-level changed keys: agents,channels,meta
[GW-RESTART-DIAG] needsHardRestart=undefined (... configChanged=true restartFlag=false)
[GW-RESTART-DIAG] NO RESTART, hot-reload only. reason=im-config-change
```

钉钉配置触发重启：

```text
[GW-RESTART-DIAG] SECRET ENV VARS CHANGED!
[GW-RESTART-DIAG] added: LOBSTER_DINGTALK_CLIENT_SECRET
[GW-RESTART-DIAG] needsHardRestart=true
[GW-RESTART-DIAG] HARD RESTART EXECUTING. reason=app-config-change
[dingtalk-connector] starting dingtalk-connector[429ee481] (mode: stream)
```

微信 channel 同时有拉取消息失败记录：

```text
[openclaw-weixin] weixin getUpdates error (1/3): TypeError: fetch failed
[openclaw-weixin] weixin getUpdates error (3/3): TypeError: fetch failed
[openclaw-weixin] weixin getUpdates: 3 consecutive failures, backing off 30s
[openclaw-weixin] [eae8794daae8-im-bot] channel exited: aborted
```

`fetch failed` 解释了旧微信通道已经不健康，但扫码成功后没有启动一次新的 config-driven channel lifecycle，所以新账号没有恢复消息监听。

### 1.3 当前代码链路

扫码等待成功后，`IMGatewayManager.weixinQrLoginWait()` 调用：

```typescript
await this.syncOpenClawConfig?.('im-weixin-qr-login-connected');
await this.ensureOpenClawGatewayConnected?.();
```

这段注释写的是“Sync config and restart gateway”，但实际没有传递 `restartGatewayIfRunning`。

主进程注入给 `IMGatewayManager` 的回调也是普通同步：

```typescript
syncOpenClawConfig: async (reason?: string) => {
  await syncOpenClawConfig({
    reason: reason || 'im-gateway-sync',
  });
}
```

真正决定是否 hard restart 的条件是：

```typescript
const needsHardRestart =
  secretEnvVarsChanged ||
  syncResult.bindingsChanged ||
  (syncResult.changed && options.restartGatewayIfRunning);
```

因此微信扫码成功后，除非刚好出现 secret env 变化或 bindings 变化，否则只会 hot reload。

手动保存微信配置还有另一个问题。`IMSettings` 中微信保存走的是：

```typescript
await imService.persistConfig({ weixin: weixinOpenClawConfig });
```

而 `persistConfig()` 明确使用：

```typescript
window.electron.im.setConfig(config, { syncGateway: false });
```

所以用户点击微信“保存”时，当前代码不会要求 gateway 同步，更不会要求 gateway hard restart。

### 1.4 根因

根因是微信扫码成功、微信账号保存、OpenClaw channel runtime 重启之间没有形成一个原子闭环。

具体表现：

1. `web.login.wait` 可以让 OpenClaw 插件保存新微信账号，并返回扫码成功。
2. 智码 GLM Code 的 UI 随后把 `weixin.enabled` 和 `accountId` 保存到本地配置。
3. 但是保存链路没有强制 OpenClaw gateway 重启。
4. 普通 hot reload 不能保证 `openclaw-weixin` 重新启动账号监听，尤其在旧账号 channel 已经 `aborted` 或 `getUpdates` 连续失败时。
5. 当前日志中的钉钉“能重启”不是因为 IM 保存天然会重启，而是因为钉钉配置引入了新的 secret env，刚好满足 hard restart 条件。

因此，不能把“扫码成功”直接等同于“微信消息通道已运行”。微信连接成功后的验收标准必须是 channel runtime 已按新账号重新启动并进入可监听状态。

## 2. 用户场景

### 场景 A: 微信首次扫码后能立即收消息

**Given** 用户此前没有可用微信连接
**When** 用户在 IM 设置中扫码微信，并看到连接成功
**Then** 智码 GLM Code 必须保存微信账号配置，并重启或明确重启 `openclaw-weixin` channel，使用户随后从微信发消息能进入 Cowork。

### 场景 B: 旧微信通道已经失败后重新扫码

**Given** 旧微信账号通道出现 `getUpdates fetch failed` 或 `channel exited: aborted`
**When** 用户重新扫码并连接成功
**Then** 系统必须抛弃旧通道状态，使用新账号启动 channel，不能只依赖 hot reload。

### 场景 C: 用户点击微信保存

**Given** 用户修改微信 `enabled`、`dmPolicy`、`allowFrom` 或完成扫码后点击保存
**When** 点击保存
**Then** 如果 OpenClaw gateway 正在运行，应触发一次可诊断的 config sync，并在必要时 hard restart gateway。

### 场景 D: 钉钉行为不回退

**Given** 用户配置钉钉并新增或修改钉钉 secret
**When** 保存钉钉配置
**Then** 仍应按现有逻辑触发 hard restart，并保持钉钉入站消息可处理。

## 3. 功能需求

### FR-1: 微信扫码成功后必须激活 channel runtime

微信扫码成功后，系统必须保证 `openclaw-weixin` channel 以最新账号状态运行。

可接受实现：

1. 对 running gateway 执行 config-driven hard restart。
2. 或调用 OpenClaw 明确的 channel restart API，且日志能证明新微信账号 channel 已启动。

当前没有可见的可靠 channel restart API，因此默认方案应使用 gateway hard restart。

### FR-2: 微信账号保存和 gateway restart 必须同一事务语义

扫码成功后，应避免“先返回 connected，再由 renderer 另一次异步保存配置，再不确定是否重启”的双阶段不一致。

推荐做法：

1. `weixinQrLoginWait()` 得到 `connected=true` 和 `accountId` 后，在主进程保存 `weixin.enabled=true` 与 `weixin.accountId`。
2. 保存成功后调用 `syncOpenClawConfig({ reason: 'im-weixin-qr-login-connected', restartGatewayIfRunning: true })`。
3. 重启完成后重新连接 gateway WebSocket，并刷新 IM 状态。
4. Renderer 只负责显示结果和重新加载配置，不再作为扫码成功后持久化和重启的唯一触发者。

如果为了降低改动范围保留 renderer 保存，也必须让保存请求携带强制重启语义，不能继续走 `persistConfig(syncGateway=false)`。

### FR-3: 微信“保存”按钮必须触发有效同步

微信设置页点击保存时，不能调用只落库不同步的 `persistConfig()`。

保存按钮应使用能触发 gateway 同步的 API，例如：

```typescript
await imService.updateConfig({ weixin: weixinOpenClawConfig }, {
  restartGatewayIfRunning: true,
});
```

如果保留 `persistConfig()` 用于输入框 blur 静默保存，则必须保证用户明确点击“保存”时走同步/重启路径。

### FR-4: IM 配置同步需要支持显式 hard restart

当前 `im:config:set` options 只有 `syncGateway`，无法表达“同步并强制重启”。

需要扩展为：

```typescript
type IMConfigSetOptions = {
  syncGateway?: boolean;
  restartGatewayIfRunning?: boolean;
};
```

主进程调度 IM 配置同步时，需要把 `restartGatewayIfRunning` 传给 `syncOpenClawConfig()`：

```typescript
await syncOpenClawConfig({
  reason: 'im-config-change',
  restartGatewayIfRunning: pendingRestartGatewayIfRunning,
});
```

多次快速配置变更仍应被 debounce 合并。合并规则中 `restartGatewayIfRunning` 使用 OR 语义：任意一次请求要求重启，本轮合并同步就必须重启。

### FR-5: 避免无意义重复重启

微信成功扫码后不应在极短时间内触发两次 gateway restart。

需要处理以下重复来源：

1. `weixinQrLoginWait()` 后端自身触发的同步/重启。
2. Renderer 在成功后保存 `weixin` 配置触发的 `im-config-change`。
3. 用户随后手动点保存。

推荐策略：

1. 扫码成功后由主进程保存配置并重启，renderer 成功后只 reload config/status。
2. 如果短时间内收到相同 `accountId`、相同微信配置的保存请求，允许落库，但不要再次 hard restart。
3. 如果同一 debounce 窗口内有多次 IM config set，合并为一次 hard restart。

### FR-6: 重启必须尊重现有 active workload 策略

如果 gateway 正在处理任务，微信配置强制重启应复用现有 deferred restart 机制，避免中断正在运行的 Cowork/IM 回复。

验收时日志应能区分：

1. 立即执行 hard restart。
2. 因 active workload 延迟重启。
3. gateway 未运行，因此只保存配置，等待下次启动生效。

### FR-7: 日志必须暴露微信 channel 是否真正运行

扫码成功后的日志不能只停留在 `connected=true`。

需要至少能看到：

1. `syncOpenClawConfig` reason。
2. `restartGatewayIfRunning=true`。
3. `HARD RESTART EXECUTING` 或 deferred restart。
4. gateway 重启后加载 `openclaw-weixin`。
5. 新账号 `starting weixin provider` / `weixin monitor started`。
6. `channels.status` 或本地 IM status 显示微信账号 `running/configured/enabled`。

错误日志应保留 `fetch failed` 的底层 cause，避免只能看到 undici 的泛化错误。

## 4. 实现方案

### 4.1 扩展 IM 配置同步选项

新增共享类型或复用现有 IPC 类型：

```typescript
interface IMConfigSetOptions {
  syncGateway?: boolean;
  restartGatewayIfRunning?: boolean;
}
```

涉及位置：

1. `src/main/preload.ts`
2. `src/renderer/types/electron.d.ts`
3. `src/renderer/services/im.ts`
4. `src/main/main.ts` 的 `im:config:set`
5. 必要时更新 `src/main/im/types.ts` 或新增模块局部类型

`imService.updateConfig()` 可增加第二个参数：

```typescript
async updateConfig(
  config: Partial<IMGatewayConfig>,
  options?: { restartGatewayIfRunning?: boolean },
): Promise<boolean>
```

内部调用：

```typescript
window.electron.im.setConfig(config, {
  syncGateway: true,
  restartGatewayIfRunning: options?.restartGatewayIfRunning,
});
```

### 4.2 让 IM sync debounce 支持强制重启

当前 `scheduleImConfigSync()` 只调度一次普通 `syncOpenClawConfig({ reason: 'im-config-change' })`。

需要增加待处理状态：

```typescript
let imConfigSyncPendingRestartGatewayIfRunning = false;
```

调度时：

```typescript
scheduleImConfigSync({
  restartGatewayIfRunning: options?.restartGatewayIfRunning === true,
});
```

执行时：

```typescript
const restartGatewayIfRunning = imConfigSyncPendingRestartGatewayIfRunning;
imConfigSyncPendingRestartGatewayIfRunning = false;

await syncOpenClawConfig({
  reason: 'im-config-change',
  restartGatewayIfRunning,
});
```

如果同步运行中又来了新的强制重启请求，pending flag 也要按 OR 语义保留到下一轮。

### 4.3 修正微信保存按钮

`IMSettings` 中微信保存不能再使用 `persistConfig()`：

```typescript
if (activePlatform === 'weixin') {
  await imService.updateConfig(
    { weixin: weixinOpenClawConfig },
    { restartGatewayIfRunning: true },
  );
  return;
}
```

输入框 blur 或中间态编辑仍可以继续用 `persistConfig()`，避免每次输入都重启。

### 4.4 扫码成功后由主进程完成激活

推荐把扫码成功后的保存与重启放在 `IMGatewayManager.weixinQrLoginWait()` 内完成：

1. 得到 `resolvedAccountId`。
2. 合并当前微信配置：

```typescript
this.setConfig({
  weixin: {
    ...this.getConfig().weixin,
    enabled: true,
    accountId: resolvedAccountId,
  },
}, { syncGateway: false });
```

3. 调用支持强制重启的新回调：

```typescript
await this.syncOpenClawConfig?.('im-weixin-qr-login-connected', {
  restartGatewayIfRunning: true,
});
```

4. `ensureOpenClawGatewayConnected()` 在重启完成后重新连接 gateway client。

如果当前 `IMGatewayManagerOptions.syncOpenClawConfig` 保持单参数，会丢失强制重启语义，因此需要扩展为：

```typescript
syncOpenClawConfig?: (
  reason?: string,
  options?: { restartGatewayIfRunning?: boolean },
) => Promise<void>;
```

主进程注入时传递：

```typescript
syncOpenClawConfig: async (reason, options) => {
  await syncOpenClawConfig({
    reason: reason || 'im-gateway-sync',
    restartGatewayIfRunning: options?.restartGatewayIfRunning,
  });
}
```

### 4.5 调整 renderer 扫码成功后的保存行为

如果 4.4 落地，renderer 的 `persistConnectedWeixinConfig()` 不应再发起第二次 `updateConfig()`。

建议改为：

1. 扫码成功后 `setWeixinQrStatus('success')`。
2. 调用 `imService.loadConfig()` 和 `imService.loadStatus()`。
3. 如果后端返回的 `accountId` 与 store 仍不一致，仅更新 Redux 本地状态，不再次触发 gateway sync。

如果短期内不调整 4.4，则 renderer 成功后必须调用：

```typescript
await imService.updateConfig(
  { weixin: { ...weixinOpenClawConfig, enabled: true, accountId } },
  { restartGatewayIfRunning: true },
);
```

不能继续依赖后端扫码成功时的普通 sync。

### 4.6 增强 `openclaw-weixin` fetch failed 诊断

当前日志只有：

```text
TypeError: fetch failed
```

如果插件代码可控，应在 `apiPostFetch()` 捕获错误时打印 `error.cause` 的关键字段：

1. `code`
2. `errno`
3. `syscall`
4. `address`
5. `port`
6. `message`

日志仍需遮蔽 token、账号敏感字段。

这不是恢复消息通道的主修复，但能区分网络不可达、证书问题、远端关闭、代理配置错误等原因。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| gateway 未运行时扫码成功 | 保存微信配置，不尝试 hard restart；下次启动 gateway 时应按配置启动微信 channel。 |
| gateway 正在处理任务 | 通过现有 deferred restart 机制延迟重启，并在日志中标明延迟原因。 |
| 用户扫码同一个已运行账号 | 如果 status 显示同账号 channel 已 running，可跳过 hard restart；如果 status 不可确认，仍执行一次 restart。 |
| 用户扫码新账号替换旧账号 | 必须 hard restart 或明确 restart `openclaw-weixin`，旧账号通道不能继续监听。 |
| 用户只在输入框编辑但未点击保存 | 允许 `persistConfig(syncGateway=false)` 静默落库，不立即重启。 |
| 用户点击微信保存但配置未变化 | 如果 channel status 已 running，可不重启；如果无法确认 running，应允许用户保存触发一次修复性重启。 |
| 连续点击保存/扫码成功后自动保存 | debounce 合并为一次重启，避免重复杀 gateway。 |
| 微信 `getUpdates` 继续 fetch failed | UI 不应只显示“连接成功”，应在 status 中暴露 lastError，并建议用户检查网络或重新扫码。 |

## 6. 涉及文件

预计修改：

1. `src/main/im/imGatewayManager.ts`
   - 扩展 `syncOpenClawConfig` 回调签名。
   - 扫码成功后保存微信配置并强制重启 gateway。
2. `src/main/main.ts`
   - 扩展 `im:config:set` options。
   - 让 IM config sync debounce 支持 `restartGatewayIfRunning`。
   - 注入给 `IMGatewayManager` 的 `syncOpenClawConfig` 透传强制重启选项。
3. `src/renderer/services/im.ts`
   - `updateConfig()` 支持传入强制重启选项。
4. `src/main/preload.ts`
   - `im.setConfig` 类型/参数透传。
5. `src/renderer/types/electron.d.ts`
   - 更新 `im.setConfig` options 类型。
6. `src/renderer/components/im/IMSettings.tsx`
   - 微信保存按钮改为触发 sync/restart。
   - 扫码成功后的 config/status 刷新避免重复重启。
7. `src/main/libs/openclawConfigSync.ts`
   - 如需判断微信 channel 配置变化，可增加更明确的诊断输出；不应把微信账号 id 写入不支持的 channel schema。

可能需要增加或更新测试：

1. `src/main/im/imGatewayManager.test.ts`
2. `src/main/libs/openclawConfigSync.runtime.test.ts`
3. `src/renderer/services/im.test.ts` 或对应 renderer 测试
4. 如当前项目没有相关测试 harness，可新增轻量单元测试覆盖 options 传递和 debounce 合并逻辑。

## 7. 验收标准

### 7.1 日志验收

微信扫码成功后，应看到类似日志：

```text
[IMGatewayManager] Weixin QR login wait completed: {"connected":true,...}
[GW-RESTART-DIAG] syncOpenClawConfig START reason=im-weixin-qr-login-connected restartIfRunning=true
[GW-RESTART-DIAG] needsHardRestart=true (... restartFlag=true)
[GW-RESTART-DIAG] HARD RESTART EXECUTING. reason=im-weixin-qr-login-connected
[gateway] http server listening (... openclaw-weixin ...)
[openclaw-weixin] [<new-account>] starting weixin provider (...)
[openclaw-weixin] weixin monitor started (...)
```

如果有 active workload，应看到 deferred restart 相关日志，而不是静默 hot reload。

微信点击保存后，如果 gateway running 且需要刷新 channel，应看到：

```text
[GW-RESTART-DIAG] syncOpenClawConfig START reason=im-config-change restartIfRunning=true
```

不能再出现用户点击保存后只有：

```text
NO RESTART, hot-reload only. reason=im-config-change
```

除非日志同时证明微信 channel 已是同账号 running 状态且明确跳过重启。

### 7.2 功能验收

1. 首次扫码微信成功后，不重启应用，直接从微信给机器人发消息，智码 GLM Code 能收到并创建/更新对应 Cowork session。
2. 旧微信通道出现 `getUpdates` 连续失败后，重新扫码成功，后续微信消息能恢复。
3. 点击微信保存后，gateway 重启或 channel restart 可观察，微信 status 变为 connected/running。
4. 钉钉配置保存和入站消息行为不回退。
5. 多次快速保存只触发一次 gateway restart。
6. gateway 有活跃任务时，微信配置重启走 deferred restart，不中断当前任务。

### 7.3 回归验证

建议验证命令：

```bash
npm test -- imGatewayManager
npm test -- openclawConfigSync
npm run lint
npm run build
```

手动验证流程：

1. 启动应用并打开 IM 设置页。
2. 清理或停用旧微信连接。
3. 扫码微信并等待成功。
4. 检查日志中是否出现 `restartIfRunning=true` 与 gateway restart。
5. 从微信发送一条文本消息，确认 智码 GLM Code 收到并回复。
6. 修改微信 allowFrom 或 dmPolicy 后点击保存，确认不会只静默落库。
7. 配置钉钉并发送消息，确认钉钉不受影响。
