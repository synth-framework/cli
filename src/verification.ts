import { isAbsolute } from 'node:path';
import type { WorkRecord, WorkRecordV3 } from './domain.js';
import { upgradeRecord } from './evolution.js';
import { usageError } from './errors.js';
import { isFileSnapshot, type FileSnapshot, type Freshness } from './fingerprint.js';

export const OUTPUT_LIMIT_BYTES = 16 * 1024;
export const MAX_TIMEOUT_MS = 300_000;
export const DEFAULT_TIMEOUT_MS = 30_000;

export type DirtyState = 'clean' | 'dirty' | 'unknown';
export type CheckStatus = 'pending' | 'passed' | 'failed' | 'timed_out' | 'interrupted' | 'could_not_start' | 'skipped' | 'inconclusive';
export type Verdict = 'unverified' | 'supported' | 'contradicted' | 'inconclusive' | 'not_applicable';

export interface OutputStream {
  bytes: number;
  text: string | null;
  truncated: boolean;
}

export interface CheckOutput {
  captured: boolean;
  limitBytesPerStream: number;
  encoding: 'utf8-lossy';
  stdout: OutputStream;
  stderr: OutputStream;
}

export interface Check {
  id: string;
  invocation: 'run' | 'reported';
  status: CheckStatus;
  argv: string[];
  cwd: string;
  criterionIds: string[];
  requestedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  reason: string | null;
  revision: string | null;
  dirty: DirtyState;
  provenance: 'reported' | 'unknown';
  timeoutMs: number | null;
  captureOutput: boolean;
  outputRef: string | null;
  output: CheckOutput | null;
}

export interface Evidence {
  id: string;
  summary: string;
  source: string;
  subject: string;
  revision: string | null;
  artifact: string | null;
  limitations: string;
  criterionIds: string[];
  checkId: string | null;
  subjectFile: FileSnapshot | null;
  createdAt: string;
}

export interface Evaluation {
  id: string;
  criterionId: string;
  verdict: Verdict;
  rationale: string;
  evidenceIds: string[];
  createdAt: string;
}

export interface CheckView extends Check {
  criterionContexts: CriterionContextView[];
}

export interface CriterionContextView {
  criterionId: string;
  recordedRevisionId: string | null;
  currentRevisionId: string | null;
  state: 'current' | 'changed' | 'inactive';
}

export interface EvidenceView extends Evidence {
  freshness: Freshness;
  evaluatedFor: string[];
  criterionContexts: CriterionContextView[];
}

export interface EvaluationView extends Evaluation {
  criterionContext: CriterionContextView;
}

export interface CheckInput {
  argv: string[];
  cwd: string;
  criterionIds: string[];
  revision: string | null;
  dirty: DirtyState;
  provenance: 'reported' | 'unknown';
  timeoutMs: number | null;
  captureOutput: boolean;
  outputRef: string | null;
}

export interface EvidenceInput {
  summary: string;
  source: string;
  subject: string;
  revision: string | null;
  artifact: string | null;
  limitations: string;
  criterionIds: string[];
  checkId: string | null;
  subjectFile: FileSnapshot | null;
}

export interface EvaluationInput {
  criterionId: string;
  verdict: Verdict;
  rationale: string;
  evidenceIds: string[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && Object.keys(value).every((key) => expected.includes(key));
}
function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function optionalText(value: unknown): value is string | null {
  return value === null || nonblank(value);
}
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function optionalTimestamp(value: unknown): boolean { return value === null || timestamp(value); }
function validId(value: unknown, prefix: string): value is string {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return false;
  const suffix = value.slice(prefix.length);
  return /^[1-9][0-9]*$/.test(suffix) && Number.isSafeInteger(Number(suffix));
}
function references(value: unknown, allowed: Set<string>, required: boolean): value is string[] {
  return Array.isArray(value) && (!required || value.length > 0) && value.length <= 100 &&
    value.every((id) => typeof id === 'string' && allowed.has(id)) && new Set(value).size === value.length;
}
function validStream(value: unknown, captured: boolean): boolean {
  if (!object(value) || !keys(value, ['bytes', 'text', 'truncated'])) return false;
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0 || typeof value.truncated !== 'boolean') return false;
  if (!captured) return value.text === null && value.truncated === false;
  return typeof value.text === 'string' && Buffer.byteLength(value.text, 'utf8') <= OUTPUT_LIMIT_BYTES * 3;
}
function validOutput(value: unknown): boolean {
  if (!object(value) || !keys(value, ['captured', 'limitBytesPerStream', 'encoding', 'stdout', 'stderr'])) return false;
  return typeof value.captured === 'boolean' && value.limitBytesPerStream === OUTPUT_LIMIT_BYTES && value.encoding === 'utf8-lossy' &&
    validStream(value.stdout, value.captured) && validStream(value.stderr, value.captured);
}

