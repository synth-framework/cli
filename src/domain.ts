import { SynthError, usageError } from './errors.js';

export const KIND_PREFIX = {
  outcome: 'O',
  scope: 'S',
  constraint: 'K',
  'non-goal': 'NG',
  criterion: 'C',
  question: 'Q',
  answer: 'ANS',
  assumption: 'A',
  plan: 'P',
  update: 'U',
  'work-ref': 'W',
  decision: 'D',
  gap: 'G',
  next: 'N',
} as const;

export type EntryKind = keyof typeof KIND_PREFIX;

export interface Entry {
  id: string;
  kind: EntryKind;
  text: string;
  reason: string | null;
  questionId: string | null;
  createdAt: string;
}

export interface WorkRecord {
  schemaVersion: 1;
  originalIntention: string;
  createdAt: string;
  entries: Entry[];
}

export interface EntryInput {
  kind: EntryKind;
  text: string;
  reason: string | null;
  questionId: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isKind(value: unknown): value is EntryKind {
  return typeof value === 'string' && Object.hasOwn(KIND_PREFIX, value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validId(id: unknown, kind: EntryKind): id is string {
  if (typeof id !== 'string') return false;
  const prefix = KIND_PREFIX[kind];
  if (!id.startsWith(prefix)) return false;
  const suffix = id.slice(prefix.length);
  return /^[1-9][0-9]*$/.test(suffix) && Number.isSafeInteger(Number(suffix));
}

/** Reject anything this version would not preserve on its next write. */
export function decodeRecord(bytes: Uint8Array, location: string): WorkRecord {
  const corrupt = (detail: string): never => {
    throw new SynthError(
      'RECORD_CORRUPT',
      `Work record "${location}" is invalid (${detail}). Inspect or restore it; SYNTH will not replace it with empty state.`,
      3,
    );
  };

  let text: string;
  try {
    // Keep a BOM visible to JSON.parse, matching the previous JSON policy.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return corrupt('invalid UTF-8');
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return corrupt('invalid JSON');
  }
  if (!isObject(value)) return corrupt('expected an object');
  if (!Number.isInteger(value.schemaVersion)) return corrupt('missing or invalid schemaVersion');
  if (value.schemaVersion !== 1) {
    throw new SynthError(
      'UNSUPPORTED_SCHEMA',
      `Work record "${location}" has schema version ${String(value.schemaVersion)}; this CLI supports version 1. It was not changed.`,
      3,
    );
  }
  if (!hasOnlyKeys(value, ['schemaVersion', 'originalIntention', 'createdAt', 'entries'])) {
    return corrupt('unrecognized record fields');
  }
  if (!isNonblank(value.originalIntention)) return corrupt('missing original intention');
  if (!isTimestamp(value.createdAt)) return corrupt('invalid creation time');
  if (!Array.isArray(value.entries)) return corrupt('entries must be an array');

  const ids = new Set<string>();
  const questions = new Set<string>();
  const answerTargets: string[] = [];
  for (const item of value.entries) {
    if (!isObject(item)) return corrupt('an entry is not an object');
    if (!hasOnlyKeys(item, ['id', 'kind', 'text', 'reason', 'questionId', 'createdAt'])) {
      return corrupt('unrecognized entry fields');
    }
    if (!isKind(item.kind)) return corrupt('invalid entry kind');
    if (!validId(item.id, item.kind) || ids.has(item.id)) return corrupt('invalid or duplicate entry ID');
    if (!isNonblank(item.text)) return corrupt('entry text is missing');
    if (item.reason !== null && !isNonblank(item.reason)) return corrupt('invalid entry reason');
    if (!isTimestamp(item.createdAt)) return corrupt('invalid entry time');
    if (item.kind === 'answer') {
      if (typeof item.questionId !== 'string') return corrupt('answer is missing its question ID');
      answerTargets.push(item.questionId);
    } else if (item.questionId !== null) {
      return corrupt('unexpected question ID');
    }
    ids.add(item.id);
    if (item.kind === 'question') questions.add(item.id);
  }
  if (answerTargets.some((id) => !questions.has(id))) return corrupt('answer refers to a missing question');
  return value as unknown as WorkRecord;
}

export function newRecord(intention: unknown): WorkRecord {
  if (!isNonblank(intention)) throw usageError('Provide a non-empty intention with --intent.');
  return {
    schemaVersion: 1,
    originalIntention: intention,
    createdAt: new Date().toISOString(),
    entries: [],
  };
}

export function parseEntryInput(value: unknown, label = 'entry'): EntryInput {
  if (!isObject(value)) throw usageError(`${label} must be a JSON object.`);
  if (!hasOnlyKeys(value, ['kind', 'text', 'reason', 'questionId'])) {
    throw usageError(`${label} contains an unsupported field. Allowed fields: kind, text, reason, questionId.`);
  }
  if (!isKind(value.kind)) {
    throw usageError(`${label} has an unknown kind. Run synth --help for the supported kinds.`);
  }
  if (!isNonblank(value.text)) throw usageError(`${label} needs non-empty text.`);
  if (value.reason !== undefined && value.reason !== null && !isNonblank(value.reason)) {
    throw usageError(`${label} reason must be non-empty text when provided.`);
  }
  if (value.kind === 'answer') {
    if (!isNonblank(value.questionId)) throw usageError(`${label} needs a questionId.`);
  } else if (value.questionId !== undefined && value.questionId !== null) {
    throw usageError(`${label} can have a questionId only when its kind is answer.`);
  }
  return {
    kind: value.kind,
    text: value.text,
    reason: (value.reason as string | null | undefined) ?? null,
    questionId: (value.questionId as string | null | undefined) ?? null,
  };
}

export function parseEntryBatch(value: unknown): EntryInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw usageError('Standard input must contain a non-empty JSON array of entries.');
  }
  if (value.length > 100) throw usageError('A single batch can contain at most 100 entries.');
  return value.map((item, index) => parseEntryInput(item, `Entry ${index + 1}`));
}

export function appendEntries(record: WorkRecord, inputs: EntryInput[]): { record: WorkRecord; added: Entry[] } {
  const numbers = new Map<EntryKind, number>();
  const questions = new Set<string>();
  for (const entry of record.entries) {
    const number = Number(entry.id.slice(KIND_PREFIX[entry.kind].length));
    numbers.set(entry.kind, Math.max(numbers.get(entry.kind) ?? 0, number));
    if (entry.kind === 'question') questions.add(entry.id);
  }

  const added: Entry[] = [];
  for (const input of inputs) {
    if (input.kind === 'answer' && (input.questionId === null || !questions.has(input.questionId))) {
      throw usageError(`Question ${input.questionId ?? '(missing)'} is not in this work record.`);
    }
    const number = (numbers.get(input.kind) ?? 0) + 1;
    if (!Number.isSafeInteger(number)) throw usageError(`No more IDs are available for ${input.kind}.`);
    const entry: Entry = {
      id: `${KIND_PREFIX[input.kind]}${number}`,
      kind: input.kind,
      text: input.text,
      reason: input.reason,
      questionId: input.questionId,
      createdAt: new Date().toISOString(),
    };
    numbers.set(input.kind, number);
    if (entry.kind === 'question') questions.add(entry.id);
    added.push(entry);
  }
  return { record: { ...record, entries: [...record.entries, ...added] }, added };
}

export interface QuestionView extends Entry {
  state: 'unanswered' | 'response_recorded';
  answers: Entry[];
}

export interface CriterionView extends Entry {
  evaluation: 'unverified';
}

export interface Handoff {
  recordVersion: 1;
  originalIntention: string;
  createdAt: string;
  outcomes: Entry[];
  scope: Entry[];
  constraints: Entry[];
  nonGoals: Entry[];
  criteria: CriterionView[];
  questions: QuestionView[];
  assumptions: Entry[];
  plan: Entry[];
  updates: Entry[];
  workReferences: Entry[];
  decisions: Entry[];
  gaps: Entry[];
  nextActions: Entry[];
  missingContext: string[];
  capabilities: {
    evidence: 'not_available';
    evaluation: 'not_available';
    acceptance: 'not_available';
    questionResolution: 'not_available';
    gapAndActionResolution: 'not_available';
    planAndDecisionSupersession: 'not_available';
  };
}

export function makeHandoff(record: WorkRecord): Handoff {
  const select = (kind: EntryKind): Entry[] => record.entries.filter((entry) => entry.kind === kind);
  const outcomes = select('outcome');
  const scope = select('scope');
  const constraints = select('constraint');
  const nonGoals = select('non-goal');
  const criteria: CriterionView[] = select('criterion').map((entry) => ({ ...entry, evaluation: 'unverified' }));
  const answers = select('answer');
  const questions: QuestionView[] = select('question').map((entry) => {
    const matching = answers.filter((answer) => answer.questionId === entry.id);
    return { ...entry, state: matching.length === 0 ? 'unanswered' : 'response_recorded', answers: matching };
  });
  const assumptions = select('assumption');
  const plan = select('plan');
  const updates = select('update');
  const workReferences = select('work-ref');
  const decisions = select('decision');
  const gaps = select('gap');
  const nextActions = select('next');
  const groups: [string, readonly unknown[]][] = [
    ['outcomes', outcomes],
    ['scope', scope],
    ['constraints', constraints],
    ['nonGoals', nonGoals],
    ['criteria', criteria],
    ['questions', questions],
    ['assumptions', assumptions],
    ['plan', plan],
    ['updates', updates],
    ['workReferences', workReferences],
    ['decisions', decisions],
    ['gaps', gaps],
    ['nextActions', nextActions],
  ];
  return {
    recordVersion: 1,
    originalIntention: record.originalIntention,
    createdAt: record.createdAt,
    outcomes,
    scope,
    constraints,
    nonGoals,
    criteria,
    questions,
    assumptions,
    plan,
    updates,
    workReferences,
    decisions,
    gaps,
    nextActions,
    missingContext: groups.filter(([, entries]) => entries.length === 0).map(([name]) => name),
    capabilities: {
      evidence: 'not_available',
      evaluation: 'not_available',
      acceptance: 'not_available',
      questionResolution: 'not_available',
      gapAndActionResolution: 'not_available',
      planAndDecisionSupersession: 'not_available',
    },
  };
}
