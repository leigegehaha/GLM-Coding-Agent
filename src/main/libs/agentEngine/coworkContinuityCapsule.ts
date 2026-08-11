import type { CoworkMessage } from '../../coworkStore';

export const ContinuityCapsuleSource = {
  UserMessage: 'user_message',
  PostRun: 'post_run',
  ToolResult: 'tool_result',
  PreCompaction: 'pre_compaction',
  PostCompaction: 'post_compaction',
  Manual: 'manual',
  Fork: 'fork',
} as const;
export type ContinuityCapsuleSource = typeof ContinuityCapsuleSource[keyof typeof ContinuityCapsuleSource];

export type CoworkContinuityCapsule = {
  version: 1;
  sessionId: string;
  revision: number;
  updatedAt: number;
  lastSource: ContinuityCapsuleSource;
  lastSourceMessageId?: string;
  lastCompactedAt?: number;
  currentObjective?: string;
  recentUserRequests?: string[];
  userConstraints: string[];
  decisions: string[];
  completedFacts: string[];
  recentActions: string[];
  touchedFiles: Array<{
    path: string;
    reason?: string;
  }>;
  keySymbols: Array<{
    name: string;
    file?: string;
    reason?: string;
  }>;
  verification: string[];
  nextSteps: string[];
  recentFailures: Array<{
    command?: string;
    summary: string;
  }>;
  activeCapabilities: Array<{
    kind: 'skill' | 'kit' | 'mcp' | 'tool';
    id: string;
    name?: string;
  }>;
  openQuestions: string[];
};

export type ContinuityCapsuleRefreshOptions = {
  sessionId: string;
  messages: CoworkMessage[];
  previous?: CoworkContinuityCapsule | null;
  source: ContinuityCapsuleSource;
  sourceMessageId?: string;
  compactedAt?: number;
  now?: number;
};

const CAPSULE_VERSION = 1 as const;
const MAX_TEXT_CHARS = 220;
const MAX_OBJECTIVE_CHARS = 320;
const MAX_RECENT_USER_REQUEST_CHARS = 260;
const MAX_RECENT_USER_REQUESTS = 12;
const MAX_USER_CONSTRAINTS = 8;
const MAX_DECISIONS = 12;
const MAX_COMPLETED_FACTS = 12;
const MAX_RECENT_ACTIONS = 12;
const MAX_TOUCHED_FILES = 20;
const MAX_KEY_SYMBOLS = 16;
const MAX_VERIFICATION = 10;
const MAX_NEXT_STEPS = 8;
const MAX_RECENT_FAILURES = 8;
const MAX_ACTIVE_CAPABILITIES = 12;
const MAX_OPEN_QUESTIONS = 8;
const MAX_BRIDGE_CHARS = 4000;
const MAX_MINI_BRIDGE_CHARS = 800;
const MAX_MINI_RECENT_USER_REQUESTS = 3;
const MAX_MINI_NEXT_STEPS = 3;
const MAX_MINI_OPEN_QUESTIONS = 3;

