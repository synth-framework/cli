// baseline.test.mjs
import test from 'node:test';
import { strict as assert } from 'assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareBaselines, validateBaseline } from '../dist/baseline.js';
import { makeHandoff } from '../dist/domain.js';
import { snapshotFile } from '../dist/fingerprint.js';
import { renderComparison } from '../dist/presentation.js';

// Helper to create a minimal valid record schema V3
function minimalRecord() {
  return {
    entries: [],
    revisions: [],
    baselines: [],
    driftAssessments: [],
    checkContexts: [],
    evidenceContexts: [],
    evaluationContexts: [],
    checks: [],
    evidence: [],
    evaluations: [],
  };
}

function corrupt(message) {
  throw new Error(message);
}

// Test that a valid empty record does not throw
await test('validateBaseline accepts minimal valid record', async () => {
  const rec = minimalRecord();
  assert.doesNotThrow(() => validateBaseline(rec, corrupt));
});

// Test that missing required arrays triggers corrupt error
await test('validateBaseline rejects missing arrays', async () => {
  let thrown = false;
  try {
    validateBaseline({}, corrupt);
  } catch (e) {
    thrown = true;
    assert.match(e.message, /baseline history and contexts must be arrays/);
  }
  assert.ok(thrown, 'expected error');
});

// Test that invalid revision ID format is caught
await test('validateBaseline rejects bad revision id', async () => {
  const rec = minimalRecord();
  rec.revisions = [{
    id: 'X1',
    target: 'intention',
    text: 'foo',
    reason: null,
    evidenceIds: [],
    entryCount: 0,
    evidenceCount: 0,
    createdAt: new Date().toISOString(),
  }];
  let thrown = false;
  try {
    validateBaseline(rec, corrupt);
  } catch (e) {
    thrown = true;
    assert.match(e.message, /invalid or duplicate revision ID/);
  }
  assert.ok(thrown, 'expected error');
});

// A revision must target an entry inside the entry prefix it records;
// targeting a later entry would break the append-only prefix integrity.
await test('validateBaseline rejects a revision target outside the recorded entry prefix', async () => {
  const rec = minimalRecord();
  rec.entries = [{
    id: 'C1',
    kind: 'criterion',
    text: 'A criterion',
    reason: null,
    questionId: null,
    createdAt: new Date().toISOString(),
  }];
  rec.revisions = [{
    id: 'R1',
    target: 'C1',
    text: 'A revised criterion',
    reason: null,
    evidenceIds: [],
    entryCount: 0,
    evidenceCount: 0,
    createdAt: new Date().toISOString(),
  }];
  let thrown = false;
  try {
    validateBaseline(rec, corrupt);
  } catch (e) {
    thrown = true;
    assert.match(e.message, /invalid revision target or text/);
  }
  assert.ok(thrown, 'expected error');
});

// A baseline or assessment must not enclose revisions that cite evidence
// beyond its own evidence prefix.
await test('validateBaseline rejects a baseline whose revision cites evidence outside the evidence prefix', async () => {
  const rec = minimalRecord();
  const now = new Date().toISOString();
  rec.entries = [{ id: 'C1', kind: 'criterion', text: 'A criterion', reason: null, questionId: null, createdAt: now }];
  rec.evidence = [{ id: 'E1', summary: 's', source: 's', subject: 's', revision: null, artifact: null, limitations: 'l', criterionIds: ['C1'], checkId: null, subjectFile: null, createdAt: now }];
  rec.evidenceContexts = [{ evidenceId: 'E1', entryCount: 1, revisionCount: 0 }];
  rec.revisions = [{ id: 'R1', target: 'C1', text: 'Revised', reason: null, evidenceIds: ['E1'], entryCount: 1, evidenceCount: 1, createdAt: now }];
  rec.baselines = [{ id: 'B1', reason: null, entryCount: 1, revisionCount: 1, checkCount: 0, evidenceCount: 0, evaluationCount: 0, files: [], createdAt: now }];
  assert.throws(() => validateBaseline(rec, corrupt), /invalid baseline contents/);
  rec.baselines[0].evidenceCount = 1;
  assert.doesNotThrow(() => validateBaseline(rec, corrupt));
  // The same rule applies to drift assessments.
  rec.driftAssessments = [{ id: 'DA1', baselineId: 'B1', area: 'criteria', finding: 'uncertain', reason: 'r', evidenceIds: [], entryCount: 1, revisionCount: 1, evidenceCount: 0, baselineCount: 1, files: [], createdAt: now }];
  assert.throws(() => validateBaseline(rec, corrupt), /invalid drift assessment history counts/);
  rec.driftAssessments[0].evidenceCount = 1;
  assert.doesNotThrow(() => validateBaseline(rec, corrupt));
});

