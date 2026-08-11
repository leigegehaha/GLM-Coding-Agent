import crypto from 'crypto';
import { app, session } from 'electron';
import extractZip from 'extract-zip';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

export const ComputerUseRuntime = {
  Id: 'computer-use',
  Version: '1.0.7',
  Platform: 'win32',
  Arch: 'x64',
  ArchiveName: 'lobsterai-computer-use-runtime-win-x64-1.0.7.zip',
  DownloadUrl: 'https://ydhardwarebusiness.nosdn.127.net/806b908f1ba20905cc5c99495bccc69c.zip',
  Sha256: 'd43c15cd69e10f0fbffe62f6c5ec947b4e61c5df84efbce46b6f73e28c9de30e',
  SizeBytes: 540139,
} as const;
export type ComputerUseRuntime =
  typeof ComputerUseRuntime[keyof typeof ComputerUseRuntime];

export const ComputerUseRuntimeStatus = {
  Unsupported: 'unsupported',
  NotInstalled: 'not_installed',
  Installed: 'installed',
  Invalid: 'invalid',
} as const;
export type ComputerUseRuntimeStatus =
  typeof ComputerUseRuntimeStatus[keyof typeof ComputerUseRuntimeStatus];

export const ComputerUseHelperConfig = {
  AccentColor: '#339cff',
  Direction: 'ltr',
  Locale: 'zh-CN',
  EscToCancel: '按 Esc 取消',
  UsingComputer: '智码 GLM Code正在使用你的电脑',
} as const;
export type ComputerUseHelperConfig =
  typeof ComputerUseHelperConfig[keyof typeof ComputerUseHelperConfig];

export interface ComputerUseRuntimePaths {
  clientModulePath: string;
  helperExePath: string;
  runtimePackageRoot: string;
  rootDir: string;
}

export interface ComputerUseRuntimeInspection {
  missing: string[];
  paths: ComputerUseRuntimePaths | null;
  status: ComputerUseRuntimeStatus;
}

export interface ComputerUseRuntimeDownloadProgress {
  received: number;
  total: number | undefined;
  percent: number | undefined;
}

const RUNTIME_PLATFORM_DIR = 'win-x64';
const RUNTIME_STATE_FILE = 'runtime.json';

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isSupportedPlatform(): boolean {
  return process.platform === ComputerUseRuntime.Platform
    && process.arch === ComputerUseRuntime.Arch;
}

export function getComputerUseRuntimeBaseDir(): string {
  return path.join(app.getPath('userData'), 'runtimes', ComputerUseRuntime.Id);
}

export function getComputerUseRuntimeRoot(): string {
  return path.join(
    getComputerUseRuntimeBaseDir(),
    RUNTIME_PLATFORM_DIR,
    ComputerUseRuntime.Version,
  );
}

export function getComputerUseHelperStateHome(): string {
  return path.join(app.getPath('userData'), 'computer-use-helper');
}

