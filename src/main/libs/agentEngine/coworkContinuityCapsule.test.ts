import { expect, test } from 'vitest';

import type { CoworkMessage } from '../../coworkStore';
import {
  buildCoworkContinuityCapsule,
  ContinuityCapsuleSource,
  formatCoworkContinuityCapsuleBridge,
  formatCoworkMiniContinuityCapsuleBridge,
} from './coworkContinuityCapsule';

const message = (
  type: CoworkMessage['type'],
  content: string,
  metadata?: CoworkMessage['metadata'],
): CoworkMessage => ({
  id: `${type}-${Math.random()}`,
  type,
  content,
  timestamp: 1,
  ...(metadata ? { metadata } : {}),
});

test('buildCoworkContinuityCapsule extracts task state from recent messages', () => {
  const capsule = buildCoworkContinuityCapsule({
    sessionId: 'session-1',
    source: ContinuityCapsuleSource.PostRun,
    now: 1000,
    messages: [
      message('user', '先写 spec，不要直接编码，必须兼容 mac/windows。目标是优化 context compaction。', {
        skillIds: ['docx'],
        kitIds: ['coding'],
      }),
      message('assistant', '决定采用 session 级 capsule 表。Next step: wire capsule bridge into buildOutboundPrompt. touched src/main/coworkStore.ts'),
      message('assistant', '已完成 continuity capsule bridge 注入，当前支持压缩后恢复任务状态。'),
      message('tool_result', 'npm test -- openclawRuntimeAdapter failed: expected summary length mismatch in src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts'),
    ],
  });

  expect(capsule.currentObjective).toContain('目标是优化 context compaction');
  expect(capsule.recentUserRequests).toEqual([
    '先写 spec，不要直接编码，必须兼容 mac/windows。目标是优化 context compaction。',
  ]);
  expect(capsule.userConstraints.join('\n')).toContain('不要直接编码');
  expect(capsule.decisions.join('\n')).toContain('session 级 capsule 表');
  expect(capsule.completedFacts.join('\n')).toContain('已完成 continuity capsule bridge 注入');
  expect(capsule.nextSteps.join('\n')).toContain('wire capsule bridge');
  expect(capsule.touchedFiles.map((entry) => entry.path)).toContain('src/main/coworkStore.ts');
  expect(capsule.touchedFiles.map((entry) => entry.path)).toContain('src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts');
  expect(capsule.recentFailures[0]?.summary).toContain('failed');
  expect(capsule.activeCapabilities).toEqual([
    { kind: 'skill', id: 'docx' },
    { kind: 'kit', id: 'coding' },
  ]);
});

test('buildCoworkContinuityCapsule merges with the previous capsule without unbounded growth', () => {
  const previous = buildCoworkContinuityCapsule({
    sessionId: 'session-1',
    source: ContinuityCapsuleSource.UserMessage,
    now: 1000,
    messages: [
      message('user', '不要切换用户模型。'),
      message('assistant', 'Next step: add store API.'),
    ],
  });

  const next = buildCoworkContinuityCapsule({
    sessionId: 'session-1',
    source: ContinuityCapsuleSource.PreCompaction,
    previous,
    now: 2000,
    compactedAt: 2000,
    messages: [
      message('user', '继续，必须不影响现有功能。'),
      message('assistant', 'Next step: add store API. Next step: inject capsule bridge.'),
    ],
  });

  expect(next.revision).toBe(previous.revision + 1);
  expect(next.lastCompactedAt).toBe(2000);
  expect(next.userConstraints.join('\n')).toContain('不要切换用户模型');
  expect(next.userConstraints.join('\n')).toContain('必须不影响现有功能');
  expect(next.nextSteps.filter((step) => step.includes('add store API'))).toHaveLength(1);
});

test('buildCoworkContinuityCapsule preserves recent user questions across compaction', () => {
  const previous = buildCoworkContinuityCapsule({
    sessionId: 'session-1',
    source: ContinuityCapsuleSource.UserMessage,
    now: 1000,
    messages: [
      message('user', '地球、月亮、太阳，三者什么关系？'),
      message('assistant', '月球绕地球公转，地球绕太阳公转。'),
      message('user', '他们是自然形成的么？'),
      message('assistant', '基本上是自然形成的，但月球的起源有些特殊。'),
      message('user', '感觉是人为的'),
      message('assistant', '这确实是一种很自然的感受。'),
    ],
  });

  const next = buildCoworkContinuityCapsule({
    sessionId: 'session-1',
    source: ContinuityCapsuleSource.PreCompaction,
    previous,
    now: 2000,
    compactedAt: 2000,
    messages: [
      message('user', '这也太巧妙了？难道不是人为的么？'),
      message('assistant', '科学上可以给每个巧合一个解释。'),
      message('user', '我之前都都问过你哪些问题来着？帮我精简总结下吧'),
    ],
  });

  expect(next.recentUserRequests).toEqual([
    '地球、月亮、太阳，三者什么关系？',
    '他们是自然形成的么？',
    '感觉是人为的',
    '这也太巧妙了？难道不是人为的么？',
    '我之前都都问过你哪些问题来着？帮我精简总结下吧',
  ]);
  expect(next.openQuestions).toEqual([
    '地球、月亮、太阳，三者什么关系？',
    '他们是自然形成的么？',
    '这也太巧妙了？难道不是人为的么？',
    '我之前都都问过你哪些问题来着？帮我精简总结下吧',
  ]);

  const bridge = formatCoworkContinuityCapsuleBridge(next);
  expect(bridge).toContain('Recent user requests:');
  expect(bridge).toContain('地球、月亮、太阳，三者什么关系？');
  expect(bridge).toContain('这也太巧妙了？难道不是人为的么？');
  expect(bridge).not.toContain('- ？难道不是人为的么');
});

