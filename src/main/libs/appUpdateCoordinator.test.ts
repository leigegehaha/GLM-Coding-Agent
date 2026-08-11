import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  APP_UPDATE_URL_UNTRUSTED_ERROR,
  type AppUpdateInfo,
  AppUpdateSource,
  AppUpdateStatus,
} from '../../shared/appUpdate/constants';
import type { SqliteStore } from '../sqliteStore';
import { WINDOWS_INSTALLER_URL_POLICY_VERSION } from './appUpdateUrlPolicy';

const mocks = vi.hoisted(() => ({
  getPath: vi.fn(),
  getVersion: vi.fn(),
  fetch: vi.fn(),
  downloadUpdate: vi.fn(),
  installUpdate: vi.fn(),
  cancelActiveDownload: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: mocks.getPath,
    getVersion: mocks.getVersion,
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  session: {
    defaultSession: {
      fetch: mocks.fetch,
    },
  },
}));

vi.mock('./appUpdateInstaller', () => ({
  cancelActiveDownload: mocks.cancelActiveDownload,
  downloadUpdate: mocks.downloadUpdate,
  installUpdate: mocks.installUpdate,
}));

vi.mock('./endpoints', () => ({
  getUpdateCheckUrl: () => 'https://updates.example.com/auto',
  getManualUpdateCheckUrl: () => 'https://updates.example.com/manual',
  getFallbackDownloadUrl: () => 'https://updates.example.com/download-list',
}));

vi.mock('./keyfromAttribution', () => ({
  getKeyfromAttribution: () => ({ firstKeyfrom: 'none', latestKeyfrom: 'none' }),
}));

import { APP_UPDATE_READY_FILE_KEY_PREFIX, AppUpdateCoordinator } from './appUpdateCoordinator';

const READY_VERSION = '2.0.0';

function createStoreStub(): SqliteStore {
  const map = new Map<string, unknown>();
  return {
    get: (key: string) => map.get(key),
    set: (key: string, value: unknown) => {
      map.set(key, value);
    },
    delete: (key: string) => {
      map.delete(key);
    },
  } as unknown as SqliteStore;
}

function readyFileStoreKey(source: AppUpdateSource): string {
  return `${APP_UPDATE_READY_FILE_KEY_PREFIX}:${source}`;
}

function seedReadyFile(store: SqliteStore, updatesDir: string, source: AppUpdateSource): string {
  fs.mkdirSync(updatesDir, { recursive: true });
  const extension = process.platform === 'darwin' ? '.dmg' : '.exe';
  const filePath = path.join(updatesDir, `lobsterai-update-${source}-1${extension}`);
  const bytes = 'installer-bytes';
  fs.writeFileSync(filePath, bytes);
  const fileHash = crypto.createHash('sha256').update(bytes).digest('hex');
  store.set(readyFileStoreKey(source), {
    version: READY_VERSION,
    filePath,
    fileHash,
    info: {
      latestVersion: READY_VERSION,
      date: '2026-06-10',
      changeLog: {
        zh: { title: '', content: [] },
        en: { title: '', content: [] },
      },
      url: `https://updates.example.com/lobsterai-${READY_VERSION}${extension}`,
    },
    windowsInstallerUrlPolicyReceipt: {
      policyVersion: WINDOWS_INSTALLER_URL_POLICY_VERSION,
      inputOrigin: 'https://updates.example.com',
      finalOrigin: 'https://updates.example.com',
    },
  });
  return filePath;
}

