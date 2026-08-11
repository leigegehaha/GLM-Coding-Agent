# HTML 分享客户端设计文档（2026-05-20，按当前实现更新）

本文档只描述 智码 GLM Code Electron 客户端的 HTML 分享入口、打包、上传调用和 UI 行为。服务端 API contract、错误码定义、鉴权规则、数据库结构和管理后台能力由 `lobsterai-server` 项目维护，客户端仓库不再保留服务端接口文档，避免两边文档漂移。

当前 Electron 客户端已经实现 **HTML Artifact 文件分享**：用户在右侧 HTML 预览中点击分享，客户端打包该 HTML 文件所在目录的静态资源，上传到 `lobsterai-server`，并获得公网可访问地址。该能力当前仅在测试模式暴露，线上模式隐藏入口并由主进程 IPC 做二次拦截。

旧的部署平台设想见 `2026-05-20-artifacts-deployment-server-design.md`。本文档以“静态 HTML 分享客户端集成”为准，不做云端构建、容器运行或 Replit 类完整部署平台。

---

## 1. 当前实现状态

### 1.1 已实现

| 能力                   | 当前实现                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 测试模式门禁           | `ArtifactPanel` 只在 `app.testMode === true` 时显示分享按钮；主进程非测试模式返回 `FeatureUnavailable`            |
| HTML Artifact 分享入口 | 测试模式下，`selectedArtifact.type === ArtifactTypeValue.Html && selectedArtifact.filePath` 时显示分享按钮         |
| 订阅门禁               | Renderer 先刷新并检查 `authState.isLoggedIn` 与 `quota.subscriptionStatus === 'active'`；服务端仍是最终安全边界   |
| 访问模式选择           | 首次创建分享对话框支持 `code` 和 `public`，默认 `code`；已有分享弹窗可切换模式并更新                              |
| HTML 文件打包          | 主进程使用 `packageHtmlFile(filePath)` 打包 HTML 文件所在目录                                                     |
| 静态资源上传           | `uploadHtmlShare()` 创建分享，`updateHtmlShare()` 更新同一分享内容和访问模式                                      |
| 分享 URL 生成          | 客户端优先使用服务端返回的 `url`，同一 HTML 文件再次分享保持原 `shareId` 和 URL 不变                              |
| 分享码展示             | `accessMode = code` 时展示服务端返回的 `shareCode`；旧数据无法回显时展示 `shareCodeUnavailable` 提示              |
| 管理 IPC               | preload 暴露 `createFromHtmlFile()`、`getByHtmlFile()`、`updateFromHtmlFile()`、`get()`、`disable()`               |

### 1.2 未实现 / 后续扩展

| 能力                   | 状态                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------- |
| 线上模式开放           | 暂未开放；当前只允许测试模式暴露                                                       |
| 本地端口预览分享       | 暂未实现；没有 `CreateFromLocalService` IPC，也没有 `local_service_build` source type |
| 本地项目自动构建       | 暂未实现；没有 `localFrontendBuilder.ts`                                              |
| 客户端“我的分享”管理页 | 暂未实现；当前没有列表页，也没有禁用分享入口                                           |
| 历史版本 / 回滚        | 暂未实现；更新覆盖当前分享内容，不提供历史版本选择                                     |

---

## 2. 功能边界

### 2.1 当前目标

| 目标                   | 说明                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| 测试模式验证           | HTML 分享仅在测试模式对内验证，线上用户看不到入口                  |
| 一键分享 HTML Artifact | 用户在 HTML 预览工具栏点击分享，获得公网 URL                       |
| 订阅分享               | 只有已登录且订阅有效的用户可以创建分享                             |
| 两种访问模式           | 支持公开访问和分享码访问；分享码模式下访问者输入分享码后才能查看   |
| 固定地址更新           | 同一 HTML 文件首次分享创建 URL；再次点击分享会加载已有分享并更新内容，URL 保持不变     |
| 客户端安全打包         | 客户端只上传静态资源白名单文件，并排除常见敏感目录和文件           |
| 服务端契约外置         | 服务端接口、错误码、存储和治理规则以服务端项目文档与实现为准       |

### 2.2 非目标

