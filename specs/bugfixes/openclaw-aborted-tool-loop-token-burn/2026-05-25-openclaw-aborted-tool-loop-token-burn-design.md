# OpenClaw Aborted 工具循环导致 Token 消耗修复设计文档

## 1. 概述

### 1.1 问题

用户反馈“在没有定时任务、没有主动发起任务的时段，智码 GLM Code 仍然持续消耗 token”。本次网关侧抓到的请求证明，异常消耗不是普通心跳或 `cron.list` 轮询，而是一次真实模型请求在持续重放异常上下文。

关键现场如下：

| 字段 | 值 |
|---|---|
| traceId | `16ba53bddcecf1d8` |
| 请求时间 | `2026-05-18 18:05:56 UTC+8` |
| model | `kimi-k2.6` |
| stream | `true` |
| message count | `6936` |
| 文本字符数 | 约 `226110` |
| `tool: Aborted` | `3467` 条 |
| `assistant content=null` | `3466` 条 |
| 重复工具调用 | `exec {"command":"dir"}` 重复 `3457` 次 |

请求内容从 `2026-05-18 14:59` 的“流失召回业务干预分层市占明细表分析”任务开始。模型先尝试读取 Excel 文件，随后工具调用持续返回 `Aborted`。之后 agent 没有结束当前 run，而是不断让模型继续选择工具，最终形成以下重复链路：

```text
assistant tool_calls: exec {"command":"dir"}
tool: Aborted
assistant tool_calls: exec {"command":"dir"}
tool: Aborted
...
```

到 `18:05:56` 时，一次新的模型请求已经携带数千条无效工具轮次。只要 run 继续，后续每次请求都会继续带上更长的历史，因此用户会看到“没有主动任务也在持续烧 token”的表象。

### 1.2 根因

根因是 **工具调用被连续 abort 后，agent run 没有进入终止态，且异常工具轮次被继续写入并回放到模型上下文**。

这个问题由三层缺口叠加触发：

1. 旧版本 OpenClaw/智码 GLM Code 没有对连续 `Aborted` 工具结果设置硬断路。
   - 工具执行已经无法取得结果。
   - 模型仍被允许反复选择同类工具。
   - 同一 run 在数小时内继续向模型发请求。

2. 当前 OpenClaw 虽已有 tool loop detection / circuit breaker 能力，但默认关闭。
   - OpenClaw 配置说明中 `tools.loopDetection.enabled` 默认是 `false`。
   - 智码 GLM Code managed config 当前没有强制开启该能力。
   - 因此用户升级后，如果只依赖默认配置，同类循环仍可能没有被拦住。

3. tool loop detection 不是完整闭环。
   - 它依赖工具调用经过 before/after hook 并成功记录 outcome。
   - 如果 `Aborted` 来自更外层取消、订阅断开、runner stop 或历史恢复，可能不能稳定形成 no-progress outcome。
   - 当前的回放清洗主要处理心跳、`NO_REPLY`、tool_use/tool_result 配对和工具结果截断，不等价于“发送模型前清理数千条 `assistant:null + tool:Aborted` 异常轮次”。

因此，单纯打开 tool loop detection 能挡住本次“同一工具同一参数反复失败”的主路径，但不能声明为彻底杜绝。完整修复需要同时包含默认启用、`Aborted` 专项断路、模型请求前历史清洗和 run 生命周期收口。

### 1.3 当前代码状态

与本问题相关的当前代码状态：

- `src/main/libs/openclawHistory.ts` 已过滤 heartbeat prompt/ack、`NO_REPLY` 和空文本 assistant，但这主要覆盖 智码 GLM Code 对 `chat.history` 的 UI 同步，不等价于 OpenClaw 发送模型请求前的上下文清洗。
- `src/main/libs/openclawConfigSync.ts` 生成 managed OpenClaw 配置时设置了 `tools.deny` 和 `tools.web.search.enabled=false`，但未设置 `tools.loopDetection.enabled=true`。
- OpenClaw 源码中已有 `tool-loop-detection.ts`，包含 warning、critical 和 global circuit breaker 阈值，但默认配置为关闭。
- OpenClaw 的 transcript repair 会维护 tool_use/tool_result 配对，避免 strict provider 拒绝请求，但不会自动把大量连续 aborted tool turns 压缩或删除。

### 1.4 目标

修复目标：

