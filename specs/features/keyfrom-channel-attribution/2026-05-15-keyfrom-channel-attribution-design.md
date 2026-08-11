# Keyfrom 渠道归因本地能力设计文档

## 1. 概述

### 1.1 问题/背景

智码 GLM Code 需要支持渠道包投放统计。不同投放渠道在打包或开发启动时传入不同 `keyfrom`，应用安装并启动后需要把渠道来源稳定记录到本地，并在必要的服务端接口中附带该来源，为后续登录、模型、用户信息、支付、埋点和报表统计提供基础数据。

本设计分两步推进：

第一步先完成客户端本地归因能力：

- 开发模式和打包模式都能注入当前渠道来源。
- 应用启动后能读取当前包的 `keyfrom`。
- 本地持久化 `firstKeyfrom` 和 `latestKeyfrom`。
- `firstKeyfrom` 只在首次为空时写入，后续不覆盖。
- `latestKeyfrom` 每次启动都按当前包来源更新。
- 开发者可以在开发模式下模拟不同渠道并验证本地归因结果。

第二步在已确认的服务端接口中只追加归因参数，不改变现有业务逻辑：

- `/api/auth/exchange`
- `/api/auth/refresh`
- `/api/auth/logout`
- `/api/user/profile-summary`
- `/api/models/available`
- `/openapi/get/luna/hardware/lobsterai/{env}/update`
- `/openapi/get/luna/hardware/lobsterai/{env}/update-manual`

### 1.2 目标

1. 统一使用 `keyfrom` 作为渠道来源业务字段名。
2. 支持通过环境变量在开发模式和打包模式中注入渠道参数。
3. 启动时把当前渠道归一化为合法 `keyfrom`，无值时使用默认渠道。
4. 本地维护两个字段：
   - `firstKeyfrom`: 首次归因来源，只写一次，不自动覆盖。
   - `latestKeyfrom`: 最近一次来源，每次启动可更新。
5. 将归因结果存入 SQLite `kv` 表，应用重启后保持不丢失。
6. 提供主进程内部读取能力，供后续登录、接口上报或埋点模块复用。
7. 提供开发模式验证路径，避免必须真实打多个安装包才能测试。
8. 保持实现轻量，不新增数据库表。
9. 在指定接口上追加 `firstKeyfrom` 和 `latestKeyfrom` 参数。
10. 正式服和测试服共用同一套参数追加逻辑，跟随现有 `getServerApiBaseUrl()` 环境切换。
11. 参数追加失败或读取归因异常时不阻塞现有接口请求。

### 1.3 非目标

本阶段不做以下事情：

- 不在支付接口中携带 `firstKeyfrom` 或 `latestKeyfrom`。
- 不新增服务端接口。
- 不修改现有接口路径、请求方法、鉴权方式、token 存储、成功失败处理或业务语义。
- 不实现服务端用户归因绑定。
- 不实现渠道报表、后台统计、合作方结算逻辑。
- 不实现广告点击归因、下载链接归因、IP/设备指纹匹配。
- 不实现邀请码、campaign、广告组、素材维度。
- 不提供面向普通用户的渠道编辑 UI。
- 不允许普通生产用户手动覆盖 `firstKeyfrom`。

## 2. 用户场景

### 场景 1: 开发模式模拟官方渠道

**Given** 开发者未传入渠道参数
**When** 开发者运行 `npm run electron:dev:openclaw`
**Then** 应用启动后读取当前渠道为默认渠道

**And** 如果本地没有 `firstKeyfrom`，写入默认渠道

**And** `latestKeyfrom` 更新为默认渠道

### 场景 2: 开发模式模拟指定渠道

**Given** 开发者希望模拟 B 站渠道
**When** 开发者运行 `KEYFROM=bilibili npm run electron:dev:openclaw`
**Then** 应用启动后读取当前渠道为 `bilibili`

**And** 如果本地没有 `firstKeyfrom`，写入 `bilibili`

**And** `latestKeyfrom` 更新为 `bilibili`

### 场景 3: 首次归因不被后续渠道覆盖

**Given** 用户第一次启动的是 `bilibili` 渠道包
**And** 本地已经写入 `firstKeyfrom=bilibili`
**When** 用户后续安装并启动 `partner_a` 渠道包
**Then** `firstKeyfrom` 仍保持 `bilibili`

**And** `latestKeyfrom` 更新为 `partner_a`

### 场景 4: 应用重启后保留归因结果

**Given** 本地已经保存 `firstKeyfrom=bilibili` 和 `latestKeyfrom=partner_a`
**When** 用户退出并重新打开应用
**Then** 应用可以从 SQLite 中读取已有归因结果

**And** 不因重启丢失 `firstKeyfrom`

### 场景 5: 渠道参数非法时使用默认渠道

**Given** 打包或开发启动时传入非法渠道值
**When** 应用启动归因初始化
**Then** 应用不写入非法原始值

**And** 当前渠道回退为默认渠道

