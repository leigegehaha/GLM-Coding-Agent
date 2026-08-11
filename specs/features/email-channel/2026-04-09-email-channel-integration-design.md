# Email Channel Integration Design

**Date:** 2026-04-09
**Status:** Approved
**Author:** CodeMaker (Claude)

## Overview

This design integrates the `claw-mail-channel` email plugin (`@clawemail/email` v0.9.0) into 智码 GLM Code using the existing multi-instance IM channel architecture. The integration enables users to manage email conversations through the 智码 GLM Code UI with support for both traditional IMAP/SMTP and secure WebSocket transport modes.

## Background

The email channel plugin (`/home/gzlicanyi/work/git/claw-mail-channel`) is a fully-featured OpenClaw extension that supports:

- **Three transport modes:** IMAP/SMTP (traditional), WebSocket (apiKey-based), and IM CLI (mail-cli profile)
- **Real-time email monitoring** via IMAP IDLE or WebSocket push
- **Thread tracking** using standard email headers
- **Multi-account support** with independent configuration per account
- **Advanced features:** whitelist filtering, reply modes, Agent-to-Agent collaboration

### Integration Scope

Based on user requirements, the integration will:

1. ✅ Support **IMAP/SMTP** and **WebSocket** transport modes (IM CLI mode excluded for simplicity)
2. ✅ Use **multi-instance architecture** (like Feishu/QQ) for managing multiple email accounts
3. ✅ Implement **account-level agent binding** (each email account can route to a different agent)
4. ✅ Provide **tiered configuration UI** (basic config + advanced options collapse panel)
5. ✅ Include **browser-based API Key acquisition** flow for WebSocket mode

## Design Approach

### Selected Approach: Full Alignment with Existing IM Pattern (Approach A)

**Rationale:**

- Minimizes code changes by reusing the proven multi-instance infrastructure
- Provides consistent UX across all IM channels (lower learning curve)
- Automatically benefits from future IM system improvements
- Email channel config structure already aligns with OpenClaw standards

**Trade-offs:**

- Must conform to existing multi-instance constraints
- Slight configuration redundancy (stored in both SQLite and openclaw.json)

**Alternatives Considered:**

- **Approach B (Independent config table):** Higher flexibility but larger code footprint and maintenance cost
- **Approach C (Hybrid mode):** Balanced but added complexity in type system and sync logic

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          智码 GLM Code UI                                │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │              EmailSettings.tsx (Renderer)                       │ │
│  │  • Multi-instance list (add/delete/select)                     │ │
│  │  • Instance detail form (basic + advanced)                     │ │
│  │  • "Get API Key" button → opens browser                        │ │
│  │  • Real-time status indicators                                 │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                               ↕ IPC                                  │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │              Main Process (Electron)                            │ │
│  │  ┌──────────────────────────────────────────────────────────┐  │ │
│  │  │ IMStore (SQLite)                                          │  │ │
│  │  │  • im_config table: email key → JSON config              │  │ │
│  │  │  • getEmailConfig() / setEmailConfig()                   │  │ │
│  │  └──────────────────────────────────────────────────────────┘  │ │
│  │                         ↓                                        │ │
│  │  ┌──────────────────────────────────────────────────────────┐  │ │
│  │  │ OpenClawConfigSync                                        │  │ │
│  │  │  • Read email config from SQLite                          │  │ │
│  │  │  • Generate openclaw.json channels.email config           │  │ │
│  │  │  • Write environment variables (passwords/apiKeys)        │  │ │
│  │  └──────────────────────────────────────────────────────────┘  │ │
│  │                         ↓                                        │ │
│  │  ┌──────────────────────────────────────────────────────────┐  │ │
│  │  │ OpenClawEngineManager                                     │  │ │
│  │  │  • restartGateway() → loads new config                    │  │ │
│  │  │  • getEmailChannelStatus() → query runtime state          │  │ │
│  │  └──────────────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                               ↕ WebSocket
┌─────────────────────────────────────────────────────────────────────┐
│                      OpenClaw Gateway                                │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  Email Channel Plugin (@clawemail/email)                       │ │
│  │  • Loads channels.email.accounts from openclaw.json           │ │
│  │  • Per-account: startAccount() → IMAP monitor or WS client    │ │
│  │  • Session format: agent:{agentId}:email:{accountId}:{thread} │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                               ↕
┌─────────────────────────────────────────────────────────────────────┐
│  Email Servers (IMAP/SMTP) or WebSocket Gateway                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Flow

**Configuration Save Flow:**

1. User modifies email config in UI → clicks Save
2. Renderer validates config (email format, required fields, duplicates)
3. IPC call `im:setConfig` with full `IMGatewayConfig` (including email)
4. Main process writes to SQLite `im_config` table
5. `syncOpenClawConfig()` generates `openclaw.json` with `channels.email`
6. `writeEnvFile()` writes `LOBSTER_EMAIL_*_PASSWORD` / `LOBSTER_EMAIL_*_APIKEY`
7. `restartGateway()` reloads OpenClaw with new config
8. Email channel plugin starts monitoring accounts

**Session Discovery Flow:**

1. OpenClaw email plugin receives inbound email
2. Builds sessionKey: `agent:{agentId}:email:{accountId}:{threadId}`
3. Gateway emits chat event with sessionKey
4. `OpenClawChannelSessionSync.parseChannelSessionKey()` extracts platform + conversationId
5. `resolveOrCreateSession()` creates local Cowork session with:
   - Title: `邮件:{threadId}` or `Email:{threadId}`
   - AgentId: read from `emailConfig.instances[accountId].agentId`
6. Session appears in 智码 GLM Code sidebar
7. Streaming chat events update message content in real-time

**Status Monitoring Flow:**

1. Renderer polls `im:getStatus` every 5 seconds
2. Main process calls `openclawEngineManager.getEmailChannelStatus()`
3. Gateway RPC `channel.status` returns per-account connection state
4. Parsed into `EmailMultiInstanceStatus` → returned to renderer
5. UI updates connection indicators (green dot = connected)

## Data Model

### TypeScript Types

```typescript
// src/main/im/types.ts

export interface EmailInstanceConfig {
  instanceId: string; // "email-1", "email-2", etc.
  instanceName: string; // Display name: "Work Email"
  enabled: boolean; // Enable/disable this account

  // Transport mode
  transport: 'imap' | 'ws'; // IMAP/SMTP or WebSocket

  // Account credentials
  email: string; // user@example.com
  password?: string; // Required if transport=imap
  apiKey?: string; // Required if transport=ws (format: ck_*)

  // Agent binding
  agentId: string; // Agent ID (default: "main")

  // IMAP/SMTP servers (optional, auto-detected if empty)
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;

  // Security & policy
  allowFrom?: string[]; // Whitelist: ["user@example.com", "*.trusted.com"]

  // Advanced options
  replyMode?: 'immediate' | 'accumulated' | 'complete';
  replyTo?: 'sender' | 'all';

  // Agent-to-Agent collaboration
  a2aEnabled?: boolean;
  a2aAgentDomains?: string[];
  a2aMaxPingPongTurns?: number;
}

export interface EmailMultiInstanceConfig {
  instances: EmailInstanceConfig[];
}

export interface EmailInstanceStatus {
  instanceId: string;
  instanceName: string;
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  email: string | null;
  transport: 'imap' | 'ws' | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

export interface EmailMultiInstanceStatus {
  instances: EmailInstanceStatus[];
}

// Default configurations
export const DEFAULT_EMAIL_INSTANCE_CONFIG: Partial<EmailInstanceConfig> = {
  enabled: true,
  transport: 'imap',
  agentId: 'main',
  replyMode: 'complete',
  replyTo: 'sender',
  a2aEnabled: false,
  a2aMaxPingPongTurns: 20,
};

export const DEFAULT_EMAIL_MULTI_INSTANCE_CONFIG: EmailMultiInstanceConfig = {
  instances: [],
};

export const MAX_EMAIL_INSTANCES = 5;
```

### Database Schema

Reuses existing `im_config` table:

```sql
-- Existing table structure
CREATE TABLE IF NOT EXISTS im_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Email config stored as JSON
-- key = 'email'
-- value = JSON.stringify(EmailMultiInstanceConfig)
```

### OpenClaw Configuration Format

`openclaw.json` structure after sync:

```json
{
  "channels": {
    "email": {
      "enabled": true,
      "accounts": {
        "email-1": {
          "enabled": true,
          "name": "Work Email",
          "email": "work@example.com",
          "transport": "imap",
          "password": "${LOBSTER_EMAIL_EMAIL_1_PASSWORD}",
          "allowFrom": ["boss@example.com", "*.company.com"],
          "replyMode": "complete",
          "replyTo": "sender"
        },
        "email-2": {
          "enabled": true,
          "name": "Personal Gmail",
          "email": "personal@gmail.com",
          "transport": "ws",
          "apiKey": "${LOBSTER_EMAIL_EMAIL_2_APIKEY}",
          "a2a": {
            "enabled": true,
            "agentDomains": ["agents.example.com"],
            "maxPingPongTurns": 20
          }
        }
      }
    }
  }
}
```

Environment variables (`.env`):

```bash
LOBSTER_EMAIL_EMAIL_1_PASSWORD=my_imap_password
LOBSTER_EMAIL_EMAIL_2_APIKEY=ck_live_abc123xyz789
```

## Component Details

### 1. Type System Extensions

**Files to modify:**

- `src/main/im/types.ts` - Add `EmailInstanceConfig`, `EmailMultiInstanceConfig`, `EmailInstanceStatus`, `EmailMultiInstanceStatus`, `DEFAULT_EMAIL_*` constants
- `src/shared/platform.ts` - Add `'email'` to `Platform` union type
- `src/main/im/types.ts` - Update `IMGatewayConfig` to include `email: EmailMultiInstanceConfig`
- `src/main/im/types.ts` - Update `IMGatewayStatus` to include `email: EmailMultiInstanceStatus`

**Estimated lines:** ~150

### 2. Configuration Storage

**File:** `src/main/im/imStore.ts`

Add methods:

```typescript
getEmailConfig(): EmailMultiInstanceConfig {
  const raw = this.db
    .prepare('SELECT value FROM im_config WHERE key = ?')
    .get('email') as { value: string } | undefined;

  if (!raw?.value) {
    return DEFAULT_EMAIL_MULTI_INSTANCE_CONFIG;
  }

  const parsed = JSON.parse(raw.value);
  return {
    instances: (parsed.instances || []).map((inst: any) => ({
      ...DEFAULT_EMAIL_INSTANCE_CONFIG,
      ...inst,
    })),
  };
}

setEmailConfig(config: EmailMultiInstanceConfig): void {
  this.db
    .prepare('INSERT OR REPLACE INTO im_config (key, value) VALUES (?, ?)')
    .run('email', JSON.stringify(config));
}
```

**Estimated lines:** ~50

### 3. OpenClaw Configuration Sync

**File:** `src/main/libs/openclawConfigSync.ts`

In `syncOpenClawConfig()` method, add email channel sync block:

```typescript
// Sync Email OpenClaw channel config (multi-instance)
const emailConfig = this.getEmailOpenClawConfig?.();
if (emailConfig?.instances && emailConfig.instances.length > 0) {
  const enabledInstances = emailConfig.instances.filter(i => i.enabled && i.email);

  if (enabledInstances.length > 0) {
    const accounts: Record<string, unknown> = {};

    for (const inst of enabledInstances) {
      const accountId = inst.instanceId;
      const envPrefix = accountId.toUpperCase().replace(/-/g, '_');

      const accountConfig: Record<string, unknown> = {
        enabled: true,
        name: inst.instanceName,
        email: inst.email,
        transport: inst.transport,
      };

      if (inst.transport === 'imap') {
        accountConfig.password = `\${LOBSTER_EMAIL_${envPrefix}_PASSWORD}`;
        if (inst.imapHost) accountConfig.imapHost = inst.imapHost;
        if (inst.imapPort) accountConfig.imapPort = inst.imapPort;
        if (inst.smtpHost) accountConfig.smtpHost = inst.smtpHost;
        if (inst.smtpPort) accountConfig.smtpPort = inst.smtpPort;
      }

      if (inst.transport === 'ws') {
        accountConfig.apiKey = `\${LOBSTER_EMAIL_${envPrefix}_APIKEY}`;
      }

      if (inst.allowFrom?.length) {
        accountConfig.allowFrom = inst.allowFrom;
      }
      if (inst.replyMode) accountConfig.replyMode = inst.replyMode;
      if (inst.replyTo) accountConfig.replyTo = inst.replyTo;

      if (inst.a2aEnabled || inst.a2aAgentDomains?.length || inst.a2aMaxPingPongTurns) {
        accountConfig.a2a = {
          enabled: inst.a2aEnabled ?? true,
          ...(inst.a2aAgentDomains?.length ? { agentDomains: inst.a2aAgentDomains } : {}),
          ...(inst.a2aMaxPingPongTurns ? { maxPingPongTurns: inst.a2aMaxPingPongTurns } : {}),
        };
      }

      accounts[accountId] = accountConfig;
    }

    managedConfig.channels = {
      ...((managedConfig.channels as Record<string, unknown>) || {}),
      email: { enabled: true, accounts },
    };
  }
}
```