1. 同一 run 内连续工具 `Aborted` 不得无限继续请求模型。
2. 智码 GLM Code managed runtime 默认开启 OpenClaw tool loop detection / circuit breaker。
3. 对 `Aborted` 工具结果增加独立硬断路，即使通用 loop detection 没有命中，也能终止 run。
4. 发送模型请求前清理或压缩旧版本残留的 `assistant tool_calls + tool Aborted` 异常历史，避免一次请求携带数千条无效轮次。
5. run 被用户 stop、工具系统 abort 或断路器终止后，状态必须收口，不再自动续跑同一任务。
6. UI 应展示明确的任务失败或已中止状态，而不是静默继续后台消耗。
7. 修复后，类似现场不应超过有限次数的工具尝试和模型请求。

### 1.5 非目标

本修复不做以下事情：

- 不重构定时任务系统。
- 不改变 `cron.list`、`sessions.list`、gateway health/tick 等状态轮询行为。
- 不用前端隐藏 token 消耗现象来掩盖后台 run 未结束。
- 不禁用 `exec`、`read` 等工具。
- 不移除模型在瞬时失败后进行少量恢复尝试的能力。
- 不把 provider 计费后台的小时级聚合误差作为产品侧唯一解释。
- 不要求用户手动清空 OpenClaw state 或删除会话历史。

## 2. 用户场景

### 场景 1: 同一工具连续 Aborted

**Given** agent 在一次任务中多次调用同一工具和同一参数
**And** 工具结果连续返回 `Aborted`
**When** 连续失败次数达到阈值
**Then** 系统应终止当前 run
**And** 不再向模型发送下一轮请求
**And** UI 显示任务因工具连续中止而失败

### 场景 2: 瞬时工具失败后恢复

**Given** 某个工具调用偶发返回 `Aborted` 或超时
**When** 后续工具调用正常成功并产生有效结果
**Then** 系统不应过早终止任务
**And** 模型应能继续完成用户任务

### 场景 3: 用户主动停止任务

**Given** 用户点击停止当前任务
**When** 智码 GLM Code 调用 `chat.abort` 或 OpenClaw 工具收到 abort signal
**Then** 当前 run 应进入终止态
**And** 不应把用户停止后的 `Aborted` 工具结果作为新上下文继续喂给模型
**And** 不应在用户停止后自动重启同一任务

### 场景 4: 升级后打开旧污染会话

**Given** 旧版本已经写入大量 `assistant tool_calls + tool Aborted` 历史
**When** 用户升级后继续该会话或 OpenClaw 恢复该 session
**Then** 发送模型请求前应清理或压缩这些异常轮次
**And** 单次请求不应携带数千条 aborted 历史

### 场景 5: 正常工具轮次保留

**Given** 会话中存在正常 tool call 和对应 tool result
**When** 发送模型请求或做 history sync
**Then** 正常工具结果应保留
**And** 不应因为新增清洗逻辑破坏 provider 所要求的 tool_call/tool_result 配对

### 场景 6: 无活动任务时无模型请求

**Given** 用户没有正在运行的 Cowork / IM / cron 任务
**When** 智码 GLM Code 只进行 gateway 状态轮询、session list 或 cron list
**Then** 不应产生新的模型请求
**And** 日志中不应出现 `chat.send`、embedded run start 或 provider request

## 3. 功能需求

### FR-1: Managed OpenClaw 默认开启 tool loop detection

智码 GLM Code 生成的 managed OpenClaw 配置必须启用工具循环检测。

建议默认配置：

```json
{
  "tools": {
    "loopDetection": {
      "enabled": true,
      "historySize": 40,
      "warningThreshold": 6,
      "unknownToolThreshold": 6,
      "criticalThreshold": 10,
      "globalCircuitBreakerThreshold": 16,
      "detectors": {
        "genericRepeat": true,
        "knownPollNoProgress": true,
        "pingPong": true
      }
    }
  }
}
```

阈值需要足够低，确保本次 `dir` 重复在几十次内被拦截；同时保留少量恢复空间，避免偶发失败立即中断任务。

### FR-2: `Aborted` 必须被识别为 no-progress outcome

当工具结果文本为 `Aborted`，或工具错误明确表示 abort/cancel/operation aborted 时，应被记录为无进展 outcome。

该 outcome 应进入 tool loop detection 的 hash 计算和 streak 计算。对于相同工具名、相同参数、相同 `Aborted` 结果，连续出现达到阈值时应触发 critical circuit breaker。

### FR-3: 增加 `Aborted` 专项断路器

通用 loop detection 之外，需要一个更直接的 `Aborted` 专项断路器。

建议规则：

