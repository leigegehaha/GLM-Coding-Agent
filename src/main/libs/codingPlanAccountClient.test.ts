import { describe, expect, test, vi } from 'vitest';

import { CodingPlanAccountErrorCode } from '../../shared/codingPlanAccount/constants';
import { CodingPlanAccountClient } from './codingPlanAccountClient';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('CodingPlanAccountClient', () => {
  test('loads the current account without requesting plan details', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse({ user: { id: '6', email: 'account@example.com' } }),
    );
    const client = new CodingPlanAccountClient({
      fetch,
      getBaseUrl: () => 'https://glmcoding.cn',
    });

    await expect(client.getAccount()).resolves.toEqual({
      success: true,
      data: { id: '6', email: 'account@example.com', name: 'account@example.com' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('logs in with the Auth.js credentials flow without persisting the password', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: null, message: 'ok' }))
      .mockResolvedValueOnce(jsonResponse({ url: 'https://glmcoding.cn/' }))
      .mockResolvedValueOnce(
        jsonResponse({
          user: { id: '7', username: 'user@example.com', name: 'User' },
        }),
      );
    const client = new CodingPlanAccountClient({
      fetch,
      getBaseUrl: () => 'https://glmcoding.cn/',
    });

    const result = await client.login(' user@example.com ', 'secret-password');

    expect(result).toEqual({
      success: true,
      data: { id: '7', email: 'user@example.com', name: 'User' },
    });
    expect(fetch.mock.calls[1][0]).toBe('https://glmcoding.cn/api/v1/user/auth/login');
    expect(fetch.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ email: 'user@example.com', password: 'secret-password' }),
    });
    expect(fetch.mock.calls[2][0]).toBe('https://glmcoding.cn/api/auth/callback/credentials');
    expect(fetch.mock.calls[2][1]).toMatchObject({
      credentials: 'include',
      headers: expect.objectContaining({ 'X-Auth-Return-Redirect': '1' }),
    });
    expect(String(fetch.mock.calls[2][1]?.body)).toContain('password=secret-password');
    expect(String(fetch.mock.calls[2][1]?.body)).toContain('callbackUrl=https%3A%2F%2Fglmcoding.cn%2F');
  });

  test('reports invalid credentials when the business login rejects the account', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ code: 40301, message: 'invalid' }));
    const client = new CodingPlanAccountClient({ fetch, getBaseUrl: () => 'https://glmcoding.cn' });

    await expect(client.login('user@example.com', 'wrong-password')).resolves.toEqual({
      success: false,
      errorCode: CodingPlanAccountErrorCode.InvalidCredentials,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('reports invalid credentials when Auth.js rejects the callback', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ code: 0 }))
      .mockResolvedValueOnce(jsonResponse({
        url: 'https://codingplan.glmcoding.cn/login?error=CredentialsSignin&code=credentials',
      }));
    const client = new CodingPlanAccountClient({ fetch, getBaseUrl: () => 'https://glmcoding.cn' });

    await expect(client.login('user@example.com', 'wrong-password')).resolves.toEqual({
      success: false,
      errorCode: CodingPlanAccountErrorCode.InvalidCredentials,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('loads the signed-in account and plan overview', async () => {
    const overview = {
      plans: [],
      unboundKeys: [{
        tokenId: 17,
        name: 'Primary key',
        keyMasked: 'abcd...wxyz',
        keyFull: 'must-not-reach-renderer',
        boundAt: '2026-08-10T00:00:00.000Z',
      }],
      ratiosOnly: true,
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ user: { id: '8', email: 'u@example.com' } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: overview, message: 'ok' }));
    const client = new CodingPlanAccountClient({ fetch, getBaseUrl: () => 'https://glmcoding.cn' });

    await expect(client.getOverview()).resolves.toEqual({
      success: true,
      data: {
        account: { id: '8', email: 'u@example.com', name: 'u@example.com' },
        overview: {
          plans: [],
          unboundKeys: [{
            tokenId: 17,
            name: 'Primary key',
            keyMasked: 'abcd...wxyz',
            boundAt: '2026-08-10T00:00:00.000Z',
          }],
          ratiosOnly: true,
        },
      },
    });
  });

  test('resolves and validates a selected key without returning it to the renderer DTO', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ user: { id: '8', email: 'u@example.com' } }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          plans: [],
          unboundKeys: [{
            tokenId: 17,
            name: 'Primary key',
            keyMasked: 'abcd...wxyz',
            keyFull: 'private-plan-key',
            boundAt: '2026-08-10T00:00:00.000Z',
          }],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'glm-5.2' }] }));
    const client = new CodingPlanAccountClient({ fetch, getBaseUrl: () => 'https://glmcoding.cn' });

    await expect(client.prepareConfiguration(17)).resolves.toEqual({
      success: true,
      data: {
        apiKey: 'private-plan-key',
        models: [{ id: 'glm-5.2', name: 'glm-5.2' }],
        tokenId: 17,
      },
    });
    expect(fetch.mock.calls[2][1]?.headers).toMatchObject({
      Authorization: 'Bearer private-plan-key',
    });
  });

  test('loads the models allowed by a selected plan key', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: 'glm-5.2', display_name: 'GLM-5.2', context_length: 1_000_000 }],
      }),
    );
    const client = new CodingPlanAccountClient({ fetch, getBaseUrl: () => 'https://glmcoding.cn' });

    await expect(client.getModelsForKey('plan-key')).resolves.toEqual({
      success: true,
      data: [{ id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000 }],
    });
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer plan-key' });
  });
});
