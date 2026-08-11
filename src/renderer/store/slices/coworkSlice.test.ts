import { expect, test } from 'vitest';

import {
  COWORK_BTW_EPHEMERAL_THREAD_LIMIT,
  COWORK_BTW_THREAD_CONTENT_MAX_CHARS,
  COWORK_BTW_THREAD_ENTRY_LIMIT,
  CoworkBtwStatus,
} from '../../../shared/cowork/btw';
import {
  type CoworkSelectedTextSnippet,
  CoworkSelectedTextSource,
} from '../../../shared/cowork/selectedText';
import { CoworkSessionStatusValue } from '../../types/cowork';
import coworkReducer, {
  addMessage,
  addSession,
  appendBtwEntry,
  clearBtwComposerIfUnchanged,
  clearCurrentSession,
  closeBtwThread,
  deleteSession,
  finishSessionNavigation,
  openBtwThread,
  setBtwDraft,
  setBtwSelectedTextSnippets,
  setConfig,
  setCurrentSession,
  setCurrentSessionId,
  setSessions,
  settleBtwEntry,
  updateCurrentSessionCodingOptimization,
  updateCurrentSessionModelOverride,
  updateMessageContent,
  updateSessionGoal,
  updateSessionStatus,
  updateSessionTitle,
  updateToolUseMediaStatus,
} from './coworkSlice';

