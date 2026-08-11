import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import crypto from 'crypto';
import extractZip from 'extract-zip';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

import {
  WEB_CONSOLE_CAPABILITIES,
  type WebConsoleEventEnvelope,
  WebConsoleRpcErrorCode,
  type WebConsoleRpcRequest,
  type WebConsoleRpcResponse,
  type WebConsoleStatus,
} from '../../shared/webConsole/constants';

const LOOPBACK_HOST = '127.0.0.1';
const PAIRING_TOKEN_TTL_MS = 60_000;
const SESSION_COOKIE = 'glmcode_web_session';
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 500 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5_000;
const ZIP_ENTRY_TYPE_MASK = 0o170000;
const ZIP_SYMBOLIC_LINK_TYPE = 0o120000;

interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface WebConsoleServerOptions {
  staticRoot: string;
  uploadsRoot: string;
  invokeRpc: (method: string, params: unknown[]) => Promise<unknown>;
  getWorkspaceRoots: () => string[];
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
  pairingTokenTtlMs?: number;
  maxUploadBytes?: number;
}

interface PairingTokenRecord {
  expiresAt: number;
  used: boolean;
}

const parseCookies = (header: string | undefined): Record<string, string> => {
  if (!header) return {};
  return Object.fromEntries(header.split(';').flatMap((part) => {
    const separator = part.indexOf('=');
    if (separator < 1) return [];
    return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]];
  }));
};

const isRpcRequest = (value: unknown): value is WebConsoleRpcRequest => {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<WebConsoleRpcRequest>;
  return typeof request.id === 'string'
    && request.id.length > 0
    && request.id.length <= 128
    && typeof request.method === 'string'
    && request.method.length > 0
    && request.method.length <= 128
    && Array.isArray(request.params);
};

const safeUploadName = (value: string): string => {
  const name = path.basename(value).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
  return name && name !== '.' && name !== '..' ? name : 'upload.bin';
};

/** 校验 ZIP 条目，限制路径穿越、符号链接、文件数量和解压后总体积。 */
export const createZipEntryValidator = (
  limits: { maxEntries: number; maxExtractedBytes: number } = {
    maxEntries: MAX_ARCHIVE_ENTRIES,
    maxExtractedBytes: MAX_EXTRACTED_BYTES,
  },
): ((entry: {
  fileName: string;
  externalFileAttributes: number;
  uncompressedSize: number;
}) => void) => {
  let entryCount = 0;
  let extractedBytes = 0;
  return entry => {
    const normalizedName = entry.fileName.replace(/\\/g, '/');
    const parts = normalizedName.split('/').filter(Boolean);
    if (
      !normalizedName
      || normalizedName.includes('\0')
      || normalizedName.startsWith('/')
      || /^[a-zA-Z]:/.test(normalizedName)
      || parts.includes('..')
    ) {
      throw new Error('ZIP 包含越界路径');
    }
    const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
    if ((unixMode & ZIP_ENTRY_TYPE_MASK) === ZIP_SYMBOLIC_LINK_TYPE) {
      throw new Error('ZIP 不允许包含符号链接');
    }
    entryCount += 1;
    extractedBytes += Math.max(0, entry.uncompressedSize || 0);
    if (entryCount > limits.maxEntries) {
      throw new Error(`ZIP 文件数量超过 ${limits.maxEntries} 个`);
    }
    if (extractedBytes > limits.maxExtractedBytes) {
      throw new Error('ZIP 解压后总体积过大');
    }
  };
};

export class WebConsoleServer {
  private app: FastifyInstance | null = null;
  private origin = '';
  private sequence = 0;
  private readonly pairingTokens = new Map<string, PairingTokenRecord>();
  private readonly sessions = new Set<string>();
  private readonly sockets = new Set<WebSocketLike>();
  private readonly log: Pick<Console, 'info' | 'warn' | 'error'>;

  constructor(private readonly options: WebConsoleServerOptions) {
    this.log = options.log ?? console;
  }

  getStatus(): WebConsoleStatus {
    return {
      running: this.app !== null,
      ...(this.origin ? { url: this.origin } : {}),
      clients: this.sockets.size,
    };
  }