**And** 日志以 warning 记录渠道值非法，但不阻塞应用启动

### 场景 6: 开发者需要重测首次归因

**Given** 开发者本地已经存在 `firstKeyfrom`
**When** 开发者需要重新模拟首次安装
**Then** 可以通过开发文档中的清理方式删除本地归因 kv

**And** 再次启动后按当前 `KEYFROM` 重新初始化 `firstKeyfrom`

说明：本阶段不要求在产品 UI 中提供重置入口。可以先通过开发工具、SQLite 检查或后续内部调试入口完成。

### 场景 7: 登录换 token 时携带归因参数

**Given** 用户通过浏览器登录后回到 智码 GLM Code
**When** 应用调用 `/api/auth/exchange` 换取 token
**Then** 请求 body 保留原有 `authCode`

**And** 只额外追加 `firstKeyfrom` 和 `latestKeyfrom`

**And** 不改变 token 保存、用户信息返回和错误处理逻辑

### 场景 8: 刷新 token 时携带归因参数

**Given** 应用因为主动刷新、401 自动刷新或代理刷新需要调用 `/api/auth/refresh`
**When** refresh 请求发出
**Then** 请求 body 保留原有 `refreshToken`

**And** 只额外追加 `firstKeyfrom` 和 `latestKeyfrom`

**And** 不改变 refresh 成功后的 token 更新逻辑

### 场景 9: 获取用户摘要和模型列表时携带归因参数

**Given** 应用需要调用 `/api/user/profile-summary` 或 `/api/models/available`
**When** GET 请求发出
**Then** URL query 中追加 `firstKeyfrom` 和 `latestKeyfrom`

**And** 不改变现有 Bearer 鉴权、响应解析和模型 metadata 同步逻辑

### 场景 10: 正式服和测试服一致携带归因参数

**Given** 设置页开启或关闭测试模式
**When** 应用调用指定服务端接口
**Then** base URL 仍由现有 `getServerApiBaseUrl()` 决定

**And** 测试服、正式服都使用同一套 keyfrom 参数追加逻辑

**And** 参数追加逻辑不自行判断或覆盖环境

## 3. 功能需求

### FR-1: keyfrom 字段定义

本阶段只定义两个持久化字段：

```ts
type KeyfromAttribution = {
  firstKeyfrom: string;
  latestKeyfrom: string;
  updatedAt: number;
};
```

字段语义：

| 字段            | 含义                 | 覆盖规则                           |
| --------------- | -------------------- | ---------------------------------- |
| `firstKeyfrom`  | 本机首次归因来源     | 仅当本地为空时写入，后续不自动覆盖 |
| `latestKeyfrom` | 本机最近一次启动来源 | 每次启动按当前包来源更新           |

### FR-2: 当前渠道来源

当前渠道来源统一称为 `currentKeyfrom`，它不需要单独持久化为长期字段，只作为启动时计算 `firstKeyfrom` 和 `latestKeyfrom` 的输入。

来源优先级：

1. 开发模式运行时注入的环境变量 `KEYFROM`。
2. 生产包构建期固化到应用资源文件中的渠道值。
3. 默认渠道 `official`。

说明：

- 开发模式可以直接读取 `process.env.KEYFROM`。
- 生产包不能依赖用户运行环境中的 `KEYFROM`，需要在构建阶段把渠道值固化到应用内。
- 生产包运行时不读取当前工作目录下的 `.keyfrom-build`，避免被外部 cwd 或本机残留文件影响。
- 如果后续支持更多构建系统，应保持对外入口仍是 `KEYFROM`。

### FR-3: 渠道值校验与归一化

`keyfrom` 必须经过校验和归一化后才能写入本地。

建议规则：

- 去除首尾空白。
- 转为小写。
- 仅允许 `a-z`、`0-9`、`_`、`-`。
- 长度建议为 1 到 64 个字符。
- 空值或非法值回退为 `official`。

示例：

| 原始值      | 归一化结果  |
| ----------- | ----------- |
| `bilibili`  | `bilibili`  |
| `Partner_A` | `partner_a` |
| 空字符串    | `official`  |
| `../../bad` | `official`  |

### FR-4: 本地持久化规则

应用启动时执行一次归因初始化：

```ts
const currentKeyfrom = resolveCurrentKeyfrom();
const existing = readKeyfromAttribution();

const firstKeyfrom = existing.firstKeyfrom || currentKeyfrom;
const latestKeyfrom = currentKeyfrom;

saveKeyfromAttribution({
  firstKeyfrom,
  latestKeyfrom,
  updatedAt: Date.now(),
});
```

要求：

- `firstKeyfrom` 已存在时不覆盖。
- `latestKeyfrom` 每次启动都更新。
- 写入应幂等，多次启动同一渠道不会产生异常。
- SQLite 写入失败时记录 error，但不阻塞应用主流程。

默认包示例：

- 如果打包时没有传 `KEYFROM`，构建期渠道为 `official`。
- 如果用户首次启动的是默认包，SQLite 中保存：

