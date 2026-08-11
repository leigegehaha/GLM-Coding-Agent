# OpenClaw 托管 Chrome 重复启动导致空白页修复 Spec

## 1. 概述

### 1.1 问题

用户在 Cowork 任务中调用 browser 工具时，智码 GLM Code 已经启动了一个独立的托管 Chrome profile：`openclaw`。这个托管浏览器启动后会先显示一个空白 tab，随后 browser 工具通过 CDP 打开真实目标页面。

实际观察到的异常是：同一次任务过程中，已经存在 `openclaw` 托管 Chrome 后，又额外出现一个新的空白 Chrome tab/window。用户主观上容易感觉它发生在任务结束后，或者像是另一个 `dev` / `user` Chrome 被单独打开。

最新诊断日志排除了这些方向：

1. 没有 `profile="user"` 请求。
2. 没有 `chrome-mcp` transport。
3. 没有 `opening Chrome MCP tab`。
4. 第二次 launch 发生在任务执行中，不是在任务结束后。

因此本问题的边界是：`openclaw` managed profile 在一次 browser 任务中被重复启动，重复启动的 Chrome 因启动参数不带 URL 而露出额外空白页。

### 1.2 关键日志证据

日志批次：

- `main-2026-05-20.log` from `lobsterai-logs-20260520-233649`
- `openclaw-2026-05-20.log` from `lobsterai-logs-20260520-233649`
- `gateway-2026-05-20.log` from `lobsterai-logs-20260520-233649`

任务标识：

```text
runId=0a55a1b0-b895-4a0f-beb3-c30467a60280
sessionKey=agent:main:lobsterai:f90336eb-3ebc-4045-9eeb-b823a3e81e48
```

第一次托管 Chrome 启动正常：

```text
2026-05-20 23:34:52.141 [BrowserDiagnostics] ensureBrowserAvailable launching managed Chrome: profile="openclaw" reason="http_unreachable" previousRunningPid=""
2026-05-20 23:34:52.144 [BrowserDiagnostics] spawning openclaw Chrome: purpose="openclaw" profile="openclaw" cdpPort="18800" ... args="--remote-debugging-port=18800 --user-data-dir=... --no-first-run ..."
2026-05-20 23:34:52.145 [BrowserDiagnostics] spawned openclaw Chrome: purpose="openclaw" profile="openclaw" childPid="19657"
2026-05-20 23:34:54.148 [BrowserDiagnostics] openclaw Chrome CDP HTTP ready: profile="openclaw" ... elapsedMs="2003"
2026-05-20 23:34:54.149 [BrowserDiagnostics] attached running openclaw Chrome: profile="openclaw" pid="19657" cdpPort="18800"
```

第二次 browser 工具执行 `snapshot` 前，300ms CDP HTTP 探测出现短暂失败：

```text
2026-05-20 23:35:01.372 [BrowserDiagnostics] CDP HTTP reachability checked: profile="openclaw" cdpUrl="http://127.0.0.1:18800" timeoutMs="default" httpTimeoutMs="300" reachable="false" runningPid="19657"
2026-05-20 23:35:01.372 [BrowserDiagnostics] ensureBrowserAvailable evaluated HTTP state: profile="openclaw" driver="openclaw" cdpUrl="http://127.0.0.1:18800" attachOnly="false" remoteCdp="false" runningPid="19657" httpReachable="false"
```

当前逻辑在 `runningPid` 存在但 HTTP 不可达时没有长超时复查，直接重复启动 managed Chrome：

```text
2026-05-20 23:35:01.372 [BrowserDiagnostics] ensureBrowserAvailable launching managed Chrome: profile="openclaw" reason="http_unreachable" previousRunningPid="19657"
2026-05-20 23:35:01.374 [BrowserDiagnostics] spawned openclaw Chrome: purpose="openclaw" profile="openclaw" childPid="19917"
```

新启动的 Chrome 在 21ms 内显示 CDP HTTP ready：

```text
2026-05-20 23:35:01.395 [BrowserDiagnostics] openclaw Chrome CDP HTTP ready: profile="openclaw" cdpUrl="http://127.0.0.1:18800" childPid="19917" elapsedMs="21"
```