| 非目标             | 说明                                                          |
| ------------------ | ------------------------------------------------------------- |
| 在客户端维护 API 契约 | 服务端接口文档不放在客户端仓库，客户端只记录依赖和集成行为       |
| 云端构建           | 服务端不执行 `npm install` / `npm run build`                  |
| 容器运行           | 不运行 Node/Python 后端服务，不支持数据库或 WebSocket runtime |
| 端口穿透           | 不把用户本机 `localhost` 暴露到公网                           |
| 本地端口分享       | 当前客户端未实现，作为后续扩展                                |
| 历史版本回滚       | 首版不支持同一分享链接的历史版本列表或回滚                      |
| 登录可见           | 首版不支持要求访问者登录后查看                                |
| 自定义有效期       | 首版不支持用户自定义分享有效期                                |
| 自定义分享码       | 分享码由服务端生成，用户不能自定义                            |
| 自定义域名         | 首版不支持用户自定义域名                                      |

---

## 3. 用户体验

### 3.1 HTML Artifact 分享

当右侧 Artifact 面板选中本地 HTML 文件时，测试模式下展示分享按钮：

```text
app.testMode === true
selectedArtifact.type === ArtifactTypeValue.Html
selectedArtifact.filePath 存在
```

点击后：

1. Renderer 调用 `authService.refreshAuthState()` 刷新登录和配额状态。
2. 未登录时弹出订阅引导：
   - 标题：`登录并订阅后即可分享页面`
   - 说明：`HTML 分享是订阅用户功能。请登录后开通订阅。`
   - 主按钮：`去订阅`
3. 已登录但未订阅时弹出订阅引导：
   - 标题：`开通订阅后即可分享页面`
   - 说明：`HTML 分享需要有效订阅。开通后即可生成外网可访问的分享链接。`
   - 主按钮：`去订阅`
4. 用户点击主按钮时，使用系统浏览器打开 `getPortalPricingUrl()`。
5. 已登录且订阅有效时，Renderer 先通过 `htmlShare:getByHtmlFile` 查询当前 HTML 文件是否已有分享。
6. 没有已有分享时弹出“创建分享”对话框；该首次分享弹窗保持原有行为。
7. 默认选择“分享码”，用户也可以切换为“公开”。
8. 用户点击“创建分享”。
9. 主进程扫描 HTML 文件所在目录并打包静态资源。
10. 客户端上传 multipart 创建请求；请求包含 `clientSourceKey` 和 `accessMode`，不传自定义分享码。
11. 服务端返回 `shareId`、`url`、状态和可选 `shareCode`。
12. 客户端优先展示服务端返回的 `url`，并自动复制到剪贴板。
13. 如果查询到已有分享，则弹出“分享设置”对话框，显示现有分享地址、访问模式、可回显的分享码，以及“更新”按钮。
14. 用户点击“更新”时，主进程重新打包当前 HTML 文件所在目录并调用更新接口；服务端更新内容和访问模式，但保持原 `shareId` 和 URL 不变。

访问方式选择：

| 模式   | 说明                                                               |
| ------ | ------------------------------------------------------------------ |
| 分享码 | 默认选项。访问者打开链接后，需要输入服务端生成的分享码才能查看内容 |
| 公开   | 任何获得链接的人都可以直接查看内容                                 |

分享码由服务端自动生成，客户端和用户不能自定义。客户端展示服务端在创建、查询或更新响应中返回的 `shareCode`；如果旧分享无法回显分享码，则展示 `shareCodeUnavailable` 提示，用户可通过更新或切换访问模式获得新的分享码状态。

### 3.2 线上模式行为

线上模式下：

- `ArtifactPanel` 不显示 HTML 分享按钮。
- 如果运行中从测试模式切回线上模式，客户端关闭当前分享弹窗并清理待分享状态。
- 主进程 `htmlShare:createFromHtmlFile`、`htmlShare:getByHtmlFile`、`htmlShare:updateFromHtmlFile`、`htmlShare:get`、`htmlShare:disable` 在非测试模式返回 `HtmlShareErrorCode.FeatureUnavailable`。
- Renderer 如收到 `FeatureUnavailable`，显示 i18n 文案 `htmlShareUnavailableInProduction`。

### 3.3 HTML 文件分享规则

| 项目       | 当前规则                                                    |
| ---------- | ----------------------------------------------------------- |
| 分享根目录 | HTML 文件所在目录                                           |
| 入口文件   | 当前 HTML 文件名                                            |
| 上传内容   | 根目录下符合白名单的静态文件，递归扫描                      |
| 依赖分析   | HTML/CSS 依赖扫描只用于缺失资源提示，不作为唯一上传依据     |
| 临时文件   | zip 写入系统临时目录 `lobster-html-share-*`，上传后异步清理 |

