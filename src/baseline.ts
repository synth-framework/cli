import type { Entry, EntryKind, WorkRecord, WorkRecordV4 } from './domain.js';
import { upgradeRecord } from './evolution.js';
import { usageError } from './errors.js';
import { isFileSnapshot, snapshotFile, type FileSnapshot } from './fingerprint.js';
import { keys, nextId, nonblank, object, optionalText, references, timestamp, validCount, validId } from './validate.js';

export const MAX_BASELINE_FILES = 20;
export type BaselineArea = 'intention' | 'scope' | 'criteria' | 'verification';
export type DriftFinding = 'intentional' | 'unintended' | 'uncertain' | 'no_concern';

const scopeKinds: readonly EntryKind[] = ['outcome', 'scope', 'constraint', 'non-goal'];
const revisableKinds: readonly EntryKind[] = [...scopeKinds, 'criterion', 'verification', 'claim'];

export interface Revision {
  id: string;
  target: string;
  text: string | null;
  reason: string | null;
  evidenceIds: string[];
  entryCount: number;
  evidenceCount: number;
  createdAt: string;
}

/** A baseline points to immutable prefixes, plus snapshots of selected files. */
export interface Baseline {
  id: string;
  reason: string | null;
  entryCount: number;
  revisionCount: number;
  checkCount: number;
  evidenceCount: number;
  evaluationCount: number;
  files: FileSnapshot[];
  createdAt: string;
}

export interface DriftAssessment {
  id: string;
  baselineId: string;
  area: BaselineArea;
  finding: DriftFinding;
  reason: string;
  evidenceIds: string[];
  entryCount: number;
  revisionCount: number;
  evidenceCount: number;
  baselineCount: number;
  files: FileSnapshot[];
  createdAt: string;
}

export interface CheckContext {
  checkId: string;
  entryCount: number;
  revisionCount: number;
}

export interface EvidenceContext {
  evidenceId: string;
  entryCount: number;
  revisionCount: number;
}

export interface EvaluationContext {
  evaluationId: string;
  entryCount: number;
  revisionCount: number;
}

export interface RevisedEntry extends Entry {
  originalText: string;
  active: boolean;
  revisionId: string | null;
}

export interface SnapshotItem {
  id: string;
  kind: string;
  text: string;
  revisionId: string | null;
}

export interface ItemChange {
  id: string;
  kind: string;
  change: 'added' | 'removed' | 'modified' | 'revised';
  before: SnapshotItem | null;
  after: SnapshotItem | null;
  entryReason: string | null;
  revisions: Revision[];
}

export interface FileChange {
  path: string;
  change: 'selection_added' | 'selection_removed' | 'matching' | 'changed' | 'unknown';
  before: FileSnapshot | null;
  after: FileSnapshot | null;
}

export interface AreaComparison {
  state: 'unchanged' | 'changed' | 'unknown' | 'not_recorded';
  before: SnapshotItem[];
  after: SnapshotItem[];
  changes: ItemChange[];
  interveningEntries: Entry[];
  interveningRevisionIds: string[];
  unknownFileCount: number;
  files: FileChange[];
}

export interface BaselineComparison {
  baselineId: string;
  comparedTo: string | 'current';
  direction: 'forward' | 'reverse' | 'same';
  areas: Record<BaselineArea, AreaComparison>;
  interveningRevisions: Revision[];
  affectedEvidenceCandidates: { evidenceId: string; basis: string[] }[];
  evidenceImpact: 'not_inferred';
}

export interface DriftAssessmentView extends DriftAssessment {
  areaBasisState: 'unchanged' | 'changed' | 'unknown';
  areaUnknownFileCount: number;
  evidenceAddedSince: string[];
}

function filesValid(value: unknown): value is FileSnapshot[] {
  return Array.isArray(value) && value.length <= MAX_BASELINE_FILES && value.every(isFileSnapshot) &&
    new Set(value.map((item) => item.path)).size === value.length;
}

