import JSZip from 'jszip';

import type {
  WebConsoleCapabilities,
  WebConsoleEventEnvelope,
  WebConsoleRpcRequest,
  WebConsoleRpcResponse,
} from '../../shared/webConsole/constants';

type EventCallback = (payload: any) => void;

interface WebWorkspaceUploadResult {
  success: boolean;
  workspacePath: string;
  filePath?: string;
}

interface BrowserFilePickerOptions {
  accept?: string;
  directory?: boolean;
  multiple?: boolean;
}

const MAX_BROWSER_UPLOAD_BYTES = 200 * 1024 * 1024;

/** 使用浏览器原生文件选择器选择文件或目录内容。 */
const pickBrowserFiles = (options: BrowserFilePickerOptions): Promise<File[]> => new Promise((resolve) => {
  const input = document.createElement('input');
  input.type = 'file';
  input.hidden = true;
  input.multiple = options.multiple === true || options.directory === true;
  if (options.accept) input.accept = options.accept;
  if (options.directory) input.setAttribute('webkitdirectory', '');
  const finish = (files: File[]): void => {
    input.remove();
    resolve(files);
  };
  input.addEventListener('change', () => finish(Array.from(input.files ?? [])), { once: true });
  input.addEventListener('cancel', () => finish([]), { once: true });
  document.body.appendChild(input);
  input.click();
});

