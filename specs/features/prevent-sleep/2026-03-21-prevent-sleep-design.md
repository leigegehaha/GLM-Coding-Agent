# Prevent Sleep Feature Design

## Overview

Add a "prevent sleep" toggle to Settings > General tab, preventing the system from sleeping while 智码 GLM Code is running. Follows the existing autoLaunch pattern.

## User Story

As a user running long AI tasks or IM bots, I want 智码 GLM Code to prevent my computer from sleeping, so tasks aren't interrupted by the system going to sleep.

## Design

### UI

- **Location**: Settings > General tab, below the system proxy toggle
- **Component**: Toggle switch (same style as autoLaunch / useSystemProxy)
- **Behavior**: Toggle takes effect immediately (no save button needed)
- **Label**: 防止休眠 / Prevent Sleep
- **Description**: 防止系统在应用运行时进入睡眠模式 / Prevent the system from sleeping while the app is running

### Architecture

Follows the autoLaunch pattern exactly:

```
Settings.tsx (toggle)
  → window.electron.preventSleep.set(true/false)
  → IPC: app:setPreventSleep
  → main.ts: powerSaveBlocker.start/stop()
  → store.set('prevent_sleep_enabled', boolean)
```

### Main Process (`main.ts`)

- Import `powerSaveBlocker` from `electron`
- Track blocker ID: `let preventSleepBlockerId: number | null = null`
- IPC `app:getPreventSleep`: read from store, return `{ enabled: boolean }`
- IPC `app:setPreventSleep`: start/stop blocker, persist to store
- On app startup: if `prevent_sleep_enabled` is true in store, auto-start blocker
- On app quit: stop blocker if active (cleanup)

### Preload (`preload.ts`)

```typescript
preventSleep: {
  get: () => ipcRenderer.invoke('app:getPreventSleep'),
  set: (enabled: boolean) => ipcRenderer.invoke('app:setPreventSleep', enabled),
},
```

### Type Declaration (`electron.d.ts`)

```typescript
preventSleep: {
  get: () => Promise<{ enabled: boolean }>;
  set: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
};
```

### Settings UI (`Settings.tsx`)

- State: `const [preventSleep, setPreventSleep] = useState(false)`
- Loading state: `isUpdatingPreventSleep`
- Init: load from `window.electron.preventSleep.get()` alongside autoLaunch
- Toggle handler: call `window.electron.preventSleep.set(next)`, update state

### i18n (`i18n.ts`)

| Key | zh | en |
|-----|----|----|
| `preventSleep` | 防止休眠 | Prevent Sleep |
| `preventSleepDescription` | 防止系统在应用运行时进入睡眠模式 | Prevent the system from sleeping while the app is running |

### Store

- Key: `prevent_sleep_enabled`
- Type: `boolean`
- Default: `false` (off by default)

### Electron API

- `powerSaveBlocker.start('prevent-display-sleep')` — prevents display sleep (also prevents system sleep)
- `powerSaveBlocker.stop(id)` — releases the blocker
- `powerSaveBlocker.isStarted(id)` — check if active

### Files to Modify

1. `src/main/main.ts` — add `powerSaveBlocker` import, IPC handlers, startup logic
2. `src/main/preload.ts` — add `preventSleep` API
3. `src/renderer/types/electron.d.ts` — add type declaration
4. `src/renderer/components/Settings.tsx` — add toggle in general tab
5. `src/renderer/services/i18n.ts` — add zh/en translations

### Edge Cases

- App quit while blocker active → blocker auto-released by OS when process exits
- Multiple toggles rapidly → loading state prevents double-click
- Store value missing → default to false (off)

### Not In Scope

- Per-session prevent sleep (only during active cowork sessions)
- Tray menu toggle
- System tray indicator showing sleep prevention status

---

## 实施计划


**Goal:** Add a "prevent sleep" toggle in Settings > General that keeps the system awake while 智码 GLM Code is running.

