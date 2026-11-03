import type { CriterionView, WorkRecord, WorkRecordV4 } from './domain.js';
import type { BaselineComparison } from './baseline.js';
import { upgradeRecord } from './evolution.js';
import { usageError } from './errors.js';

/** Optional case label for a check, so negative and boundary coverage is visible. */
export type CaseType = 'positive' | 'negative' | 'boundary' | 'regression';
export const CASE_TYPES: readonly CaseType[] = ['positive', 'negative', 'boundary', 'regression'];

/** Delivery goals are distinct from recorded activities; one is never inferred from the other. */
export type DeliveryTargetKind = 'code' | 'pr-handoff' | 'artifact' | 'documentation' | 'deployment' | 'observed-outcome';
export const DELIVERY_TARGETS: readonly DeliveryTargetKind[] = ['code', 'pr-handoff', 'artifact', 'documentation', 'deployment', 'observed-outcome'];

/**
 * A recorded acceptance is an explicit human self-attestation with known gaps.
 * It is not proof a human was present, not a verification, and not delegation.
 * Recording does not depend on freshness; the counts snapshot lets the handoff
 * tell whether anything relevant changed since the acceptance was recorded.
 */
export interface Acceptance {
  id: string;
  kind: 'initial' | 'reassessment';
  statement: string;
  knownGapIds: string[];
  recordedAt: string;
  entryCount: number;
  revisionCount: number;
  baselineCount: number;
  checkCount: number;
  evidenceCount: number;
  evaluationCount: number;
}

export interface AcceptanceView extends Acceptance {
  state: 'current' | 'reassessment_needed';
  changedSince: string[];
}

export interface DeliveryTarget {
  id: string;
  target: DeliveryTargetKind;
  text: string;
  reason: string | null;
  recordedAt: string;
  entryCount: number;
}

export interface QaCoverage {
  criteria: { total: number; active: number; evaluated: number; unverified: number };
  checks: { total: number; pending: number; byStatus: Record<string, number>; byCase: Record<string, number> };
  evidence: number;
  evaluations: number;
  findings: { driftAssessments: number; unintendedOrUncertain: number };
  risks: { openGaps: number; unknownSelectedFiles: number | null };
}

export interface AcceptanceInput {
  kind: 'initial' | 'reassessment';
  statement: string;
  knownGapIds: string[];
}