/** Validate the history and all its references before any record can be rewritten. */
export function validateBaseline(value: Record<string, unknown>, corrupt: (detail: string) => never): void {
  if (!Array.isArray(value.revisions) || !Array.isArray(value.baselines) || !Array.isArray(value.driftAssessments) ||
      !Array.isArray(value.checkContexts) || !Array.isArray(value.evidenceContexts) || !Array.isArray(value.evaluationContexts)) corrupt('baseline history and contexts must be arrays');
  const entries = value.entries as Entry[];
  const checks = value.checks as WorkRecordV4['checks'];
  const evidence = value.evidence as WorkRecordV4['evidence'];
  const evaluations = value.evaluations as WorkRecordV4['evaluations'];
  const revisions = value.revisions as unknown[];
  const baselines = value.baselines as unknown[];
  const assessments = value.driftAssessments as unknown[];
  const revisionIds = new Set<string>();
  let lastEntryCount = 0;
  let lastEvidenceCount = 0;
  for (const raw of revisions) {
    if (!object(raw) || !keys(raw, ['id', 'target', 'text', 'reason', 'evidenceIds', 'entryCount', 'evidenceCount', 'createdAt'])) corrupt('invalid revision fields');
    if (!validId(raw.id, 'R') || revisionIds.has(raw.id)) corrupt('invalid or duplicate revision ID');
    if (!validCount(raw.entryCount, entries.length) || !validCount(raw.evidenceCount, evidence.length) ||
        raw.entryCount < lastEntryCount || raw.evidenceCount < lastEvidenceCount) corrupt('invalid revision history counts');
    if (raw.target === 'intention') {
      if (!nonblank(raw.text)) corrupt('the intention cannot be removed');
    } else {
      const target = entries.slice(0, raw.entryCount as number).find((entry) => entry.id === raw.target);
      if (!target || !revisableKinds.includes(target.kind) || !(raw.text === null || nonblank(raw.text))) corrupt('invalid revision target or text');
    }
    if (!optionalText(raw.reason) || !references(raw.evidenceIds, new Set(evidence.slice(0, raw.evidenceCount as number).map((item) => item.id))) || !timestamp(raw.createdAt)) corrupt('invalid revision details');
    revisionIds.add(raw.id as string);
    lastEntryCount = raw.entryCount as number;
    lastEvidenceCount = raw.evidenceCount as number;
  }
  const validPrefixes = (entryCount: unknown, revisionCount: unknown): boolean => {
    if (!validCount(entryCount, entries.length) || !validCount(revisionCount, revisions.length)) return false;
    // Revision entry counts were checked as nondecreasing above.
    return revisionCount === 0 || (revisions[revisionCount - 1] as Revision).entryCount <= entryCount;
  };
  // Revision evidence counts were also checked as nondecreasing, so the last
  // included revision carries the maximum: a baseline or assessment must not
  // enclose revisions that cite evidence beyond its own evidence prefix.
  const revisionsCiteIncludedEvidence = (revisionCount: unknown, evidenceCount: unknown): boolean => {
    if (!validCount(revisionCount, revisions.length) || !validCount(evidenceCount, evidence.length)) return false;
    return revisionCount === 0 || (revisions[revisionCount - 1] as Revision).evidenceCount <= evidenceCount;
  };
  const baselineIds = new Set<string>();
  lastEntryCount = 0;
  let lastRevisionCount = 0;
  lastEvidenceCount = 0;
  let lastCheckCount = 0;
  let lastEvaluationCount = 0;
  for (const raw of baselines) {
    if (!object(raw) || !keys(raw, ['id', 'reason', 'entryCount', 'revisionCount', 'checkCount', 'evidenceCount', 'evaluationCount', 'files', 'createdAt'])) corrupt('invalid baseline fields');
    if (!validId(raw.id, 'B') || baselineIds.has(raw.id) || !optionalText(raw.reason) || !timestamp(raw.createdAt)) corrupt('invalid baseline');
    if (!validPrefixes(raw.entryCount, raw.revisionCount) || !revisionsCiteIncludedEvidence(raw.revisionCount, raw.evidenceCount) ||
        !validCount(raw.checkCount, checks.length) || !validCount(raw.evidenceCount, evidence.length) || !validCount(raw.evaluationCount, evaluations.length) ||
        (raw.entryCount as number) < lastEntryCount || (raw.revisionCount as number) < lastRevisionCount || (raw.checkCount as number) < lastCheckCount ||
        (raw.evidenceCount as number) < lastEvidenceCount || (raw.evaluationCount as number) < lastEvaluationCount || !filesValid(raw.files)) corrupt('invalid baseline contents');
    baselineIds.add(raw.id as string);
    lastEntryCount = raw.entryCount as number;
    lastRevisionCount = raw.revisionCount as number;
    lastCheckCount = raw.checkCount as number;
    lastEvidenceCount = raw.evidenceCount as number;
    lastEvaluationCount = raw.evaluationCount as number;
  }
  const assessmentIds = new Set<string>();
  lastEntryCount = 0;
  lastRevisionCount = 0;
  lastEvidenceCount = 0;
  let lastBaselineCount = 0;
  for (const raw of assessments) {
    if (!object(raw) || !keys(raw, ['id', 'baselineId', 'area', 'finding', 'reason', 'evidenceIds', 'entryCount', 'revisionCount', 'evidenceCount', 'baselineCount', 'files', 'createdAt'])) corrupt('invalid drift assessment fields');
    if (!validId(raw.id, 'DA') || assessmentIds.has(raw.id) || !['intention', 'scope', 'criteria', 'verification'].includes(String(raw.area)) ||
        !['intentional', 'unintended', 'uncertain', 'no_concern'].includes(String(raw.finding)) || !nonblank(raw.reason) || !timestamp(raw.createdAt)) corrupt('invalid drift assessment');
    if (!validPrefixes(raw.entryCount, raw.revisionCount) || !revisionsCiteIncludedEvidence(raw.revisionCount, raw.evidenceCount) ||
        !validCount(raw.evidenceCount, evidence.length) || !validCount(raw.baselineCount, baselines.length) ||
        (raw.entryCount as number) < lastEntryCount || (raw.revisionCount as number) < lastRevisionCount ||
        (raw.evidenceCount as number) < lastEvidenceCount || (raw.baselineCount as number) < lastBaselineCount) corrupt('invalid drift assessment history counts');
    const baseline = (baselines.slice(0, raw.baselineCount as number) as Baseline[]).find((item) => item.id === raw.baselineId);
    if (!baseline || baseline.entryCount > (raw.entryCount as number) || baseline.revisionCount > (raw.revisionCount as number) ||
        baseline.evidenceCount > (raw.evidenceCount as number) || !references(raw.evidenceIds, new Set(evidence.slice(0, raw.evidenceCount as number).map((item) => item.id))) || !filesValid(raw.files)) corrupt('invalid drift assessment references');
    const files = raw.files as FileSnapshot[];
    if (raw.area === 'verification') {
      if (files.length !== baseline.files.length || files.some((item, index) => item.path !== baseline.files[index]?.path)) corrupt('invalid assessment file selection');
    } else if (files.length !== 0) corrupt('unexpected assessment files');
    assessmentIds.add(raw.id as string);
    lastEntryCount = raw.entryCount as number;
    lastRevisionCount = raw.revisionCount as number;
    lastEvidenceCount = raw.evidenceCount as number;
    lastBaselineCount = raw.baselineCount as number;
  }

  function validateContexts(rawContexts: unknown[], targets: readonly { id: string; criterionIds: string[] }[], idKey: string): void {
    if (rawContexts.length !== targets.length) corrupt('missing verification context');
    let previousEntries = 0;
    let previousRevisions = 0;
    for (let index = 0; index < targets.length; index++) {
      const raw = rawContexts[index];
      const target = targets[index]!;
      if (!object(raw) || !keys(raw, [idKey, 'entryCount', 'revisionCount']) || raw[idKey] !== target.id ||
          !validPrefixes(raw.entryCount, raw.revisionCount) || (raw.entryCount as number) < previousEntries || (raw.revisionCount as number) < previousRevisions) corrupt('invalid verification context');
      const criteria = new Set(entries.slice(0, raw.entryCount as number).filter((entry) => entry.kind === 'criterion').map((entry) => entry.id));
      if (!target.criterionIds.every((id) => criteria.has(id))) corrupt('verification context refers to a later criterion');
      previousEntries = raw.entryCount as number;
      previousRevisions = raw.revisionCount as number;
    }
  }
  validateContexts(value.checkContexts as unknown[], checks, 'checkId');
  validateContexts(value.evidenceContexts as unknown[], evidence, 'evidenceId');
  validateContexts(value.evaluationContexts as unknown[], evaluations.map((item) => ({ id: item.id, criterionIds: [item.criterionId] })), 'evaluationId');
  for (const baseline of baselines as Baseline[]) {
    const contexts = [
      ...(value.checkContexts as CheckContext[]).slice(0, baseline.checkCount),
      ...(value.evidenceContexts as EvidenceContext[]).slice(0, baseline.evidenceCount),
      ...(value.evaluationContexts as EvaluationContext[]).slice(0, baseline.evaluationCount),
    ];
    const availableEvidence = new Set(evidence.slice(0, baseline.evidenceCount).map((item) => item.id));
    const availableChecks = new Set(checks.slice(0, baseline.checkCount).map((item) => item.id));
    if (contexts.some((item) => item.entryCount > baseline.entryCount || item.revisionCount > baseline.revisionCount) ||
        evidence.slice(0, baseline.evidenceCount).some((item) => item.checkId !== null && !availableChecks.has(item.checkId)) ||
        evaluations.slice(0, baseline.evaluationCount).some((item) => item.evidenceIds.some((id) => !availableEvidence.has(id)))) corrupt('baseline refers to later verification context');
  }
}