- 同一 run 内，同一工具签名连续 `Aborted` 达到 5 次，返回明确 warning 给模型或直接终止。
- 同一 run 内，同一工具签名连续 `Aborted` 达到 8 次，必须终止当前 run。
- 同一 run 内，任意工具累计 `Aborted` 达到 20 次，即使工具签名不同，也必须终止当前 run。
- 用户主动 stop 导致的 abort 不进入“继续重试”分支，应直接完成终止收口。

专项断路器不能只把下一次工具调用变成一个普通 tool error。否则模型仍可能继续选择工具。critical 级别必须能让 runner 停止继续调用模型。

### FR-4: Critical circuit breaker 必须终止 run

当前 before-tool-call hook 如果返回 blocked，模型可能仍收到一个错误结果并继续下一轮推理。对于 critical loop，应提升为 run 级终止信号。

终止要求：

1. 停止当前 active run 的后续模型请求。
2. 向 gateway / 智码 GLM Code 发出 final error 或 lifecycle error。
3. 清理 active turn。
4. 不把该 runId 放入可继续续跑状态。
5. UI 显示可理解的失败信息，例如“工具连续中止，任务已停止以避免继续消耗 token”。

### FR-5: 发送模型请求前清理异常 aborted 历史

OpenClaw 在组装模型上下文前，应识别旧版本污染的异常历史。

识别模式：

```text
assistant content=null 或空文本
assistant tool_calls: [...]
tool content="Aborted"
```

处理规则：

- 如果这类轮次是连续的大段历史，应压缩为一条 bounded diagnostic summary，或直接删除整组 assistant/tool pair。
- 不能只删除 `tool` 消息而保留 assistant tool_calls，避免 strict provider 报 tool result 缺失。
- 保留最近少量有效失败证据即可，例如最多 1-3 组，帮助模型理解工具不可用。
- 对于当前正在执行的 active turn，不应在工具结果尚未配对完成时误删。

目标是：即使旧会话里已经有数千条 `Aborted` 轮次，升级后下一次模型请求也不会原样携带这些历史。

### FR-6: 用户 stop 后不再继续自动 retry

当 智码 GLM Code 调用 `stopSession()` 或 gateway 收到 `chat.abort` 后：

- OpenClaw 应将当前 run 标记为 terminal aborted。
- 后续 late tool result / assistant event 不应重新打开该 run。
- 如果 session history 中出现 stop 产生的 `Aborted` tool result，不应触发下一轮模型请求。
- 智码 GLM Code active turn cleanup 不应留下可继续执行的 pending retry。

### FR-7: 智码 GLM Code history sync 不引入异常消息

智码 GLM Code 从 `chat.history` 同步 UI 消息时，应继续忽略：

- 空文本 assistant。
- `content=null` assistant。
- 非当前 turn 的 tool result。
- `tool: Aborted` 这类无可见用户价值且无配对上下文的异常历史。

该要求不能替代 OpenClaw 发送模型请求前的清洗，但可以避免旧污染在 UI 中再次暴露。

### FR-8: 日志必须能定位 token 消耗原因

新增日志应帮助定位以下事实：

- 某个 run 因连续 `Aborted` 被断路器终止。
- 触发断路器的 tool name、参数摘要、连续次数和 runId/sessionKey。
- 模型请求前清理了多少条 aborted tool turns。
- tool loop detection 是否在 managed config 中启用。

日志要求：

- 使用英文。
- 使用模块 tag，例如 `[OpenClawRuntime]`、`[OpenClawConfigSync]` 或 OpenClaw 侧对应 subsystem tag。
- 不在每次工具循环都打 info 级日志；高频计数用 debug，触发断路时用 warn/error。
- error/warn 必须包含可定位的 sessionKey/runId。

## 4. 实现方案

### 4.1 智码 GLM Code managed config 启用 loop detection

修改 `src/main/libs/openclawConfigSync.ts` 中 generated config 的 `tools` 段：

```typescript
tools: {
  deny: [...MANAGED_TOOL_DENY],
  loopDetection: {
    enabled: true,
    historySize: 40,
    warningThreshold: 6,
    unknownToolThreshold: 6,
    criticalThreshold: 10,
    globalCircuitBreakerThreshold: 16,
    detectors: {
      genericRepeat: true,
      knownPollNoProgress: true,
      pingPong: true,
    },
  },
  web: {
    search: {
      enabled: false,
    },
  },
},
```