```json
{
  "firstKeyfrom": "official",
  "latestKeyfrom": "official",
  "updatedAt": 1789473600000
}
```

- 如果同一台机器后续启动 `bilibili` 渠道包，则更新为：

```json
{
  "firstKeyfrom": "official",
  "latestKeyfrom": "bilibili",
  "updatedAt": 1789473600000
}
```

说明：`firstKeyfrom` 表示第一次来源，不覆盖；`latestKeyfrom` 表示最近一次包来源，会更新。

### FR-5: 存储位置

使用现有 SQLite `kv` 表，不新增数据库表。

建议 kv key：

```ts
KeyfromStoreKey.Attribution = 'keyfrom.attribution.v1';
```

value 示例：

```json
{
  "firstKeyfrom": "bilibili",
  "latestKeyfrom": "partner_a",
  "updatedAt": 1789473600000
}
```

说明：

- 后续如果需要拆字段存储，可以新建 v2 key 并做迁移。
- 本阶段不需要把归因数据写入 `cowork_config` 或应用配置对象。

### FR-6: 主进程读取能力

主进程需要提供内部服务方法：

```ts
getKeyfromAttribution(): KeyfromAttribution
```

用于后续模块读取，不要求本阶段暴露给 renderer。

可选提供开发调试 IPC：

```ts
KeyfromIpc.GetAttribution;
```

如果添加 IPC channel，必须放入集中常量对象，不能在 `ipcMain.handle()` 或 `ipcRenderer.invoke()` 中使用裸字符串。

### FR-7: 打包渠道注入

打包时支持：

```bash
# macOS / Linux shell
KEYFROM=bilibili npm run dist:mac:x64
KEYFROM=bilibili npm run dist:mac:arm64
```

```powershell
# Windows PowerShell
$env:KEYFROM = "bilibili"
npm run dist:win
```

```cmd
:: Windows CMD
set KEYFROM=bilibili && npm run dist:win
```

也可以使用项目已安装的 `cross-env` 统一命令：

```bash
npx cross-env KEYFROM=bilibili npm run dist:mac:x64
npx cross-env KEYFROM=bilibili npm run dist:mac:arm64
npx cross-env KEYFROM=bilibili npm run dist:win
```

不支持在 Windows PowerShell / CMD 中直接运行：

```bash
KEYFROM=bilibili npm run dist:win
```

构建产物需要能在应用启动时读到固化后的渠道值。

建议实现方式：

1. 新增构建期脚本读取 `process.env.KEYFROM`。
2. 生成一个受版本控制忽略的构建产物文件，例如 `src/generated/keyfrom.json` 或 `dist-electron/keyfrom.json`。
3. 主进程启动时读取该文件作为生产包渠道值。
4. 开发模式下如果环境变量存在，优先使用环境变量，方便本地调试。

说明：

- 具体文件路径在实现时以打包可访问、asar 兼容、主进程易读取为准。
- 生成文件应避免被误提交，或使用稳定模板加运行时替换。
- 现有打包命令不需要替换；渠道通过命令前缀环境变量传入。
- 当前项目的 `dist:mac:x64`、`dist:mac:arm64`、`dist:win` 内部都会执行 `npm run build` 或等价构建流程，因此可以通过 `prebuild` 自动生成渠道固化文件。
- 生产包运行时不应依赖用户机器上的 `KEYFROM` 环境变量，避免被本机环境意外覆盖；正式包应读取构建期固化到 `resources/keyfrom/keyfrom.json` 的值。
- 如果没有传 `KEYFROM`，构建期固化为默认渠道 `official`。
- `.keyfrom-build/` 是打包前的临时中间目录，不是运行期业务数据目录，也不应提交到 Git。

### FR-8: 渠道包产物命名

渠道包产物应能从文件名上区分来源，便于投放和人工核对。

命名规则：

```text
Mac Intel:
智码 GLM Code-darwin-x64-<version>-<keyfrom>.dmg

Mac Apple Silicon:
智码 GLM Code-darwin-arm64-<version>-<keyfrom>.dmg

Windows x64:
智码 GLM Code-Setup-x64-<version>-<keyfrom>.exe
```

示例：

```text
智码 GLM Code-darwin-x64-2026.5.14-bilibili.dmg
智码 GLM Code-darwin-arm64-2026.5.14-bilibili.dmg
智码 GLM Code-Setup-x64-2026.5.14-bilibili.exe
```

说明：

- `keyfrom` 放在文件名末尾，弱化渠道字段，不抢产品名位置。
- Windows 保留 `Setup`，符合 Windows 安装器命名习惯。
- Windows 文件名不额外添加 `win`，因为 `.exe` 和 `Setup-x64` 已经能表达平台和架构。
- 未传 `KEYFROM` 时，文件名使用默认渠道 `official`。
- 产物命名只影响 release 文件名，不改变应用显示名、安装目录、可执行文件名和运行时归因逻辑。
- 如果 `electron-builder` 同时存在顶层和平台级 `extraResources`，需要确保 `.keyfrom-build` 被显式合并进 macOS / Windows 平台级资源列表，避免产物文件名带渠道但包内缺少 `resources/keyfrom/keyfrom.json`。