客户端打包限制：

| 限制             | 当前值 |
| ---------------- | ------ |
| 压缩包大小       | 20 MB  |
| 解压前扫描总大小 | 100 MB |
| 单文件大小       | 10 MB  |
| 文件数量         | 500    |

客户端排除目录：

```text
.git
.hg
.svn
node_modules
.next
.nuxt
.svelte-kit
.vite
.cache
coverage
```

客户端排除文件：

```text
.DS_Store
Thumbs.db
package-lock.json
pnpm-lock.yaml
yarn.lock
.env
.env.*
```

客户端允许扩展名：

```text
.html .htm .css .js .mjs .cjs .json .txt .md
.png .jpg .jpeg .gif .webp .svg .ico .bmp .avif
.woff .woff2 .ttf .otf .eot .wasm
.mp3 .mp4 .webm .ogg
```

当前客户端不允许上传 PDF，也不上传无扩展名文件。

### 3.4 缺失资源提示

`htmlDependencyScanner.ts` 扫描：

```text
HTML src/href
CSS url(...)
CSS @import
```

扫描会跳过远程 URL、协议 URL、`//`、`#`、`data:`、`mailto:`、`tel:`。如果引用的本地文件不存在，创建成功后结果弹窗最多展示前 3 条 `Missing referenced resource: ...` 警告。缺失资源不会阻止上传。

---

## 4. 服务端依赖边界

客户端当前依赖服务端提供按来源查询、创建和更新分享能力：

```http
POST /api/html-shares
GET /api/html-shares/source?sourceType=html_file&clientSourceKey=...
PUT /api/html-shares/{shareId}
```

创建请求发送的业务字段包括：

| 字段           | 当前 Electron 取值                         |
| -------------- | ------------------------------------------ |
| `sourceType`   | `html_file`                                |
| `clientSourceKey` | 根据标准化 HTML 文件路径计算的客户端来源 key |
| `sessionId`    | Cowork session ID                          |
| `artifactId`   | Artifact ID                                |
| `title`        | Artifact title / fileName / `分享`         |
| `entryFile`    | HTML 文件相对分享根目录的路径              |
| `accessMode`   | `code` 或 `public`                         |
| `sourceSha256` | 客户端生成 zip 后对 zip 内容计算的 SHA-256 |
| `archive`      | 静态文件 zip，文件名 `share.zip`           |

更新请求使用 URL 中的 `shareId` 定位已有分享，multipart 字段与创建请求基本一致，但不再发送 `sourceType`。服务端更新当前分享内容和访问模式，并保持原分享地址不变。

客户端消费的响应字段包括：

| 字段                   | 客户端用途                                           |
| ---------------------- | ---------------------------------------------------- |
| `shareId`              | `url` 缺失时构造兜底分享地址，更新时作为稳定资源 ID |
| `url`                  | 优先作为最终分享链接                                 |
| `accessMode`           | 回显当前访问模式                                     |
| `shareCode`            | 分享码模式下展示并复制给用户                         |
| `shareCodeUnavailable` | 旧分享码无法回显时展示提示                           |
| `status`               | 回传分享状态                                         |
| `updatedAt`            | 分享元数据更新时间                                   |
| `contentUpdatedAt`     | 分享内容更新时间                                     |

客户端只在 `41307` 时展示订阅引导。其他服务端错误按失败信息展示。具体 endpoint、响应结构、错误码、鉴权、分享访问和管理能力以 `lobsterai-server` 项目文档与实现为准。

---

## 5. Electron 客户端设计

### 5.1 共享常量

当前文件：

```text
src/shared/htmlShare/constants.ts
```

当前核心常量：

```typescript
export const HtmlShareIpc = {
  CreateFromHtmlFile: 'htmlShare:createFromHtmlFile',
  UpdateFromHtmlFile: 'htmlShare:updateFromHtmlFile',
  GetByHtmlFile: 'htmlShare:getByHtmlFile',
  Disable: 'htmlShare:disable',
  Get: 'htmlShare:get',
} as const;

export const HtmlShareSourceType = {
  HtmlFile: 'html_file',
} as const;

export const HtmlShareAccessMode = {
  Code: 'code',
  Public: 'public',
} as const;

export const HtmlShareStatus = {
  Live: 'live',
  Disabled: 'disabled',
  Failed: 'failed',
} as const;

export const HtmlShareErrorCode = {
  SubscriptionRequired: 41307,
  AccessCodeInvalid: 41308,
  AccessCodeRateLimited: 41309,
  AccessModeInvalid: 41310,
  FeatureUnavailable: 41311,
} as const;
```