这个时间远短于一次真实冷启动，说明前一个 `300ms` 失败更像是瞬时不可达或 CDP 短暂忙碌，而不是浏览器已经彻底不可用。

第二个子进程很快正常退出：

```text
2026-05-20 23:35:01.400 [BrowserDiagnostics] openclaw Chrome child exited: purpose="openclaw" profile="openclaw" childPid="19917" code="0" signal="" killed="false"
2026-05-20 23:35:01.400 [BrowserDiagnostics] tracked openclaw Chrome process exited: profile="openclaw" pid="19917" code="0" signal="" currentRunningPid="19917"
```

任务实际结束时间晚于第二次启动：

```text
2026-05-20 23:36:42.382 [OpenClawRuntimeAdapter] embedded run prompt end ...
2026-05-20 23:36:42.382 [OpenClawRuntimeAdapter] agent_end ...
2026-05-20 23:36:42.383 [OpenClawRuntimeAdapter] run_completed ...
```

因此“结束后又打开一个 Chrome”的主观感受不等于真实时序。真实时序是第二次 `openclaw` managed Chrome 在任务中途被重复拉起。

### 1.3 根因

根因是 OpenClaw browser availability 判断对 loopback CDP 的短暂不可达过于敏感。

当前 `ensureBrowserAvailable()` 的关键行为：

1. 对 loopback CDP 使用默认 `httpTimeoutMs=300` 的快速探测。
2. 如果 HTTP 不可达，只有在 `!profileState.running` 时才执行一次 `1200ms` HTTP + websocket 复查。
3. 如果 `profileState.running` 存在但 HTTP 不可达，则直接进入 managed Chrome launch。
4. launch 参数不包含目标 URL，Chrome 会显示启动空白页。

这导致以下状态被误判：

```text
runningPid=19657
300ms HTTP probe=false
actual CDP endpoint likely transient/busy
current logic => launch a second managed Chrome
```

此外还存在一个独立但相关的诊断问题：macOS Chrome.app 启动器进程退出不一定代表浏览器不可用。日志显示后续多次状态中 `runningPid=""` 但 CDP 仍可达。这说明 `profileState.running` 只能作为最佳努力的进程跟踪，不能作为 browser 是否可用的唯一事实来源。

### 1.4 非根因

以下方向已由日志排除，不应作为本修复的主要路径：

| 假设 | 结论 | 证据 |
|------|------|------|
| 任务结束后打开 dev Chrome | 排除 | 第二次 launch 在 `23:35:01`，任务结束在 `23:36:42` |
| 使用了用户 Chrome profile | 排除 | 最新日志无 `profile="user"` |
| Chrome MCP existing-session 拉起新 tab | 排除 | 最新日志无 `chrome-mcp` 或 `opening Chrome MCP tab` |
| Renderer 设置页查询触发启动 | 排除 | 最新日志无 renderer browser status/profile 请求 |

## 2. 用户场景

### 场景 A: 第一次 browser 调用启动托管 Chrome

**Given** OpenClaw gateway 正在运行，`openclaw` managed Chrome 未启动
**When** Agent 第一次调用 browser 工具
**Then** 智码 GLM Code 可以启动一个 `openclaw` managed Chrome，并通过 CDP 打开目标页面。

### 场景 B: 托管 Chrome 已启动但 CDP 短暂不可达

**Given** `openclaw` managed Chrome 已启动，且 CDP endpoint 在本机 loopback 端口
**When** 一次 `300ms` CDP HTTP 探测失败，但长超时 HTTP + websocket 复查成功
**Then** 系统必须复用现有浏览器，不能再次启动 managed Chrome。

### 场景 C: Chrome 启动器进程退出但 CDP 仍可达

**Given** macOS 上 Chrome 子进程 `exit code=0`，但 `127.0.0.1:<cdpPort>` 仍可达
**When** 后续 browser 工具继续执行
**Then** 可用性判断应以 CDP 可达为准，不能因为 `runningPid` 丢失而重复启动 Chrome。

### 场景 D: CDP 真实不可达

**Given** managed Chrome 未运行，或 CDP 端口在长超时复查后仍不可达
**When** Agent 调用 browser 工具
**Then** 系统可以启动或重启 managed Chrome，并记录一次明确的 launch reason。

