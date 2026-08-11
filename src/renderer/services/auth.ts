import {
  type AuthLifecycleEvent,
  AuthLifecycleEventType,
  type AuthSessionChangedEvent,
  AuthSessionStatus,
} from '@shared/auth/constants';
import { ProviderName } from '@shared/providers';
import type { ModelRuntimeProfile } from '@shared/providers/modelRuntimeProfiles';

import { store } from '../store';
import {
  setAuthExpired,
  setAuthLoading,
  setAuthTemporarilyUnavailable,
  setLoggedIn,
  setLoggedOut,
  setProfileSummary,
  updateQuota,
  type UserProfile,
  type UserQuota,
} from '../store/slices/authSlice';
import type { Model } from '../store/slices/modelSlice';
import {
  clearServerModels,
  setServerModels,
} from '../store/slices/modelSlice';
import { i18nService } from './i18n';
import { LogReporterAction, reportAnalytics } from './logReporter';

interface AuthStateRefreshResult {
  isLoggedIn: boolean;
  user: UserProfile | null;
  quota: UserQuota | null;
}

export interface PricingCatalogTextModel {
  modelId?: string;
  modelName?: string;
  provider?: string;
  providerLabel?: string;
  description?: string;
  supportsImage?: boolean;
  supportsThinking?: boolean;
  contextWindow?: number | null;
  costMultiplier?: number;
}

export interface PricingCatalogResponse {
  textModels?: PricingCatalogTextModel[];
  imageModels?: unknown[];
  videoModels?: unknown[];
}

export interface AvailableServerModelEntry {
  modelId: string;
  modelName: string;
  provider: string;
  apiFormat: string;
  runtimeProfile?: ModelRuntimeProfile;
  supportsImage?: boolean;
  supportsVideo?: boolean;
  supportsThinking?: boolean;
  supportsToolCalling?: boolean;
  agenticReady?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  explicitContextCache?: boolean;
  costMultiplier?: number;
  description?: string;
  accessible?: boolean;
  restrictionHint?: string;
}

const readString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const readPositiveNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined
);

type AuthRendererLogLevel = 'debug' | 'info' | 'warn';

const writeAuthRendererLog = (
  level: AuthRendererLogLevel,
  message: string,
  error?: unknown,
): void => {
  if (level === 'warn') {
    if (error === undefined) {
      console.warn(`[Auth] ${message}`);
    } else {
      console.warn(`[Auth] ${message}:`, error);
    }
  } else if (level === 'debug') {
    console.debug(`[Auth] ${message}`);
  } else {
    console.log(`[Auth] ${message}`);
  }

  try {
    window.electron?.log?.fromRenderer?.(level, 'AuthService', message);
  } catch {
    // Logging is best-effort and must never interrupt authentication.
  }
};

const reportAuthLifecycleEvent = (event: AuthLifecycleEvent): void => {
  void reportAnalytics({
    action: LogReporterAction.AuthLifecycle,
    event_type: event.eventType,
    outcome: event.outcome,
    reason: 'reason' in event ? event.reason : undefined,
    duration_ms: 'durationMs' in event ? event.durationMs : undefined,
    failure_kind: 'failureKind' in event ? event.failureKind : undefined,
    http_status: 'httpStatus' in event ? event.httpStatus : undefined,
    error_code: 'errorCode' in event ? event.errorCode : undefined,
    joined_requests: 'joinedRequests' in event ? event.joinedRequests : undefined,
  });
};

export function mapPricingCatalogTextModelsToServerModels(
  textModels: PricingCatalogTextModel[],
): Model[] {
  return textModels.flatMap((model): Model[] => {
    const modelId = readString(model.modelId);
    if (!modelId) return [];

    const modelName = readString(model.modelName) || modelId;
    const provider = readString(model.providerLabel)
      || readString(model.provider)
      || '智码 GLM Code';
    const contextWindow = readPositiveNumber(model.contextWindow);
    const costMultiplier = readPositiveNumber(model.costMultiplier);

    return [{
      id: modelId,
      name: modelName,
      provider,
      providerKey: ProviderName.LobsteraiServer,
      isServerModel: true,
      supportsImage: model.supportsImage === true,
      supportsThinking: model.supportsThinking === true,
      description: readString(model.description) || undefined,
      costMultiplier,
      contextWindow,
      accessible: false,
    }];
  });
}

