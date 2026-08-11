export const WebConsoleIpc = {
  GetStatus: 'web-console:getStatus',
  Open: 'web-console:open',
  Stop: 'web-console:stop',
} as const;

export const WebConsoleRpcErrorCode = {
  BadRequest: 'BAD_REQUEST',
  Internal: 'INTERNAL_ERROR',
  MethodNotFound: 'METHOD_NOT_FOUND',
  Unauthorized: 'UNAUTHORIZED',
} as const;

export type WebConsoleRpcErrorCode =
  typeof WebConsoleRpcErrorCode[keyof typeof WebConsoleRpcErrorCode];

export interface WebConsoleCapabilities {
  runtime: 'web';
  localOnly: true;
  authSharedWithDesktop: true;
  agents: true;
  cowork: true;
  workspaceUpload: true;
  desktopSettings: false;
  imManagement: false;
  scheduledTasks: false;
  skillsManagement: false;
  mcpManagement: false;
  appUpdates: false;
}

export interface WebConsoleRpcRequest {
  id: string;
  method: string;
  params: unknown[];
}

export interface WebConsoleRpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: WebConsoleRpcErrorCode;
    message: string;
  };
}

export interface WebConsoleEventEnvelope {
  sequence: number;
  topic: string;
  payload: unknown;
}

export interface WebConsoleStatus {
  running: boolean;
  url?: string;
  clients: number;
}

export const WEB_CONSOLE_CAPABILITIES: WebConsoleCapabilities = {
  runtime: 'web',
  localOnly: true,
  authSharedWithDesktop: true,
  agents: true,
  cowork: true,
  workspaceUpload: true,
  desktopSettings: false,
  imManagement: false,
  scheduledTasks: false,
  skillsManagement: false,
  mcpManagement: false,
  appUpdates: false,
};