注意：当前没有 `CreateFromLocalService` 和 `LocalServiceBuild`。新增本地端口分享时必须先扩展这里，不能在调用处使用裸字符串。

### 5.2 主进程模块

当前文件：

```text
src/main/libs/htmlShare/htmlSharePackager.ts
src/main/libs/htmlShare/htmlDependencyScanner.ts
src/main/libs/htmlShare/htmlShareClient.ts
```

职责：

| 文件                       | 职责                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `htmlSharePackager.ts`     | 扫描目录、排除敏感文件、校验大小和数量、生成 zip、计算 zip SHA-256                               |
| `htmlDependencyScanner.ts` | 扫描 HTML/CSS 显性依赖并生成缺失资源提示                                                         |
| `htmlShareClient.ts`       | 使用 `fetchWithAuth()` 上传 multipart 到服务端，优先使用服务端 URL，缺失时按当前环境构造兜底 URL |

当前不存在：

```text
src/main/libs/htmlShare/localFrontendBuilder.ts
```

### 5.3 Endpoint 和模式判断

主进程：

```typescript
export const isTestModeEnabled = (): boolean => {
  return cachedTestMode ?? !app.isPackaged;
};

export const getServerApiBaseUrl = (): string => {
  return isTestModeEnabled()
    ? 'https://glmcoding.cn/api'
    : 'https://glmcoding.cn/api';
};

export const getHtmlSharePublicBaseUrl = (): string => {
  return `${getServerApiBaseUrl()}${HtmlSharePublicRoute.Root}`;
};
```

Renderer：

```typescript
export const isTestModeEnabled = () => {
  return configService.getConfig().app?.testMode === true;
};
```

订阅引导通过：

```typescript
window.electron.shell.openExternal(getPortalPricingUrl());
```

### 5.4 IPC

preload 暴露：

```typescript
window.electron.htmlShare.createFromHtmlFile(options);
window.electron.htmlShare.updateFromHtmlFile(options);
window.electron.htmlShare.getByHtmlFile({ filePath });
window.electron.htmlShare.disable(shareId);
window.electron.htmlShare.get(shareId);
```

`createFromHtmlFile` 参数：

```typescript
{
  shareId?: string; // updateFromHtmlFile 必填
  sessionId: string;
  artifactId: string;
  filePath: string;
  title: string;
  accessMode: HtmlShareAccessMode;
}
```

主进程输入校验：

| 字段         | 校验                                                              |
| ------------ | ----------------------------------------------------------------- |
| `sessionId`  | string，trim 后非空，最长 128                                     |
| `artifactId` | string，trim 后非空，最长 128                                     |
| `filePath`   | string，trim 后非空，最长 4096                                    |
| `title`      | string，trim 后非空，最长 255                                     |
| `accessMode` | 必须为 `HtmlShareAccessMode.Code` 或 `HtmlShareAccessMode.Public` |

结果：

```typescript
{
  success: boolean;
  shareId?: string;
  url?: string;
  accessMode?: HtmlShareAccessMode;
  shareCode?: string;
  shareCodeUnavailable?: boolean;
  status?: HtmlShareStatus;
  updatedAt?: string;
  contentUpdatedAt?: string;
  error?: string;
  code?: number;
  warnings?: string[];
}
```

### 5.5 主进程创建流程

```text
htmlShare:createFromHtmlFile
  ↓
isTestModeEnabled()
  ↓
sanitizeCreateFromHtmlFileInput()
  ↓
buildHtmlShareClientSourceKey(filePath)
  ↓
packageHtmlFile(filePath)
  ↓
uploadHtmlShare(getServerApiBaseUrl(), getHtmlSharePublicBaseUrl(), fetchWithAuth, payload)
  ↓
返回 upload 结果和 dependency warnings
  ↓
finally 异步删除临时 zip 目录
```

上传字段：

```typescript
{
  archivePath: packaged.archivePath,
  sourceType: HtmlShareSourceType.HtmlFile,
  clientSourceKey: buildHtmlShareClientSourceKey(options.filePath),
  accessMode: options.accessMode,
  sessionId: options.sessionId,
  artifactId: options.artifactId,
  title: options.title,
  entryFile: packaged.entryFile,
  sourceSha256: packaged.sourceSha256,
}
```

已有分享查询流程：

