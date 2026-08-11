import { store } from '../store';
import { configService } from './config';
import { getInstallationId } from './installationId';

export const LogReporterEndpoint = {
  GLMCodeAnalytics: 'https://glmcoding.cn/api/analytics/events',
} as const;

export const LogReporterProduct = {
  GLMCode: 'glm-code',
} as const;

export const LogReporterCategory = {
  Actions: 'actions',
} as const;

export const LogReporterActionPrefix = {
  GLMCode: 'glmcode_',
} as const;

export const LogReporterAction = {
  AgentCreateAction: 'glmcode_agent_create_action',
  AgentSettingsAction: 'glmcode_agent_settings_action',
  AgentEngineMaintenanceAction: 'glmcode_agent_engine_maintenance_action',
  AgentEngineSettingChanged: 'glmcode_agent_engine_setting_changed',
  AboutAction: 'glmcode_about_action',
  AccountMenuAction: 'glmcode_account_menu_action',
  AppStarted: 'glmcode_app_started',
  AppearanceSettingChanged: 'glmcode_appearance_setting_changed',
  ArtifactPreviewAction: 'glmcode_artifact_preview_action',
  AuthLifecycle: 'glmcode_auth_lifecycle',
  BrowserSettingChanged: 'glmcode_browser_setting_changed',
  CustomModelConnectionTested: 'glmcode_custom_model_connection_tested',
  CustomModelSettingsSaved: 'glmcode_custom_model_settings_saved',
  ConversationBlockAction: 'glmcode_conversation_block_action',
  ConversationMessageAction: 'glmcode_conversation_message_action',
  ConversationNavigationAction: 'glmcode_conversation_navigation_action',
  DreamingSettingChanged: 'glmcode_dreaming_setting_changed',
  EmailSkillConnectionTested: 'glmcode_email_skill_connection_tested',
  EmailSkillSettingsSaved: 'glmcode_email_skill_settings_saved',
  ExpertKitAction: 'glmcode_expert_kit_action',
  ExpertKitSelected: 'glmcode_expert_kit_selected',
  GeneralSettingChanged: 'glmcode_general_setting_changed',
  ImConnectionTested: 'glmcode_im_connection_tested',
  ImGatewayToggled: 'glmcode_im_gateway_toggled',
  ImInstanceChanged: 'glmcode_im_instance_changed',
  ImSettingsSaved: 'glmcode_im_settings_saved',
  MemoryEntryChanged: 'glmcode_memory_entry_changed',
  MemorySettingChanged: 'glmcode_memory_setting_changed',
  McpEnabled: 'glmcode_mcp_enabled',
  McpAction: 'glmcode_mcp_action',
  ModelSelected: 'glmcode_model_selected',
  PlanModeEnabled: 'glmcode_plan_mode_enabled',
  PluginAction: 'glmcode_plugin_action',
  PluginSettingsSaved: 'glmcode_plugin_settings_saved',
  PromptControlAction: 'glmcode_prompt_control_action',
  PromptSubmit: 'glmcode_prompt_submit',
  PromptTemplateAction: 'glmcode_prompt_template_action',
  ShortcutSettingChanged: 'glmcode_shortcut_setting_changed',
  SidebarAction: 'glmcode_sidebar_action',
  SkillAction: 'glmcode_skill_action',
  SkillEnabled: 'glmcode_skill_enabled',
  ScheduledTaskAction: 'glmcode_scheduled_task_action',
  TaskSearchAction: 'glmcode_task_search_action',
  UsageAnalyticsEnabled: 'glmcode_usage_analytics_enabled',
} as const;

export const LogReporterEntry = {
  PromptToolsMenu: 'prompt_tools_menu',
} as const;

type LogParamValue = string | number | boolean | null | undefined;

export type LogEventAction = `${typeof LogReporterActionPrefix.GLMCode}${string}`;

export type LogEventParams = Record<string, LogParamValue> & {
  action: LogEventAction;
};

const logCommons = {
  _npid: LogReporterProduct.GLMCode,
  _ncat: LogReporterCategory.Actions,
} as const;

export interface BuildLogUrlOptions {
  appVersion?: string;
  arch?: string;
  firstKeyfrom?: string;
  installationId?: string | null;
  language?: string;
  latestKeyfrom?: string;
  platform?: string;
  userId?: string;
  timestamp?: number;
}

type LogKeyfromAttribution = {
  firstKeyfrom: string;
  latestKeyfrom: string;
};

let cachedAppVersion = '';
let appVersionPromise: Promise<string> | null = null;
let cachedInstallationId: string | null = null;
let installationIdPromise: Promise<string | null> | null = null;
let cachedKeyfromAttribution: LogKeyfromAttribution | null = null;
let keyfromAttributionPromise: Promise<LogKeyfromAttribution | null> | null = null;