### FR-9: 日志

主进程归因初始化需要记录关键生命周期日志：

- 当前渠道解析成功。
- 渠道值非法并回退到默认渠道。
- `firstKeyfrom` 首次写入。
- `latestKeyfrom` 更新。
- SQLite 读取或写入失败。

日志要求：

- 使用 `console.log` / `console.warn` / `console.error`。
- 日志必须以模块 tag 开头，例如 `[Keyfrom]`。
- 日志使用英文。
- 不在热循环中记录。
- 错误日志必须把 error 对象作为最后一个参数。

### FR-10: 开发测试能力

开发者应可以通过以下命令验证：

```bash
KEYFROM=bilibili npm run electron:dev:openclaw
KEYFROM=partner_a npm run electron:dev:openclaw
```

验证重点：

- 首次启动 `bilibili` 后，本地 `firstKeyfrom=bilibili`。
- 再用 `partner_a` 启动后，本地 `firstKeyfrom` 仍为 `bilibili`。
- 再用 `partner_a` 启动后，本地 `latestKeyfrom=partner_a`。
- 清理本地 kv 后，再用新渠道启动可重新初始化首次归因。

说明：

- `electron:dev:openclaw` 是日常本地开发入口，应直接支持 `KEYFROM` 环境变量。
- 开发模式读取运行时环境变量，是为了方便反复模拟不同渠道。
- 开发模式不会要求真实生成安装包，也不依赖生产包内的 `resources/keyfrom/keyfrom.json`。

### FR-11: 指定接口携带归因参数

以下接口需要携带本地归因参数：

| 接口                                                       | 当前请求方式 | 参数携带方式                                                                |
| ---------------------------------------------------------- | ------------ | --------------------------------------------------------------------------- |
| `/api/auth/exchange`                                       | `POST`       | JSON body 追加 `firstKeyfrom`、`latestKeyfrom`、`uuid`、`version`、`userId` |
| `/api/auth/refresh`                                        | `POST`       | JSON body 追加 `firstKeyfrom`、`latestKeyfrom`、`uuid`、`version`、`userId` |
| `/api/auth/logout`                                         | `POST`       | JSON body 追加 `firstKeyfrom`、`latestKeyfrom`、`uuid`、`version`、`userId` |
| `/api/user/profile-summary`                                | `GET`        | URL query 追加 `firstKeyfrom`、`latestKeyfrom`、`uuid`、`version`、`userId` |
| `/api/models/available`                                    | `GET`        | URL query 追加 `firstKeyfrom`、`latestKeyfrom`、`uuid`、`version`、`userId` |
| `/openapi/get/luna/hardware/lobsterai/{env}/update`        | `GET`        | URL query 追加 `firstKeyfrom`、`latestKeyfrom`、`uuid`、`version`、`userId` |
| `/openapi/get/luna/hardware/lobsterai/{env}/update-manual` | `GET`        | URL query 追加 `firstKeyfrom`、`latestKeyfrom`、`uuid`、`version`、`userId` |

POST body 示例：

```json
{
  "authCode": "<existing-auth-code>",
  "firstKeyfrom": "bilibili",
  "latestKeyfrom": "baidu",
  "uuid": "158d6395-ebc3-4235-b5d6-a46df4db9af4",
  "version": "2026.5.14",
  "userId": "urs-phoneyd.61cbc4eb015242369@163.com_1"
}
```

GET query 示例：

```text
/api/user/profile-summary?firstKeyfrom=bilibili&latestKeyfrom=baidu&uuid=...&version=2026.5.14&userId=...
/api/models/available?firstKeyfrom=bilibili&latestKeyfrom=baidu&uuid=...&version=2026.5.14&userId=...
/openapi/get/luna/hardware/lobsterai/prod/update?uuid=...&userId=...&version=...&firstKeyfrom=bilibili&latestKeyfrom=baidu
/openapi/get/luna/hardware/lobsterai/prod/update-manual?uuid=...&userId=...&version=...&firstKeyfrom=bilibili&latestKeyfrom=baidu
```

要求：

- 只追加参数，不改原有字段。
- `authCode`、`refreshToken`、`Authorization` 等现有字段和 header 保持不变。
- 原来是 `POST` 的继续 `POST`，原来是 `GET` 的继续 `GET`。
- 原有成功、失败、重试、token 保存、清理本地 token、模型 metadata 同步逻辑保持不变。
- 读取 keyfrom 失败时使用本地归因服务兜底结果，不应导致接口失败。
- `uuid` 复用更新检查接口使用的 `installation_uuid`。
- `version` 复用更新检查接口使用的当前应用版本。
- `userId` 有本地登录用户信息时追加；登录前或本地缺失时不阻塞请求。