In `writeEnvFile()` method, add:

```typescript
// Email credentials
const emailConfig = this.getEmailOpenClawConfig?.();
if (emailConfig?.instances) {
  for (const inst of emailConfig.instances) {
    if (!inst.enabled || !inst.email) continue;
    const envPrefix = `LOBSTER_EMAIL_${inst.instanceId.toUpperCase().replace(/-/g, '_')}`;
    if (inst.transport === 'imap' && inst.password) {
      lines.push(`${envPrefix}_PASSWORD=${inst.password}`);
    }
    if (inst.transport === 'ws' && inst.apiKey) {
      lines.push(`${envPrefix}_APIKEY=${inst.apiKey}`);
    }
  }
}
```

**Estimated lines:** ~80

### 4. Session Mapping

**File:** `src/shared/platform.ts`

Add email platform mapping:

```typescript
static platformOfChannel(channelName: string): Platform | null {
  const mapping: Record<string, Platform> = {
    // ... existing mappings
    'email': 'email',
    'clawemail': 'email',
    'clawemail-email': 'email',
  };
  return mapping[channelName] || null;
}

static channelOf(platform: Platform): string | null {
  const reverseMapping: Record<Platform, string> = {
    // ... existing mappings
    email: 'email',
  };
  return reverseMapping[platform] || null;
}
```

**Estimated lines:** ~10

**File:** `src/main/libs/openclawChannelSessionSync.ts`

Update `getTitlePrefix()` to include email:

```typescript
const prefixByPlatform: Record<Platform, string> = {
  // ... existing prefixes
  email: t('channelPrefixEmail'),
};
```

Update `resolveOrCreateSession()` to handle account-level agent binding:

```typescript
// Extract agentId from email account config
let agentId = 'main';
if (platform === 'email') {
  const parts = sessionKey.split(':');
  if (parts.length >= 5 && parts[2] === 'email') {
    const accountId = parts[3];
    const emailConfig = this.imStore.getEmailConfig();
    const instance = emailConfig.instances.find(i => i.instanceId === accountId);
    if (instance?.agentId) {
      agentId = instance.agentId;
    }
  }
}
```

**Estimated lines:** ~30

### 5. UI Component

**File:** `src/renderer/components/settings/EmailSettings.tsx` (NEW)

Component structure:

```typescript
export const EmailSettings: React.FC = () => {
  // State management
  const [emailConfig, setEmailConfig] = useState<EmailMultiInstanceConfig>();
  const [emailStatus, setEmailStatus] = useState<EmailMultiInstanceStatus>();
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Load config and status
  useEffect(() => { loadConfig(); }, []);
  useEffect(() => {
    loadStatus();
    const timer = setInterval(loadStatus, 5000);
    return () => clearInterval(timer);
  }, []);

  // Handlers
  const handleAddInstance = () => { /* ... */ };
  const handleDeleteInstance = (id: string) => { /* ... */ };
  const handleUpdateInstance = (id: string, updates: Partial<EmailInstanceConfig>) => { /* ... */ };
  const handleSave = async () => { /* validate → IPC call → refresh */ };
  const handleGetApiKey = async (instanceId: string) => { /* open browser */ };
  const handleTestConnection = async (instanceId: string) => { /* test IMAP/WS */ };

  return (
    <div className="flex h-full">
      {/* Left: Instance list */}
      <div className="w-64 border-r">
        <button onClick={handleAddInstance}>+ {t('addEmailInstance')}</button>
        {emailConfig?.instances.map(inst => (
          <InstanceCard
            key={inst.instanceId}
            instance={inst}
            status={emailStatus?.instances.find(s => s.instanceId === inst.instanceId)}
            selected={selectedInstanceId === inst.instanceId}
            onSelect={() => setSelectedInstanceId(inst.instanceId)}
            onDelete={() => handleDeleteInstance(inst.instanceId)}
          />
        ))}
      </div>

      {/* Right: Instance detail form */}
      {selectedInstance && (
        <div className="flex-1 p-6 overflow-y-auto">
          {/* Basic config */}
          <section>
            <Input label="instanceName" />
            <RadioGroup label="transport" options={['imap', 'ws']} />
            <Input label="email" type="email" />
            {selectedInstance.transport === 'imap' && (
              <Input label="password" type="password" />
            )}
            {selectedInstance.transport === 'ws' && (
              <div>
                <Input label="apiKey" type="password" />
                <Button onClick={() => handleGetApiKey(selectedInstance.instanceId)}>
                  {t('getApiKey')}
                </Button>
              </div>
            )}
            <Select label="agentId" options={availableAgents} />
            <Textarea label="allowFrom" />
          </section>

          {/* Advanced options (collapsible) */}
          <Collapse title={t('emailAdvancedOptions')}>
            {selectedInstance.transport === 'imap' && (
              <section>
                <h4>{t('emailImapSmtpConfig')}</h4>
                <Input label="imapHost" />
                <Input label="imapPort" type="number" />
                <Input label="smtpHost" />
                <Input label="smtpPort" type="number" />
              </section>
            )}

            <section>
              <h4>{t('emailReplyStrategy')}</h4>
              <Select label="replyMode" options={['immediate', 'accumulated', 'complete']} />
              <RadioGroup label="replyTo" options={['sender', 'all']} />
            </section>

            <section>
              <h4>{t('emailA2aConfig')}</h4>
              <Toggle label="a2aEnabled" />
              {selectedInstance.a2aEnabled && (
                <>
                  <Textarea label="a2aAgentDomains" />
                  <Input label="a2aMaxPingPongTurns" type="number" />
                </>
              )}
            </section>
          </Collapse>

          {/* Actions */}
          <div className="flex gap-2 mt-6">
            <Button onClick={handleTestConnection} disabled={!selectedInstance.email}>
              {t('testConnection')}
            </Button>
            <Button onClick={handleSave} loading={saving} primary>
              {t('save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
```

**Estimated lines:** ~400

### 6. Internationalization

**Files:** `src/main/i18n.ts`, `src/renderer/services/i18n.ts`

Add translation keys for:

- Channel prefix: `channelPrefixEmail`
- Form labels: `emailInstanceName`, `emailAddress`, `emailPassword`, `emailApiKey`, etc.
- UI text: `addEmailInstance`, `getApiKey`, `testConnection`, etc.
- Validation errors: `emailInvalidEmail`, `emailMissingPassword`, `emailDuplicateEmail`, etc.
- Status: `emailConnected`, `emailDisconnected`

**Estimated lines:** ~60 (30 per language)

### 7. Plugin Declaration

**File:** `package.json`

Add to `openclaw.plugins` array:

```json
{
  "id": "clawemail-email",
  "npm": "@clawemail/email",
  "version": "0.9.0"
}
```

For development, support local path via environment variable:

```bash
# .env.local
CLAWEMAIL_LOCAL_PATH=/home/gzlicanyi/work/git/claw-mail-channel/extensions/email
```

**File:** `scripts/ensure-openclaw-plugins.cjs`

Add email plugin to installation logic with local path fallback.

**Estimated lines:** ~15

## Implementation Details

### Transport Mode Switching

The UI must dynamically show/hide fields based on `transport`:

| Field          | IMAP Mode              | WebSocket Mode |
| -------------- | ---------------------- | -------------- |
| Email          | ✅ Required            | ✅ Required    |
| Password       | ✅ Required            | ❌ Hidden      |
| API Key        | ❌ Hidden              | ✅ Required    |
| IMAP Host/Port | ⚙️ Optional (Advanced) | ❌ Hidden      |
| SMTP Host/Port | ⚙️ Optional (Advanced) | ❌ Hidden      |

### API Key Acquisition Flow

**User Experience:**

1. User selects "WebSocket" transport mode
2. User enters email address
3. User clicks "获取 API Key" button
4. System opens default browser to `https://your-clawemail-service.com/get-apikey?email={email}`
5. User completes verification in browser (e.g., email OTP, OAuth)
6. Service displays API Key (format: `ck_live_...`)
7. User copies API Key and pastes into 智码 GLM Code input field
8. User clicks Save

**Technical Implementation:**

