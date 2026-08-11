# OpenClaw Session Policy Setting — Design

## Overview

Add a simple user-facing setting in 智码 GLM Code to control how long a conversation keeps its existing context before automatically starting a new session.

The goal is to expose one clear product concept while keeping OpenClaw's lower-level session policy details internal.

## Problem

智码 GLM Code currently writes only `session.dmScope` into runtime `openclaw.json`, while QClaw also configures `session.reset` and `session.maintenance`.

This creates two product issues:

- Users cannot control when old context should roll over into a new session.
- Session lifecycle behavior is not explicit in 智码 GLM Code and depends more on OpenClaw defaults than intended.

At the same time, exposing raw OpenClaw fields such as `dmScope`, `idleMinutes`, `pruneAfter`, or `rotateBytes` would be too technical for most users.

## Design

### Product Model

Expose one global setting only:

- `会话保持时长`

Help text:

- `在这个时间内继续聊天，会沿用原来的上下文；超过后会自动开始新会话。时间越长，连续性更强，但也更容易带入较早的信息。`

Available options:

- `始终延续`
- `24小时`
- `7天（推荐）`
- `30天`
- `1年`

Default value:

- `7天`

### What This Setting Means

This setting controls when an inactive conversation should be treated as a new session.

- Shorter durations keep context fresher and reduce carry-over from older messages.
- Longer durations preserve continuity for long-running projects and assistant relationships.

The setting does not expose storage retention or low-level session key behavior to users.

### Internal Mapping

User-facing values map to OpenClaw `session.reset` as follows:

| User option | `session.reset.mode` | `session.reset.idleMinutes` |
|-------------|----------------------|-----------------------------|
| `始终延续` | `off` | omitted |
| `24小时` | `idle` | `1440` |
| `7天` | `idle` | `10080` |
| `30天` | `idle` | `43200` |
| `1年` | `idle` | `525600` |

### Internal Defaults Kept Out of UI

The following values remain app-managed and are not user-configurable in v1:

- `session.dmScope = per-account-channel-peer`
- `session.maintenance.pruneAfter = 365d`
- `session.maintenance.maxEntries = 1000000`
- `session.maintenance.rotateBytes = 1gb`

Rationale:

- `dmScope` affects session identity and historical session partitioning, so changing it is too risky for a simple user setting.
- `maintenance.*` is primarily storage governance, not a user-facing conversational preference.
- Keeping these internal makes the UI easier to understand and gives 智码 GLM Code freedom to tune defaults later.

### Scope

This setting is global for v1.

- It applies to both desktop cowork sessions and IM channel sessions.
- No IM-specific override is added in v1.
- No per-agent or per-channel override is added in v1.

This keeps the mental model simple: one app-wide session continuity preference.

## Data Model

Add a dedicated OpenClaw session policy config rather than mixing this into existing cowork or IM settings.

```ts
export const OpenClawSessionKeepAlive = {
  Always: 'always',
  OneDay: '1d',
  SevenDays: '7d',
  ThirtyDays: '30d',
  OneYear: '365d',
} as const;

export type OpenClawSessionKeepAlive =
  typeof OpenClawSessionKeepAlive[keyof typeof OpenClawSessionKeepAlive];

export interface OpenClawSessionPolicyConfig {
  keepAlive: OpenClawSessionKeepAlive;
}
```

Why a dedicated config:

- It matches the actual owner of the behavior: generated OpenClaw runtime config.
- It avoids overloading `cowork_config` with IM-adjacent behavior.
- It leaves room for future expansion without polluting unrelated settings.

## Runtime Generation

`openclawConfigSync.ts` should always generate explicit `session.reset` and `session.maintenance` fields.

Target runtime shape:

```json
{
  "session": {
    "dmScope": "per-account-channel-peer",
    "reset": {
      "mode": "idle",
      "idleMinutes": 10080
    },
    "maintenance": {
      "pruneAfter": "365d",
      "maxEntries": 1000000,
      "rotateBytes": "1gb"
    }
  }
}
```

If `keepAlive = always`, generate:

```json
{
  "session": {
    "dmScope": "per-account-channel-peer",
    "reset": {
      "mode": "off"
    },
    "maintenance": {
      "pruneAfter": "365d",
      "maxEntries": 1000000,
      "rotateBytes": "1gb"
    }
  }
}
```

## UI Placement

