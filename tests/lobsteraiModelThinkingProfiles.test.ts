import { describe, expect, test } from 'vitest';

import { resolveKnownModelThinkingProfile } from '../openclaw-extensions/lobsterai-model-compat/thinkingProfiles';
import { resolveModelThinkingProfile } from '../src/shared/providers/modelThinkingProfiles';

describe('runtime thinking profiles', () => {
  test.each([
    'glm-5.2',
    'claude-opus-4-8',
    'kimi-k3-YoudaoInner',
    'deepseek-v4-pro',
  ])('matches the renderer profile for %s', (modelId) => {
    const rendererProfile = resolveModelThinkingProfile(modelId, false);
    expect(resolveKnownModelThinkingProfile(modelId)).toEqual({
      levels: rendererProfile?.levels,
      defaultLevel: rendererProfile?.defaultLevel,
    });
  });
});