/** 上传浏览器文件并返回桌面主进程中的受控本地路径。 */
const uploadWorkspaceBlob = async (blob: Blob, fileName: string): Promise<WebWorkspaceUploadResult> => {
  if (blob.size > MAX_BROWSER_UPLOAD_BYTES) {
    throw new Error('上传内容超过 200 MB');
  }
  const form = new FormData();
  form.append('file', blob, fileName);
  const response = await fetch('/api/workspaces/upload', {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  const result = await response.json() as WebWorkspaceUploadResult & { error?: string };
  if (!response.ok || !result.success) {
    throw new Error(result.error || '工作区上传失败');
  }
  return result;
};

/** 将浏览器目录打包为 ZIP，再由桌面端安全解压到 Web 工作区。 */
const uploadBrowserDirectory = async (): Promise<{ success: boolean; path: string | null }> => {
  const files = await pickBrowserFiles({ directory: true });
  if (files.length === 0) return { success: true, path: null };
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_BROWSER_UPLOAD_BYTES) {
    throw new Error('所选目录超过 200 MB');
  }
  const zip = new JSZip();
  for (const file of files) {
    const relativeParts = (file.webkitRelativePath || file.name).split('/').filter(Boolean);
    const relativePath = relativeParts.length > 1 ? relativeParts.slice(1).join('/') : file.name;
    zip.file(relativePath, file);
  }
  const archive = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  const result = await uploadWorkspaceBlob(archive, 'workspace.zip');
  return { success: true, path: result.workspacePath };
};

const filtersToAccept = (options: unknown): string | undefined => {
  const filters = (options as { filters?: Array<{ extensions?: string[] }> } | undefined)?.filters;
  const extensions = filters?.flatMap(filter => filter.extensions ?? [])
    .map(extension => extension.trim().replace(/^\./, ''))
    .filter(Boolean);
  return extensions?.length ? extensions.map(extension => `.${extension}`).join(',') : undefined;
};

/** 选择并上传单个或多个文件，返回受控工作区中的绝对路径。 */
const uploadBrowserFiles = async (
  options: unknown,
  multiple: boolean,
): Promise<{ success: boolean; path?: string | null; paths?: string[] }> => {
  const files = await pickBrowserFiles({ accept: filtersToAccept(options), multiple });
  if (files.length === 0) {
    return multiple ? { success: true, paths: [] } : { success: true, path: null };
  }
  const paths: string[] = [];
  for (const file of files) {
    const result = await uploadWorkspaceBlob(file, file.name);
    if (result.filePath) paths.push(result.filePath);
  }
  return multiple
    ? { success: true, paths }
    : { success: true, path: paths[0] ?? null };
};

const EVENT_METHOD_TOPICS: Record<string, string> = {
  'auth.onCallback': 'auth:callback',
  'auth.onLifecycleEvent': 'auth:lifecycleEvent',
  'auth.onQuotaChanged': 'auth:quotaChanged',
  'auth.onSessionChanged': 'auth:sessionChanged',
  'cowork.onMediaStatusPollUpdate': 'cowork:media:statusPollUpdate',
  'cowork.onOpenSessionFromNotification': 'cowork:session:openFromNotification',
  'cowork.onSessionModelOverrideChanged': 'cowork:session:modelOverrideChanged',
  'cowork.onSessionsChanged': 'cowork:sessions:changed',
  'cowork.onStreamBtwResult': 'cowork:stream:btwResult',
  'cowork.onStreamComplete': 'cowork:stream:complete',
  'cowork.onStreamContextMaintenance': 'cowork:stream:contextMaintenance',
  'cowork.onStreamContextUsage': 'cowork:stream:contextUsage',
  'cowork.onStreamError': 'cowork:stream:error',
  'cowork.onStreamGoal': 'cowork:stream:goal',
  'cowork.onStreamMessage': 'cowork:stream:message',
  'cowork.onStreamMessageUpdate': 'cowork:stream:messageUpdate',
  'cowork.onStreamPermission': 'cowork:stream:permission',
  'cowork.onStreamPermissionDismiss': 'cowork:stream:permissionDismiss',
  'cowork.onStreamSessionStatus': 'cowork:stream:sessionStatus',
  'openclaw.engine.onProgress': 'openclaw:engine:onProgress',
};

const LOCAL_EVENT_METHODS = new Set([
  'appUpdate.onStateChanged',
  'githubCopilot.onTokenUpdated',
  'ipcRenderer.on',
  'skin.onChanged',
  'skills.onChanged',
  'window.onStateChanged',
]);

class WebConsoleTransport {
  private readonly listeners = new Map<string, Set<EventCallback>>();
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private stopped = false;

  /** 完成一次性配对并确认当前浏览器拥有本地访问会话。 */
  async initialize(): Promise<WebConsoleCapabilities> {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const pairingToken = params.get('pair');
    if (pairingToken) {
      const response = await fetch('/api/pair', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: pairingToken }),
      });
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
      if (!response.ok) {
        throw new Error('Web 控制台配对链接已失效，请从桌面端重新打开。');
      }
    }

    const capabilitiesResponse = await fetch('/api/capabilities', { credentials: 'include' });
    if (!capabilitiesResponse.ok) {
      throw new Error('Web 控制台尚未配对，请从桌面端点击“打开 Web 控制台”。');
    }
    const capabilities = await capabilitiesResponse.json() as WebConsoleCapabilities;
    this.connectEvents();
    return capabilities;
  }

  /** 调用本地服务的显式 RPC 白名单。 */
  async invoke(method: string, params: unknown[]): Promise<unknown> {
    const request: WebConsoleRpcRequest = {
      id: crypto.randomUUID(),
      method,
      params,
    };
    const response = await fetch('/api/rpc', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    const body = await response.json() as WebConsoleRpcResponse;
    if (!response.ok || !body.ok) {
      throw new Error(body.error?.message || `Web RPC ${method} 执行失败`);
    }
    return body.result;
  }

  subscribe(topic: string, callback: EventCallback): () => void {
    const callbacks = this.listeners.get(topic) ?? new Set<EventCallback>();
    callbacks.add(callback);
    this.listeners.set(topic, callbacks);
    return () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) this.listeners.delete(topic);
    };
  }

  private connectEvents(): void {
    if (this.stopped || this.socket?.readyState === WebSocket.OPEN) return;
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${scheme}//${window.location.host}/api/events`);
    this.socket = socket;
    socket.addEventListener('message', event => {
      try {
        const envelope = JSON.parse(String(event.data)) as WebConsoleEventEnvelope;
        this.listeners.get(envelope.topic)?.forEach(callback => callback(envelope.payload));
      } catch (error) {
        console.warn('[WebConsole] 忽略无效事件：', error);
      }
    });
    socket.addEventListener('close', () => {
      if (this.stopped) return;
      if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = window.setTimeout(() => this.connectEvents(), 1_500);
    });
  }
}