export function ensureComputerUseHelperStateHome(): string {
  const stateHome = getComputerUseHelperStateHome();
  const configDir = path.join(stateHome, 'computer-use');
  const configPath = path.join(configDir, 'config.json');
  const config = {
    accentColor: ComputerUseHelperConfig.AccentColor,
    direction: ComputerUseHelperConfig.Direction,
    locale: ComputerUseHelperConfig.Locale,
    strings: {
      escToCancel: ComputerUseHelperConfig.EscToCancel,
      usingComputer: ComputerUseHelperConfig.UsingComputer,
    },
  };
  const content = `${JSON.stringify(config, null, 2)}\n`;

  fs.mkdirSync(configDir, { recursive: true });
  const existing = isFile(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  if (existing !== content) {
    fs.writeFileSync(configPath, content, 'utf8');
  }

  return stateHome;
}

function readRuntimeManifest(rootDir: string): Record<string, unknown> | null {
  const manifestPath = path.join(rootDir, RUNTIME_STATE_FILE);
  if (!isFile(manifestPath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function manifestMatches(manifest: Record<string, unknown> | null): boolean {
  return manifest?.id === ComputerUseRuntime.Id
    && manifest.version === ComputerUseRuntime.Version
    && manifest.platform === ComputerUseRuntime.Platform
    && manifest.arch === ComputerUseRuntime.Arch;
}

function readManifestRelativePath(
  manifest: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = manifest?.[key];
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().replace(/\\/g, '/');
  if (!normalized || path.isAbsolute(normalized)) {
    return null;
  }

  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some(part => part === '.' || part === '..')) {
    return null;
  }

  return path.join(...parts);
}

export function inspectComputerUseRuntime(
  rootDir = getComputerUseRuntimeRoot(),
): ComputerUseRuntimeInspection {
  if (!isSupportedPlatform()) {
    return {
      missing: [],
      paths: null,
      status: ComputerUseRuntimeStatus.Unsupported,
    };
  }

  if (!isDirectory(rootDir)) {
    return {
      missing: [rootDir],
      paths: null,
      status: ComputerUseRuntimeStatus.NotInstalled,
    };
  }

  const missing: string[] = [];
  const manifest = readRuntimeManifest(rootDir);
  if (!manifestMatches(manifest)) {
    missing.push(RUNTIME_STATE_FILE);
  }

  const runtimePackageRootRelativePath = readManifestRelativePath(manifest, 'runtimePackageRoot');
  const helperRelativePath = readManifestRelativePath(manifest, 'helper');
  const clientModuleRelativePath = readManifestRelativePath(manifest, 'clientModule');

  if (!runtimePackageRootRelativePath) {
    missing.push(`${RUNTIME_STATE_FILE}:runtimePackageRoot`);
  }
  if (!helperRelativePath) {
    missing.push(`${RUNTIME_STATE_FILE}:helper`);
  }
  if (!clientModuleRelativePath) {
    missing.push(`${RUNTIME_STATE_FILE}:clientModule`);
  }

  const runtimePackageRoot = runtimePackageRootRelativePath
    ? path.join(rootDir, runtimePackageRootRelativePath)
    : '';
  const helperExePath = helperRelativePath ? path.join(rootDir, helperRelativePath) : '';
  const clientModulePath = clientModuleRelativePath
    ? path.join(rootDir, clientModuleRelativePath)
    : '';

  if (runtimePackageRootRelativePath && !isDirectory(runtimePackageRoot)) {
    missing.push(runtimePackageRootRelativePath);
  }
  if (helperRelativePath && !isFile(helperExePath)) {
    missing.push(helperRelativePath);
  }
  if (clientModuleRelativePath && !isFile(clientModulePath)) {
    missing.push(clientModuleRelativePath);
  }

  if (missing.length > 0) {
    return {
      missing,
      paths: null,
      status: ComputerUseRuntimeStatus.Invalid,
    };
  }

  return {
    missing: [],
    paths: { clientModulePath, helperExePath, rootDir, runtimePackageRoot },
    status: ComputerUseRuntimeStatus.Installed,
  };
}

export function resolveInstalledComputerUseRuntimePaths(): ComputerUseRuntimePaths | null {
  return inspectComputerUseRuntime().paths;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function downloadRuntimeArchive(
  archivePath: string,
  onProgress?: (progress: ComputerUseRuntimeDownloadProgress) => void,
): Promise<void> {
  const response = await session.defaultSession.fetch(ComputerUseRuntime.DownloadUrl);
  if (!response.ok) {
    throw new Error(`Computer Use runtime download failed with HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error('Computer Use runtime download returned an empty body');
  }

  const totalHeader = response.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : undefined;
  let received = 0;
  onProgress?.({ received, total, percent: total ? 0 : undefined });

  await fs.promises.mkdir(path.dirname(archivePath), { recursive: true });
  const nodeStream = Readable.fromWeb(response.body as any);
  nodeStream.on('data', (chunk: Buffer) => {
    received += chunk.length;
    onProgress?.({
      received,
      total: total && Number.isFinite(total) ? total : undefined,
      percent: total && Number.isFinite(total) ? received / total : undefined,
    });
  });
  await pipeline(nodeStream, fs.createWriteStream(archivePath));
}

export async function installComputerUseRuntime(
  onProgress?: (progress: ComputerUseRuntimeDownloadProgress) => void,
): Promise<{ success: boolean; paths?: ComputerUseRuntimePaths; error?: string }> {
  if (!isSupportedPlatform()) {
    return { success: false, error: 'Computer Use runtime is only available on Windows x64.' };
  }

  const current = inspectComputerUseRuntime();
  if (current.paths) {
    return { success: true, paths: current.paths };
  }

  const baseDir = getComputerUseRuntimeBaseDir();
  const archivePath = path.join(baseDir, 'downloads', ComputerUseRuntime.ArchiveName);
  const targetRoot = getComputerUseRuntimeRoot();
  const tempRoot = `${targetRoot}.tmp-${Date.now()}`;

  try {
    await downloadRuntimeArchive(archivePath, onProgress);
    const actualSha256 = await sha256File(archivePath);
    if (actualSha256 !== ComputerUseRuntime.Sha256) {
      throw new Error('Computer Use runtime checksum verification failed');
    }

    await fs.promises.rm(tempRoot, { recursive: true, force: true });
    await fs.promises.mkdir(tempRoot, { recursive: true });
    await extractZip(archivePath, { dir: tempRoot });

    const extracted = inspectComputerUseRuntime(tempRoot);
    if (!extracted.paths) {
      throw new Error(`Computer Use runtime archive is invalid: ${extracted.missing.join(', ')}`);
    }

    await fs.promises.rm(targetRoot, { recursive: true, force: true });
    await fs.promises.mkdir(path.dirname(targetRoot), { recursive: true });
    await fs.promises.rename(tempRoot, targetRoot);

    const installed = inspectComputerUseRuntime(targetRoot);
    if (!installed.paths) {
      throw new Error(`Computer Use runtime install is invalid: ${installed.missing.join(', ')}`);
    }

    console.log('[ComputerUseRuntime] runtime installed successfully');
    return { success: true, paths: installed.paths };
  } catch (error) {
    await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ComputerUseRuntime] runtime installation failed:', error);
    return { success: false, error: message };
  }
}

export async function uninstallComputerUseRuntime(): Promise<void> {
  const targetRoot = getComputerUseRuntimeRoot();
  const archivePath = path.join(
    getComputerUseRuntimeBaseDir(),
    'downloads',
    ComputerUseRuntime.ArchiveName,
  );

  await fs.promises.rm(targetRoot, { recursive: true, force: true });
  await fs.promises.rm(archivePath, { force: true }).catch(() => {});
}