export function mapPricingCatalogToPublicServerModels(
  catalog: PricingCatalogResponse,
): Model[] {
  return mapPricingCatalogTextModelsToServerModels(
    Array.isArray(catalog.textModels) ? catalog.textModels : [],
  );
}

export function mapAvailableServerModelsToModels(
  models: AvailableServerModelEntry[],
): Model[] {
  return models.map(model => ({
    id: model.modelId,
    name: model.modelName,
    provider: model.provider,
    providerKey: ProviderName.LobsteraiServer,
    isServerModel: true,
    serverApiFormat: model.apiFormat,
    runtimeProfile: model.runtimeProfile,
    supportsImage: model.supportsImage ?? false,
    supportsVideo: model.supportsVideo ?? false,
    supportsThinking: model.supportsThinking ?? false,
    supportsToolCalling: model.supportsToolCalling,
    agenticReady: model.agenticReady,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    explicitContextCache: model.explicitContextCache ?? false,
    description: model.description,
    costMultiplier: model.costMultiplier,
    accessible: model.accessible ?? true,
    restrictionHint: model.restrictionHint ?? undefined,
  }));
}

class AuthService {
  private unsubCallback: (() => void) | null = null;
  private unsubLifecycleEvent: (() => void) | null = null;
  private unsubQuotaChanged: (() => void) | null = null;
  private unsubSessionChanged: (() => void) | null = null;
  private unsubWindowState: (() => void) | null = null;
  private lastRefreshTime = 0;
  private loginAttemptSequence = 0;

  /**
   * Initialize: try to restore login state from persisted token.
   */
  async init() {
    // Clean up any existing listeners to prevent stacking on repeated init()
    this.destroy();

    store.dispatch(setAuthLoading(true));

    // Listen for OAuth callback from protocol handler
    this.unsubCallback = window.electron.auth.onCallback(async ({ code }) => {
      await this.handleCallback(code);
    });
    this.unsubSessionChanged = window.electron.auth.onSessionChanged(event => {
      void this.handleSessionChanged(event);
    });
    this.unsubLifecycleEvent = window.electron.auth.onLifecycleEvent(reportAuthLifecycleEvent);

    try {
      const pendingCode = await window.electron.auth.getPendingCallback();
      let handledPendingCode = false;
      if (pendingCode) {
        handledPendingCode = await this.handleCallback(pendingCode);
      }
      if (!handledPendingCode) {
        await this.refreshAuthState({
          clearOnFailure: true,
          reportLifecycle: true,
        });
      }
    } catch {
      store.dispatch(setAuthTemporarilyUnavailable({ hasCredentials: false }));
      reportAuthLifecycleEvent({
        eventType: AuthLifecycleEventType.Restore,
        outcome: AuthSessionStatus.TemporarilyUnavailable,
      });
    }

    // Listen for quota changes (e.g. after cowork session using server model)
    this.unsubQuotaChanged = window.electron.auth.onQuotaChanged(() => {
      this.refreshQuota();
      void this.fetchProfileSummary();
      this.loadServerModels();
    });

    // Refresh quota and models when Electron window gains focus — user may have purchased on portal
    this.unsubWindowState = window.electron.window.onStateChanged((state) => {
      if (state.isFocused && store.getState().auth.isLoggedIn) {
        const now = Date.now();
        if (now - this.lastRefreshTime > 30_000) {
          this.lastRefreshTime = now;
          this.refreshQuota();
          void this.fetchProfileSummary();
          this.loadServerModels();
        }
      }
    });
  }

