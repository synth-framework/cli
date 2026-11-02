import { SynthError, usageError } from './errors.js';
import { upgradeRecord } from './evolution.js';
import { fileFreshness, type Freshness } from './fingerprint.js';
import {
  assessmentView, compareBaselines, currentIntention, projectEntry, revisionIdAt, validateBaseline,
  type Baseline, type BaselineComparison, type CheckContext, type DriftAssessment, type DriftAssessmentView,
  type EvaluationContext, type EvidenceContext, type ObservationCache, type RevisedEntry, type Revision,
} from './baseline.js';
import { validateVerification, type Check, type CheckView, type CriterionContextView, type Evidence, type EvidenceView, type Evaluation, type EvaluationView, type Verdict } from './verification.js';

export const KIND_PREFIX = {
  outcome: 'O',
  scope: 'S',
  constraint: 'K',
  'non-goal': 'NG',
  criterion: 'C',
  verification: 'VR',
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

interface RecordBase {
  originalIntention: string;
  createdAt: string;
  entries: Entry[];
}

export interface WorkRecordV1 extends RecordBase {
  schemaVersion: 1;
}

export interface WorkRecordV2 extends RecordBase {
  schemaVersion: 2;
  checks: Check[];
  evidence: Evidence[];
  evaluations: Evaluation[];
}

export interface WorkRecordV3 extends RecordBase {
  schemaVersion: 3;
  checks: Check[];
  evidence: Evidence[];
  evaluations: Evaluation[];
  revisions: Revision[];
  baselines: Baseline[];
  driftAssessments: DriftAssessment[];
  checkContexts: CheckContext[];
  evidenceContexts: EvidenceContext[];
  evaluationContexts: EvaluationContext[];
}

export type WorkRecord = WorkRecordV1 | WorkRecordV2 | WorkRecordV3;

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
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3) {
    throw new SynthError(
      'UNSUPPORTED_SCHEMA',
      `Work record "${location}" has schema version ${String(value.schemaVersion)}; this CLI supports versions 1, 2, and 3. It was not changed.`,
      3,
    );
  }
  const recordKeys = value.schemaVersion === 1
    ? ['schemaVersion', 'originalIntention', 'createdAt', 'entries']
    : value.schemaVersion === 2
      ? ['schemaVersion', 'originalIntention', 'createdAt', 'entries', 'checks', 'evidence', 'evaluations']
      : ['schemaVersion', 'originalIntention', 'createdAt', 'entries', 'checks', 'evidence', 'evaluations', 'revisions', 'baselines', 'driftAssessments', 'checkContexts', 'evidenceContexts', 'evaluationContexts'];
  if (!hasOnlyKeys(value, recordKeys)) return corrupt('unrecognized record fields');
  if (!isNonblank(value.originalIntention)) return corrupt('missing original intention');
  if (!isTimestamp(value.createdAt)) return corrupt('invalid creation time');
  if (!Array.isArray(value.entries)) return corrupt('entries must be an array');

  const ids = new Set<string>();
  const questions = new Set<string>();
  const criteria = new Set<string>();
  const answerTargets: string[] = [];
  for (const item of value.entries) {
    if (!isObject(item)) return corrupt('an entry is not an object');
    if (!hasOnlyKeys(item, ['id', 'kind', 'text', 'reason', 'questionId', 'createdAt'])) {
      return corrupt('unrecognized entry fields');
    }
    if (!isKind(item.kind) || (value.schemaVersion !== 3 && item.kind === 'verification')) return corrupt('invalid entry kind');
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
    if (item.kind === 'criterion') criteria.add(item.id);
  }
  if (answerTargets.some((id) => !questions.has(id))) return corrupt('answer refers to a missing question');
  if (value.schemaVersion === 2 || value.schemaVersion === 3) validateVerification(value, criteria, corrupt);
  if (value.schemaVersion === 3) validateBaseline(value, corrupt);
  return value as unknown as WorkRecord;
}