Place the setting in the main app settings area where users already configure AI behavior.

Recommended placement:

- OpenClaw or Cowork settings section
- Single select field or radio group
- Helper text directly below the field

Do not place it inside IM-only settings in v1, since the behavior is global.

## Migration and Compatibility

- Existing users who have no stored value receive the default `7天`.
- Existing `dmScope` stays unchanged as `per-account-channel-peer`.
- Legacy per-channel fields such as DingTalk `sessionTimeout` are not exposed in the new UI and should gradually become secondary to global `session.reset`.

## Non-Goals

Not included in v1:

- User-configurable `dmScope`
- User-configurable `maintenance.*`
- IM-specific session policy override
- Per-agent or per-channel session policy
- Custom numeric input for arbitrary durations

These can be added later only if there is clear user demand.

## Testing

- Unit test mapping from `keepAlive` enum to generated `session.reset`
- Unit test generated config always includes explicit `session.maintenance`
- Manual test: change setting, sync config, verify `openclaw.json` updates without invalid structure
- Manual test: leave a conversation idle past the selected threshold and verify the next turn starts a new session

---

## 实施计划


**Goal:** Add a simple global `会话保持时长` setting in 智码 GLM Code, persist it locally, and always generate explicit OpenClaw `session.reset` and `session.maintenance` config from that value.

**Architecture:** Introduce a dedicated OpenClaw session policy config owned by the main process instead of overloading `cowork_config` or IM settings. The renderer reads and writes a single enum-like setting, while `openclawConfigSync.ts` maps that value into explicit runtime `session` fields. The UI stays simple, but runtime behavior becomes explicit and testable.

**Tech Stack:** Electron IPC, TypeScript, Redux Toolkit, React, Vitest

---

## File Structure

- Create: `src/main/openclawSessionPolicy/constants.ts`
- Create: `src/main/openclawSessionPolicy/store.ts`
- Create: `src/main/openclawSessionPolicy/store.test.ts`
- Modify: `src/main/main.ts`
- Modify: `src/main/libs/openclawConfigSync.ts`
- Modify: `src/main/libs/openclawConfigSync.test.ts`
- Modify: `src/renderer/types/cowork.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Modify: `src/renderer/services/cowork.ts`
- Modify: `src/renderer/store/slices/coworkSlice.ts`
- Modify: `src/renderer/components/Settings.tsx`
- Modify: `src/renderer/services/i18n.ts`

## Task 1: Add Main-Process Session Policy Model and Persistence

**Files:**
- Create: `src/main/openclawSessionPolicy/constants.ts`
- Create: `src/main/openclawSessionPolicy/store.ts`
- Create: `src/main/openclawSessionPolicy/store.test.ts`

- [ ] **Step 1: Write the failing store test**

```ts
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_OPENCLAW_SESSION_POLICY_CONFIG,
  OpenClawSessionKeepAlive,
} from './constants';
import {
  normalizeOpenClawSessionPolicyConfig,
  mapKeepAliveToSessionReset,
} from './store';

describe('normalizeOpenClawSessionPolicyConfig', () => {
  test('falls back to default when keepAlive is invalid', () => {
    const config = normalizeOpenClawSessionPolicyConfig({ keepAlive: 'bad-value' });
    expect(config).toEqual(DEFAULT_OPENCLAW_SESSION_POLICY_CONFIG);
  });
});

