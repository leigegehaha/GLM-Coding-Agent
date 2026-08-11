# 智码 GLM Code 数据备份与跨机器还原设计文档

## 1. 概述

### 1.1 问题/背景

智码 GLM Code 需要在设置页提供“数据备份”和“数据迁移”能力，用于用户把一台机器上的 智码 GLM Code 迁移到另一台机器。应用内迁移采用新的归档格式，只支持由 智码 GLM Code 设置页导出的备份包。

应用内迁移不能简单采用“强制退出后打包/删除/解压”模型，因为主进程、SQLite、OpenClaw gateway、定时任务和 IM 网关都可能在运行中写入数据。已经出现过以下失败现象：

- 备份包里缺少或包含错误的 `lobsterai.sqlite`，导致多 Agent、历史记录、定时任务、自定义模型 API key、IM 配置没有迁移成功。
- Windows 上复制 `Network/Cookies`、重命名 `userData` 时遇到 `EBUSY` 或 `EPERM`。
- 还原阶段过早退出应用，用户中途再次启动导致恢复失败。
- UI 上显示迁移成功，但实际数据库或 OpenClaw state 没有被目标应用加载。

因此，本设计文档把备份和还原拆成可验证的数据流程，明确数据范围、归档格式、停写策略、回滚策略和验收标准。后续实现必须以本文为准，先修正方案，再修改代码。

### 1.2 目标

1. 在设置页 `Agent 引擎 -> OpenClaw 维护` 中提供可用的备份和导入入口。
2. 支持 Windows、macOS 和 Linux 之间迁移核心用户数据。
3. 备份必须包含 智码 GLM Code 的核心状态：登录态、Agent、会话历史、定时任务、自定义模型、IM 配置、技能、插件/MCP 状态和 OpenClaw state。
4. 导入必须采用整体替换语义，并在替换前生成目标机当前数据的回滚备份。
5. UI 必须在备份/还原期间显示全局 loading，阻止用户继续操作，并提示关闭应用会中断操作。
6. 导入期间应用不能提前退出；必须先完成恢复和验证，再自动重启。
7. 不能把“文件存在”当成成功。必须验证归档中的 SQLite/OpenClaw 数据与恢复后的目标数据一致。

### 1.3 非目标

以下内容不属于本功能第一阶段迁移范围：

- 不迁移用户项目工作目录，例如用户自己选择的 Cowork 工作目录、代码仓库、下载目录。
- 不迁移应用安装目录、Electron/Node/OpenClaw runtime 二进制、`Resources/cfmind` 等随安装包提供的运行时。
- 不迁移 Chromium 缓存、日志、崩溃报告、临时文件。
- 不保证第三方服务的设备绑定登录态一定跨机器可用，例如部分 IM 平台可能要求重新扫码或重新授权。但本地保存的配置和状态文件必须尽量随包迁移。
- 不在备份文件中明文展示 API key 或 token 摘要之外的敏感内容。

## 2. 用户场景

### 场景 1: 从旧 Windows 电脑迁移到新 Windows 电脑

**Given** 旧电脑上有多个 Agent，每个 Agent 下有历史记录，自定义模型配置了 API key，IM 机器人已配置，存在定时任务。
**When** 用户在旧电脑设置页点击“备份数据”，把生成的 `lobsterai-backup-yyyyMMdd-HHmmss.tar.gz` 拷贝到新电脑，并在新电脑设置页点击“导入备份”。
**Then** 新电脑重启后能看到同样的 Agent、历史记录、自定义模型、IM 配置和定时任务。

### 场景 2: 从 macOS 迁移到 Windows

**Given** macOS 上的 智码 GLM Code 已使用一段时间，包含 SQLite 数据、OpenClaw state、技能和插件状态。
**When** 用户在 macOS 备份，在 Windows 上导入。
**Then** SQLite 数据和 OpenClaw state 被还原；路径类配置如果指向 macOS 文件路径，应用应保留原值但提示用户自行调整为 Windows 可用路径。

### 场景 3: 备份时存在正在运行的任务