export function newRecord(intention: unknown): WorkRecord {
  if (!isNonblank(intention)) throw usageError('Provide a non-empty intention with --intent.');
  return {
    schemaVersion: 3,
    originalIntention: intention,
    createdAt: new Date().toISOString(),
    entries: [],
    checks: [],
    evidence: [],
    evaluations: [],
    revisions: [],
    baselines: [],
    driftAssessments: [],
    checkContexts: [],
    evidenceContexts: [],
    evaluationContexts: [],
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
  return { record: { ...upgradeRecord(record), entries: [...record.entries, ...added] }, added };
}

export interface QuestionView extends Entry {
  state: 'unanswered' | 'response_recorded';
  answers: Entry[];
}

export interface CriterionView extends RevisedEntry {
  evaluation: Verdict;
  evaluationId: string | null;
  evaluationReason: string | null;
  evidenceIds: string[];
  freshness: Freshness;
  priorEvaluationIds: string[];
}

export interface Handoff {
  recordVersion: 1 | 2 | 3;
  originalIntention: string;
  currentIntention: string;
  intentionRevisionId: string | null;
  createdAt: string;
  outcomes: RevisedEntry[];
  scope: RevisedEntry[];
  constraints: RevisedEntry[];
  nonGoals: RevisedEntry[];
  criteria: CriterionView[];
  verification: RevisedEntry[];
  questions: QuestionView[];
  assumptions: Entry[];
  plan: Entry[];
  updates: Entry[];
  workReferences: Entry[];
  decisions: Entry[];
  gaps: Entry[];
  nextActions: Entry[];
  checks: CheckView[];
  evidence: EvidenceView[];
  evaluations: EvaluationView[];
  revisions: Revision[];
  baselines: Baseline[];
  baselineComparison: BaselineComparison | null;
  previousBaselineComparison: BaselineComparison | null;
  driftAssessments: DriftAssessmentView[];
  missingContext: string[];
  capabilities: {
    checks: 'available';
    evidence: 'available';
    evaluation: 'available';
    revisions: 'available';
    baselines: 'available';
    driftAssessment: 'available';
    acceptance: 'not_available';
    questionResolution: 'not_available';
    gapAndActionResolution: 'not_available';
    planAndDecisionSupersession: 'not_available';
  };
}

export function makeHandoff(record: WorkRecord): Handoff {
  // The virtual upgrade is never written during a read.
  const state = upgradeRecord(record);
  const select = (kind: EntryKind): Entry[] => state.entries.filter((entry) => entry.kind === kind);
  const revised = (kind: EntryKind): RevisedEntry[] => select(kind).map((entry) => projectEntry(entry, state.revisions));
  const outcomes = revised('outcome');
  const scope = revised('scope');
  const constraints = revised('constraint');
  const nonGoals = revised('non-goal');
  const verification = revised('verification');
  const criterionEntries = revised('criterion');
  const criterionContext = (criterionId: string, revisionCount: number): CriterionContextView => {
    const criterion = criterionEntries.find((item) => item.id === criterionId)!;
    const recordedRevisionId = revisionIdAt(state, criterionId, revisionCount);
    return {
      criterionId, recordedRevisionId, currentRevisionId: criterion.revisionId,
      state: !criterion.active ? 'inactive' : recordedRevisionId === criterion.revisionId ? 'current' : 'changed',
    };
  };
  const checks: CheckView[] = state.checks.map((item, index) => ({
    ...item,
    criterionContexts: item.criterionIds.map((id) => criterionContext(id, state.checkContexts[index]!.revisionCount)),
  }));
  const evaluations: EvaluationView[] = state.evaluations.map((item, index) => ({
    ...item,
    criterionContext: criterionContext(item.criterionId, state.evaluationContexts[index]!.revisionCount),
  }));
  const evidence: EvidenceView[] = state.evidence.map((item, index) => ({
    ...item,
    freshness: fileFreshness(item.subjectFile),
    evaluatedFor: [...new Set(evaluations.filter((evaluation) => evaluation.evidenceIds.includes(item.id)).map((evaluation) => evaluation.criterionId))],
    criterionContexts: item.criterionIds.map((id) => criterionContext(id, state.evidenceContexts[index]!.revisionCount)),
  }));
  const criteria: CriterionView[] = criterionEntries.map((entry) => {
    const matching = evaluations.filter((item) => item.criterionId === entry.id);
    const latest = matching.filter((item) => item.criterionContext.state === 'current').at(-1);
    const evidenceIds = latest?.evidenceIds ?? [];
    const freshnesses = evidenceIds.map((id) => evidence.find((item) => item.id === id)!.freshness);
    const freshness: Freshness = freshnesses.includes('changed') ? 'changed'
      : freshnesses.length > 0 && freshnesses.every((status) => status === 'matching') ? 'matching' : 'unknown';
    return {
      ...entry, evaluation: latest?.verdict ?? 'unverified', evaluationId: latest?.id ?? null,
      evaluationReason: latest?.rationale ?? null, evidenceIds, freshness,
      priorEvaluationIds: matching.filter((item) => item.criterionContext.state !== 'current').map((item) => item.id),
    };
  });
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
    ['outcomes', outcomes.filter((item) => item.active)],
    ['scope', scope.filter((item) => item.active)],
    ['constraints', constraints.filter((item) => item.active)],
    ['nonGoals', nonGoals.filter((item) => item.active)],
    ['criteria', criteria.filter((item) => item.active)],
    ['verification', verification.filter((item) => item.active)],
    ['questions', questions], ['assumptions', assumptions], ['plan', plan],
    ['updates', updates], ['workReferences', workReferences], ['decisions', decisions],
    ['gaps', gaps], ['nextActions', nextActions],
  ];
  const observations: ObservationCache = new Map();
  const latestBaseline = state.baselines.at(-1);
  const previousBaseline = state.baselines.at(-2);
  const baselineComparison = latestBaseline ? compareBaselines(state, latestBaseline.id, undefined, observations) : null;
  const previousBaselineComparison = latestBaseline && previousBaseline ? compareBaselines(state, previousBaseline.id, latestBaseline.id, observations) : null;
  const intention = currentIntention(state);
  return {
    recordVersion: record.schemaVersion,
    originalIntention: state.originalIntention,
    currentIntention: intention.text,
    intentionRevisionId: intention.revisionId,
    createdAt: state.createdAt,
    outcomes, scope, constraints, nonGoals, criteria, verification, questions, assumptions,
    plan, updates, workReferences, decisions, gaps, nextActions, checks, evidence, evaluations,
    revisions: state.revisions,
    baselines: state.baselines,
    baselineComparison,
    previousBaselineComparison,
    driftAssessments: state.driftAssessments.map((assessment) => assessmentView(state, assessment, observations)),
    missingContext: groups.filter(([, entries]) => entries.length === 0).map(([name]) => name),
    capabilities: {
      checks: 'available', evidence: 'available', evaluation: 'available',
      revisions: 'available', baselines: 'available', driftAssessment: 'available',
      acceptance: 'not_available', questionResolution: 'not_available', gapAndActionResolution: 'not_available',
      planAndDecisionSupersession: 'not_available',
    },
  };
}