export function revisionIdAt(record: WorkRecordV4, target: string, revisionCount = record.revisions.length): string | null {
  for (let index = Math.min(revisionCount, record.revisions.length) - 1; index >= 0; index--) {
    const revision = record.revisions[index]!;
    if (revision.target === target) return revision.id;
  }
  return null;
}

export function projectEntry(entry: Entry, revisions: readonly Revision[], count = revisions.length): RevisedEntry {
  let text = entry.text;
  let active = true;
  let revisionId: string | null = null;
  for (const revision of revisions.slice(0, count)) {
    if (revision.target !== entry.id) continue;
    revisionId = revision.id;
    if (revision.text === null) active = false;
    else { text = revision.text; active = true; }
  }
  return { ...entry, text, originalText: entry.text, active, revisionId };
}

export function currentIntention(record: WorkRecordV4, count = record.revisions.length): { text: string; revisionId: string | null } {
  let text = record.originalIntention;
  let revisionId: string | null = null;
  for (const revision of record.revisions.slice(0, count)) {
    if (revision.target === 'intention' && revision.text !== null) { text = revision.text; revisionId = revision.id; }
  }
  return { text, revisionId };
}

export function addRevision(record: WorkRecord, input: { target: string; text: string | null; reason: string | null; evidenceIds: string[] }): { record: WorkRecordV4; revision: Revision } {
  const next = upgradeRecord(record);
  if (input.target === 'intention') {
    if (input.text === null) throw usageError('The original intention cannot be removed; revise its text instead.');
  } else {
    const target = next.entries.find((entry) => entry.id === input.target);
    if (!target || !revisableKinds.includes(target.kind)) throw usageError('Revise intention or an existing outcome, scope, constraint, non-goal, criterion, verification, or claim ID.');
  }
  if (!references(input.evidenceIds, new Set(next.evidence.map((item) => item.id)))) throw usageError('Evidence IDs must be distinct existing IDs (at most 100).');
  const revision: Revision = {
    id: nextId('R', next.revisions), ...input,
    entryCount: next.entries.length, evidenceCount: next.evidence.length, createdAt: new Date().toISOString(),
  };
  return { record: { ...next, revisions: [...next.revisions, revision] }, revision };
}

