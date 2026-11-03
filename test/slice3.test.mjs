import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { appendEntries, decodeRecord, makeHandoff, newRecord } from '../dist/domain.js';
import { addAcceptance, addDeliveryTarget } from '../dist/review.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repository, 'dist', 'cli.js');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'synth-slice3-'));
  const record = join(dir, 'work.json');
  return { dir, record };
}

function run(record, args, options = {}) {
  return spawnSync(process.execPath, [cli, '--record', record, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    ...options,
  });
}

function ok(result, command) {
  assert.equal(result.error, undefined, `spawn failed: ${result.error}`);
  assert.equal(result.status, 0, `expected success; stdout=${result.stdout}\nstderr=${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, command);
  return payload.data;
}

function fail(result, code, errorCode) {
  assert.notEqual(result.status, 0, `expected failure; stdout=${result.stdout}`);
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, errorCode ?? code);
  return payload;
}

function init(record, intent = 'Slice 3 work item') {
  return ok(run(record, ['init', '--intent', intent, '--json']), 'init');
}

function handoff(record) {
  return ok(run(record, ['handoff', '--json']), 'handoff').handoff;
}

test('S3-02: claims are recorded, corrected with history retained, and surfaced in the handoff', () => {
  const { dir, record } = setup();
  try {
    init(record);
    assert.ok(handoff(record).missingContext.includes('claims'));
    ok(run(record, ['add', 'claim', '--text', 'The title stays stable', '--reason', 'Observed behavior', '--json']), 'add');
    ok(run(record, ['revise', 'CL1', '--text', 'The title stays stable across renames', '--reason', 'Correction after review', '--json']), 'revise');
    const h = handoff(record);
    assert.ok(!h.missingContext.includes('claims'));
    assert.equal(h.claims.length, 1);
    assert.equal(h.claims[0].id, 'CL1');
    assert.equal(h.claims[0].text, 'The title stays stable across renames');
    assert.equal(h.claims[0].originalText, 'The title stays stable');
    assert.equal(h.claims[0].revisionId, 'R1');
    assert.ok(h.revisions.some((item) => item.target === 'CL1' && item.text === 'The title stays stable across renames'));
    const human = run(record, ['handoff']);
    assert.equal(human.status, 0);
    assert.match(human.stdout, /Claims \(corrections retained/);
    assert.match(human.stdout, /Current revision: R1; original: The title stays stable/);
    // Removing the only claim is recorded-but-removed, not missing.
    ok(run(record, ['revise', 'CL1', '--remove', '--reason', 'Claim withdrawn', '--json']), 'revise');
    const after = handoff(record);
    assert.equal(after.claims.length, 0);
    assert.ok(!after.missingContext.includes('claims'));
    assert.ok(after.removedEntries.some((item) => item.id === 'CL1' && item.kind === 'claim'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S3-04: acceptance is recorded as a self-attestation with known gaps, independent of freshness', () => {
  const { dir, record } = setup();
  try {
    init(record);
    ok(run(record, ['add', 'gap', '--text', 'macOS untested', '--json']), 'add');
    // Acceptance recording must not consult freshness: a changed selected file does not block it.
    const file = join(dir, 'subject.js');
    writeFileSync(file, 'v1');
    ok(run(record, ['baseline', 'capture', '--file', 'subject.js', '--json'], { cwd: dir }), 'baseline');
    writeFileSync(file, 'v2');
    const acceptance = ok(run(record, ['accept', '--statement', 'Reviewed; known gaps recorded', '--gap', 'G1', '--json']), 'accept').acceptance;
    assert.equal(acceptance.id, 'AC1');
    assert.equal(acceptance.kind, 'initial');
    assert.deepEqual(acceptance.knownGapIds, ['G1']);
    const h = handoff(record);
    assert.equal(h.capabilities.acceptance, 'available');
    assert.equal(h.acceptance.id, 'AC1');
    assert.equal(h.acceptance.state, 'current');
    assert.deepEqual(h.acceptance.changedSince, []);
    // A second initial acceptance is rejected; --reassess is required.
    fail(run(record, ['accept', '--statement', 'Again', '--json']), 2, 'USAGE_ERROR');
    // Unknown gap IDs are rejected.
    fail(run(record, ['accept', '--reassess', '--statement', 'X', '--gap', 'G404', '--json']), 2, 'USAGE_ERROR');
    // Missing statement is a usage error.
    fail(run(record, ['accept', '--json']), 2, 'USAGE_ERROR');
    const human = run(record, ['handoff']);
    assert.match(human.stdout, /Acceptance \(recorded self-attestation AC1 \[initial\]/);
    assert.match(human.stdout, /Known gaps: G1/);
    assert.match(human.stdout, /State: current/);
    const status = run(record, ['status']);
    assert.match(status.stdout, /Acceptance: AC1 \[initial\] is current/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S3-05: acceptance is flagged for reassessment after relevant changes and can be re-recorded', () => {
  const { dir, record } = setup();
  try {
    init(record);
    ok(run(record, ['add', 'criterion', '--text', 'Titles are strings', '--json']), 'add');
    ok(run(record, ['accept', '--statement', 'Initial acceptance', '--json']), 'accept');
    assert.equal(handoff(record).acceptance.state, 'current');
    ok(run(record, ['revise', 'intention', '--text', 'Narrower intention', '--reason', 'Scope review', '--json']), 'revise');
    ok(run(record, ['evidence', 'add', '--summary', 'A report', '--source', 'Caller', '--subject', 'Titles', '--limitations', 'Not verified', '--json']), 'evidence');
    const h = handoff(record);
    assert.equal(h.acceptance.state, 'reassessment_needed');
    assert.ok(h.acceptance.changedSince.includes('revisions'));
    assert.ok(h.acceptance.changedSince.includes('evidence'));
    assert.ok(!h.acceptance.changedSince.includes('entries'), 'no new entry was recorded, so entries did not change');
    assert.equal(h.acceptance.id, 'AC1');
    // The envelope signals output version 2 because the intention was revised.
    const payload = JSON.parse(run(record, ['handoff', '--json']).stdout);
    assert.equal(payload.outputVersion, 2);
    // Reassessment is recorded as a new acceptance event.
    const reassessed = ok(run(record, ['accept', '--reassess', '--statement', 'Reassessed after the revision', '--json']), 'accept').acceptance;
    assert.equal(reassessed.id, 'AC2');
    assert.equal(reassessed.kind, 'reassessment');
    const after = handoff(record);
    assert.equal(after.acceptance.id, 'AC2');
    assert.equal(after.acceptance.state, 'current');
    // --reassess without a prior acceptance is a usage error.
    const { dir: dir2, record: record2 } = setup();
    try {
      init(record2);
      fail(run(record2, ['accept', '--reassess', '--statement', 'X', '--json']), 2, 'USAGE_ERROR');
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S3-06: QA coverage summarizes checks (with case labels), evidence, evaluations, findings, and risks', () => {
  const { dir, record } = setup();
  try {
    init(record);
    ok(run(record, ['add', 'criterion', '--text', 'Whitespace-only titles are empty', '--json']), 'add');
    ok(run(record, ['add', 'gap', '--text', 'Boundary behavior untested', '--json']), 'add');
    ok(run(record, ['check', 'record', '--case', 'boundary', '--status', 'inconclusive', '--reason', 'Needs a fixture', '--json', '--', 'node', '-e', ''], { cwd: dir }), 'check');
    ok(run(record, ['check', 'record', '--case', 'negative', '--status', 'skipped', '--reason', 'Not applicable yet', '--json', '--', 'node', '-e', ''], { cwd: dir }), 'check');
    ok(run(record, ['evidence', 'add', '--criterion', 'C1', '--summary', 'Manual run', '--source', 'Developer', '--subject', 'Criterion', '--limitations', 'Small sample', '--json']), 'evidence');
    ok(run(record, ['evaluate', 'C1', '--status', 'supported', '--reason', 'Consistent with evidence', '--evidence', 'E1', '--json']), 'evaluate');
    ok(run(record, ['baseline', 'capture', '--no-files', '--reason', 'Start', '--json']), 'baseline');
    ok(run(record, ['baseline', 'assess', 'B1', '--area', 'criteria', '--finding', 'unintended', '--reason', 'Criterion changed after baseline', '--json']), 'baseline');
    const h = handoff(record);
    assert.deepEqual(h.qaCoverage.criteria, { total: 1, active: 1, evaluated: 1, unverified: 0 });
    assert.equal(h.qaCoverage.checks.total, 2);
    assert.equal(h.qaCoverage.checks.byStatus.inconclusive, 1);
    assert.equal(h.qaCoverage.checks.byStatus.skipped, 1);
    assert.equal(h.qaCoverage.checks.byCase.boundary, 1);
    assert.equal(h.qaCoverage.checks.byCase.negative, 1);
    assert.equal(h.qaCoverage.evidence, 1);
    assert.equal(h.qaCoverage.evaluations, 1);
    assert.deepEqual(h.qaCoverage.findings, { driftAssessments: 1, unintendedOrUncertain: 1 });
    assert.equal(h.qaCoverage.risks.openGaps, 1);
    assert.equal(h.qaCoverage.risks.unknownSelectedFiles, 0);
    const human = run(record, ['handoff']);
    assert.match(human.stdout, /QA coverage \(recorded coverage, not proof of adequacy\)/);
    assert.match(human.stdout, /by case: 1 boundary, 1 negative/);
    assert.match(human.stdout, /Residual risks: 1 recorded gap\(s\)/);
    assert.match(human.stdout, /CHK1 \[inconclusive; reported; case: boundary\]/);
    const status = run(record, ['status']);
    assert.match(status.stdout, /QA coverage: 1 active criteria \(0 unverified\); 2 checks \(0 pending\)/);
    // Invalid case label is a usage error.
    fail(run(record, ['check', 'record', '--case', 'exploratory', '--status', 'skipped', '--reason', 'x', '--json', '--', 'node', '-e', ''], { cwd: dir }), 2, 'USAGE_ERROR');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S3-07: delivery targets are recorded as goals, distinct from recorded activities', () => {
  const { dir, record } = setup();
  try {
    init(record);
    ok(run(record, ['add', 'update', '--text', 'Implemented the change', '--json']), 'add');
    assert.equal(handoff(record).deliveryTargets.length, 0);
    const target = ok(run(record, ['deliver', '--target', 'pr-handoff', '--text', 'Hand off via pull request', '--reason', 'Team flow', '--json']), 'deliver').deliveryTarget;
    assert.equal(target.id, 'T1');
    assert.equal(target.target, 'pr-handoff');
    const h = handoff(record);
    assert.equal(h.deliveryTargets.length, 1);
    assert.equal(h.deliveryTargets[0].target, 'pr-handoff');
    assert.equal(h.updates.length, 1, 'activities are not rewritten as delivery targets');
    const human = run(record, ['handoff']);
    assert.match(human.stdout, /Delivery targets \(goals; not evidence that an outcome was achieved\)/);
    assert.match(human.stdout, /T1 \[pr-handoff\]: Hand off via pull request/);
    const status = run(record, ['status']);
    assert.match(status.stdout, /Delivery targets \(goals, not outcomes\): T1 pr-handoff/);
    fail(run(record, ['deliver', '--target', 'website', '--text', 'x', '--json']), 2, 'USAGE_ERROR');
    fail(run(record, ['deliver', '--target', 'code', '--json']), 2, 'USAGE_ERROR');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schema 4 records validate, upgrade from schema 3, and reject unknown versions or kinds', () => {
  const base = newRecord('Unit check');
  assert.equal(base.schemaVersion, 4);
  const encoded = Buffer.from(JSON.stringify(base));
  assert.equal(decodeRecord(encoded, 'unit.json').schemaVersion, 4);

  // Schema 5 is rejected without modification.
  assert.throws(() => decodeRecord(Buffer.from(JSON.stringify({ ...base, schemaVersion: 5 })), 'unit.json'), /schema version 5/);

  // A schema 3 record with a claim entry is corrupt (claims are schema-4 only).
  const v3 = { schemaVersion: 3, originalIntention: 'x', createdAt: new Date().toISOString(), entries: [{ id: 'CL1', kind: 'claim', text: 't', reason: null, questionId: null, createdAt: new Date().toISOString() }], checks: [], evidence: [], evaluations: [], revisions: [], baselines: [], driftAssessments: [], checkContexts: [], evidenceContexts: [], evaluationContexts: [] };
  assert.throws(() => decodeRecord(Buffer.from(JSON.stringify(v3)), 'unit.json'), /claims require schema version 4/);

  // A schema 3 record upgrades to 4 on the next mutation, retaining entries.
  const legacy = { ...v3, entries: [{ id: 'C1', kind: 'criterion', text: 'c', reason: null, questionId: null, createdAt: new Date().toISOString() }] };
  const upgraded = appendEntries(decodeRecord(Buffer.from(JSON.stringify(legacy)), 'unit.json'), [{ kind: 'gap', text: 'g', reason: null, questionId: null }]);
  assert.equal(upgraded.record.schemaVersion, 4);
  assert.equal(upgraded.record.entries.length, 2);
  assert.deepEqual(upgraded.record.acceptances, []);
  assert.deepEqual(upgraded.record.deliveryTargets, []);

  // Acceptance referencing a missing gap is rejected at validation time.
  const withAcceptance = { ...upgraded.record, acceptances: [{ id: 'AC1', kind: 'initial', statement: 's', knownGapIds: ['G404'], recordedAt: new Date().toISOString(), entryCount: 2, revisionCount: 0, baselineCount: 0, checkCount: 0, evidenceCount: 0, evaluationCount: 0 }] };
  assert.throws(() => decodeRecord(Buffer.from(JSON.stringify(withAcceptance)), 'unit.json'), /invalid acceptance/);

  // Domain-level helpers agree with the CLI shape.
  const record = addAcceptance(upgraded.record, { kind: 'initial', statement: 'ok', knownGapIds: ['G1'] }).record;
  assert.equal(record.acceptances.length, 1);
  const target = addDeliveryTarget(record, { target: 'code', text: 'ship it', reason: null }).record;
  assert.equal(target.deliveryTargets[0].target, 'code');
  const h = makeHandoff(target);
  assert.equal(h.acceptance?.state, 'current');
  assert.equal(h.deliveryTargets.length, 1);
  assert.equal(h.qaCoverage.risks.openGaps, 1);
  assert.ok(existsSync(cli));
});