**Given** OpenClaw 正在执行 Cowork 会话、定时任务或 IM 触发的任务。
**When** 用户点击备份。
**Then** 应用不应生成可能不一致的备份包，应提示用户先停止或等待任务结束；或者进入明确的 quiesce 状态，暂停可写入服务后再备份。

### 场景 4: 导入失败并回滚

**Given** 目标机已有可用数据，用户选择的备份包损坏或恢复过程中写入失败。
**When** 用户执行导入。
**Then** 应用必须恢复到导入前的数据，写入失败结果 marker，并在 UI 上展示失败原因和回滚备份位置。

## 3. 功能需求

### FR-1: 备份入口

设置页 `Agent 引擎 -> OpenClaw 维护` 提供“备份数据”按钮。点击后弹出保存文件对话框，默认文件名为：

```text
lobsterai-backup-yyyyMMdd-HHmmss.tar.gz
```

备份期间显示全局 loading，文案说明正在备份 智码 GLM Code 数据，关闭应用会中断备份。备份成功后展示备份路径、文件大小，并提供“在文件夹中显示”。

### FR-2: 导入入口

同一位置提供“导入备份”按钮。点击后弹出选择归档对话框，支持 `.tar.gz`、`.tgz`。导入前必须弹出确认弹窗，说明：

- 当前 智码 GLM Code 数据会被备份包整体替换。
- 应用会先自动生成回滚备份。
- 导入期间不要关闭应用。
- 成功后应用会自动重启。

导入期间显示全局 loading，应用不提前退出。

### FR-3: IPC 接口

新增集中 IPC 常量和类型，禁止使用裸字符串。

```typescript
export const DataMigrationIpc = {
  Backup: 'openclaw:dataMigration:backup',
  Restore: 'openclaw:dataMigration:restore',
  GetLastRestoreResult: 'openclaw:dataMigration:getLastRestoreResult',
} as const;
```

预期 preload 暴露：

```typescript
window.electron.openclaw.dataMigration.backup(): Promise<BackupResult>;
window.electron.openclaw.dataMigration.restore(): Promise<RestoreResult>;
window.electron.openclaw.dataMigration.getLastRestoreResult(): Promise<LastRestoreResult>;
```

返回值必须包含 `success`、`canceled`、`path`、`sizeBytes`、`scheduledRestart`、`rollbackPath`、`error` 等必要字段。

### FR-4: 备份包必须自描述

新备份包必须包含 manifest 文件：

```text
智码 GLM Code/.lobsterai-migration.json
```

manifest 不保存敏感明文，但必须包含足够信息来判断备份是否完整，以及恢复后是否匹配。

### FR-5: 成功必须可验证

备份成功至少满足：

- staged `lobsterai.sqlite` 来自 SQLite backup API 快照，而不是 live 文件直接复制。
- staged SQLite 通过 `PRAGMA quick_check`。
- manifest 中记录的 SQLite 表、关键表行数、关键内容校验和来自 staged 数据。
- staged OpenClaw state 与备份时可迁移 live state 摘要一致。
- 归档创建成功并且归档内能识别出同样的根目录和 manifest。

还原成功至少满足：

- 恢复后的目标 `lobsterai.sqlite` 与归档源 SQLite 的内容摘要一致。
- 恢复后的目标 OpenClaw state 与归档源 OpenClaw state 的内容摘要一致。
- 关键表行数和关键配置摘要与 manifest 匹配。
- 结果 marker 写入成功，应用重启后 UI 能展示恢复结果。

## 4. 数据范围

### 4.1 必须迁移的数据

#### SQLite: `lobsterai.sqlite`

SQLite 是 智码 GLM Code 的主要权威数据源，必须通过 SQLite backup API 生成一致快照后迁移。至少包括：

| 数据类型 | 代表内容 |
|----------|----------|
| 登录态 | `auth_tokens` 等 kv 数据 |
| 应用配置 | 主题、语言、Agent 引擎、自定义模型、模型 API key |
| Cowork 数据 | Agent 列表、会话列表、消息历史、权限记录 |
| 定时任务元数据 | `scheduled_task_meta` 及相关绑定信息 |
| IM 配置 | IM 机器人配置、会话绑定、同步游标、平台状态 |
| MCP/插件 | 插件启用状态、安装状态、用户配置 |
| 记忆/技能配置 | 与 SQLite 相关的启用状态和配置 |