### FR-12: refresh 多调用点必须统一覆盖

`/api/auth/refresh` 当前不止一个调用点，参数追加必须覆盖所有 refresh 路径：

1. `fetchWithAuth()` 遇到 401 后自动刷新。
2. `auth:refreshToken` IPC 主动刷新。
3. `refreshOnce('proactive')` 主动后台刷新。
4. `registerProxyTokenRefresher('lobsterai-server')` 代理刷新。

要求：

- 不在每个调用点手写重复逻辑。
- 使用统一 helper 构造 body，避免漏掉某个 refresh 路径。
- 不改变现有 refresh 去重逻辑和 rolling refresh token 更新逻辑。

### FR-13: 正式服与测试服环境兼容

指定接口的 base URL 继续使用现有 `getServerApiBaseUrl()`：

| 环境   | Base URL                                    |
| ------ | ------------------------------------------- |
| 测试服 | `https://glmcoding.cn/api` |
| 正式服 | `https://glmcoding.cn/api`       |

要求：

- keyfrom 参数追加逻辑不自行判断正式服或测试服。
- 设置页 `testMode` 切换后，仍由 `refreshEndpointsTestMode()` 和 `getServerApiBaseUrl()` 控制环境。
- 同一个 helper 应同时适用于测试服和正式服 URL。
- 更新检查接口使用 `getUpdateCheckUrl()` / `getManualUpdateCheckUrl()` 自身的测试服、正式服切换逻辑，keyfrom 参数追加不参与环境判断。

### FR-14: 接口改动边界

本功能只做参数追加和必要的兼容、异常处理。

禁止事项：

- 不修改接口路径。
- 不修改请求方法。
- 不修改现有 request body 字段名。
- 不修改现有 response 解析。
- 不修改 auth token 存储结构。
- 不修改 `logout` 的 best-effort 行为。
- 不修改 `fetchWithAuth()` 的 401 refresh/retry 业务语义。
- 不在高频请求中新增 info 级别噪音日志。

## 4. 实现方案

### 4.1 共享常量与类型

建议新增：

```text
src/shared/keyfrom/constants.ts
src/shared/keyfrom/types.ts
```

常量示例：

```ts
export const DefaultKeyfrom = {
  Official: 'official',
} as const;

export const KeyfromStoreKey = {
  Attribution: 'keyfrom.attribution.v1',
} as const;
```

如果新增 IPC：

```ts
export const KeyfromIpc = {
  GetAttribution: 'keyfrom:getAttribution',
} as const;
```

要求：

- 所有比较、构造、kv key、IPC channel 都使用集中常量。
- 不在多个文件散落裸字符串。

### 4.2 keyfrom 解析服务

建议新增：

```text
src/main/libs/keyfromAttribution.ts
```

职责：

1. 解析当前启动渠道。
2. 校验并归一化渠道值。
3. 从 SQLite 读取已有归因。
4. 执行 `firstKeyfrom` / `latestKeyfrom` 更新规则。
5. 提供 `getKeyfromAttribution()` 给主进程其他模块复用。

核心方法建议：

```ts
normalizeKeyfrom(value: unknown): string
resolveCurrentKeyfrom(): string
initializeKeyfromAttribution(store: SqliteStore): KeyfromAttribution
readKeyfromAttribution(store: SqliteStore): KeyfromAttribution | null
saveKeyfromAttribution(store: SqliteStore, value: KeyfromAttribution): void
```

### 4.3 启动初始化时机

建议在主进程 SQLite store 初始化完成后、窗口创建前执行：

```text
SqliteStore.create()
  -> initializeKeyfromAttribution(store)
  -> create main window
```

理由：

- 归因属于应用级启动状态，不依赖 renderer。
- 后续登录、接口或埋点模块需要在主进程随时可读。
- 越早初始化，越不容易出现某些启动事件缺失渠道的情况。

### 4.4 构建期注入

建议新增脚本：

```text
scripts/generate-keyfrom-build-info.cjs
```

职责：

1. 读取 `process.env.KEYFROM`。
2. 使用与运行时一致的规则校验并归一化。
3. 写入构建期渠道文件。
4. 打印一行清晰日志说明当前打包渠道。

脚本需要接入：

- 开发模式：主进程直接读取 `KEYFROM`，覆盖构建期文件，便于本地调试。
- 打包模式：通过 `prebuild` 自动生成渠道固化文件；现有 `dist:mac:x64`、`dist:mac:arm64`、`dist:win` 不需要改成新的命令。
- `dist:*` / `pack` / `dist` 打包流程最终都应确保生成文件存在。

实现时需要避免改动过多 npm script。可以先让主进程开发模式直接读环境变量，生产打包路径再通过 `predist:*` 或统一 build 前置脚本生成文件。

当前推荐命令：

```bash
# macOS / Linux shell: 开发测试
KEYFROM=bilibili npm run electron:dev:openclaw

# macOS / Linux shell: macOS x64 渠道包
KEYFROM=bilibili npm run dist:mac:x64

# macOS / Linux shell: macOS arm64 渠道包
KEYFROM=bilibili npm run dist:mac:arm64
```