/** files=null inherits the last explicitly selected paths; [] explicitly clears them. */
export function captureBaseline(record: WorkRecord, input: { reason: string | null; files: string[] | null }): { record: WorkRecordV4; baseline: Baseline } {
  const next = upgradeRecord(record);
  const paths = input.files ?? next.baselines.at(-1)?.files.map((item) => item.path) ?? [];
  if (paths.length > MAX_BASELINE_FILES || new Set(paths).size !== paths.length) throw usageError(`Select at most ${MAX_BASELINE_FILES} distinct baseline files.`);
  const baseline: Baseline = {
    id: nextId('B', next.baselines), reason: input.reason, entryCount: next.entries.length,
    revisionCount: next.revisions.length, checkCount: next.checks.length,
    evidenceCount: next.evidence.length, evaluationCount: next.evaluations.length,
    files: paths.map(snapshotFile), createdAt: new Date().toISOString(),
  };
  return { record: { ...next, baselines: [...next.baselines, baseline] }, baseline };
}

export function addDriftAssessment(record: WorkRecord, input: { baselineId: string; area: BaselineArea; finding: DriftFinding; reason: string; evidenceIds: string[] }): { record: WorkRecordV4; assessment: DriftAssessment } {
  const next = upgradeRecord(record);
  const baseline = next.baselines.find((item) => item.id === input.baselineId);
  if (!baseline) throw usageError(`Baseline ${input.baselineId} is not in this work record.`);
  if (!references(input.evidenceIds, new Set(next.evidence.map((item) => item.id)))) throw usageError('Evidence IDs must be distinct existing IDs (at most 100).');
  const assessment: DriftAssessment = {
    id: nextId('DA', next.driftAssessments), ...input,
    entryCount: next.entries.length, revisionCount: next.revisions.length,
    evidenceCount: next.evidence.length, baselineCount: next.baselines.length,
    files: input.area === 'verification' ? baseline.files.map((item) => snapshotFile(item.path)) : [],
    createdAt: new Date().toISOString(),
  };
  return { record: { ...next, driftAssessments: [...next.driftAssessments, assessment] }, assessment };
}