// Evidence linked to a changed criterion only through its check is still a
// review candidate, with an explicit indirect-link basis.
await test('compareBaselines surfaces evidence linked via a changed criterion check', async () => {
  const now = new Date().toISOString();
  const record = {
    schemaVersion: 3,
    originalIntention: 'I',
    createdAt: now,
    entries: [{ id: 'C1', kind: 'criterion', text: 'A criterion', reason: null, questionId: null, createdAt: now }],
    checks: [{ id: 'CHK1', invocation: 'reported', status: 'skipped', argv: [], cwd: '/tmp', criterionIds: ['C1'], requestedAt: now, startedAt: null, endedAt: null, exitCode: null, signal: null, reason: 'Not run', revision: null, dirty: 'unknown', provenance: 'unknown', timeoutMs: null, captureOutput: false, outputRef: null, output: null }],
    evidence: [{ id: 'E1', summary: 's', source: 's', subject: 's', revision: null, artifact: null, limitations: 'l', criterionIds: [], checkId: 'CHK1', subjectFile: null, createdAt: now }],
    evaluations: [],
    revisions: [{ id: 'R1', target: 'C1', text: 'Revised', reason: null, evidenceIds: [], entryCount: 1, evidenceCount: 1, createdAt: now }],
    baselines: [{ id: 'B1', reason: null, entryCount: 1, revisionCount: 0, checkCount: 1, evidenceCount: 1, evaluationCount: 0, files: [], createdAt: now }],
    driftAssessments: [],
    checkContexts: [{ checkId: 'CHK1', entryCount: 1, revisionCount: 0 }],
    evidenceContexts: [{ evidenceId: 'E1', entryCount: 1, revisionCount: 0 }],
    evaluationContexts: [],
  };
  const comparison = compareBaselines(record, 'B1');
  const candidate = comparison.affectedEvidenceCandidates.find((item) => item.evidenceId === 'E1');
  assert.ok(candidate, 'E1 should be a candidate');
  assert.ok(candidate.basis.includes('check_criterion_link'), `basis was ${candidate.basis.join(',')}`);
});

// The v1-named handoff arrays contain active entries only; removed entries are
// exposed separately so consumers ignoring `active` never read removed work.
await test('makeHandoff keeps v1 arrays active-only and lists removed entries separately', async () => {
  const now = new Date().toISOString();
  const record = {
    schemaVersion: 3,
    originalIntention: 'I',
    createdAt: now,
    entries: [{ id: 'C1', kind: 'criterion', text: 'Original', reason: null, questionId: null, createdAt: now }],
    checks: [],
    evidence: [],
    evaluations: [],
    revisions: [{ id: 'R1', target: 'C1', text: null, reason: 'out of scope', evidenceIds: [], entryCount: 1, evidenceCount: 0, createdAt: now }],
    baselines: [],
    driftAssessments: [],
    checkContexts: [],
    evidenceContexts: [],
    evaluationContexts: [],
  };
  const handoff = makeHandoff(record);
  assert.equal(handoff.criteria.length, 0);
  const removed = handoff.removedEntries.find((item) => item.id === 'C1');
  assert.ok(removed, 'C1 should be in removedEntries');
  assert.equal(removed.active, false);
  assert.equal(removed.revisionId, 'R1');
});

// A FIFO swapped in for a selected file must not block fingerprinting.
await test('snapshotFile rejects a non-regular file without blocking', { skip: process.platform !== 'linux' ? 'requires Linux mkfifo' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'synth-fifo-'));
  try {
    const fifo = join(dir, 'pipe');
    execFileSync('mkfifo', [fifo]);
    const snapshot = snapshotFile(fifo);
    assert.equal(snapshot.state, 'unavailable');
    assert.equal(snapshot.digest, null);
    assert.match(snapshot.reason ?? '', /not a regular file|file changed while opening|could not be fingerprinted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The human comparison output shows the unknown-file count next to the state.
await test('renderComparison shows the unknown selected-file count', async () => {
  const area = (state, unknownFileCount) => ({ state, before: [], after: [], changes: [], interveningEntries: [], interveningRevisionIds: [], unknownFileCount, files: [] });
  const comparison = {
    baselineId: 'B1',
    comparedTo: 'current',
    direction: 'forward',
    areas: {
      intention: area('unchanged', 0),
      scope: area('unchanged', 0),
      criteria: area('changed', 0),
      verification: area('changed', 1),
    },
    interveningRevisions: [],
    affectedEvidenceCandidates: [],
    evidenceImpact: 'not_inferred',
  };
  const output = renderComparison(comparison);
  assert.match(output, /verification: changed; unknown selected files 1\./);
  assert.match(output, /intention: unchanged\./);
});