```powershell
# Windows PowerShell: Windows x64 渠道包
$env:KEYFROM = "bilibili"
npm run dist:win
```

```cmd
:: Windows CMD: Windows x64 渠道包
set KEYFROM=bilibili && npm run dist:win
```

```bash
# 跨平台写法，适合统一复制到文档或 CI 脚本
npx cross-env KEYFROM=bilibili npm run dist:win
```

构建脚本职责说明：

- 脚本不是新的启动/打包入口，只是 `npm run build` 的自动前置步骤。
- npm 会在执行 `npm run build` 时自动执行 `prebuild`。
- 脚本输出 `.keyfrom-build/keyfrom.json`。
- `electron-builder` 将 `.keyfrom-build/keyfrom.json` 打进安装包资源目录。
- App 正式运行时读取安装包资源目录中的渠道文件。
- `.keyfrom-build/keyfrom.json` 的典型内容：

```json
{
  "keyfrom": "bilibili",
  "generatedAt": "2026-05-15T08:04:48.717Z"
}
```

- 如果打包时没有传 `KEYFROM`，脚本输出 `keyfrom: "official"`。
- 生产包不直接读取用户机器上的 `process.env.KEYFROM`，也不读取当前工作目录下的 `.keyfrom-build`。

### 4.5 产物命名

如果第一版同步实现产物命名，建议优先利用 `electron-builder` 配置中的 artifact name 模板，或在打包后执行重命名脚本。

要求：

- 渠道名必须使用归一化后的 `keyfrom`。
- 不合法渠道不能进入文件名。
- 默认渠道也应体现在文件名中，便于和渠道包统一管理。

### 4.6 开发调试与清理

第一版可以不做 UI 重置入口。

开发者重测首次归因时，可以选择：

1. 删除应用 userData 目录下的 SQLite 数据库。
2. 使用 SQLite 工具删除 `keyfrom.attribution.v1` kv。
3. 后续新增仅开发可用 IPC 或菜单项清理该 kv。

如果新增清理能力，必须限制为开发模式或内部调试能力，不向普通生产用户暴露。

### 4.7 接口参数追加 helper

建议在主进程 auth handler 附近新增轻量 helper：

```ts
const buildKeyfromPayload = () => {
  const { firstKeyfrom, latestKeyfrom } = getKeyfromAttribution(getStore());
  return {
    firstKeyfrom,
    latestKeyfrom,
    uuid: getOrCreateInstallationId(),
    version: app.getVersion(),
    userId: getAuthUserId(),
  };
};

const withKeyfromBody = (body: Record<string, unknown>) => ({
  ...body,
  ...buildKeyfromPayload(),
});

const appendKeyfromQuery = (url: string) => {
  const parsed = new URL(url);
  const payload = buildKeyfromPayload();
  for (const [key, value] of Object.entries(payload)) {
    if (value) parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
};
```

说明：

- helper 只负责追加参数。
- helper 不负责选择正式服或测试服。
- helper 不打印 token 或完整请求体。
- 如果读取本地归因异常，`getKeyfromAttribution()` 应返回兜底值，避免影响接口调用。
- `uuid` 使用更新检查接口同一个 SQLite kv key：`installation_uuid`。
- `userId` 复用主进程缓存的登录用户信息；如果当前请求发生在登录前，不追加该字段。

### 4.8 POST 接口接入

`/api/auth/exchange`：

```ts
body: JSON.stringify(withKeyfromBody({ authCode: code }));
```

`/api/auth/refresh`：

```ts
body: JSON.stringify(withKeyfromBody({ refreshToken: tokens.refreshToken }));
```

`/api/auth/logout`：

```ts
headers: {
  Authorization: `Bearer ${tokens.accessToken}`,
  'Content-Type': 'application/json',
},
body: JSON.stringify(withKeyfromBody({})),
```

说明：

- `logout` 仍然是 best-effort。
- `logout` 请求失败仍然清理本地 token。
- `exchange` 和 `refresh` 的 response 解析、token 保存和错误返回保持不变。
- `exchange` / `getUser` 成功返回用户信息后，可将用户对象缓存到 SQLite kv，用于后续请求追加 `userId`。

### 4.9 GET 接口接入

`/api/user/profile-summary`：

```ts
const url = appendKeyfromQuery(`${serverBaseUrl}/api/user/profile-summary`);
const resp = await fetchWithAuth(url);
```

`/api/models/available`：

```ts
const url = appendKeyfromQuery(`${serverBaseUrl}/api/models/available`);
const resp = await fetchWithAuth(url);
```

说明：

- `fetchWithAuth()` 保持现有 Bearer token、401 refresh 和 retry 语义。
- URL query 追加不改变接口 response 解析。
- 如果后续 URL 已有 query，`URLSearchParams.set()` 应覆盖同名 key，避免重复参数。
- 登录用户信息尚未恢复时，`userId` 可以缺省。

