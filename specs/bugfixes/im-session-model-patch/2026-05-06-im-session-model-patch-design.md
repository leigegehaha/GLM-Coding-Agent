# IM 会话模型切换未命中真实 sessionKey 修复 Spec

## 问题描述

用户在 智码 GLM Code 的 IM 对话历史中修改模型后，UI 与本地 SQLite 都显示模型已经切换，但实际从 IM 继续对话时，模型仍然是修改前的模型。普通非 IM Cowork 会话不存在这个问题。

实际观察到的状态：

1. `cowork_sessions.model_override` 已更新为用户新选择的模型
2. OpenClaw 中真实 IM channel 会话仍保留旧模型
3. OpenClaw 中额外出现了一个 `agent:main:lobsterai:<coworkSessionId>` managed 会话 key，并且新模型被写到了这个错误 key 上
4. IM 后续消息继续使用真实 channel key，例如 `agent:main:openclaw-weixin:<accountId>:direct:<peerId>`，因此仍然走旧模型

## 核心结论

**根因是 IM channel 会话的真实 OpenClaw `sessionKey` 只存在于运行期内存，没有持久化到 `im_session_mappings`。**

非 IM 会话的真实 key 本来就是 智码 GLM Code managed key：

```text
agent:{agentId}:lobsterai:{coworkSessionId}
```

所以 `sessions.patch` fallback 到 managed key 是正确的。

IM channel 会话的真实 key 来自 OpenClaw channel extension：

```text
agent:{agentId}:{channel}:{accountId}:{peerKind}:{peerId}
```

应用重启、channel polling 还没重新记住 key、或者只从 SQLite 加载会话详情时，当前 `patchSession()` 找不到真实 channel key，就 fallback 到 managed key。这个 fallback 会创建或修改错误的 OpenClaw session entry，导致 UI 看起来 patch 成功，但 IM runtime 实际没有切换模型。

| 会话类型 | 当前 fallback key | 是否正确 |
|---|---|---|
| 普通 Cowork | `agent:main:lobsterai:<sessionId>` | 正确 |
| IM channel | `agent:main:lobsterai:<sessionId>` | 错误 |
| IM channel 真实 key | `agent:main:openclaw-weixin:<account>:direct:<peer>` | 应优先使用 |

---

## 目标

1. IM channel session mapping 持久化真实 OpenClaw `sessionKey`
2. `patchSession()` 在内存 key 缺失时仍能找到真实 channel key
3. 对已知 IM channel 会话，禁止静默 fallback 到 managed key
4. 保持非 IM Cowork 会话现有行为不变
5. 补覆盖 app 重启后内存 key 丢失的回归测试
6. 模型下拉选择后立即给出 UI 反馈，避免等待 OpenClaw patch 返回造成卡顿感
7. 普通非 IM Cowork 会话在模型切换后继续追问时，发送前必须确保 OpenClaw 实际 session 模型与本地期望模型一致

## 非目标

1. 不改变 IM 对话历史同步算法
2. 不改变模型列表、provider 配置或 agent 默认模型逻辑
3. 不放开 remote-managed 会话的主动发消息能力
4. 不迁移历史 OpenClaw `sessions.json` 结构

## 实现方案

### 1. 扩展 IM 映射表

给 `im_session_mappings` 增加可空字段：

```sql
openclaw_session_key TEXT
```

该字段保存 OpenClaw channel runtime 的真实 session key。历史记录允许为空，以兼容升级前数据。

`IMSessionMapping` 增加：

```typescript
openClawSessionKey?: string;
```

### 2. 创建或复用 channel mapping 时写入 key

`OpenClawChannelSessionSync.resolveOrCreateSession(sessionKey)` 已经拿到了真实 key，因此在以下路径都要同步给 `IMStore`：

1. 新建 mapping 时写入 `openclaw_session_key`
2. 复用已有 mapping 时，如果字段为空或与当前 key 不一致，则更新
3. agent binding 变化后创建新 session 并更新 mapping target 时，也写入新 key

这样即使应用重启，SQLite 也能恢复真实 key。