注意：manifest 中只能保存 API key/token 的存在性、长度或哈希摘要，不能保存明文。

#### OpenClaw state

OpenClaw state 是 Agent 引擎运行态的重要来源，至少包括：

| 路径 | 说明 |
|------|------|
| `openclaw/state/openclaw.json` | OpenClaw 全局配置、Agent 引擎状态 |
| `openclaw/state/cron/` | 定时任务定义、运行记录、调度状态 |
| `openclaw/state/agents/` | Agent 相关 state、会话映射、运行痕迹 |
| `openclaw/state/memory/` 或同类路径 | OpenClaw 维护的记忆文件 |
| `openclaw/state/plugins/` 或同类路径 | 插件状态、MCP 状态、授权信息 |

实际路径以当前 OpenClaw runtime 写入为准，不能只备份 `openclaw.json`。实现必须按“可迁移 state 根目录”递归备份，并通过排除列表剔除缓存和临时产物。

#### 用户可安装资源

| 路径 | 说明 |
|------|------|
| `SKILLs/` | 用户安装或修改的技能 |
| `third-party-extensions/` | 用户安装的第三方扩展 |

Electron/Chromium profile 数据不作为迁移主数据集。智码 GLM Code 登录态、模型配置、API key、IM 配置、Agent 和任务历史必须以 SQLite/OpenClaw state 为准；`Dictionaries/`、`Local Storage/`、`Session Storage/`、`Local State`、`Preferences`、`Shared Dictionary/`、`SharedStorage*` 这类 profile 文件在 Windows 上可能被 Chromium/LevelDB 持有锁，恢复时应保留目标机现有文件并跳过归档中的同名条目，不能因为它们删除失败而回滚核心数据恢复。

### 4.2 默认排除的数据

以下内容不进入迁移包：

| 路径/模式 | 原因 |
|-----------|------|
| `Cache/`、`Code Cache/`、`GPUCache/`、`Dawn*Cache/` | Chromium 可重建缓存 |
| `Service Worker/`、`blob_storage/` | 易变缓存，跨机器价值低 |
| `Crashpad/`、`logs/`、`openclaw/logs/`、`openclaw/state/logs/`、`install-timing.log`、`skill-migrate.log` | 诊断和运行日志，不属于用户状态 |
| `Dictionaries/`、`Local Storage/`、`Session Storage/`、`Local State`、`Preferences`、`Shared Dictionary/`、`SharedStorage*` | Chromium profile/LevelDB 运行态文件，Windows 上容易被锁；核心用户数据必须来自 SQLite/OpenClaw state |
| `lockfile`、`Singleton*`、`.com.github.Electron.*` | Electron 运行时锁和临时标记 |
| `Cookies*`、`DIPS*`、`Network/Cookies*` | Windows 上经常被 Chromium 锁定，且 智码 GLM Code 登录态应以 SQLite token 为准 |
| `backups/`、`sqlite-backups/` | 自动备份目录会造成包膨胀和旧数据混淆 |
| `runtimes/` | 目标机安装包负责提供 runtime |
| `openclaw/mcp-packages/`、`.compile-cache/`、`bin/` | OpenClaw/MCP 可重建或平台相关的运行时产物 |
| 用户工作目录、代码仓库 | 不属于 Electron `userData` |

`openclaw/mcp-packages/` 不是 MCP 用户配置，而是 MCP launch resolver 为 `npx` 类 MCP server 下载和安装的 npm package 目录，内部通常是 `node_modules`、bin 脚本和可能的平台相关 native 依赖。MCP server 的用户配置存储在 SQLite 的 `mcp_servers` 表中，必须随 SQLite 迁移。由于 `mcp_launch_resolutions` 表会缓存 `install_dir`、`command`、`args` 等本机绝对路径，恢复后必须把这些解析缓存失效化，让目标机重新安装和解析 MCP package。