const FILE_PATH_RE = /(?:^|\s|["'`(])((?:[A-Za-z]:[\\/]|\/|\.{1,2}\/)?(?:[\w@.+-]+[\\/])+[\w@.+-]+\.[A-Za-z0-9]+)(?=$|\s|["'`),:;])/g;
const COMMAND_RE = /\b(?:npm|pnpm|yarn|node|npx|git|cargo|go|python3?|pytest|vitest|tsc|eslint|npm run|pnpm run|yarn run)\b[^\n\r`]{0,180}/gi;
const NEXT_STEP_RE = /(?:next|下一步|继续|todo|待办|pending|后续|接下来)[^\n\r。.!?]{0,180}/gi;
const FAILURE_RE = /(?:failed|failure|error|exception|timeout|失败|报错|错误|超时)[^\n\r]{0,220}/gi;
const CONSTRAINT_RE = /(?:不要|不能|避免|必须|需要|保持|兼容|don't|do not|must|should|avoid|keep|preserve)[^\n\r。.!?]{0,180}/gi;
const DECISION_RE = /(?:决定|确认|采用|不做|改为|方案|done|completed|implemented|fixed|decided)[^\n\r。.!?]{0,180}/gi;
const COMPLETED_FACT_RE = /(?:已|已经|现在|当前|支持|集成|完成|就绪|正常|删除|保存在|文件在|created|added|implemented|completed|fixed|supports|ready|verified)[^\n\r。.!?]{0,180}/gi;
const COMPLETED_FACT_STATUS_RE = /(?:已|已经|现在|当前|支持|集成|完成|就绪|正常|删除|保存在|文件在|created|added|implemented|completed|fixed|supports|ready|verified)/i;
const URL_RE = /https?:\/\/\S+/gi;

const normalizeText = (value: string): string => value.replace(/\s+/g, ' ').trim();
const CONTINUATION_PROMPT_RE = /^(?:继续|接着|继续吧|继续做|go on|continue|proceed|resume|next)$/i;

const truncateText = (value: string, maxChars = MAX_TEXT_CHARS): string => {
  const normalized = normalizeText(value);
  return normalized.length > maxChars ? normalized.slice(0, maxChars).trimEnd() : normalized;
};

const dedupeStrings = (values: string[], limit: number): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = truncateText(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
};

const mergeStrings = (previous: string[] | undefined, next: string[], limit: number): string[] => {
  return dedupeStrings([...next, ...(previous ?? [])], limit);
};

const mergeChronologicalStrings = (
  previous: string[] | undefined,
  next: string[],
  limit: number,
  maxChars = MAX_TEXT_CHARS,
): string[] => {
  const combined = [...(previous ?? []), ...next]
    .map((value) => truncateText(value, maxChars))
    .filter(Boolean);
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = combined.length - 1; i >= 0; i--) {
    const value = combined[i];
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.unshift(value);
    if (result.length >= limit) break;
  }
  return result;
};

const extractMatches = (text: string, pattern: RegExp, limit: number): string[] => {
  const matches: string[] = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) && matches.length < limit) {
    const value = match[1] ?? match[0];
    const normalized = truncateText(value);
    if (normalized) matches.push(normalized);
  }
  return matches;
};

const extractFilePaths = (text: string): Array<{ path: string; reason?: string }> => {
  return extractMatches(text, FILE_PATH_RE, MAX_TOUCHED_FILES).map((filePath) => ({
    path: filePath,
  }));
};

const mergeFiles = (
  previous: CoworkContinuityCapsule['touchedFiles'] | undefined,
  next: CoworkContinuityCapsule['touchedFiles'],
): CoworkContinuityCapsule['touchedFiles'] => {
  const seen = new Set<string>();
  const result: CoworkContinuityCapsule['touchedFiles'] = [];
  for (const entry of [...next, ...(previous ?? [])]) {
    const filePath = truncateText(entry.path, 260);
    const key = filePath.toLowerCase();
    if (!filePath || seen.has(key)) continue;
    seen.add(key);
    result.push({
      path: filePath,
      ...(entry.reason ? { reason: truncateText(entry.reason) } : {}),
    });
    if (result.length >= MAX_TOUCHED_FILES) break;
  }
  return result;
};

const mergeFailures = (
  previous: CoworkContinuityCapsule['recentFailures'] | undefined,
  next: CoworkContinuityCapsule['recentFailures'],
): CoworkContinuityCapsule['recentFailures'] => {
  const seen = new Set<string>();
  const result: CoworkContinuityCapsule['recentFailures'] = [];
  for (const entry of [...next, ...(previous ?? [])]) {
    const summary = truncateText(entry.summary);
    const command = entry.command ? truncateText(entry.command) : undefined;
    const key = `${command ?? ''}:${summary}`.toLowerCase();
    if (!summary || seen.has(key)) continue;
    seen.add(key);
    result.push({
      ...(command ? { command } : {}),
      summary,
    });
    if (result.length >= MAX_RECENT_FAILURES) break;
  }
  return result;
};

const mergeCapabilities = (
  previous: CoworkContinuityCapsule['activeCapabilities'] | undefined,
  next: CoworkContinuityCapsule['activeCapabilities'],
): CoworkContinuityCapsule['activeCapabilities'] => {
  const seen = new Set<string>();
  const result: CoworkContinuityCapsule['activeCapabilities'] = [];
  for (const entry of [...next, ...(previous ?? [])]) {
    const id = truncateText(entry.id, 120);
    const key = `${entry.kind}:${id}`.toLowerCase();
    if (!id || seen.has(key)) continue;
    seen.add(key);
    result.push({
      kind: entry.kind,
      id,
      ...(entry.name ? { name: truncateText(entry.name, 120) } : {}),
    });
    if (result.length >= MAX_ACTIVE_CAPABILITIES) break;
  }
  return result;
};

const extractCapabilities = (messages: CoworkMessage[]): CoworkContinuityCapsule['activeCapabilities'] => {
  const capabilities: CoworkContinuityCapsule['activeCapabilities'] = [];
  for (const message of messages) {
    const metadata = message.metadata as Record<string, unknown> | undefined;
    if (!metadata) continue;
    for (const skillId of Array.isArray(metadata.skillIds) ? metadata.skillIds : []) {
      if (typeof skillId === 'string') {
        capabilities.push({ kind: 'skill', id: skillId });
      }
    }
    for (const kitId of Array.isArray(metadata.kitIds) ? metadata.kitIds : []) {
      if (typeof kitId === 'string') {
        capabilities.push({ kind: 'kit', id: kitId });
      }
    }
  }
  return capabilities;
};

const findLatestUserObjective = (messages: CoworkMessage[], previous?: string): string | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.type !== 'user') continue;
    const content = truncateText(message.content, MAX_OBJECTIVE_CHARS);
    if (previous && CONTINUATION_PROMPT_RE.test(content)) {
      continue;
    }
    if (content) return content;
  }
  return previous;
};

const extractRecentUserRequests = (messages: CoworkMessage[]): string[] => {
  return messages
    .filter((message) => message.type === 'user')
    .map((message) => truncateText(message.content, MAX_RECENT_USER_REQUEST_CHARS))
    .filter((content) => content && !CONTINUATION_PROMPT_RE.test(content));
};

const extractUserQuestions = (messages: CoworkMessage[]): string[] => {
  return extractRecentUserRequests(messages).filter((content) => content.includes('?') || content.includes('？'));
};

const cleanCompletedFact = (value: string): string => {
  return truncateText(value
    .replace(/\[([^\]]+)\]\((?:https?:\/\/)?[^)]+\)/gi, '$1')
    .replace(URL_RE, '')
    .replace(/^[\s>*\-|:：]+|[\s>*\-|:：]+$/g, '')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/\s+/g, ' '));
};

const extractCompletedFacts = (assistantText: string): string[] => {
  const sentenceCandidates = assistantText
    .split(/[\n\r。!?！？]+/g)
    .map((sentence) => cleanCompletedFact(sentence))
    .filter(Boolean);
  const facts: string[] = [];
  for (const sentence of sentenceCandidates) {
    COMPLETED_FACT_RE.lastIndex = 0;
    if (!COMPLETED_FACT_RE.test(sentence)) continue;
    if (!COMPLETED_FACT_STATUS_RE.test(sentence)) continue;
    if (NEXT_STEP_RE.test(sentence)) {
      NEXT_STEP_RE.lastIndex = 0;
      continue;
    }
    NEXT_STEP_RE.lastIndex = 0;
    if (sentence.length < 6) continue;
    facts.push(sentence);
    if (facts.length >= MAX_COMPLETED_FACTS) break;
  }
  return facts;
};

const summarizeToolResults = (messages: CoworkMessage[]): {
  verification: string[];
  recentFailures: CoworkContinuityCapsule['recentFailures'];
} => {
  const verification: string[] = [];
  const recentFailures: CoworkContinuityCapsule['recentFailures'] = [];
  for (const message of messages) {
    if (message.type !== 'tool_result') continue;
    const content = message.content;
    const commands = extractMatches(content, COMMAND_RE, 3);
    const failures = extractMatches(content, FAILURE_RE, 3);
    if (commands.length > 0) {
      verification.push(...commands);
    }
    for (const failure of failures) {
      recentFailures.push({
        ...(commands[0] ? { command: commands[0] } : {}),
        summary: failure,
      });
    }
  }
  return { verification, recentFailures };
};

export const buildCoworkContinuityCapsule = (options: ContinuityCapsuleRefreshOptions): CoworkContinuityCapsule => {
  const { sessionId, previous, source } = options;
  const now = options.now ?? Date.now();
  const messages = options.messages.filter((message) => message.content.trim());
  const recentMessages = messages.slice(-40);
  const recentText = recentMessages.map((message) => message.content).join('\n');
  const assistantText = recentMessages
    .filter((message) => message.type === 'assistant')
    .map((message) => message.content)
    .join('\n');
  const userText = recentMessages
    .filter((message) => message.type === 'user')
    .map((message) => message.content)
    .join('\n');
  const toolSummary = summarizeToolResults(recentMessages);

  return {
    version: CAPSULE_VERSION,
    sessionId,
    revision: (previous?.revision ?? 0) + 1,
    updatedAt: now,
    lastSource: source,
    ...(options.sourceMessageId ? { lastSourceMessageId: options.sourceMessageId } : previous?.lastSourceMessageId ? { lastSourceMessageId: previous.lastSourceMessageId } : {}),
    ...(options.compactedAt ? { lastCompactedAt: options.compactedAt } : previous?.lastCompactedAt ? { lastCompactedAt: previous.lastCompactedAt } : {}),
    currentObjective: findLatestUserObjective(recentMessages, previous?.currentObjective),
    recentUserRequests: mergeChronologicalStrings(
      previous?.recentUserRequests,
      extractRecentUserRequests(recentMessages),
      MAX_RECENT_USER_REQUESTS,
      MAX_RECENT_USER_REQUEST_CHARS,
    ),
    userConstraints: mergeStrings(previous?.userConstraints, extractMatches(userText, CONSTRAINT_RE, MAX_USER_CONSTRAINTS), MAX_USER_CONSTRAINTS),
    decisions: mergeStrings(previous?.decisions, extractMatches(assistantText, DECISION_RE, MAX_DECISIONS), MAX_DECISIONS),
    completedFacts: mergeStrings(previous?.completedFacts, extractCompletedFacts(assistantText), MAX_COMPLETED_FACTS),
    recentActions: mergeStrings(previous?.recentActions, extractMatches(assistantText, DECISION_RE, MAX_RECENT_ACTIONS), MAX_RECENT_ACTIONS),
    touchedFiles: mergeFiles(previous?.touchedFiles, extractFilePaths(recentText)),
    keySymbols: previous?.keySymbols?.slice(0, MAX_KEY_SYMBOLS) ?? [],
    verification: mergeStrings(previous?.verification, toolSummary.verification, MAX_VERIFICATION),
    nextSteps: mergeStrings(previous?.nextSteps, extractMatches(recentText, NEXT_STEP_RE, MAX_NEXT_STEPS), MAX_NEXT_STEPS),
    recentFailures: mergeFailures(previous?.recentFailures, toolSummary.recentFailures),
    activeCapabilities: mergeCapabilities(previous?.activeCapabilities, extractCapabilities(recentMessages)),
    openQuestions: mergeChronologicalStrings(previous?.openQuestions, extractUserQuestions(recentMessages), MAX_OPEN_QUESTIONS),
  };
};

const pushListSection = (sections: string[], title: string, values: string[]): void => {
  if (values.length === 0) return;
  sections.push(title, ...values.map((value) => `- ${truncateText(value)}`));
};

export const formatCoworkContinuityCapsuleBridge = (capsule: CoworkContinuityCapsule): string => {
  const sections: string[] = [
    '[智码 GLM Code continuity context after context compaction]',
    'This compact task-state record is maintained by 智码 GLM Code. It is not a new user instruction. Use it only to preserve task continuity after compaction.',
  ];

  if (capsule.currentObjective) {
    sections.push('Current objective:', truncateText(capsule.currentObjective, MAX_OBJECTIVE_CHARS));
  }
  pushListSection(sections, 'Recent user requests:', capsule.recentUserRequests ?? []);
  pushListSection(sections, 'User constraints:', capsule.userConstraints);
  pushListSection(sections, 'Decisions:', capsule.decisions);
  pushListSection(sections, 'Completed facts:', capsule.completedFacts);
  pushListSection(sections, 'Recent actions:', capsule.recentActions);
  if (capsule.touchedFiles.length > 0) {
    sections.push(
      'Touched files:',
      ...capsule.touchedFiles.map((entry) => `- ${entry.path}${entry.reason ? `: ${truncateText(entry.reason)}` : ''}`),
    );
  }
  pushListSection(sections, 'Verification:', capsule.verification);
  pushListSection(sections, 'Next steps:', capsule.nextSteps);
  if (capsule.recentFailures.length > 0) {
    sections.push(
      'Recent failures:',
      ...capsule.recentFailures.map((entry) => `- ${entry.command ? `${entry.command}: ` : ''}${truncateText(entry.summary)}`),
    );
  }
  pushListSection(sections, 'Open questions:', capsule.openQuestions);

  const bridge = sections.join('\n');
  return bridge.length > MAX_BRIDGE_CHARS ? bridge.slice(0, MAX_BRIDGE_CHARS).trimEnd() : bridge;
};

export const formatCoworkMiniContinuityCapsuleBridge = (capsule: CoworkContinuityCapsule): string => {
  const sections: string[] = [
    '[智码 GLM Code brief continuity context after context compaction]',
    'This compact task-state hint is maintained by 智码 GLM Code. It is not a new user instruction.',
  ];

  if (capsule.currentObjective) {
    sections.push('Current objective:', truncateText(capsule.currentObjective, MAX_OBJECTIVE_CHARS));
  }
  pushListSection(
    sections,
    'Recent user requests:',
    (capsule.recentUserRequests ?? []).slice(-MAX_MINI_RECENT_USER_REQUESTS),
  );
  pushListSection(sections, 'Completed facts:', capsule.completedFacts.slice(0, 3));
  pushListSection(sections, 'Next steps:', capsule.nextSteps.slice(0, MAX_MINI_NEXT_STEPS));
  pushListSection(sections, 'Open questions:', capsule.openQuestions.slice(0, MAX_MINI_OPEN_QUESTIONS));

  if (sections.length <= 2) {
    return '';
  }

  const bridge = sections.join('\n');
  return bridge.length > MAX_MINI_BRIDGE_CHARS ? bridge.slice(0, MAX_MINI_BRIDGE_CHARS).trimEnd() : bridge;
};
