import { describe, expect, test } from 'vitest';

import {
  buildCodingOptimizationSystemPrompt,
  CODING_OPTIMIZATION_PROMPT_MARKER,
  prependCodingOptimizationSystemPrompt,
} from './codingOptimization';

describe('coding optimization system prompt', () => {
  test('builds a model-independent coding workflow with Plan Mode precedence', () => {
    const prompt = buildCodingOptimizationSystemPrompt();

    expect(prompt).toContain(CODING_OPTIMIZATION_PROMPT_MARKER);
    expect(prompt).toContain('Preserve user changes');
    expect(prompt).toContain('Plan Mode');
  });

  test('prepends the coding layer without replacing the turn prompt', () => {
    expect(prependCodingOptimizationSystemPrompt('base prompt', true)).toBe(
      `${buildCodingOptimizationSystemPrompt()}\n\nbase prompt`,
    );
  });

  test('does not duplicate a coding layer already applied upstream', () => {
    const prompt = prependCodingOptimizationSystemPrompt('base prompt', true);

    expect(prependCodingOptimizationSystemPrompt(prompt, true)).toBe(prompt);
  });

  test('returns the original prompt when coding optimization is disabled', () => {
    expect(prependCodingOptimizationSystemPrompt('  base prompt  ', false)).toBe('base prompt');
    expect(prependCodingOptimizationSystemPrompt(undefined, false)).toBeUndefined();
  });
});
