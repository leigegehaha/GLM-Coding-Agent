import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { store } from '../store';
import { setCurrentSession } from '../store/slices/coworkSlice';
import {
  type CoworkMessage,
  type CoworkSession,
  CoworkSessionStatusValue,
} from '../types/cowork';
import { coworkService } from './cowork';

const messages: CoworkMessage[] = Array.from({ length: 40 }, (_, index) => ({
  id: `message-${index}`,
  type: index % 2 === 0 ? 'user' : 'assistant',
  content: `message ${index}`,
  timestamp: index,
}));

const makeSession = (overrides: Partial<CoworkSession> = {}): CoworkSession => ({
  id: 'session-1',
  title: 'Session 1',
  claudeSessionId: null,
  status: CoworkSessionStatusValue.Completed,
  pinned: false,
  pinOrder: null,
  cwd: '/tmp',
  systemPrompt: '',
  modelOverride: 'zhima-coding/glm-5.2',
  executionMode: 'local',
  activeSkillIds: [],
  agentId: 'main',
  messages,
  messagesOffset: 0,
  totalMessages: messages.length,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

beforeEach(() => {
  store.dispatch(setCurrentSession(makeSession()));
});

afterEach(() => {
  store.dispatch(setCurrentSession(null));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('coworkService.patchSession', () => {
  test('does not rebuild the current session for a thinking-level patch', async () => {
    const currentSessionBeforePatch = store.getState().cowork.currentSession;
    const patch = vi.fn(async () => ({
      success: true,
      session: makeSession({ messages: messages.slice(-30), messagesOffset: 10 }),
    }));
    vi.stubGlobal('window', {
      electron: { openclaw: { session: { patch } } },
    });

    await coworkService.patchSession('session-1', {
      thinkingLevel: 'low',
      reasoningLevel: 'stream',
    });

    expect(patch).toHaveBeenCalledWith({
      sessionId: 'session-1',
      patch: { thinkingLevel: 'low', reasoningLevel: 'stream' },
    });
    expect(store.getState().cowork.currentSession).toBe(currentSessionBeforePatch);
    expect(store.getState().cowork.currentSession?.messages).toHaveLength(40);
  });

  test('updates only the model field and preserves loaded messages for a model patch', async () => {
    const getContextUsage = vi.fn(async () => ({ success: true, usage: null }));
    vi.stubGlobal('window', {
      electron: {
        openclaw: {
          session: {
            patch: vi.fn(async () => ({
              success: true,
              session: makeSession({
                modelOverride: 'anthropic/claude-opus',
                messages: messages.slice(-30),
                messagesOffset: 10,
              }),
            })),
          },
        },
        cowork: { getContextUsage },
      },
    });

    await coworkService.patchSession('session-1', { model: 'anthropic/claude-opus' });

    expect(store.getState().cowork.currentSession?.modelOverride).toBe('anthropic/claude-opus');
    expect(store.getState().cowork.currentSession?.messages).toHaveLength(40);
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(0);
    expect(getContextUsage).toHaveBeenCalledWith('session-1');
  });
});
