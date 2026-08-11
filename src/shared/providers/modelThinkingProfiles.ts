export const ModelThinkingLevel = {
  Off: 'off',
  Minimal: 'minimal',
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  XHigh: 'xhigh',
  Adaptive: 'adaptive',
  Max: 'max',
} as const;

export type ModelThinkingLevel =
  typeof ModelThinkingLevel[keyof typeof ModelThinkingLevel];

export const ModelThinkingFamily = {
  Glm52: 'glm-5.2',
  ClaudeOpus: 'claude-opus',
  KimiK3: 'kimi-k3',
  DeepSeekV4: 'deepseek-v4',
  Generic: 'generic',
} as const;

export type ModelThinkingFamily =
  typeof ModelThinkingFamily[keyof typeof ModelThinkingFamily];

export interface ModelThinkingLevelOption {
  id: ModelThinkingLevel;
  label?: 'on' | 'max';
}

export interface ModelThinkingProfile {
  family: ModelThinkingFamily;
  levels: readonly ModelThinkingLevelOption[];
  defaultLevel: ModelThinkingLevel;
}

const BASE_LEVELS = [
  { id: ModelThinkingLevel.Off },
  { id: ModelThinkingLevel.Minimal },
  { id: ModelThinkingLevel.Low },
  { id: ModelThinkingLevel.Medium },
  { id: ModelThinkingLevel.High },
] as const;

const KNOWN_PROFILES: Record<Exclude<ModelThinkingFamily, 'generic'>, ModelThinkingProfile> = {
  [ModelThinkingFamily.Glm52]: {
    family: ModelThinkingFamily.Glm52,
    levels: [
      { id: ModelThinkingLevel.Off },
      { id: ModelThinkingLevel.Low, label: 'on' },
    ],
    defaultLevel: ModelThinkingLevel.Off,
  },
  [ModelThinkingFamily.ClaudeOpus]: {
    family: ModelThinkingFamily.ClaudeOpus,
    levels: [
      ...BASE_LEVELS,
      { id: ModelThinkingLevel.XHigh },
      { id: ModelThinkingLevel.Adaptive },
      { id: ModelThinkingLevel.Max },
    ],
    defaultLevel: ModelThinkingLevel.Off,
  },
  [ModelThinkingFamily.KimiK3]: {
    family: ModelThinkingFamily.KimiK3,
    levels: [{ id: ModelThinkingLevel.High, label: 'max' }],
    defaultLevel: ModelThinkingLevel.High,
  },
  [ModelThinkingFamily.DeepSeekV4]: {
    family: ModelThinkingFamily.DeepSeekV4,
    levels: [
      ...BASE_LEVELS,
      { id: ModelThinkingLevel.XHigh },
      { id: ModelThinkingLevel.Max },
    ],
    defaultLevel: ModelThinkingLevel.High,
  },
};

const GENERIC_PROFILE: ModelThinkingProfile = {
  family: ModelThinkingFamily.Generic,
  levels: BASE_LEVELS,
  defaultLevel: ModelThinkingLevel.Medium,
};

const getUnqualifiedModelId = (modelId: string): string => {
  const normalized = modelId.trim().toLowerCase();
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
};

export const resolveKnownModelThinkingFamily = (
  modelId: string,
): Exclude<ModelThinkingFamily, 'generic'> | undefined => {
  const id = getUnqualifiedModelId(modelId);
  if (/^glm[-_.]?5[-_.]?2(?:[-_.]|$)/.test(id)) {
    return ModelThinkingFamily.Glm52;
  }
  if (/^claude[-_.]?opus(?:[-_.]|$)/.test(id)) {
    return ModelThinkingFamily.ClaudeOpus;
  }
  if (/^kimi[-_.]?k3(?:[-_.]|$)/.test(id)) {
    return ModelThinkingFamily.KimiK3;
  }
  if (/^deepseek[-_.]?v4(?:[-_.]|$)/.test(id)) {
    return ModelThinkingFamily.DeepSeekV4;
  }
  return undefined;
};

export const isKnownThinkingModelId = (modelId: string): boolean =>
  resolveKnownModelThinkingFamily(modelId) !== undefined;

export const resolveModelThinkingProfile = (
  modelId: string,
  supportsThinking: boolean,
): ModelThinkingProfile | undefined => {
  const family = resolveKnownModelThinkingFamily(modelId);
  if (family) {
    return KNOWN_PROFILES[family];
  }
  return supportsThinking ? GENERIC_PROFILE : undefined;
};

const THINKING_LEVEL_RANK: Record<ModelThinkingLevel, number> = {
  [ModelThinkingLevel.Off]: 0,
  [ModelThinkingLevel.Minimal]: 1,
  [ModelThinkingLevel.Low]: 2,
  [ModelThinkingLevel.Medium]: 3,
  [ModelThinkingLevel.Adaptive]: 3,
  [ModelThinkingLevel.High]: 4,
  [ModelThinkingLevel.XHigh]: 5,
  [ModelThinkingLevel.Max]: 6,
};

export const normalizeThinkingLevelForProfile = (
  level: ModelThinkingLevel,
  profile: ModelThinkingProfile,
): ModelThinkingLevel => {
  if (profile.levels.some(option => option.id === level)) {
    return level;
  }
  if (level === ModelThinkingLevel.Off) {
    return profile.defaultLevel;
  }

  const targetLevel = level === ModelThinkingLevel.Adaptive
    ? ModelThinkingLevel.Medium
    : level;
  const targetRank = THINKING_LEVEL_RANK[targetLevel];
  const fallback = [...profile.levels]
    .filter(option => option.id !== ModelThinkingLevel.Off)
    .sort((a, b) => THINKING_LEVEL_RANK[b.id] - THINKING_LEVEL_RANK[a.id])
    .find(option => THINKING_LEVEL_RANK[option.id] <= targetRank);
  return fallback?.id ?? profile.defaultLevel;
};