## 3. 功能需求

### FR-1: HTTP 不可达时必须先长超时复查

`ensureBrowserAvailable()` 在 managed loopback profile 的 HTTP 探测失败后，必须执行一次 grace retry：

1. HTTP 复查使用 `1200ms` 到 `2000ms` 的超时。
2. HTTP 复查成功后继续做 websocket 复查。
3. HTTP 和 websocket 都成功时直接返回，不启动 Chrome。

该复查不应只限于 `!profileState.running`。即使当前存在 `runningPid`，也必须先复查再决定 launch。

### FR-2: CDP 可达性是 managed browser 可用性的主事实

对 managed loopback profile：

1. `profileState.running` 用于停止当前由本进程创建的子进程、记录诊断信息和 best-effort 清理。
2. CDP HTTP + websocket 可达用于判断浏览器是否可复用。
3. 当 `runningPid` 为空但 CDP 可达时，应视为浏览器可用，不能因为进程句柄缺失触发 launch。
4. 当子进程 `exit code=0` 后，应先探测 CDP 是否仍可达，再决定是否清理“浏览器可用”状态。

### FR-3: 同一 profile 的 launch 必须串行化

每个 browser profile 需要一个 launch mutex 或 in-flight ensure promise。

要求：

1. 同一 profile 同一时间最多只有一次 managed Chrome launch。
2. 并发 `ensureBrowserAvailable()` 应等待正在进行的 ensure/launch。
3. 等待结束后重新检查 CDP 状态，避免等待者继续 launch。
4. 失败时要清理 in-flight 状态，避免后续调用永久卡住。

### FR-4: launch reason 必须可诊断

保留低频关键日志，但不保留当前临时调试级别的噪声。

建议日志：

```text
[BrowserAvailability] reused managed Chrome after CDP grace retry for profile "openclaw"
[BrowserAvailability] launching managed Chrome for profile "openclaw" because CDP remained unreachable
[BrowserAvailability] managed Chrome launcher exited for profile "openclaw"; CDP still reachable, keeping browser attached
```

日志要求：

1. 使用 `console.debug` 记录常规探测细节。
2. 使用 `console.log` 记录 launch、reuse-after-retry、实际 restart 等关键状态变化。
3. 使用 `console.warn` 记录短暂不可达后的降级、launcher exit、重复 launch 被抑制等异常但可恢复事件。
4. 不在每次轮询或每个 browser action 都打印 info 级别日志。

### FR-5: 空白 startup tab 后续可被清理

本问题的核心修复是避免重复启动。空白 startup tab 清理可以作为同一修复的低风险附加项或后续迭代。

可接受策略：

1. browser 打开第一个真实 target 后，查找由 Chrome 启动产生且仍未使用的 `about:blank` / `chrome://newtab`。
2. 仅在确认它不是当前激活目标、不是用户手动打开页面、且没有导航历史时关闭。
3. 如果判断条件不可靠，第一版可以不清理空白 tab，只修复重复启动。

## 4. 实现方案

### 4.1 调整 `ensureBrowserAvailable()` 的 HTTP 不可达分支

涉及位置：

- OpenClaw 源码：`extensions/browser/src/browser/server-context.availability.ts`
- 智码 GLM Code 补丁：`scripts/patches/v2026.4.14/openclaw-browser-duplicate-launch.patch`
- 打包后验证：`vendor/openclaw-runtime/<target>/dist/server-context-*.js`

当前逻辑可以抽象为：

```typescript
const initialHttpReachable = await isHttpReachable();

if (!initialHttpReachable) {
  if (!attachOnly && !remoteCdp && profile.cdpIsLoopback && !profileState.running) {
    const retryHttpReachable = await isHttpReachable(1200);
    const retryWsReachable = retryHttpReachable ? await isReachable(1200) : false;
    if (retryHttpReachable && retryWsReachable) return;
  }

  launchOpenClawChrome(...);
}
```

调整为：