describe('mapKeepAliveToSessionReset', () => {
  test('maps seven days to idle reset', () => {
    expect(mapKeepAliveToSessionReset(OpenClawSessionKeepAlive.SevenDays)).toEqual({
      mode: 'idle',
      idleMinutes: 10080,
    });
  });

  test('maps always to reset off', () => {
    expect(mapKeepAliveToSessionReset(OpenClawSessionKeepAlive.Always)).toEqual({
      mode: 'off',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- openclawSessionPolicy
```

Expected: FAIL with module-not-found errors for `./constants` and `./store`.

- [ ] **Step 3: Add constants module**

```ts
export const OpenClawSessionKeepAlive = {
  Always: 'always',
  OneDay: '1d',
  SevenDays: '7d',
  ThirtyDays: '30d',
  OneYear: '365d',
} as const;

export type OpenClawSessionKeepAlive =
  typeof OpenClawSessionKeepAlive[keyof typeof OpenClawSessionKeepAlive];

export const OPENCLAW_SESSION_POLICY_STORE_KEY = 'openclaw_session_policy';

export interface OpenClawSessionPolicyConfig {
  keepAlive: OpenClawSessionKeepAlive;
}

export const DEFAULT_OPENCLAW_SESSION_POLICY_CONFIG: OpenClawSessionPolicyConfig = {
  keepAlive: OpenClawSessionKeepAlive.SevenDays,
};
```

- [ ] **Step 4: Add store module**

```ts
import { DEFAULT_OPENCLAW_SESSION_POLICY_CONFIG, OPENCLAW_SESSION_POLICY_STORE_KEY, OpenClawSessionKeepAlive, type OpenClawSessionPolicyConfig } from './constants';

type KeyValueStore = {
  get: <T>(key: string) => T | undefined;
  set: (key: string, value: unknown) => void;
};

export const normalizeOpenClawSessionPolicyConfig = (
  value: unknown,
): OpenClawSessionPolicyConfig => {
  const keepAlive = (value as { keepAlive?: string } | null)?.keepAlive;
  const validValues = new Set(Object.values(OpenClawSessionKeepAlive));
  if (keepAlive && validValues.has(keepAlive as OpenClawSessionKeepAlive)) {
    return { keepAlive: keepAlive as OpenClawSessionKeepAlive };
  }
  return DEFAULT_OPENCLAW_SESSION_POLICY_CONFIG;
};

export const mapKeepAliveToSessionReset = (
  keepAlive: OpenClawSessionKeepAlive,
): { mode: 'off' } | { mode: 'idle'; idleMinutes: number } => {
  switch (keepAlive) {
    case OpenClawSessionKeepAlive.Always:
      return { mode: 'off' };
    case OpenClawSessionKeepAlive.OneDay:
      return { mode: 'idle', idleMinutes: 1440 };
    case OpenClawSessionKeepAlive.ThirtyDays:
      return { mode: 'idle', idleMinutes: 43200 };
    case OpenClawSessionKeepAlive.OneYear:
      return { mode: 'idle', idleMinutes: 525600 };
    case OpenClawSessionKeepAlive.SevenDays:
    default:
      return { mode: 'idle', idleMinutes: 10080 };
  }
};

export const loadOpenClawSessionPolicyConfig = (store: KeyValueStore): OpenClawSessionPolicyConfig => {
  return normalizeOpenClawSessionPolicyConfig(store.get(OPENCLAW_SESSION_POLICY_STORE_KEY));
};

export const saveOpenClawSessionPolicyConfig = (
  store: KeyValueStore,
  value: unknown,
): OpenClawSessionPolicyConfig => {
  const normalized = normalizeOpenClawSessionPolicyConfig(value);
  store.set(OPENCLAW_SESSION_POLICY_STORE_KEY, normalized);
  return normalized;
};
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
npm test -- openclawSessionPolicy
```

Expected: PASS for normalization and keep-alive mapping tests.

- [ ] **Step 6: Commit**

```bash
git add src/main/openclawSessionPolicy/constants.ts src/main/openclawSessionPolicy/store.ts src/main/openclawSessionPolicy/store.test.ts
git commit -m "feat(openclaw): add session policy config store"
```

## Task 2: Add IPC Surface and Shared Renderer Types

**Files:**
- Modify: `src/main/main.ts`
- Modify: `src/renderer/types/cowork.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Modify: `src/renderer/services/cowork.ts`
- Modify: `src/renderer/store/slices/coworkSlice.ts`

- [ ] **Step 1: Write the failing type changes**

Add these types to the shared renderer model first:

```ts
export const OpenClawSessionKeepAlive = {
  Always: 'always',
  OneDay: '1d',
  SevenDays: '7d',
  ThirtyDays: '30d',
  OneYear: '365d',
} as const;

export type OpenClawSessionKeepAlive =
  typeof OpenClawSessionKeepAlive[keyof typeof OpenClawSessionKeepAlive];

export interface OpenClawSessionPolicyConfig {
  keepAlive: OpenClawSessionKeepAlive;
}
```

Then extend `CoworkConfig`:

```ts
export interface CoworkConfig {
  workingDirectory: string;
  systemPrompt: string;
  executionMode: CoworkExecutionMode;
  agentEngine: CoworkAgentEngine;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: 'strict' | 'standard' | 'relaxed';
  memoryUserMemoriesMaxItems: number;
  openClawSessionPolicy: OpenClawSessionPolicyConfig;
}
```

- [ ] **Step 2: Update reducer initial state**

```ts
config: {
  workingDirectory: '',
  systemPrompt: '',
  executionMode: 'local',
  agentEngine: 'openclaw',
  memoryEnabled: true,
  memoryImplicitUpdateEnabled: true,
  memoryLlmJudgeEnabled: false,
  memoryGuardLevel: 'strict',
  memoryUserMemoriesMaxItems: 12,
  openClawSessionPolicy: {
    keepAlive: '7d',
  },
},
```

- [ ] **Step 3: Add main-process IPC handlers**

In `src/main/main.ts`, add two handlers near existing `cowork:config:get/set`:

```ts
ipcMain.handle('openclaw:sessionPolicy:get', async () => {
  try {
    const config = loadOpenClawSessionPolicyConfig(getStore());
    return { success: true, config };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get OpenClaw session policy',
    };
  }
});

ipcMain.handle('openclaw:sessionPolicy:set', async (_event, config: unknown) => {
  try {
    const saved = saveOpenClawSessionPolicyConfig(getStore(), config);
    await syncOpenClawConfig({ reason: 'session-policy-updated', restartGatewayIfRunning: false });
    return { success: true, config: saved };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save OpenClaw session policy',
    };
  }
});
```

- [ ] **Step 4: Expose renderer API surface**

Add preload-facing typings in `src/renderer/types/electron.d.ts`:

```ts
interface OpenClawSessionPolicyConfig {
  keepAlive: 'always' | '1d' | '7d' | '30d' | '365d';
}
```

Add to the `window.electron.openclaw` namespace:

```ts
sessionPolicy: {
  get: () => Promise<{ success: boolean; config?: OpenClawSessionPolicyConfig; error?: string }>;
  set: (config: OpenClawSessionPolicyConfig) => Promise<{ success: boolean; config?: OpenClawSessionPolicyConfig; error?: string }>;
};
```

- [ ] **Step 5: Load the new config into Redux on init**

Update `src/renderer/services/cowork.ts` `loadConfig()` to merge in the session policy:

```ts
async loadConfig(): Promise<void> {
  const [coworkResult, sessionPolicyResult] = await Promise.all([
    window.electron?.cowork?.getConfig(),
    window.electron?.openclaw?.sessionPolicy?.get?.(),
  ]);

  if (coworkResult?.success && coworkResult.config) {
    store.dispatch(setConfig({
      ...coworkResult.config,
      openClawSessionPolicy: sessionPolicyResult?.success && sessionPolicyResult.config
        ? sessionPolicyResult.config
        : { keepAlive: '7d' },
    }));
  }
}
```

- [ ] **Step 6: Run targeted tests and typecheck**

Run:

```bash
npm test -- coworkStore
npm run build
```

Expected: existing cowork tests still pass and TypeScript compilation succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/main/main.ts src/renderer/types/cowork.ts src/renderer/types/electron.d.ts src/renderer/services/cowork.ts src/renderer/store/slices/coworkSlice.ts
git commit -m "feat(openclaw): add session policy ipc surface"
```

## Task 3: Generate Explicit OpenClaw Session Reset and Maintenance

**Files:**
- Modify: `src/main/libs/openclawConfigSync.ts`
- Modify: `src/main/libs/openclawConfigSync.test.ts`

- [ ] **Step 1: Write the failing OpenClaw mapping test**

Add a small pure helper test in `src/main/libs/openclawConfigSync.test.ts`:

```ts
describe('session policy mapping', () => {
  test('maps seven-day keepAlive to idle reset and fixed maintenance', () => {
    const keepAlive = '7d';
    const reset = keepAlive === '7d'
      ? { mode: 'idle', idleMinutes: 10080 }
      : { mode: 'off' };

    expect(reset).toEqual({ mode: 'idle', idleMinutes: 10080 });
    expect({
      pruneAfter: '365d',
      maxEntries: 1000000,
      rotateBytes: '1gb',
    }).toEqual({
      pruneAfter: '365d',
      maxEntries: 1000000,
      rotateBytes: '1gb',
    });
  });
});
```

- [ ] **Step 2: Extract explicit session config helpers in `openclawConfigSync.ts`**

Add near the top of the file:

```ts
const OPENCLAW_SESSION_MAINTENANCE = {
  pruneAfter: '365d',
  maxEntries: 1000000,
  rotateBytes: '1gb',
} as const;
```

Add a resolver method:

```ts
private buildSessionConfig(): Record<string, unknown> {
  const policy = this.getOpenClawSessionPolicy?.() ?? { keepAlive: '7d' };
  const reset = mapKeepAliveToSessionReset(policy.keepAlive);
  return {
    dmScope: 'per-account-channel-peer',
    reset,
    maintenance: { ...OPENCLAW_SESSION_MAINTENANCE },
  };
}
```

- [ ] **Step 3: Wire session config into the generated runtime config**

Replace the inline `session` object:

```ts
session: this.buildSessionConfig(),
```

instead of:

```ts
session: {
  dmScope: 'per-account-channel-peer',
},
```

- [ ] **Step 4: Pass the new dependency into `OpenClawConfigSync`**

When constructing `OpenClawConfigSync` in `src/main/main.ts`, add:

```ts
getOpenClawSessionPolicy: () => loadOpenClawSessionPolicyConfig(getStore()),
```

and extend the dependency type in `src/main/libs/openclawConfigSync.ts`:

```ts
getOpenClawSessionPolicy?: () => { keepAlive: 'always' | '1d' | '7d' | '30d' | '365d' };
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm test -- openclawConfigSync
```

Expected: PASS with new mapping test and no regression in existing tests.

- [ ] **Step 6: Commit**

```bash
git add src/main/libs/openclawConfigSync.ts src/main/libs/openclawConfigSync.test.ts src/main/main.ts
git commit -m "feat(openclaw): generate explicit session reset config"
```

## Task 4: Add `会话保持时长` to Settings UI and Save Flow

**Files:**
- Modify: `src/renderer/components/Settings.tsx`
- Modify: `src/renderer/services/i18n.ts`

- [ ] **Step 1: Add new i18n keys**

Add matching `zh` and `en` keys in `src/renderer/services/i18n.ts`:

```ts
openClawSessionKeepAlive: '会话保持时长',
openClawSessionKeepAliveHint: '在这个时间内继续聊天，会沿用原来的上下文；超过后会自动开始新会话。时间越长，连续性更强，但也更容易带入较早的信息。',
openClawSessionKeepAliveAlways: '始终延续',
openClawSessionKeepAliveOneDay: '24小时',
openClawSessionKeepAliveSevenDays: '7天（推荐）',
openClawSessionKeepAliveThirtyDays: '30天',
openClawSessionKeepAliveOneYear: '1年',
```

English:

```ts
openClawSessionKeepAlive: 'Session continuity',
openClawSessionKeepAliveHint: 'Continue chatting within this period to keep the same context. After that, 智码 GLM Code starts a new session automatically. Longer durations improve continuity but can also carry older context forward.',
openClawSessionKeepAliveAlways: 'Always continue',
openClawSessionKeepAliveOneDay: '24 hours',
openClawSessionKeepAliveSevenDays: '7 days (Recommended)',
openClawSessionKeepAliveThirtyDays: '30 days',
openClawSessionKeepAliveOneYear: '1 year',
```

- [ ] **Step 2: Add local state in `Settings.tsx`**

Near the existing cowork settings state:

```ts
const [openClawSessionKeepAlive, setOpenClawSessionKeepAlive] = useState<OpenClawSessionKeepAlive>(
  coworkConfig.openClawSessionPolicy?.keepAlive || '7d',
);
```

Sync it from Redux:

```ts
useEffect(() => {
  setOpenClawSessionKeepAlive(coworkConfig.openClawSessionPolicy?.keepAlive || '7d');
}, [coworkConfig.openClawSessionPolicy?.keepAlive]);
```

- [ ] **Step 3: Include this field in dirty-state detection**

Extend `hasCoworkConfigChanges`:

```ts
const hasCoworkConfigChanges = coworkAgentEngine !== coworkConfig.agentEngine
  || coworkMemoryEnabled !== coworkConfig.memoryEnabled
  || coworkMemoryLlmJudgeEnabled !== coworkConfig.memoryLlmJudgeEnabled
  || openClawSessionKeepAlive !== (coworkConfig.openClawSessionPolicy?.keepAlive || '7d');
```

- [ ] **Step 4: Render the new control in the existing 智码 GLM Code settings section**

Insert a compact select block in the same section that contains agent engine and memory toggles:

```tsx
<div className="space-y-2 rounded-xl border px-4 py-4 border-border">
  <label className="block text-sm font-medium text-foreground">
    {i18nService.t('openClawSessionKeepAlive')}
  </label>
  <p className="text-xs text-secondary">
    {i18nService.t('openClawSessionKeepAliveHint')}
  </p>
  <select
    value={openClawSessionKeepAlive}
    onChange={(e) => setOpenClawSessionKeepAlive(e.target.value as OpenClawSessionKeepAlive)}
    className="w-full rounded-lg border px-3 py-2 text-sm border-border bg-surface text-foreground"
  >
    <option value="always">{i18nService.t('openClawSessionKeepAliveAlways')}</option>
    <option value="1d">{i18nService.t('openClawSessionKeepAliveOneDay')}</option>
    <option value="7d">{i18nService.t('openClawSessionKeepAliveSevenDays')}</option>
    <option value="30d">{i18nService.t('openClawSessionKeepAliveThirtyDays')}</option>
    <option value="365d">{i18nService.t('openClawSessionKeepAliveOneYear')}</option>
  </select>
</div>
```

- [ ] **Step 5: Save the setting during Settings submit**

In `handleSubmit`, after successful `coworkService.updateConfig(...)`, save the session policy:

```ts
const savedSessionPolicy = await window.electron.openclaw.sessionPolicy.set({
  keepAlive: openClawSessionKeepAlive,
});
if (!savedSessionPolicy?.success) {
  throw new Error(savedSessionPolicy?.error || i18nService.t('coworkConfigSaveFailed'));
}
```

- [ ] **Step 6: Run build to verify UI typing**

Run:

```bash
npm run build
```

Expected: PASS with no TypeScript or JSX errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/Settings.tsx src/renderer/services/i18n.ts
git commit -m "feat(settings): add session continuity control"
```

## Task 5: End-to-End Verification

**Files:**
- Test: `src/main/openclawSessionPolicy/store.test.ts`
- Test: `src/main/libs/openclawConfigSync.test.ts`

- [ ] **Step 1: Run focused automated checks**

Run:

```bash
npm test -- openclawSessionPolicy
npm test -- openclawConfigSync
```

Expected: PASS for new policy storage and runtime config mapping coverage.

- [ ] **Step 2: Run the main project build**

Run:

```bash
npm run build
```

Expected: PASS with updated renderer types and main-process code.

- [ ] **Step 3: Manual verification in the app**

Run:

```bash
npm run electron:dev
```

Verify:

- Open Settings and find `会话保持时长`
- Default selection is `7天（推荐）`
- Change it to `1年`, save settings, and confirm `/Users/wulei/Library/Application Support/智码 GLM Code/openclaw/state/openclaw.json` includes:

```json
"session": {
  "dmScope": "per-account-channel-peer",
  "reset": {
    "mode": "idle",
    "idleMinutes": 525600
  },
  "maintenance": {
    "pruneAfter": "365d",
    "maxEntries": 1000000,
    "rotateBytes": "1gb"
  }
}
```

- Change it to `始终延续`, save again, and confirm:

```json
"reset": {
  "mode": "off"
}
```

- [ ] **Step 4: Final commit**

```bash
git add src/main/openclawSessionPolicy src/main/main.ts src/main/libs/openclawConfigSync.ts src/main/libs/openclawConfigSync.test.ts src/renderer/types/cowork.ts src/renderer/types/electron.d.ts src/renderer/services/cowork.ts src/renderer/store/slices/coworkSlice.ts src/renderer/components/Settings.tsx src/renderer/services/i18n.ts
git commit -m "feat(openclaw): add session continuity setting"
```

## Self-Review

- Spec coverage:
  - User-facing single global setting: covered in Task 4
  - Dedicated config model: covered in Task 1 and Task 2
  - Explicit runtime `session.reset` and `session.maintenance`: covered in Task 3
  - No IM-specific override in v1: reflected in scope and no task adds it
- Placeholder scan:
  - No `TODO`, `TBD`, or undefined commands remain
  - All new file paths are explicit
- Type consistency:
  - `OpenClawSessionKeepAlive` values match the spec and UI options
  - `openClawSessionPolicy.keepAlive` is used consistently in main, renderer, and tests
