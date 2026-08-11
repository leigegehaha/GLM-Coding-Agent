import fs from 'fs';
import JSZip from 'jszip';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { createZipEntryValidator, WebConsoleServer } from './webConsoleServer';

interface TestServerContext {
  root: string;
  server: WebConsoleServer;
  origin: string;
}

const activeContexts: TestServerContext[] = [];

/** 创建使用临时静态目录和上传目录的 Web 控制台测试服务。 */
const createTestServer = async (
  options: { pairingTokenTtlMs?: number; maxUploadBytes?: number } = {},
): Promise<TestServerContext> => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-web-console-'));
  const staticRoot = path.join(root, 'static');
  fs.mkdirSync(staticRoot, { recursive: true });
  fs.writeFileSync(path.join(staticRoot, 'index.html'), '<main>test</main>');
  fs.writeFileSync(path.join(staticRoot, 'app-hash.js'), 'console.log("test");');
  const server = new WebConsoleServer({
    staticRoot,
    uploadsRoot: path.join(root, 'uploads'),
    invokeRpc: async (method, params) => {
      if (method !== 'store.get') throw new Error(`WEB_RPC_METHOD_NOT_FOUND:${method}`);
      return params[0] ?? null;
    },
    getWorkspaceRoots: () => [path.join(root, 'uploads')],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    ...options,
  });
  const status = await server.start();
  const context = { root, server, origin: status.url! };
  activeContexts.push(context);
  return context;
};