```typescript
const handleGetApiKey = async () => {
  const email = selectedInstance.email?.trim();
  if (!email || !isValidEmail(email)) {
    showError('请先填写有效的邮箱地址');
    return;
  }

  const apiKeyUrl = `https://your-clawemail-service.com/get-apikey?email=${encodeURIComponent(email)}`;

  try {
    await window.electron.shell.openExternal(apiKeyUrl);
    showInfo('请在浏览器中完成验证，然后将 API Key 粘贴回来');
  } catch (error) {
    // Fallback: show URL in dialog
    showErrorWithCopy('无法打开浏览器', apiKeyUrl);
  }
};
```

### Account-Level Agent Binding

Each email instance has its own `agentId` field. When a session is created:

1. Parse `accountId` from sessionKey: `agent:main:email:{accountId}:{threadId}`
2. Look up `emailConfig.instances.find(i => i.instanceId === accountId)`
3. Extract `instance.agentId` (default: `'main'`)
4. Create Cowork session with that agentId

This ensures emails to different accounts can route to different agents (e.g., work emails → `work-agent`, personal emails → `main`).

### Configuration Validation

Before saving, validate:

- ✅ Instance count ≤ `MAX_EMAIL_INSTANCES` (5)
- ✅ No duplicate `instanceId` or `email` addresses
- ✅ Valid email format: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
- ✅ IMAP mode requires `password`
- ✅ WebSocket mode requires `apiKey` starting with `ck_`
- ✅ All enabled instances have required fields

Show consolidated error dialog if validation fails.

### Error Handling

**Config Sync Errors:**

- Wrap email sync block in try-catch
- Log error but don't block other IM channels
- Email channel simply won't load in OpenClaw

**Session Parse Errors:**

- If `parseChannelSessionKey` fails for email, fall back to generic channel session
- User can still view conversation history

**Gateway Restart Timeout:**

- Wait up to 30 seconds for gateway restart
- If timeout, show warning but don't rollback config (it's already saved)
- User can manually check gateway logs

**Connection Test:**

- For IMAP: attempt login and list mailboxes
- For WebSocket: attempt token fetch with apiKey
- Display success/failure message with details

## Testing Strategy

### Manual Testing Checklist

**Configuration:**

- [ ] Add email instance (IMAP mode) → save → verify in openclaw.json
- [ ] Add email instance (WebSocket mode) → save → verify apiKey env var
- [ ] Toggle transport mode → verify UI shows/hides correct fields
- [ ] Test validation: empty email, duplicate email, invalid apiKey format
- [ ] Test max instances limit (try to add 6th instance)
- [ ] Delete instance → save → verify removed from config

**Agent Binding:**

- [ ] Set different agentId for each instance
- [ ] Send test emails to both accounts
- [ ] Verify sessions appear under correct agents in sidebar

**API Key Flow:**

- [ ] Click "获取 API Key" → verify browser opens with correct URL
- [ ] Paste apiKey → save → verify stored in env file

**Connection Status:**

- [ ] Start gateway with valid config → verify green "已连接" indicator
- [ ] Stop gateway → verify gray "未连接" indicator
- [ ] Invalid credentials → verify error badge appears

**Session Discovery:**

- [ ] Send inbound email → verify session appears in sidebar
- [ ] Session title format: `邮件:{threadId}`
- [ ] Reply in 智码 GLM Code → verify email sent via SMTP/WebSocket

**Advanced Options:**

- [ ] Configure custom IMAP/SMTP hosts → verify used instead of auto-detected
- [ ] Test replyMode options (immediate/accumulated/complete)
- [ ] Test A2A configuration fields

### Integration Testing

Run existing IM channel tests to ensure no regressions:

```bash
npm test -- im
```

### Development Testing

For local development, use the local plugin path:

```bash
export CLAWEMAIL_LOCAL_PATH=/home/gzlicanyi/work/git/claw-mail-channel/extensions/email
npm run openclaw:plugins
npm run electron:dev:openclaw
```

## Migration & Compatibility

### Forward Compatibility

If future versions change the config format, add migration logic in `getEmailConfig()`:

```typescript
// Detect v1 format (single account) and convert to v2 (multi-instance)
if (parsed.email && !parsed.instances) {
  console.log('[EmailChannel] Migrating from v1 config format');
  return {
    instances: [
      {
        instanceId: 'email-1',
        instanceName: 'Default',
        enabled: parsed.enabled ?? false,
        transport: 'imap',
        email: parsed.email,
        password: parsed.password,
        agentId: 'main',
        ...DEFAULT_EMAIL_INSTANCE_CONFIG,
      },
    ],
  };
}
```

### Backward Compatibility

No existing 智码 GLM Code features are affected:

- Email config is additive (new key in `im_config` table)
- Email platform is new (no conflicts with existing platforms)
- UI adds new Settings tab (no changes to existing tabs)

## Security Considerations

**Password Storage:**

- Passwords and API Keys stored in SQLite (encrypted at rest by OS filesystem)
- Written to `.env` file as plain text (file permissions: 600)
- Environment variables passed to OpenClaw child process (isolated memory space)

**Whitelist Enforcement:**

- `allowFrom` patterns enforced by email channel plugin before dispatching to agent
- Empty whitelist = accept all senders (user must explicitly configure)

**API Key Validation:**

- Client-side format check: must start with `ck_`
- Server-side validation when fetching IM token (via `@clawemail/node-sdk`)
- Invalid apiKey → connection fails with clear error message

**WebSocket Security:**

- WebSocket transport uses TLS (wss://)
- Token authentication for every request
- Email content encrypted in transit

## Performance Considerations

**Config Sync:**

- Triggered only on user Save action (not hot path)
- Gateway restart takes ~2-5 seconds (show loading indicator)

**Status Polling:**

- Poll every 5 seconds (same as other IM channels)
- Batched with other IM status queries (single RPC call)
- Minimal network overhead (~1KB per poll)

**Session Discovery:**

- Existing `pollChannelSessions` runs every 10 seconds
- Email sessions discovered automatically (no additional polling)
- Session list limited to 200 active sessions (configurable)

**UI Rendering:**

- Email settings component only rendered when Settings tab is active
- Instance list virtualized if >20 instances (future optimization)

## Code Estimate Summary

| Component          | Files  | New Lines | Modified Lines |
| ------------------ | ------ | --------- | -------------- |
| Type definitions   | 1      | ~150      | -              |
| IMStore methods    | 1      | ~50       | -              |
| Config sync        | 1      | ~80       | -              |
| Session mapping    | 2      | ~40       | -              |
| UI component       | 1      | ~400      | -              |
| i18n translations  | 2      | ~60       | -              |
| Plugin declaration | 2      | ~15       | -              |
| **Total**          | **10** | **~795**  | **~20**        |

## Open Questions

1. **API Key service URL:** What is the actual URL for the apiKey acquisition page?
   - Placeholder: `https://your-clawemail-service.com/get-apikey`
   - Needs to be updated with real URL before release

2. **Plugin distribution:** Will `@clawemail/email` be published to npm or distributed via private registry?
   - Current design supports both via `localPath` fallback

3. **IM CLI transport:** Should we add support for `mail-cli` profile mode in a future iteration?
   - Currently excluded per user preference (Approach B)

## References

- Email channel plugin: `/home/gzlicanyi/work/git/claw-mail-channel`
- OpenClaw config sync: `src/main/libs/openclawConfigSync.ts`
- Multi-instance reference: Feishu implementation (`src/renderer/components/settings/FeishuSettings.tsx`)
- Session sync: `src/main/libs/openclawChannelSessionSync.ts`
- Gateway manager: `src/main/libs/openclawEngineManager.ts`

## Spec Review Corrections

The following issues were identified during spec review and have been addressed:

### 1. Missing Default Configuration Constants

Added to the TypeScript types section:

```typescript
export const DEFAULT_EMAIL_INSTANCE_CONFIG: Partial<EmailInstanceConfig> = {
  enabled: true,
  transport: 'imap',
  agentId: 'main',
  replyMode: 'complete',
  replyTo: 'sender',
  a2aEnabled: false,
  a2aMaxPingPongTurns: 20,
};

export const DEFAULT_EMAIL_MULTI_INSTANCE_CONFIG: EmailMultiInstanceConfig = {
  instances: [],
};
```

### 2. Environment Variable Naming Simplification

**Changed:** `LOBSTER_EMAIL_EMAIL_1_PASSWORD` → `LOBSTER_EMAIL_1_PASSWORD`

Transformation logic updated to:

```typescript
const envPrefix = `LOBSTER_EMAIL_${inst.instanceId.replace(/^email-/, '').toUpperCase()}`;
// email-1 → LOBSTER_EMAIL_1_PASSWORD
// email-work → LOBSTER_EMAIL_WORK_PASSWORD
```

### 3. Session Key Format Standardization

- **Standardized format:** `agent:{agentId}:email:{accountId}:{threadId}`
- Updated parsing logic to be defensive against threadId containing colons:

```typescript
const emailIndex = parts.indexOf('email');
if (emailIndex !== -1 && emailIndex < parts.length - 2) {
  const accountId = parts[emailIndex + 1];
  const threadId = parts.slice(emailIndex + 2).join(':'); // Handle colons in threadId
}
```

### 4. IPC Channel Specification

Clarified complete IPC API surface:

```typescript
// Email configuration (reuses existing IM channels)
'im:getConfig' → IMGatewayConfig (includes optional email field)
'im:setConfig' → IMGatewayConfig (includes optional email field)
'im:getStatus' → IMGatewayStatus (includes optional email field)

// Agent listing for UI dropdown
'cowork:listAgents' → string[] (agent IDs)

// Connection testing
'email:testConnection' → { instanceId: string } → { success: boolean; error?: string }
```

### 5. Validation Function Definitions

Added utility functions specification:

```typescript
// src/renderer/utils/validation.ts
export const isValidEmail = (email: string): boolean => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

// src/renderer/components/settings/EmailSettings.tsx
const validateConfig = (): string[] => {
  const errors: string[] = [];
  if (emailConfig.instances.length > MAX_EMAIL_INSTANCES) {
    errors.push(t('emailMaxInstancesExceeded', { count: MAX_EMAIL_INSTANCES }));
  }
  const seenIds = new Set<string>();
  const seenEmails = new Set<string>();
  for (const inst of emailConfig.instances) {
    if (seenIds.has(inst.instanceId)) {
      errors.push(t('emailDuplicateInstanceId', { id: inst.instanceId }));
    }
    seenIds.add(inst.instanceId);
    if (seenEmails.has(inst.email)) {
      errors.push(t('emailDuplicateEmail', { email: inst.email }));
    }
    seenEmails.add(inst.email);
    if (!isValidEmail(inst.email)) {
      errors.push(t('emailInvalidEmail', { email: inst.email }));
    }
    if (inst.transport === 'imap' && !inst.password) {
      errors.push(t('emailMissingPassword', { name: inst.instanceName }));
    }
    if (inst.transport === 'ws' && !inst.apiKey) {
      errors.push(t('emailMissingApiKey', { name: inst.instanceName }));
    }
    if (inst.transport === 'ws' && inst.apiKey && !inst.apiKey.startsWith('ck_')) {
      errors.push(t('emailInvalidApiKey', { name: inst.instanceName }));
    }
  }
  return errors;
};
```

### 6. Test Connection Implementation

Added implementation approach:

```typescript
// src/main/main.ts
ipcMain.handle('email:testConnection', async (event, { instanceId }) => {
  try {
    const imStore = getIMGatewayManager().getIMStore();
    const emailConfig = imStore.getEmailConfig();
    const instance = emailConfig.instances.find(i => i.instanceId === instanceId);
    if (!instance) throw new Error('Instance not found');

    if (instance.transport === 'imap') {
      // Use node-imap library directly
      const Imap = require('imap');
      const connection = new Imap({
        user: instance.email,
        password: instance.password,
        host: instance.imapHost || deriveImapHost(instance.email),
        port: instance.imapPort || 993,
        tls: true,
      });
      await new Promise((resolve, reject) => {
        connection.once('ready', () => {
          connection.end();
          resolve();
        });
        connection.once('error', reject);
        connection.connect();
      });
    } else if (instance.transport === 'ws') {
      // Use @clawemail/node-sdk to fetch token
      const { fetchIMToken } = require('@clawemail/node-sdk');
      await fetchIMToken(instance.apiKey, instance.email, console);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});
```

### 7. Agent Binding Race Condition Fix

Updated session resolution to cache config:

```typescript
// In OpenClawChannelSessionSync constructor
this.cachedEmailConfig: EmailMultiInstanceConfig | null = null;
this.configCacheExpiry = 0;

// In resolveOrCreateSession
let agentId = 'main';
if (platform === 'email') {
  // Cache config for 60 seconds to avoid repeated DB reads
  if (!this.cachedEmailConfig || Date.now() > this.configCacheExpiry) {
    this.cachedEmailConfig = this.imStore.getEmailConfig();
    this.configCacheExpiry = Date.now() + 60_000;
  }
  const parts = sessionKey.split(':');
  const emailIndex = parts.indexOf('email');
  if (emailIndex !== -1 && emailIndex < parts.length - 2) {
    const accountId = parts[emailIndex + 1];
    const instance = this.cachedEmailConfig.instances.find(i => i.instanceId === accountId);
    if (instance?.agentId) {
      agentId = instance.agentId;
    }
  }
}
```

### 8. Plugin Installation Error Handling

Added error handling policy:

```javascript
// scripts/ensure-openclaw-plugins.cjs
// Policy: Email plugin installation is non-blocking
for (const plugin of PLUGINS) {
  try {
    if (plugin.localPath && fs.existsSync(plugin.localPath)) {
      console.log(`[Plugin] Using local path for ${plugin.id}: ${plugin.localPath}`);
      fs.symlinkSync(plugin.localPath, pluginDir, 'dir');
    } else {
      console.log(`[Plugin] Installing ${plugin.id}@${plugin.version}`);
      execSync(`npm install ${plugin.npmSpec}@${plugin.version}`, {
        cwd: extensionsDir,
        stdio: 'inherit',
      });
    }
  } catch (error) {
    console.error(`[Plugin] Failed to install ${plugin.id}:`, error.message);
    console.error(`[Plugin] ${plugin.id} will not be available. Continue without it.`);
    // Non-blocking: app starts without this plugin
  }
}
```

### 9. Internationalization Hardcoded Strings

Fixed all hardcoded Chinese strings:

```typescript
// Before:
showError('请先填写有效的邮箱地址');
showInfo('请在浏览器中完成验证，然后将 API Key 粘贴回来');

// After:
showError(t('emailEnterValidEmailFirst'));
showInfo(t('emailVerifyInBrowserAndPaste'));
```

Added missing translation keys:

- `emailEnterValidEmailFirst`
- `emailVerifyInBrowserAndPaste`
- `emailDuplicateInstanceId`

### 10. Runtime Statistics Documentation

Added clarification for `lastInboundAt` / `lastOutboundAt`:

```typescript
// EmailInstanceStatus fields:
// - lastInboundAt: Timestamp of last received email (provided by email plugin runtime)
// - lastOutboundAt: Timestamp of last sent email (provided by email plugin runtime)
// - Both reset to null when OpenClaw gateway restarts (not persisted)
// - UI displays as relative time: "2 minutes ago" using libraries like date-fns
```

### 11. Backward Compatibility

Updated `IMGatewayConfig` and `IMGatewayStatus` to make `email` optional:

```typescript
export interface IMGatewayConfig {
  // ... existing required fields
  email?: EmailMultiInstanceConfig; // Optional: introduced in this version
}

export interface IMGatewayStatus {
  // ... existing required fields
  email?: EmailMultiInstanceStatus; // Optional: introduced in this version
}
```