**Architecture:** Follows the existing autoLaunch pattern — independent IPC channel, store key, and immediate toggle (no save button). Main process uses Electron's `powerSaveBlocker` API.

**Tech Stack:** Electron `powerSaveBlocker`, React, IPC, SQLite kv store

**Spec:** `docs/superpowers/specs/2026-03-21-prevent-sleep-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/main/main.ts` | Modify | Add `powerSaveBlocker` import, IPC handlers, startup activation |
| `src/main/preload.ts` | Modify | Expose `preventSleep.get/set` API |
| `src/renderer/types/electron.d.ts` | Modify | Add `preventSleep` type declaration |
| `src/renderer/services/i18n.ts` | Modify | Add zh/en translation keys |
| `src/renderer/components/Settings.tsx` | Modify | Add toggle UI in general tab |

---

### Task 1: Main Process — IPC Handlers and powerSaveBlocker

**Files:**
- Modify: `src/main/main.ts:1` (add `powerSaveBlocker` to electron import)
- Modify: `src/main/main.ts:1676` (add IPC handlers after autoLaunch handlers)

- [ ] **Step 1: Add `powerSaveBlocker` to electron import (line 1)**

Change:
```typescript
import { app, BrowserWindow, ipcMain, session, nativeTheme, dialog, shell, nativeImage, systemPreferences, Menu, protocol, net, powerMonitor } from 'electron';
```
To:
```typescript
import { app, BrowserWindow, ipcMain, session, nativeTheme, dialog, shell, nativeImage, systemPreferences, Menu, protocol, net, powerMonitor, powerSaveBlocker } from 'electron';
```

- [ ] **Step 2: Add blocker state variable**

Add after the electron import section (near other module-level variables):
```typescript
let preventSleepBlockerId: number | null = null;
```

- [ ] **Step 3: Add IPC handlers after autoLaunch handlers (after line 1676)**

```typescript
  ipcMain.handle('app:getPreventSleep', () => {
    const enabled = getStore().get<boolean>('prevent_sleep_enabled') ?? false;
    return { enabled };
  });

  ipcMain.handle('app:setPreventSleep', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      return { success: false, error: 'Invalid parameter: enabled must be boolean' };
    }
    try {
      if (enabled) {
        if (preventSleepBlockerId === null || !powerSaveBlocker.isStarted(preventSleepBlockerId)) {
          preventSleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
        }
      } else {
        if (preventSleepBlockerId !== null && powerSaveBlocker.isStarted(preventSleepBlockerId)) {
          powerSaveBlocker.stop(preventSleepBlockerId);
          preventSleepBlockerId = null;
        }
      }
      getStore().set('prevent_sleep_enabled', enabled);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set prevent-sleep',
      };
    }
  });
```

- [ ] **Step 4: Add startup activation**

Find the `initApp` function where autoLaunch store read happens (search for `auto_launch_enabled` near line 3932). Add nearby:

```typescript
// Restore prevent-sleep setting
const preventSleepEnabled = getStore().get<boolean>('prevent_sleep_enabled');
if (preventSleepEnabled) {
  try {
    preventSleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  } catch (err) {
    console.error('[Main] Failed to start prevent-sleep blocker:', err);
  }
}
```

- [ ] **Step 5: Compile and verify**

Run: `npm run compile:electron`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/main/main.ts
git commit -m "feat: add prevent-sleep IPC handlers and powerSaveBlocker logic"
```

---

### Task 2: Preload and Type Declaration

**Files:**
- Modify: `src/main/preload.ts:262` (add after autoLaunch block)
- Modify: `src/renderer/types/electron.d.ts:358` (add after autoLaunch type)

- [ ] **Step 1: Add preload API (after autoLaunch block, line 262)**

```typescript
  preventSleep: {
    get: () => ipcRenderer.invoke('app:getPreventSleep'),
    set: (enabled: boolean) => ipcRenderer.invoke('app:setPreventSleep', enabled),
  },
