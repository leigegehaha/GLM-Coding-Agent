export const ModelThinkingLevel = {
  Off: 'off',
} as const;

export const ModelThinkingFamily = {
  Glm52: 'glm-5.2',
  ClaudeOpus: 'claude-opus',
  KimiK3: 'kimi-k3',
  DeepSeekV4: 'deepseek-v4',
} as const;

export type ModelThinkingFamily =
  typeof ModelThinkingFamily[keyof typeof ModelThinkingFamily];

type ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'adaptive'
  | 'max';

type ThinkingProfile = {
  levels: Array<{ id: ThinkingLevel; label?: 'on' | 'max' }>;
  defaultLevel: ThinkingLevel;
};

const getUnqualifiedModelId = (modelId: string): string => {
  const normalized = modelId.trim().toLowerCase();
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
};

export const resolveKnownModelThinkingFamily = (
  modelId: string,
): ModelThinkingFamily | undefined => {
  const id = getUnqualifiedModelId(modelId);
  if (/^glm[-_.]?5[-_.]?2(?:[-_.]|$)/.test(id)) return ModelThinkingFamily.Glm52;
  if (/^claude[-_.]?opus(?:[-_.]|$)/.test(id)) return ModelThinkingFamily.ClaudeOpus;
  if (/^kimi[-_.]?k3(?:[-_.]|$)/.test(id)) return ModelThinkingFamily.KimiK3;
  if (/^deepseek[-_.]?v4(?:[-_.]|$)/.test(id)) return ModelThinkingFamily.DeepSeekV4;
  return undefined;
};

export const resolveKnownModelThinkingProfile = (
  modelId: string,
): ThinkingProfile | undefined => {
  const family = resolveKnownModelThinkingFamily(modelId);
  switch (family) {
    case ModelThinkingFamily.Glm52:
      return {
        levels: [{ id: 'off' }, { id: 'low', label: 'on' }],
        defaultLevel: 'off',
      };
    case ModelThinkingFamily.ClaudeOpus:
      return {
        levels: [
          { id: 'off' },
          { id: 'minimal' },
          { id: 'low' },
          { id: 'medium' },
          { id: 'high' },
          { id: 'xhigh' },
          { id: 'adaptive' },
          { id: 'max' },
        ],
        defaultLevel: 'off',
      };
    case ModelThinkingFamily.KimiK3:
      return { levels: [{ id: 'high', label: 'max' }], defaultLevel: 'high' };
    case ModelThinkingFamily.DeepSeekV4:
      return {
        levels: [
          { id: 'off' },
          { id: 'minimal' },
          { id: 'low' },
          { id: 'medium' },
          { id: 'high' },
          { id: 'xhigh' },
          { id: 'max' },
        ],
        defaultLevel: 'high',
      };
    default:
      return undefined;
  }
};
