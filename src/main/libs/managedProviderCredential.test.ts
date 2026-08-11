import { describe, expect, test, vi } from 'vitest';

import { CODING_PLAN_CREDENTIAL_REF } from '../../shared/codingPlanAccount/constants';
import { injectManagedProviderCredential } from './managedProviderCredential';

const inject = (overrides: Partial<Parameters<typeof injectManagedProviderCredential>[0]> = {}) => (
  injectManagedProviderCredential({
    url: 'https://glmcoding.cn/v1/chat/completions',
    headers: { 'Content-Type': 'application/json' },
    credentialRef: CODING_PLAN_CREDENTIAL_REF,
    credentialIsActive: true,
    readCredential: () => 'private-plan-key',
    ...overrides,
  })
);

describe('injectManagedProviderCredential', () => {
  test('injects the managed key only for the official Coding Plan API path', () => {
    const readCredential = vi.fn(() => 'private-plan-key');

    expect(inject({
      headers: {
        Authorization: 'Bearer renderer-value',
        'x-api-key': 'renderer-value',
        'X-Goog-Api-Key': 'renderer-value',
        'Content-Type': 'application/json',
      },
      readCredential,
    })).toEqual({
      Authorization: 'Bearer private-plan-key',
      'Content-Type': 'application/json',
    });
    expect(readCredential).toHaveBeenCalledWith(CODING_PLAN_CREDENTIAL_REF);
  });

  test.each([
    'http://glmcoding.cn/v1/chat/completions',
    'https://glmcoding.cn.evil.example/v1/chat/completions',
    'https://glmcoding.cn:444/v1/chat/completions',
    'https://user:password@glmcoding.cn/v1/chat/completions',
    'https://glmcoding.cn/v11/chat/completions',
  ])('rejects an untrusted credential target: %s', url => {
    expect(() => inject({ url })).toThrow('Managed provider credential');
  });

  test('rejects inactive and unknown credential references', () => {
    expect(() => inject({ credentialIsActive: false })).toThrow('not active');
    expect(() => inject({ credentialRef: 'other-secret' })).toThrow('Unknown');
  });

  test('does not resolve a credential when no managed reference is present', () => {
    const headers = { Authorization: 'Bearer renderer-value' };
    const readCredential = vi.fn(() => 'private-plan-key');

    expect(inject({ headers, credentialRef: undefined, readCredential })).toBe(headers);
    expect(readCredential).not.toHaveBeenCalled();
  });
});
