import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import {
  buildAnthropicReplayPolicyForModel,
  buildGoogleGeminiReplayPolicy,
  buildOpenAICompatibleReplayPolicy,
} from 'openclaw/plugin-sdk/provider-model-shared';
import {
  createDeepSeekV4OpenAICompatibleThinkingWrapper,
  createMoonshotKimiK3Wrapper,
  createPayloadPatchStreamWrapper,
} from 'openclaw/plugin-sdk/provider-stream-shared';

import {
  hasModelRuntimeProfile,
  LobsterAIModelRuntimeProfile,
  ModelProfileTransportDecision,
  parseModelProfileMap,
  resolveModelProfileTransportDecision,
} from './profileMapping';
import {
  ModelThinkingFamily,
  ModelThinkingLevel,
  resolveKnownModelThinkingFamily,
  resolveKnownModelThinkingProfile,
} from './thinkingProfiles';

const PLUGIN_ID = 'lobsterai-model-compat';
const ZHIMA_CODING_PROVIDER_ID = 'zhima-coding';
const LOBSTERAI_SERVER_PROVIDER_ID = 'lobsterai-server';
const OPENAI_COMPLETIONS_API = 'openai-completions';
const OPENAI_COMPATIBLE_APIS = new Set([
  OPENAI_COMPLETIONS_API,
  'openai-responses',
  'openai-chatgpt-responses',
]);

const isThinkingEnabled = (thinkingLevel: string | undefined): boolean =>
  thinkingLevel !== ModelThinkingLevel.Off;

const register = (api: OpenClawPluginApi): void => {
  const modelProfiles = parseModelProfileMap(api.pluginConfig?.modelProfiles);
  const isKimiK3Profile = (provider: string, modelId: string): boolean => (
    hasModelRuntimeProfile(
      modelProfiles,
      provider,
      modelId,
      LobsterAIModelRuntimeProfile.MoonshotKimiK3,
    )
  );
  const resolveTransportDecision = (
    provider: string,
    modelId: string,
    modelApi?: string,
  ) => resolveModelProfileTransportDecision({
    modelProfiles,
    provider,
    modelId,
    modelApi,
  });
  const assertSupportedTransport = (
    provider: string,
    modelId: string,
    modelApi?: string,
  ): ReturnType<typeof resolveTransportDecision> => {
    const decision = resolveTransportDecision(provider, modelId, modelApi);
    if (decision.kind === ModelProfileTransportDecision.Reject) {
      throw new Error(
        `Kimi K3 compatibility requires ${decision.expectedApi} for ${provider}/${modelId}; received ${decision.actualApi}`,
      );
    }
    return decision;
  };

  api.registerProvider({
    id: PLUGIN_ID,
    label: '智码 GLM Code Model Compatibility',
    hookAliases: [ZHIMA_CODING_PROVIDER_ID, LOBSTERAI_SERVER_PROVIDER_ID],
    auth: [],
    buildReplayPolicy: (ctx) => {
      const modelApi = ctx.modelApi ?? ctx.model?.api;
      const modelId = ctx.modelId ?? '';
      const decision = assertSupportedTransport(ctx.provider, modelId, modelApi);
      if (decision.kind === ModelProfileTransportDecision.MoonshotKimiK3) {
        return buildOpenAICompatibleReplayPolicy(modelApi, {
          modelId,
          sanitizeToolCallIds: false,
          dropReasoningFromHistory: false,
        });
      }
      if (modelApi && OPENAI_COMPATIBLE_APIS.has(modelApi)) {
        return buildOpenAICompatibleReplayPolicy(modelApi, {
          modelId,
          dropReasoningFromHistory: ctx.model?.reasoning !== true,
        });
      }
      if (modelApi === 'anthropic-messages') {
        return buildAnthropicReplayPolicyForModel(modelId);
      }
      if (modelApi === 'google-generative-ai') {
        return buildGoogleGeminiReplayPolicy();
      }
      return undefined;
    },
    wrapStreamFn: (ctx) => {
      const decision = assertSupportedTransport(ctx.provider, ctx.modelId, ctx.model?.api);
      if (decision.kind === ModelProfileTransportDecision.MoonshotKimiK3) {
        return createMoonshotKimiK3Wrapper(ctx.streamFn);
      }
      const family = resolveKnownModelThinkingFamily(ctx.modelId);
      if (family === ModelThinkingFamily.KimiK3) {
        return createMoonshotKimiK3Wrapper(ctx.streamFn);
      }
      if (family === ModelThinkingFamily.DeepSeekV4) {
        const wrapped = createDeepSeekV4OpenAICompatibleThinkingWrapper({
          baseStreamFn: ctx.streamFn,
          thinkingLevel: ctx.thinkingLevel,
          shouldPatchModel: model => (
            resolveKnownModelThinkingFamily(model.id) === ModelThinkingFamily.DeepSeekV4
          ),
        });
        return createPayloadPatchStreamWrapper(wrapped, ({ payload }) => {
          const thinking = payload.thinking;
          if (
            thinking
            && typeof thinking === 'object'
            && (thinking as Record<string, unknown>).type === 'enabled'
          ) {
            payload.thinking = { ...thinking, type: 'adaptive' };
          }
        });
      }
      if (family === ModelThinkingFamily.Glm52) {
        return createPayloadPatchStreamWrapper(ctx.streamFn, ({ payload }) => {
          payload.enable_thinking = isThinkingEnabled(ctx.thinkingLevel);
          delete payload.reasoning_effort;
        });
      }
      return ctx.streamFn;
    },
    resolveThinkingProfile: ({ provider, modelId }) => {
      if (isKimiK3Profile(provider, modelId)) {
        return {
          levels: [{ id: 'high', label: 'max' }],
          defaultLevel: 'high',
          preserveWhenCatalogReasoningFalse: true,
        };
      }
      const profile = resolveKnownModelThinkingProfile(modelId);
      return profile
        ? {
            levels: profile.levels.map(level => ({
              id: level.id,
              ...(level.label ? { label: level.label } : {}),
            })),
            defaultLevel: profile.defaultLevel,
          }
        : undefined;
    },
    isModernModelRef: ({ provider, modelId }) => (
      isKimiK3Profile(provider, modelId) || undefined
    ),
  });
};

export default {
  id: PLUGIN_ID,
  name: '智码 GLM Code Model Compatibility',
  description: 'Applies explicit 智码 GLM Code-managed model runtime profiles.',
  register,
};
