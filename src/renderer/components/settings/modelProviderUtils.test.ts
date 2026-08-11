import { expect, test } from 'vitest';

import { OpenClawProviderId, ProviderAuthType, ProviderName } from '../../../shared/providers';
import {
  buildOpenAIConnectionTestRequestBody,
  getFixedApiFormatForProvider,
  getOpenClawProviderIdForConfig,
  hasEquivalentProviderModelId,
  hasProviderAuthConfigured,
  type ProviderConfig,
  providerRequiresApiKey,
  resolveCodingPlanDefaultModel,
  shouldShowApiFormatSelector,
} from './modelProviderUtils';

const providerConfig = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  enabled: true,
  apiKey: '',
  baseUrl: 'https://api.example.com',
  models: [],
  ...overrides,
});

test('GitHub Copilot does not require a persisted API key', () => {
  expect(providerRequiresApiKey(ProviderName.Copilot)).toBe(false);
});

test('智码 Coding Plan always uses the OpenAI-compatible transport', () => {
  expect(getFixedApiFormatForProvider(ProviderName.ZhimaCoding)).toBe('openai');
  expect(shouldShowApiFormatSelector(ProviderName.ZhimaCoding)).toBe(false);
});

test('智码 Coding Plan auth is tracked by a main-process credential reference', () => {
  expect(hasProviderAuthConfigured(
    ProviderName.ZhimaCoding,
    providerConfig({ apiKey: '', credentialRef: 'coding-plan-account-key' }),
  )).toBe(true);
  expect(hasProviderAuthConfigured(
    ProviderName.ZhimaCoding,
    providerConfig({ apiKey: 'renderer-visible-key' }),
  )).toBe(false);
});

test('Coding Plan configuration prefers GLM-5.2 over API list order', () => {
  expect(resolveCodingPlanDefaultModel([
    { id: 'glm-4.7', name: 'GLM-4.7' },
    { id: 'glm-5.2', name: 'GLM-5.2' },
  ])?.id).toBe('glm-5.2');
});

test('Coding Plan configuration falls back when GLM-5.2 is unavailable', () => {
  expect(resolveCodingPlanDefaultModel([
    { id: 'glm-4.7', name: 'GLM-4.7' },
    { id: 'deepseek-v4', name: 'DeepSeek V4' },
  ])?.id).toBe('glm-4.7');
});

test('GitHub Copilot OAuth auth is tracked by authType instead of apiKey', () => {
  expect(
    hasProviderAuthConfigured(
      ProviderName.Copilot,
      providerConfig({ authType: ProviderAuthType.OAuth }),
    ),
  ).toBe(true);

  expect(
    hasProviderAuthConfigured(
      ProviderName.Copilot,
      providerConfig({ apiKey: 'legacy-short-token' }),
    ),
  ).toBe(false);
});

test('MiniMax OAuth resolves to the OpenClaw portal provider', () => {
  expect(
    getOpenClawProviderIdForConfig(
      ProviderName.Minimax,
      providerConfig({ authType: ProviderAuthType.OAuth }),
    ),
  ).toBe(OpenClawProviderId.MinimaxPortal);

  expect(
    getOpenClawProviderIdForConfig(
      ProviderName.Minimax,
      providerConfig({ authType: ProviderAuthType.ApiKey }),
    ),
  ).toBe(OpenClawProviderId.Minimax);
});

test('OpenAI OAuth models use the canonical OpenClaw OpenAI provider id', () => {
  expect(
    getOpenClawProviderIdForConfig(
      ProviderName.OpenAI,
      providerConfig({ authType: ProviderAuthType.OAuth }),
    ),
  ).toBe(OpenClawProviderId.OpenAI);
});

test('provider model identity comparison ignores K3 punctuation and casing', () => {
  expect(hasEquivalentProviderModelId([{ id: 'kimi-k3' }], ' Kimi_K3 ')).toBe(true);
});

test('provider model identity comparison excludes the model currently being edited', () => {
  expect(hasEquivalentProviderModelId([{ id: 'Kimi_K3' }], 'kimi.k3', 'Kimi_K3')).toBe(false);

  expect(
    hasEquivalentProviderModelId([{ id: 'Kimi_K3' }, { id: 'kimi.k3' }], 'kimi-k3', 'Kimi_K3'),
  ).toBe(true);
});

test('provider model identity comparison preserves distinct non-K3 punctuation', () => {
  expect(hasEquivalentProviderModelId([{ id: 'foo/bar' }, { id: 'model.v1' }], 'foo-bar')).toBe(
    false,
  );
  expect(hasEquivalentProviderModelId([{ id: 'foo/bar' }, { id: 'model.v1' }], 'model-v1')).toBe(
    false,
  );
});

test('legacy Moonshot Anthropic configs stay visible and use their real transport', () => {
  expect(shouldShowApiFormatSelector(ProviderName.Moonshot, 'anthropic')).toBe(true);
  expect(shouldShowApiFormatSelector(ProviderName.Moonshot, 'openai')).toBe(false);
});

test('official Moonshot K3 connection test uses the K3 request contract', () => {
  expect(
    buildOpenAIConnectionTestRequestBody({
      provider: ProviderName.Moonshot,
      model: { id: 'kimi-k3' },
      useResponsesApi: false,
    }),
  ).toEqual({
    model: 'kimi-k3',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 64,
    reasoning_effort: 'max',
  });
});

test('exact custom K3 model ID uses the K3 request contract', () => {
  expect(
    buildOpenAIConnectionTestRequestBody({
      provider: 'custom_0',
      model: { id: 'kimi-k3' },
      useResponsesApi: false,
    }),
  ).toMatchObject({
    model: 'kimi-k3',
    max_tokens: 64,
    reasoning_effort: 'max',
  });
});

test('ordinary OpenAI-compatible connection tests retain their existing token field', () => {
  expect(
    buildOpenAIConnectionTestRequestBody({
      provider: 'custom_0',
      model: { id: 'ordinary-model' },
      useResponsesApi: false,
    }),
  ).toEqual({
    model: 'ordinary-model',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 64,
  });
});
