import { describe, expect, test, vi } from 'vitest';

import { WebConsoleRpcRegistry } from './rpcRegistry';

describe('WebConsoleRpcRegistry', () => {
  test('只调用显式白名单中的 IPC handler', async () => {
    const registry = new WebConsoleRpcRegistry();
    const handler = vi.fn(async (_event, key: unknown) => `value:${String(key)}`);
    registry.capture('store:get', handler);
    const event = {} as Parameters<WebConsoleRpcRegistry['invoke']>[2];

    await expect(registry.invoke('store.get', ['theme'], event)).resolves.toBe('value:theme');
    await expect(registry.invoke('system.exec', [], event)).rejects.toThrow(
      'WEB_RPC_METHOD_NOT_FOUND:system.exec',
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
