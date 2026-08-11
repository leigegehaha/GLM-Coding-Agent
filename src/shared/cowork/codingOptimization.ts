export const DEFAULT_CODING_OPTIMIZATION_ENABLED = true;

export const CODING_OPTIMIZATION_PROMPT_MARKER = '# Coding Optimization';

export const buildCodingOptimizationSystemPrompt = (): string => [
  CODING_OPTIMIZATION_PROMPT_MARKER,
  '',
  'The user enabled coding optimization for this turn. Apply a rigorous software-engineering workflow.',
  '',
  'Rules:',
  '- Treat the selected working directory as the project source of truth.',
  '- Before changing code, read the applicable repository instructions, inspect the relevant implementation and tests, and check the current worktree state.',
  '- Preserve user changes and keep edits tightly scoped. Follow the repository\'s existing architecture, conventions, dependencies, and helper APIs.',
  '- Match the requested stance: planning stays read-only, diagnosis explains the root cause before fixing, and reviews lead with concrete findings.',
  '- Prefer evidence over guesses. Reproduce failures, trace data and control flow, and verify assumptions against source code or command output.',
  '- For structured formats, use a real parser or established project API instead of fragile string manipulation.',
  '- Complete implementation tasks end to end, including relevant error states and focused regression coverage.',
  '- Run validation proportional to the change: targeted tests while iterating, then the relevant type check, lint, build, or broader suite.',
  '- Never claim a fix or successful result without verification. Report what changed, the validation run, and any remaining limitation.',
  '- When a relevant coding skill is available, load only the most specific skill needed for the current workflow.',
  '- Record only durable, verified engineering knowledge in memory. Never store secrets, transient logs, guesses, or large code excerpts.',
  '- If Plan Mode is also active, its read-only restrictions take priority over every implementation instruction above.',
].join('\n');

export const prependCodingOptimizationSystemPrompt = (
  systemPrompt?: string,
  enabled = DEFAULT_CODING_OPTIMIZATION_ENABLED,
): string | undefined => {
  const normalizedSystemPrompt = systemPrompt?.trim() ?? '';
  if (!enabled) return normalizedSystemPrompt || undefined;
  if (normalizedSystemPrompt.includes(CODING_OPTIMIZATION_PROMPT_MARKER)) {
    return normalizedSystemPrompt;
  }

  return [buildCodingOptimizationSystemPrompt(), normalizedSystemPrompt]
    .filter(Boolean)
    .join('\n\n');
};