  /** 启动仅监听回环地址的同源 Web 服务。 */
  async start(): Promise<WebConsoleStatus> {
    if (this.app) return this.getStatus();

    fs.mkdirSync(this.options.uploadsRoot, { recursive: true });
    const app = Fastify({
      logger: false,
      bodyLimit: 2 * 1024 * 1024,
      trustProxy: false,
    });
    await app.register(websocket);
    await app.register(multipart, {
      limits: {
        files: 1,
        fileSize: this.options.maxUploadBytes ?? MAX_UPLOAD_BYTES,
        fields: 4,
      },
    });

    app.addHook('onSend', async (_request, reply, payload) => {
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
          + "script-src 'self' 'sha256-+OJAncjJDps8Tl3mFeIIZ6z7juRflMMLQEIYFGhIuzc=' "
          + "'sha256-4PbjWxcwhlrpZIbQk1zhzNgPo5KFCQXsrLE76+5Qm+I='; "
          + "font-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; "
          + "frame-src 'self' blob: data: http://127.0.0.1:*; media-src 'self' blob: data: http://127.0.0.1:*; "
          + "frame-ancestors 'none'; base-uri 'self'",
      );
      return payload;
    });

    app.post('/api/pair', async (request, reply) => this.handlePair(request, reply));
    app.get('/api/capabilities', async (request, reply) => {
      if (!this.authorize(request, reply)) return undefined;
      return WEB_CONSOLE_CAPABILITIES;
    });
    app.post('/api/rpc', async (request, reply) => this.handleRpc(request, reply));
    app.get('/api/workspaces', async (request, reply) => {
      if (!this.authorize(request, reply)) return undefined;
      return { roots: this.options.getWorkspaceRoots() };
    });
    app.post('/api/workspaces/upload', async (request, reply) => this.handleUpload(request, reply));
    app.get('/api/events', { websocket: true }, (socket, request) => {
      const ws = socket as unknown as WebSocketLike;
      if (!this.isAuthorizedRequest(request) || !this.hasValidOrigin(request)) {
        ws.close(1008, 'unauthorized');
        return;
      }
      this.sockets.add(ws);
      ws.send(JSON.stringify({
        sequence: ++this.sequence,
        topic: 'web.ready',
        payload: WEB_CONSOLE_CAPABILITIES,
      } satisfies WebConsoleEventEnvelope));
      socket.on('close', () => this.sockets.delete(ws));
      socket.on('error', () => this.sockets.delete(ws));
    });