This ensures older code that doesn't expect the `email` field won't break.

### 12. Type System Clarity

Explicitly documented that `IMGatewayConfig` and `IMGatewayStatus` modifications are part of the `src/main/im/types.ts` changes in the "Type System Extensions" section.

---

## Approval

This design has been reviewed, corrected, and approved for implementation.

**Next Steps:**

1. Write detailed implementation plan using `writing-plans` skill
2. Execute implementation in isolated worktree (if applicable)
3. Run test suite and manual testing checklist
4. Submit PR for code review

---

## 实施计划


**Goal:** Integrate the `@clawemail/email` OpenClaw plugin into 智码 GLM Code with full UI configuration support for IMAP/SMTP and WebSocket transport modes.

**Architecture:** Reuse existing IM multi-instance pattern (Feishu/QQ model) with email-specific type extensions, account-level agent binding, and tiered configuration UI (basic + advanced collapsible).

**Tech Stack:** TypeScript, React, Electron IPC, SQLite (better-sqlite3), OpenClaw Gateway, Tailwind CSS

**Spec Reference:** `docs/superpowers/specs/2026-04-09-email-channel-integration-design.md`

---

## File Structure Overview

**New Files (2):**

- `src/renderer/components/settings/EmailSettings.tsx` - UI configuration component (~400 lines)
- `src/renderer/utils/validation.ts` - Email validation utility (~10 lines)

**Modified Files (8):**

- `src/main/im/types.ts` - Add Email types and extend IM interfaces (~150 lines added)
- `src/shared/platform.ts` - Add 'email' platform enum (~10 lines added)
- `src/main/im/imStore.ts` - Add getEmailConfig/setEmailConfig methods (~50 lines added)
- `src/main/libs/openclawConfigSync.ts` - Add email channel sync logic (~80 lines added)
- `src/main/libs/openclawChannelSessionSync.ts` - Add email session mapping (~40 lines added)
- `src/main/i18n.ts` - Add email translation keys (zh) (~30 lines added)
- `src/renderer/services/i18n.ts` - Add email translation keys (en) (~30 lines added)
- `package.json` - Add email plugin declaration (~5 lines added)

**Total Estimate:** ~805 lines of new code

---

## Chunk 1: Type System & Core Infrastructure

### Task 1: Add Email Type Definitions

**Files:**

- Modify: `src/main/im/types.ts:809` (end of file)
- Spec ref: Design doc lines 140-215

- [ ] **Step 1: Add EmailInstanceConfig interface**

Insert at end of `src/main/im/types.ts`:

```typescript
// ==================== Email Channel Types ====================

export interface EmailInstanceConfig {
  instanceId: string; // "email-1", "email-2", etc.
  instanceName: string; // Display name: "Work Email"
  enabled: boolean; // Enable/disable this account

  // Transport mode
  transport: 'imap' | 'ws'; // IMAP/SMTP or WebSocket

  // Account credentials
  email: string; // user@example.com
  password?: string; // Required if transport=imap
  apiKey?: string; // Required if transport=ws (format: ck_*)

  // Agent binding
  agentId: string; // Agent ID (default: "main")

  // IMAP/SMTP servers (optional, auto-detected if empty)
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;

  // Security & policy
  allowFrom?: string[]; // Whitelist: ["user@example.com", "*.trusted.com"]

  // Advanced options
  replyMode?: 'immediate' | 'accumulated' | 'complete';
  replyTo?: 'sender' | 'all';

  // Agent-to-Agent collaboration
  a2aEnabled?: boolean;
  a2aAgentDomains?: string[];
  a2aMaxPingPongTurns?: number;
}

export interface EmailMultiInstanceConfig {
  instances: EmailInstanceConfig[];
}

export interface EmailInstanceStatus {
  instanceId: string;
  instanceName: string;
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  email: string | null;
  transport: 'imap' | 'ws' | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

export interface EmailMultiInstanceStatus {
  instances: EmailInstanceStatus[];
}

// Default configurations
export const DEFAULT_EMAIL_INSTANCE_CONFIG: Partial<EmailInstanceConfig> = {
  enabled: true,
  transport: 'imap',
  agentId: 'main',
  replyMode: 'complete',
  replyTo: 'sender',
  a2aEnabled: false,
  a2aMaxPingPongTurns: 20,
};

export const DEFAULT_EMAIL_MULTI_INSTANCE_CONFIG: EmailMultiInstanceConfig = {
  instances: [],
};

export const MAX_EMAIL_INSTANCES = 5;
```

- [ ] **Step 2: Verify TypeScript compilation**

Run: `npm run build`
Expected: No type errors

- [ ] **Step 3: Commit type definitions**

```bash
git add src/main/im/types.ts
git commit -m "feat(types): add email channel type definitions"
```

---

### Task 2: Update IMGatewayConfig to Include Email

**Files:**

- Modify: `src/main/im/types.ts:388-400`
- Spec ref: Design doc "Spec Review Corrections" #11

- [ ] **Step 1: Add optional email field to IMGatewayConfig**

Find the `IMGatewayConfig` interface definition (around line 388) and modify:

```typescript
export interface IMGatewayConfig {
  dingtalk: DingTalkMultiInstanceConfig;
  feishu: FeishuMultiInstanceConfig;
  telegram: TelegramOpenClawConfig;
  qq: QQMultiInstanceConfig;
  discord: DiscordOpenClawConfig;
  nim: NimConfig;
  'netease-bee': NeteaseBeeChanConfig;
  wecom: WecomOpenClawConfig;
  popo: PopoOpenClawConfig;
  weixin: WeixinOpenClawConfig;
  email?: EmailMultiInstanceConfig; // Optional: new in this version
  settings: IMSettings;
}
```

- [ ] **Step 2: Add optional email field to IMGatewayStatus**

Find the `IMGatewayStatus` interface (around line 409) and modify:

```typescript
export interface IMGatewayStatus {
  dingtalk: DingTalkMultiInstanceStatus;
  feishu: FeishuMultiInstanceStatus;
  qq: QQMultiInstanceStatus;
  telegram: TelegramGatewayStatus;
  discord: DiscordGatewayStatus;
  nim: NimGatewayStatus;
  'netease-bee': NeteaseBeeChanGatewayStatus;
  wecom: WecomGatewayStatus;
  popo: PopoGatewayStatus;
  weixin: WeixinGatewayStatus;
  email?: EmailMultiInstanceStatus; // Optional: new in this version
}
```

- [ ] **Step 3: Update DEFAULT_IM_CONFIG**

Find `DEFAULT_IM_CONFIG` (around line 689) and add:

```typescript
export const DEFAULT_IM_CONFIG: IMGatewayConfig = {
  dingtalk: DEFAULT_DINGTALK_MULTI_INSTANCE_CONFIG,
  feishu: DEFAULT_FEISHU_MULTI_INSTANCE_CONFIG,
  telegram: DEFAULT_TELEGRAM_OPENCLAW_CONFIG,
  qq: DEFAULT_QQ_MULTI_INSTANCE_CONFIG,
  discord: DEFAULT_DISCORD_OPENCLAW_CONFIG,
  nim: DEFAULT_NIM_CONFIG,
  'netease-bee': DEFAULT_NETEASE_BEE_CONFIG,
  wecom: DEFAULT_WECOM_CONFIG,
  popo: DEFAULT_POPO_CONFIG,
  weixin: DEFAULT_WEIXIN_CONFIG,
  email: DEFAULT_EMAIL_MULTI_INSTANCE_CONFIG, // Add this line
  settings: DEFAULT_IM_SETTINGS,
};
```

- [ ] **Step 4: Update DEFAULT_IM_STATUS**

Find `DEFAULT_IM_STATUS` (around line 781) and add:

```typescript
export const DEFAULT_IM_STATUS: IMGatewayStatus = {
  dingtalk: { instances: [] },
  feishu: { instances: [] },
  telegram: {
    connected: false,
    startedAt: null,
    lastError: null,
    botUsername: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
  qq: { instances: [] },
  discord: DEFAULT_DISCORD_STATUS,
  nim: DEFAULT_NIM_STATUS,
  'netease-bee': DEFAULT_NETEASE_BEE_STATUS,
  wecom: DEFAULT_WECOM_STATUS,
  popo: DEFAULT_POPO_STATUS,
  weixin: DEFAULT_WEIXIN_STATUS,
  email: { instances: [] }, // Add this line
};
```

- [ ] **Step 5: Verify TypeScript compilation**

Run: `npm run build`
Expected: No type errors

- [ ] **Step 6: Commit IMGatewayConfig extension**

```bash
git add src/main/im/types.ts
git commit -m "feat(types): extend IMGatewayConfig to include email channel"
```

---

### Task 3: Add Email Platform Enum

**Files:**

- Modify: `src/shared/platform.ts:6-20`
- Spec ref: Design doc lines 269-271, 420-431

- [ ] **Step 1: Add 'email' to Platform type**

Find the `Platform` type definition and add 'email':

```typescript
export type Platform =
  | 'telegram'
  | 'discord'
  | 'feishu'
  | 'dingtalk'
  | 'wecom'
  | 'qq'
  | 'weixin'
  | 'nim'
  | 'popo'
  | 'netease-bee'
  | 'email'; // Add this line
```

- [ ] **Step 2: Add email to platformOfChannel mapping**

Find the `PlatformRegistry.platformOfChannel` method and add email mappings:

```typescript
static platformOfChannel(channelName: string): Platform | null {
  const mapping: Record<string, Platform> = {
    'telegram': 'telegram',
    'discord': 'discord',
    'feishu': 'feishu',
    'feishu-openclaw-plugin': 'feishu',
    'dingtalk': 'dingtalk',
    'dingtalk-connector': 'dingtalk',
    'wecom': 'wecom',
    'wecom-openclaw-plugin': 'wecom',
    'qqbot': 'qq',
    'weixin': 'weixin',
    'openclaw-weixin': 'weixin',
    'nim': 'nim',
    'openclaw-nim': 'nim',
    'popo': 'popo',
    'moltbot-popo': 'popo',
    'netease-bee': 'netease-bee',
    'openclaw-netease-bee': 'netease-bee',
    'email': 'email',             // Add these three lines
    'clawemail': 'email',
    'clawemail-email': 'email',
  };
  return mapping[channelName] || null;
}
```

- [ ] **Step 3: Add email to channelOf reverse mapping**

Find the `PlatformRegistry.channelOf` method and add:

```typescript
static channelOf(platform: Platform): string | null {
  const reverseMapping: Record<Platform, string> = {
    telegram: 'telegram',
    discord: 'discord',
    feishu: 'feishu',
    dingtalk: 'dingtalk',
    wecom: 'wecom',
    qq: 'qqbot',
    weixin: 'weixin',
    nim: 'nim',
    popo: 'popo',
    'netease-bee': 'netease-bee',
    email: 'email',  // Add this line
  };
  return reverseMapping[platform] || null;
}
```

- [ ] **Step 4: Verify TypeScript compilation**

Run: `npm run build`
Expected: No type errors

- [ ] **Step 5: Commit platform enum extension**

```bash
git add src/shared/platform.ts
git commit -m "feat(platform): add email to Platform enum and registry"
```

---

### Task 4: Add IMStore Email Config Methods

**Files:**

- Modify: `src/main/im/imStore.ts` (end of class)
- Spec ref: Design doc lines 285-309

- [ ] **Step 1: Add getEmailConfig method**

Add to the `IMStore` class before the closing brace:

```typescript
  /**
   * Get email channel multi-instance configuration
   */
  getEmailConfig(): EmailMultiInstanceConfig {
    const raw = this.db
      .prepare('SELECT value FROM im_config WHERE key = ?')
      .get('email') as { value: string } | undefined;

    if (!raw?.value) {
      return DEFAULT_EMAIL_MULTI_INSTANCE_CONFIG;
    }

    try {
      const parsed = JSON.parse(raw.value);

      // Migration logic: detect v1 format (single account) and convert to v2 (multi-instance)
      if (parsed.email && !parsed.instances) {
        console.log('[EmailChannel] Migrating from v1 config format');
        return {
          instances: [{
            instanceId: 'email-1',
            instanceName: 'Default',
            enabled: parsed.enabled ?? false,
            transport: 'imap',
            email: parsed.email,
            password: parsed.password,
            agentId: 'main',
            ...DEFAULT_EMAIL_INSTANCE_CONFIG,
          }],
        };
      }

      // v2 format: multi-instance mode
      return {
        instances: (parsed.instances || []).map((inst: any) => ({
          ...DEFAULT_EMAIL_INSTANCE_CONFIG,
          ...inst,
        })),
      };
    } catch (error) {
      console.error('[EmailChannel] Failed to parse config:', error);
      return DEFAULT_EMAIL_MULTI_INSTANCE_CONFIG;
    }
  }

  /**
   * Set email channel multi-instance configuration
   */
  setEmailConfig(config: EmailMultiInstanceConfig): void {
    this.db
      .prepare('INSERT OR REPLACE INTO im_config (key, value) VALUES (?, ?)')
      .run('email', JSON.stringify(config));
  }
```