### 3. patchSession key 选择顺序

`OpenClawRuntimeAdapter.patchSession(sessionId, patch)` 的 key 选择顺序调整为：

1. 当前 active turn 的 `sessionKey`
2. 内存中记住的非 managed `sessionKey`
3. 持久化的 IM channel `openclaw_session_key`
4. 普通非 IM 会话才 fallback 到 managed key

如果该 `sessionId` 属于 IM mapping，但上述 1-3 都没有真实 channel key，则返回明确错误，例如：

```text
Cannot patch IM channel session because the OpenClaw session key is missing.
```

这样避免再次写入错误 managed key。

### 4. 旧数据兼容

升级前的 mapping 没有 `openclaw_session_key`。兼容策略：

1. channel polling 发现同一真实 key 时，会调用 `resolveOrCreateSession()` 并回填字段
2. active turn 期间 patch 时，仍可使用 active turn key
3. 如果用户在回填前直接 patch 老会话，返回明确错误，引导等待 IM 会话被重新发现或收到新消息

不尝试从 `im_conversation_id` 反推 OpenClaw key，因为不同 channel、账号和版本存在多种 key 格式，反推风险高于收益。

### 5. 模型切换体感优化

当前模型下拉的选中态来自 `currentSession.modelOverride`。点击模型后，renderer 会等待 IPC、主进程 `runtime.patchSession()` 和 OpenClaw `sessions.patch` 全部成功返回，再从返回的 session 更新 Redux。这个确认链路正确但不适合作为即时 UI 反馈，因此用户会感觉点击卡顿。

优化策略：

1. 点击模型时先在 renderer 中 optimistic 更新当前 session 的 `modelOverride`
2. 后台继续调用 `coworkService.patchSession()`，真实写入仍由主进程和 OpenClaw 完成
3. patch 成功后用主进程返回的 session 覆盖 optimistic 状态
4. patch 失败时回滚到点击前的 `modelOverride`，并显示本地化 toast
5. patch 进行中临时禁用模型下拉，避免连续点击产生乱序覆盖
6. patch 返回时仅在目标 session 仍是当前 session 时写回 Redux，避免用户切换会话后被旧响应拉回
7. 移除渲染路径中的模型解析调试日志，避免重渲染时放大卡顿感

这个优化只改变交互反馈时机，不改变 `sessions.patch` 的真实 session key 选择逻辑，也不改变 IM 和普通 Cowork 的持久化语义。

### 6. 普通 Cowork 发送前模型一致性校准

体感优化引入 optimistic UI 后，renderer 和 智码 GLM Code SQLite 会先显示用户选择的新模型，但 OpenClaw `sessions.patch` 仍是异步提交。如果用户在 patch 未完成时继续发送，或者后端仅凭本地 `lastPatchedModelBySession` 缓存认为模型已经提交，就可能出现：

1. `cowork_sessions.model_override` 已是新模型
2. prompt 中注入的 `[Session info]` 也是新模型
3. OpenClaw 实际 session entry 仍是旧模型
4. 后续 `chat.send` 继续按旧模型运行

修复策略：

1. 对每个 session 串行化模型 `sessions.patch`，避免 UI patch 与发送前 patch 并发乱序
2. `patchSession()` 作为 UI 修改入口时不再把模型写入“已确认”缓存；它只能代表 patch 请求返回，不能证明下一轮 `chat.send` 已使用该模型
3. `runTurn()` 在 `chat.send` 前执行 `ensureSessionModelForTurn()`：
   - session 级 `modelOverride` 始终在发送前 patch 一次，作为用户显式选择的强一致保障
   - agent 默认模型仍允许使用缓存跳过重复 patch，避免无模型切换时每轮都额外请求
4. 前端在模型 patch pending 期间禁用发送按钮和快捷键发送，避免用户在模型提交前发起下一轮
5. patch 失败时继续回滚 optimistic 状态，并保持不能把失败模型当作已确认模型

这个策略的核心是：UI 可以乐观显示，但真正发起 `chat.send` 前必须由后端按当前 session 的期望模型重新校准一次 OpenClaw runtime。

---