默认排除的数据在恢复时也不作为目标删除对象：目标机已有的 `backups/`、`cowork/`、`runtimes/`、`openclaw/mcp-packages/`、日志和 Chromium profile 运行态应保留；如果旧备份包中包含这些路径，导入时必须跳过，不得覆盖目标机内容，也不得因为它们被 Windows 锁定而回滚核心数据恢复。

如果后续发现某类登录态只能从 Chromium `Network` 目录恢复，应作为独立需求处理，不能在当前主流程中直接复制 locked profile 文件。

## 5. 归档格式

### 5.1 新格式目录结构

```text
lobsterai-backup-20260609-103000.tar.gz
└── 智码 GLM Code/
    ├── .lobsterai-migration.json
    ├── lobsterai.sqlite
    ├── SKILLs/
    ├── third-party-extensions/
    └── openclaw/
        └── state/
```

归档中不应包含 live `lobsterai.sqlite-wal` 和 `lobsterai.sqlite-shm`。如果导入预检发现归档中包含 SQLite sidecar 文件，必须先在 staging 中 checkpoint/合并后再恢复主库。

### 5.2 manifest 字段

manifest 建议结构如下：

```json
{
  "format": "lobsterai-data-migration",
  "version": 1,
  "createdAt": "2026-06-09T10:30:00.000Z",
  "source": {
    "platform": "win32",
    "arch": "x64",
    "appVersion": "x.y.z",
    "electronVersion": "x.y.z",
    "openclawVersion": "x.y.z"
  },
  "archive": {
    "root": "智码 GLM Code",
    "excluded": ["Cache", "Code Cache", "GPUCache", "logs", "openclaw/logs", "openclaw/state/logs"]
  },
  "sqlite": {
    "exists": true,
    "sizeBytes": 250000,
    "sha256": "<file hash>",
    "quickCheck": "ok",
    "tableNames": ["kv", "cowork_sessions"],
    "rowCounts": {
      "kv": 20,
      "cowork_sessions": 8,
      "cowork_messages": 120
    },
    "tableContentChecksums": {
      "cowork_sessions": "<hash>",
      "cowork_messages": "<hash>"
    },
    "kvKeys": ["auth_tokens", "app_config"],
    "kvValueChecksums": {
      "auth_tokens": "<hash>",
      "app_config": "<hash>"
    },
    "appConfig": {
      "checksumSha256": "<hash>",
      "customProviderCount": 2,
      "primaryApiKeyPresent": true,
      "customProviderApiKeyPresence": {
        "provider-a": true
      }
    },
    "im": {
      "configKeys": ["wechat", "feishu"],
      "configValueChecksums": {
        "wechat": "<hash>"
      }
    },
    "scheduledTasks": {
      "metaIds": ["task-1"],
      "metaCount": 1
    },
    "agents": {
      "agentIds": ["main", "agent-2"],
      "sessionCountsByAgentId": {
        "main": 5,
        "agent-2": 3
      }
    }
  },
  "openclawState": {
    "exists": true,
    "fileCount": 100,
    "totalSizeBytes": 1000000,
    "sha256": "<tree hash>",
    "cronFileCount": 10,
    "cronRunFileCount": 5,
    "agentSessionFileCount": 20,
    "openclawConfigExists": true,
    "sampledRelativePaths": [
      "state/openclaw.json",
      "state/cron/tasks.json"
    ]
  }
}
```

manifest 的用途是诊断和验收，不是数据库。恢复时仍以归档中的实际文件为准，但如果实际文件摘要与 manifest 不一致，必须拒绝恢复。

## 6. 备份流程

### 6.1 UI 阶段

1. 用户点击“备份数据”。
2. 弹出保存文件对话框。
3. 用户确认后进入全局 loading。
4. loading 期间禁用设置、Cowork、IM、定时任务等会触发写入的操作。
5. 如果用户尝试关闭窗口，提示“备份正在进行，关闭应用会中断备份”。

### 6.2 运行态停写检查

备份前必须检查是否存在高风险写入：