/** 使用一次性令牌完成配对，并返回会话 Cookie。 */
const pairWithServer = async (context: TestServerContext): Promise<{
  cookie: string;
  token: string;
  response: Response;
}> => {
  const pairingUrl = new URL(context.server.createPairingUrl());
  const token = new URLSearchParams(pairingUrl.hash.slice(1)).get('pair')!;
  const response = await fetch(`${context.origin}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: context.origin },
    body: JSON.stringify({ token }),
  });
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
  return { cookie, token, response };
};

afterEach(async () => {
  await Promise.all(activeContexts.splice(0).map(async context => {
    await context.server.stop();
    fs.rmSync(context.root, { recursive: true, force: true });
  }));
});

describe('WebConsoleServer', () => {
  test('入口页不缓存，哈希静态资源继续缓存', async () => {
    const context = await createTestServer();
    const indexResponse = await fetch(`${context.origin}/`);
    const assetResponse = await fetch(`${context.origin}/app-hash.js`);

    expect(indexResponse.status).toBe(200);
    expect(indexResponse.headers.get('cache-control')).toBe('no-store');
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get('cache-control')).toContain('max-age=3600');
  });

  test('一次性令牌可配对，但不可重放', async () => {
    const context = await createTestServer();
    const paired = await pairWithServer(context);
    expect(paired.response.status).toBe(200);
    expect(paired.cookie).toContain('glmcode_web_session=');

    const replay = await fetch(`${context.origin}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: context.origin },
      body: JSON.stringify({ token: paired.token }),
    });
    expect(replay.status).toBe(401);
  });

  test('过期令牌和异源请求会被拒绝', async () => {
    const context = await createTestServer({ pairingTokenTtlMs: 5 });
    const pairingUrl = new URL(context.server.createPairingUrl());
    const token = new URLSearchParams(pairingUrl.hash.slice(1)).get('pair')!;
    await new Promise(resolve => setTimeout(resolve, 15));
    const expired = await fetch(`${context.origin}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: context.origin },
      body: JSON.stringify({ token }),
    });
    expect(expired.status).toBe(401);

    const nextUrl = new URL(context.server.createPairingUrl());
    const nextToken = new URLSearchParams(nextUrl.hash.slice(1)).get('pair')!;
    const foreignOrigin = await fetch(`${context.origin}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://example.test' },
      body: JSON.stringify({ token: nextToken }),
    });
    expect(foreignOrigin.status).toBe(403);
  });

  test('RPC 需要配对且只执行允许的方法', async () => {
    const context = await createTestServer();
    const unauthorized = await fetch(`${context.origin}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: context.origin },
      body: JSON.stringify({ id: '1', method: 'store.get', params: ['value'] }),
    });
    expect(unauthorized.status).toBe(401);

    const { cookie } = await pairWithServer(context);
    const allowed = await fetch(`${context.origin}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: context.origin, Cookie: cookie },
      body: JSON.stringify({ id: '2', method: 'store.get', params: ['value'] }),
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ id: '2', ok: true, result: 'value' });

    const blocked = await fetch(`${context.origin}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: context.origin, Cookie: cookie },
      body: JSON.stringify({ id: '3', method: 'system.exec', params: [] }),
    });
    expect(blocked.status).toBe(404);
  });

  test('未配对的 WebSocket 连接会被关闭', async () => {
    const context = await createTestServer();
    const wsUrl = `${context.origin.replace(/^http/, 'ws')}/api/events`;
    const closeCode = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      const timer = setTimeout(() => reject(new Error('WebSocket 关闭超时')), 2_000);
      socket.addEventListener('close', event => {
        clearTimeout(timer);
        resolve(event.code);
      });
      socket.addEventListener('error', () => undefined);
    });
    expect(closeCode).toBe(1008);
  });

  test('上传文件保存到受控工作区，并执行体积限制', async () => {
    const context = await createTestServer();
    const { cookie } = await pairWithServer(context);
    const form = new FormData();
    form.append('file', new Blob(['hello']), 'hello.txt');
    const uploaded = await fetch(`${context.origin}/api/workspaces/upload`, {
      method: 'POST',
      headers: { Origin: context.origin, Cookie: cookie },
      body: form,
    });
    expect(uploaded.status).toBe(200);
    const result = await uploaded.json() as { filePath: string; workspacePath: string };
    expect(fs.readFileSync(result.filePath, 'utf8')).toBe('hello');
    expect(result.filePath.startsWith(result.workspacePath + path.sep)).toBe(true);

    const zip = new JSZip();
    zip.file('src/index.ts', 'export {};');
    const zipForm = new FormData();
    zipForm.append('file', new Blob([await zip.generateAsync({ type: 'uint8array' })]), 'project.zip');
    const extracted = await fetch(`${context.origin}/api/workspaces/upload`, {
      method: 'POST',
      headers: { Origin: context.origin, Cookie: cookie },
      body: zipForm,
    });
    expect(extracted.status).toBe(200);
    const extractedResult = await extracted.json() as { workspacePath: string; extracted: boolean };
    expect(extractedResult.extracted).toBe(true);
    expect(fs.readFileSync(path.join(extractedResult.workspacePath, 'src', 'index.ts'), 'utf8'))
      .toBe('export {};');

    const limited = await createTestServer({ maxUploadBytes: 4 });
    const limitedPair = await pairWithServer(limited);
    const oversizedForm = new FormData();
    oversizedForm.append('file', new Blob(['12345']), 'large.txt');
    const oversized = await fetch(`${limited.origin}/api/workspaces/upload`, {
      method: 'POST',
      headers: { Origin: limited.origin, Cookie: limitedPair.cookie },
      body: oversizedForm,
    });
    expect(oversized.status).toBe(413);
  });
});

describe('createZipEntryValidator', () => {
  const regularFile = 0o100644 << 16;
  const symbolicLink = 0o120777 << 16;

  test('拒绝越界路径和符号链接', () => {
    expect(() => createZipEntryValidator()({
      fileName: '../outside.txt',
      externalFileAttributes: regularFile,
      uncompressedSize: 1,
    })).toThrow('越界路径');
    expect(() => createZipEntryValidator()({
      fileName: 'link',
      externalFileAttributes: symbolicLink,
      uncompressedSize: 1,
    })).toThrow('符号链接');
  });

  test('限制条目数量和解压总体积', () => {
    const entryValidator = createZipEntryValidator({ maxEntries: 1, maxExtractedBytes: 4 });
    entryValidator({ fileName: 'one.txt', externalFileAttributes: regularFile, uncompressedSize: 4 });
    expect(() => entryValidator({
      fileName: 'two.txt',
      externalFileAttributes: regularFile,
      uncompressedSize: 1,
    })).toThrow('文件数量');

    const sizeValidator = createZipEntryValidator({ maxEntries: 2, maxExtractedBytes: 4 });
    expect(() => sizeValidator({
      fileName: 'large.txt',
      externalFileAttributes: regularFile,
      uncompressedSize: 5,
    })).toThrow('总体积');
  });
});