## 涉及文件

核心变更：

- `src/main/im/types.ts`
- `src/main/im/imStore.ts`
- `src/main/libs/openclawChannelSessionSync.ts`
- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
- `src/renderer/components/ModelSelector.tsx`
- `src/renderer/components/cowork/CoworkPromptInput.tsx`
- `src/renderer/services/cowork.ts`
- `src/renderer/store/slices/coworkSlice.ts`
- `src/renderer/services/i18n.ts`

测试：

- `src/main/im/imStore.test.ts`
- `src/main/libs/openclawChannelSessionSync.test.ts`
- `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts`
- `src/renderer/store/slices/coworkSlice.test.ts`

## 边界情况

| 场景 | 处理方式 |
|---|---|
| 普通 Cowork 会话 patch 模型 | 继续使用 managed key |
| IM 会话 active turn 期间 patch | 使用 active turn 的真实 key |
| IM 会话非 active，但内存已记住真实 key | 使用内存 key |
| IM 会话非 active，内存丢失，但 SQLite 有真实 key | 使用持久化 key |
| IM 会话非 active，内存和 SQLite 都没有真实 key | 返回明确错误，不 fallback |
| 历史 mapping 在 polling 中被重新发现 | 回填 `openclaw_session_key` |
| agent binding 变化生成新会话 | 更新 mapping target、agentId 和真实 key |
| 模型 patch 成功但 OpenClaw 返回较慢 | UI 先显示新模型，成功后保持 |
| 模型 patch 失败 | 回滚模型显示并 toast 提示 |
| 模型 patch 进行中再次点击 | 暂时禁用下拉，避免乱序 |
| 模型 patch 未返回时切换会话 | 旧响应不再覆盖当前会话 |
| 普通 Cowork 模型 patch 未完成时点击发送 | 发送按钮和快捷键发送被禁用 |
| 普通 Cowork 本地显示新模型但 OpenClaw 仍是旧模型 | 下一轮 `chat.send` 前再次 patch 当前 `modelOverride` |
| UI patch 返回成功但未能作为实际运行确认 | 不写入已确认模型缓存，发送前仍重新校准 |

## 测试计划

### 单元测试

1. `IMStore` 创建、查询、更新 mapping 时保留 `openClawSessionKey`
2. `OpenClawChannelSessionSync` 新建 mapping 时写入真实 session key
3. `OpenClawChannelSessionSync` 复用旧 mapping 时回填真实 session key
4. `OpenClawRuntimeAdapter.patchSession()` 在内存 key 为空时使用持久化 IM key
5. `OpenClawRuntimeAdapter.patchSession()` 对缺失真实 key 的 IM 会话返回错误，不 patch managed key
6. 普通非 IM 会话仍 fallback 到 managed key
7. `coworkSlice` 支持只更新当前 session 的 optimistic `modelOverride`
8. `OpenClawRuntimeAdapter.runTurn()` 即使已存在同值模型缓存，也会在 session 级 `modelOverride` 下于 `chat.send` 前重新 patch
9. 模型 patch pending 时，后续发送会等待前一个 patch 完成并再次执行发送前 patch

运行：

```bash
npm test -- imStore openclawChannelSessionSync openclawRuntimeAdapter
npm test -- coworkSlice
```

### 类型验证

```bash
npm run compile:electron
```

## 验收标准

1. 在 IM 对话历史中切换模型后，OpenClaw 的真实 channel session entry 被 patch 到新模型
2. 不再生成新的 `agent:main:lobsterai:<imCoworkSessionId>` 幽灵会话 key
3. 应用重启后，已回填 `openclaw_session_key` 的 IM 会话仍能切换模型
4. 普通 Cowork 会话模型切换行为不回退
5. 点击模型后按钮文本和勾选态立即变化，不等待 OpenClaw patch 返回
6. patch 失败时显示错误并回滚到旧模型
7. 普通 Cowork 模型 patch 未完成时不能发送下一轮
8. 普通 Cowork 继续追问前会把 OpenClaw 实际 session patch 到当前 `modelOverride`
9. 相关单元测试通过
