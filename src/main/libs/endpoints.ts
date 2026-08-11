import { app } from 'electron';

import { HtmlSharePublicRoute } from '../../shared/htmlShare/constants';
import type { SqliteStore } from '../sqliteStore';

let cachedTestMode: boolean | null = null;

const GLM_CODE_SITE_URL = 'https://glmcoding.cn';
const GLM_CODE_API_BASE_URL = `${GLM_CODE_SITE_URL}/api`;

const fromEnv = (name: string, fallback: string): string => (
  process.env[name]?.trim().replace(/\/+$/, '') || fallback
);

/**
 * Read testMode from store and cache it.
 * Call once at startup and again whenever app_config changes.
 */
export function refreshEndpointsTestMode(store: SqliteStore): void {
  const appConfig = store.get<any>('app_config');
  cachedTestMode = appConfig?.app?.testMode === true;
}

/**
 * Whether the app is in test mode.
 * Uses cached value after init; falls back to !app.isPackaged before init.
 */
export const isTestModeEnabled = (): boolean => {
  return cachedTestMode ?? !app.isPackaged;
};

/**
 * Server API base URL — switches based on testMode.
 * Used for auth exchange/refresh, models, proxy, etc.
 */
export const getServerApiBaseUrl = (): string => {
  return fromEnv('GLMCODE_SERVER_API_URL', GLM_CODE_SITE_URL);
};

export const getHtmlSharePublicBaseUrl = (): string => {
  return `${getServerApiBaseUrl()}${HtmlSharePublicRoute.Root}`;
};

export const getUpdateCheckUrl = (): string => fromEnv(
  'GLMCODE_UPDATE_CHECK_URL',
  `${GLM_CODE_API_BASE_URL}/desktop/update`,
);

export const getManualUpdateCheckUrl = (): string => fromEnv(
  'GLMCODE_MANUAL_UPDATE_CHECK_URL',
  `${GLM_CODE_API_BASE_URL}/desktop/update-manual`,
);

export const getFallbackDownloadUrl = (): string => fromEnv(
  'GLMCODE_DOWNLOAD_URL',
  `${GLM_CODE_SITE_URL}/download`,
);

export const getSkillStoreUrl = (): string => fromEnv(
  'GLMCODE_SKILL_STORE_URL',
  `${GLM_CODE_API_BASE_URL}/desktop/skill-store`,
);

// Portal 页面
const getPortalBase = (): string => fromEnv('GLMCODE_PORTAL_URL', GLM_CODE_SITE_URL);

export const getPortalTasksUrl = (): string => `${getPortalBase()}/profile/detail?tab=tasks`;

export const getKitStoreUrl = (): string => fromEnv(
  'GLMCODE_KIT_STORE_URL',
  `${GLM_CODE_API_BASE_URL}/desktop/kit-store`,
);
