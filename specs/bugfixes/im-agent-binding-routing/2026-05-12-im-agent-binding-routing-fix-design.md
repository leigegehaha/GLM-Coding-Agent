# IM 绑定 Agent 后仍由默认 Agent 响应修复 Spec

## 1. 概述

### 1.1 问题

用户在 智码 GLM Code 中把某个 IM 渠道绑定到指定 Agent 后，来自该 IM 的后续消息仍可能表现为主 Agent 或其他 Agent 的行为。例如微信已在 Agent 设置里绑定到一个具备特定身份/性格的 Agent，但在微信里询问“你是谁、你的助手身份/性格是什么”时，回复仍像主 Agent。

这个问题的关键不在 UI 是否显示绑定成功，而在 OpenClaw 实际处理该 IM 消息时解析出的 `agentId` 是否等于绑定目标 Agent。

### 1.2 当前现状

当前链路分为四层：

1. **UI 绑定层**：`AgentSettingsPanel` / `AgentCreateModal` 将 IM 绑定写入 `IMSettings.platformAgentBindings`。
2. **本地存储层**：`IMStore` 把 `settings.platformAgentBindings` 存进 SQLite 的 `im_config`。
3. **OpenClaw 配置同步层**：`OpenClawConfigSync.buildBindings()` 将 智码 GLM Code 的绑定转换成 OpenClaw 顶层 `bindings`。
4. **运行期 session 同步层**：OpenClaw channel plugin 收到 IM 消息后调用 `resolveAgentRoute()`，得到真实 `sessionKey`，智码 GLM Code 再通过 `OpenClawChannelSessionSync` 把该 channel session 映射成本地 Cowork session。

已有代码已经处理了一部分历史问题：

- `bindingsChanged` 会触发 gateway 硬重启，避免 channel 插件继续使用旧配置。
- `im_session_mappings` 已有 `agent_id` 和 `openclaw_session_key`，用于记录本地 session 所属 Agent 与真实 OpenClaw channel key。
- `OpenClawChannelSessionSync` 会在发现绑定变化时创建新的本地 Cowork session，避免把新 Agent 的消息混进旧 Agent 会话。
- polling 会通过 `isCurrentBindingKey()` 过滤旧 Agent 的 channel session key。

但这些机制都依赖一个前提：OpenClaw runtime 必须先把新 IM 消息路由到正确 Agent。如果 OpenClaw `bindings` 本身没有命中，后续 智码 GLM Code 的 session 映射只能看到一个已经路由错的 `sessionKey`。

### 1.3 根因

`OpenClawConfigSync.buildBindings()` 当前对平台级绑定生成的配置是：

```json
{
  "agentId": "target-agent",
  "match": {
    "channel": "openclaw-weixin"
  }
}
```

智码 GLM Code 侧的意图是“这个平台/渠道的所有账号都路由到 target-agent”。但 OpenClaw 当前路由语义不是这样：

- `match.accountId` 省略：只匹配默认账号。
- `match.accountId: "*"`：才匹配任意账号。
- `match.accountId: "<id>"`：匹配指定账号。

微信 QR 登录后，OpenClaw 插件处理入站消息时会传入真实账号 ID：

```typescript
resolveAgentRoute({
  channel: 'openclaw-weixin',
  accountId: deps.accountId,
  peer: { kind: 'direct', id: ctx.To },
})
```

因此 `match: { channel: 'openclaw-weixin' }` 不会命中真实微信账号，只会回落到默认 Agent。用户看到的结果就是：绑定在 UI 中存在，但微信里实际回答仍是主 Agent 或其他默认路由结果。

同类风险也存在于：

- 单实例平台级绑定：`weixin`、`netease-bee`。
- 多实例平台的 legacy 平台级 binding fallback：例如 `telegram` / `discord` / `dingtalk` 等如果存在 `platformAgentBindings[platform]`。

per-instance 绑定当前已经带 `accountId`，不属于同一个根因。

## 2. 用户场景

### 场景 A: 微信绑定到特定 Agent

**Given** 用户把微信绑定到 Agent A，Agent A 有明确的身份/性格描述
**When** 用户在微信里问“你是谁？你的助手身份是什么？”
**Then** OpenClaw 解析出的 route 应该是 Agent A，回答应体现 Agent A 的身份/性格，而不是主 Agent。

### 场景 B: 修改绑定后继续从同一个微信联系人提问

**Given** 微信原先由主 Agent 响应，后来被绑定到 Agent B
**When** 用户在同一个微信联系人里发送新问题
**Then** 新消息必须进入 `agent:agent-b:openclaw-weixin:<accountId>:direct:<peerId>` 这类 session key，而不是继续使用 `agent:main:...`。

### 场景 C: 多实例平台的全平台 fallback

**Given** 某多实例平台存在平台级 legacy 绑定，没有精确实例绑定
**When** 任意启用账号收到新消息
**Then** 平台级绑定应覆盖所有账号，而不是只覆盖默认账号。

## 3. 功能需求

### FR-1: 平台级绑定必须匹配任意账号

凡是 智码 GLM Code 表达“平台级绑定”的 OpenClaw route binding，都必须显式写入：

```json
{ "match": { "channel": "<channel>", "accountId": "*" } }
```

不再使用省略 `accountId` 表达全平台匹配。

### FR-2: 实例级绑定继续使用精确账号

多实例平台的 `platform:instanceId` 绑定应继续生成精确 `accountId`：

```json
{ "match": { "channel": "<channel>", "accountId": "<resolved-account-id>" } }
```

精确绑定优先级应高于平台级 wildcard fallback。

### FR-3: 绑定变更后要能验证真实 runtime route

