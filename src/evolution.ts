import type { WorkRecord, WorkRecordV5 } from './domain.js';

/** Upgrade only for a mutation. Legacy criteria could not be revised, so their
 * evidence and evaluations refer to the original criterion versions. Schema 4
 * adds claims, check case labels, recorded acceptances, and delivery targets.
 * Schema 5 adds optional practice and scenario entries (a scenario may link one
 * criterion) and a per-check caller expectation; older binaries reject schema 5
 * rather than dropping its fields. */
export function upgradeRecord(record: WorkRecord): WorkRecordV5 {
  if (record.schemaVersion === 5) {
    return record.checks.some((check) => !('reconciledAt' in check))
      ? { ...record, checks: record.checks.map((check) => ({ ...check, reconciledAt: check.reconciledAt ?? null })) }
      : record;
  }
  if (record.schemaVersion === 4) {
    return {
      ...record,
      schemaVersion: 5,
      entries: record.entries.map((entry) => ({ ...entry, criterionId: entry.criterionId ?? null })),
      checks: record.checks.map((check) => ({ ...check, expect: check.expect ?? null, reconciledAt: null })),
    };
  }
  if (record.schemaVersion === 3) {
    return {
      ...record,
      schemaVersion: 5,
      entries: record.entries.map((entry) => ({ ...entry, criterionId: null })),
      checks: record.checks.map((check) => ({ ...check, caseType: check.caseType ?? null, expect: null, reconciledAt: null })),
      acceptances: [],
      deliveryTargets: [],
    };
  }
  const verification = record.schemaVersion === 2
    ? { checks: record.checks, evidence: record.evidence, evaluations: record.evaluations }
    : { checks: [], evidence: [], evaluations: [] };
  return {
    ...record,
    ...verification,
    schemaVersion: 5,
    entries: record.entries.map((entry) => ({ ...entry, criterionId: null })),
    checks: verification.checks.map((check) => ({ ...check, caseType: null, expect: null, reconciledAt: null })),
    revisions: [],
    baselines: [],
    driftAssessments: [],
    checkContexts: verification.checks.map((item) => ({
      checkId: item.id, entryCount: record.entries.length, revisionCount: 0,
    })),
    evidenceContexts: verification.evidence.map((item) => ({
      evidenceId: item.id, entryCount: record.entries.length, revisionCount: 0,
    })),
    evaluationContexts: verification.evaluations.map((item) => ({
      evaluationId: item.id, entryCount: record.entries.length, revisionCount: 0,
    })),
    acceptances: [],
    deliveryTargets: [],
  };
}
