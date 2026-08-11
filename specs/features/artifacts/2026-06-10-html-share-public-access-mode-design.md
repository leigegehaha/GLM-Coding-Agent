# HTML 分享公开访问模式与模式切换设计文档

## 1. 概述

### 1.1 问题/背景

HTML 静态分享当前在客户端只暴露“分享码”模式，用户创建分享时不能选择公开访问。实际系统历史上曾支持 `public` 模式，数据库结构、服务端静态访问链路和管理员后台展示也仍保留了部分公开访问能力：

- 客户端仓库 `/Users/admin/Documents/lobsterai/智码 GLM Code`
  - `src/shared/htmlShare/constants.ts` 中 `HtmlShareAccessMode` 只定义了 `Code`。
  - `src/main/main.ts` 的 `validateHtmlShareAccessMode()` 只允许 `code`。
  - `uploadHtmlShare()` / `updateHtmlShare()` 调用没有把 `accessMode` 传给服务端。
  - `ArtifactPanel` 分享入口没有创建时访问方式选择，也没有已有分享的访问方式切换。
- 服务端仓库 `/Users/admin/Documents/lobsterai/lobsterai-server`
  - `html_shares.access_mode` 字段仍存在，schema 默认值为 `public`。
  - `HtmlShareService.ACCESS_MODES` 包含 `code` 和 `public`。
  - `HtmlShareStaticController` 只在 `isAccessCodeRequired()` 为 true 时要求分享码，因此公开访问链路本身可复用。
  - `HtmlShareAccessService.normalizeAccessMode()` 当前把空值默认成 `code`，并拒绝 `public`。
- 管理后台仓库 `/Users/admin/Documents/lobsterai/lobsterai-admin`
  - `HtmlShareListView.vue` 已能展示 `公开访问` 和 `分享码`。
  - 管理后台文档已描述分享可以是公开访问或分享码访问。

本次要恢复用户侧公开访问能力，并补齐访问模式切换。用户创建分享时可以选择 `分享码` 或 `公开访问`，默认仍是 `分享码`。用户更新已有分享时也可以切换访问模式。

### 1.2 目标

1. 创建 HTML 分享时让用户选择访问方式：`分享码` 或 `公开访问`。
2. 默认访问方式保持 `分享码`，兼容旧客户端和现有产品策略。
3. 更新已有分享时支持切换访问方式。
4. `code -> public -> code` 切换时尽量复用原分享码。
5. 切回 `code` 时，如果没有可复用分享码，则服务端生成新分享码并返回。
6. 旧客户端更新分享时如果不传 `accessMode`，服务端必须保留已有访问方式，避免把旧公开分享改成分享码。
7. 管理后台继续正确展示、筛选和审核两种访问方式，不展示分享码明文。
8. 不引入数据库结构变更，除非测试环境实际表结构与仓库 schema 不一致。

### 1.3 非目标

1. 不在管理后台展示或解密分享码明文。
2. 不移除订阅校验、登录校验或服务端最终鉴权。
3. 不改变分享 URL 格式。
4. 不在内容更新时自动轮换分享码。
5. 不支持用户自定义分享码。
6. 不批量为历史公开分享补生成分享码；公开分享第一次切到分享码模式时再懒生成。
7. 不新增“重置分享码”功能；该能力可作为后续独立安全操作设计。

### 1.4 方案结论

访问模式和分享码凭据分开管理：

- `access_mode` 决定当前访问行为。
- `access_code_*` 字段保存分享码凭据，可以在 `public` 模式下继续保留。
- 创建时未传 `accessMode` 默认 `code`。
- 更新时未传 `accessMode` 保留原访问方式。
- 切换到 `public` 只改 `access_mode`，不清空分享码字段。
- 切换到 `code` 时优先复用可解密的历史分享码；没有可复用分享码时生成新分享码。

服务端需要新增一个“仅更新访问方式”的接口，避免用户只改访问方式时必须重新上传文件。内容更新接口仍可同时携带 `accessMode`，用于“更新文件并调整访问方式”的场景。

## 2. 用户场景

### 场景 1: 用户创建默认分享码分享

**Given** 用户已登录且订阅有效，并在 Artifact 面板选中一个本地 HTML 文件。

