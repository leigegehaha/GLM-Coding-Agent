# OpenClaw subagent cleanup finalize 无限重放修复设计文档

## 1. 概述

### 1.1 问题

部分 Windows 用户在 OpenClaw gateway 启动和会话继续过程中，会反复出现 `subagent cleanup finalize failed`。同一批已经结束的 subagent run 会在每次启动后被重新恢复、重新执行 cleanup finalize，并再次失败。

用户侧同时可能看到 `gateway request timeout for sessions.patch`。从日志链路看，这个 toast 的直接触发点是主进程在发送 `chat.send` 前先执行 `sessions.patch` 更新当前会话模型，gateway 在客户端 30 秒超时后才返回成功，导致本轮消息没有继续进入 `chat.send`。

`subagent cleanup finalize failed` 不是 `sessions.patch` 超时的唯一原因，但它会在 gateway 启动和恢复阶段制造大量历史状态重放、动态 import 失败和日志噪声，增加 gateway 在关键请求前后的压力，也让同一批异常永远不能自动收敛。

### 1.2 根因

这是两个问题叠加后暴露出来的：

1. cleanup 状态机把 ended hook 失败当成 finalize 失败。
   - 已完成且已公告的 subagent run 会走 `finalizeSubagentCleanup(..., didAnnounce=true, ...)`。
   - 该路径会先等待 `emitCompletionEndedHookIfNeeded(...)`，然后才写入 `cleanupCompletedAt`。
   - 一旦 ended hook 或其动态 import 失败，`completeCleanupBookkeeping(...)` 不会执行，`cleanupCompletedAt` 也不会落盘。
   - 外层 catch 又会把 `cleanupHandled` 重新置回 false，于是下次恢复时继续重放同一条历史 run。

2. Windows bundle fast path 下 runtime lazy import 的相对路径不正确。
   - Windows 包使用 `cfmind\gateway-bundle.mjs` 作为快速入口。
   - OpenClaw 内部的 lazy import 以 `import.meta.url` 为基准解析 `./subagent-registry.runtime.js`。
   - 在非 bundle 运行时，基准文件位于 `cfmind\dist\...`，因此能解析到 `cfmind\dist\subagent-registry.runtime.js`。
   - 在 bundle 运行时，基准文件变成 `cfmind\gateway-bundle.mjs`，因此错误地解析到 `cfmind\subagent-registry.runtime.js`。
   - 用户机器上的真实文件在 `cfmind\dist` 下，包本身并不是缺少该 runtime 文件。

需要注意：`notifyContextEngineSubagentEnded(...)` 本身已经是 best-effort；真正阻断 cleanup 状态写入的是更外层的 `emitCompletionEndedHookIfNeeded(...)` / `emitSubagentEndedHookForRun(...)`。

### 1.3 证据

用户提供的 `subagents\runs.json` 有以下特征：

- 共 278 条 run，全部是 `status: ended`。
- 278 条全部缺少 `cleanupCompletedAt`。
- 277 条已有 `completionAnnouncedAt`。
- 277 条 `cleanupHandled` 为 false，1 条为 true。
- 278 条全部是 `cleanup: keep`。
- gateway 日志中的 cleanup finalize warning 与该文件中的 run id 高度重合，说明 warning 来自这批历史状态的重复恢复。

这说明系统已经完成了 subagent 的主要执行和公告流程，但 cleanup finalize 的最后 bookkeeping 没有成功写入，因此每次启动都会继续处理这些历史 run。

### 1.4 修复立场

修复应分两层推进：

1. 先修 cleanup finalize 的状态收敛能力，让 ended hook/import 失败不再阻断 `cleanupCompletedAt` 写入。
2. 再修 Windows bundle 下 runtime lazy import 的路径解析，让后续 hook 可以正常加载 `dist` 下的 runtime 文件。

只修 bundle 路径可以减少 import error，但仍保留“hook 失败会阻断 cleanup”的状态机缺陷，而且可能让历史 run 在第一次修复后集中重放 ended hook。只修 cleanup 状态机可以先阻止无限重放，是更适合先落地的低风险修复，但不能消除其他路径未来再次触发同类 import 失败的可能。

## 2. 用户场景

### 2.1 历史 ended run 恢复

用户已有一批结束、已公告、但缺少 `cleanupCompletedAt` 的 subagent run。应用启动后 gateway 恢复这些 run，即使 ended hook 加载失败，也应该把 cleanup 状态推进到完成，避免下一次启动继续重放。

### 2.2 新 subagent 正常结束

新 subagent run 正常完成时，系统仍应按原逻辑发送 completion announce、执行 ended hook、处理附件清理，并写入 cleanup 完成状态。修复不应移除正常 hook 能力。

### 2.3 ended hook 失败

当 ended hook 或 runtime lazy import 失败时，用户可见的 subagent 结果已经完成，不应因为一个后置 hook 失败导致 cleanup 永远卡住。系统应记录 warning，并继续完成 cleanup bookkeeping。

### 2.4 Windows bundle runtime 加载