/** Validate every field and reference before allowing this version to rewrite a record. */
export function validateVerification(value: Record<string, unknown>, criterionIds: Set<string>, corrupt: (detail: string) => never): void {
  if (!Array.isArray(value.checks) || !Array.isArray(value.evidence) || !Array.isArray(value.evaluations)) {
    corrupt('checks, evidence, and evaluations must be arrays');
  }
  const checks = new Map<string, Check>();
  for (const raw of value.checks as unknown[]) {
    if (!object(raw) || !keys(raw, ['id', 'invocation', 'status', 'argv', 'cwd', 'criterionIds', 'requestedAt', 'startedAt', 'endedAt', 'exitCode', 'signal', 'reason', 'revision', 'dirty', 'provenance', 'timeoutMs', 'captureOutput', 'outputRef', 'output'])) corrupt('invalid check fields');
    if (!validId(raw.id, 'CHK') || checks.has(raw.id)) corrupt('invalid or duplicate check ID');
    if (raw.invocation !== 'run' && raw.invocation !== 'reported') corrupt('invalid check invocation');
    if (!['pending', 'passed', 'failed', 'timed_out', 'interrupted', 'could_not_start', 'skipped', 'inconclusive'].includes(String(raw.status))) corrupt('invalid check status');
    if (!Array.isArray(raw.argv) || raw.argv.length === 0 || raw.argv.length > 100 || !nonblank(raw.argv[0]) || !raw.argv.every((arg) => typeof arg === 'string' && !arg.includes('\0'))) corrupt('invalid check command');
    if (!nonblank(raw.cwd) || !isAbsolute(raw.cwd) || !references(raw.criterionIds, criterionIds, false)) corrupt('invalid check cwd or criteria');
    if (!timestamp(raw.requestedAt) || !optionalTimestamp(raw.startedAt) || !optionalTimestamp(raw.endedAt)) corrupt('invalid check times');
    if (!(raw.exitCode === null || (Number.isSafeInteger(raw.exitCode) && (raw.exitCode as number) >= 0)) || !optionalText(raw.signal) || !optionalText(raw.reason) || !optionalText(raw.revision) || !optionalText(raw.outputRef)) corrupt('invalid check result');
    if (!['clean', 'dirty', 'unknown'].includes(String(raw.dirty)) || !['reported', 'unknown'].includes(String(raw.provenance))) corrupt('invalid check provenance');
    if (raw.provenance === 'unknown' && (raw.revision !== null || raw.dirty !== 'unknown')) corrupt('unattributed check provenance');
    if (typeof raw.captureOutput !== 'boolean') corrupt('invalid output capture selection');
    if (raw.invocation === 'run') {
      if (!Number.isSafeInteger(raw.timeoutMs) || (raw.timeoutMs as number) < 1 || (raw.timeoutMs as number) > MAX_TIMEOUT_MS) corrupt('invalid check timeout');
      if (!raw.captureOutput && raw.outputRef === null) corrupt('check is missing output or an artifact reference');
      if (raw.status === 'skipped') corrupt('an executed check cannot be marked skipped');
      if (raw.status === 'pending') {
        if (raw.startedAt !== null || raw.endedAt !== null || raw.exitCode !== null || raw.signal !== null || raw.reason !== null || raw.output !== null) corrupt('invalid pending check');
      } else {
        if (!timestamp(raw.endedAt) || !validOutput(raw.output) || !object(raw.output) || raw.output.captured !== raw.captureOutput) corrupt('invalid completed check');
        if (raw.status === 'passed' && (raw.exitCode !== 0 || raw.signal !== null || !timestamp(raw.startedAt))) corrupt('invalid passing check');
        if (raw.status === 'failed' && (!(typeof raw.exitCode === 'number' && raw.exitCode > 0) || raw.signal !== null || !timestamp(raw.startedAt))) corrupt('invalid failed check');
        if (raw.status === 'could_not_start' && (raw.startedAt !== null || raw.exitCode !== null || raw.signal !== null || !nonblank(raw.reason))) corrupt('invalid unstarted check');
        if (['timed_out', 'interrupted', 'inconclusive'].includes(String(raw.status)) && !nonblank(raw.reason)) corrupt('check outcome needs a reason');
      }
    } else {
      if (!['skipped', 'inconclusive'].includes(String(raw.status)) || !nonblank(raw.reason) || raw.startedAt !== null || raw.endedAt !== null || raw.exitCode !== null || raw.signal !== null || raw.timeoutMs !== null || raw.captureOutput || raw.output !== null) corrupt('invalid reported check');
    }
    checks.set(raw.id as string, raw as unknown as Check);
  }
  const evidence = new Map<string, Evidence>();
  for (const raw of value.evidence as unknown[]) {
    if (!object(raw) || !keys(raw, ['id', 'summary', 'source', 'subject', 'revision', 'artifact', 'limitations', 'criterionIds', 'checkId', 'subjectFile', 'createdAt'])) corrupt('invalid evidence fields');
    if (!validId(raw.id, 'E') || evidence.has(raw.id)) corrupt('invalid or duplicate evidence ID');
    if (!nonblank(raw.summary) || !nonblank(raw.source) || !nonblank(raw.subject) || !nonblank(raw.limitations) || !optionalText(raw.revision) || !optionalText(raw.artifact) || !references(raw.criterionIds, criterionIds, false) || !timestamp(raw.createdAt) || !(raw.subjectFile === null || isFileSnapshot(raw.subjectFile))) corrupt('invalid evidence');
    if (raw.checkId !== null && (typeof raw.checkId !== 'string' || !checks.has(raw.checkId))) {
      corrupt('evidence refers to a missing check');
    }
    evidence.set(raw.id as string, raw as unknown as Evidence);
  }
  const evaluationIds = new Set<string>();
  for (const raw of value.evaluations as unknown[]) {
    if (!object(raw) || !keys(raw, ['id', 'criterionId', 'verdict', 'rationale', 'evidenceIds', 'createdAt'])) corrupt('invalid evaluation fields');
    if (!validId(raw.id, 'V') || evaluationIds.has(raw.id)) corrupt('invalid or duplicate evaluation ID');
    if (typeof raw.criterionId !== 'string' || !criterionIds.has(raw.criterionId) || !['unverified', 'supported', 'contradicted', 'inconclusive', 'not_applicable'].includes(String(raw.verdict)) || !nonblank(raw.rationale) || !timestamp(raw.createdAt)) corrupt('invalid evaluation');
    if (!references(raw.evidenceIds, new Set(evidence.keys()), raw.verdict !== 'unverified')) corrupt('invalid evaluation evidence');
    evaluationIds.add(raw.id as string);
  }
}

