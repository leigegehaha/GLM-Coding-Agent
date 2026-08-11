import { ArrowTopRightOnSquareIcon, ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useMemo,useRef, useState } from 'react';
import { useDispatch,useSelector } from 'react-redux';

import {
  APP_UPDATE_HEARTBEAT_INTERVAL_MS,
  APP_UPDATE_POLL_INTERVAL_MS,
  type AppUpdateInfo,
  type AppUpdateRuntimeState,
  AppUpdateStatus,
  isManualDownloadUrl,
} from '../shared/appUpdate/constants';
import type { CodingPlanAccountUser } from '../shared/codingPlanAccount/constants';
import { ProviderAuthType, ProviderName, ProviderRegistry } from '../shared/providers';
import { CoworkView } from './components/cowork';
import { CoworkShortcutDirection, CoworkUiEvent } from './components/cowork/constants';
import CoworkPermissionModal from './components/cowork/CoworkPermissionModal';
import CoworkQuestionWizard from './components/cowork/CoworkQuestionWizard';
import EngineFailureOverlay from './components/cowork/EngineFailureOverlay';
import EngineStartupOverlay from './components/cowork/EngineStartupOverlay';
import KitsView from './components/kits/KitsView';
import { McpView } from './components/mcp';
import PrivacyDialog from './components/PrivacyDialog';
import { ScheduledTasksView } from './components/scheduledTasks';
import Settings, { type SettingsOpenOptions } from './components/Settings';
import Sidebar from './components/Sidebar';
import { SitesView } from './components/sites';
import { SkillsView } from './components/skills';
import SkinBackdrop, { SkinBackdropVariant } from './components/skin/SkinBackdrop';
import SkinPresentationScope from './components/skin/SkinPresentationScope';
import Toast from './components/Toast';
import AppUpdateBadge from './components/update/AppUpdateBadge';
import AppUpdateBlockingPanel from './components/update/AppUpdateBlockingPanel';
import AppUpdateCard from './components/update/AppUpdateCard';
import { formatAppUpdateError } from './components/update/appUpdateErrorText';
import AppUpdateInteractionOverlay from './components/update/AppUpdateInteractionOverlay';
import {
  isAppUpdateInteractionBlockingStatus,
  shouldBlockAppInteractionForUpdate,
} from './components/update/appUpdateInteractionState';
import AppUpdateModal from './components/update/AppUpdateModal';
import WelcomeDialog from './components/WelcomeDialog';
import WindowsAppTitleBar from './components/window/WindowsAppTitleBar';
import { defaultConfig, getProviderDisplayName, ShortcutAction } from './config';
import { SkinProvider } from './providers/SkinProvider';
import type { ApiConfig } from './services/api';
import { apiService } from './services/api';
import { authService } from './services/auth';
import { configService } from './services/config';
import { coworkService } from './services/cowork';
import { getPortalRegisterUrl, isTestModeEnabled } from './services/endpoints';
import { i18nService } from './services/i18n';
import { LogReporterAction, reportAnalytics } from './services/logReporter';
import { scheduledTaskService } from './services/scheduledTask';
import { matchesShortcut } from './services/shortcuts';
import { themeService } from './services/theme';
import { applyTypographyPreferences } from './services/typography';
import { RootState, store } from './store';
import {
  selectCurrentSessionId,
  selectFirstCurrentSessionPendingPermission,
  selectPendingPermissions,
} from './store/selectors/coworkSelectors';
import {
  clearDraftAttachments,
  clearDraftSelectedTextSnippets,
  setDraftCollaborationMode,
  setDraftKitIds,
  setDraftPrompt,
} from './store/slices/coworkSlice';
import { setActiveKitIds } from './store/slices/kitSlice';
import { setAvailableModels, setDefaultSelectedModel } from './store/slices/modelSlice';
import { clearSelection } from './store/slices/quickActionSlice';
import { CoworkCollaborationMode, type CoworkPermissionResult } from './types/cowork';

const AGENT_TASK_SLOT_SHORTCUT_ACTIONS = [
  ShortcutAction.OpenAgentTask1,
  ShortcutAction.OpenAgentTask2,
  ShortcutAction.OpenAgentTask3,
  ShortcutAction.OpenAgentTask4,
  ShortcutAction.OpenAgentTask5,
  ShortcutAction.OpenAgentTask6,
  ShortcutAction.OpenAgentTask7,
  ShortcutAction.OpenAgentTask8,
  ShortcutAction.OpenAgentTask9,
] as const;

const SETTINGS_TAB_SHORTCUT_ACTIONS: Array<{
  action: ShortcutAction;
  initialTab: NonNullable<SettingsOpenOptions['initialTab']>;
}> = [
  { action: ShortcutAction.OpenSettingsGeneral, initialTab: 'general' },
  { action: ShortcutAction.OpenSettingsAppearance, initialTab: 'appearance' },
  { action: ShortcutAction.OpenSettingsAgentEngine, initialTab: 'coworkAgentEngine' },
  { action: ShortcutAction.OpenSettingsModel, initialTab: 'model' },
  { action: ShortcutAction.OpenSettingsIm, initialTab: 'im' },
  { action: ShortcutAction.OpenSettingsBrowser, initialTab: 'browserWebAccess' },
  { action: ShortcutAction.OpenSettingsEmail, initialTab: 'email' },
  { action: ShortcutAction.OpenSettingsMemory, initialTab: 'coworkMemory' },
  { action: ShortcutAction.OpenSettingsDreaming, initialTab: 'coworkDreaming' },
  { action: ShortcutAction.OpenSettingsPlugins, initialTab: 'plugins' },
  { action: ShortcutAction.OpenSettingsShortcuts, initialTab: 'shortcuts' },
  { action: ShortcutAction.OpenSettingsAbout, initialTab: 'about' },
];

/** Used for config + i18n init; longer on Windows where main-process IPC can stall during cold start. */
const INIT_STEP_TIMEOUT_MS_WINDOWS = 24_000;
const INIT_STEP_TIMEOUT_MS_DEFAULT = 16_000;

const logAppUpdateRendererLifecycle = (
  message: string,
  level: 'debug' | 'warn' = 'debug',
): void => {
  if (level === 'warn') {
    console.warn(`[AppUpdate] ${message}`);
  } else {
    console.debug(`[AppUpdate] ${message}`);
  }
  try {
    window.electron?.log?.fromRenderer?.(level, 'AppUpdate', message);
  } catch {
    // Best-effort diagnostic only.
  }
};