const makeSession = (overrides: Partial<Parameters<typeof addSession>[0]> = {}) => ({
  id: 'session-1',
  title: 'Test Session',
  claudeSessionId: null,
  status: CoworkSessionStatusValue.Completed,
  pinned: false,
  cwd: '/tmp',
  systemPrompt: '',
  modelOverride: '',
  executionMode: 'local' as const,
  activeSkillIds: [],
  agentId: 'main',
  messages: [],
  messagesOffset: 0,
  totalMessages: 0,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const makeSelectedTextSnippet = (
  id: string,
  text: string,
): CoworkSelectedTextSnippet => ({
  id,
  text,
  sourceMessageId: `message-${id}`,
  sourceMessageType: CoworkSelectedTextSource.AssistantMessage,
  sourceId: `message-${id}`,
  sourceType: CoworkSelectedTextSource.AssistantMessage,
  createdAt: 1,
});

test('defaults hidden OpenClaw session policy to thirty days', () => {
  const state = coworkReducer(undefined, { type: 'init' });

  expect(state.config.openClawSessionPolicy).toEqual({
    keepAlive: '30d',
  });
  expect(state.config.skipMissedJobs).toBe(true);
  expect(state.config.openClawHeartbeatEnabled).toBe(true);
});

test('keeps a cross-agent session presentation target until the session loads', () => {
  const activeState = coworkReducer(undefined, setCurrentSession(makeSession()));
  const navigatingState = coworkReducer(
    activeState,
    clearCurrentSession({ sessionNavigationTargetId: 'session-2' }),
  );

  expect(navigatingState.currentSession).toBeNull();
  expect(navigatingState.currentSessionId).toBeNull();
  expect(navigatingState.sessionNavigationTargetId).toBe('session-2');

  const loadedState = coworkReducer(
    navigatingState,
    setCurrentSession(makeSession({ id: 'session-2' })),
  );
  expect(loadedState.sessionNavigationTargetId).toBeNull();
});

test('only finishes the matching cross-agent session navigation', () => {
  const navigatingState = coworkReducer(
    undefined,
    clearCurrentSession({ sessionNavigationTargetId: 'session-2' }),
  );
  const staleCompletionState = coworkReducer(
    navigatingState,
    finishSessionNavigation('session-1'),
  );
  const completedState = coworkReducer(
    staleCompletionState,
    finishSessionNavigation('session-2'),
  );

  expect(staleCompletionState.sessionNavigationTargetId).toBe('session-2');
  expect(completedState.sessionNavigationTargetId).toBeNull();
});

test('setConfig preserves loaded OpenClaw session policy', () => {
  const state = coworkReducer(undefined, setConfig({
    workingDirectory: '/tmp',
    systemPrompt: '',
    executionMode: 'local',
    agentEngine: 'openclaw',
    memoryEnabled: true,
    memoryImplicitUpdateEnabled: true,
    memoryLlmJudgeEnabled: false,
    memoryGuardLevel: 'strict',
    memoryUserMemoriesMaxItems: 12,
    skipMissedJobs: false,
    openClawHeartbeatEnabled: false,
    embeddingEnabled: false,
    embeddingProvider: 'openai',
    embeddingModel: '',
    embeddingLocalModelPath: '',
    embeddingVectorWeight: 0.7,
    embeddingRemoteBaseUrl: '',
    embeddingRemoteApiKey: '',
    dreamingEnabled: false,
    dreamingFrequency: '0 3 * * *',
    dreamingModel: '',
    dreamingTimezone: '',
    openClawSessionPolicy: {
      keepAlive: '365d',
    },
  }));

  expect(state.config.openClawSessionPolicy.keepAlive).toBe('365d');
  expect(state.config.openClawHeartbeatEnabled).toBe(false);
});

test('updateCurrentSessionModelOverride only patches the active session', () => {
  const session = makeSession({ modelOverride: 'openai/gpt-5.4' });

  const activeState = coworkReducer(
    coworkReducer(undefined, addSession(session)),
    updateCurrentSessionModelOverride({
      sessionId: 'session-1',
      modelOverride: 'lobsterai-server/qwen3.6-plus-YoudaoInner',
    }),
  );

  expect(activeState.currentSession?.modelOverride).toBe('lobsterai-server/qwen3.6-plus-YoudaoInner');
  expect(activeState.currentSession?.updatedAt).toBe(1);

  const ignoredState = coworkReducer(
    activeState,
    updateCurrentSessionModelOverride({
      sessionId: 'session-2',
      modelOverride: 'moonshot/kimi-k2.6',
    }),
  );

  expect(ignoredState.currentSession?.modelOverride).toBe('lobsterai-server/qwen3.6-plus-YoudaoInner');
});

test('updateCurrentSessionCodingOptimization only patches the active session', () => {
  const activeState = coworkReducer(
    coworkReducer(undefined, addSession(makeSession({ codingOptimized: true }))),
    updateCurrentSessionCodingOptimization({
      sessionId: 'session-1',
      codingOptimized: false,
    }),
  );

  expect(activeState.currentSession?.codingOptimized).toBe(false);

  const ignoredState = coworkReducer(
    activeState,
    updateCurrentSessionCodingOptimization({
      sessionId: 'session-2',
      codingOptimized: true,
    }),
  );

  expect(ignoredState.currentSession?.codingOptimized).toBe(false);
});

test('updateSessionTitle preserves the session updated time', () => {
  const session = makeSession({ updatedAt: 1000 });
  const state = coworkReducer(
    coworkReducer(undefined, addSession(session)),
    updateSessionTitle({
      sessionId: 'session-1',
      title: 'Renamed task',
    }),
  );

  expect(state.sessions[0].title).toBe('Renamed task');
  expect(state.sessions[0].updatedAt).toBe(1000);
  expect(state.currentSession?.title).toBe('Renamed task');
  expect(state.currentSession?.updatedAt).toBe(1000);
});

test('updateSessionStatus only refreshes the session updated time on a real transition', () => {
  const initialState = coworkReducer(undefined, setSessions([{
    id: 'session-1',
    title: 'Running task',
    status: CoworkSessionStatusValue.Running,
    pinned: false,
    agentId: 'main',
    createdAt: 1,
    updatedAt: 1000,
  }]));

  const reassertedState = coworkReducer(
    initialState,
    updateSessionStatus({
      sessionId: 'session-1',
      status: CoworkSessionStatusValue.Running,
    }),
  );
  expect(reassertedState.sessions[0].updatedAt).toBe(1000);

  const beforeTransition = Date.now();
  const completedState = coworkReducer(
    reassertedState,
    updateSessionStatus({
      sessionId: 'session-1',
      status: CoworkSessionStatusValue.Completed,
    }),
  );
  expect(completedState.sessions[0].updatedAt).toBeGreaterThanOrEqual(beforeTransition);
});

test('addMessage refreshes the session updated time only for user messages', () => {
  const initialState = coworkReducer(undefined, addSession(makeSession({ updatedAt: 1000 })));

  const streamedState = coworkReducer(
    initialState,
    addMessage({
      sessionId: 'session-1',
      message: { id: 'assistant-1', type: 'assistant', content: 'streamed reply', timestamp: 2000 },
    }),
  );
  expect(streamedState.sessions[0].updatedAt).toBe(1000);
  expect(streamedState.currentSession?.updatedAt).toBe(1000);

  const userState = coworkReducer(
    streamedState,
    addMessage({
      sessionId: 'session-1',
      message: { id: 'user-1', type: 'user', content: 'follow up', timestamp: 3000 },
    }),
  );
  expect(userState.sessions[0].updatedAt).toBe(3000);
  expect(userState.currentSession?.updatedAt).toBe(3000);
});

test('updateMessageContent preserves the session updated time', () => {
  const session = makeSession({
    updatedAt: 1000,
    messages: [{ id: 'assistant-1', type: 'assistant' as const, content: '', timestamp: 900 }],
    totalMessages: 1,
  });
  const state = coworkReducer(
    coworkReducer(undefined, addSession(session)),
    updateMessageContent({
      sessionId: 'session-1',
      messageId: 'assistant-1',
      content: 'streamed delta',
    }),
  );

  expect(state.sessions[0].updatedAt).toBe(1000);
  expect(state.currentSession?.updatedAt).toBe(1000);
  expect(state.currentSession?.messages[0]?.content).toBe('streamed delta');
});

test('addSession preserves the agent id in session summaries', () => {
  const state = coworkReducer(undefined, addSession(makeSession({
    id: 'session-agent-2',
    agentId: 'agent-2',
  })));

  expect(state.sessions[0].agentId).toBe('agent-2');
});

test('updateSessionGoal updates the current session and session summary', () => {
  const session = makeSession({ updatedAt: 1234 });
  const goal = {
    id: 'goal-1',
    objective: 'Ship goal mode',
    status: 'active' as const,
    createdAt: 100,
    updatedAt: 100,
    tokensUsed: 0,
  };

  const state = coworkReducer(
    coworkReducer(undefined, addSession(session)),
    updateSessionGoal({ sessionId: session.id, goal }),
  );

  expect(state.currentSession?.goal).toEqual(goal);
  expect(state.currentSession?.updatedAt).toBe(1234);
  expect(state.sessions[0].goal).toEqual(goal);
  expect(state.sessions[0].updatedAt).toBe(1234);

  const cleared = coworkReducer(
    state,
    updateSessionGoal({ sessionId: session.id, goal: null }),
  );

  expect(cleared.currentSession?.goal).toBeNull();
  expect(cleared.currentSession?.updatedAt).toBe(1234);
  expect(cleared.sessions[0].goal).toBeNull();
  expect(cleared.sessions[0].updatedAt).toBe(1234);
});

test('keeps editable BTW side-chat threads ephemeral and session-scoped', () => {
  const session = makeSession({ updatedAt: 1234 });
  const initial = coworkReducer(undefined, addSession(session));
  const firstSnippet = makeSelectedTextSnippet('selected-1', 'Selected assistant text');
  const opened = coworkReducer(initial, openBtwThread({
    sessionId: session.id,
    selectedTextSnippets: [firstSnippet],
  }));
  expect(opened.btwThreadsBySessionId[session.id]).toMatchObject({
    isOpen: true,
    draft: '',
    selectedTextSnippets: [firstSnippet],
    entries: [],
  });

  const editedBeforeClose = coworkReducer(opened, setBtwDraft({
    sessionId: session.id,
    draft: 'Unsent edited draft',
  }));
  const reopenedWithoutSelection = coworkReducer(
    coworkReducer(editedBeforeClose, closeBtwThread(session.id)),
    openBtwThread({ sessionId: session.id }),
  );
  expect(reopenedWithoutSelection.btwThreadsBySessionId[session.id]?.draft)
    .toBe('Unsent edited draft');
  expect(reopenedWithoutSelection.btwThreadsBySessionId[session.id]?.selectedTextSnippets)
    .toEqual([firstSnippet]);
  const secondSnippet = makeSelectedTextSnippet('selected-2', 'New selected text');
  const appendedFromSelection = coworkReducer(reopenedWithoutSelection, openBtwThread({
    sessionId: session.id,
    selectedTextSnippets: [firstSnippet, secondSnippet],
  }));
  expect(appendedFromSelection.btwThreadsBySessionId[session.id]?.draft)
    .toBe('Unsent edited draft');
  expect(appendedFromSelection.btwThreadsBySessionId[session.id]?.selectedTextSnippets)
    .toEqual([firstSnippet, secondSnippet]);

  const replacementSnippet = makeSelectedTextSnippet('selected-3', 'Fresh selected text');
  const reopenedFromSelection = coworkReducer(
    coworkReducer(appendedFromSelection, closeBtwThread(session.id)),
    openBtwThread({
      sessionId: session.id,
      selectedTextSnippets: [replacementSnippet],
    }),
  );
  expect(reopenedFromSelection.btwThreadsBySessionId[session.id]?.draft)
    .toBe('Unsent edited draft');
  expect(reopenedFromSelection.btwThreadsBySessionId[session.id]?.selectedTextSnippets)
    .toEqual([replacementSnippet]);

  const pending = coworkReducer(reopenedFromSelection, appendBtwEntry({
    runId: 'btw-1',
    sessionId: session.id,
    question: 'What changed?',
    selectedTextSnippets: [replacementSnippet],
    status: CoworkBtwStatus.Pending,
    createdAt: 10,
  }));

  expect(pending.btwThreadsBySessionId[session.id]?.entries[0]).toMatchObject({
    question: 'What changed?',
    selectedTextSnippets: [replacementSnippet],
    status: CoworkBtwStatus.Pending,
  });
  expect(pending.currentSession?.messages).toEqual([]);
  expect(pending.currentSession?.status).toBe(CoworkSessionStatusValue.Completed);
  expect(pending.currentSession?.updatedAt).toBe(1234);

  const stopped = coworkReducer(pending, settleBtwEntry({
    runId: 'btw-1',
    sessionId: session.id,
    question: 'Hidden contextual request',
    status: CoworkBtwStatus.Stopped,
    createdAt: 10,
    completedAt: 15,
  }));
  expect(stopped.btwThreadsBySessionId[session.id]?.entries[0]).toMatchObject({
    question: 'What changed?',
    status: CoworkBtwStatus.Stopped,
    completedAt: 15,
  });

  const answered = coworkReducer(pending, settleBtwEntry({
    runId: 'btw-1',
    sessionId: session.id,
    question: 'Hidden contextual request',
    status: CoworkBtwStatus.Answered,
    answer: '**Only docs.**',
    createdAt: 10,
    completedAt: 20,
  }));
  expect(answered.btwThreadsBySessionId[session.id]?.entries[0]).toMatchObject({
    question: 'What changed?',
    answer: '**Only docs.**',
  });

  const edited = coworkReducer(answered, setBtwDraft({
    sessionId: session.id,
    draft: 'Follow up',
  }));
  const editedWithSnippet = coworkReducer(edited, setBtwSelectedTextSnippets({
    sessionId: session.id,
    snippets: [firstSnippet],
  }));
  const preservedAfterStaleClear = coworkReducer(
    editedWithSnippet,
    clearBtwComposerIfUnchanged({
      sessionId: session.id,
      expectedDraft: 'Follow up',
      expectedSelectedTextSnippetIds: [replacementSnippet.id],
    }),
  );
  expect(preservedAfterStaleClear.btwThreadsBySessionId[session.id]).toMatchObject({
    draft: 'Follow up',
    selectedTextSnippets: [firstSnippet],
  });
  const cleared = coworkReducer(preservedAfterStaleClear, clearBtwComposerIfUnchanged({
    sessionId: session.id,
    expectedDraft: 'Follow up',
    expectedSelectedTextSnippetIds: [firstSnippet.id],
  }));
  const closed = coworkReducer(cleared, closeBtwThread(session.id));
  const switchedAway = coworkReducer(closed, clearCurrentSession());
  expect(switchedAway.btwThreadsBySessionId[session.id]).toMatchObject({
    isOpen: false,
    draft: '',
    selectedTextSnippets: [],
  });
  expect(switchedAway.btwThreadsBySessionId[session.id]?.entries[0].answer)
    .toBe('**Only docs.**');
});

test('clears BTW side-question state when its session is deleted', () => {
  const session = makeSession();
  const withBtw = coworkReducer(
    coworkReducer(undefined, addSession(session)),
    appendBtwEntry({
      runId: 'btw-1',
      sessionId: session.id,
      question: 'Question',
      status: CoworkBtwStatus.Failed,
      error: 'Failed',
      createdAt: 10,
      completedAt: 20,
    }),
  );

  const deleted = coworkReducer(withBtw, deleteSession(session.id));
  expect(deleted.btwThreadsBySessionId[session.id]).toBeUndefined();
});

test('bounds side-chat entries without evicting a pending request', () => {
  let state = coworkReducer(undefined, addSession(makeSession()));
  state = coworkReducer(state, appendBtwEntry({
    runId: 'btw-pending',
    sessionId: 'session-1',
    question: 'Pending question',
    status: CoworkBtwStatus.Pending,
    createdAt: 0,
  }));

  for (let index = 1; index <= COWORK_BTW_THREAD_ENTRY_LIMIT; index += 1) {
    state = coworkReducer(state, appendBtwEntry({
      runId: `btw-${index}`,
      sessionId: 'session-1',
      question: `Question ${index}`,
      status: CoworkBtwStatus.Pending,
      createdAt: index,
    }));
    state = coworkReducer(state, settleBtwEntry({
      runId: `btw-${index}`,
      sessionId: 'session-1',
      question: `Wire question ${index}`,
      status: CoworkBtwStatus.Answered,
      answer: `Answer ${index}`,
      createdAt: index,
      completedAt: index,
    }));
  }

  const entries = state.btwThreadsBySessionId['session-1'].entries;
  expect(entries).toHaveLength(COWORK_BTW_THREAD_ENTRY_LIMIT);
  expect(entries[0].runId).toBe('btw-pending');
  expect(entries[0].status).toBe(CoworkBtwStatus.Pending);
  expect(entries.some(entry => entry.runId === 'btw-1')).toBe(false);
});

test('bounds closed ephemeral BTW threads across sessions', () => {
  const sessions = Array.from(
    { length: COWORK_BTW_EPHEMERAL_THREAD_LIMIT + 1 },
    (_, index) => makeSession({ id: `session-${index}` }),
  );
  let state = coworkReducer(undefined, setSessions(sessions));
  for (const session of sessions) {
    state = coworkReducer(state, openBtwThread({ sessionId: session.id }));
    state = coworkReducer(state, closeBtwThread(session.id));
  }

  expect(Object.keys(state.btwThreadsBySessionId))
    .toHaveLength(COWORK_BTW_EPHEMERAL_THREAD_LIMIT);
  expect(state.btwThreadsBySessionId['session-0']).toBeUndefined();
  expect(state.btwThreadsBySessionId[`session-${COWORK_BTW_EPHEMERAL_THREAD_LIMIT}`])
    .toBeDefined();
});

test('prunes excess ephemeral threads as pending requests settle', () => {
  const sessions = Array.from(
    { length: COWORK_BTW_EPHEMERAL_THREAD_LIMIT + 2 },
    (_, index) => makeSession({ id: `session-${index}` }),
  );
  let state = coworkReducer(undefined, setSessions(sessions));
  for (const [index, session] of sessions.entries()) {
    state = coworkReducer(state, appendBtwEntry({
      runId: `btw-${index}`,
      sessionId: session.id,
      question: `Question ${index}`,
      status: CoworkBtwStatus.Pending,
      createdAt: index,
    }));
  }
  expect(Object.keys(state.btwThreadsBySessionId)).toHaveLength(sessions.length);

  for (const [index, session] of sessions.entries()) {
    state = coworkReducer(state, settleBtwEntry({
      runId: `btw-${index}`,
      sessionId: session.id,
      question: `Wire question ${index}`,
      status: CoworkBtwStatus.Answered,
      answer: `Answer ${index}`,
      createdAt: index,
      completedAt: index + 1,
    }));
  }

  expect(Object.keys(state.btwThreadsBySessionId))
    .toHaveLength(COWORK_BTW_EPHEMERAL_THREAD_LIMIT);
  expect(state.btwThreadsBySessionId[`session-${sessions.length - 1}`])
    .toBeDefined();
});

test('keeps side-chat drafts intact and bounds older completed entries in renderer memory', () => {
  let state = coworkReducer(undefined, addSession(makeSession()));
  const largeDraft = 'x'.repeat(40_000);
  state = coworkReducer(state, openBtwThread({
    sessionId: 'session-1',
    prefill: largeDraft,
  }));
  expect(state.btwThreadsBySessionId['session-1'].draft).toBe(largeDraft);

  for (let index = 0; index < 5; index += 1) {
    state = coworkReducer(state, appendBtwEntry({
      runId: `large-${index}`,
      sessionId: 'session-1',
      question: `Question ${index}`,
      status: CoworkBtwStatus.Pending,
      createdAt: index,
    }));
    state = coworkReducer(state, settleBtwEntry({
      runId: `large-${index}`,
      sessionId: 'session-1',
      question: `Wire ${index}`,
      status: CoworkBtwStatus.Answered,
      answer: 'a'.repeat(120_000),
      createdAt: index,
      completedAt: index + 1,
    }));
  }

  const contentChars = state.btwThreadsBySessionId['session-1'].entries.reduce(
    (total, entry) => total + entry.question.length + (entry.answer?.length ?? 0),
    0,
  );
  expect(contentChars).toBeLessThanOrEqual(COWORK_BTW_THREAD_CONTENT_MAX_CHARS);
  expect(state.btwThreadsBySessionId['session-1'].entries.length).toBeLessThan(5);

  const oversizedLatestQuestion = 'q'.repeat(COWORK_BTW_THREAD_CONTENT_MAX_CHARS + 1);
  state = coworkReducer(state, appendBtwEntry({
    runId: 'oversized-latest',
    sessionId: 'session-1',
    question: oversizedLatestQuestion,
    status: CoworkBtwStatus.Pending,
    createdAt: 10,
  }));
  state = coworkReducer(state, settleBtwEntry({
    runId: 'oversized-latest',
    sessionId: 'session-1',
    question: 'Wire oversized latest',
    status: CoworkBtwStatus.Answered,
    answer: 'Latest answer',
    createdAt: 10,
    completedAt: 11,
  }));
  expect(state.btwThreadsBySessionId['session-1'].entries).toHaveLength(1);
  expect(state.btwThreadsBySessionId['session-1'].entries[0].question)
    .toBe(oversizedLatestQuestion);
});

test('setCurrentSession preserves the agent id when inserting a summary', () => {
  const state = coworkReducer(undefined, setCurrentSession(makeSession({
    id: 'session-agent-3',
    agentId: 'agent-3',
  })));

  expect(state.sessions[0].agentId).toBe('agent-3');
});

test('updateSessionStatus marks completed inactive sessions unread', () => {
  const state = coworkReducer(undefined, setSessions([{
    id: 'session-1',
    title: 'Completed task',
    status: CoworkSessionStatusValue.Running,
    pinned: false,
    agentId: 'main',
    createdAt: 1,
    updatedAt: 1,
  }]));

  const completedState = coworkReducer(
    state,
    updateSessionStatus({
      sessionId: 'session-1',
      status: CoworkSessionStatusValue.Completed,
    }),
  );

  expect(completedState.unreadSessionIds).toEqual(['session-1']);
});

test('updateSessionStatus does not mark the active completed session unread', () => {
  const state = coworkReducer(
    coworkReducer(undefined, setSessions([{
      id: 'session-1',
      title: 'Active task',
      status: CoworkSessionStatusValue.Running,
      pinned: false,
      agentId: 'main',
      createdAt: 1,
      updatedAt: 1,
    }])),
    setCurrentSessionId('session-1'),
  );

  const completedState = coworkReducer(
    state,
    updateSessionStatus({
      sessionId: 'session-1',
      status: CoworkSessionStatusValue.Completed,
    }),
  );

  expect(completedState.unreadSessionIds).toEqual([]);
});

test('updateToolUseMediaStatus preserves the highest media poll count', () => {
  const state = coworkReducer(undefined, setCurrentSession(makeSession({
    messages: [{
      id: 'tool-1',
      type: 'tool_use',
      content: 'Using tool: lobsterai_video_generate',
      timestamp: 1,
      metadata: {
        toolName: 'lobsterai_video_generate',
        toolUseId: 'call-1',
        toolInput: { action: 'status', taskId: 'task-1' },
      },
    }],
    totalMessages: 1,
  })));

  const highCountState = coworkReducer(state, updateToolUseMediaStatus({
    sessionId: 'session-1',
    toolCallId: 'call-1',
    details: { taskId: 'task-1', pollCount: 12 },
  }));
  const staleCountState = coworkReducer(highCountState, updateToolUseMediaStatus({
    sessionId: 'session-1',
    toolCallId: 'call-1',
    details: { taskId: 'task-1', pollCount: 1 },
  }));

  expect(staleCountState.currentSession?.messages[0].metadata?.mediaStatusDetails).toMatchObject({
    taskId: 'task-1',
    pollCount: 12,
  });
});

test('updateToolUseMediaStatus drops single media poll counts', () => {
  const state = coworkReducer(undefined, setCurrentSession(makeSession({
    messages: [{
      id: 'tool-1',
      type: 'tool_use',
      content: 'Using tool: lobsterai_video_generate',
      timestamp: 1,
      metadata: {
        toolName: 'lobsterai_video_generate',
        toolUseId: 'call-1',
        toolInput: { action: 'status', taskId: 'task-1' },
      },
    }],
    totalMessages: 1,
  })));

  const nextState = coworkReducer(state, updateToolUseMediaStatus({
    sessionId: 'session-1',
    toolCallId: 'call-1',
    details: { taskId: 'task-1', pollCount: 1 },
  }));

  expect(nextState.currentSession?.messages[0].metadata?.mediaStatusDetails).toEqual({
    taskId: 'task-1',
  });
});

test('updateMessageContent preserves the highest media tool result poll count', () => {
  const state = coworkReducer(undefined, setCurrentSession(makeSession({
    messages: [{
      id: 'result-1',
      type: 'tool_result',
      content: 'Task ID: task-1\nStatus: processing',
      timestamp: 1,
      metadata: {
        toolUseId: 'call-1',
        toolResultDetails: { taskId: 'task-1', pollCount: 12, status: 'processing' },
      },
    }],
    totalMessages: 1,
  })));

  const staleCountState = coworkReducer(state, updateMessageContent({
    sessionId: 'session-1',
    messageId: 'result-1',
    content: 'Task ID: task-1\nStatus: processing',
    metadata: {
      toolUseId: 'call-1',
      toolResultDetails: { taskId: 'task-1', pollCount: 1, status: 'processing' },
    },
  }));

  expect(staleCountState.currentSession?.messages[0].metadata?.toolResultDetails).toMatchObject({
    taskId: 'task-1',
    pollCount: 12,
    status: 'processing',
  });
});

test('updateMessageContent drops single media tool result poll counts', () => {
  const state = coworkReducer(undefined, setCurrentSession(makeSession({
    messages: [{
      id: 'result-1',
      type: 'tool_result',
      content: 'Task ID: task-1\nStatus: processing',
      timestamp: 1,
      metadata: {
        toolUseId: 'call-1',
      },
    }],
    totalMessages: 1,
  })));

  const nextState = coworkReducer(state, updateMessageContent({
    sessionId: 'session-1',
    messageId: 'result-1',
    content: 'Task ID: task-1\nStatus: processing',
    metadata: {
      toolUseId: 'call-1',
      toolResultDetails: { taskId: 'task-1', pollCount: 1, status: 'processing' },
    },
  }));

  expect(nextState.currentSession?.messages[0].metadata?.toolResultDetails).toEqual({
    taskId: 'task-1',
    status: 'processing',
  });
});

test('pending media status updates are applied when the tool use arrives', () => {
  const baseState = coworkReducer(undefined, setCurrentSession(makeSession()));
  const pendingState = coworkReducer(baseState, updateToolUseMediaStatus({
    sessionId: 'session-1',
    toolCallId: 'call-1',
    details: { taskId: 'task-1', pollCount: 7 },
  }));

  const state = coworkReducer(pendingState, addMessage({
    sessionId: 'session-1',
    message: {
      id: 'tool-1',
      type: 'tool_use',
      content: 'Using tool: lobsterai_video_generate',
      timestamp: 2,
      metadata: {
        toolName: 'lobsterai_video_generate',
        toolUseId: 'call-1',
        toolInput: { action: 'status', taskId: 'task-1' },
      },
    },
  }));

  expect(state.currentSession?.messages[0].metadata?.mediaStatusDetails).toMatchObject({
    taskId: 'task-1',
    pollCount: 7,
  });
});

test('inactive media status updates are applied when returning to the session', () => {
  const baseState = coworkReducer(undefined, setCurrentSession(makeSession({
    id: 'session-2',
    title: 'Other Session',
  })));

  const pendingState = coworkReducer(baseState, updateToolUseMediaStatus({
    sessionId: 'session-1',
    toolCallId: 'call-1',
    details: { taskId: 'task-1', pollCount: 9 },
  }));

  const state = coworkReducer(pendingState, setCurrentSession(makeSession({
    messages: [{
      id: 'tool-1',
      type: 'tool_use',
      content: 'Using tool: lobsterai_video_generate',
      timestamp: 2,
      metadata: {
        toolName: 'lobsterai_video_generate',
        toolUseId: 'call-1',
        toolInput: { action: 'status', taskId: 'task-1' },
      },
    }],
    totalMessages: 1,
  })));

  expect(state.currentSession?.messages[0].metadata?.mediaStatusDetails).toMatchObject({
    taskId: 'task-1',
    pollCount: 9,
  });
});

test('retained media poll counts survive switching away and back', () => {
  const activeState = coworkReducer(undefined, setCurrentSession(makeSession({
    messages: [{
      id: 'tool-1',
      type: 'tool_use',
      content: 'Using tool: lobsterai_video_generate',
      timestamp: 1,
      metadata: {
        toolName: 'lobsterai_video_generate',
        toolUseId: 'call-1',
        toolInput: { action: 'status', taskId: 'task-1' },
      },
    }],
    totalMessages: 1,
  })));

  const countedState = coworkReducer(activeState, updateToolUseMediaStatus({
    sessionId: 'session-1',
    toolCallId: 'call-1',
    details: { taskId: 'task-1', pollCount: 12 },
  }));
  const otherSessionState = coworkReducer(countedState, setCurrentSession(makeSession({
    id: 'session-2',
    title: 'Other Session',
  })));
  const returnedState = coworkReducer(otherSessionState, setCurrentSession(makeSession({
    messages: [{
      id: 'tool-1-reloaded',
      type: 'tool_use',
      content: 'Using tool: lobsterai_video_generate',
      timestamp: 3,
      metadata: {
        toolName: 'lobsterai_video_generate',
        toolUseId: 'call-1',
        toolInput: { action: 'status', taskId: 'task-1' },
      },
    }],
    totalMessages: 1,
  })));

  expect(returnedState.currentSession?.messages[0].metadata?.mediaStatusDetails).toMatchObject({
    taskId: 'task-1',
    pollCount: 12,
  });
});
