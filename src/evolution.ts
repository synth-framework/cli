import type { WorkRecord, WorkRecordV4 } from './domain.js';

/** Upgrade only for a mutation. Legacy criteria could not be revised, so their
 * evidence and evaluations refer to the original criterion versions. Schema 4
 * adds claims, check case labels, recorded acceptances, and delivery targets;
 * older binaries reject schema 4 rather than dropping its fields. */
export function upgradeRecord(record: WorkRecord): WorkRecordV4 {
  if (record.schemaVersion === 4) return record;
  if (record.schemaVersion === 3) {
    return {
      ...record,
      schemaVersion: 4,
      checks: record.checks.map((check) => ({ ...check, caseType: check.caseType ?? null })),
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
    schemaVersion: 4,
    checks: verification.checks.map((check) => ({ ...check, caseType: null })),
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
