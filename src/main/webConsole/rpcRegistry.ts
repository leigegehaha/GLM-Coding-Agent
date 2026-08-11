import type { IpcMainInvokeEvent } from 'electron';

type IpcInvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

interface WebRpcMethodDefinition {
  channel: string;
  transformArgs?: (args: unknown[]) => unknown[];
  transformResult?: (result: unknown) => unknown;
}

const WEB_RPC_METHODS: Record<string, WebRpcMethodDefinition> = {
  'store.get': { channel: 'store:get' },
  'store.set': { channel: 'store:set' },
  'store.remove': { channel: 'store:remove' },
  'enterprise.getConfig': { channel: 'enterprise:getConfig' },
  'appInfo.getVersion': { channel: 'app:getVersion' },
  'appInfo.getSystemLocale': { channel: 'app:getSystemLocale' },
  'appInfo.getKeyfromAttribution': { channel: 'app:getKeyfromAttribution' },
  'getApiConfig': { channel: 'get-api-config' },
  'checkApiConfig': { channel: 'check-api-config' },
  'generateSessionTitle': { channel: 'generate-session-title' },
  'getRecentCwds': { channel: 'get-recent-cwds' },
  'api.fetch': { channel: 'api:fetch' },
  'auth.login': {
    channel: 'auth:login',
    transformArgs: args => [{ loginUrl: args[0] }],
  },
  'auth.exchange': {
    channel: 'auth:exchange',
    transformArgs: args => [{ code: args[0] }],
  },
  'auth.getUser': { channel: 'auth:getUser' },
  'auth.getQuota': { channel: 'auth:getQuota' },
  'auth.logout': { channel: 'auth:logout' },
  'auth.refreshToken': { channel: 'auth:refreshToken' },
  'auth.getModels': { channel: 'auth:getModels' },
  'auth.getPricingCatalog': { channel: 'auth:getPricingCatalog' },
  'auth.getProfileSummary': { channel: 'auth:getProfileSummary' },
  'auth.getPendingCallback': { channel: 'auth:getPendingCallback' },
  'auth.getActiveClientBanner': { channel: 'auth:getActiveClientBanner' },
  'auth.getActiveClientBanners': { channel: 'auth:getActiveClientBanners' },
  'auth.claimCreditsFinalReward': {
    channel: 'auth:claimCreditsFinalReward',
    transformArgs: args => [{ campaignCode: args[0] }],
  },
  // Web 端不接触 GLM access token，所有鉴权请求继续由主进程代理。
  'auth.getAccessToken': { channel: 'web-console:null' },
  'agents.list': {
    channel: 'agents:list',
    transformResult: result => {
      const value = result as { success?: boolean; agents?: unknown[] } | null;
      return value?.success ? value.agents ?? [] : [];
    },
  },
  'agents.get': {
    channel: 'agents:get',
    transformResult: result => {
      const value = result as { success?: boolean; agent?: unknown } | null;
      return value?.success ? value.agent ?? null : null;
    },
  },
  'agents.create': {
    channel: 'agents:create',
    transformResult: result => {
      const value = result as { success?: boolean; agent?: unknown } | null;
      return value?.success ? value.agent ?? null : null;
    },
  },
  'agents.update': {
    channel: 'agents:update',
    transformResult: result => {
      const value = result as { success?: boolean; agent?: unknown } | null;
      return value?.success ? value.agent ?? null : null;
    },
  },
  'agents.reorder': {
    channel: 'agents:reorder',
    transformResult: result => {
      const value = result as { success?: boolean; agents?: unknown[] } | null;
      return value?.success ? value.agents ?? null : null;
    },
  },
  'agents.delete': {
    channel: 'agents:delete',
    transformResult: result => {
      const value = result as { success?: boolean; deleted?: boolean } | null;
      return value?.success ? value.deleted === true : false;
    },
  },
  'agents.presets': {
    channel: 'agents:presets',
    transformResult: result => {
      const value = result as { success?: boolean; presets?: unknown[] } | null;
      return value?.success ? value.presets ?? [] : [];
    },
  },
  'agents.presetTemplates': {
    channel: 'agents:presetTemplates',
    transformResult: result => {
      const value = result as { success?: boolean; presets?: unknown[] } | null;
      return value?.success ? value.presets ?? [] : [];
    },
  },
  'agents.addPreset': {
    channel: 'agents:addPreset',
    transformResult: result => {
      const value = result as { success?: boolean; agent?: unknown } | null;
      return value?.success ? value.agent ?? null : null;
    },
  },
  'agents.cleanupLegacyIdentityBlock': {
    channel: 'agents:cleanupLegacyIdentityBlock',
    transformResult: result => {
      const value = result as { result?: unknown } | null;
      return value?.result ?? null;
    },
  },
  'skills.list': { channel: 'skills:list' },
  'skills.autoRoutingPrompt': { channel: 'skills:autoRoutingPrompt' },
  'kits.listInstalled': { channel: 'kits:listInstalled' },
  'cowork.startSession': { channel: 'cowork:session:start' },
  'cowork.continueSession': { channel: 'cowork:session:continue' },
  'cowork.submitBtw': { channel: 'cowork:session:submitBtw' },
  'cowork.abortBtw': { channel: 'cowork:session:abortBtw' },
  'cowork.submitSteer': { channel: 'cowork:session:submitSteer' },
  'cowork.runGoalCommand': { channel: 'cowork:session:goalCommand' },
  'cowork.stopSession': { channel: 'cowork:session:stop' },
  'cowork.deleteSession': { channel: 'cowork:session:delete' },
  'cowork.deleteSessions': { channel: 'cowork:session:deleteBatch' },
  'cowork.setSessionPinned': { channel: 'cowork:session:pin' },
  'cowork.renameSession': { channel: 'cowork:session:rename' },
  'cowork.forkSession': { channel: 'cowork:session:fork' },
  'cowork.getSession': { channel: 'cowork:session:get' },
  'cowork.markSessionViewed': { channel: 'cowork:session:markViewed' },
  'cowork.setActiveSession': { channel: 'cowork:session:setActive' },
  'cowork.remoteManaged': { channel: 'cowork:session:remoteManaged' },
  'cowork.listSessions': { channel: 'cowork:session:list' },
  'cowork.getSessionMessages': { channel: 'cowork:session:getMessages' },
  'cowork.getSessionMessageRailIndex': { channel: 'cowork:session:getMessageRailIndex' },
  'cowork.getContextUsage': { channel: 'cowork:session:contextUsage' },
  'cowork.compactContext': { channel: 'cowork:session:compactContext' },
  'cowork.respondToPermission': { channel: 'cowork:permission:respond' },
  'cowork.getConfig': { channel: 'cowork:config:get' },
  'cowork.setConfig': { channel: 'cowork:config:set' },
  'cowork.listSubagentSessions': {
    channel: 'cowork:subagent:list',
    transformArgs: args => [{ parentSessionId: args[0] }],
  },
  'cowork.listSubagentSessionsByAgent': { channel: 'cowork:subagent:listByAgent' },
  'cowork.getSubTaskHistory': { channel: 'cowork:subTask:history' },
  'cowork.deleteSubagentSession': { channel: 'cowork:subagent:delete' },
  'openclaw.engine.getStatus': { channel: 'openclaw:engine:getStatus' },
  'openclaw.engine.install': { channel: 'openclaw:engine:install' },
  'openclaw.engine.retryInstall': { channel: 'openclaw:engine:retryInstall' },
  'openclaw.engine.restartGateway': { channel: 'openclaw:engine:restartGateway' },
  'openclaw.engine.repairGatewayState': { channel: 'openclaw:engine:repairGatewayState' },
  'openclaw.sessionPolicy.get': { channel: 'openclaw:sessionPolicy:get' },
  'openclaw.sessionPolicy.set': { channel: 'openclaw:sessionPolicy:set' },
  'openclaw.session.patch': { channel: 'openclaw:session:patch' },
  'dialog.readFileAsDataUrl': { channel: 'dialog:readFileAsDataUrl' },
  'dialog.statFile': { channel: 'dialog:statFile' },
  'dialog.readTextFile': { channel: 'dialog:readTextFile' },
  'dialog.saveInlineFile': { channel: 'dialog:saveInlineFile' },
  'artifact.createPreviewSession': { channel: 'artifact:createPreviewSession' },
  'artifact.createOfficePreviewSession': { channel: 'artifact:createOfficePreviewSession' },
  'artifact.destroyPreviewSession': { channel: 'artifact:destroyPreviewSession' },
  'artifact.listLocalWebServices': { channel: 'localWebServices:list' },
  'shell.openPath': { channel: 'shell:openPath' },
  'shell.showItemInFolder': { channel: 'shell:showItemInFolder' },
};

export class WebConsoleRpcRegistry {
  private readonly handlers = new Map<string, IpcInvokeHandler>();

  /** 记录 Electron handler，Web 侧仍会经过独立的方法白名单。 */
  capture(channel: string, handler: IpcInvokeHandler): void {
    this.handlers.set(channel, handler);
  }

  /** 调用与桌面端相同的 IPC handler，防止业务逻辑出现双实现。 */
  async invoke(
    method: string,
    args: unknown[],
    event: IpcMainInvokeEvent,
  ): Promise<unknown> {
    const definition = WEB_RPC_METHODS[method];
    if (!definition) {
      throw new Error(`WEB_RPC_METHOD_NOT_FOUND:${method}`);
    }
    if (definition.channel === 'web-console:null') {
      return null;
    }
    const handler = this.handlers.get(definition.channel);
    if (!handler) {
      throw new Error(`WEB_RPC_HANDLER_NOT_READY:${definition.channel}`);
    }
    const invokeArgs = definition.transformArgs?.(args) ?? args;
    const result = await handler(event, ...invokeArgs);
    return definition.transformResult?.(result) ?? result;
  }
}

export const isKnownWebRpcMethod = (method: string): boolean => method in WEB_RPC_METHODS;