如果 OpenClaw 后续把 loop detection 默认值改为 true，智码 GLM Code 仍应显式写入该配置，避免旧 runtime 或用户 overlay 下行为漂移。

### 4.2 OpenClaw 侧记录 `Aborted` outcome

检查 OpenClaw 的 tool execution wrapper、`pi-tools.before-tool-call.ts`、`tool-loop-detection.ts` 和相关 runtime hooks。

目标是确保以下路径都能调用 `recordToolCallOutcome()`：

- 工具正常返回 `{ content: [{ text: "Aborted" }] }`。
- 工具抛出 abort/cancel 类错误。
- before-tool-call hook blocked 后返回的错误结果。
- wrapper 因 abort signal 提前结束工具。

`hashToolOutcome()` 应把 `Aborted`、`Operation aborted`、`Request was aborted` 等稳定归一为 no-progress outcome，避免同类 abort 由于错误对象形态不同而逃过 streak 统计。

### 4.3 OpenClaw 侧 run 级 `Aborted` 断路器

建议新增一个小的 run-scope 状态结构：

```typescript
type AbortedToolLoopState = {
  totalAborted: number;
  consecutiveBySignature: Map<string, number>;
};
```

每次工具结果完成后更新该状态：

1. 计算 tool signature：tool name + stable params hash。
2. 判断 result/error 是否为 abort outcome。
3. 如果不是 abort，重置对应连续计数。
4. 如果是 abort，累加 run total 和 signature streak。
5. 达到 critical 阈值时抛出或返回 run-level terminal error。

该逻辑可以放在 OpenClaw runner 内部，比单纯依赖 before-tool-call hook 更可靠，因为它发生在工具结果被观察到之后、下一轮模型请求之前。

### 4.4 模型请求前清理 aborted tool turn 历史

建议在 OpenClaw 的 session history sanitize 阶段增加一个独立函数，例如：

```typescript
sanitizeAbortedToolLoopHistory(messages, {
  maxPreservedAbortedPairs: 3,
  minCollapseRunLength: 5,
})
```

处理策略：

- 按顺序扫描 assistant/tool pair。
- 如果 assistant 只有 tool_calls、没有可见文本，且紧随其后的 tool result 全部是 `Aborted`，标记为 aborted tool pair。
- 连续 aborted tool pair 数量超过阈值时，删除大部分 pair。
- 可选地插入一条短 summary，说明历史中曾发生多次 aborted 工具调用。
- 保证输出后 transcript 仍符合 provider 的 tool_call/tool_result 配对规则。

该函数应在发送模型请求前运行，而不仅在 `chat.history` 返回给 智码 GLM Code 时运行。

### 4.5 智码 GLM Code 收到断路错误后的 UI 收口

当 OpenClaw 因断路器终止 run 时，智码 GLM Code `openclawRuntimeAdapter.ts` 应按错误完成路径处理：

- 当前 assistant streaming 停止。
- 当前 session 从 running 状态退出。
- 输入区恢复可用。
- 插入一条系统错误消息或 assistant 错误消息，说明任务已停止以避免继续消耗。
- 不触发 `continueSession` 或 fallback retry。

已有的 lifecycle error、chat aborted 和 recently closed run guard 应继续生效，避免 late event 污染后续任务。

### 4.6 历史污染的可选迁移

首版修复可以不做 SQLite/OpenClaw state 的破坏性迁移，但应保证运行时清洗足以阻止旧污染继续烧 token。

后续可以考虑只读诊断或温和迁移：

- 检测某个 OpenClaw session 是否存在超过阈值的 aborted tool loop。
- 标记 session 为 needs compaction 或 needs repair。
- 在用户继续该 session 前清理对应 OpenClaw transcript。

迁移不能要求用户清空全部历史。

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| 工具偶发一次 `Aborted` 后恢复 | 不终止 run，只记录 outcome |
| 同一 `dir` 连续返回 `Aborted` | 达到阈值后终止 run |
| 多个不同工具都返回 `Aborted` | total aborted 达到全局阈值后终止 run |
| 用户主动 stop | 直接终止，不再让模型继续 retry |
| strict provider 需要 tool result 配对 | 清理时删除整组 assistant/tool pair 或保留完整 pair，不制造孤儿消息 |
| 旧历史含数千条 aborted pair | 发送模型前压缩或删除，单次请求不原样携带 |
| 正常工具失败返回具体错误文本 | 交给通用 loop detection；不要误判为 `Aborted` 专项规则 |
| `process poll` 等合法轮询 | 继续由 known poll no-progress 检测处理，避免过早中断正常后台进程等待 |
| gateway 状态轮询 | 不参与模型请求，不受本修复影响 |
| 定时任务真实触发 | 如果 cron session 内工具持续 abort，同样应被断路器终止 |