const writeReporterLog = (level: 'debug' | 'warn', message: string, error?: unknown): void => {
  if (level === 'warn') {
    if (error === undefined) {
      console.warn(`[LogReporter] ${message}`);
    } else {
      console.warn(`[LogReporter] ${message}:`, error);
    }
  } else {
    console.debug(`[LogReporter] ${message}`);
  }
  window.electron?.log?.fromRenderer?.(level, 'LogReporter', message);
};

const getWindowAppVersion = async (): Promise<string> => {
  if (cachedAppVersion) {
    return cachedAppVersion;
  }
  if (typeof window === 'undefined' || !window.electron?.appInfo?.getVersion) {
    return '';
  }
  if (!appVersionPromise) {
    appVersionPromise = window.electron.appInfo.getVersion()
      .then(version => {
        cachedAppVersion = version || '';
        return cachedAppVersion;
      })
      .catch(error => {
        appVersionPromise = null;
        writeReporterLog('warn', 'failed to load app version for analytics', error);
        return '';
      });
  }
  return appVersionPromise;
};

const getInstallationIdForAnalytics = async (): Promise<string | null> => {
  if (cachedInstallationId) {
    return cachedInstallationId;
  }
  if (!installationIdPromise) {
    installationIdPromise = getInstallationId()
      .then(id => {
        cachedInstallationId = id;
        return cachedInstallationId;
      })
      .catch(error => {
        installationIdPromise = null;
        writeReporterLog('warn', 'failed to load installation uuid for analytics', error);
        return null;
      });
  }
  return installationIdPromise;
};

const getWindowKeyfromAttribution = async (): Promise<LogKeyfromAttribution | null> => {
  if (cachedKeyfromAttribution) {
    return cachedKeyfromAttribution;
  }
  if (typeof window === 'undefined' || !window.electron?.appInfo?.getKeyfromAttribution) {
    return null;
  }
  if (!keyfromAttributionPromise) {
    keyfromAttributionPromise = window.electron.appInfo.getKeyfromAttribution()
      .then(attribution => {
        cachedKeyfromAttribution = {
          firstKeyfrom: attribution.firstKeyfrom || '',
          latestKeyfrom: attribution.latestKeyfrom || '',
        };
        return cachedKeyfromAttribution;
      })
      .catch(error => {
        keyfromAttributionPromise = null;
        writeReporterLog('warn', 'failed to load keyfrom attribution for analytics', error);
        return null;
      });
  }
  return keyfromAttributionPromise;
};

const getWindowPlatform = (): string => {
  if (typeof window === 'undefined') {
    return '';
  }
  return window.electron?.platform || '';
};

const getWindowArch = (): string => {
  if (typeof window === 'undefined') {
    return '';
  }
  return window.electron?.arch || '';
};

export const buildLogUrl = (
  params: LogEventParams,
  options: BuildLogUrlOptions = {},
): string => {
  const url = new URL(LogReporterEndpoint.GLMCodeAnalytics);
  const config = configService.getConfig();
  const userId = options.userId ?? store.getState().auth.user?.yid ?? '';
  const firstKeyfrom = options.firstKeyfrom ?? cachedKeyfromAttribution?.firstKeyfrom;
  const latestKeyfrom = options.latestKeyfrom ?? cachedKeyfromAttribution?.latestKeyfrom;
  const installationId = options.installationId ?? cachedInstallationId;
  const logParams: Record<string, LogParamValue> = {
    ...params,
    ...logCommons,
    app_version: options.appVersion ?? cachedAppVersion,
    os_platform: options.platform ?? getWindowPlatform(),
    os_arch: options.arch ?? getWindowArch(),
    language: options.language ?? config.language,
    uuid: installationId,
    firstKeyfrom,
    latestKeyfrom,
    is_logged_in: userId.trim().length > 0,
    log_Usid: userId,
    uts: options.timestamp ?? Date.now(),
  };

  Object.entries(logParams).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  });

  return url.href;
};

export const reportAnalytics = async (params: LogEventParams): Promise<boolean> => {
  if (configService.getConfig().usageAnalyticsEnabled === false) {
    writeReporterLog('debug', `skipped event ${params.action} because usage analytics is disabled`);
    return false;
  }

  if (!params.action.trim()) {
    writeReporterLog('warn', 'skipped an event without an action');
    return false;
  }

  if (!params.action.startsWith(LogReporterActionPrefix.GLMCode)) {
    writeReporterLog('warn', 'skipped an event without the GLM Code action prefix');
    return false;
  }

  try {
    await Promise.all([
      getWindowAppVersion(),
      getInstallationIdForAnalytics(),
      getWindowKeyfromAttribution(),
    ]);
    writeReporterLog('debug', `sending event ${params.action}`);
    const response = await window.electron.api.fetch({
      url: buildLogUrl(params),
      method: 'GET',
      headers: {},
    });

    if (!response.ok) {
      writeReporterLog('warn', `event ${params.action} failed with status ${response.status}`);
      return false;
    }

    writeReporterLog('debug', `sent event ${params.action} successfully`);
    return true;
  } catch (error) {
    writeReporterLog('warn', `event ${params.action} failed`, error);
    return false;
  }
};