**When** 用户点击分享按钮，保持默认访问方式 `分享码` 并创建分享。

**Then** 客户端上传 HTML 静态资源，服务端创建 `access_mode = code` 的分享，返回分享链接和分享码，客户端展示并复制“链接 + 分享码”。

### 场景 2: 用户创建公开访问分享

**Given** 用户已登录且订阅有效，并在 Artifact 面板选中一个本地 HTML 文件。

**When** 用户点击分享按钮，在创建弹窗中选择 `公开访问` 并创建分享。

**Then** 服务端创建 `access_mode = public` 的分享，不生成分享码，客户端只展示分享链接。访问者打开链接时无需输入分享码即可查看内容。

### 场景 3: 用户把分享码分享改成公开访问

**Given** 用户已有一个 `access_mode = code` 的 live 分享，并且服务端保存了可用分享码凭据。

**When** 用户在分享设置中把访问方式切换为 `公开访问`。

**Then** 服务端只把 `access_mode` 更新为 `public`，保留 `access_code_hash`、`access_code_salt`、`access_code_ciphertext` 和 `access_code_nonce`，分享链接无需分享码即可访问。

### 场景 4: 用户把公开访问分享改回分享码访问

**Given** 用户已有一个由 `code` 切到 `public` 的分享，服务端仍保留可解密的分享码凭据。

**When** 用户在分享设置中把访问方式切换为 `分享码`。

**Then** 服务端把 `access_mode` 更新为 `code`，复用原分享码并返回给客户端。此前发出去的“链接 + 分享码”仍然可用。

### 场景 5: 历史公开分享第一次切到分享码访问

**Given** 用户已有一个 `access_mode = public` 的历史分享，但没有任何 `access_code_*` 凭据。

**When** 用户把访问方式切换为 `分享码`。

**Then** 服务端生成新的分享码凭据并返回新分享码，后续访问者必须输入该分享码。

### 场景 6: 旧客户端更新公开分享内容

**Given** 用户通过旧客户端更新一个 `access_mode = public` 的分享，旧客户端请求不包含 `accessMode`。

**When** 服务端处理内容更新请求。

**Then** 服务端保留已有 `access_mode = public`，只更新内容和内容审核状态，不把分享隐式改成 `code`。

### 场景 7: 管理员审核公开分享

**Given** 管理员拥有 `html-shares` 权限，并在管理后台查看 HTML 分享列表。

**When** 管理员筛选或打开 `accessMode = public` 的分享。

**Then** 管理后台正确展示 `公开访问`，管理员预览仍走审核预览授权，不展示分享码明文。

## 3. 功能需求

### FR-1: 客户端创建分享时提供访问方式选择

首次创建 HTML 分享时，客户端必须显示创建弹窗，提供 `分享码` 和 `公开访问` 两个互斥选项。默认选中 `分享码`。

### FR-2: 客户端已有分享设置支持访问方式切换

已有分享弹窗必须展示当前访问方式，并允许用户切换 `分享码` / `公开访问`。用户只切换访问方式时，客户端调用专用访问方式更新接口，不重新打包或上传文件。

### FR-3: 服务端创建接口支持 public 和 code

`POST /api/html-shares` 的 multipart 表单支持可选字段：

```text
accessMode?: "code" | "public"
```

未传时默认 `code`。传入其他值时返回 `HTML_SHARE_ACCESS_MODE_INVALID`。

### FR-4: 服务端内容更新接口支持访问方式更新

`PUT /api/html-shares/{shareId}` 的 multipart 表单支持可选字段：

```text
accessMode?: "code" | "public"
```

未传时保留已有访问方式。传入 `public` 或 `code` 时，在更新内容的同时更新访问方式。

### FR-5: 服务端新增仅更新访问方式接口

新增接口：

```http
PUT /api/html-shares/{shareId}/access-mode
Content-Type: application/json

{
  "accessMode": "public"
}
```

该接口只更新访问方式，不更新内容文件，不重置内容审核状态，不修改 `contentUpdatedAt`。

### FR-6: 分享码凭据复用

服务端切换到 `code` 时必须按以下顺序处理：

1. 如果已有 `access_code_*` 字段且密文可以解密，复用原分享码并返回。
2. 如果没有可解密分享码，生成新的分享码凭据并返回新分享码。