### 4.10 更新检查接口接入

更新检查接口包括：

- 自动更新检查：`getUpdateCheckUrl()`，正式服为 `/lobsterai/prod/update`，测试服为 `/lobsterai/test/update`。
- 手动更新检查：`getManualUpdateCheckUrl()`，正式服为 `/lobsterai/prod/update-manual`，测试服为 `/lobsterai/test/update-manual`。

当前请求统一在 `AppUpdateCoordinator.fetchUpdateInfo()` 中发起，并由 `getUpdateQueryString()` 构造 query。

建议只在 `getUpdateQueryString()` 中追加：

```ts
const { firstKeyfrom, latestKeyfrom } = getKeyfromAttribution(this.store);
params.set('firstKeyfrom', firstKeyfrom);
params.set('latestKeyfrom', latestKeyfrom);
```

说明：

- 自动更新和手动更新共用同一个 query 构造方法，因此改一处即可覆盖两个接口。
- 不修改更新检查 URL 选择逻辑。
- 不修改请求方式，仍为 `GET`。
- 不修改 response 解析、版本比较、下载、安装和 ready-file 复用逻辑。
- 当前已有日志 `[AppUpdate] checking update, currentVersion=..., url=...` 会打印完整 URL，便于验证 keyfrom query。

## 5. 边界情况

| 场景                                 | 处理方式                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| 开发启动未传 `KEYFROM`               | 使用 `official`                                                                       |
| 打包时未传 `KEYFROM`                 | 构建期固化 `official`，首次启动写入 `firstKeyfrom=official`、`latestKeyfrom=official` |
| `KEYFROM` 为空字符串                 | 使用 `official`                                                                       |
| `KEYFROM` 包含路径符号或特殊字符     | 回退 `official` 并记录 warning                                                        |
| 本地已有 `firstKeyfrom`              | 不覆盖                                                                                |
| 本地没有 `firstKeyfrom`              | 写入当前归一化后的渠道                                                                |
| 当前包渠道变化                       | 只更新 `latestKeyfrom`                                                                |
| 生产包所在 cwd 存在 `.keyfrom-build` | 忽略该目录，只读取安装包资源目录中的 `resources/keyfrom/keyfrom.json`                 |
| SQLite 读取失败                      | 记录 error，使用当前渠道作为内存兜底，不阻塞启动                                      |
| SQLite 写入失败                      | 记录 error，不阻塞启动                                                                |
| 旧版本没有归因 kv                    | 启动时自动按当前渠道初始化                                                            |
| 用户复制安装包给他人                 | 新设备首次启动按该包渠道初始化，属于渠道包归因的正常限制                              |
| 开发者想测试首次归因覆盖             | 需要先清理本地 kv 或 userData                                                         |
| 测试服和正式服切换                   | 继续由 `getServerApiBaseUrl()` 控制 base URL，keyfrom helper 不参与环境判断           |
| POST 接口追加参数                    | 保留原 body 字段，只追加归因参数                                                      |
| GET 接口追加参数                     | 通过 query 追加归因参数，已有同名参数使用 `set()` 覆盖                                |
| 更新检查接口追加参数                 | 在 `getUpdateQueryString()` 中追加，自动覆盖 `/update` 和 `/update-manual`            |
| 登录前请求追加 `userId`              | 本地没有登录用户信息时不追加，不阻塞 `/api/auth/exchange`                             |
| 老用户覆盖安装                       | 首次发起相关请求时补齐 `installation_uuid` 和用户缓存，不需要数据库表结构迁移         |
| 读取 keyfrom 失败                    | 使用归因服务兜底值，不阻塞原接口请求                                                  |
| `/api/auth/refresh` 多调用点         | 所有 refresh 路径必须统一追加参数，不改变现有 token refresh 逻辑                      |

## 6. 涉及文件

预计新增：

- `src/shared/keyfrom/constants.ts`
- `src/shared/keyfrom/types.ts`
- `src/main/libs/keyfromAttribution.ts`
- `src/main/libs/keyfromAttribution.test.ts`
- `scripts/generate-keyfrom-build-info.cjs`
- `scripts/electron-builder-config.cjs`

预计修改：

- `src/main/main.ts`
- `package.json`
- `electron-builder.json`
- `.gitignore`

可选修改：

- `src/main/preload.ts`
- `src/renderer/services/*`
- `src/renderer/types/*`

说明：

- 可选修改仅用于开发调试读取，不属于本阶段必须范围。
- 指定接口的参数追加集中在 `src/main/main.ts` 当前 auth IPC handler 和 refresh helper 附近完成。
- 更新检查接口的参数追加集中在 `src/main/libs/appUpdateCoordinator.ts` 的 query 构造方法中完成。
- 不需要修改 renderer API 服务来支持这 5 个接口，因为它们当前都由主进程发起。

## 7. 验收标准