```typescript
const initialHttpReachable = await isHttpReachable();

if (!initialHttpReachable) {
  if ((attachOnly || remoteCdp) && opts.onEnsureAttachTarget) {
    await opts.onEnsureAttachTarget(profile);
    if (await isHttpReachable(1200)) return;
  }

  if (!attachOnly && !remoteCdp && profile.cdpIsLoopback) {
    const retryHttpReachable = await isHttpReachable(1500);
    const retryWsReachable = retryHttpReachable ? await isReachable(1500) : false;
    if (retryHttpReachable && retryWsReachable) {
      markProfileCdpAttachedIfNeeded();
      return;
    }
  }

  if (attachOnly || remoteCdp) throwUnavailable();

  await launchManagedChromeOnce();
}
```

关键变化是移除 `!profileState.running` 限制，让“已有 pid 但 300ms 探测失败”的场景也先进入长超时复查。

### 4.2 引入 profile 级 ensure/launch 串行化

在 profile runtime state 中增加一个 in-flight 字段，例如：

```typescript
type BrowserProfileRuntimeState = {
  running: OpenClawChromeProcess | null;
  ensureInFlight?: Promise<void> | null;
  launchInFlight?: Promise<OpenClawChromeProcess> | null;
};
```

实现方式二选一：

1. 在 `ensureBrowserAvailable()` 外层包一层 `ensureInFlight`，保证整个可用性检查串行。
2. 只对 `launchOpenClawChrome()` 包 `launchInFlight`，允许探测并发，但 launch 串行。

推荐第一种，因为它能避免多个 browser action 同时看到“不可达”后排队重复 launch。

伪代码：

```typescript
const ensureBrowserAvailable = async () => {
  const profileState = getProfileState();
  if (profileState.ensureInFlight) {
    await profileState.ensureInFlight;
    return;
  }

  const ensurePromise = doEnsureBrowserAvailable().finally(() => {
    if (getProfileState().ensureInFlight === ensurePromise) {
      getProfileState().ensureInFlight = null;
    }
  });

  profileState.ensureInFlight = ensurePromise;
  await ensurePromise;
};
```

如果采用该方案，需要确认 `getProfileState()` 返回的是同一个可变 state 对象，否则应通过现有 setter 更新。

### 4.3 调整 launcher exit 的状态处理

当前 `attachRunning()` 在子进程 exit 时，如果 pid 匹配就直接 `setProfileRunning(null)`。

建议改为：

```typescript
running.proc.on('exit', async (code, signal) => {
  if (!opts.getState()) return;
  if (getProfileState().running?.pid !== running.pid) return;

  const httpReachable = await isHttpReachable(1200);
  const wsReachable = httpReachable ? await isReachable(1200) : false;

  if (httpReachable && wsReachable) {
    setProfileRunning(null);
    markProfileCdpAttached(profile);
    return;
  }

  setProfileRunning(null);
});
```

第一版也可以不新增 `markProfileCdpAttached()`，只要后续 `ensureBrowserAvailable()` 在 `runningPid=""` 且 CDP 可达时直接返回即可。这样即使进程句柄丢失，也不会重复启动。

### 4.4 清理临时诊断日志

前期为定位问题加入的 `BrowserDiagnostics` 日志应收敛：

1. 保留对问题有长期价值的 launch / reuse / suppressed duplicate launch 记录。
2. 删除或降级每次 `isHttpReachable()`、`isReachable()` 的详细探测日志。
3. `src/main/main.ts` 中 renderer status/profile 查询日志属于本次定位用临时日志，修复完成后应移除，除非后续设置页需要开发者诊断入口。

### 4.5 补丁落点

由于 智码 GLM Code 通过 `scripts/apply-openclaw-patches.cjs` 对 pinned OpenClaw 版本应用补丁，修复不应只修改 `vendor/openclaw-runtime/*/dist`。

推荐实施顺序：