切换到 `public` 时不得清空 `access_code_*` 字段。

### FR-7: 静态访问行为保持模式驱动

`public` 分享访问入口文件和静态资源时不要求分享码。`code` 分享仍要求分享码或有效访问 cookie。

### FR-8: 管理后台兼容两种访问方式

管理后台继续支持 `accessMode` 筛选、列表展示、详情展示和审核预览。后台不得展示分享码明文。

### FR-9: 文案国际化

客户端新增或修改用户可见文案时，必须在 `src/renderer/services/i18n.ts` 的中文和英文区域同时添加 key。

## 4. 实现方案

### 4.1 服务端

#### 4.1.1 访问方式常量与校验

服务端继续使用 `HtmlShareAccessService` 中的常量：

```java
public static final String ACCESS_MODE_CODE = "code";
public static final String ACCESS_MODE_PUBLIC = "public";
```

将访问方式归一化拆成创建、更新和必填校验三种语义：

```java
public String normalizeAccessModeForCreate(String accessMode) {
    if (!StringUtils.hasText(accessMode)) {
        return ACCESS_MODE_CODE;
    }
    return normalizeRequiredAccessMode(accessMode);
}

public String normalizeAccessModeForUpdate(String accessMode, String existingAccessMode) {
    if (!StringUtils.hasText(accessMode)) {
        return normalizeRequiredAccessMode(existingAccessMode);
    }
    return normalizeRequiredAccessMode(accessMode);
}

public String normalizeRequiredAccessMode(String accessMode) {
    String value = accessMode.trim().toLowerCase(Locale.ROOT);
    if (!ACCESS_MODE_CODE.equals(value) && !ACCESS_MODE_PUBLIC.equals(value)) {
        throw new ServiceException(ErrorCode.HTML_SHARE_ACCESS_MODE_INVALID);
    }
    return value;
}
```

`ErrorCode.HTML_SHARE_ACCESS_MODE_INVALID` 文案从 `仅支持分享码模式` 改为 `分享访问模式无效`。

#### 4.1.2 创建分享

`HtmlShareController.create()` 继续接收 `@RequestParam(value = "accessMode", required = false)`。

`HtmlShareService.createShare()` 行为：

- 使用 `normalizeAccessModeForCreate(accessMode)`。
- `code` 模式创建分享码凭据，并通过响应返回明文分享码。
- `public` 模式不创建分享码凭据，`shareCode = null`，`shareCodeUnavailable = false`。
- 其他创建、上传、订阅校验和审核触发逻辑保持不变。

#### 4.1.3 更新分享内容

`HtmlShareService.updateShare()` 行为：

- 先读取 `existing`。
- 使用 `normalizeAccessModeForUpdate(accessMode, existing.getAccessMode())`。
- 内容更新仍替换文件、更新 `contentUpdatedAt`、重置审核状态并触发审核。
- 更新到 `public` 时保留已有分享码字段。
- 更新到 `code` 时调用统一 helper 确保存在可用分享码。

#### 4.1.4 新增访问方式更新接口

新增 DTO：

```java
public class HtmlShareAccessModeUpdateRequest {
    private String accessMode;
}
```

新增 Controller 方法：

```java
@PutMapping("/{shareId}/access-mode")
public ApiResponse<?> updateAccessMode(@PathVariable String shareId,
                                       @RequestBody HtmlShareAccessModeUpdateRequest body,
                                       HttpServletRequest request) {
    Long userId = requireUser(request);
    return ApiResponse.success(htmlShareService.updateMineAccessMode(userId, shareId, body.getAccessMode()));
}
```

新增 Service 方法 `updateMineAccessMode(Long userId, String shareId, String accessMode)`：

- 要求用户已登录且拥有该分享。
- 要求用户订阅有效，与创建/内容更新保持一致。
- `live` 分享允许切换。
- 用户自己关闭的 `disabled` 分享允许切换，但不重新打开。
- `failed` 分享拒绝。
- 管理员关闭、审核关闭、系统关闭的分享拒绝。
- 不修改内容文件。
- 不修改 `contentUpdatedAt`。
- 不重置 `moderationStatus`。
- 更新 `updatedAt`。
- 返回 `HtmlShareCreateResponse`，用于客户端拿到最新 `accessMode`、状态和可选 `shareCode`。