## 6. 涉及文件

智码 GLM Code 侧：

- `src/main/libs/openclawConfigSync.ts`：managed config 默认启用 `tools.loopDetection`。
- `src/main/libs/openclawConfigSync.runtime.test.ts` 或相邻测试：验证生成的 OpenClaw config 包含 loop detection 配置。
- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`：处理 OpenClaw 断路器错误、确保 UI 收口、不触发 fallback retry。
- `src/main/libs/openclawHistory.ts`：如需增强 history sync 对 `tool: Aborted` 的 UI 过滤，可在此补充。

OpenClaw patch 侧：

- `scripts/patches/v2026.4.14/`：新增或更新 OpenClaw runtime patch。
- `src/agents/tool-loop-detection.ts`：识别 abort outcome，调整 critical 行为。
- `src/agents/pi-tools.before-tool-call.ts`：确保 blocked / abort outcome 被记录。
- `src/agents/pi-embedded-runner/run/attempt.ts` 或相邻 runner 文件：在下一次模型请求前触发 run-level aborted circuit breaker。
- `src/agents/session-transcript-repair.ts` 或新增 sanitizer：清理旧 aborted tool loop 历史。

## 7. 验收标准

1. 智码 GLM Code 生成的 managed OpenClaw config 中包含 `tools.loopDetection.enabled=true`。
2. 构造同一工具同一参数连续返回 `Aborted` 的测试，run 在阈值内终止，不会继续调用模型到第 20 次以后。
3. 构造现场同类历史：`assistant:null + exec {"command":"dir"} + tool "Aborted"` 重复 3000 次；发送模型请求前被压缩或清理，最终请求不再包含数千条 aborted 轮次。
4. 用户点击 stop 后，当前 run 不再产生后续模型请求。
5. 偶发一次工具 `Aborted` 后恢复的任务可以继续完成。
6. 正常 tool_call/tool_result 配对不被破坏，OpenAI-compatible 和 Anthropic-compatible provider 都不因历史清洗报 tool result 缺失。
7. 无 active task 时，日志中只允许出现 `sessions.list`、`cron.list`、health/tick 等状态请求，不应出现 `chat.send` 或 provider request。
8. 断路器触发时 UI 能退出 running 状态，并展示明确失败原因。
9. 日志中能看到一次断路摘要，包括 sessionKey/runId、tool name、连续次数和清理数量；不会对每次循环刷 info 级日志。

## 8. 验证计划

### 8.1 单元测试

新增 focused tests：

- loop detection enabled config generation。
- `Aborted` outcome hash 和 no-progress streak。
- 同一 signature 连续 aborted 达到阈值触发 critical。
- total aborted 达到全局阈值触发 terminal。
- sanitizer 删除或压缩连续 aborted assistant/tool pair 后仍保持合法 transcript。

### 8.2 集成测试

构造一个 fake tool：

1. 每次调用都返回 `Aborted`。
2. 模型或测试 harness 持续选择同一工具。
3. 验证 run 在阈值内终止。
4. 验证 provider request 次数受限。
5. 验证 UI/adapter 收到 error completion，而不是保持 running。

### 8.3 现场 JSON 回放测试

使用本次网关 trace 的结构构造 fixture：

- 1 条 system。
- 1 条大 user。
- 1 条真实 assistant。
- 多组 `assistant tool_calls` + `tool Aborted`。

验证 sanitizer 输出：

- 不保留数千条 aborted pair。
- 不产生孤儿 tool result。
- 保留必要上下文和当前用户任务。
- token/字符规模降到可控范围。

### 8.4 手工日志验证

在本地运行 OpenClaw gateway + 智码 GLM Code：

1. 启动任务，模拟工具连续 abort。
2. 检查 `main-YYYY-MM-DD.log` 和 OpenClaw gateway log。
3. 确认断路后没有继续 `chat.send`。
4. 确认 UI 退出 loading。
5. 确认后续 `sessions.list`、`cron.list` 轮询不会产生模型请求。

### 8.5 回归验证

覆盖以下现有场景：

- 正常 Cowork 本地任务。
- 工具失败后模型改用其他方式完成任务。
- 用户主动停止任务。
- IM/channel 会话。
- cron session 真正触发任务。
- context compaction / silent maintenance。
- tool result backfill 和 history sync。