- [ ] **Step 2: Add import for email types**

At the top of `imStore.ts`, find the imports from `./types` and add email types:

```typescript
import type {
  // ... existing imports
  EmailMultiInstanceConfig,
  EmailInstanceConfig,
} from './types';
import { DEFAULT_EMAIL_MULTI_INSTANCE_CONFIG, DEFAULT_EMAIL_INSTANCE_CONFIG } from './types';
```

- [ ] **Step 3: Verify TypeScript compilation**

Run: `npm run build`
Expected: No type errors

- [ ] **Step 4: Commit IMStore email methods**

```bash
git add src/main/im/imStore.ts
git commit -m "feat(imstore): add getEmailConfig/setEmailConfig methods"
```

---

## Chunk 2: OpenClaw Configuration Sync

### Task 5: Add Email Channel Config Sync

**Files:**

- Modify: `src/main/libs/openclawConfigSync.ts` (in syncOpenClawConfig method)
- Spec ref: Design doc lines 311-379

- [ ] **Step 1: Add email config sync block**

Find the `syncOpenClawConfig()` method and add email sync logic after the POPO sync block (search for "Sync POPO OpenClaw channel config"):

```typescript
// Sync Email OpenClaw channel config (multi-instance)
const emailConfig = this.getEmailOpenClawConfig?.();
if (emailConfig?.instances && emailConfig.instances.length > 0) {
  const enabledInstances = emailConfig.instances.filter(i => i.enabled && i.email);

  if (enabledInstances.length > 0) {
    const accounts: Record<string, unknown> = {};

    for (const inst of enabledInstances) {
      const accountId = inst.instanceId;
      // Transform instanceId: email-1 → 1, email-work → WORK
      const envSuffix = accountId.replace(/^email-/, '').toUpperCase();

      const accountConfig: Record<string, unknown> = {
        enabled: true,
        name: inst.instanceName,
        email: inst.email,
        transport: inst.transport,
      };

      // IMAP/SMTP mode configuration
      if (inst.transport === 'imap') {
        accountConfig.password = `\${LOBSTER_EMAIL_${envSuffix}_PASSWORD}`;
        if (inst.imapHost) accountConfig.imapHost = inst.imapHost;
        if (inst.imapPort) accountConfig.imapPort = inst.imapPort;
        if (inst.smtpHost) accountConfig.smtpHost = inst.smtpHost;
        if (inst.smtpPort) accountConfig.smtpPort = inst.smtpPort;
      }

      // WebSocket mode configuration
      if (inst.transport === 'ws') {
        accountConfig.apiKey = `\${LOBSTER_EMAIL_${envSuffix}_APIKEY}`;
      }

      // Common configuration
      if (inst.allowFrom?.length) {
        accountConfig.allowFrom = inst.allowFrom;
      }
      if (inst.replyMode) {
        accountConfig.replyMode = inst.replyMode;
      }
      if (inst.replyTo) {
        accountConfig.replyTo = inst.replyTo;
      }

      // A2A configuration
      if (
        inst.a2aEnabled !== undefined ||
        inst.a2aAgentDomains?.length ||
        inst.a2aMaxPingPongTurns
      ) {
        accountConfig.a2a = {
          enabled: inst.a2aEnabled ?? true,
          ...(inst.a2aAgentDomains?.length ? { agentDomains: inst.a2aAgentDomains } : {}),
          ...(inst.a2aMaxPingPongTurns ? { maxPingPongTurns: inst.a2aMaxPingPongTurns } : {}),
        };
      }

      accounts[accountId] = accountConfig;
    }

    managedConfig.channels = {
      ...((managedConfig.channels as Record<string, unknown>) || {}),
      email: {
        enabled: true,
        accounts,
      },
    };
  }
}
```

- [ ] **Step 2: Add getEmailOpenClawConfig method declaration**

Find the class properties/methods section and add getter method (after similar methods like `getTelegramOpenClawConfig`):

```typescript
  private getEmailOpenClawConfig?: () => EmailMultiInstanceConfig;
```

- [ ] **Step 3: Initialize email config getter in constructor**

In the `syncOpenClawConfig` class constructor, add initialization:

```typescript
this.getEmailOpenClawConfig = () => {
  const imStore = getIMGatewayManager().getIMStore();
  return imStore.getEmailConfig();
};
```

- [ ] **Step 4: Add imports**

At the top of the file, add email type imports:

```typescript
import type { EmailMultiInstanceConfig } from '../im/types';
```

- [ ] **Step 5: Verify TypeScript compilation**

Run: `npm run build`
Expected: No type errors

- [ ] **Step 6: Commit config sync logic**

```bash
git add src/main/libs/openclawConfigSync.ts
git commit -m "feat(config-sync): add email channel configuration sync"
```

---

### Task 6: Add Email Environment Variables

**Files:**

- Modify: `src/main/libs/openclawConfigSync.ts` (in writeEnvFile method)
- Spec ref: Design doc lines 380-395

- [ ] **Step 1: Add email credentials to env file**

Find the `writeEnvFile()` method and add email env vars after POPO credentials section:

```typescript
// Email credentials
const emailConfig = this.getEmailOpenClawConfig?.();
if (emailConfig?.instances) {
  for (const inst of emailConfig.instances) {
    if (!inst.enabled || !inst.email) continue;

    const envSuffix = inst.instanceId.replace(/^email-/, '').toUpperCase();

    if (inst.transport === 'imap' && inst.password) {
      lines.push(`LOBSTER_EMAIL_${envSuffix}_PASSWORD=${inst.password}`);
    }

    if (inst.transport === 'ws' && inst.apiKey) {
      lines.push(`LOBSTER_EMAIL_${envSuffix}_APIKEY=${inst.apiKey}`);
    }
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 3: Commit env file changes**

```bash
git add src/main/libs/openclawConfigSync.ts
git commit -m "feat(config-sync): add email credentials to environment variables"
```

---

### Task 7: Add Email Session Mapping

**Files:**

- Modify: `src/main/libs/openclawChannelSessionSync.ts`
- Spec ref: Design doc lines 420-454

- [ ] **Step 1: Add email to title prefix mapping**

Find the `getTitlePrefix` method and add email prefix:

```typescript
  private getTitlePrefix(platform: Platform): string {
    const prefixByPlatform: Record<Platform, string> = {
      telegram: t('channelPrefixTelegram'),
      discord: t('channelPrefixDiscord'),
      feishu: t('channelPrefixFeishu'),
      dingtalk: t('channelPrefixDingtalk'),
      wecom: t('channelPrefixWecom'),
      'wecom-openclaw-plugin': t('channelPrefixWecom'),
      nim: t('channelPrefixNim'),
      weixin: t('channelPrefixWeixin'),
      'netease-bee': t('channelPrefixNeteaseBee'),
      qq: t('channelPrefixQQ'),
      popo: t('channelPrefixPopo'),
      email: t('channelPrefixEmail'),  // Add this line
    };
    return prefixByPlatform[platform] || platform;
  }
```

- [ ] **Step 2: Add account-level agent binding logic**

Find the `resolveOrCreateSession` method and add email-specific agent resolution. Insert after the platform parsing and before session creation:

```typescript
// Email channel: resolve agent from account config
let agentId = 'main';
if (platform === 'email') {
  // Cache email config for 60 seconds to avoid repeated DB reads
  if (!this.cachedEmailConfig || Date.now() > this.emailConfigCacheExpiry) {
    this.cachedEmailConfig = this.imStore.getEmailConfig();
    this.emailConfigCacheExpiry = Date.now() + 60_000;
  }

  // Extract accountId from sessionKey: agent:{agentId}:email:{accountId}:{threadId}
  const parts = sessionKey.split(':');
  const emailIndex = parts.indexOf('email');
  if (emailIndex !== -1 && emailIndex < parts.length - 2) {
    const accountId = parts[emailIndex + 1];
    const instance = this.cachedEmailConfig.instances.find(i => i.instanceId === accountId);
    if (instance?.agentId) {
      agentId = instance.agentId;
    }
  }
}
```

- [ ] **Step 3: Add cache properties to class**

Find the class properties section and add:

```typescript
  private cachedEmailConfig: EmailMultiInstanceConfig | null = null;
  private emailConfigCacheExpiry = 0;
```

- [ ] **Step 4: Update session creation to use resolved agentId**

Find where the session is created in `resolveOrCreateSession` and ensure it uses the `agentId` variable:

```typescript
const newSession = this.coworkStore.createSession({
  title: `${titlePrefix}${conversationId}`,
  agentId, // Use resolved agentId (not hardcoded 'main')
  // ... rest of session config
});
```

- [ ] **Step 5: Add imports**

At the top of the file, add:

```typescript
import type { EmailMultiInstanceConfig } from '../im/types';
```

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 7: Commit session mapping**

```bash
git add src/main/libs/openclawChannelSessionSync.ts
git commit -m "feat(session-sync): add email channel session mapping with account-level agent binding"
```

---

## Chunk 3: Internationalization & Plugin Declaration

### Task 8: Add Email i18n Keys (Chinese)

**Files:**

- Modify: `src/main/i18n.ts`
- Spec ref: Design doc lines 579-626

- [ ] **Step 1: Add Chinese translations**

Find the `zh` constant and add email keys after existing channel prefixes:

```typescript
const zh = {
  // ... existing keys

  // Email Channel
  channelPrefixEmail: '邮件',
  emailSettings: '邮件设置',
  emailInstance: '邮箱账号',
  addEmailInstance: '添加邮箱账号',
  emailInstanceName: '账号名称',
  emailInstanceNamePlaceholder: '例如：工作邮箱',
  emailAddress: '邮箱地址',
  emailAddressPlaceholder: 'user@example.com',
  emailPassword: '密码',
  emailPasswordPlaceholder: '邮箱密码或应用专用密码',
  emailApiKey: 'API Key',
  emailApiKeyPlaceholder: 'ck_live_xxxxxxxx',
  getApiKey: '获取 API Key',
  apiKeyHint: '点击「获取 API Key」按钮在浏览器中完成邮箱验证',
  emailTransportMode: '传输模式',
  emailTransportImap: 'IMAP/SMTP（传统模式）',
  emailTransportWs: 'WebSocket（安全模式，无需密码）',
  emailAgentBinding: '绑定 Agent',
  emailAgentBindingHint: '该邮箱的所有邮件对话将路由到选定的 Agent',
  emailAllowFrom: '允许的发件人（白名单）',
  emailAllowFromPlaceholder: 'user@example.com\n*.trusted-domain.com\n*@company.com',
  emailAllowFromHint: '支持通配符，每行一个。留空表示接受所有发件人。',
  emailAdvancedOptions: '高级选项',
  emailImapSmtpConfig: 'IMAP/SMTP 服务器配置',
  emailImapHost: 'IMAP Host',
  emailImapPort: 'IMAP Port',
  emailSmtpHost: 'SMTP Host',
  emailSmtpPort: 'SMTP Port',
  emailServerConfigHint: '留空则自动根据邮箱域名推断',
  emailReplyStrategy: '回复策略',
  emailReplyMode: '回复模式',
  emailReplyModeImmediate: '立即发送（流式，每个块一封邮件）',
  emailReplyModeAccumulated: '累积发送（流式，缓冲后一封邮件）',
  emailReplyModeComplete: '完成后发送（等待完整回复）',
  emailReplyTo: '回复范围',
  emailReplyToSender: '仅回复发件人',
  emailReplyToAll: '回复发件人 + 所有收件人',
  emailA2aConfig: 'Agent-to-Agent 配置',
  emailA2aEnabled: '启用 A2A',
  emailA2aAgentDomains: 'Agent 域名',
  emailA2aAgentDomainsPlaceholder: 'agents.example.com',
  emailA2aAgentDomainsHint: '允许进行 Agent 协作的域名，每行一个',
  emailA2aMaxTurns: '最大往返次数',
  emailConnected: '已连接',
  emailDisconnected: '未连接',
  emailSaveSuccess: '配置已保存',
  emailSaveError: '保存失败',
  emailValidationError: '配置验证失败',
  emailMaxInstancesExceeded: '最多支持 {count} 个邮箱账号',
  emailDuplicateEmail: '邮箱地址「{email}」重复',
  emailDuplicateInstanceId: '实例 ID「{id}」重复',
  emailInvalidEmail: '邮箱地址格式不正确',
  emailMissingPassword: '实例「{name}」使用 IMAP 模式但未填写密码',
  emailMissingApiKey: '实例「{name}」使用 WebSocket 模式但未填写 API Key',
  emailInvalidApiKey: '实例「{name}」的 API Key 格式不正确（应以 ck_ 开头）',
  emailGatewayRestarting: '正在重启 OpenClaw Gateway...',
  emailDeleteConfirm: '确定要删除邮箱账号「{name}」吗？',
  emailEnterValidEmailFirst: '请先填写有效的邮箱地址',
  emailVerifyInBrowserAndPaste: '请在浏览器中完成验证，然后将 API Key 粘贴回来',
  testConnection: '测试连接',
  emailTestSuccess: '连接测试成功！',
  emailTestFailed: '连接测试失败：{error}',
};
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 3: Commit Chinese translations**