```

- [ ] **Step 2: Add type declaration (after autoLaunch type, line 358)**

```typescript
  preventSleep: {
    get: () => Promise<{ enabled: boolean }>;
    set: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  };
```

- [ ] **Step 3: Compile and verify**

Run: `npm run compile:electron`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main/preload.ts src/renderer/types/electron.d.ts
git commit -m "feat: expose preventSleep API in preload and type declaration"
```

---

### Task 3: i18n Translations

**Files:**
- Modify: `src/renderer/services/i18n.ts:860` (add after useSystemProxyDescription, zh section)
- Modify: `src/renderer/services/i18n.ts:1904` (add after useSystemProxyDescription, en section)

- [ ] **Step 1: Add Chinese translations (after line 860)**

```typescript
    preventSleep: '防止休眠',
    preventSleepDescription: '防止系统在应用运行时进入睡眠模式',
```

- [ ] **Step 2: Add English translations (after line 1904)**

```typescript
    preventSleep: 'Prevent Sleep',
    preventSleepDescription: 'Prevent the system from sleeping while the app is running',
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/services/i18n.ts
git commit -m "feat(i18n): add prevent-sleep translation keys"
```

---

### Task 4: Settings UI Toggle

**Files:**
- Modify: `src/renderer/components/Settings.tsx:383` (add state)
- Modify: `src/renderer/components/Settings.tsx:601` (add init load)
- Modify: `src/renderer/components/Settings.tsx:1949` (add toggle after system proxy section)

- [ ] **Step 1: Add state variables (near line 383, after autoLaunch states)**

```typescript
  const [preventSleep, setPreventSleepState] = useState(false);
  const [isUpdatingPreventSleep, setIsUpdatingPreventSleep] = useState(false);
```

- [ ] **Step 2: Add init load (after autoLaunch.get() block, near line 605)**

```typescript
      // Load prevent-sleep setting
      window.electron.preventSleep.get().then(({ enabled }) => {
        setPreventSleepState(enabled);
      }).catch(err => {
        console.error('Failed to load prevent-sleep setting:', err);
      });
```

- [ ] **Step 3: Add toggle UI (after system proxy section closing `</div>`, line 1949)**

```tsx
            {/* Prevent Sleep Section */}
            <div>
              <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">
                {i18nService.t('preventSleep')}
              </h4>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm dark:text-claude-darkSecondaryText text-claude-secondaryText">
                  {i18nService.t('preventSleepDescription')}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={preventSleep}
                  onClick={async () => {
                    if (isUpdatingPreventSleep) return;
                    const next = !preventSleep;
                    setIsUpdatingPreventSleep(true);
                    try {
                      const result = await window.electron.preventSleep.set(next);
                      if (result.success) {
                        setPreventSleepState(next);
                      } else {
                        setError(result.error || 'Failed to update prevent-sleep setting');
                      }
                    } catch (err) {
                      console.error('Failed to set prevent-sleep:', err);
                      setError('Failed to update prevent-sleep setting');
                    } finally {
                      setIsUpdatingPreventSleep(false);
                    }
                  }}
                  disabled={isUpdatingPreventSleep}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                    isUpdatingPreventSleep ? 'opacity-50 cursor-not-allowed' : ''
                  } ${
                    preventSleep
                      ? 'bg-claude-accent'
                      : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      preventSleep ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
            </div>
```

- [ ] **Step 4: Compile and verify**

Run: `npm run compile:electron`
Expected: No errors

- [ ] **Step 5: Manual test**

Run: `npm run electron:dev`
1. Open Settings > General
2. Verify "防止休眠" toggle appears below system proxy
3. Toggle on → system should not sleep
4. Toggle off → normal sleep behavior
5. Toggle on → close and reopen Settings → toggle should still be on
6. Restart app → toggle should still be on

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/Settings.tsx
git commit -m "feat(renderer): add prevent-sleep toggle in Settings general tab"
```