1. 在 OpenClaw 源码 checkout 中修改 browser availability 源文件。
2. 生成 `scripts/patches/v2026.4.14/openclaw-browser-duplicate-launch.patch`。
3. 运行 `npm run openclaw:patch` 验证补丁可重复应用。
4. 运行 `npm run openclaw:runtime:host` 生成本机 runtime。
5. 使用用户复现任务验证不会再出现第二个空白 Chrome。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 首次启动，CDP 端口确实不可达 | grace retry 后仍不可达，允许启动 managed Chrome |
| 已有 `runningPid`，300ms 探测失败但 1500ms 成功 | 复用现有浏览器，不启动 |
| `runningPid` 为空但 CDP 可达 | 视为可用，不启动；记录 debug 或低频 info |
| macOS launcher 子进程 `code=0` 退出 | 先以 CDP 可达性判断是否仍可复用 |
| 两个 browser action 同时触发 ensure | 后来者等待 in-flight ensure，不重复 launch |
| attachOnly 或 remote CDP | 保持现有错误语义，不自动启动本地 Chrome |
| websocket 不可达但 HTTP 可达 | 先做长超时 websocket retry；仍失败才按现有重启逻辑处理 |
| 用户手动关闭托管 Chrome | 长超时复查失败后允许重新启动 |
| CDP 端口被其他进程占用 | 不应盲目认为是 OpenClaw Chrome；保留现有 CDP policy 与 profile 校验，必要时报错 |

## 6. 涉及文件

| 文件 | 变更 |
|------|------|
| `scripts/patches/v2026.4.14/openclaw-browser-duplicate-launch.patch` | 新增 OpenClaw browser availability 修复补丁 |
| `vendor/openclaw-runtime/<target>/dist/server-context-*.js` | 由 runtime build 生成，验证修复是否进入 bundled runtime |
| `vendor/openclaw-runtime/<target>/dist/chrome-*.js` | 如需收敛 launch 日志或调整 startup tab 行为，由 runtime build 生成 |
| `src/main/main.ts` | 移除本次定位用 `BrowserDiagnostics` renderer status/profile 临时日志 |
| `specs/bugfixes/openclaw-browser-duplicate-launch/2026-05-20-openclaw-browser-duplicate-launch-fix-design.md` | 本 spec |

## 7. 验收标准

### 7.1 自动化验证

应在 OpenClaw browser availability 逻辑附近补单元测试或等价测试，覆盖：

1. `runningPid` 存在、首次 HTTP 探测失败、长超时 HTTP + websocket 成功时，不调用 `launchOpenClawChrome()`。
2. `runningPid` 不存在、首次 HTTP 探测失败、长超时 HTTP + websocket 成功时，不调用 `launchOpenClawChrome()`。
3. 长超时 HTTP 或 websocket 仍失败时，只调用一次 `launchOpenClawChrome()`。
4. 两个并发 `ensureBrowserAvailable()` 在同一 profile 上只产生一次 launch。
5. launcher 子进程 exit 后，CDP 仍可达时后续 ensure 不 launch。

如果 OpenClaw 当前没有可直接测试该模块的结构，至少应通过 patch-level integration test 或小型 harness 模拟 `isHttpReachable` / `isReachable` / `launchOpenClawChrome`。

### 7.2 本地验证

1. 运行 `npm run openclaw:patch`，确认补丁可重复应用。
2. 运行 `npm run openclaw:runtime:host`，确认本机 runtime 构建成功。
3. 运行 `npm run compile:electron`，确认 Electron main process 编译成功。
4. 启动 `npm run electron:dev:openclaw`。
5. 执行一次会调用 browser `open` + `snapshot` 的 Cowork 任务。
6. 检查日志：同一 run 中 `openclaw` profile 只能出现一次 `launching managed Chrome`。
7. 检查 UI：不再出现第二个额外空白 Chrome tab/window。

### 7.3 日志验收

修复后日志应能证明以下事实：

1. 首次启动时有一次 managed Chrome launch。
2. 后续短暂 HTTP 不可达时，有 grace retry 成功并复用的记录。
3. 没有 `previousRunningPid="<pid>"` 后立即再次 `launching managed Chrome` 的记录。
4. 如果 launcher 子进程退出但 CDP 仍可达，日志应明确说明保留 CDP 可用状态或后续复用成功。

## 8. 后续优化

1. 将 browser availability 的关键诊断整理为开发者诊断入口，而不是长期散落在 info 日志中。
2. 评估是否关闭启动后遗留的未使用 `about:blank` tab。
3. 将 OpenClaw browser 侧修复向上游同步，减少 智码 GLM Code 长期维护补丁的成本。