function itemsAt(record: WorkRecordV4, area: BaselineArea, entryCount: number, revisionCount: number): SnapshotItem[] {
  if (area === 'intention') {
    const intention = currentIntention(record, revisionCount);
    return [{ id: 'intention', kind: 'intention', ...intention }];
  }
  const kinds: readonly EntryKind[] = area === 'scope' ? scopeKinds : area === 'criteria' ? ['criterion'] : ['verification'];
  return record.entries.slice(0, entryCount).filter((entry) => kinds.includes(entry.kind))
    .map((entry) => projectEntry(entry, record.revisions, revisionCount)).filter((entry) => entry.active)
    .map((entry) => ({ id: entry.id, kind: entry.kind, text: entry.text, revisionId: entry.revisionId }));
}

function belongsToArea(area: BaselineArea, kind: EntryKind): boolean {
  return area === 'scope' ? scopeKinds.includes(kind) : area === 'criteria' ? kind === 'criterion'
    : area === 'verification' ? kind === 'verification' : false;
}

function compareArea(record: WorkRecordV4, area: BaselineArea, beforeItems: SnapshotItem[], afterItems: SnapshotItem[], beforeFiles: FileSnapshot[], afterFiles: FileSnapshot[], revisions: Revision[], entries: Entry[]): AreaComparison {
  const beforeById = new Map(beforeItems.map((item) => [item.id, item]));
  const afterById = new Map(afterItems.map((item) => [item.id, item]));
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])];
  const changes: ItemChange[] = [];
  for (const id of ids) {
    const before = beforeById.get(id) ?? null;
    const after = afterById.get(id) ?? null;
    let change: ItemChange['change'] | null = null;
    if (before === null) change = 'added';
    else if (after === null) change = 'removed';
    else if (before.text !== after.text || before.kind !== after.kind) change = 'modified';
    else if (before.revisionId !== after.revisionId) change = 'revised';
    if (change !== null) changes.push({
      id, kind: (after ?? before)!.kind, change, before, after,
      entryReason: record.entries.find((entry) => entry.id === id)?.reason ?? null,
      revisions: revisions.filter((revision) => revision.target === id),
    });
  }
  const beforeByPath = new Map(beforeFiles.map((item) => [item.path, item]));
  const afterByPath = new Map(afterFiles.map((item) => [item.path, item]));
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])];
  const files: FileChange[] = paths.map((path) => {
    const before = beforeByPath.get(path) ?? null;
    const after = afterByPath.get(path) ?? null;
    let change: FileChange['change'];
    if (before === null) change = 'selection_added';
    else if (after === null) change = 'selection_removed';
    else if ((before.state === 'captured' && after.state === 'missing') || (before.state === 'missing' && after.state === 'captured')) change = 'changed';
    else if (before.state !== 'captured' || after.state !== 'captured') change = 'unknown';
    else change = before.digest === after.digest ? 'matching' : 'changed';
    return { path, change, before, after };
  });
  const interveningEntries = entries.filter((entry) => belongsToArea(area, entry.kind));
  const interveningRevisionIds = revisions.filter((revision) => {
    if (revision.target === 'intention') return area === 'intention';
    const entry = record.entries.find((item) => item.id === revision.target);
    return entry !== undefined && belongsToArea(area, entry.kind);
  }).map((revision) => revision.id);
  const changed = changes.length > 0 || interveningEntries.length > 0 || interveningRevisionIds.length > 0 ||
    files.some((item) => ['selection_added', 'selection_removed', 'changed'].includes(item.change));
  // A selection or existence change can be known while one snapshot's bytes
  // are still unavailable; expose both facts rather than hiding the unknown.
  const unknownFileCount = files.filter((item) =>
    (item.before !== null && item.before.state !== 'captured') ||
    (item.after !== null && item.after.state !== 'captured')).length;
  const emptyVerification = area === 'verification' && beforeItems.length === 0 && afterItems.length === 0 && files.length === 0;
  return {
    state: changed ? 'changed' : unknownFileCount > 0 ? 'unknown' : emptyVerification ? 'not_recorded' : 'unchanged',
    before: beforeItems, after: afterItems, changes, interveningEntries, interveningRevisionIds, unknownFileCount, files,
  };
}