const App: React.FC = () => {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsOptions, setSettingsOptions] = useState<SettingsOpenOptions & { requestId: number }>({ requestId: 0 });
  const [mainView, setMainView] = useState<'cowork' | 'skills' | 'scheduledTasks' | 'kits' | 'mcp' | 'sites'>('cowork');
  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [, forceLanguageRefresh] = useState(0);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => (
    window.electron?.platform === 'web'
    && window.matchMedia('(max-width: 767px)').matches
  ));
  const [sidebarWidth, setSidebarWidth] = useState(244);
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateRuntimeState>({
    status: AppUpdateStatus.Idle,
    source: null,
    info: null,
    progress: null,
    readyFilePath: null,
    readyFileHash: null,
    errorMessage: null,
  });
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [isUpdateCardExpanded, setIsUpdateCardExpanded] = useState(false);
  const [isUserInitiatedUpdateFlowActive, setIsUserInitiatedUpdateFlowActive] = useState(false);
  const [privacyAgreed, setPrivacyAgreed] = useState<boolean | null>(null);
  const [showWelcome, setShowWelcome] = useState(false);
  const [enterpriseConfig, setEnterpriseConfig] = useState<{
    ui?: Record<string, 'hide' | 'disable' | 'readonly'>;
    disableUpdate?: boolean;
  } | null>(null);
  const [codingPlanAccount, setCodingPlanAccount] = useState<CodingPlanAccountUser | null>(null);
  const [codingPlanAccountLoaded, setCodingPlanAccountLoaded] = useState(false);
  const toastTimerRef = useRef<number | null>(null);
  const askAiFocusTimerRef = useRef<number | null>(null);
  const hasInitialized = useRef(false);
  const hasReportedAppStartedRef = useRef(false);
  const previousUpdateStatusRef = useRef<AppUpdateRuntimeState['status']>(AppUpdateStatus.Idle);
  const shouldInstallReadyUpdateRef = useRef(false);
  const isUserInitiatedUpdateFlowActiveRef = useRef(false);
  const dispatch = useDispatch();
  const defaultSelectedModel = useSelector((state: RootState) => state.model.defaultSelectedModel);
  const currentSessionId = useSelector(selectCurrentSessionId);
  const pendingPermission = useSelector(selectFirstCurrentSessionPendingPermission);
  const pendingPermissions = useSelector(selectPendingPermissions);
  const authUser = useSelector((state: RootState) => state.auth.user);
  const authIsLoading = useSelector((state: RootState) => state.auth.isLoading);
  const isWindows = window.electron.platform === 'win32';
  const isWebRuntime = window.electron.platform === 'web';
  const [minimizedPermissionIds, setMinimizedPermissionIds] = useState<string[]>([]);
  const isPendingPermissionMinimized = pendingPermission
    ? minimizedPermissionIds.includes(pendingPermission.requestId)
    : false;
  const isPermissionModalOpen = pendingPermission !== null && !isPendingPermissionMinimized;
  const isUpdateInteractionBlocked = shouldBlockAppInteractionForUpdate(
    isUserInitiatedUpdateFlowActive,
    appUpdateState.status,
  );

  const waitWithTimeout = useCallback(
    async <T,>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
      return await new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        promise.then(
          (value) => {
            window.clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            window.clearTimeout(timer);
            reject(error);
          }
        );
      });
    },
    []
  );

  // 初始化应用
  useEffect(() => {
    if (hasInitialized.current) {
      return;
    }
    hasInitialized.current = true;

    const initializeApp = async () => {
      const t0 = performance.now();
      const mark = (label: string) => {
        const elapsed = Math.round(performance.now() - t0);
        const msg = `initializeApp: ${label} (+${elapsed}ms)`;
        console.info(`[App] ${msg}`);
        try { window.electron?.log?.fromRenderer?.('info', 'App', msg); } catch { /* preload may not expose this yet */ }
      };

      try {
        mark('start');
        document.documentElement.classList.add(`platform-${window.electron.platform}`);

        const initTimeoutMs =
          window.electron.platform === 'win32'
            ? INIT_STEP_TIMEOUT_MS_WINDOWS
            : INIT_STEP_TIMEOUT_MS_DEFAULT;
        mark('configService.init begin');
        await waitWithTimeout(configService.init(), initTimeoutMs, 'configService.init');
        mark('configService.init done');

        const entConfig = await window.electron.enterprise.getConfig();
        setEnterpriseConfig(entConfig);
        mark('enterprise.getConfig done');

        themeService.initialize();
        mark('themeService done');

        mark('i18nService.initialize begin');
        await waitWithTimeout(i18nService.initialize(), initTimeoutMs, 'i18nService.initialize');
        mark('i18nService.initialize done');

        mark('authService.init begin');
        await authService.init();
        mark('authService.init done');

        const config = await configService.getConfig();
        applyTypographyPreferences(config);
        const apiConfig: ApiConfig = {
          apiKey: config.api.key,
          baseUrl: config.api.baseUrl,
        };
        apiService.setConfig(apiConfig);

        const providerModels: { id: string; name: string; provider?: string; providerKey?: string; openClawProviderId?: string; supportsImage?: boolean }[] = [];
        if (config.providers) {
          Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
            if (providerConfig.enabled && providerConfig.models) {
              const openClawProviderId = ProviderRegistry.getOpenClawProviderIdForConfig(providerName, providerConfig);
              if (providerName === ProviderName.Minimax && providerConfig.authType === ProviderAuthType.OAuth) {
                mark('MiniMax OAuth provider resolved to OpenClaw minimax-portal');
              }
              providerConfig.models.forEach((model: { id: string; name: string; supportsImage?: boolean }) => {
                providerModels.push({
                  id: model.id,
                  name: model.name,
                  provider: getProviderDisplayName(providerName, providerConfig),
                  providerKey: providerName,
                  openClawProviderId,
                  supportsImage: model.supportsImage ?? false,
                });
              });
            }
          });
        }
        dispatch(setAvailableModels(providerModels));
        if (providerModels.length > 0) {
          const allModels = store.getState().model.availableModels;
          const preferredModel = allModels.find(
            model => model.id === config.model.defaultModel
              && (!config.model.defaultModelProvider || model.providerKey === config.model.defaultModelProvider)
          ) ?? allModels[0];
          dispatch(setDefaultSelectedModel(preferredModel));
        }
        mark('model resolution done');

        const agreed = await window.electron.store.get('privacy_agreed');
        setPrivacyAgreed(agreed === true);
        mark('privacy check done');

        setIsInitialized(true);
        mark('shell ready');
        if (!hasReportedAppStartedRef.current) {
          hasReportedAppStartedRef.current = true;
          void reportAnalytics({
            action: LogReporterAction.AppStarted,
            providerModelCount: providerModels.length,
            hasLoggedInUser: !!store.getState().auth.user?.yid,
          });
        }

        if (!isWebRuntime) {
          void waitWithTimeout(scheduledTaskService.init(), 5000, 'scheduledTaskService.init').catch((error) => {
            console.error('[App] initializeApp: scheduledTaskService.init failed:', error);
          });
        }

      } catch (error) {
        const elapsed = Math.round(performance.now() - t0);
        const msg = error instanceof Error ? error.message : String(error);
        const detail = `initializeApp FAILED after ${elapsed}ms: ${msg}`;
        console.error(`[App] ${detail}`);
        try { window.electron?.log?.fromRenderer?.('error', 'App', detail); } catch { /* best-effort */ }
        setInitError(i18nService.t('initializationError'));
        setIsInitialized(true);
      }
    };

    void initializeApp();
  }, [dispatch, isWebRuntime, waitWithTimeout]);

  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      forceLanguageRefresh((prev) => prev + 1);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (authUser) {
      void authService.fetchProfileSummary();
    }
  }, [authUser]);

  useEffect(() => {
    if (isWebRuntime) {
      setCodingPlanAccountLoaded(true);
      return;
    }
    let active = true;
    void window.electron.codingPlan.getAccount()
      .then(result => {
        if (active) {
          setCodingPlanAccount(result.success ? result.data : null);
        }
      })
      .catch(() => {
        if (active) setCodingPlanAccount(null);
      })
      .finally(() => {
        if (active) setCodingPlanAccountLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [isWebRuntime]);

  // Listen for Copilot token auto-refresh events from the main process
  useEffect(() => {
    const removeListener = window.electron.githubCopilot.onTokenUpdated(({ token, baseUrl }) => {
      console.log('[App] received Copilot token update from main process');
      apiService.setProviderRuntimeCredential(ProviderName.Copilot, {
        apiKey: token,
        ...(baseUrl ? { baseUrl } : {}),
      });
    });
    return removeListener;
  }, []);

  // Network status monitoring
  useEffect(() => {
    const handleOnline = () => {
      console.log('[Renderer] Network online');
      window.electron.networkStatus.send('online');
    };

    const handleOffline = () => {
      console.log('[Renderer] Network offline');
      window.electron.networkStatus.send('offline');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!isInitialized || !defaultSelectedModel?.id) return;
    const config = configService.getConfig();
    if (
      config.model.defaultModel === defaultSelectedModel.id
      && (config.model.defaultModelProvider ?? '') === (defaultSelectedModel.providerKey ?? '')
    ) {
      return;
    }
    void configService.updateConfig({
      model: {
        ...config.model,
        defaultModel: defaultSelectedModel.id,
        defaultModelProvider: defaultSelectedModel.providerKey,
      },
    });
  }, [isInitialized, defaultSelectedModel?.id, defaultSelectedModel?.providerKey]);

  const handleShowSettings = useCallback((options?: SettingsOpenOptions) => {
    if (isWebRuntime) return;
    setSettingsOptions((current) => ({
      initialTab: options?.initialTab,
      notice: options?.notice,
      noticeI18nKey: options?.noticeI18nKey,
      noticeExtra: options?.noticeExtra,
      requestId: current.requestId + 1,
    }));
    setShowSettings(true);
  }, [isWebRuntime]);

  const handleShowSkills = useCallback(() => {
    if (isWebRuntime) return;
    setMainView('skills');
  }, [isWebRuntime]);

  const handleShowCowork = useCallback(() => {
    setMainView('cowork');
  }, []);

  const handleShowScheduledTasks = useCallback(() => {
    if (isWebRuntime) return;
    setMainView('scheduledTasks');
  }, [isWebRuntime]);

  const handleShowMcp = useCallback(() => {
    if (isWebRuntime) return;
    setMainView('mcp');
  }, [isWebRuntime]);

  const handleShowSites = useCallback(() => {
    if (isWebRuntime) return;
    setMainView('sites');
  }, [isWebRuntime]);

  const handleShowKits = useCallback(() => {
    if (isWebRuntime) return;
    setMainView('kits');
  }, [isWebRuntime]);

  const openHomeWithKit = useCallback((kitId: string, text?: string) => {
    dispatch(setActiveKitIds([kitId]));
    coworkService.clearSession({ restoreAgentSkills: true });
    dispatch(clearSelection());
    if (text !== undefined) {
      dispatch(setDraftCollaborationMode({
        draftKey: '__home__',
        mode: CoworkCollaborationMode.Default,
      }));
      // Set the draft prompt before switching view, so that when CoworkPromptInput
      // mounts/updates with draftKey='__home__', it picks up the text.
      dispatch(setDraftPrompt({ sessionId: '__home__', draft: text }));
    }
    dispatch(setDraftKitIds({ draftKey: '__home__', kitIds: [kitId] }));
    setMainView('cowork');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(CoworkUiEvent.FocusInput, {
        // Without text, keep any existing home draft and just focus with the kit selected
        detail: text !== undefined ? { resetCollaborationMode: true, text } : { clear: false },
      }));
    }, 0);
  }, [dispatch]);

  const handleKitTryAsking = useCallback((text: string, kitId: string) => {
    openHomeWithKit(kitId, text);
  }, [openHomeWithKit]);

  const handleKitUse = useCallback((kitId: string) => {
    openHomeWithKit(kitId);
  }, [openHomeWithKit]);

  const handleToggleSidebar = useCallback(() => {
    const nextCollapsed = !isSidebarCollapsed;
    const message = `sidebar toggle requested activeView=${mainView} nextCollapsed=${nextCollapsed} platform=${window.electron.platform}`;
    console.debug(`[AppLayout] ${message}`);
    try {
      window.electron?.log?.fromRenderer?.('debug', 'AppLayout', message);
    } catch {
      // Logging should never block sidebar interactions.
    }
    void reportAnalytics({
      action: LogReporterAction.SidebarAction,
      source: 'home_sidebar',
      actionType: isSidebarCollapsed ? 'expand_sidebar' : 'collapse_sidebar',
      activeView: mainView,
      isCollapsed: isSidebarCollapsed,
    });
    setIsSidebarCollapsed((prev) => !prev);
  }, [isSidebarCollapsed, mainView]);

  const handleNewChat = useCallback(() => {
    // Only clear when already on home (no session) — preserve __home__ draft when returning from a session
    const shouldClearInput = mainView === 'cowork' && !currentSessionId;
    coworkService.clearSession({ restoreAgentSkills: true });
    dispatch(clearSelection());
    dispatch(setDraftCollaborationMode({
      draftKey: '__home__',
      mode: CoworkCollaborationMode.Default,
    }));
    setMainView('cowork');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(CoworkUiEvent.FocusInput, {
        detail: { clear: shouldClearInput, resetCollaborationMode: true },
      }));
    }, 0);
  }, [dispatch, mainView, currentSessionId]);

  const handleCreateSkillByChat = useCallback(() => {
    dispatch(setDraftPrompt({ sessionId: '__home__', draft: i18nService.t('skillCreatorPrompt') }));
    coworkService.clearSession();
    dispatch(clearSelection());
    dispatch(setDraftCollaborationMode({
      draftKey: '__home__',
      mode: CoworkCollaborationMode.Default,
    }));
    setMainView('cowork');
  }, [dispatch]);

  const handleCreateSiteByChat = useCallback((prompt: string) => {
    coworkService.clearSession({ restoreAgentSkills: true });
    dispatch(clearSelection());
    dispatch(clearDraftAttachments('__home__'));
    dispatch(clearDraftSelectedTextSnippets('__home__'));
    dispatch(setActiveKitIds([]));
    dispatch(setDraftKitIds({ draftKey: '__home__', kitIds: [] }));
    dispatch(setDraftCollaborationMode({
      draftKey: '__home__',
      mode: CoworkCollaborationMode.Default,
    }));
    dispatch(setDraftPrompt({ sessionId: '__home__', draft: prompt }));
    setMainView('cowork');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(CoworkUiEvent.FocusInput, {
        detail: { clear: false, resetCollaborationMode: true, text: prompt },
      }));
    }, 0);
  }, [dispatch]);

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, 2200);
  }, []);

  const startUserInitiatedUpdateFlow = useCallback((reason: string) => {
    if (!isUserInitiatedUpdateFlowActiveRef.current) {
      logAppUpdateRendererLifecycle(`interaction lock started reason=${reason}`);
    }
    isUserInitiatedUpdateFlowActiveRef.current = true;
    setIsUserInitiatedUpdateFlowActive(true);
  }, []);

  const stopUserInitiatedUpdateFlow = useCallback((reason: string) => {
    if (!isUserInitiatedUpdateFlowActiveRef.current) return;

    isUserInitiatedUpdateFlowActiveRef.current = false;
    setIsUserInitiatedUpdateFlowActive(false);
    logAppUpdateRendererLifecycle(`interaction lock released reason=${reason}`);
  }, []);

  useEffect(() => {
    if (isWebRuntime) return undefined;
    let mounted = true;

    const loadInitialUpdateState = async () => {
      try {
        const state = await window.electron.appUpdate.getState();
        if (mounted) {
          setAppUpdateState(state);
          previousUpdateStatusRef.current = state.status;
          // A previous install attempt quit the app without completing
          // (e.g. the installer never launched) — re-prompt the user.
          if (state.status === AppUpdateStatus.Ready && state.installIncomplete) {
            setShowUpdateModal(true);
          }
        }
        // Silent installs relaunch the app with no visible install step, so
        // this toast is the only confirmation the update actually happened.
        const completed = await window.electron.appUpdate.getCompletedUpdate?.();
        if (mounted && completed?.version) {
          showToast(`${i18nService.t('updateInstalledToast')} v${completed.version}`);
        }
      } catch (error) {
        console.error('[App] failed to load initial app update state:', error);
      }
    };

    void loadInitialUpdateState();

    const unsubscribe = window.electron.appUpdate.onStateChanged((state) => {
      const previousStatus = previousUpdateStatusRef.current;
      previousUpdateStatusRef.current = state.status;
      setAppUpdateState(state);

      if (!isAppUpdateInteractionBlockingStatus(state.status)) {
        shouldInstallReadyUpdateRef.current = false;
        stopUserInitiatedUpdateFlow(`state=${state.status}`);
      }

      if (
        state.status === AppUpdateStatus.Ready
        && previousStatus !== AppUpdateStatus.Ready
        && shouldInstallReadyUpdateRef.current
      ) {
        shouldInstallReadyUpdateRef.current = false;
        if (state.readyFilePath) {
          logAppUpdateRendererLifecycle(
            `download ready; starting install version=${state.info?.latestVersion ?? 'unknown'}`,
          );
          void window.electron.appUpdate.installReady()
            .then((installResult) => {
              if (!installResult.success) {
                stopUserInitiatedUpdateFlow('install-result-failed');
                showToast(
                  installResult.error
                    ? formatAppUpdateError(installResult.error)
                    : i18nService.t('updateInstallFailed'),
                );
              }
            })
            .catch((error) => {
              stopUserInitiatedUpdateFlow('install-ipc-failed');
              console.error('[AppUpdate] failed to install downloaded update:', error);
              showToast(i18nService.t('updateInstallFailed'));
            });
        } else {
          stopUserInitiatedUpdateFlow('ready-file-missing');
          logAppUpdateRendererLifecycle(
            `ready update is missing its installer path version=${state.info?.latestVersion ?? 'unknown'}`,
            'warn',
          );
          showToast(i18nService.t('updateInstallFailed'));
        }
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [isWebRuntime, showToast, stopUserInitiatedUpdateFlow]);

  const handleShowLogin = useCallback(() => {
    handleShowSettings({ initialTab: 'codingPlan' });
  }, [handleShowSettings]);

  const runUpdateCheck = useCallback(async () => {
    try {
      const result = await window.electron.appUpdate.checkNow({ userId: authUser?.yid });
      setAppUpdateState(result.state);
      if (!result.success) {
        console.error('[App] app update check failed:', result.error);
      }
    } catch (error) {
      console.error('Failed to check app update:', error);
    }
  }, [authUser]);

  const updateInfo = appUpdateState.info;

  const handleOpenUpdateModal = useCallback(() => {
    if (!updateInfo) return;

    const message = `update modal requested status=${appUpdateState.status} source=${appUpdateState.source ?? 'none'} version=${updateInfo.latestVersion}`;
    logAppUpdateRendererLifecycle(message);
    setShowUpdateModal(true);
  }, [appUpdateState.source, appUpdateState.status, updateInfo]);

  const handleUpdateFound = useCallback((_info: AppUpdateInfo) => {
    setShowUpdateModal(true);
  }, []);

  const handleConfirmUpdate = useCallback(async () => {
    if (!updateInfo) return;

    if (appUpdateState.readyFilePath) {
      setShowUpdateModal(false);
      shouldInstallReadyUpdateRef.current = false;
      startUserInitiatedUpdateFlow(
        `install-ready version=${updateInfo.latestVersion}`,
      );
      try {
        const installResult = await window.electron.appUpdate.installReady();
        if (!installResult.success) {
          stopUserInitiatedUpdateFlow('install-result-failed');
          showToast(
            installResult.error
              ? formatAppUpdateError(installResult.error)
              : i18nService.t('updateInstallFailed'),
          );
        }
      } catch (error) {
        stopUserInitiatedUpdateFlow('install-ipc-failed');
        console.error('[AppUpdate] failed to install ready update:', error);
        showToast(i18nService.t('updateInstallFailed'));
      }
      return;
    }

    if (appUpdateState.status === AppUpdateStatus.Error || appUpdateState.status === AppUpdateStatus.Available) {
      if (!isManualDownloadUrl(updateInfo.url)) {
        setShowUpdateModal(false);
        // The user explicitly asked to update (or retry), so finish the whole
        // flow in one click: install and restart as soon as the download lands.
        shouldInstallReadyUpdateRef.current = true;
        startUserInitiatedUpdateFlow(
          `download-and-install version=${updateInfo.latestVersion}`,
        );
        try {
          const retryResult = await window.electron.appUpdate.retryDownload();
          if (
            !retryResult.success
            || retryResult.state.status !== AppUpdateStatus.Downloading
          ) {
            stopUserInitiatedUpdateFlow(
              `download-not-started state=${retryResult.state.status}`,
            );
            shouldInstallReadyUpdateRef.current = false;
            showToast(i18nService.t('updateDownloadFailed'));
          }
        } catch (error) {
          stopUserInitiatedUpdateFlow('download-ipc-failed');
          shouldInstallReadyUpdateRef.current = false;
          console.error('[AppUpdate] failed to start update download:', error);
          showToast(i18nService.t('updateDownloadFailed'));
        }
        return;
      }
    }

    if (isManualDownloadUrl(updateInfo.url)) {
      shouldInstallReadyUpdateRef.current = false;
      setShowUpdateModal(false);
      try {
        const result = await window.electron.shell.openExternal(updateInfo.url);
        if (!result.success) {
          showToast(i18nService.t('updateOpenFailed'));
        }
      } catch (error) {
        console.error('Failed to open update url:', error);
        showToast(i18nService.t('updateOpenFailed'));
      }
      return;
    }
  }, [
    appUpdateState.readyFilePath,
    appUpdateState.status,
    showToast,
    startUserInitiatedUpdateFlow,
    stopUserInitiatedUpdateFlow,
    updateInfo,
  ]);

  const handleCancelDownload = useCallback(async () => {
    shouldInstallReadyUpdateRef.current = false;
    stopUserInitiatedUpdateFlow('download-cancel-requested');
    try {
      const cancelResult = await window.electron.appUpdate.cancelDownload();
      if (cancelResult.state.status === AppUpdateStatus.Downloading) {
        logAppUpdateRendererLifecycle(
          'download cancel request completed but the update is still downloading',
          'warn',
        );
      }
    } catch (error) {
      console.error('[AppUpdate] failed to cancel update download:', error);
      showToast(i18nService.t('updateDownloadFailed'));
    }
  }, [showToast, stopUserInitiatedUpdateFlow]);

  const handleRetryUpdate = useCallback(async () => {
    await handleConfirmUpdate();
  }, [handleConfirmUpdate]);

  const handlePrivacyAccept = useCallback(async () => {
    await window.electron.store.set('privacy_agreed', true);
    setPrivacyAgreed(true);
    setShowWelcome(true);
  }, []);

  const handlePrivacyReject = useCallback(() => {
    // 立刻隐藏窗口，让用户感觉立即关闭
    window.electron.window.close();
  }, []);

  const handleWelcomeLogin = useCallback(async () => {
    setShowWelcome(false);
    await authService.login();
  }, []);
  const handleWelcomeCustomModel = useCallback(() => {
    setShowWelcome(false);
    handleShowSettings({ initialTab: 'model' });
  }, [handleShowSettings]);

  const handlePermissionResponse = useCallback(async (result: CoworkPermissionResult) => {
    if (!pendingPermission) return;
    await coworkService.respondToPermission(pendingPermission.requestId, result);
  }, [pendingPermission]);

  const handleMinimizePermission = useCallback(() => {
    if (!pendingPermission) return;
    setMinimizedPermissionIds((previous) => (
      previous.includes(pendingPermission.requestId)
        ? previous
        : [...previous, pendingPermission.requestId]
    ));
  }, [pendingPermission]);

  const handleRestorePermission = useCallback(() => {
    if (!pendingPermission) return;
    setMinimizedPermissionIds((previous) => (
      previous.filter((requestId) => requestId !== pendingPermission.requestId)
    ));
  }, [pendingPermission]);

  useEffect(() => {
    const activeRequestIds = new Set(pendingPermissions.map((permission) => permission.requestId));
    setMinimizedPermissionIds((previous) => {
      const next = previous.filter((requestId) => activeRequestIds.has(requestId));
      return next.length === previous.length ? previous : next;
    });
  }, [pendingPermissions]);

  const handleCloseSettings = () => {
    setShowSettings(false);
    const config = configService.getConfig();
    apiService.setConfig({
      apiKey: config.api.key,
      baseUrl: config.api.baseUrl,
    });

    if (config.providers) {
      const allModels: { id: string; name: string; provider?: string; providerKey?: string; openClawProviderId?: string; supportsImage?: boolean }[] = [];
      Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
        if (providerConfig.enabled && providerConfig.models) {
          const openClawProviderId = ProviderRegistry.getOpenClawProviderIdForConfig(providerName, providerConfig);
          providerConfig.models.forEach((model: { id: string; name: string; supportsImage?: boolean }) => {
            allModels.push({
              id: model.id,
              name: model.name,
              provider: getProviderDisplayName(providerName, providerConfig),
              providerKey: providerName,
              openClawProviderId,
              supportsImage: model.supportsImage ?? false,
            });
          });
        }
      });
      dispatch(setAvailableModels(allModels));
    }
  };

  const handleStartAiSkinFromSettings = (text: string, kitId: string) => {
    handleCloseSettings();
    openHomeWithKit(kitId, text);
  };

  const isShortcutInputActive = () => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return false;
    return activeElement.dataset.shortcutInput === 'true';
  };

  const isTextEditingActive = () => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return false;
    if (activeElement.isContentEditable) return true;
    if (activeElement instanceof HTMLTextAreaElement) return true;
    if (activeElement instanceof HTMLSelectElement) return true;
    return activeElement instanceof HTMLInputElement;
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isShortcutInputActive() || isTextEditingActive()) return;

      const { shortcuts } = configService.getConfig();
      const activeShortcuts = {
        ...defaultConfig.shortcuts,
        ...(shortcuts ?? {}),
      };

      const matchesAction = (action: ShortcutAction) => matchesShortcut(event, activeShortcuts[action]);

      if (showSettings) {
        if (matchesAction(ShortcutAction.ShowShortcuts)) {
          event.preventDefault();
          handleShowSettings({ initialTab: 'shortcuts' });
        }
        return;
      }

      if (showUpdateModal || isPermissionModalOpen || isUpdateInteractionBlocked) return;

      if (matchesAction(ShortcutAction.NewChat)) {
        event.preventDefault();
        handleNewChat();
        return;
      }

      if (matchesAction(ShortcutAction.Search)) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutSearch));
        return;
      }

      if (matchesAction(ShortcutAction.Settings)) {
        event.preventDefault();
        handleShowSettings();
        return;
      }

      if (matchesAction(ShortcutAction.ShowShortcuts)) {
        event.preventDefault();
        handleShowSettings({ initialTab: 'shortcuts' });
        return;
      }

      const settingsTabShortcut = SETTINGS_TAB_SHORTCUT_ACTIONS.find(({ action }) => matchesAction(action));
      if (settingsTabShortcut) {
        event.preventDefault();
        handleShowSettings({ initialTab: settingsTabShortcut.initialTab });
        return;
      }

      if (matchesAction(ShortcutAction.FocusPrompt)) {
        event.preventDefault();
        setMainView('cowork');
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent(CoworkUiEvent.FocusInput, {
            detail: { clear: false },
          }));
        }, 0);
        return;
      }

      if (matchesAction(ShortcutAction.StopCurrentTask)) {
        event.preventDefault();
        if (mainView === 'cowork') {
          window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutStopSession));
        } else if (currentSessionId) {
          void coworkService.stopSession(currentSessionId);
        }
        return;
      }

      if (matchesAction(ShortcutAction.ToggleSidebar)) {
        event.preventDefault();
        handleToggleSidebar();
        return;
      }

      if (matchesAction(ShortcutAction.ToggleArtifacts)) {
        event.preventDefault();
        setMainView('cowork');
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutToggleArtifacts));
        }, 0);
        return;
      }

      if (matchesAction(ShortcutAction.PreviousAgent)) {
        event.preventDefault();
        setMainView('cowork');
        setIsSidebarCollapsed(false);
        window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutSwitchAgent, {
          detail: { direction: CoworkShortcutDirection.Previous },
        }));
        return;
      }

      if (matchesAction(ShortcutAction.NextAgent)) {
        event.preventDefault();
        setMainView('cowork');
        setIsSidebarCollapsed(false);
        window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutSwitchAgent, {
          detail: { direction: CoworkShortcutDirection.Next },
        }));
        return;
      }

      if (matchesAction(ShortcutAction.ShowCurrentAgentTasks)) {
        event.preventDefault();
        setMainView('cowork');
        setIsSidebarCollapsed(false);
        window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutShowCurrentAgentTasks));
        return;
      }

      const taskSlotIndex = AGENT_TASK_SLOT_SHORTCUT_ACTIONS.findIndex(action => matchesAction(action));
      if (taskSlotIndex >= 0) {
        event.preventDefault();
        setMainView('cowork');
        setIsSidebarCollapsed(false);
        window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutOpenAgentTaskSlot, {
          detail: { slot: taskSlotIndex + 1 },
        }));
        return;
      }

      if (matchesAction(ShortcutAction.OpenCowork)) {
        event.preventDefault();
        handleShowCowork();
        return;
      }

      if (matchesAction(ShortcutAction.OpenScheduledTasks)) {
        event.preventDefault();
        handleShowScheduledTasks();
        return;
      }

      if (matchesAction(ShortcutAction.OpenKits)) {
        event.preventDefault();
        handleShowKits();
        return;
      }

      if (matchesAction(ShortcutAction.OpenSkills)) {
        event.preventDefault();
        handleShowSkills();
        return;
      }

      if (matchesAction(ShortcutAction.OpenMcp)) {
        event.preventDefault();
        handleShowMcp();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    currentSessionId,
    handleNewChat,
    handleShowCowork,
    handleShowKits,
    handleShowMcp,
    handleShowScheduledTasks,
    handleShowSettings,
    handleShowSkills,
    handleToggleSidebar,
    isUpdateInteractionBlocked,
    mainView,
    isPermissionModalOpen,
    showSettings,
    showUpdateModal,
  ]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  // Listen for toast events from child components
  useEffect(() => {
    const handler = (e: Event) => {
      const message = (e as CustomEvent<string>).detail;
      if (message) showToast(message);
    };
    window.addEventListener('app:showToast', handler);
    return () => window.removeEventListener('app:showToast', handler);
  }, [showToast]);

  // Listen for ask-ai events: close settings, open a new chat, and pre-fill its input.
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (typeof text !== 'string' || !text.trim()) {
        console.warn('[AskAI] ignored navigation request because the prompt was empty.');
        return;
      }

      const coworkState = store.getState().cowork;
      const diagnostic = [
        'opening new chat with prefilled prompt;',
        `hadCurrentSession=${Boolean(coworkState.currentSessionId)},`,
        `remoteManaged=${coworkState.remoteManaged},`,
        `promptLength=${text.length}`,
      ].join(' ');
      console.debug(`[AskAI] ${diagnostic}`);
      try {
        window.electron?.log?.fromRenderer?.('debug', 'AskAI', diagnostic);
      } catch {
        // Logging must not block navigation.
      }

      coworkService.clearSession({ restoreAgentSkills: true });
      dispatch(clearSelection());
      dispatch(setDraftCollaborationMode({
        draftKey: '__home__',
        mode: CoworkCollaborationMode.Default,
      }));
      dispatch(setDraftPrompt({ sessionId: '__home__', draft: text }));
      dispatch(clearDraftAttachments('__home__'));
      dispatch(clearDraftSelectedTextSnippets('__home__'));
      setShowSettings(false);
      setMainView('cowork');
      if (askAiFocusTimerRef.current !== null) {
        window.clearTimeout(askAiFocusTimerRef.current);
      }
      askAiFocusTimerRef.current = window.setTimeout(() => {
        askAiFocusTimerRef.current = null;
        window.dispatchEvent(
          new CustomEvent(CoworkUiEvent.FocusInput, {
            detail: { text },
          }),
        );
      }, 50);
    };
    window.addEventListener('app:ask-ai', handler);
    return () => {
      window.removeEventListener('app:ask-ai', handler);
      if (askAiFocusTimerRef.current !== null) {
        window.clearTimeout(askAiFocusTimerRef.current);
        askAiFocusTimerRef.current = null;
      }
    };
  }, [dispatch]);

  // 监听托盘菜单打开设置的 IPC 事件
  useEffect(() => {
    const unsubscribe = window.electron.ipcRenderer.on('app:openSettings', () => {
      handleShowSettings();
    });
    return unsubscribe;
  }, [handleShowSettings]);

  // 监听托盘菜单新建任务的 IPC 事件
  useEffect(() => {
    const unsubscribe = window.electron.ipcRenderer.on('app:newTask', () => {
      handleNewChat();
    });
    return unsubscribe;
  }, [handleNewChat]);

  useEffect(() => {
    const unsubscribe = window.electron.cowork.onOpenSessionFromNotification?.(({ sessionId }) => {
      setShowSettings(false);
      setMainView('cowork');
      void coworkService.loadSession(sessionId);
    });
    void window.electron.cowork.notifyOpenSessionFromNotificationReady?.();
    return unsubscribe;
  }, []);

  // Tell the main process which session is currently visible so desktop
  // notifications for that session can be suppressed and cleared.
  useEffect(() => {
    const visibleSessionId = mainView === 'cowork' && !showSettings ? currentSessionId ?? null : null;
    void window.electron.cowork.setActiveSession?.(visibleSessionId)?.catch?.((error: unknown) => {
      console.debug('[App] failed to report active session:', error);
    });
  }, [mainView, showSettings, currentSessionId]);

  useEffect(() => {
    if (!isInitialized || isWebRuntime) return;

    // Enterprise mode: completely skip update detection
    if (enterpriseConfig?.disableUpdate) return;

    let cancelled = false;
    let lastCheckTime = 0;

    const maybeCheck = async (reason: 'startup' | 'heartbeat' | 'visibility') => {
      if (cancelled) return;
      const now = Date.now();
      if (lastCheckTime > 0 && now - lastCheckTime < APP_UPDATE_POLL_INTERVAL_MS) return;
      lastCheckTime = now;
      console.log(`[App] auto update check triggered, reason=${reason}, at=${new Date(now).toISOString()}`);
      await runUpdateCheck();
    };

    // 启动时立即检查
    void maybeCheck('startup');

    // 心跳：每 30 分钟检测是否距上次检查已超过 2 小时
    const timer = window.setInterval(() => {
      void maybeCheck('heartbeat');
    }, APP_UPDATE_HEARTBEAT_INTERVAL_MS);

    // 窗口恢复可见时检测（覆盖休眠唤醒场景）
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void maybeCheck('visibility');
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isInitialized, isWebRuntime, runUpdateCheck, enterpriseConfig]);

  // 根据场景选择使用哪个权限组件。最小化时保持组件挂载（仅视觉隐藏），
  // 避免重新展开后丢失用户已选择/已输入的内容；key 按 requestId 隔离不同请求的状态。
  const permissionModal = useMemo(() => {
    if (!pendingPermission) return null;

    // 检查是否为 AskUserQuestion 且有多个问题 -> 使用向导式组件
    const isQuestionTool = pendingPermission.toolName === 'AskUserQuestion';
    if (isQuestionTool && pendingPermission.toolInput) {
      const rawQuestions = (pendingPermission.toolInput as Record<string, unknown>).questions;
      const hasMultipleQuestions = Array.isArray(rawQuestions) && rawQuestions.length > 1;

      if (hasMultipleQuestions) {
        return (
          <CoworkQuestionWizard
            key={pendingPermission.requestId}
            permission={pendingPermission}
            onRespond={handlePermissionResponse}
            onMinimize={handleMinimizePermission}
            hidden={isPendingPermissionMinimized}
          />
        );
      }
    }

    // 其他情况使用原有的权限模态框
    return (
      <CoworkPermissionModal
        key={pendingPermission.requestId}
        permission={pendingPermission}
        onRespond={handlePermissionResponse}
        onMinimize={handleMinimizePermission}
        hidden={isPendingPermissionMinimized}
      />
    );
  }, [pendingPermission, handlePermissionResponse, handleMinimizePermission, isPendingPermissionMinimized]);

  const isOverlayActive = showSettings
    || showUpdateModal
    || isPermissionModalOpen
    || isUpdateInteractionBlocked;
  // Keep the badge visible while downloading so the collapsed-sidebar layouts
  // still surface progress; only a plain re-check hides nothing new.
  const shouldShowUpdateBadge = updateInfo && appUpdateState.status !== AppUpdateStatus.Checking;
  const updateBadge = shouldShowUpdateBadge ? (
    <AppUpdateBadge
      latestVersion={updateInfo.latestVersion}
      status={appUpdateState.status}
      progress={appUpdateState.progress?.percent}
      onClick={handleOpenUpdateModal}
    />
  ) : null;
  const updateCard = updateInfo ? (
    <AppUpdateCard
      updateState={appUpdateState}
      onUpdate={handleConfirmUpdate}
      onShowDetails={handleOpenUpdateModal}
      onCancelDownload={handleCancelDownload}
      onExpandedChange={setIsUpdateCardExpanded}
    />
  ) : null;
  const canUseWindowsTopBarActions = isInitialized && !initError && !isUpdateInteractionBlocked;
  const canUseWindowsCollapsedTopBarActions = canUseWindowsTopBarActions && isSidebarCollapsed;
  const collapsedHeaderUpdateBadge = isSidebarCollapsed && !isWindows ? updateBadge : null;
  const windowsStandaloneTitleBar = isWindows ? (
    <WindowsAppTitleBar
      isOverlayActive={isOverlayActive}
      isSidebarCollapsed={isSidebarCollapsed}
      sidebarWidth={sidebarWidth}
      onToggleSidebar={canUseWindowsTopBarActions ? handleToggleSidebar : undefined}
      onNewChat={canUseWindowsCollapsedTopBarActions ? handleNewChat : undefined}
      sidebarToggleLabel={isSidebarCollapsed ? i18nService.t('expand') : i18nService.t('collapse')}
      newChatLabel={i18nService.t('newChat')}
      updateBadge={canUseWindowsCollapsedTopBarActions ? updateBadge : null}
    />
  ) : null;

  if (!isInitialized) {
    // index.html's static splash shows the same startup page until React
    // mounts; rendering EngineStartupOverlay from the first frame keeps the
    // whole startup on one continuous screen with no visual handoff.
    return (
      <div className="h-screen overflow-hidden flex flex-col">
        {windowsStandaloneTitleBar}
        <div className="flex-1 bg-surface" />
        <EngineStartupOverlay bootstrapping />
      </div>
    );
  }

  if (initError) {
    return (
      <div className="h-screen overflow-hidden flex flex-col">
        {windowsStandaloneTitleBar}
        <div className="flex-1 flex flex-col items-center justify-center bg-background">
          <div className="flex flex-col items-center space-y-6 max-w-md px-6">
            <div className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center shadow-lg">
              <ChatBubbleLeftRightIcon className="h-8 w-8 text-white" />
            </div>
            <div className="text-foreground text-xl font-medium text-center">{initError}</div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => window.electron.appInfo.relaunch()}
                className="px-6 py-2.5 bg-primary hover:bg-primary-hover text-white rounded-xl transition-colors text-sm font-medium"
              >
                {i18nService.t('restartApp')}
              </button>
              <button
                onClick={() => handleShowSettings()}
                className="px-6 py-2.5 border border-border text-foreground hover:bg-surface-raised rounded-xl transition-colors text-sm font-medium"
              >
                {i18nService.t('openSettings')}
              </button>
            </div>
          </div>
          {showSettings && (
            <SkinProvider>
              <Settings
                onClose={handleCloseSettings}
                onCodingPlanAccountChange={setCodingPlanAccount}
                initialTab={settingsOptions.initialTab}
                initialTabRequestId={settingsOptions.requestId}
                notice={settingsOptions.notice}
                onUpdateFound={handleUpdateFound}
                enterpriseConfig={enterpriseConfig}
              />
            </SkinProvider>
          )}
        </div>
      </div>
    );
  }

  return (
    <SkinProvider>
      <SkinPresentationScope
        enabled
        className="h-screen overflow-hidden flex flex-col bg-surface-raised"
      >
      {toastMessage && (
        <Toast
          message={toastMessage}
          closeLabel={i18nService.t('close')}
          onClose={() => setToastMessage(null)}
        />
      )}
      {windowsStandaloneTitleBar}
      <div
        className="relative flex flex-1 min-h-0 overflow-hidden"
        aria-busy={isUpdateInteractionBlocked}
      >
        <Sidebar
          codingPlanAccount={codingPlanAccount}
          onShowLogin={handleShowLogin}
          onShowSettings={handleShowSettings}
          activeView={mainView}
          onShowSkills={handleShowSkills}
          onShowCowork={handleShowCowork}
          onShowScheduledTasks={handleShowScheduledTasks}
          onShowKits={handleShowKits}
          onShowMcp={handleShowMcp}
          onShowSites={handleShowSites}
          onNewChat={handleNewChat}
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={handleToggleSidebar}
          onWidthChange={setSidebarWidth}
          updateNotice={!isWebRuntime && !isSidebarCollapsed && !isUpdateInteractionBlocked ? updateCard : null}
          hideAdBanner={isUpdateCardExpanded}
          hideLogin={enterpriseConfig?.ui?.login === 'hide'}
          hideSites={isWebRuntime || !isTestModeEnabled() || enterpriseConfig?.ui?.sites === 'hide'}
        />
        <div className={`flex-1 min-w-0 transition-[padding] duration-200 ease-out ${isSidebarCollapsed ? 'pl-1.5' : ''}`}>
          <div
            data-skin-cowork-frame={mainView === 'cowork' ? 'true' : undefined}
            data-skin-management-frame={mainView !== 'cowork' ? 'true' : undefined}
            className="relative h-full min-h-0 rounded-xl border border-border bg-background overflow-hidden"
          >
            {mainView !== 'cowork' && (
              <SkinBackdrop variant={SkinBackdropVariant.Management} />
            )}
            <EngineStartupOverlay />
            {mainView === 'skills' ? (
              <SkillsView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                onCreateSkillByChat={handleCreateSkillByChat}
                updateBadge={collapsedHeaderUpdateBadge}
                readOnly={enterpriseConfig?.ui?.skills === 'readonly'}
              />
            ) : mainView === 'scheduledTasks' ? (
              <ScheduledTasksView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={collapsedHeaderUpdateBadge}
              />
            ) : mainView === 'kits' ? (
              <KitsView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={collapsedHeaderUpdateBadge}
                onTryAsking={handleKitTryAsking}
                onUseKit={handleKitUse}
              />
            ) : mainView === 'mcp' ? (
              <McpView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={collapsedHeaderUpdateBadge}
              />
            ) : mainView === 'sites' ? (
              <SitesView
                isAuthenticated={Boolean(authUser)}
                onCreateSiteByChat={handleCreateSiteByChat}
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                updateBadge={collapsedHeaderUpdateBadge}
                readOnly={enterpriseConfig?.ui?.sites === 'readonly'}
              />
            ) : (
              <CoworkView
                onRequestAppSettings={privacyAgreed === true && !showWelcome ? handleShowSettings : undefined}
                onShowSkills={handleShowSkills}
                onShowKits={handleShowKits}
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={collapsedHeaderUpdateBadge}
                minimizedPermission={isPendingPermissionMinimized ? pendingPermission : null}
                onRestorePermission={handleRestorePermission}
                onRespondToPermission={handlePermissionResponse}
              />
            )}
            {codingPlanAccountLoaded
              && !authIsLoading
              && !authUser
              && !codingPlanAccount
              && mainView === 'cowork'
              && !currentSessionId
              && !isWebRuntime && (
                <button
                  type="button"
                  onClick={() => {
                    void window.electron.shell.openExternal(getPortalRegisterUrl());
                  }}
                  className="absolute bottom-4 right-4 z-20 inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background/95 px-3 text-sm font-medium text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-surface-raised"
                >
                  {i18nService.t('codingPlanRegisterShort')}
                  <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                </button>
              )}
          </div>
        </div>
        {isUpdateInteractionBlocked && (
          <AppUpdateInteractionOverlay>
            <AppUpdateBlockingPanel
              updateState={appUpdateState}
              onCancelDownload={handleCancelDownload}
            />
          </AppUpdateInteractionOverlay>
        )}
      </div>

      <EngineFailureOverlay
        onRequestAppSettings={privacyAgreed === true && !showWelcome ? handleShowSettings : undefined}
        suspended={showSettings || showUpdateModal || isPermissionModalOpen || privacyAgreed === false || showWelcome}
      />

      {/* 设置窗口显示在所有主内容之上，但不影响主界面的交互 */}
      {showSettings && (
        <Settings
          onClose={handleCloseSettings}
          onCodingPlanAccountChange={setCodingPlanAccount}
          onStartAiSkin={handleStartAiSkinFromSettings}
          initialTab={settingsOptions.initialTab}
          initialTabRequestId={settingsOptions.requestId}
          notice={settingsOptions.notice}
          onUpdateFound={handleUpdateFound}
          enterpriseConfig={enterpriseConfig}
        />
      )}
      {showUpdateModal && updateInfo && (
        <AppUpdateModal
          updateState={appUpdateState}
          onCancel={() => {
            if (appUpdateState.status !== AppUpdateStatus.Downloading && appUpdateState.status !== AppUpdateStatus.Installing) {
              setShowUpdateModal(false);
            }
          }}
          onConfirm={handleConfirmUpdate}
          onCancelDownload={handleCancelDownload}
          onRetry={handleRetryUpdate}
        />
      )}
      {permissionModal}
      {privacyAgreed === false && (
        <PrivacyDialog
          onAccept={handlePrivacyAccept}
          onReject={handlePrivacyReject}
        />
      )}
      {showWelcome && (
        <WelcomeDialog
          onLogin={handleWelcomeLogin}
          onCustomModel={handleWelcomeCustomModel}
        />
      )}
      </SkinPresentationScope>
    </SkinProvider>
  );
};

export default App;