function nextId(prefix: string, items: readonly { id: string }[]): string {
  let max = 0;
  for (const item of items) max = Math.max(max, Number(item.id.slice(prefix.length)));
  if (!Number.isSafeInteger(max + 1)) throw usageError(`No more ${prefix} IDs are available.`);
  return `${prefix}${max + 1}`;
}

function requireCriteria(record: WorkRecord, ids: string[], required = false): void {
  const known = new Set(record.entries.filter((entry) => entry.kind === 'criterion').map((entry) => entry.id));
  if (!references(ids, known, required)) throw usageError('Criterion IDs must be distinct existing IDs (at most 100).');
}

export function addCheck(record: WorkRecord, input: CheckInput, reported?: { status: 'skipped' | 'inconclusive'; reason: string }): { record: WorkRecordV3; check: Check } {
  requireCriteria(record, input.criterionIds);
  const next = upgradeRecord(record);
  const check: Check = {
    id: nextId('CHK', next.checks), invocation: reported ? 'reported' : 'run', status: reported?.status ?? 'pending',
    argv: input.argv, cwd: input.cwd, criterionIds: input.criterionIds, requestedAt: new Date().toISOString(),
    startedAt: null, endedAt: null, exitCode: null, signal: null, reason: reported?.reason ?? null,
    revision: input.revision, dirty: input.dirty, provenance: input.provenance,
    timeoutMs: reported ? null : input.timeoutMs, captureOutput: reported ? false : input.captureOutput,
    outputRef: input.outputRef, output: null,
  };
  const context = { checkId: check.id, entryCount: next.entries.length, revisionCount: next.revisions.length };
  return { record: { ...next, checks: [...next.checks, check], checkContexts: [...next.checkContexts, context] }, check };
}

export function completeCheck(record: WorkRecord, completed: Check): WorkRecordV3 {
  const next = upgradeRecord(record);
  const index = next.checks.findIndex((check) => check.id === completed.id);
  if (index < 0 || next.checks[index]!.status !== 'pending') throw usageError(`Check ${completed.id} is missing or is no longer pending; inspect the record.`);
  const checks = [...next.checks];
  checks[index] = completed;
  return { ...next, checks };
}

export function addEvidence(record: WorkRecord, input: EvidenceInput): { record: WorkRecordV3; evidence: Evidence } {
  requireCriteria(record, input.criterionIds);
  const next = upgradeRecord(record);
  if (input.checkId !== null && !next.checks.some((item) => item.id === input.checkId)) {
    throw usageError(`Check ${input.checkId} is not in this work record.`);
  }
  const evidence: Evidence = { id: nextId('E', next.evidence), ...input, createdAt: new Date().toISOString() };
  const context = { evidenceId: evidence.id, entryCount: next.entries.length, revisionCount: next.revisions.length };
  return { record: { ...next, evidence: [...next.evidence, evidence], evidenceContexts: [...next.evidenceContexts, context] }, evidence };
}

export function addEvaluation(record: WorkRecord, input: EvaluationInput): { record: WorkRecordV3; evaluation: Evaluation } {
  requireCriteria(record, [input.criterionId], true);
  const next = upgradeRecord(record);
  const known = new Set(next.evidence.map((item) => item.id));
  if (!references(input.evidenceIds, known, input.verdict !== 'unverified')) throw usageError('A non-unverified evaluation needs distinct existing --evidence IDs (at most 100).');
  const evaluation: Evaluation = { id: nextId('V', next.evaluations), ...input, createdAt: new Date().toISOString() };
  const context = { evaluationId: evaluation.id, entryCount: next.entries.length, revisionCount: next.revisions.length };
  return { record: { ...next, evaluations: [...next.evaluations, evaluation], evaluationContexts: [...next.evaluationContexts, context] }, evaluation };
}