#### 4.1.5 分享码复用 helper

在 `HtmlShareService` 中抽出统一 helper，供内容更新和访问方式更新复用：

```java
private String ensureAccessCodeForCodeMode(HtmlShare existing, HtmlShare target) {
    if (hasStoredAccessCode(existing)) {
        String shareCode = htmlShareAccessService.decryptAccessCode(existing);
        if (shareCode != null) {
            copyAccessCode(existing, target);
            return shareCode;
        }
    }

    HtmlShareAccessService.AccessCode accessCode =
            htmlShareAccessService.createAccessCode(existing.getId());
    applyAccessCode(target, accessCode);
    return accessCode.getCode();
}
```

`hasStoredAccessCode()` 至少检查 hash、salt、ciphertext、nonce 是否存在。若旧数据只有 hash/salt 而没有可解密密文，切回 `code` 时生成新分享码。

#### 4.1.6 静态访问

`HtmlShareStaticController` 当前逻辑可保留：

- `htmlShareService.isAccessCodeRequired(share)` 为 true 时要求分享码或访问 cookie。
- `public` 分享该方法返回 false，因此直接返回内容。

需要补测试，防止未来再次只支持 `code`。

### 4.2 桌面客户端

#### 4.2.1 常量

更新 `src/shared/htmlShare/constants.ts`：

```typescript
export const HtmlShareAccessMode = {
  Code: 'code',
  Public: 'public',
} as const;
export type HtmlShareAccessMode = typeof HtmlShareAccessMode[keyof typeof HtmlShareAccessMode];
```

所有构造和比较访问方式的地方使用 `HtmlShareAccessMode.Code` / `HtmlShareAccessMode.Public`。

#### 4.2.2 主进程 IPC 入参

`src/main/main.ts` 中创建/更新入参增加 `accessMode`：

```typescript
interface HtmlShareCreateFromHtmlFileInput {
  sessionId: string;
  artifactId: string;
  filePath: string;
  title: string;
  accessMode?: HtmlShareAccessMode;
}
```

创建 sanitize 行为：

- 未传 `accessMode` 默认 `HtmlShareAccessMode.Code`。
- 接受 `Code` 和 `Public`。
- 其他值抛出参数错误。

更新 sanitize 行为：

- 接受可选 `accessMode`。
- 新版客户端更新文件时始终传当前选择的访问方式。
- 如果旧调用方不传，主进程可以不填该字段，让服务端按“保留旧模式”处理。

#### 4.2.3 上传客户端

`src/main/libs/htmlShare/htmlShareClient.ts`：

- `CreateHtmlShareUploadInput` 增加 `accessMode?: HtmlShareAccessMode`。
- `appendHtmlShareFormData()` 在存在 `accessMode` 时写入 form。
- `uploadHtmlShare()` 和 `updateHtmlShare()` 日志不再写死“share-code access”，改为输出当前 access mode。
- 响应解析继续保留 `accessMode`、`shareCode`、`shareCodeUnavailable`。

#### 4.2.4 preload 和 renderer 类型

`src/main/preload.ts` 与 `src/renderer/types/electron.d.ts`：

- `createFromHtmlFile()` options 增加 `accessMode?: HtmlShareAccessMode`。
- `updateFromHtmlFile()` options 增加 `accessMode?: HtmlShareAccessMode`。
- 新增：

```typescript
updateAccessMode: (options: {
  shareId: string;
  accessMode: HtmlShareAccessMode;
}) => Promise<HtmlShareResult>;
```

对应新增 IPC channel 时要遵守仓库常量规则，在 `src/shared/htmlShare/constants.ts` 中定义，例如：

```typescript
UpdateAccessMode: 'htmlShare:updateAccessMode'
```

#### 4.2.5 ArtifactPanel UI

`src/renderer/components/artifacts/ArtifactPanel.tsx` 调整：

- `ExistingHtmlShareInfo` 保存 `accessMode`。
- `HtmlSharePendingRequest` 保存用户选择的 `accessMode`。
- 首次分享时不再直接调用创建接口，而是展示创建弹窗。
- 创建弹窗默认选中 `HtmlShareAccessMode.Code`。
- 已有分享设置弹窗展示当前访问方式，并提供互斥选择。
- 只改访问方式时调用 `window.electron.htmlShare.updateAccessMode()`。
- 更新文件时调用 `updateFromHtmlFile()`，同时传当前选择的访问方式。
- 复制 public 分享时只复制链接。
- 复制 code 分享且有 `shareCode` 时复制链接和分享码。
- code 分享的旧数据无法回显分享码时继续显示 `shareCodeUnavailable` 提示。