- 正在运行的 Cowork 会话。
- 正在执行的 OpenClaw gateway 任务。
- 正在执行的定时任务。
- 正在进行的 IM 消息同步写入。
- SQLite migration 或自动备份正在运行。

第一阶段建议采用保守策略：发现正在运行的任务就阻止备份，提示用户停止或等待任务结束。不要为了备份而直接关闭 gateway，因为这会让 UI 看起来像卡死，也可能打断用户任务。

如果未来需要无感备份，应增加统一 quiesce 接口，由各服务短暂暂停新写入并确认 flush 完成。

### 6.3 SQLite 快照

1. 调用 `SqliteBackupManager.createBackup({ trigger: Manual })` 创建一致快照。
2. 对快照执行 `PRAGMA quick_check`。
3. 读取快照中的关键表、行数、内容摘要、关键 kv 摘要。
4. 同时读取 live SQLite 的相同摘要。
5. 如果 live 摘要与快照摘要不一致，说明快照过程中发生写入或快照不完整，备份失败并提示重试。

staging 目录中的 `lobsterai.sqlite` 必须来自该快照，不能来自 live userData 的直接复制。

### 6.4 文件 staging

1. 创建临时 staging 目录。
2. 按“必须迁移的数据”和“默认排除的数据”递归复制 `userData`。
3. 不复制 live `lobsterai.sqlite`、`lobsterai.sqlite-wal`、`lobsterai.sqlite-shm`。
4. 将 SQLite 快照复制为 `stage/智码 GLM Code/lobsterai.sqlite`。
5. 对 staged SQLite 再次执行 `PRAGMA quick_check`。

### 6.5 OpenClaw state 一致性检查

复制完成后，对可迁移 OpenClaw state 计算摘要：

- live included state 摘要。
- staged included state 摘要。

如果两者不一致，说明 OpenClaw state 在复制过程中发生变化，备份失败并删除半成品。此时不能输出“成功但可能不完整”的备份包。

### 6.6 写入 manifest 和归档

1. 基于 staged 数据生成 `.lobsterai-migration.json`。
2. 使用 `tar` 依赖创建 `.tar.gz`。
3. 创建完成后重新读取归档做快速 inspection，确认能识别根目录和 manifest。
4. 返回成功结果，包括路径和大小。

## 7. 还原流程

### 7.1 UI 阶段

1. 用户点击“导入备份”。
2. 用户选择归档。
3. 应用先在非破坏阶段 inspection 归档。
4. 显示确认弹窗，包含备份来源平台、创建时间和关键数据摘要。
5. 用户确认后进入全局 loading。
6. loading 期间禁止用户操作和关闭窗口。
7. 恢复成功后应用自动重启。

应用不能在完成恢复前退出。早退会产生一个危险窗口：用户可能手动启动应用，导致新进程抢占 SQLite 或开始写入，最终恢复失败。

### 7.2 归档预检

破坏性操作前必须完成以下检查：

1. 识别根目录：只接受 `智码 GLM Code/`。
2. 拒绝绝对路径、`..`、空路径、目标根外写入。
3. 拒绝 symlink、hardlink、device file 等特殊 entry。
4. 如果存在 manifest，校验 manifest 与归档内容一致。
5. 如果不存在 manifest，拒绝导入。
6. staging 提取后必须找到 `lobsterai.sqlite`。
7. 对 staging SQLite 执行 `PRAGMA quick_check`。
8. 如果 staging 中存在 `lobsterai.sqlite-wal`，先打开 staging 数据库执行 checkpoint，合并 WAL，再删除 sidecar。

任何一步失败，都必须在删除目标数据前返回错误。

### 7.3 应用 quiesce

用户确认导入后，主进程进入恢复模式：

1. renderer 显示全局 loading。
2. 停止接受新的 Cowork、IM、定时任务和设置写入请求。
3. 释放原业务 BrowserWindow/renderer 进程持有的业务句柄；主进程必须继续运行并保持单实例锁，不能在恢复完成前退出。
4. 立即打开一个不使用 智码 GLM Code `userData` 的专用恢复进度窗口，使用非持久化 session/partition，只展示 loading 和安全提示。
5. 停止或暂停 OpenClaw gateway、定时任务服务、IM gateway。
6. flush 并关闭 SQLite store。
7. 停止日志之外的所有可写入 userData 的服务。