```text
htmlShare:getByHtmlFile
  ↓
isTestModeEnabled()
  ↓
sanitizeHtmlShareFilePathInput()
  ↓
buildHtmlShareClientSourceKey(filePath)
  ↓
getHtmlShareBySource(getServerApiBaseUrl(), getHtmlSharePublicBaseUrl(), fetchWithAuth, HtmlShareSourceType.HtmlFile, clientSourceKey)
```

已有分享更新流程：

```text
htmlShare:updateFromHtmlFile
  ↓
isTestModeEnabled()
  ↓
sanitizeUpdateFromHtmlFileInput()
  ↓
buildHtmlShareClientSourceKey(filePath)
  ↓
packageHtmlFile(filePath)
  ↓
updateHtmlShare(getServerApiBaseUrl(), getHtmlSharePublicBaseUrl(), fetchWithAuth, shareId, payload)
  ↓
返回原分享 URL 和最新访问模式 / 分享码状态
  ↓
finally 异步删除临时 zip 目录
```

### 5.6 Renderer UI 状态

当前 `ArtifactPanel` 内部状态：

```text
idle
checking
selectingAccessMode
packing
uploading
live
failed
```

`checking` 用于分享按钮点击后查询当前 HTML 文件是否已有分享。当前没有 `scanning` 和 `building` 状态。虽然 i18n 中保留了 `htmlShareScanning`，但 UI 流程没有使用。

成功状态：

- 公开模式展示分享 URL。
- 分享码模式展示分享 URL 和分享码。
- 公开模式自动复制链接到剪贴板。
- 分享码模式自动复制链接和分享码到剪贴板。
- 提供“复制链接”或“复制链接和分享码”以及“打开链接”。
- 已有分享弹窗展示原 URL，可复制、打开，并可点击“更新”重新上传当前文件内容。

失败状态：

- 显示可理解错误。
- 不影响当前本地预览。
- 如果服务端返回 `41307`，展示订阅引导。
- 如果主进程返回 `FeatureUnavailable`，展示测试模式限制说明。

未登录或未订阅状态：

- 不执行扫描、打包和上传。
- 弹窗说明分享功能需要登录并开通订阅。
- 用户点击主按钮后，使用系统浏览器打开 `getPortalPricingUrl()`。
- 用户完成登录或订阅后不自动继续分享，用户需要回到客户端再次点击分享。

创建分享对话框：

```text
创建分享

(*) 分享码
    访问者打开链接后，需要输入分享码才能查看。

( ) 公开
    任何获得链接的人都可以直接查看。

[取消] [创建分享]
```

默认选中“分享码”。首次分享弹窗不展示已有 URL，也不提供用户输入分享码的表单。

已有分享对话框：

```text
分享设置

此文件已分享。更新后原链接保持不变。

分享链接
https://...

(*) 分享码
    访问者打开链接后，需要输入分享码才能查看。

( ) 公开
    任何获得链接的人都可以直接查看。

分享码
123456

[取消] [复制链接和分享码] [打开链接] [更新]
```

如果服务端无法回显旧分享码，分享码区域展示 `htmlShareCodeUnavailable`，更新后以服务端最新返回为准。

### 5.7 i18n key

当前已加入中英文：

```text
htmlShare
htmlShareScanning
htmlSharePacking
htmlShareUploading
htmlShareSuccess
htmlShareSuccessMessage
htmlShareFailed
htmlShareCreateDialogTitle
htmlShareCreate
htmlShareManageDialogTitle
htmlShareExistingShareMessage
htmlShareUpdate
htmlShareUpdated
htmlShareUpdatedMessage
htmlShareAccessModeCode
htmlShareAccessModeCodeDescription
htmlShareAccessModePublic
htmlShareAccessModePublicDescription
htmlShareLink
htmlShareCode
htmlShareCopyLink
htmlShareCopyLinkAndCode
htmlShareOpenLink
htmlShareCodeUnavailable
htmlShareLoginRequiredTitle
htmlShareLoginRequiredMessage
htmlShareSubscriptionRequiredTitle
htmlShareSubscriptionRequiredMessage
htmlShareOpenSubscription
htmlShareUnavailableInProduction
```

当前没有：

```text
htmlShareCurrentPage
htmlShareBuilding
```

---

## 6. Electron 客户端验收清单

