/**
 * Sentinel sessionId for permission requests that arrive without a resolvable
 * OpenClaw session key (e.g. AskUserQuestion callbacks missing sessionKey).
 * The renderer must surface these in whichever session is currently open —
 * they can never match a real session id.
 */
export const SESSION_AGNOSTIC_PERMISSION_SESSION_ID = '__askuser__';

/**
 * Tool name carried by AskUserQuestion requests when they are surfaced through
 * the permission-request channel. Used to classify "waiting for input"
 * requests apart from regular approval requests.
 */
export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';

/** Default page size for session list pagination. */
export const COWORK_SESSION_PAGE_SIZE = 50;

/** Default page size for message history pagination. */
export const COWORK_MESSAGE_PAGE_SIZE = 30;

/**
 * Per-working-directory scratch directory for intermediate files (model
 * helper scripts, pasted attachments, drafts). Swept by the cowork temp
 * janitor; user-facing deliverables must not live here.
 */
export const COWORK_TEMP_DIR_NAME = '.cowork-temp';

/**
 * Subdirectory of the cowork temp dir holding pasted/manual attachments.
 * Attachment originals are referenced by message metadata (re-edit restores
 * them), so the janitor never deletes this subtree.
 */
export const COWORK_TEMP_ATTACHMENTS_DIR_NAME = 'attachments';

export const CoworkIpcChannel = {
  MediaStatusPollUpdate: 'cowork:media:statusPollUpdate',
  ForkSession: 'cowork:session:fork',
  StopSession: 'cowork:session:stop',
  SubTaskHistory: 'cowork:subTask:history',
  SubagentList: 'cowork:subagent:list',
  SubagentListByAgent: 'cowork:subagent:listByAgent',
  SubagentDelete: 'cowork:subagent:delete',
  MarkSessionViewed: 'cowork:session:markViewed',
  SetActiveSession: 'cowork:session:setActive',
  SetCodingOptimization: 'cowork:session:setCodingOptimization',
  ExportSessionDiagnostics: 'cowork:session:exportDiagnostics',
  GetSessionMessageRailIndex: 'cowork:session:getMessageRailIndex',
  OpenSessionFromNotification: 'cowork:session:openFromNotification',
  OpenSessionFromNotificationReady: 'cowork:session:openFromNotificationReady',
  GoalCommand: 'cowork:session:goalCommand',
  SubmitBtw: 'cowork:session:submitBtw',
  AbortBtw: 'cowork:session:abortBtw',
  SubmitSteer: 'cowork:session:submitSteer',
  SessionModelOverrideChanged: 'cowork:session:modelOverrideChanged',
  SessionsChanged: 'cowork:sessions:changed',
  StreamBtwResult: 'cowork:stream:btwResult',
  StreamGoal: 'cowork:stream:goal',
  MemoryReadRaw: 'cowork:memory:readRaw',
  MemoryWriteRaw: 'cowork:memory:writeRaw',
  BootstrapRead: 'cowork:bootstrap:read',
  BootstrapWrite: 'cowork:bootstrap:write',
  TempStorageUsage: 'cowork:tempStorage:usage',
  TempStorageClean: 'cowork:tempStorage:clean',
} as const;
export type CoworkIpcChannel = typeof CoworkIpcChannel[keyof typeof CoworkIpcChannel];

export interface CoworkSessionsChangedPayload {
  sessionIds: string[];
}

export const CoworkForkMode = {
  None: 'none',
  Conversation: 'conversation',
  Worktree: 'worktree',
} as const;
export type CoworkForkMode = typeof CoworkForkMode[keyof typeof CoworkForkMode];

export const CoworkContextUsageSource = {
  Live: 'live',
  Cache: 'cache',
  Unavailable: 'unavailable',
} as const;
export type CoworkContextUsageSource =
  typeof CoworkContextUsageSource[keyof typeof CoworkContextUsageSource];

export const CoworkContextUsageFailureReason = {
  Timeout: 'timeout',
  GatewayError: 'gateway_error',
} as const;
export type CoworkContextUsageFailureReason =
  typeof CoworkContextUsageFailureReason[keyof typeof CoworkContextUsageFailureReason];

export const CoworkContextUsageRefreshMode = {
  Auto: 'auto',
  Manual: 'manual',
  PostRun: 'postRun',
} as const;
export type CoworkContextUsageRefreshMode =
  typeof CoworkContextUsageRefreshMode[keyof typeof CoworkContextUsageRefreshMode];