Windows 打包应用使用 `gateway-bundle.mjs` 启动时，subagent runtime lazy import 应能定位到 `cfmind\dist\subagent-registry.runtime.js`，而不是错误寻找 `cfmind\subagent-registry.runtime.js`。

### 2.5 gateway 请求超时

修复 cleanup 重放后，gateway 启动阶段的历史状态压力应减少。但 `sessions.patch` 超时还可能与 gateway readiness、并发 `sessions.list` 轮询、模型 patch 客户端超时策略有关，本 spec 不把 cleanup 修复声明为 `sessions.patch` 超时的唯一或彻底修复。

## 3. 功能需求

### 3.1 cleanup bookkeeping 不受 ended hook 失败阻断

对于已经进入 finalize 的 ended run，`emitCompletionEndedHookIfNeeded(...)` 失败不能阻断：

- `cleanupCompletedAt` 写入。
- `cleanupHandled` 最终状态收敛。
- `cleanup: delete` 场景下的 run 删除。
- `cleanup: keep` 场景下的 run 保留和完成标记。

### 3.2 保留 ended hook 的正常行为

当 ended hook 正常加载和执行时，应保持现有行为，包括必要的 hook 状态字段写入、context engine 通知和插件侧回调。修复只把 hook failure 降级为 best-effort failure，不移除 hook。

### 3.3 历史状态必须自动收敛

对于“已 ended、已 completion announced、缺少 cleanupCompletedAt”的历史 run，升级后第一次启动可以执行一次恢复处理，但处理后不能在后续启动继续反复 finalize 同一批 run。

### 3.4 Windows bundle import 仅做定向兼容

runtime import 路径修复必须只作用于 bundle root 入口这类明确场景，不能全局改变非 bundle、开发模式、macOS、Linux 或 OpenClaw 原生 `dist` 运行路径的相对 import 行为。

### 3.5 不做破坏性数据修复

产品修复不应要求用户删除 `runs.json`、清空 OpenClaw state、重置会话数据库或删除 workspace。用户数据清理只能作为支持侧临时 workaround，不能作为正式方案。

### 3.6 日志可诊断但不刷屏

如果一批历史 run 在恢复时遇到 hook failure，应提供可诊断的 warning 和汇总信息，但不应对每次启动、每条历史 run 长期重复打印同样的错误。

## 4. 实现方案

### 4.1 第一阶段：cleanup finalize 状态收敛

优先修改 OpenClaw subagent cleanup finalize 流程，使 ended hook 成为真正的 best-effort 后置动作。

建议在 `finalizeSubagentCleanup(...)` 中调整 `didAnnounce=true` 分支：

```ts
try {
  await emitCompletionEndedHookIfNeeded(...);
} catch (error) {
  console.warn('[SubagentRegistry] subagent ended hook failed during cleanup finalize:', error);
}

await completeCleanupBookkeeping(...);
```

实现时需要按实际代码结构处理顺序，但核心要求是：hook failure 不能阻止 cleanup bookkeeping 执行。

同时检查相邻路径：

- `finalizeResumedAnnounceGiveUp(...)` 当前已经在 hook 前写 bookkeeping，风险较小，但仍可把 hook failure 降级，避免无意义的外层失败日志。
- announce 重试放弃路径如果已经写入 `cleanupCompletedAt`，外层 catch 不应再把 `cleanupHandled` 置回 false。
- 如果 run 已经存在 `cleanupCompletedAt`，恢复流程应直接跳过或短路，保持幂等。

### 4.2 第二阶段：Windows bundle runtime import 兼容

在确认 cleanup 状态可以收敛后，再修 bundle runtime import 路径。优先选择定向 resolver 修复：

- 当 import 基准 URL 指向 `gateway-bundle.mjs` 时，把 `./subagent-registry.runtime.js` 解析到同级 `dist/subagent-registry.runtime.js`。
- 当 import 基准 URL 已经位于 `dist` 内，保持原有相对解析。
- 不改变其他动态 import 的默认语义，避免影响 OpenClaw 其他 lazy chunk。

如果上游 patch 难以快速落地，可以使用包装兼容方案作为过渡：

- 在 Windows runtime 包根目录生成一个 ESM shim：`subagent-registry.runtime.js`。
- shim 只做 re-export：从 `./dist/subagent-registry.runtime.js` 导出。
- 不复制真实 runtime 文件到根目录，避免 root/dist 双份代码漂移。

两种方案都需要验证 Windows 产物中 `cfmind\dist\subagent-registry.runtime.js` 仍被保留。

### 4.3 第三阶段：恢复日志和统计

恢复 `runs.json` 时可以增加轻量统计：

- 本次恢复发现多少 ended run 缺少 cleanup completion。
- 成功 finalize 多少条。
- ended hook 失败多少条。
- 第二次启动同一批 run 不应再次进入 finalize。

统计日志应是摘要，不应在常态启动中对每个历史 run 输出 info 级日志。

### 4.4 与 sessions.patch 超时的关系

本修复可以减少 gateway 启动阶段的历史 cleanup 重放压力，但不直接改变 `OpenClawRuntimeAdapter.ensureSessionModelForTurn()` 对 `sessions.patch` 的调用策略。