```bash
git add src/main/i18n.ts
git commit -m "feat(i18n): add Chinese translations for email channel"
```

---

### Task 9: Add Email i18n Keys (English)

**Files:**

- Modify: `src/renderer/services/i18n.ts`
- Spec ref: Design doc lines 579-626

- [ ] **Step 1: Add English translations**

Find the `en` constant and add email keys (mirror structure from Chinese):

```typescript
const en = {
  // ... existing keys

  // Email Channel
  channelPrefixEmail: 'Email',
  emailSettings: 'Email Settings',
  emailInstance: 'Email Account',
  addEmailInstance: 'Add Email Account',
  emailInstanceName: 'Account Name',
  emailInstanceNamePlaceholder: 'e.g., Work Email',
  emailAddress: 'Email Address',
  emailAddressPlaceholder: 'user@example.com',
  emailPassword: 'Password',
  emailPasswordPlaceholder: 'Email password or app-specific password',
  emailApiKey: 'API Key',
  emailApiKeyPlaceholder: 'ck_live_xxxxxxxx',
  getApiKey: 'Get API Key',
  apiKeyHint: 'Click "Get API Key" to verify your email in browser',
  emailTransportMode: 'Transport Mode',
  emailTransportImap: 'IMAP/SMTP (Traditional)',
  emailTransportWs: 'WebSocket (Secure, no password required)',
  emailAgentBinding: 'Agent Binding',
  emailAgentBindingHint: 'All email conversations will be routed to the selected Agent',
  emailAllowFrom: 'Allowed Senders (Whitelist)',
  emailAllowFromPlaceholder: 'user@example.com\n*.trusted-domain.com\n*@company.com',
  emailAllowFromHint: 'Supports wildcards, one per line. Empty = accept all senders.',
  emailAdvancedOptions: 'Advanced Options',
  emailImapSmtpConfig: 'IMAP/SMTP Server Configuration',
  emailImapHost: 'IMAP Host',
  emailImapPort: 'IMAP Port',
  emailSmtpHost: 'SMTP Host',
  emailSmtpPort: 'SMTP Port',
  emailServerConfigHint: 'Leave empty to auto-detect from email domain',
  emailReplyStrategy: 'Reply Strategy',
  emailReplyMode: 'Reply Mode',
  emailReplyModeImmediate: 'Immediate (streaming, one email per block)',
  emailReplyModeAccumulated: 'Accumulated (streaming, buffered)',
  emailReplyModeComplete: 'Complete (wait for full response)',
  emailReplyTo: 'Reply Recipients',
  emailReplyToSender: 'Sender only',
  emailReplyToAll: 'Sender + all recipients',
  emailA2aConfig: 'Agent-to-Agent Configuration',
  emailA2aEnabled: 'Enable A2A',
  emailA2aAgentDomains: 'Agent Domains',
  emailA2aAgentDomainsPlaceholder: 'agents.example.com',
  emailA2aAgentDomainsHint: 'Domains allowed for agent collaboration, one per line',
  emailA2aMaxTurns: 'Max Ping-Pong Turns',
  emailConnected: 'Connected',
  emailDisconnected: 'Disconnected',
  emailSaveSuccess: 'Configuration saved',
  emailSaveError: 'Save failed',
  emailValidationError: 'Configuration validation failed',
  emailMaxInstancesExceeded: 'Maximum {count} email accounts supported',
  emailDuplicateEmail: 'Email address "{email}" is duplicated',
  emailDuplicateInstanceId: 'Instance ID "{id}" is duplicated',
  emailInvalidEmail: 'Invalid email address format',
  emailMissingPassword: 'Instance "{name}" uses IMAP mode but password is missing',
  emailMissingApiKey: 'Instance "{name}" uses WebSocket mode but API Key is missing',
  emailInvalidApiKey: 'Instance "{name}" has invalid API Key format (should start with ck_)',
  emailGatewayRestarting: 'Restarting OpenClaw Gateway...',
  emailDeleteConfirm: 'Delete email account "{name}"?',
  emailEnterValidEmailFirst: 'Please enter a valid email address first',
  emailVerifyInBrowserAndPaste: 'Please complete verification in browser, then paste API Key here',
  testConnection: 'Test Connection',
  emailTestSuccess: 'Connection test successful!',
  emailTestFailed: 'Connection test failed: {error}',
};
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 3: Commit English translations**

```bash
git add src/renderer/services/i18n.ts
git commit -m "feat(i18n): add English translations for email channel"
```

---

### Task 10: Add Plugin Declaration to package.json

**Files:**

- Modify: `package.json:10-56` (openclaw.plugins section)
- Spec ref: Design doc lines 397-405, 607-618

- [ ] **Step 1: Add email plugin to plugins array**

Find the `openclaw.plugins` array in `package.json` and add:

```json
{
  "openclaw": {
    "version": "v2026.3.2",
    "repo": "https://github.com/openclaw/openclaw.git",
    "plugins": [
      {
        "id": "dingtalk",
        "npm": "@soimy/dingtalk",
        "version": "3.4.0"
      },
      ...existing plugins...,
      {
        "id": "clawemail-email",
        "npm": "@clawemail/email",
        "version": "0.9.0"
      }
    ]
  }
}
```

- [ ] **Step 2: Verify JSON syntax**

Run: `npm run build`
Expected: No errors

- [ ] **Step 3: Commit plugin declaration**

```bash
git add package.json
git commit -m "feat(openclaw): add email channel plugin declaration"
```

---

## Chunk 4: Validation Utilities & IPC

### Task 11: Create Validation Utility

**Files:**

- Create: `src/renderer/utils/validation.ts`
- Spec ref: Design doc "Spec Review Corrections" #5, #9

- [ ] **Step 1: Create validation.ts file**

```typescript
/**
 * Email validation utility
 */
export const isValidEmail = (email: string): boolean => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 3: Commit validation utility**

```bash
git add src/renderer/utils/validation.ts
git commit -m "feat(utils): add email validation utility"
```

---

### Task 12: Add Test Connection IPC Handler

**Files:**

- Modify: `src/main/main.ts` (IPC handlers section)
- Spec ref: Design doc "Spec Review Corrections" #6

- [ ] **Step 1: Add test connection IPC handler**

Find the IPC handlers section (search for `ipcMain.handle`) and add:

```typescript
// Email: Test connection
ipcMain.handle('email:testConnection', async (event, { instanceId }: { instanceId: string }) => {
  try {
    const imManager = getIMGatewayManager();
    const imStore = imManager.getIMStore();
    const emailConfig = imStore.getEmailConfig();
    const instance = emailConfig.instances.find(i => i.instanceId === instanceId);

    if (!instance) {
      throw new Error('Instance not found');
    }

    if (instance.transport === 'imap') {
      // Test IMAP connection using node-imap
      const Imap = require('imap');
      const deriveImapHost = (email: string) => {
        const domain = email.split('@')[1];
        return `imap.${domain}`;
      };

      const connection = new Imap({
        user: instance.email,
        password: instance.password,
        host: instance.imapHost || deriveImapHost(instance.email),
        port: instance.imapPort || 993,
        tls: true,
      });

      await new Promise<void>((resolve, reject) => {
        connection.once('ready', () => {
          connection.end();
          resolve();
        });
        connection.once('error', reject);
        connection.connect();
      });
    } else if (instance.transport === 'ws') {
      // Test WebSocket connection by fetching token
      const { fetchIMToken } = require('@clawemail/node-sdk');
      await fetchIMToken(instance.apiKey!, instance.email, console);
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});
```

- [ ] **Step 2: Add type import for test connection**

At the top of `main.ts`, ensure email types are imported:

```typescript
import type { EmailMultiInstanceConfig } from './im/types';
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: No errors (imap and @clawemail/node-sdk are peer dependencies, runtime check only)

- [ ] **Step 4: Commit test connection handler**

```bash
git add src/main/main.ts
git commit -m "feat(ipc): add email test connection handler"
```

---

## Chunk 5: UI Component Implementation

### Task 13: Create EmailSettings Component (Part 1: Structure & State)

**Files:**

- Create: `src/renderer/components/settings/EmailSettings.tsx`
- Spec ref: Design doc lines 460-567

- [ ] **Step 1: Create component file with imports and types**

```typescript
import React, { useState, useEffect } from 'react';
import type {
  EmailMultiInstanceConfig,
  EmailInstanceConfig,
  EmailMultiInstanceStatus,
  EmailInstanceStatus,
} from '../../../main/im/types';
import { DEFAULT_EMAIL_INSTANCE_CONFIG, MAX_EMAIL_INSTANCES } from '../../../main/im/types';
import { isValidEmail } from '../../utils/validation';
import { t } from '../../services/i18n';

interface EmailSettingsProps {}

export const EmailSettings: React.FC<EmailSettingsProps> = () => {
  // State management
  const [emailConfig, setEmailConfig] = useState<EmailMultiInstanceConfig>({ instances: [] });
  const [emailStatus, setEmailStatus] = useState<EmailMultiInstanceStatus>({ instances: [] });
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [availableAgents, setAvailableAgents] = useState<Array<{ id: string; name: string }>>([
    { id: 'main', name: 'Main Agent' },
  ]);

  // Derived state
  const selectedInstance = emailConfig.instances.find(i => i.instanceId === selectedInstanceId);
  const selectedStatus = emailStatus.instances.find(s => s.instanceId === selectedInstanceId);

  // TODO: Add effect hooks for loading config/status
  // TODO: Add handler functions
  // TODO: Add render logic

  return <div>EmailSettings - TODO</div>;
};
```

- [ ] **Step 2: Verify TypeScript compilation**

Run: `npm run build`
Expected: No errors

- [ ] **Step 3: Commit component structure**

```bash
git add src/renderer/components/settings/EmailSettings.tsx
git commit -m "feat(ui): create EmailSettings component structure"
```

---

### Task 14: Create EmailSettings Component (Part 2: Data Loading)

**Files:**

- Modify: `src/renderer/components/settings/EmailSettings.tsx`
- Spec ref: Design doc lines 482-490

- [ ] **Step 1: Add config loading effect**

Replace the `// TODO: Add effect hooks` comment with:

```typescript
// Load configuration on mount
useEffect(() => {
  loadConfig();
  loadAvailableAgents();
}, []);

// Poll status every 5 seconds
useEffect(() => {
  loadStatus();
  const timer = setInterval(loadStatus, 5000);
  return () => clearInterval(timer);
}, []);

const loadConfig = async () => {
  try {
    const result = await window.electron.ipc.invoke('im:getConfig');
    if (result.success && result.config?.email) {
      setEmailConfig(result.config.email);
      if (result.config.email.instances.length > 0 && !selectedInstanceId) {
        setSelectedInstanceId(result.config.email.instances[0].instanceId);
      }
    }
  } catch (error) {
    console.error('[EmailSettings] Failed to load config:', error);
  }
};

const loadStatus = async () => {
  try {
    const result = await window.electron.ipc.invoke('im:getStatus');
    if (result.success && result.status?.email) {
      setEmailStatus(result.status.email);
    }
  } catch (error) {
    console.error('[EmailSettings] Failed to load status:', error);
  }
};

const loadAvailableAgents = async () => {
  try {
    // TODO: Implement cowork:listAgents IPC
    // For now, hardcode main agent
    setAvailableAgents([{ id: 'main', name: 'Main Agent' }]);
  } catch (error) {
    console.error('[EmailSettings] Failed to load agents:', error);
  }
};
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 3: Commit data loading**

```bash
git add src/renderer/components/settings/EmailSettings.tsx
git commit -m "feat(ui): add config/status loading to EmailSettings"
```

---

### Task 15: Create EmailSettings Component (Part 3: Validation & Handlers)

**Files:**

- Modify: `src/renderer/components/settings/EmailSettings.tsx`
- Spec ref: Design doc "Spec Review Corrections" #5, #7

- [ ] **Step 1: Add validation function**

Add before the render logic:

```typescript
const validateConfig = (): string[] => {
  const errors: string[] = [];

  if (emailConfig.instances.length > MAX_EMAIL_INSTANCES) {
    errors.push(t('emailMaxInstancesExceeded').replace('{count}', String(MAX_EMAIL_INSTANCES)));
  }

  const seenIds = new Set<string>();
  const seenEmails = new Set<string>();

  for (const inst of emailConfig.instances) {
    // Check required fields
    if (!inst.instanceId) {
      errors.push('Instance ID is required');
    }
    if (!inst.instanceName) {
      errors.push('Instance name is required');
    }
    if (!inst.email) {
      errors.push(t('emailInvalidEmail').replace('{email}', inst.instanceName || 'unnamed'));
      continue;
    }

    // Check email format
    if (!isValidEmail(inst.email)) {
      errors.push(t('emailInvalidEmail').replace('{email}', inst.email));
    }

    // Check duplicates
    if (seenIds.has(inst.instanceId)) {
      errors.push(t('emailDuplicateInstanceId').replace('{id}', inst.instanceId));
    }
    seenIds.add(inst.instanceId);

    if (seenEmails.has(inst.email)) {
      errors.push(t('emailDuplicateEmail').replace('{email}', inst.email));
    }
    seenEmails.add(inst.email);

    // Check transport-specific fields
    if (inst.transport === 'imap' && !inst.password) {
      errors.push(t('emailMissingPassword').replace('{name}', inst.instanceName));
    }

    if (inst.transport === 'ws') {
      if (!inst.apiKey) {
        errors.push(t('emailMissingApiKey').replace('{name}', inst.instanceName));
      } else if (!inst.apiKey.startsWith('ck_')) {
        errors.push(t('emailInvalidApiKey').replace('{name}', inst.instanceName));
      }
    }
  }

  return errors;
};
```

- [ ] **Step 2: Add handler functions**

Add after validation function:

```typescript
const handleAddInstance = () => {
  const newInstanceId = `email-${Date.now()}`;
  const newInstance: EmailInstanceConfig = {
    instanceId: newInstanceId,
    instanceName: `Email ${emailConfig.instances.length + 1}`,
    enabled: true,
    transport: 'imap',
    email: '',
    agentId: 'main',
    ...DEFAULT_EMAIL_INSTANCE_CONFIG,
  };

  setEmailConfig({
    instances: [...emailConfig.instances, newInstance],
  });
  setSelectedInstanceId(newInstanceId);
};

const handleDeleteInstance = (instanceId: string) => {
  const instance = emailConfig.instances.find(i => i.instanceId === instanceId);
  if (!instance) return;

  const confirmed = window.confirm(
    t('emailDeleteConfirm').replace('{name}', instance.instanceName),
  );

  if (confirmed) {
    const newInstances = emailConfig.instances.filter(i => i.instanceId !== instanceId);
    setEmailConfig({ instances: newInstances });

    if (selectedInstanceId === instanceId) {
      setSelectedInstanceId(newInstances.length > 0 ? newInstances[0].instanceId : null);
    }
  }
};

const handleUpdateInstance = (instanceId: string, updates: Partial<EmailInstanceConfig>) => {
  setEmailConfig({
    instances: emailConfig.instances.map(inst =>
      inst.instanceId === instanceId ? { ...inst, ...updates } : inst,
    ),
  });
};

const handleSave = async () => {
  try {
    setSaving(true);

    // Validate
    const errors = validateConfig();
    if (errors.length > 0) {
      alert(
        t('emailValidationError') + ':\n\n' + errors.map((e, i) => `${i + 1}. ${e}`).join('\n'),
      );
      return;
    }

    // Get full IM config
    const result = await window.electron.ipc.invoke('im:getConfig');
    if (!result.success) {
      throw new Error(result.error);
    }

    // Update email section
    const fullConfig = {
      ...result.config,
      email: emailConfig,
    };

    // Save config
    const saveResult = await window.electron.ipc.invoke('im:setConfig', fullConfig);
    if (!saveResult.success) {
      throw new Error(saveResult.error);
    }

    alert(t('emailSaveSuccess'));

    // Reload config to reflect any server-side changes
    await loadConfig();
  } catch (error) {
    alert(t('emailSaveError') + ': ' + (error instanceof Error ? error.message : String(error)));
  } finally {
    setSaving(false);
  }
};

const handleGetApiKey = async () => {
  if (!selectedInstance) return;

  const email = selectedInstance.email?.trim();
  if (!email || !isValidEmail(email)) {
    alert(t('emailEnterValidEmailFirst'));
    return;
  }

  const apiKeyUrl = `https://your-clawemail-service.com/get-apikey?email=${encodeURIComponent(email)}`;

  try {
    await window.electron.shell.openExternal(apiKeyUrl);
    alert(t('emailVerifyInBrowserAndPaste'));
  } catch (error) {
    alert('Failed to open browser. Please visit: ' + apiKeyUrl);
  }
};

const handleTestConnection = async () => {
  if (!selectedInstance) return;

  try {
    setTesting(selectedInstance.instanceId);

    const result = await window.electron.ipc.invoke('email:testConnection', {
      instanceId: selectedInstance.instanceId,
    });

    if (result.success) {
      alert(t('emailTestSuccess'));
    } else {
      alert(t('emailTestFailed').replace('{error}', result.error || 'Unknown error'));
    }
  } catch (error) {
    alert(
      t('emailTestFailed').replace(
        '{error}',
        error instanceof Error ? error.message : String(error),
      ),
    );
  } finally {
    setTesting(null);
  }
};
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 4: Commit validation and handlers**

```bash
git add src/renderer/components/settings/EmailSettings.tsx
git commit -m "feat(ui): add validation and event handlers to EmailSettings"
```

---

### Task 16: Create EmailSettings Component (Part 4: Render UI)

**Files:**

- Modify: `src/renderer/components/settings/EmailSettings.tsx`
- Spec ref: Design doc lines 460-567

- [ ] **Step 1: Replace render placeholder with full UI**

Replace `return <div>EmailSettings - TODO</div>;` with:

```typescript
  return (
    <div className="flex h-full bg-white dark:bg-gray-900">
      {/* Left: Instance list */}
      <div className="w-64 border-r border-gray-200 dark:border-gray-700 p-4 overflow-y-auto">
        <button
          onClick={handleAddInstance}
          disabled={emailConfig.instances.length >= MAX_EMAIL_INSTANCES}
          className="w-full px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed mb-4"
        >
          + {t('addEmailInstance')}
        </button>

        <div className="space-y-2">
          {emailConfig.instances.map(inst => {
            const status = emailStatus.instances.find(s => s.instanceId === inst.instanceId);
            const isSelected = selectedInstanceId === inst.instanceId;

            return (
              <div
                key={inst.instanceId}
                onClick={() => setSelectedInstanceId(inst.instanceId)}
                className={`p-3 rounded cursor-pointer border ${
                  isSelected
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                    : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium truncate">{inst.instanceName}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteInstance(inst.instanceId);
                    }}
                    className="text-red-500 hover:text-red-700"
                    title="Delete"
                  >
                    ×
                  </button>
                </div>
                <div className="text-xs text-gray-500 truncate">{inst.email}</div>
                <div className="flex items-center gap-2 mt-1">
                  <div className={`w-2 h-2 rounded-full ${status?.connected ? 'bg-green-500' : 'bg-gray-400'}`} />
                  <span className="text-xs">
                    {status?.connected ? t('emailConnected') : t('emailDisconnected')}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right: Instance detail form */}
      {selectedInstance ? (
        <div className="flex-1 p-6 overflow-y-auto">
          <h2 className="text-2xl font-bold mb-6">{selectedInstance.instanceName}</h2>

          {/* Basic config section - will be added in next step */}
          <div className="space-y-4">
            <p className="text-gray-500">TODO: Add form fields</p>
          </div>

          {/* Save button */}
          <div className="flex gap-2 mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={handleTestConnection}
              disabled={!selectedInstance.email || testing === selectedInstance.instanceId}
              className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {testing === selectedInstance.instanceId ? 'Testing...' : t('testConnection')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : t('save')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-gray-500">
          {emailConfig.instances.length === 0
            ? t('addEmailInstance')
            : 'Select an account to configure'}
        </div>
      )}
    </div>
  );
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 3: Commit UI structure**

```bash
git add src/renderer/components/settings/EmailSettings.tsx
git commit -m "feat(ui): add EmailSettings UI structure with instance list"
```

---

### Task 17: Create EmailSettings Component (Part 5: Basic Form Fields)

**Files:**

- Modify: `src/renderer/components/settings/EmailSettings.tsx`
- Spec ref: Design doc lines 512-567

- [ ] **Step 1: Replace "TODO: Add form fields" with basic config form**

Replace the `<p className="text-gray-500">TODO: Add form fields</p>` with:

