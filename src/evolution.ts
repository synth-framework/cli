import type { WorkRecord, WorkRecordV3 } from './domain.js';

/** Upgrade only for a mutation. Legacy criteria could not be revised, so their
 * evidence and evaluations refer to the original criterion versions. */
export function upgradeRecord(record: WorkRecord): WorkRecordV3 {
  if (record.schemaVersion === 3) return record;
  const verification = record.schemaVersion === 2
    ? { checks: record.checks, evidence: record.evidence, evaluations: record.evaluations }
    : { checks: [], evidence: [], evaluations: [] };
  return {
    ...record,
    ...verification,
    schemaVersion: 3,
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
  };
}