如果当前进程无法可靠关闭 SQLite 或 gateway，应退回“pending restore at startup”模式，但必须由当前进程显示等待页并负责 relaunch，不能让用户在中间手动启动。

### 7.4 生成回滚备份

恢复前必须把目标机当前可迁移数据打成回滚包：

```text
lobsterai-rollback-yyyyMMdd-HHmmss.tar.gz
```

回滚包可以使用同一套备份排除列表，但它的目的是恢复目标机现状，不是给用户跨机器迁移。因此可以保留更多本机状态摘要，便于失败后回滚。

如果回滚包创建失败，默认不继续恢复，除非用户在高级确认中明确选择无回滚继续。

### 7.5 替换数据

恢复采用整体替换语义，但不是简单 `rename userData`，因为 Windows 上 `userData` 目录经常被系统、日志或 Chromium 锁定。

建议流程：

1. 删除目标目录内的可迁移数据文件和目录。
2. 保留或跳过备份排除项、运行时锁、日志、不可迁移缓存目录。
3. 从 staging 中复制可迁移数据到目标 userData。
4. SQLite 使用专门流程：
   - 确认 SQLite store 已关闭。
   - 删除目标 `lobsterai.sqlite-wal` 和 `lobsterai.sqlite-shm`。
   - 复制 staging `lobsterai.sqlite` 到目标。
   - 不复制 staging sidecar。
   - 重新打开目标 SQLite 执行 `PRAGMA quick_check`。
5. 对恢复后的 SQLite 执行迁移后修正：
   - 保留 `mcp_servers` 中的 MCP 用户配置。
   - 删除或置为 `pending` 所有指向 `openclaw/mcp-packages/` 的 `mcp_launch_resolutions`，避免目标机继续使用源机器的绝对路径。
6. OpenClaw state 使用目录级复制，复制后计算 tree hash。

### 7.6 恢复后验证

恢复完成后，在重启应用前验证：

- 目标 SQLite 文件 hash 或内容摘要等于 staging SQLite。
- 目标 SQLite 关键表行数和内容摘要与 manifest 或 inspection summary 一致。
- 目标 `app_config` 摘要一致，自定义模型 API key 存在性一致。
- 目标 Agent ID 和每个 Agent 的 session 数与源摘要一致。
- 目标 IM 配置 key 和摘要一致。
- 目标定时任务元数据 ID 与源摘要一致。
- 目标 MCP server 配置存在，且本机 MCP launch resolution 缓存已失效化等待重新解析。
- 目标 OpenClaw state tree hash 与 staging state 一致。

验证失败必须触发回滚，不允许显示“恢复成功”。

### 7.7 结果 marker 和重启

恢复成功后写入一次性结果 marker，例如：

```text
userData/.lobsterai-restore-result.json
```

内容包含：

- success
- source archive path
- rollback archive path
- source platform
- restoredAt
- summary

然后调用 `app.relaunch()` 和 `app.exit(0)`。新进程启动后设置页读取 marker 并展示结果，再删除 marker。

如果失败发生在归档预检阶段，renderer 仍在运行，应保持应用不退出并直接展示错误。若已经释放 renderer 进入破坏性恢复阶段，则失败时必须先写入失败 marker、完成回滚处理，再 relaunch；新进程启动后设置页读取 marker 并展示错误。

## 8. 跨平台兼容性

### 8.1 SQLite

SQLite 数据库本身跨 Windows、macOS、Linux 可读。兼容性风险主要来自：

- 应用版本或数据库 schema 不一致。
- 数据库处于 WAL 未合并状态。
- 表内保存了平台相关路径。

应对策略：

- 备份使用 SQLite backup API。
- 导入时合并 staging WAL，并删除 sidecar。
- 目标应用启动后按现有迁移逻辑升级 schema。
- 对工作目录、项目路径等平台相关字段保留原值，但在 UI 中提示用户按目标系统修正。

