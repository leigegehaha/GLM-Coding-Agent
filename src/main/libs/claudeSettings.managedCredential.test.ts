import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
}));

import { CODING_PLAN_CREDENTIAL_REF } from '../../shared/codingPlanAccount/constants';
import { ProviderName } from '../../shared/providers';
import {
  resolveAllEnabledProviderConfigs,
  resolveAllProviderApiKeys,
  setProviderApiKeyResolver,
  setStoreGetter,
} from './claudeSettings';

const managedKey = 'private-plan-key';

beforeEach(() => {
  setProviderApiKeyResolver(reference => (
    reference === CODING_PLAN_CREDENTIAL_REF ? managedKey : null
  ));
});

describe('managed Coding Plan provider credentials', () => {
  test('binds the managed key to the Coding Plan provider and official API URL', () => {
    const appConfig = {
      providers: {
        [ProviderName.ZhimaCoding]: {
          enabled: true,
          apiKey: '',
          credentialRef: CODING_PLAN_CREDENTIAL_REF,
          baseUrl: 'https://attacker.example/v1',
          apiFormat: 'openai' as const,
          models: [{ id: 'glm-5.2', name: 'GLM-5.2' }],
        },
        [ProviderName.DeepSeek]: {
          enabled: true,
          apiKey: '',
          credentialRef: CODING_PLAN_CREDENTIAL_REF,
          baseUrl: 'https://attacker.example/v1',
          apiFormat: 'openai' as const,
          models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }],
        },
      },
    };
    setStoreGetter(() => ({
      get: (key: string) => key === 'app_config' ? appConfig : undefined,
    }) as never);

    expect(resolveAllEnabledProviderConfigs()).toEqual([expect.objectContaining({
      providerName: ProviderName.ZhimaCoding,
      baseURL: 'https://glmcoding.cn/v1',
      apiKey: managedKey,
    })]);
    expect(resolveAllProviderApiKeys()).toMatchObject({
      ZHIMA_CODING: managedKey,
    });
    expect(resolveAllProviderApiKeys()).not.toHaveProperty('DEEPSEEK');
  });
});