/** 执行 Proxy 模拟出的 preload 方法，并处理 Web 专属实现。 */
const invokeBridgeMethod = (
  transport: WebConsoleTransport,
  pathParts: string[],
  args: unknown[],
): unknown => {
  const method = pathParts.join('.');
    const eventTopic = EVENT_METHOD_TOPICS[method];
    if (eventTopic) {
      const callback = args[0];
      return typeof callback === 'function'
        ? transport.subscribe(eventTopic, callback as EventCallback)
        : () => undefined;
    }
    if (method === 'ipcRenderer.on') {
      const topic = typeof args[0] === 'string' ? args[0] : '';
      const callback = args[1];
      return topic && typeof callback === 'function'
        ? transport.subscribe(topic, callback as EventCallback)
        : () => undefined;
    }
    if (LOCAL_EVENT_METHODS.has(method)) return () => undefined;
    if (method === 'log.fromRenderer') {
      const [level, tag, message] = args;
      console.debug(`[${String(tag)}][${String(level)}] ${String(message)}`);
      return undefined;
    }
    if (method === 'networkStatus.send') return undefined;
    if (method === 'cowork.notifyOpenSessionFromNotificationReady') return Promise.resolve(undefined);
    if (method === 'appUpdate.checkNow') {
      return Promise.resolve({ success: true, state: { status: 'idle' } });
    }
    if (method === 'skin.getActive') return Promise.resolve({ success: true, activeSkin: null });
    if (method === 'skin.list') return Promise.resolve({ success: true, skins: [] });
    if (method === 'theme.updateTitleBar') return undefined;
    if (method === 'window.isMaximized') return Promise.resolve(false);
    if (method.startsWith('window.')) return undefined;
    if (method === 'shell.openExternal') {
      const url = typeof args[0] === 'string' ? args[0] : '';
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      return Promise.resolve({ success: Boolean(url) });
    }
    if (method === 'clipboard.writeText') {
      return navigator.clipboard.writeText(String(args[0] ?? ''));
    }
    if (method === 'dialog.selectDirectory') return uploadBrowserDirectory();
    if (method === 'dialog.selectFile') return uploadBrowserFiles(args[0], false);
    if (method === 'dialog.selectFiles') return uploadBrowserFiles(args[0], true);
    return transport.invoke(method, args);
};

const createBridgeNamespace = (
  transport: WebConsoleTransport,
  pathParts: string[] = [],
): unknown => new Proxy(() => undefined, {
  get: (_target, property) => {
    if (typeof property === 'symbol' || property === 'then' || property === 'toJSON') return undefined;
    if (property === 'call') {
      return (_thisArg: unknown, ...args: unknown[]) => invokeBridgeMethod(transport, pathParts, args);
    }
    if (property === 'apply') {
      return (_thisArg: unknown, args: unknown[]) => invokeBridgeMethod(
        transport,
        pathParts,
        Array.isArray(args) ? args : [],
      );
    }
    const key = String(property);
    const nextParts = [...pathParts, key];
    const method = nextParts.join('.');

    if (method === 'platform') return 'web';
    if (method === 'arch') return 'browser';
    if (method === 'capabilities') return (window as any).__GLM_CODE_WEB_CAPABILITIES__;
    if (method === 'dialog.getPathForFile') return undefined;

    return createBridgeNamespace(transport, nextParts);
  },
  apply: (_target, _thisArg, args: unknown[]) => {
    return invokeBridgeMethod(transport, pathParts, args);
  },
});

/** 普通浏览器启动前安装与 Electron preload 同形状的 Web Bridge。 */
export async function ensureWebConsoleBridge(): Promise<void> {
  if (window.electron) return;
  const transport = new WebConsoleTransport();
  const capabilities = await transport.initialize();
  (window as any).__GLM_CODE_WEB__ = true;
  (window as any).__GLM_CODE_WEB_CAPABILITIES__ = capabilities;
  (window as any).electron = createBridgeNamespace(transport);
}

export const isWebConsoleRuntime = (): boolean => (window as any).__GLM_CODE_WEB__ === true;