### 8.2 OpenClaw state

OpenClaw state 中可能包含平台路径、插件路径、任务工作目录、shell 命令、MCP server 路径等。迁移时应保留原始数据，不能擅自改写。目标机无法访问的路径属于运行时配置问题，不是迁移失败。

后续可增加“迁移后路径修复向导”，但不属于本设计第一阶段。

### 8.3 登录态和凭据

智码 GLM Code 服务登录态应以 SQLite 中的 token 为准，可以跨机器恢复，但 refreshToken 过期时仍需要重新登录。

自定义模型 API key、IM webhook token、MCP token 等本地保存凭据应随 SQLite 或 OpenClaw state 迁移。manifest 只能记录存在性和哈希，不能输出明文。

部分 IM 平台可能存在设备绑定或服务端风控，迁移后需要重新扫码。只要本地配置被还原，即视为迁移功能正确。

### 8.4 Windows 文件锁

Windows 对 SQLite、Chromium profile、日志、目录 rename 更敏感。设计上必须避免：

- 复制 live `Network/Cookies`。
- 复制 live SQLite sidecar。
- 对整个 `userData` 做原子 rename。
- 在恢复完成前退出应用。

恢复必须关闭写入服务后按文件级替换，并带重试和回滚。

### 8.5 macOS

macOS 同机重装通常不会删除 `~/Library/Application Support/智码 GLM Code`，但跨机器迁移仍需本功能。macOS 也存在 WAL-only 数据丢失风险，所以必须使用同样的 SQLite 快照和 checkpoint 验证流程，不能因为 macOS 文件锁较少就直接复制 live 数据库。

## 9. 失败模型

| 场景 | 处理方式 |
|------|----------|
| 用户取消保存或选择文件 | 返回 `canceled: true`，不产生副作用 |
| 备份时存在运行中任务 | 阻止备份，提示停止或等待任务结束 |
| SQLite 快照与 live 摘要不一致 | 备份失败，不生成归档 |
| staged OpenClaw state 与 live 摘要不一致 | 备份失败，不生成归档 |
| 归档路径穿越 | 预检失败，拒绝导入 |
| 归档缺少 `lobsterai.sqlite` | 预检失败，拒绝导入 |
| staging SQLite `quick_check` 失败 | 预检失败，拒绝导入 |
| 回滚备份失败 | 默认停止恢复 |
| 替换目标数据失败 | 尝试回滚，显示错误 |
| 恢复后验证不一致 | 尝试回滚，显示错误，不允许成功 |

## 10. 涉及文件

预期涉及以下文件和模块：

| 文件/模块 | 作用 |
|-----------|------|
| `src/main/libs/dataMigration/dataMigrationService.ts` | 主进程备份、预检、恢复、回滚、验证服务 |
| `src/main/libs/dataMigration/dataMigrationService.test.ts` | 迁移服务单元测试 |
| `src/main/libs/sqliteBackupManager.ts` | 生成一致 SQLite 快照 |
| `src/main/sqliteStore.ts` | 提供关闭、重开、quick_check 和摘要读取能力 |
| `src/main/libs/openclawEngineManager.ts` | OpenClaw gateway 停止、恢复、状态检查 |
| `src/scheduledTask/` | 定时任务运行态检查和暂停 |
| `src/main/im/` | IM gateway 暂停和恢复 |
| `src/main/main.ts` | IPC handler 注册、应用重启流程 |
| `src/main/preload.ts` | 暴露 `window.electron.openclaw.dataMigration` |
| `src/shared` 或相关 constants 文件 | IPC 常量和类型 |
| `src/renderer/components/Settings.tsx` | 设置页 UI |
| `src/renderer/services/i18n.ts` | renderer 文案 |
| `src/main/i18n.ts` | main 进程文案 |

## 11. 测试计划

### 11.1 单元测试

迁移服务测试必须覆盖：