1. `KEYFROM=bilibili npm run electron:dev:openclaw` 首次启动后，本地归因为 `firstKeyfrom=bilibili`、`latestKeyfrom=bilibili`。
2. 不清理本地数据，再运行 `KEYFROM=partner_a npm run electron:dev:openclaw` 后，`firstKeyfrom` 仍为 `bilibili`，`latestKeyfrom` 为 `partner_a`。
3. 清理归因 kv 后，再运行 `KEYFROM=partner_a npm run electron:dev:openclaw`，`firstKeyfrom` 变为 `partner_a`。
4. 未传 `KEYFROM` 时，当前渠道为 `official`。
5. 未传 `KEYFROM` 打包出的默认包首次启动后，SQLite 中保存 `firstKeyfrom=official`、`latestKeyfrom=official`。
6. 非法 `KEYFROM` 不会写入本地，归因回退为 `official`。
7. 应用重启后可以从 SQLite 读取已保存的归因结果。
8. 生产包运行时读取安装包资源目录中的 `resources/keyfrom/keyfrom.json`，不依赖用户机器运行时环境变量。
9. 单元测试覆盖 `normalizeKeyfrom()`、首次写入、不覆盖 `firstKeyfrom`、更新 `latestKeyfrom`、非法值回退。
10. 新增 IPC channel、kv key、默认渠道等字符串均通过集中常量定义。
11. 主进程日志符合 `[Keyfrom]` tag 和英文日志要求。
12. `/api/auth/exchange` 请求 body 保留 `authCode`，并追加可用的归因参数。
13. `/api/auth/refresh` 所有调用点请求 body 保留 `refreshToken`，并追加可用的归因参数。
14. `/api/auth/logout` 保持 best-effort 和本地 token 清理逻辑，只在请求 body 追加可用的归因参数。
15. `/api/user/profile-summary` 和 `/api/models/available` 保持 GET 和 Bearer 鉴权，只在 query 追加可用的归因参数。
16. `/lobsterai/{env}/update` 和 `/lobsterai/{env}/update-manual` 保持 GET，只在 query 追加可用的归因参数。
17. 渠道包产物文件名包含版本、平台/架构和 `keyfrom`，且 `keyfrom` 位于文件名末尾。
18. 未传 `KEYFROM` 打包时，产物文件名使用 `official`。
19. 测试服和正式服 URL 仍由现有 endpoints helper 决定，keyfrom 参数追加逻辑不改变环境切换。
20. 本阶段没有修改支付接口、服务端归因绑定、报表或合作方结算逻辑。

## 8. 初步手工验证方法

建议按以下顺序验证，逐层确认渠道包是否正确：

```text
安装包文件名包含渠道
→ 包内 keyfrom.json 正确
→ 首次启动 SQLite first/latest 正确
→ 请求日志里归因参数正确
```

### 8.1 安装包文件名

打包完成后，先通过安装包文件名做快速判断。

示例：

```text
智码 GLM Code-darwin-x64-2026.5.14-bilibili.dmg
智码 GLM Code-darwin-arm64-2026.5.14-bilibili.dmg
智码 GLM Code-Setup-x64-2026.5.14-bilibili.exe
```

如果未传 `KEYFROM`，文件名中的渠道应为 `official`。

### 8.2 手动查看包内 keyfrom.json

macOS：

1. 双击 `.dmg` 安装包。
2. 在弹出的挂载窗口中找到 `智码 GLM Code.app`。
3. 右键 `智码 GLM Code.app`，选择“显示包内容”。
4. 进入 `Contents/Resources/keyfrom/`。
5. 打开 `keyfrom.json`，确认 `keyfrom` 等于本次打包传入的渠道。

Windows：

1. 双击 `.exe` 安装包完成安装。
2. 打开资源管理器。
3. 在地址栏输入 `%LOCALAPPDATA%\Programs\智码 GLM Code\resources\keyfrom`。
4. 打开 `keyfrom.json`，确认 `keyfrom` 等于本次打包传入的渠道。

示例内容：

```json
{
  "keyfrom": "bilibili",
  "generatedAt": "2026-05-15T08:04:48.717Z"
}
```

说明：

- `generatedAt` 使用 UTC ISO 字符串，仅用于构建信息排查。
- 文件名正确只能说明打包命名读取到了渠道；包内 `keyfrom.json` 正确才能说明运行时可读取到渠道。

### 8.3 首次启动和请求日志

首次启动后，SQLite 中的归因值应符合：

```json
{
  "firstKeyfrom": "bilibili",
  "latestKeyfrom": "bilibili"
}
```

后续用其他渠道包覆盖启动时：

```json
{
  "firstKeyfrom": "bilibili",
  "latestKeyfrom": "baidu"
}
```

请求日志中应能看到 GET 请求 URL 携带归因参数，例如：

```text
firstKeyfrom=bilibili&latestKeyfrom=baidu
```

POST 请求不应打印完整 body，避免泄露 `authCode` 或 `refreshToken`。
