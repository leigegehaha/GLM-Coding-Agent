import { describe, expect, test } from 'vitest';

import {
  isKnownThinkingModelId,
  ModelThinkingFamily,
  ModelThinkingLevel,
  normalizeThinkingLevelForProfile,
  resolveModelThinkingProfile,
} from './modelThinkingProfiles';

describe('model thinking profiles', () => {
  test.each([
    ['zhima-coding/glm-5.2', ModelThinkingFamily.Glm52, ['off', 'low'], 'off'],
    ['claude-opus-4-8', ModelThinkingFamily.ClaudeOpus, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max'], 'off'],
    ['lobsterai-server/kimi-k3-YoudaoInner', ModelThinkingFamily.KimiK3, ['high'], 'high'],
    ['deepseek-v4-pro', ModelThinkingFamily.DeepSeekV4, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'high'],
    ['deepseek-v4-flash-0731', ModelThinkingFamily.DeepSeekV4, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'high'],
  ])('resolves %s', (modelId, family, levels, defaultLevel) => {
    const profile = resolveModelThinkingProfile(modelId, false);
    expect(profile?.family).toBe(family);
    expect(profile?.levels.map(level => level.id)).toEqual(levels);
    expect(profile?.defaultLevel).toBe(defaultLevel);
    expect(isKnownThinkingModelId(modelId)).toBe(true);
  });

  test('uses the generic profile only for explicitly capable unknown models', () => {
    expect(resolveModelThinkingProfile('custom-reasoner', false)).toBeUndefined();
    expect(resolveModelThinkingProfile('custom-reasoner', true)?.levels.map(level => level.id))
      .toEqual(['off', 'minimal', 'low', 'medium', 'high']);
  });

  test('remaps an unsupported level to the closest supported model level', () => {
    const glmProfile = resolveModelThinkingProfile('glm-5.2', false);
    const kimiProfile = resolveModelThinkingProfile('kimi-k3', false);
    expect(glmProfile).toBeDefined();
    expect(kimiProfile).toBeDefined();
    expect(normalizeThinkingLevelForProfile(ModelThinkingLevel.High, glmProfile!))
      .toBe(ModelThinkingLevel.Low);
    expect(normalizeThinkingLevelForProfile(ModelThinkingLevel.Off, kimiProfile!))
      .toBe(ModelThinkingLevel.High);
    expect(kimiProfile?.levels[0]?.label).toBe('max');
  });
});