1. 备份排除缓存、日志、`backups/`、`runtimes/`、SQLite sidecar。
2. 备份使用 SQLite 快照替换 staged live DB。
3. manifest 包含 SQLite 表、关键行数、关键内容摘要和 OpenClaw state 摘要。
4. 自定义模型 API key 只在 manifest 中显示存在性或哈希，不泄露明文。
5. 多 Agent、多会话摘要能被生成和恢复后验证。
6. IM 配置摘要能被生成和恢复后验证。
7. 定时任务元数据和 OpenClaw cron state 能被生成和恢复后验证。
8. 恶意路径、绝对路径、`..`、symlink 被拒绝。
9. 恢复前会生成 rollback。
10. 恢复失败不会误删目标数据。
11. 成功恢复后写入 result marker。
12. staging SQLite 有 WAL 时会 checkpoint，目标只保留主库。

### 11.2 集成/手动验证

至少准备一份源机器数据，包含：

- 两个以上 Agent。
- 每个 Agent 至少一条历史会话。
- 主 Agent 也有历史会话。
- 自定义模型，且至少一个 provider 配置了 API key。
- 至少一个 IM 机器人配置。
- 至少一个定时任务。
- 至少一个已安装技能。
- 至少一个 MCP 或插件状态。

验证矩阵：

| 源平台 | 目标平台 | 必测内容 |
|--------|----------|----------|
| Windows | Windows | 文件锁、SQLite、Agent、IM、定时任务 |
| Windows | macOS | SQLite 跨平台、路径保留 |
| macOS | Windows | OpenClaw state、路径保留、Windows 锁规避 |
| macOS | macOS | 常规导入导出 |

每次恢复后检查：

- 登录态是否保留或 refreshToken 过期时给出合理登录状态。
- Agent 数量、名称、配置一致。
- 每个 Agent 的历史记录数量一致。
- 自定义模型配置和 API key 可用。
- IM 配置存在。
- 定时任务列表不为空且与源机器一致。
- SKILLs 和 third-party extensions 存在。
- OpenClaw gateway 能正常启动。

### 11.3 构建验证

实现完成后至少运行：

```bash
npm test -- dataMigrationService
npm run build
```

如修改 UI，还需手动运行：

```bash
npm run electron:dev
```

并在设置页验证备份、取消备份、导入确认取消、导入成功自动重启、导入失败回滚。

## 12. 验收标准

1. 备份包中必须存在 `智码 GLM Code/lobsterai.sqlite` 和 `智码 GLM Code/.lobsterai-migration.json`。
2. 新格式备份包不得包含 `lobsterai.sqlite-wal`、`lobsterai.sqlite-shm`、`backups/`、`sqlite-backups/`、`runtimes/`、Chromium cache、日志和 lock 文件。
3. 备份包 manifest 中的 SQLite 摘要能证明自定义模型、Agent、会话、IM、定时任务数据存在。
4. 导入前如果归档缺少 SQLite，必须失败，不能继续恢复。
5. 导入前如果归档路径不安全，必须失败，不能写入目标目录。
6. 导入会自动生成 rollback 归档。
7. 导入期间应用保持打开并显示全局 loading，恢复完成后才重启。
8. 恢复后目标 SQLite 摘要与备份源一致，否则回滚并报错。
9. 恢复后目标 OpenClaw state 摘要与备份源一致，否则回滚并报错。
10. 从一台包含多个 Agent 和历史记录的机器迁移后，目标机必须显示相同 Agent 和历史记录。
11. 自定义模型 API key 在目标机可用。
12. IM 配置在目标机存在。
13. 定时任务列表在目标机存在。

## 13. 后续实现顺序

建议按以下顺序重新实现，避免再次出现“看似成功但数据没迁移”的问题：

1. 先实现归档 inspection、SQLite 摘要、OpenClaw state 摘要和 manifest。
2. 再实现备份流程，确保生成的包能被 inspection 证明完整。
3. 再实现非破坏性 restore preflight，先不写目标 userData。
4. 再实现 rollback 和目标替换。
5. 最后实现 UI loading、确认弹窗、结果提示和 i18n。

任何阶段都不应跳过验证。只要 SQLite 或 OpenClaw state 摘要不一致，就必须失败，而不是继续显示成功。