    await app.register(fastifyStatic, {
      root: this.options.staticRoot,
      prefix: '/',
      cacheControl: true,
      maxAge: '1h',
      // 入口页每次重新校验，避免发布后仍引用旧版本的哈希资源。
      setHeaders: (reply, filePath) => {
        if (path.basename(filePath) === 'index.html') {
          reply.header('Cache-Control', 'no-store');
        }
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.header('Cache-Control', 'no-store').sendFile('index.html');
    });

    await app.listen({ host: LOOPBACK_HOST, port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') {
      await app.close();
      throw new Error('本地 Web 服务未获得有效端口');
    }
    this.app = app;
    this.origin = `http://${LOOPBACK_HOST}:${address.port}`;
    this.log.info(`[WebConsole] 本地服务已启动：${this.origin}`);
    return this.getStatus();
  }

  /** 生成只使用一次的配对链接，令牌放在 fragment 中避免进入服务端访问日志。 */
  createPairingUrl(): string {
    if (!this.app || !this.origin) {
      throw new Error('本地 Web 服务尚未启动');
    }
    const token = crypto.randomBytes(32).toString('base64url');
    this.pairingTokens.set(token, {
      expiresAt: Date.now() + (this.options.pairingTokenTtlMs ?? PAIRING_TOKEN_TTL_MS),
      used: false,
    });
    this.pruneExpiredCredentials();
    return `${this.origin}/#pair=${encodeURIComponent(token)}`;
  }

  /** 将运行时事件同时广播给所有已配对浏览器。 */
  publish(topic: string, payload: unknown): void {
    if (this.sockets.size === 0) return;
    const message = JSON.stringify({
      sequence: ++this.sequence,
      topic,
      payload,
    } satisfies WebConsoleEventEnvelope);
    for (const socket of this.sockets) {
      if (socket.readyState === 1) {
        socket.send(message);
      }
    }
  }

  /** 停止服务并使全部配对状态失效。 */
  async stop(): Promise<void> {
    const app = this.app;
    this.app = null;
    this.origin = '';
    this.pairingTokens.clear();
    this.sessions.clear();
    for (const socket of this.sockets) {
      socket.close(1001, 'server stopping');
    }
    this.sockets.clear();
    if (app) {
      await app.close();
      this.log.info('[WebConsole] 本地服务已停止');
    }
  }

  private async handlePair(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    if (!this.hasValidOrigin(request)) {
      return reply.code(403).send({ error: 'Origin rejected' });
    }
    const token = (request.body as { token?: unknown } | null)?.token;
    if (typeof token !== 'string') {
      return reply.code(400).send({ error: 'Missing pairing token' });
    }
    const record = this.pairingTokens.get(token);
    if (!record || record.used || record.expiresAt < Date.now()) {
      return reply.code(401).send({ error: 'Pairing token is invalid or expired' });
    }
    record.used = true;
    const sessionId = crypto.randomBytes(32).toString('base64url');
    this.sessions.add(sessionId);
    reply.header(
      'Set-Cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Strict; Path=/`,
    );
    return { success: true };
  }

  private async handleRpc(request: FastifyRequest, reply: FastifyReply): Promise<WebConsoleRpcResponse | undefined> {
    if (!this.authorize(request, reply)) return undefined;
    const body = request.body;
    if (!isRpcRequest(body)) {
      return reply.code(400).send({
        id: '',
        ok: false,
        error: { code: WebConsoleRpcErrorCode.BadRequest, message: 'RPC 请求格式错误' },
      });
    }
    try {
      const result = await this.options.invokeRpc(body.method, body.params);
      return { id: body.id, ok: true, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const methodMissing = message.startsWith('WEB_RPC_METHOD_NOT_FOUND:');
      if (!methodMissing) {
        this.log.error(`[WebConsole] RPC ${body.method} 执行失败：${message}`);
      }
      return reply.code(methodMissing ? 404 : 500).send({
        id: body.id,
        ok: false,
        error: {
          code: methodMissing
            ? WebConsoleRpcErrorCode.MethodNotFound
            : WebConsoleRpcErrorCode.Internal,
          message: methodMissing ? '该功能尚未开放到 Web 端' : message,
        },
      });
    }
  }

  private async handleUpload(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    if (!this.authorize(request, reply)) return undefined;
    const part = await request.file();
    if (!part) {
      return reply.code(400).send({ error: 'Missing upload file' });
    }
    const workspaceId = crypto.randomUUID();
    const workspaceDir = path.join(this.options.uploadsRoot, workspaceId);
    fs.mkdirSync(workspaceDir, { recursive: true });
    const fileName = safeUploadName(part.filename);
    const filePath = path.join(workspaceDir, fileName);
    try {
      await pipeline(part.file, fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 }));
      if (part.file.truncated) {
        throw new Error('上传文件超过体积限制');
      }
      const isZip = path.extname(fileName).toLowerCase() === '.zip'
        || part.mimetype === 'application/zip'
        || part.mimetype === 'application/x-zip-compressed';
      if (isZip) {
        const extractedRoot = path.join(workspaceDir, 'workspace');
        await extractZip(filePath, {
          dir: extractedRoot,
          onEntry: createZipEntryValidator(),
        });
        fs.rmSync(filePath, { force: true });
        return {
          success: true,
          workspaceId,
          workspacePath: extractedRoot,
          fileName,
          extracted: true,
        };
      }
      return {
        success: true,
        workspaceId,
        workspacePath: workspaceDir,
        filePath,
        fileName,
        sizeBytes: fs.statSync(filePath).size,
      };
    } catch (error) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`[WebConsole] 工作区上传失败：${message}`);
      return reply.code(message.includes('体积限制') ? 413 : 400).send({ error: message });
    }
  }

  private authorize(request: FastifyRequest, reply: FastifyReply): boolean {
    if (!this.hasValidOrigin(request)) {
      void reply.code(403).send({ error: 'Origin rejected' });
      return false;
    }
    if (!this.isAuthorizedRequest(request)) {
      void reply.code(401).send({ error: 'Pairing required' });
      return false;
    }
    return true;
  }

  private hasValidOrigin(request: FastifyRequest): boolean {
    const origin = request.headers.origin;
    return !origin || origin === this.origin;
  }

  private isAuthorizedRequest(request: FastifyRequest): boolean {
    const sessionId = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    return Boolean(sessionId && this.sessions.has(sessionId));
  }

  private pruneExpiredCredentials(): void {
    const now = Date.now();
    for (const [token, record] of this.pairingTokens) {
      if (record.used || record.expiresAt < now) {
        this.pairingTokens.delete(token);
      }
    }
  }
}