1. 测试模式下，HTML Artifact 有 `filePath` 时显示分享按钮。
2. 线上模式下，HTML Artifact 不显示分享按钮。
3. 线上模式下，主进程分享相关 IPC 返回 `FeatureUnavailable`，不打包也不上传。
4. 非 HTML Artifact 或没有 `filePath` 的 HTML 内容不显示分享按钮。
5. 未登录点击 HTML Artifact 分享按钮，看到分享需要登录和订阅的说明，并可打开 Portal 订阅页。
6. 已登录但未订阅点击分享按钮，看到订阅说明，并可打开 Portal 订阅页。
7. 已登录且订阅有效点击分享后，先按 HTML 文件来源查询已有分享。
8. 首次分享时展示创建分享对话框，默认选中分享码模式。
9. 首次分享弹窗保持原有交互，用户可以切换为公开模式。
10. 已登录且订阅有效的 HTML Artifact 分享能上传 HTML 所在目录。
11. 创建分享时客户端上传 `sourceType = html_file`、`clientSourceKey`、`entryFile`、`sourceSha256` 和 `archive`。
12. 客户端不上传 `.env*`、lockfile、`.git`、`node_modules`、缓存目录和超出限制的文件。
13. 客户端遇到 symlink、超文件数、超大小时阻止分享并展示错误。
14. 公开模式分享成功后 URL 可复制、可打开。
15. 分享码模式分享成功后 URL 和分享码可复制、可打开链接。
16. 服务端返回 `41307` 时显示订阅引导。
17. 服务端返回 `url` 时，客户端优先使用该 URL 作为分享链接。
18. 服务端缺失 `url` 但返回 `shareId` 时，客户端使用当前环境 base URL 构造兜底分享链接。
19. 同一 HTML 文件已有分享时，点击分享按钮展示已有 URL、访问模式、分享码状态和“更新”按钮。
20. 已有分享更新后，原 URL 保持不变，访问模式按用户最新选择生效。
21. 旧分享无法回显分享码时，客户端展示 `shareCodeUnavailable` 提示。

### 6.1 当前不适用的客户端验收项

以下能力尚未实现，不能作为当前 Electron 验收项：

1. 本地端口分享按钮。
2. `htmlShare:createFromLocalService` IPC。
3. 本地项目自动构建。
4. 构建失败 stdout/stderr 摘要。
5. 输出目录缺少 `index.html` 时阻止分享。

---

## 7. 后续扩展：本地端口分享

本地端口分享若后续实现，应作为独立增量设计，不应复用当前已实现路径里的裸字符串。

需要新增：

```typescript
export const HtmlShareIpc = {
  CreateFromHtmlFile: 'htmlShare:createFromHtmlFile',
  UpdateFromHtmlFile: 'htmlShare:updateFromHtmlFile',
  GetByHtmlFile: 'htmlShare:getByHtmlFile',
  CreateFromLocalService: 'htmlShare:createFromLocalService',
  Disable: 'htmlShare:disable',
  Get: 'htmlShare:get',
} as const;

export const HtmlShareSourceType = {
  HtmlFile: 'html_file',
  LocalServiceBuild: 'local_service_build',
} as const;
```

建议新增文件：

```text
src/main/libs/htmlShare/localFrontendBuilder.ts
```

本地 URL 判断：

```text
localhost
127.0.0.1
0.0.0.0
::1
[::1]
```

点击流程：

```text
检查测试模式、登录和订阅状态
  ↓
已登录且订阅有效：弹出创建分享对话框，选择分享码或公开
  ↓
调用 htmlShare:createFromLocalService，参数包含 accessMode
  ↓
主进程识别 workingDirectory
  ↓
本地构建或静态目录分享
  ↓
上传服务端
  ↓
展示 URL；分享码模式展示服务端返回的 shareCode
```

包管理器建议：

| 条件             | install 命令   | build 命令      |
| ---------------- | -------------- | --------------- |
| `pnpm-lock.yaml` | `pnpm install` | `pnpm build`    |
| `yarn.lock`      | `yarn install` | `yarn build`    |
| 默认             | `npm install`  | `npm run build` |

执行规则：

- 如果 `node_modules` 不存在，先执行 install。
- 构建超时 10 分钟。
- 构建失败时返回 stderr/stdout 摘要，不上传。
- 允许用户在确认弹窗中修改 build command 和 output directory。

输出目录推断：

| 项目类型            | 输出目录 |
| ------------------- | -------- |
| Vite / Vue / Svelte | `dist`   |
| Create React App    | `build`  |
| Next static export  | `out`    |

输出目录必须包含 `index.html`。