describe('AppUpdateCoordinator', () => {
  const originalPlatform = process.platform;
  let tmpDir: string;
  let updatesDir: string;

  beforeEach(() => {
    mocks.getPath.mockReset();
    mocks.getVersion.mockReset();
    mocks.fetch.mockReset();
    mocks.downloadUpdate.mockReset();
    mocks.installUpdate.mockReset();
    mocks.cancelActiveDownload.mockReset();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-update-test-'));
    updatesDir = path.join(tmpDir, 'updates');
    mocks.getPath.mockReturnValue(tmpDir);
    mocks.getVersion.mockReturnValue('1.0.0');
    mocks.cancelActiveDownload.mockReturnValue(false);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('rejects an API-supplied insecure Windows installer URL with a stable error', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          value: {
            version: READY_VERSION,
            windowsX64: {
              url: 'http://downloads.example/GLMCode.exe',
            },
          },
        },
      }),
    });
    const coordinator = new AppUpdateCoordinator(createStoreStub());

    const result = await coordinator.checkNow({ manual: true });

    expect(result.success).toBe(false);
    expect(result.error).toBe(APP_UPDATE_URL_UNTRUSTED_ERROR);
    expect(result.state.info).toBeNull();
    expect(result.state.errorMessage).toBe(APP_UPDATE_URL_UNTRUSTED_ERROR);
    expect(JSON.stringify(result.state)).not.toContain('downloads.example');
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
  });

  test('accepts a changing HTTPS CDN without passing a fixed origin allowlist', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const installerUrl = `https://replacement-cdn.example.net/GLMCode-${READY_VERSION}.exe`;
    const downloadedFile = path.join(updatesDir, 'lobsterai-update-auto-1.exe');
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          value: {
            version: READY_VERSION,
            windowsX64: { url: installerUrl },
          },
        },
      }),
    });
    mocks.downloadUpdate.mockImplementation(async () => {
      fs.mkdirSync(updatesDir, { recursive: true });
      fs.writeFileSync(downloadedFile, 'installer-bytes');
      return {
        filePath: downloadedFile,
        windowsInstallerUrlPolicyReceipt: {
          policyVersion: WINDOWS_INSTALLER_URL_POLICY_VERSION,
          inputOrigin: 'https://replacement-cdn.example.net',
          finalOrigin: 'https://replacement-cdn.example.net',
        },
      };
    });
    const coordinator = new AppUpdateCoordinator(createStoreStub());

    const result = await coordinator.checkNow();

    expect(result.success).toBe(true);
    expect(result.state.status).toBe(AppUpdateStatus.Ready);
    expect(mocks.downloadUpdate).toHaveBeenCalledWith(
      installerUrl,
      AppUpdateSource.Auto,
      expect.any(Function),
    );
  });

  test('uses only the fixed download page when the Windows API omits an installer URL', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          value: {
            version: READY_VERSION,
          },
        },
      }),
    });
    const coordinator = new AppUpdateCoordinator(createStoreStub());

    const result = await coordinator.checkNow({ manual: true });

    expect(result.success).toBe(true);
    expect(result.state.status).toBe(AppUpdateStatus.Available);
    expect(result.state.info?.url).toBe('https://updates.example.com/download-list');
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
  });

  test('does not restore a persisted Windows installer from an untrusted source', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const store = createStoreStub();
    const filePath = seedReadyFile(store, updatesDir, AppUpdateSource.Auto);
    const stored = store.get<{
      info: AppUpdateInfo;
    }>(readyFileStoreKey(AppUpdateSource.Auto));
    if (!stored) {
      throw new Error('test fixture was not persisted');
    }
    stored.info.url = 'http://downloads.example/GLMCode.exe';
    store.set(readyFileStoreKey(AppUpdateSource.Auto), stored);

    const coordinator = new AppUpdateCoordinator(store);

    expect(coordinator.getState().status).toBe(AppUpdateStatus.Idle);
    expect(store.get(readyFileStoreKey(AppUpdateSource.Auto))).toBeUndefined();
    await vi.waitFor(() => {
      expect(fs.existsSync(filePath)).toBe(false);
    });
  });

  test('does not restore a legacy Windows cache without a policy receipt', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const store = createStoreStub();
    const filePath = seedReadyFile(store, updatesDir, AppUpdateSource.Auto);
    const stored = store.get<Record<string, unknown>>(
      readyFileStoreKey(AppUpdateSource.Auto),
    );
    if (!stored) {
      throw new Error('test fixture was not persisted');
    }
    delete stored.windowsInstallerUrlPolicyReceipt;
    store.set(readyFileStoreKey(AppUpdateSource.Auto), stored);

    const coordinator = new AppUpdateCoordinator(store);

    expect(coordinator.getState().status).toBe(AppUpdateStatus.Idle);
    expect(store.get(readyFileStoreKey(AppUpdateSource.Auto))).toBeUndefined();
    await vi.waitFor(() => {
      expect(fs.existsSync(filePath)).toBe(false);
    });
  });

  test('does not restore a cache whose recorded final origin differs from its input', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const store = createStoreStub();
    const filePath = seedReadyFile(store, updatesDir, AppUpdateSource.Auto);
    const stored = store.get<{
      windowsInstallerUrlPolicyReceipt: {
        policyVersion: typeof WINDOWS_INSTALLER_URL_POLICY_VERSION;
        inputOrigin: string;
        finalOrigin: string;
      };
    }>(readyFileStoreKey(AppUpdateSource.Auto));
    if (!stored) {
      throw new Error('test fixture was not persisted');
    }
    stored.windowsInstallerUrlPolicyReceipt.finalOrigin =
      'https://object-storage.example.org';
    store.set(readyFileStoreKey(AppUpdateSource.Auto), stored);

    const coordinator = new AppUpdateCoordinator(store);

    expect(coordinator.getState().status).toBe(AppUpdateStatus.Idle);
    expect(store.get(readyFileStoreKey(AppUpdateSource.Auto))).toBeUndefined();
    await vi.waitFor(() => {
      expect(fs.existsSync(filePath)).toBe(false);
    });
  });

  test('never deletes or restores a persisted ready path outside the update cache', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const store = createStoreStub();
    const cachedPath = seedReadyFile(store, updatesDir, AppUpdateSource.Auto);
    const outsidePath = path.join(tmpDir, 'important-user-file.exe');
    const outsideBytes = 'must-not-delete';
    fs.writeFileSync(outsidePath, outsideBytes);
    const stored = store.get<Record<string, unknown>>(
      readyFileStoreKey(AppUpdateSource.Auto),
    );
    if (!stored) {
      throw new Error('test fixture was not persisted');
    }
    stored.filePath = outsidePath;
    stored.fileHash = crypto.createHash('sha256').update(outsideBytes).digest('hex');
    store.set(readyFileStoreKey(AppUpdateSource.Auto), stored);

    const coordinator = new AppUpdateCoordinator(store);

    expect(coordinator.getState().status).toBe(AppUpdateStatus.Idle);
    expect(fs.readFileSync(outsidePath, 'utf8')).toBe(outsideBytes);
    expect(store.get(readyFileStoreKey(AppUpdateSource.Auto))).toBeUndefined();
    await vi.waitFor(() => {
      expect(fs.existsSync(cachedPath)).toBe(false);
    });
  });

  test('does not restore a symlinked Windows installer from the update cache', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const store = createStoreStub();
    fs.mkdirSync(updatesDir, { recursive: true });
    const targetPath = path.join(tmpDir, 'symlink-target.exe');
    const symlinkPath = path.join(updatesDir, 'lobsterai-update-auto-2.exe');
    const targetBytes = 'symlink-target';
    fs.writeFileSync(targetPath, targetBytes);
    fs.symlinkSync(targetPath, symlinkPath);
    store.set(readyFileStoreKey(AppUpdateSource.Auto), {
      version: READY_VERSION,
      filePath: symlinkPath,
      fileHash: crypto.createHash('sha256').update(targetBytes).digest('hex'),
      info: {
        latestVersion: READY_VERSION,
        date: '',
        changeLog: {
          zh: { title: '', content: [] },
          en: { title: '', content: [] },
        },
        url: `https://updates.example.com/lobsterai-${READY_VERSION}.exe`,
      },
      windowsInstallerUrlPolicyReceipt: {
        policyVersion: WINDOWS_INSTALLER_URL_POLICY_VERSION,
        inputOrigin: 'https://updates.example.com',
        finalOrigin: 'https://updates.example.com',
      },
    });

    const coordinator = new AppUpdateCoordinator(store);

    expect(coordinator.getState().status).toBe(AppUpdateStatus.Idle);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe(targetBytes);
    expect(store.get(readyFileStoreKey(AppUpdateSource.Auto))).toBeUndefined();
  });

  test('revalidates a ready installer source immediately before elevation', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const store = createStoreStub();
    const filePath = seedReadyFile(store, updatesDir, AppUpdateSource.Auto);
    const coordinator = new AppUpdateCoordinator(store);
    const internal = coordinator as unknown as {
      state: {
        info: AppUpdateInfo | null;
      };
    };
    if (!internal.state.info) {
      throw new Error('test fixture did not restore ready state');
    }
    internal.state.info.url = 'http://downloads.example/GLMCode.exe';

    const result = await coordinator.installReadyUpdate();

    expect(result.success).toBe(false);
    expect(result.error).toBe(APP_UPDATE_URL_UNTRUSTED_ERROR);
    expect(result.state.status).toBe(AppUpdateStatus.Error);
    expect(result.state.info).toBeNull();
    expect(result.state.readyFilePath).toBeNull();
    expect(fs.existsSync(filePath)).toBe(false);
    expect(mocks.installUpdate).not.toHaveBeenCalled();
  });

  test('revalidates ready installer bytes immediately before elevation', async () => {
    const store = createStoreStub();
    const filePath = seedReadyFile(store, updatesDir, AppUpdateSource.Auto);
    const coordinator = new AppUpdateCoordinator(store);
    fs.writeFileSync(filePath, 'tampered-installer-bytes');

    const result = await coordinator.installReadyUpdate();

    expect(result.success).toBe(false);
    expect(result.state.status).toBe(AppUpdateStatus.Available);
    expect(result.state.readyFilePath).toBeNull();
    expect(fs.existsSync(filePath)).toBe(false);
    expect(mocks.installUpdate).not.toHaveBeenCalled();
  });

  test('keeps policy receipt bound across auto-to-manual ready-file reuse', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const store = createStoreStub();
    seedReadyFile(store, updatesDir, AppUpdateSource.Auto);
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          value: {
            version: READY_VERSION,
            windowsX64: {
              url: `https://updates.example.com/GLMCode-${READY_VERSION}.exe`,
            },
          },
        },
      }),
    });
    const coordinator = new AppUpdateCoordinator(store);

    const firstManualCheck = await coordinator.checkNow({ manual: true });
    const secondManualCheck = await coordinator.checkNow({ manual: true });
    const install = await coordinator.installReadyUpdate();

    expect(firstManualCheck.state.status).toBe(AppUpdateStatus.Ready);
    expect(firstManualCheck.state.source).toBe(AppUpdateSource.Manual);
    expect(secondManualCheck.state.status).toBe(AppUpdateStatus.Ready);
    expect(install.success).toBe(true);
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
    expect(mocks.installUpdate).toHaveBeenCalledOnce();
  });

  test('returns to Ready and keeps the verified installer when install fails', async () => {
    const store = createStoreStub();
    const filePath = seedReadyFile(store, updatesDir, AppUpdateSource.Auto);
    const coordinator = new AppUpdateCoordinator(store);
    expect(coordinator.getState().status).toBe(AppUpdateStatus.Ready);

    mocks.installUpdate.mockRejectedValue(new Error('The operation was canceled by the user.'));

    const result = await coordinator.installReadyUpdate();

    expect(result.success).toBe(false);
    expect(result.state.status).toBe(AppUpdateStatus.Ready);
    expect(result.state.readyFilePath).toBe(filePath);
    expect(result.state.errorMessage).toBe('The operation was canceled by the user.');
    expect(fs.existsSync(filePath)).toBe(true);
  });

  test('falls back to Available when the installer is gone after a failed install', async () => {
    const store = createStoreStub();
    const filePath = seedReadyFile(store, updatesDir, AppUpdateSource.Auto);
    const coordinator = new AppUpdateCoordinator(store);

    mocks.installUpdate.mockImplementation(async () => {
      fs.unlinkSync(filePath);
      throw new Error('Update file not found');
    });

    const result = await coordinator.installReadyUpdate();

    expect(result.success).toBe(false);
    expect(result.state.status).toBe(AppUpdateStatus.Available);
    expect(result.state.readyFilePath).toBeNull();
    expect(result.state.errorMessage).toBe('Update file not found');
    expect(store.get(readyFileStoreKey(AppUpdateSource.Auto))).toBeUndefined();
  });

  test('manual check reuses an installer downloaded by the auto flow', async () => {
    const store = createStoreStub();
    const filePath = seedReadyFile(store, updatesDir, AppUpdateSource.Auto);
    const coordinator = new AppUpdateCoordinator(store);

    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          value: {
            version: READY_VERSION,
            date: '2026-06-10',
            changeLog: {
              ch: { title: '', content: [] },
              en: { title: '', content: [] },
            },
            macIntel: { url: `https://updates.example.com/lobsterai-${READY_VERSION}.dmg` },
            macArm: { url: `https://updates.example.com/lobsterai-${READY_VERSION}.dmg` },
            windowsX64: { url: `https://updates.example.com/lobsterai-${READY_VERSION}.exe` },
          },
        },
      }),
    });

    const result = await coordinator.checkNow({ manual: true });

    expect(result.success).toBe(true);
    expect(result.updateFound).toBe(true);
    expect(result.state.status).toBe(AppUpdateStatus.Ready);
    expect(result.state.source).toBe(AppUpdateSource.Manual);
    expect(result.state.readyFilePath).toBe(filePath);
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
  });

  test('restores installIncomplete after an install attempt that never completed', async () => {
    const store = createStoreStub();
    seedReadyFile(store, updatesDir, AppUpdateSource.Auto);
    const coordinator = new AppUpdateCoordinator(store);
    mocks.installUpdate.mockResolvedValue(undefined);

    const result = await coordinator.installReadyUpdate();
    expect(result.success).toBe(true);

    const restored = new AppUpdateCoordinator(store);
    const state = restored.getState();
    expect(state.status).toBe(AppUpdateStatus.Ready);
    expect(state.installIncomplete).toBe(true);
  });

  test('reports a completed update once when relaunched as the attempted version', async () => {
    const store = createStoreStub();
    seedReadyFile(store, updatesDir, AppUpdateSource.Auto);
    const coordinator = new AppUpdateCoordinator(store);
    mocks.installUpdate.mockResolvedValue(undefined);
    await coordinator.installReadyUpdate();

    // The installer finished and relaunched the app as the new version.
    mocks.getVersion.mockReturnValue(READY_VERSION);
    const relaunched = new AppUpdateCoordinator(store);

    expect(relaunched.getState().status).toBe(AppUpdateStatus.Idle);
    expect(relaunched.consumeCompletedUpdateVersion()).toBe(READY_VERSION);
    expect(relaunched.consumeCompletedUpdateVersion()).toBeNull();
    expect(store.get(readyFileStoreKey(AppUpdateSource.Auto))).toBeUndefined();
  });

  test('does not report a completed update without a prior install attempt', () => {
    const store = createStoreStub();
    seedReadyFile(store, updatesDir, AppUpdateSource.Auto);

    // App is already on the ready version, but no install was ever launched
    // (e.g. the user updated manually with the wizard from a browser download).
    mocks.getVersion.mockReturnValue(READY_VERSION);
    const coordinator = new AppUpdateCoordinator(store);

    expect(coordinator.consumeCompletedUpdateVersion()).toBeNull();
  });

  test('forwards the enterprise Defender-exclusion opt-out to the installer', async () => {
    const store = createStoreStub();
    store.set('enterprise_config', { disableDefenderExclusion: true });
    seedReadyFile(store, updatesDir, AppUpdateSource.Auto);
    const coordinator = new AppUpdateCoordinator(store);
    mocks.installUpdate.mockResolvedValue(undefined);

    await coordinator.installReadyUpdate();

    expect(mocks.installUpdate).toHaveBeenCalledWith(
      expect.any(String),
      { noDefenderExclusion: true },
    );
  });

  test('does not request the Defender opt-out without enterprise config', async () => {
    const store = createStoreStub();
    seedReadyFile(store, updatesDir, AppUpdateSource.Auto);
    const coordinator = new AppUpdateCoordinator(store);
    mocks.installUpdate.mockResolvedValue(undefined);

    await coordinator.installReadyUpdate();

    expect(mocks.installUpdate).toHaveBeenCalledWith(
      expect.any(String),
      { noDefenderExclusion: false },
    );
  });
});