#### 4.2.6 i18n

`src/renderer/services/i18n.ts` 新增中英文 key：

- `htmlShareAccessMode`
- `htmlShareAccessModeCode`
- `htmlShareAccessModeCodeHint`
- `htmlShareAccessModePublic`
- `htmlShareAccessModePublicHint`
- `htmlShareCreateDialogTitle`
- `htmlShareCreateAction`
- `htmlSharePublicViewHint`
- `htmlShareCodeViewHint`
- `htmlShareAccessModeUpdating`
- `htmlShareAccessModeUpdateFailed`
- `htmlShareAccessModeUpdated`

现有默认暗示“必须输入分享码”的文案改为模式相关文案：

- `htmlShareViewHint`
- `htmlShareSuccessMessage`
- `htmlShareExistingShareMessage`
- `htmlShareAvailabilityOpenHint`

### 4.3 管理后台

管理后台当前已能展示两种模式，原则上不需要新增功能。实施时需要复核：

- `src/api/htmlShares.ts` 的 `accessMode` 查询参数仍可传 `public` / `code`。
- `src/views/HtmlShareListView.vue` 列表标签和详情标签正确显示 `公开访问` / `分享码`。
- public 分享详情展示 `无分享码`。
- code 分享详情展示 `已设置分享码` 或 `无分享码`，但不展示明文。
- 审核预览继续通过 preview token 绕过分享码校验，不暴露用户分享码。

### 4.4 数据库

不新增字段。

测试环境需要确认表结构：

```sql
SHOW COLUMNS FROM html_shares LIKE 'access_mode';
SHOW COLUMNS FROM html_shares LIKE 'access_code_ciphertext';
SHOW INDEX FROM html_shares WHERE Key_name = 'idx_html_shares_access_mode';
```

期望：

- `access_mode` 存在。
- `access_code_hash`、`access_code_salt`、`access_code_created_at`、`access_code_ciphertext`、`access_code_nonce` 可为空。
- `access_mode` 可存 `public` 和 `code`。

仓库 schema 中 `access_mode` 默认值为 `public`，但业务创建接口仍显式默认 `code`。两者不冲突，应用层不依赖数据库默认值。

### 4.5 发布顺序

1. 先发布服务端。
   - 新客户端需要服务端接受 `public`。
   - 旧客户端创建时仍默认 `code`。
   - 旧客户端更新公开分享时不会把访问方式改成 `code`。
2. 发布桌面客户端。
   - 用户可以创建 public 分享。
   - 用户可以切换已有分享访问方式。
3. 验证管理后台。
   - 确认 mixed data 下 public/code 展示、筛选、审核都正常。
4. 观察 `HTML_SHARE_ACCESS_MODE_INVALID` 错误量。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 创建分享不传 `accessMode` | 服务端默认 `code` |
| 更新分享不传 `accessMode` | 服务端保留已有访问方式 |
| `code -> public` | 只改 `access_mode`，保留分享码凭据 |
| `public -> code` 且有可解密旧码 | 复用旧分享码并返回 |
| `public -> code` 但旧码缺失或不可解密 | 生成新分享码并返回 |
| public 分享访问入口 | 不展示分享码页，直接返回内容 |
| code 分享访问入口 | 未验证时展示分享码页或返回 403 |
| 用户关闭的 disabled 分享切换访问方式 | 允许切换，但保持 disabled，不重新打开 |
| 管理员/审核/系统关闭的分享切换访问方式 | 拒绝，沿用现有 forbidden/not-found 语义 |
| failed 分享切换访问方式 | 拒绝 |
| 内容更新同时切换访问方式 | 更新内容、重置审核状态，并应用新访问方式 |
| 只切换访问方式 | 不更新内容，不重置审核状态，不改 `contentUpdatedAt` |
| 管理后台查看 code 分享 | 不展示分享码明文 |
| 管理后台预览 code 分享 | 使用管理员 preview token，不要求管理员知道分享码 |

