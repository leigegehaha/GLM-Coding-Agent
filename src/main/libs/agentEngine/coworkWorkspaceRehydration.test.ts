import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { expect, test } from 'vitest';

import { ContinuityCapsuleSource, type CoworkContinuityCapsule } from './coworkContinuityCapsule';
import {
  buildCoworkWorkspaceRehydrationBridge,
  type WorkspaceRehydrationCommandRunner,
} from './coworkWorkspaceRehydration';

const makeCapsule = (overrides: Partial<CoworkContinuityCapsule> = {}): CoworkContinuityCapsule => ({
  version: 1,
  sessionId: 'session-1',
  revision: 1,
  updatedAt: 100,
  lastSource: ContinuityCapsuleSource.PostCompaction,
  lastCompactedAt: 100,
  currentObjective: 'Improve context continuity.',
  recentUserRequests: ['继续优化压缩后的代码现场'],
  userConstraints: [],
  decisions: [],
  recentActions: [],
  touchedFiles: [{ path: 'src/main/libs/agentEngine/openclawRuntimeAdapter.ts' }],
  keySymbols: [],
  verification: ['npm test -- openclawRuntimeAdapter passed'],
  nextSteps: ['Inject a lightweight workspace state bridge.'],
  recentFailures: [{ command: 'npm test -- coworkWorkspaceRehydration', summary: 'No test existed yet.' }],
  activeCapabilities: [],
  openQuestions: [],
  ...overrides,
});

const makeTempWorkspace = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-workspace-'));

test('workspace rehydration bridge is skipped before compaction', async () => {
  const bridge = await buildCoworkWorkspaceRehydrationBridge({
    sessionId: 'session-1',
    cwd: makeTempWorkspace(),
    capsule: makeCapsule({ lastCompactedAt: undefined }),
  });

  expect(bridge).toBe('');
});

test('workspace rehydration bridge includes bounded capsule and git state', async () => {
  const workspace = makeTempWorkspace();
  const commandRunner: WorkspaceRehydrationCommandRunner = async (_command, args) => {
    const joinedArgs = args.join(' ');
    if (joinedArgs === 'status --short') {
      return 'M src/main/libs/agentEngine/openclawRuntimeAdapter.ts\n?? src/main/libs/agentEngine/coworkWorkspaceRehydration.ts\n';
    }
    if (joinedArgs === 'diff --stat') {
      return ' src/main/libs/agentEngine/openclawRuntimeAdapter.ts | 6 ++++++\n 1 file changed, 6 insertions(+)\n';
    }
    return '';
  };

  const bridge = await buildCoworkWorkspaceRehydrationBridge({
    sessionId: 'session-1',
    cwd: workspace,
    capsule: makeCapsule(),
    commandRunner,
  });

  expect(bridge).toContain('[智码 GLM Code workspace state after context compaction]');
  expect(bridge).toContain('Recently touched files:');
  expect(bridge).toContain('src/main/libs/agentEngine/openclawRuntimeAdapter.ts');
  expect(bridge).toContain('Git status:');
  expect(bridge).toContain('M src/main/libs/agentEngine/openclawRuntimeAdapter.ts');
  expect(bridge).toContain('Git diff stat:');
  expect(bridge.length).toBeLessThanOrEqual(1400);
});

test('workspace rehydration bridge skips invalid workspace but keeps capsule state', async () => {
  const bridge = await buildCoworkWorkspaceRehydrationBridge({
    sessionId: 'session-1',
    cwd: path.join(os.tmpdir(), 'missing-lobster-workspace'),
    capsule: makeCapsule(),
  });

  expect(bridge).toContain('Recently touched files:');
  expect(bridge).toContain('Recent verification:');
  expect(bridge).not.toContain('Git status:');
});

test('workspace rehydration bridge tolerates git command failures', async () => {
  const workspace = makeTempWorkspace();
  const commandRunner: WorkspaceRehydrationCommandRunner = async () => {
    throw new Error('git failed');
  };

  const bridge = await buildCoworkWorkspaceRehydrationBridge({
    sessionId: 'session-1',
    cwd: workspace,
    capsule: makeCapsule(),
    commandRunner,
  });

  expect(bridge).toContain('Recently touched files:');
  expect(bridge).not.toContain('Git status:');
  expect(bridge).not.toContain('Git diff stat:');
});