export interface DeliveryTargetInput {
  target: DeliveryTargetKind;
  text: string;
  reason: string | null;
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
function validId(value: unknown, prefix: string): value is string {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return false;
  const suffix = value.slice(prefix.length);
  return /^[1-9][0-9]*$/.test(suffix) && Number.isSafeInteger(Number(suffix));
}
function count(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function references(value: unknown, allowed: Set<string>, max = 100): value is string[] {
  return Array.isArray(value) && value.length <= max &&
    value.every((id) => typeof id === 'string' && allowed.has(id)) && new Set(value).size === value.length;
}

/** Validate the schema-4 review collections before this version rewrites a record. */
export function validateReview(value: Record<string, unknown>, gapIds: Set<string>, corrupt: (detail: string) => never): void {
  if (!Array.isArray(value.acceptances) || !Array.isArray(value.deliveryTargets)) {
    corrupt('acceptances and deliveryTargets must be arrays');
  }
  const acceptanceIds = new Set<string>();
  for (const raw of value.acceptances as unknown[]) {
    if (!object(raw) || !keys(raw, ['id', 'kind', 'statement', 'knownGapIds', 'recordedAt', 'entryCount', 'revisionCount', 'baselineCount', 'checkCount', 'evidenceCount', 'evaluationCount'])) corrupt('invalid acceptance fields');
    if (!validId(raw.id, 'AC') || acceptanceIds.has(raw.id)) corrupt('invalid or duplicate acceptance ID');
    if (raw.kind !== 'initial' && raw.kind !== 'reassessment') corrupt('invalid acceptance kind');
    if (!nonblank(raw.statement) || !references(raw.knownGapIds, gapIds) || !timestamp(raw.recordedAt)) corrupt('invalid acceptance');
    if (!count(raw.entryCount) || !count(raw.revisionCount) || !count(raw.baselineCount) || !count(raw.checkCount) || !count(raw.evidenceCount) || !count(raw.evaluationCount)) corrupt('invalid acceptance counts');
    acceptanceIds.add(raw.id as string);
  }
  const targetIds = new Set<string>();
  for (const raw of value.deliveryTargets as unknown[]) {
    if (!object(raw) || !keys(raw, ['id', 'target', 'text', 'reason', 'recordedAt', 'entryCount'])) corrupt('invalid delivery target fields');
    if (!validId(raw.id, 'T') || targetIds.has(raw.id)) corrupt('invalid or duplicate delivery target ID');
    if (!DELIVERY_TARGETS.includes(raw.target as DeliveryTargetKind) || !nonblank(raw.text) || !optionalText(raw.reason) || !timestamp(raw.recordedAt) || !count(raw.entryCount)) corrupt('invalid delivery target');
    targetIds.add(raw.id as string);
  }
}

function nextId(prefix: string, items: readonly { id: string }[]): string {
  let max = 0;
  for (const item of items) max = Math.max(max, Number(item.id.slice(prefix.length)));
  if (!Number.isSafeInteger(max + 1)) throw usageError(`No more ${prefix} IDs are available.`);
  return `${prefix}${max + 1}`;
}

export function addAcceptance(record: WorkRecord, input: AcceptanceInput): { record: WorkRecordV4; acceptance: Acceptance } {
  const next = upgradeRecord(record);
  const gaps = new Set(next.entries.filter((entry) => entry.kind === 'gap').map((entry) => entry.id));
  if (input.kind === 'initial' && next.acceptances.length > 0) {
    throw usageError('An acceptance is already recorded; use --reassess to record acceptance again after relevant changes.');
  }
  if (input.kind === 'reassessment' && next.acceptances.length === 0) {
    throw usageError('No acceptance is recorded yet; record the initial acceptance first.');
  }
  if (!references(input.knownGapIds, gaps)) {
    throw usageError('Known gaps must be distinct existing gap IDs (at most 100); record gaps with add gap first.');
  }
  const acceptance: Acceptance = {
    id: nextId('AC', next.acceptances),
    kind: input.kind,
    statement: input.statement,
    knownGapIds: input.knownGapIds,
    recordedAt: new Date().toISOString(),
    entryCount: next.entries.length,
    revisionCount: next.revisions.length,
    baselineCount: next.baselines.length,
    checkCount: next.checks.length,
    evidenceCount: next.evidence.length,
    evaluationCount: next.evaluations.length,
  };
  return { record: { ...next, acceptances: [...next.acceptances, acceptance] }, acceptance };
}

export function addDeliveryTarget(record: WorkRecord, input: DeliveryTargetInput): { record: WorkRecordV4; target: DeliveryTarget } {
  const next = upgradeRecord(record);
  const deliveryTarget: DeliveryTarget = {
    id: nextId('T', next.deliveryTargets),
    target: input.target,
    text: input.text,
    reason: input.reason,
    recordedAt: new Date().toISOString(),
    entryCount: next.entries.length,
  };
  return { record: { ...next, deliveryTargets: [...next.deliveryTargets, deliveryTarget] }, target: deliveryTarget };
}

/** Compare the acceptance snapshot counts with the current record; no timestamps are trusted. */
export function acceptanceView(state: WorkRecordV4): AcceptanceView | null {
  const latest = state.acceptances.at(-1);
  if (!latest) return null;
  const changedSince: string[] = [];
  if (state.entries.length !== latest.entryCount) changedSince.push('entries');
  if (state.revisions.length !== latest.revisionCount) changedSince.push('revisions');
  if (state.baselines.length !== latest.baselineCount) changedSince.push('baselines');
  if (state.checks.length !== latest.checkCount) changedSince.push('checks');
  if (state.evidence.length !== latest.evidenceCount) changedSince.push('evidence');
  if (state.evaluations.length !== latest.evaluationCount) changedSince.push('evaluations');
  return { ...latest, state: changedSince.length === 0 ? 'current' : 'reassessment_needed', changedSince };
}

/** Coverage summary: what was checked, with what evidence, plus findings and residual risks. */
export function computeQaCoverage(state: WorkRecordV4, criteria: readonly CriterionView[], comparison: BaselineComparison | null): QaCoverage {
  const byStatus: Record<string, number> = {};
  const byCase: Record<string, number> = {};
  let pending = 0;
  for (const check of state.checks) {
    byStatus[check.status] = (byStatus[check.status] ?? 0) + 1;
    if (check.status === 'pending') pending += 1;
    const caseType = check.caseType ?? 'unlabeled';
    byCase[caseType] = (byCase[caseType] ?? 0) + 1;
  }
  const active = criteria.filter((item) => item.active);
  return {
    criteria: {
      total: criteria.length,
      active: active.length,
      evaluated: active.filter((item) => item.evaluation !== 'unverified').length,
      unverified: active.filter((item) => item.evaluation === 'unverified').length,
    },
    checks: { total: state.checks.length, pending, byStatus, byCase },
    evidence: state.evidence.length,
    evaluations: state.evaluations.length,
    findings: {
      driftAssessments: state.driftAssessments.length,
      unintendedOrUncertain: state.driftAssessments.filter((item) => item.finding === 'unintended' || item.finding === 'uncertain').length,
    },
    risks: {
      openGaps: state.entries.filter((entry) => entry.kind === 'gap').length,
      unknownSelectedFiles: comparison ? Object.values(comparison.areas).reduce((sum, area) => sum + area.unknownFileCount, 0) : null,
    },
  };
}