  /**
   * Initiate login (opens system browser).
   */
  async login() {
    const attemptId = ++this.loginAttemptSequence;
    writeAuthRendererLog('info', `login attempt ${attemptId} started`);

    try {
      const loginUrl = await this.fetchLoginUrl();
      const result = await window.electron.auth.login(loginUrl);
      if (result.success) {
        writeAuthRendererLog('info', `login attempt ${attemptId} handed off to the system browser`);
      } else {
        writeAuthRendererLog('warn', `login attempt ${attemptId} could not open the system browser`);
      }
    } catch (error) {
      writeAuthRendererLog('warn', `login attempt ${attemptId} failed before browser handoff`, error);
      throw error;
    }
  }

  /**
   * Fetch login URL from overmind, fallback to Portal login page.
   */
  private async fetchLoginUrl(): Promise<string> {
    const { getLoginOvermindUrl } = await import('./endpoints');
    const url = getLoginOvermindUrl();
    try {
      const response = await window.electron.api.fetch({
        url,
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (response.ok && typeof response.data === 'object' && response.data !== null) {
        const value = (response.data as any)?.data?.value;
        if (typeof value === 'string' && value.trim()) {
          writeAuthRendererLog('debug', 'resolved login URL from overmind');
          return value.trim();
        }
      }
    } catch (e) {
      writeAuthRendererLog('warn', 'failed to resolve login URL from overmind', e);
    }
    // Fallback: use Portal login page directly
    const { getPortalLoginUrl } = await import('./endpoints');
    writeAuthRendererLog('info', 'using fallback portal login URL');
    return getPortalLoginUrl();
  }

  /**
   * Handle OAuth callback with auth code.
   */
  async handleCallback(code: string): Promise<boolean> {
    writeAuthRendererLog('info', 'received login callback; starting token exchange');
    try {
      const result = await window.electron.auth.exchange(code);
      if (result.success) {
        writeAuthRendererLog('info', 'login callback exchange succeeded');
        store.dispatch(setLoggedIn({ user: result.user, quota: result.quota }));
        await this.loadServerModels();
        void this.fetchProfileSummary();
        this.refreshQuota();
        return true;
      }
      writeAuthRendererLog('warn', 'login callback exchange was rejected');
    } catch (e) {
      writeAuthRendererLog('warn', 'login callback exchange failed', e);
    }
    return false;
  }

  /**
   * Refresh the full auth snapshot from persisted tokens.
   */
  async refreshAuthState(
    options: {
      clearOnFailure?: boolean;
      reportLifecycle?: boolean;
    } = {},
  ): Promise<AuthStateRefreshResult> {
    try {
      const result = await window.electron.auth.getUser();
      if (result.success && result.user) {
        store.dispatch(setLoggedIn({ user: result.user, quota: result.quota }));
        await this.loadServerModels();
        void this.fetchProfileSummary();
        if (options.reportLifecycle) {
          reportAuthLifecycleEvent({
            eventType: AuthLifecycleEventType.Restore,
            outcome: AuthSessionStatus.Authenticated,
          });
        }
        return { isLoggedIn: true, user: result.user, quota: result.quota ?? null };
      }

      const status = result.status ?? (
        result.hasCredentials
          ? AuthSessionStatus.TemporarilyUnavailable
          : AuthSessionStatus.Unauthenticated
      );
      if (options.reportLifecycle) {
        reportAuthLifecycleEvent({
          eventType: AuthLifecycleEventType.Restore,
          outcome: status,
        });
      }

      if (status === AuthSessionStatus.TemporarilyUnavailable) {
        store.dispatch(setAuthTemporarilyUnavailable({
          hasCredentials: result.hasCredentials === true,
          cachedUser: result.cachedUser ?? null,
        }));
      } else if (status === AuthSessionStatus.Expired) {
        await this.applyLoggedOutState(true);
      } else if (options.clearOnFailure) {
        await this.applyLoggedOutState(false);
      }
    } catch {
      store.dispatch(setAuthTemporarilyUnavailable({
        hasCredentials: store.getState().auth.isLoggedIn,
      }));
      if (options.reportLifecycle) {
        reportAuthLifecycleEvent({
          eventType: AuthLifecycleEventType.Restore,
          outcome: AuthSessionStatus.TemporarilyUnavailable,
        });
      }
    }

    const current = store.getState().auth;
    return {
      isLoggedIn: current.isLoggedIn,
      user: current.user,
      quota: current.quota,
    };
  }

  /**
   * Logout.
   */
  async logout() {
    await window.electron.auth.logout();
    await this.applyLoggedOutState(false);
  }

  /**
   * Refresh quota information.
   */
  async refreshQuota() {
    try {
      const result = await window.electron.auth.getQuota();
      if (result.success) {
        store.dispatch(updateQuota(result.quota));
      }
    } catch {
      // ignore
    }
  }

  /**
   * Fetch profile summary (credits breakdown).
   */
  async fetchProfileSummary() {
    try {
      const result = await window.electron.auth.getProfileSummary();
      if (result.success && result.data) {
        store.dispatch(setProfileSummary(result.data));
      }
    } catch {
      // ignore
    }
  }

  async claimCreditsFinalReward(campaignCode: string) {
    const result = await window.electron.auth.claimCreditsFinalReward(campaignCode);
    if (!result.success || !result.data) {
      throw new Error(result.error || 'Claim failed');
    }
    await Promise.all([this.refreshQuota(), this.fetchProfileSummary()]);
    return result.data;
  }

  /**
   * Get current access token (for proxy API calls).
   */
  async getAccessToken(): Promise<string | null> {
    try {
      return await window.electron.auth.getAccessToken();
    } catch {
      return null;
    }
  }

  destroy() {
    this.unsubCallback?.();
    this.unsubCallback = null;
    this.unsubLifecycleEvent?.();
    this.unsubLifecycleEvent = null;
    this.unsubQuotaChanged?.();
    this.unsubQuotaChanged = null;
    this.unsubSessionChanged?.();
    this.unsubSessionChanged = null;
    this.unsubWindowState?.();
    this.unsubWindowState = null;
  }

  private async handleSessionChanged(event: AuthSessionChangedEvent): Promise<void> {
    if (event.status !== AuthSessionStatus.Expired) return;
    writeAuthRendererLog('warn', `login session expired (${event.reason})`);
    const cleanup = this.applyLoggedOutState(true);
    window.dispatchEvent(new CustomEvent('app:showToast', {
      detail: i18nService.t('coworkErrorLobsterAILoginExpired'),
    }));
    await cleanup;
  }

  private async applyLoggedOutState(expired: boolean): Promise<void> {
    const targetStatus = expired
      ? AuthSessionStatus.Expired
      : AuthSessionStatus.Unauthenticated;
    const current = store.getState().auth;
    if (
      !current.isLoggedIn
      && !current.isLoading
      && current.sessionStatus === targetStatus
    ) {
      return;
    }

    store.dispatch(expired ? setAuthExpired() : setLoggedOut());
    store.dispatch(clearServerModels());
    await this.loadPublicPricingCatalogModels();
  }

  /**
   * Load available models from server and dispatch to store.
   */
  private async loadServerModels() {
    try {
      const modelsResult = await window.electron.auth.getModels();
      if (modelsResult.success && modelsResult.models) {
        const serverModels = mapAvailableServerModelsToModels(modelsResult.models);
        store.dispatch(setServerModels(serverModels));
        console.debug(`[Auth] loaded ${serverModels.length} server model(s) into renderer state`);
      } else {
        console.debug('[Auth] server model load returned no models');
      }
    } catch (error) {
      console.warn('[Auth] failed to load server models:', error);
    }
  }

  /**
   * Load public pricing catalog models for unauthenticated read-only display.
   */
  private async loadPublicPricingCatalogModels() {
    try {
      const catalogResult = await window.electron.auth.getPricingCatalog();
      if (!catalogResult.success || !catalogResult.textModels) {
        return;
      }
      const serverModels = mapPricingCatalogToPublicServerModels({
        textModels: catalogResult.textModels,
      });
      store.dispatch(setServerModels(serverModels));
    } catch {
      // ignore — public catalog is optional
    }
  }
}

export const authService = new AuthService();