test('buildCoworkContinuityCapsule preserves objective for short continuation prompts', () => {
  const previous = buildCoworkContinuityCapsule({
    sessionId: 'session-1',
    source: ContinuityCapsuleSource.UserMessage,
    now: 1000,
    messages: [
      message('user', '优化 智码 GLM Code context compaction 的连续性。'),
    ],
  });

  const next = buildCoworkContinuityCapsule({
    sessionId: 'session-1',
    source: ContinuityCapsuleSource.UserMessage,
    previous,
    now: 2000,
    messages: [
      message('user', '继续'),
    ],
  });

  expect(next.currentObjective).toBe(previous.currentObjective);
});

test('buildCoworkContinuityCapsule cleans completed facts before storing them', () => {
  const capsule = buildCoworkContinuityCapsule({
    sessionId: 'session-1',
    source: ContinuityCapsuleSource.PostRun,
    now: 1000,
    messages: [
      message('assistant', '韩语版已添加完成！现在访问 [http://127.0.0.1:8910](http://127.0.0.1:8910) 点按语言切换按钮即可体验 4 种语言。'),
      message('assistant', '**新增的日语支持：** | 项目 | 内容 | |------|------| | 字体 | Noto Sans JP |'),
    ],
  });

  const facts = capsule.completedFacts.join('\n');
  expect(facts).toContain('韩语版已添加完成');
  expect(facts).toContain('现在访问 点按语言切换按钮即可体验 4 种语言');
  expect(facts).toContain('新增的日语支持');
  expect(facts).not.toContain('http://127');
  expect(facts).not.toContain('|------|');
});

test('formatCoworkContinuityCapsuleBridge produces bounded hidden bridge text', () => {
  const capsule = buildCoworkContinuityCapsule({
    sessionId: 'session-1',
    source: ContinuityCapsuleSource.PostCompaction,
    now: 1000,
    messages: [
      message('user', '继续优化 context compaction。'),
      message('assistant', '决定保留 prompt 注入方式。已完成 capsule bridge 注入。Next step: run tests.'),
    ],
  });

  const bridge = formatCoworkContinuityCapsuleBridge(capsule);

  expect(bridge).toContain('[智码 GLM Code continuity context after context compaction]');
  expect(bridge).toContain('It is not a new user instruction');
  expect(bridge).toContain('Current objective:');
  expect(bridge).toContain('Recent user requests:');
  expect(bridge).toContain('Completed facts:');
  expect(bridge).toContain('Next steps:');
  expect(bridge.length).toBeLessThanOrEqual(4000);
});

test('formatCoworkMiniContinuityCapsuleBridge keeps only the compact follow-up fields', () => {
  const capsule = buildCoworkContinuityCapsule({
    sessionId: 'session-1',
    source: ContinuityCapsuleSource.PostCompaction,
    now: 1000,
    messages: [
      message('user', '继续优化 context compaction。'),
      message('assistant', '决定保留 prompt 注入方式。已完成 capsule bridge 注入。Next step: run tests. touched src/main/libs/agentEngine/openclawRuntimeAdapter.ts'),
    ],
  });

  const bridge = formatCoworkMiniContinuityCapsuleBridge({
    ...capsule,
    lastCompactedAt: 1000,
  });

  expect(bridge).toContain('[智码 GLM Code brief continuity context after context compaction]');
  expect(bridge).toContain('Current objective:');
  expect(bridge).toContain('Recent user requests:');
  expect(bridge).toContain('Completed facts:');
  expect(bridge).toContain('Next steps:');
  expect(bridge).not.toContain('Touched files:');
  expect(bridge).not.toContain('src/main/libs/agentEngine/openclawRuntimeAdapter.ts');
  expect(bridge.length).toBeLessThanOrEqual(800);
});