`sessions.patch` 超时仍建议作为后续独立问题继续处理，方向包括：

- gateway readiness 只在 gateway 完成自身 ready 后再放行关键请求。
- 避免 channel polling 的 `sessions.list` 在首个用户请求前抢占 gateway。
- 对 session model patch 做更清晰的 timeout、retry 或非阻断策略评估。

## 5. 边界情况

### 5.1 hook 永久失败

即使 hook 永久失败，cleanup 状态也应完成。风险是某些插件的 ended hook 没有被执行。这个风险可接受，因为当前状态下这些 run 已经完成且已公告；继续无限重放的风险更高。

### 5.2 hook 成功但 bookkeeping 失败

如果 hook 成功后 bookkeeping 失败，仍可能重放。实现时需要确保 bookkeeping 本身的失败被明确记录，并区分可恢复的 IO 问题和代码异常。不能因为本次修复吞掉真正的数据写入错误。

### 5.3 cleanup: delete

`cleanup: delete` 的 run 不应因为 hook failure 被保留下来。附件清理和 run 删除的原有顺序需要保留，hook failure 不能阻断删除流程。

### 5.4 历史 run 集中处理

升级后第一次启动可能处理数百条历史 run。实现应避免并发风暴和 per-run warning 刷屏，可以串行或限流处理，并输出摘要。

### 5.5 非 Windows 和非 bundle 环境

bundle import 兼容不能影响非 Windows 开发环境或 macOS/Linux 产物。路径判断必须足够窄，最好以入口文件名和文件位置作为条件。

当前 智码 GLM Code 的实际启动路径里，只有 Windows fast path 会把 `gateway-bundle.mjs` 作为 gateway 主入口；macOS/Linux 虽然产物里也可能存在该 bundle，但不会通过它启动 gateway。因此 `cfmind\subagent-registry.runtime.js` 这类 root-relative runtime import 错误当前只确认影响 Windows bundle fast path。cleanup finalize 被 ended hook failure 阻断的问题本身是平台无关的，仍需要用状态收敛修复处理。

### 5.6 包产物结构变化

如果未来 OpenClaw runtime 包结构变化，shim 或 resolver 需要能失败得足够清楚。验证时必须检查最终安装目录，而不是只检查源码目录。

## 6. 验收标准

1. 使用包含历史 ended run 的 `runs.json` 启动 gateway 后，缺少 `cleanupCompletedAt` 的 run 会被处理到收敛状态。
2. 模拟 `emitCompletionEndedHookIfNeeded(...)` 抛错时，cleanup bookkeeping 仍会执行。
3. 第二次启动同一份 state 时，不再重复打印同一批 `subagent cleanup finalize failed`。
4. 正常 hook 成功路径仍会执行 ended hook，不丢失现有插件通知行为。
5. Windows bundle 产物中，`gateway-bundle.mjs` 触发的 subagent runtime lazy import 能解析到 `cfmind\dist\subagent-registry.runtime.js`。
6. 不要求用户删除 `runs.json` 或重置 OpenClaw state 即可恢复。
7. 新建 subagent、完成 subagent、`cleanup: keep` 和 `cleanup: delete` 基本路径均无回归。
8. 日志中可以看到一次性恢复摘要或单次 warning，但不出现长期重复的历史 run finalize 失败刷屏。
9. 对 `sessions.patch` 超时不做过度承诺；若仍有超时，应能通过后续独立 spec 继续分析 gateway readiness 和 patch 调用策略。

## 7. 验证计划

### 7.1 fixture 验证

构造或复用用户提供的 `runs.json` 形态：

- 多条 `status: ended`。
- 已有 `completionAnnouncedAt`。
- 缺少 `cleanupCompletedAt`。
- `cleanupHandled` 为 false。

在 hook import 失败的情况下启动恢复流程，验证 run 状态会收敛。

### 7.2 单元测试

为 cleanup finalize 增加 focused test：

- hook 成功时，bookkeeping 执行且 hook 状态保持原行为。
- hook 抛错时，bookkeeping 仍执行。
- 已有 `cleanupCompletedAt` 时，恢复流程不重复 finalize。
- `cleanup: delete` 不受 hook failure 阻断。

### 7.3 Windows 包验证

使用 Windows 产物或等价目录结构验证：

- `cfmind\gateway-bundle.mjs` 存在。
- `cfmind\dist\subagent-registry.runtime.js` 存在。
- 启动 gateway 时不再寻找不存在的 `cfmind\subagent-registry.runtime.js`，除非该文件是显式 shim。

### 7.4 回归验证

执行一次新 subagent run，从创建、结束、公告到 cleanup 完成全流程确认无回归。随后重启应用，确认该 run 不再被恢复为待 cleanup 状态。

### 7.5 日志验证

检查 `gateway` 和 `main` 日志：

- 不再长期重复同一批 run id 的 `subagent cleanup finalize failed`。
- 如果存在 hook failure，日志应能定位 run id 和失败原因。
- 恢复摘要的日志级别和频率符合生产日志要求。