修复后，判断 IM 是否真正绑定到对应 Agent 的验收方式不是只看 UI 开关，而是从真实 IM 渠道发问，让 Agent 自述自己的助手身份/性格。

可选辅助验证：

- 检查 OpenClaw debug 日志中的 `resolveAgentRoute: agentId=... sessionKey=...`。
- 检查 智码 GLM Code 本地 `im_session_mappings.openclaw_session_key` 是否包含目标 Agent ID。

### FR-4: 旧 session 不应掩盖新路由

如果绑定切换后 gateway 仍产生旧 Agent 的 `sessionKey`，智码 GLM Code 应把它识别为 stale route，而不是把它当作绑定已生效。这个需求用于暴露 OpenClaw route 未命中或 gateway 未重启问题。

## 4. 实现方案

### 4.1 修正 OpenClaw binding 生成

修改 `src/main/libs/openclawConfigSync.ts` 的 `buildBindings()`：

- 单实例平台级绑定：

```typescript
bindings.push({ agentId, match: { channel, accountId: '*' } });
```

- 多实例平台 legacy 平台级 fallback：

```typescript
bindings.push({ agentId: platformAgentId, match: { channel, accountId: '*' } });
```

- per-instance 绑定保持现状：

```typescript
bindings.push({ agentId, match: { channel, accountId } });
```

这样符合 OpenClaw 的路由语义：精确账号绑定优先，wildcard 账号作为平台级 fallback。

### 4.2 增加 route binding 单元测试

在 `openclawConfigSync.runtime.test.ts` 增加覆盖：

1. 微信平台级绑定输出 `match.accountId === '*'`。
2. 多实例平台级 fallback 输出 `accountId === '*'`。
3. 多实例 per-instance 绑定仍输出精确 `accountId`。
4. 绑定数组顺序保持 per-instance 在 platform wildcard 前，避免 wildcard 抢占精确绑定。

### 4.3 增加 session sync stale key 测试

在 `openclawChannelSessionSync.test.ts` 或 `openclawRuntimeAdapter.test.ts` 增加覆盖：

1. 当前绑定为 Agent B，但收到 `agent:main:openclaw-weixin:...` 时，`isCurrentBindingKey()` 返回 false。
2. polling 不创建/不更新旧 Agent 的 local mapping。
3. 实时事件路径如果已经记住旧 session key，应至少有明确诊断，避免误判为绑定生效。

第三点可以先做日志/测试暴露，不一定在本次强制改变事件处理行为；核心修复仍是让 OpenClaw route 正确命中。

### 4.4 增加绑定生效诊断

为了后续定位同类问题，建议在低频路径添加 debug 级诊断：

- `buildBindings()` 输出 binding 数量和关键 match，不打印敏感凭证。
- `OpenClawChannelSessionSync` 在发现 `keyAgentId !== currentAgentId` 时记录 channel、platform、accountId、keyAgentId、currentAgentId。

日志必须保持英文、自然语言、debug/warn 级别分明，避免在 polling 热路径输出 info。

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| 微信绑定非主 Agent | 生成 `{ channel: 'openclaw-weixin', accountId: '*' }` |
| 微信未绑定或绑定主 Agent | 不生成 binding，继续走默认主 Agent |
| 多实例精确绑定 | 保留精确 `accountId` |
| 多实例平台级 fallback | 生成 `accountId: '*'` |
| 精确绑定和 wildcard 同时存在 | 精确绑定排在前，OpenClaw 先命中精确规则 |
| 绑定目标 Agent 被删除或禁用 | 不生成 binding，回落主 Agent；删除 Agent 时继续清理 `platformAgentBindings` |
| gateway 未运行 | 配置写入 SQLite；下次启动 gateway 后生效 |
| gateway 正在运行且绑定变化 | `bindingsChanged` 触发硬重启 |
| 有 active workload 导致重启延迟 | UI 应避免宣称“运行时已生效”；验证以真实 IM 问答为准 |
| 历史旧 session | 不迁移历史回答；新消息应进入新 Agent session |

## 6. 验收标准

1. 绑定微信到 Agent A 后，从微信问“你是谁/你的助手身份是什么”，回复体现 Agent A 的身份/性格。
2. OpenClaw 日志中的 route 结果为目标 Agent，`sessionKey` 前缀包含 `agent:<targetAgentId>:openclaw-weixin:...`。
3. `openclaw.json` 中微信平台级 binding 的 `match.accountId` 为 `"*"`。
4. 多实例平台的 per-instance binding 仍使用精确账号 ID。
5. 多实例平台的 platform fallback binding 使用 `"*"`，能覆盖任意账号。
6. 切换绑定后，新 IM 消息不再继续写入旧 Agent 的 Cowork session。
7. 相关单元测试通过。

## 7. 验证计划

### 单元测试

```bash
npm test -- openclawConfigSync
npm test -- openclawChannelSessionSync
```

### 手动验证

1. 创建或选择一个身份非常明确的 Agent，例如“你是代码审查助手，只用代码审查视角回答”。
2. 在 Agent 设置中把微信绑定到该 Agent，并保存。
3. 等待 gateway 重启完成，或重启 OpenClaw gateway。
4. 在微信里发送：“你是谁？请说出你的助手身份和性格。”
5. 验证回答是否体现该 Agent 的身份/性格。
6. 再切回主 Agent 或其他 Agent，重复同一问题，确认回复随绑定变化。

### 配置验证

检查生成的 `openclaw.json`：

```json
{
  "bindings": [
    {
      "agentId": "<target-agent>",
      "match": {
        "channel": "openclaw-weixin",
        "accountId": "*"
      }
    }
  ]
}
```

如果仍是 `match: { "channel": "openclaw-weixin" }`，说明修复没有覆盖到平台级绑定生成。