export type ObservationCache = Map<string, FileSnapshot>;
function observe(paths: readonly string[], cache: ObservationCache): FileSnapshot[] {
  return paths.map((path) => {
    const previous = cache.get(path);
    if (previous) return previous;
    const current = snapshotFile(path);
    cache.set(path, current);
    return current;
  });
}

export function compareBaselines(record: WorkRecordV4, baselineId: string, targetId?: string, cache: ObservationCache = new Map()): BaselineComparison {
  const before = record.baselines.find((item) => item.id === baselineId);
  if (!before) throw usageError(`Baseline ${baselineId} is not in this work record.`);
  const after = targetId === undefined ? undefined : record.baselines.find((item) => item.id === targetId);
  if (targetId !== undefined && !after) throw usageError(`Baseline ${targetId} is not in this work record.`);
  const entryCount = after?.entryCount ?? record.entries.length;
  const revisionCount = after?.revisionCount ?? record.revisions.length;
  const entries = record.entries.slice(Math.min(before.entryCount, entryCount), Math.max(before.entryCount, entryCount));
  const revisions = record.revisions.slice(Math.min(before.revisionCount, revisionCount), Math.max(before.revisionCount, revisionCount));
  const areas = {} as Record<BaselineArea, AreaComparison>;
  for (const area of ['intention', 'scope', 'criteria', 'verification'] as const) {
    const filesBefore = area === 'verification' ? before.files : [];
    const filesAfter = area !== 'verification' ? [] : after ? after.files : observe(before.files.map((item) => item.path), cache);
    areas[area] = compareArea(record, area, itemsAt(record, area, before.entryCount, before.revisionCount), itemsAt(record, area, entryCount, revisionCount), filesBefore, filesAfter, revisions, entries);
  }
  const criterionRevisionIds = new Set(areas.criteria.interveningRevisionIds);
  const changedCriteria = new Set([
    ...areas.criteria.changes.map((item) => item.id),
    ...areas.criteria.interveningEntries.map((item) => item.id),
    ...revisions.filter((item) => criterionRevisionIds.has(item.id)).map((item) => item.target),
  ]);
  const changedFiles = new Set(areas.verification.files.filter((item) => item.change !== 'matching').map((item) => item.path));
  const candidates = new Map<string, Set<string>>();
  const addCandidate = (id: string, reason: string): void => {
    const basis = candidates.get(id) ?? new Set<string>();
    basis.add(reason);
    candidates.set(id, basis);
  };
  const evidenceCount = after ? Math.max(before.evidenceCount, after.evidenceCount) : record.evidence.length;
  const evaluationCount = after ? Math.max(before.evaluationCount, after.evaluationCount) : record.evaluations.length;
  const checkCount = after ? Math.max(before.checkCount, after.checkCount) : record.checks.length;
  const availableEvidence = record.evidence.slice(0, evidenceCount);
  const checksById = new Map(record.checks.slice(0, checkCount).map((check) => [check.id, check]));
  for (const revision of revisions) for (const id of revision.evidenceIds) addCandidate(id, 'declared_by_revision');
  for (const item of availableEvidence) {
    if (item.criterionIds.some((id) => changedCriteria.has(id))) addCandidate(item.id, 'criterion_link');
    if (item.checkId !== null && checksById.get(item.checkId)?.criterionIds.some((id) => changedCriteria.has(id))) addCandidate(item.id, 'check_criterion_link');
    if (item.subjectFile !== null && changedFiles.has(item.subjectFile.path)) addCandidate(item.id, 'selected_subject_file');
    if (item.checkId !== null && ['changed', 'unknown'].includes(areas.verification.state)) addCandidate(item.id, 'check_inputs_unknown');
  }
  for (const evaluation of record.evaluations.slice(0, evaluationCount)) {
    if (changedCriteria.has(evaluation.criterionId)) for (const id of evaluation.evidenceIds) addCandidate(id, 'evaluation_citation');
  }
  const direction = !after ? 'forward' : record.baselines.indexOf(after) > record.baselines.indexOf(before) ? 'forward'
    : after.id === before.id ? 'same' : 'reverse';
  return {
    baselineId, comparedTo: targetId ?? 'current', direction, areas, interveningRevisions: revisions,
    affectedEvidenceCandidates: availableEvidence.filter((item) => candidates.has(item.id)).map((item) => ({ evidenceId: item.id, basis: [...candidates.get(item.id)!] })),
    evidenceImpact: 'not_inferred',
  };
}

export function assessmentView(record: WorkRecordV4, assessment: DriftAssessment, cache: ObservationCache = new Map()): DriftAssessmentView {
  const baseline = record.baselines.find((item) => item.id === assessment.baselineId)!;
  const files = assessment.area === 'verification' ? observe(baseline.files.map((item) => item.path), cache) : [];
  const revisions = record.revisions.slice(assessment.revisionCount);
  const comparison = compareArea(record, assessment.area,
    itemsAt(record, assessment.area, assessment.entryCount, assessment.revisionCount),
    itemsAt(record, assessment.area, record.entries.length, record.revisions.length), assessment.files, files, revisions,
    record.entries.slice(assessment.entryCount));
  return {
    ...assessment,
    areaBasisState: comparison.state === 'changed' ? 'changed' : comparison.state === 'unknown' ? 'unknown' : 'unchanged',
    areaUnknownFileCount: comparison.unknownFileCount,
    evidenceAddedSince: record.evidence.slice(assessment.evidenceCount).map((item) => item.id),
  };
}