## 6. 涉及文件

### 6.1 桌面客户端 `/Users/admin/Documents/lobsterai/智码 GLM Code`

| 文件 | 变更 |
|------|------|
| `src/shared/htmlShare/constants.ts` | 增加 `HtmlShareAccessMode.Public` 和 `HtmlShareIpc.UpdateAccessMode` |
| `src/main/main.ts` | 放开 access mode 校验，传递 create/update accessMode，新增 updateAccessMode IPC handler |
| `src/main/preload.ts` | create/update options 增加 accessMode，暴露 updateAccessMode |
| `src/main/libs/htmlShare/htmlShareClient.ts` | multipart 表单写入 accessMode，新增 updateAccessMode client |
| `src/main/libs/htmlShare/htmlShareClient.test.ts` | 覆盖 public/code 请求与响应解析 |
| `src/renderer/types/electron.d.ts` | 更新 HTML share API 类型 |
| `src/renderer/components/artifacts/ArtifactPanel.tsx` | 新增创建选择、已有分享模式切换、复制逻辑调整 |
| `src/renderer/services/i18n.ts` | 新增和调整分享访问方式相关中英文文案 |

### 6.2 服务端 `/Users/admin/Documents/lobsterai/lobsterai-server`

| 文件 | 变更 |
|------|------|
| `src/main/java/com/youdao/lobsterai/service/HtmlShareAccessService.java` | 支持 `public`，拆分创建/更新归一化语义 |
| `src/main/java/com/youdao/lobsterai/service/HtmlShareService.java` | 创建/更新模式处理，分享码复用 helper，新增仅更新访问方式方法 |
| `src/main/java/com/youdao/lobsterai/web/controller/HtmlShareController.java` | 新增 `PUT /api/html-shares/{shareId}/access-mode` |
| `src/main/java/com/youdao/lobsterai/entity/dto/HtmlShareAccessModeUpdateRequest.java` | 新增请求 DTO |
| `src/main/java/com/youdao/lobsterai/exceptions/ErrorCode.java` | 更新访问方式错误文案 |
| `src/test/java/com/youdao/lobsterai/service/HtmlShareAccessServiceTest.java` | 更新 normalize access mode 测试 |
| `src/test/java/com/youdao/lobsterai/service/HtmlShareServiceTest.java` | 覆盖 public 创建、更新、模式切换和分享码复用 |
| `src/test/java/com/youdao/lobsterai/web/controller/HtmlShareStaticControllerTest.java` | 覆盖 public/code 访问行为 |

### 6.3 管理后台 `/Users/admin/Documents/lobsterai/lobsterai-admin`

| 文件 | 变更 |
|------|------|
| `src/api/htmlShares.ts` | 复核 accessMode 类型和查询参数 |
| `src/views/HtmlShareListView.vue` | 复核 public/code 标签、筛选和详情文案 |

## 7. 验收标准

1. 新建 HTML 分享时，客户端展示访问方式选择，默认选中 `分享码`。
2. 新建 `分享码` 分享后，服务端写入 `access_mode = code`，客户端展示链接和分享码。
3. 新建 `公开访问` 分享后，服务端写入 `access_mode = public`，客户端只展示链接。
4. public 分享 URL 可直接打开，不要求输入分享码。
5. code 分享 URL 未验证时仍要求输入分享码。
6. 用户可在已有分享设置中把 `code` 切到 `public`，切换后原分享码字段仍保留。
7. 用户可把同一分享从 `public` 切回 `code`，如果历史分享码可解密，返回并继续使用原分享码。
8. 没有历史分享码的 public 分享切到 code 时，服务端生成并返回新分享码。
9. 旧客户端更新 public 分享且不传 `accessMode` 时，分享保持 public。
10. 只切换访问方式时不上传文件，不修改 `contentUpdatedAt`，不重置 `moderationStatus`。
11. 更新内容并切换访问方式时，内容更新、审核重置和访问方式变更同时生效。
12. 管理后台可筛选、展示、详情查看和审核预览 public/code 分享，不展示分享码明文。
13. 客户端 `npm run lint` 通过。
14. 客户端 HTML share 相关测试通过。
15. 服务端 HTML share 相关单元测试通过。