```typescript
          {/* Instance Name */}
          <div>
            <label className="block text-sm font-medium mb-1">
              {t('emailInstanceName')}
            </label>
            <input
              type="text"
              value={selectedInstance.instanceName}
              onChange={(e) => handleUpdateInstance(selectedInstance.instanceId, { instanceName: e.target.value })}
              placeholder={t('emailInstanceNamePlaceholder')}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-800"
            />
          </div>

          {/* Transport Mode */}
          <div>
            <label className="block text-sm font-medium mb-1">
              {t('emailTransportMode')}
            </label>
            <div className="flex gap-4">
              <label className="flex items-center">
                <input
                  type="radio"
                  checked={selectedInstance.transport === 'imap'}
                  onChange={() => handleUpdateInstance(selectedInstance.instanceId, { transport: 'imap' })}
                  className="mr-2"
                />
                {t('emailTransportImap')}
              </label>
              <label className="flex items-center">
                <input
                  type="radio"
                  checked={selectedInstance.transport === 'ws'}
                  onChange={() => handleUpdateInstance(selectedInstance.instanceId, { transport: 'ws' })}
                  className="mr-2"
                />
                {t('emailTransportWs')}
              </label>
            </div>
          </div>

          {/* Email Address */}
          <div>
            <label className="block text-sm font-medium mb-1">
              {t('emailAddress')}
            </label>
            <input
              type="email"
              value={selectedInstance.email}
              onChange={(e) => handleUpdateInstance(selectedInstance.instanceId, { email: e.target.value })}
              placeholder={t('emailAddressPlaceholder')}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-800"
            />
          </div>

          {/* IMAP Mode: Password */}
          {selectedInstance.transport === 'imap' && (
            <div>
              <label className="block text-sm font-medium mb-1">
                {t('emailPassword')}
              </label>
              <input
                type="password"
                value={selectedInstance.password || ''}
                onChange={(e) => handleUpdateInstance(selectedInstance.instanceId, { password: e.target.value })}
                placeholder={t('emailPasswordPlaceholder')}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-800"
              />
            </div>
          )}

          {/* WebSocket Mode: API Key */}
          {selectedInstance.transport === 'ws' && (
            <div>
              <label className="block text-sm font-medium mb-1">
                {t('emailApiKey')}
              </label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={selectedInstance.apiKey || ''}
                  onChange={(e) => handleUpdateInstance(selectedInstance.instanceId, { apiKey: e.target.value })}
                  placeholder={t('emailApiKeyPlaceholder')}
                  className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-800"
                />
                <button
                  onClick={handleGetApiKey}
                  className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 whitespace-nowrap"
                >
                  {t('getApiKey')}
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-1">{t('apiKeyHint')}</p>
            </div>
          )}

          {/* Agent Binding */}
          <div>
            <label className="block text-sm font-medium mb-1">
              {t('emailAgentBinding')}
            </label>
            <select
              value={selectedInstance.agentId}
              onChange={(e) => handleUpdateInstance(selectedInstance.instanceId, { agentId: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-800"
            >
              {availableAgents.map(agent => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">{t('emailAgentBindingHint')}</p>
          </div>

          {/* Whitelist */}
          <div>
            <label className="block text-sm font-medium mb-1">
              {t('emailAllowFrom')}
            </label>
            <textarea
              value={(selectedInstance.allowFrom || []).join('\n')}
              onChange={(e) => handleUpdateInstance(selectedInstance.instanceId, {
                allowFrom: e.target.value.split('\n').filter(Boolean),
              })}
              placeholder={t('emailAllowFromPlaceholder')}
              rows={4}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-800 font-mono text-sm"
            />
            <p className="text-xs text-gray-500 mt-1">{t('emailAllowFromHint')}</p>
          </div>
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 3: Commit basic form fields**

```bash
git add src/renderer/components/settings/EmailSettings.tsx
git commit -m "feat(ui): add basic form fields to EmailSettings"
```

---

### Task 18: Create EmailSettings Component (Part 6: Advanced Options)

**Files:**

- Modify: `src/renderer/components/settings/EmailSettings.tsx`
- Spec ref: Design doc lines 534-549

- [ ] **Step 1: Add advanced options collapsible section**

Add after the whitelist field (before the Save button section):

```typescript
          {/* Advanced Options */}
          <details className="mt-6">
            <summary className="cursor-pointer font-medium text-blue-500 hover:text-blue-600">
              {t('emailAdvancedOptions')}
            </summary>

            <div className="mt-4 space-y-4 pl-4 border-l-2 border-gray-200 dark:border-gray-700">
              {/* IMAP/SMTP Config (IMAP mode only) */}
              {selectedInstance.transport === 'imap' && (
                <div className="space-y-4">
                  <h4 className="font-medium">{t('emailImapSmtpConfig')}</h4>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm mb-1">{t('emailImapHost')}</label>
                      <input
                        type="text"
                        value={selectedInstance.imapHost || ''}
                        onChange={(e) => handleUpdateInstance(selectedInstance.instanceId, { imapHost: e.target.value })}
                        placeholder="imap.example.com"
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-800"
                      />
                    </div>
                    <div>
                      <label className="block text-sm mb-1">{t('emailImapPort')}</label>
                      <input
                        type="number"
                        value={selectedInstance.imapPort || ''}
                        onChange={(e) => handleUpdateInstance(selectedInstance.instanceId, { imapPort: parseInt(e.target.value) || undefined })}
                        placeholder="993"
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-800"
                      />
                    </div>
                    <div>
                      <label className="block text-sm mb-1">{t('emailSmtpHost')}</label>
                      <input
                        type="text"
                        value={selectedInstance.smtpHost || ''}
                        onChange={(e) => handleUpdateInstance(selectedInstance.instanceId, { smtpHost: e.target.value })}
                        placeholder="smtp.example.com"
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-800"
                      />
                    </div>
                    <div>
                      <label className="block text-sm mb-1">{t('emailSmtpPort')}</label>
                      <input
                        type="number"
                        value={selectedInstance.smtpPort || ''}
                        onChange={(e) => handleUpdateInstance(selectedInstance.instanceId, { smtpPort: parseInt(e.target.value) || undefined })}
                        placeholder="465"
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-800"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-gray-500">{t('emailServerConfigHint')}</p>
                </div>
              )}

              {/* Reply Strategy */}
              <div className="space-y-4">
                <h4 className="font-medium">{t('emailReplyStrategy')}</h4>

                <div>
                  <label className="block text-sm mb-1">{t('emailReplyMode')}</label>
                  <select
                    value={selectedInstance.replyMode || 'complete'}
                    onChange={(e) => handleUpdateInstance(selectedInstance.instanceId, { replyMode: e.target.value as any })}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-800"
                  >
                    <option value="immediate">{t('emailReplyModeImmediate')}</option>
                    <option value="accumulated">{t('emailReplyModeAccumulated')}</option>
                    <option value="complete">{t('emailReplyModeComplete')}</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm mb-1">{t('emailReplyTo')}</label>
                  <div className="flex gap-4">
                    <label className="flex items-center">
                      <input
                        type="radio"
                        checked={selectedInstance.replyTo === 'sender'}
                        onChange={() => handleUpdateInstance(selectedInstance.instanceId, { replyTo: 'sender' })}
                        className="mr-2"
                      />
                      {t('emailReplyToSender')}
                    </label>
                    <label className="flex items-center">
                      <input
                        type="radio"
                        checked={selectedInstance.replyTo === 'all'}
                        onChange={() => handleUpdateInstance(selectedInstance.instanceId, { replyTo: 'all' })}
                        className="mr-2"
                      />
                      {t('emailReplyToAll')}
                    </label>
                  </div>
                </div>
              </div>

              {/* A2A Config */}
              <div className="space-y-4">
                <h4 className="font-medium">{t('emailA2aConfig')}</h4>

                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={selectedInstance.a2aEnabled ?? false}
                    onChange={(e) => handleUpdateInstance(selectedInstance.instanceId, { a2aEnabled: e.target.checked })}
                    className="mr-2"
                  />
                  {t('emailA2aEnabled')}
                </label>

                {selectedInstance.a2aEnabled && (
                  <>
                    <div>
                      <label className="block text-sm mb-1">{t('emailA2aAgentDomains')}</label>
                      <textarea
                        value={(selectedInstance.a2aAgentDomains || []).join('\n')}
                        onChange={(e) => handleUpdateInstance(selectedInstance.instanceId, {
                          a2aAgentDomains: e.target.value.split('\n').filter(Boolean),
                        })}
                        placeholder={t('emailA2aAgentDomainsPlaceholder')}
                        rows={3}
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-800 font-mono text-sm"
                      />
                      <p className="text-xs text-gray-500 mt-1">{t('emailA2aAgentDomainsHint')}</p>
                    </div>

                    <div>
                      <label className="block text-sm mb-1">{t('emailA2aMaxTurns')}</label>
                      <input
                        type="number"
                        value={selectedInstance.a2aMaxPingPongTurns || 20}
                        onChange={(e) => handleUpdateInstance(selectedInstance.instanceId, { a2aMaxPingPongTurns: parseInt(e.target.value) || 20 })}
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-800"
                      />
                    </div>
                  </>
                )}
              </div>
            </div>
          </details>
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 3: Commit advanced options**

```bash
git add src/renderer/components/settings/EmailSettings.tsx
git commit -m "feat(ui): add advanced options collapsible section to EmailSettings"
```

---

## Final Integration & Testing

### Task 19: Integrate EmailSettings into Settings Router

**Files:**

- Modify: `src/renderer/App.tsx` or relevant settings router file
- Spec ref: Design doc "Implementation Details"

- [ ] **Step 1: Import EmailSettings component**

Find the Settings component imports and add:

```typescript
import { EmailSettings } from './components/settings/EmailSettings';
```

- [ ] **Step 2: Add email tab to settings navigation**

Find the settings tabs/routes and add email entry (exact location depends on your router setup):

```typescript
// Example for tab-based settings:
<Tab label="Email" />

// Example for route-based settings:
<Route path="/settings/email" element={<EmailSettings />} />
```

- [ ] **Step 3: Verify app builds and runs**

Run: `npm run build && npm run electron:dev`
Expected: App starts, Settings has Email tab

- [ ] **Step 4: Commit router integration**

```bash
git add src/renderer/App.tsx
git commit -m "feat(ui): integrate EmailSettings into Settings navigation"
```

---

### Task 20: Manual Testing Checklist

**Files:**

- None (testing task)
- Spec ref: Design doc "Testing Strategy"

- [ ] **Step 1: Test add/delete instance**

1. Open Settings → Email
2. Click "Add Email Account"
3. Verify new instance appears in left panel
4. Click × to delete
5. Confirm deletion dialog works

- [ ] **Step 2: Test IMAP configuration**

1. Add instance
2. Select IMAP mode
3. Fill email and password
4. Click "Test Connection"
5. Verify test result (requires valid credentials)

- [ ] **Step 3: Test WebSocket configuration**

1. Add instance
2. Select WebSocket mode
3. Fill email
4. Click "Get API Key"
5. Verify browser opens (or shows fallback)
6. Paste apiKey (format: ck\_\*)
7. Click "Test Connection"

- [ ] **Step 4: Test validation**

1. Try to save with empty email → verify error
2. Try to save with duplicate email → verify error
3. Try IMAP without password → verify error
4. Try WS with invalid apiKey (no ck\_ prefix) → verify error
5. Try to add 6th instance → verify button disabled

- [ ] **Step 5: Test agent binding**

1. Set different agentId for each instance
2. Save config
3. Send test email to both accounts
4. Verify sessions appear under correct agents

- [ ] **Step 6: Test advanced options**

1. Expand Advanced Options
2. Fill custom IMAP/SMTP hosts
3. Change reply mode/replyTo
4. Enable A2A with custom domains
5. Save and verify openclaw.json reflects changes

- [ ] **Step 7: Test config persistence**

1. Configure 2 email instances
2. Save
3. Restart app
4. Verify config persists

- [ ] **Step 8: Document test results**

Create summary: all tests passed / issues found

---

### Task 21: Final Commit & Documentation

**Files:**

- None (commit message only)

- [ ] **Step 1: Run linter**

Run: `npm run lint`
Expected: No errors (fix any found)

- [ ] **Step 2: Create final feature commit**

```bash
git add -A
git commit -m "feat(email-channel): complete email channel integration

- Add email channel type definitions (EmailInstanceConfig, etc.)
- Extend IMGatewayConfig to include optional email field
- Add email platform enum and registry mappings
- Implement IMStore getEmailConfig/setEmailConfig methods
- Add email configuration sync to OpenClaw (channels.email)
- Add email environment variable management
- Implement email session mapping with account-level agent binding
- Add Chinese and English i18n translations for email channel
- Declare @clawemail/email plugin in package.json
- Create email validation utility (isValidEmail)
- Add email:testConnection IPC handler
- Create EmailSettings UI component with:
  - Multi-instance list management
  - Basic config (transport, email, password/apiKey, agent, whitelist)
  - Advanced options (IMAP/SMTP, reply strategy, A2A)
  - Validation and error handling
  - Test connection and save functionality
- Integrate EmailSettings into Settings navigation

Implements spec: docs/superpowers/specs/2026-04-09-email-channel-integration-design.md
Closes: email-channel-integration"
```

- [ ] **Step 3: Update implementation plan status**

Mark plan as completed in `docs/superpowers/plans/2026-04-09-email-channel-integration.md`

---

## Execution Notes

**Total Tasks:** 21
**Estimated Time:** 4-6 hours (assuming no major blockers)

**Prerequisites:**

- `@clawemail/email` plugin available (npm or local path)
- `imap` npm package installed (for test connection)
- `@clawemail/node-sdk` available (for WebSocket test)

**Development Workflow:**

1. Use `npm run electron:dev:openclaw` to test with OpenClaw
2. Check OpenClaw logs for plugin loading: `~/.local/state/openclaw/logs/`
3. Use browser DevTools (Renderer) and terminal (Main) for debugging

**Environment Setup for Testing:**

```bash
# Use local email plugin during development
export CLAWEMAIL_LOCAL_PATH=/home/gzlicanyi/work/git/claw-mail-channel/extensions/email

# Install OpenClaw with email plugin
npm run openclaw:plugins

# Start development environment
npm run electron:dev:openclaw
```

**Common Issues:**

- If email plugin doesn't load, check `openclaw.json` was generated correctly
- If test connection fails, check credentials and network (IMAP ports: 993/143, SMTP: 465/587)
- If sessions don't appear, check `parseChannelSessionKey` handles email format correctly

---

**Plan Status:** Ready for execution ✅

Use `superpowers:subagent-driven-development` (if subagents available) or `superpowers:executing-plans` to implement this plan.
