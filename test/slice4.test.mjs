import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { appendEntries, decodeRecord, makeHandoff, newRecord } from '../dist/domain.js';
import { addCheck, completeCheck, OUTPUT_LIMIT_BYTES } from '../dist/verification.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repository, 'dist', 'cli.js');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'synth-slice4-'));
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

function init(record, intent = 'Slice 4 work item') {
  return ok(run(record, ['init', '--intent', intent, '--json']), 'init');
}

function handoff(record) {
  return ok(run(record, ['handoff', '--json']), 'handoff').handoff;
}

test('S4-01: optional practice entries record tdd/bdd and reject other text', () => {
  const { dir, record } = setup();
  try {
    const created = init(record);
    assert.equal(created.record.schemaVersion, 5);
    ok(run(record, ['add', 'practice', '--text', 'tdd', '--reason', 'Red-green cycle for this item', '--json']), 'add');
    ok(run(record, ['add', 'practice', '--text', 'bdd', '--json']), 'add');
    fail(run(record, ['add', 'practice', '--text', 'xp', '--json']), 2, 'USAGE_ERROR');
    const h = handoff(record);
    assert.deepEqual(h.practices.map((entry) => entry.id), ['PR1', 'PR2']);
    assert.deepEqual(h.practices.map((entry) => entry.text), ['tdd', 'bdd']);
    assert.equal(h.practices[0].criterionId, null);
    assert.ok(h.missingContext.includes('scenarios'));
    assert.equal(h.capabilities.practices, 'available');
    assert.equal(h.capabilities.scenarios, 'available');
    assert.equal(h.capabilities.checkExpectation, 'available');
    assert.deepEqual(h.qaCoverage.practices, ['tdd', 'bdd']);
    const human = run(record, ['handoff']);
    assert.equal(human.status, 0);
    assert.match(human.stdout, /Practices \(optional recorded choice/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S4-01: check --expect records the caller expectation and the handoff reports met/not met', () => {
  const { dir, record } = setup();
  try {
    init(record);
    ok(run(record, ['add', 'criterion', '--text', 'A behavior to drive', '--json']), 'add');
    // TDD red: a failing command recorded with --expect fail meets the expectation.
    const red = ok(run(record, ['check', 'run', '--criterion', 'C1', '--expect', 'fail', '--capture-output', '--json', '--', 'node', '-e', 'process.exit(1)']), 'check');
    assert.equal(red.check.status, 'failed');
    assert.equal(red.check.expect, 'fail');
    // A mismatched expectation is recorded as not met, not hidden.
    ok(run(record, ['check', 'run', '--criterion', 'C1', '--expect', 'pass', '--capture-output', '--json', '--', 'node', '-e', 'process.exit(1)']), 'check');
    // TDD green: a passing command recorded with --expect pass meets it.
    ok(run(record, ['check', 'run', '--criterion', 'C1', '--expect', 'pass', '--capture-output', '--json', '--', 'node', '-e', '']), 'check');
    // No expectation recorded: expectationMet is null.
    ok(run(record, ['check', 'run', '--criterion', 'C1', '--capture-output', '--json', '--', 'node', '-e', '']), 'check');
    // A reported (not run) check has no pass/fail outcome, so expectationMet stays null.
    const reported = ok(run(record, ['check', 'record', '--criterion', 'C1', '--expect', 'fail', '--status', 'skipped', '--reason', 'Not run here', '--output-ref', 'ticket-1', '--json', '--', 'node', '--test']), 'check');
    assert.equal(reported.check.status, 'skipped');
    assert.equal(reported.check.expect, 'fail');
    fail(run(record, ['check', 'run', '--expect', 'maybe', '--capture-output', '--json', '--', 'node', '-e', '']), 2, 'USAGE_ERROR');
    const h = handoff(record);
    assert.deepEqual(h.checks.map((check) => check.expectationMet), [true, false, true, null, null]);
    assert.deepEqual(h.checks.map((check) => check.expect), ['fail', 'pass', 'pass', null, 'fail']);
    const human = run(record, ['handoff']);
    assert.match(human.stdout, /expect: fail; expectation met/);
    assert.match(human.stdout, /expect: pass; expectation not met/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S4-02: scenarios are entries with an optional validated criterion link', () => {
  const { dir, record } = setup();
  try {
    init(record);
    ok(run(record, ['add', 'criterion', '--text', 'Whitespace-only titles remain empty', '--json']), 'add');
    const linked = ok(run(record, ['add', 'scenario', '--text', 'Given a whitespace-only title, when normalizeTitle runs, then the result is empty', '--criterion', 'C1', '--json']), 'add');
    assert.equal(linked.entries[0].id, 'SC1');
    assert.equal(linked.entries[0].criterionId, 'C1');
    ok(run(record, ['add', 'scenario', '--text', 'Given a padded title, when normalizeTitle runs, then whitespace is trimmed', '--json']), 'add');
    // Validation: unknown criterion, criterion on a non-scenario kind, and repeated --criterion all fail.
    fail(run(record, ['add', 'scenario', '--text', 'x', '--criterion', 'C404', '--json']), 2, 'USAGE_ERROR');
    fail(run(record, ['add', 'plan', '--text', 'x', '--criterion', 'C1', '--json']), 2, 'USAGE_ERROR');
    fail(run(record, ['add', 'scenario', '--text', 'x', '--criterion', 'C1', '--criterion', 'C1', '--json']), 2, 'USAGE_ERROR');
    // Batch input: scenario may carry criterionId; other kinds may not.
    const batch = ok(run(record, ['add', '--stdin', '--json'], { input: JSON.stringify([
      { kind: 'scenario', text: 'Given a long title, when truncated, then it is at most 40 chars', criterionId: 'C1' },
      { kind: 'plan', text: 'Write the scenario test first' },
    ]) }), 'add');
    assert.equal(batch.entries[0].criterionId, 'C1');
    assert.equal(batch.entries[1].criterionId, null);
    fail(run(record, ['add', '--stdin', '--json'], { input: JSON.stringify([{ kind: 'plan', text: 'x', criterionId: 'C1' }]) }), 2, 'USAGE_ERROR');
    const h = handoff(record);
    assert.equal(h.scenarios.length, 3);
    assert.equal(h.scenarios[0].criterionId, 'C1');
    assert.equal(h.scenarios[1].criterionId, null);
    assert.deepEqual(h.qaCoverage.scenarios, { total: 3, linked: 2 });
    const human = run(record, ['handoff']);
    assert.match(human.stdout, /Scenarios \(BDD-style statements/);
    assert.match(human.stdout, /Criterion: C1/);
    assert.match(human.stdout, /Criterion: not linked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S4-02: a batch may create a criterion and a scenario linking it in the same call', () => {
  const { dir, record } = setup();
  try {
    init(record);
    // The link target is created earlier in the same batch, like question -> answer.
    const batch = ok(run(record, ['add', '--stdin', '--json'], { input: JSON.stringify([
      { kind: 'criterion', text: 'Titles are truncated to 40 characters' },
      { kind: 'scenario', text: 'Given a 50-character title, when saved, then only 40 characters remain', criterionId: 'C1' },
    ]) }), 'add');
    assert.equal(batch.entries[0].id, 'C1');
    assert.equal(batch.entries[1].criterionId, 'C1');
    const h = handoff(record);
    assert.equal(h.scenarios.length, 1);
    assert.equal(h.scenarios[0].criterionId, 'C1');
    assert.deepEqual(h.qaCoverage.scenarios, { total: 1, linked: 1 });
    // An unknown criterion in a batch still fails without writing.
    const before = JSON.parse(readFileSync(record, 'utf8'));
    fail(run(record, ['add', '--stdin', '--json'], { input: JSON.stringify([
      { kind: 'scenario', text: 'Given x, when y, then z', criterionId: 'C404' },
    ]) }), 2, 'USAGE_ERROR');
    assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S4-01/S4-02: schema 5 validation, upgrade from schema 4, and tamper rejection', () => {
  const base = newRecord('Unit check');
  assert.equal(base.schemaVersion, 5);
  assert.equal(decodeRecord(Buffer.from(JSON.stringify(base)), 'unit.json').schemaVersion, 5);
  assert.throws(() => decodeRecord(Buffer.from(JSON.stringify({ ...base, schemaVersion: 6 })), 'unit.json'), /schema version 6/);

  // A schema 4 record (no criterionId/expect keys) reads fine and upgrades to 5 on mutation.
  const grown = appendEntries(base, [{ kind: 'criterion', text: 'c', reason: null, questionId: null, criterionId: null }]).record;
  const v4 = JSON.parse(JSON.stringify(grown));
  v4.schemaVersion = 4;
  v4.entries = v4.entries.map(({ criterionId, ...entry }) => entry);
  assert.equal(decodeRecord(Buffer.from(JSON.stringify(v4)), 'unit.json').schemaVersion, 4);
  const reup = appendEntries(decodeRecord(Buffer.from(JSON.stringify(v4)), 'unit.json'), [{ kind: 'gap', text: 'g', reason: null, questionId: null, criterionId: null }]);
  assert.equal(reup.record.schemaVersion, 5);
  assert.ok(reup.record.entries.every((entry) => entry.criterionId === null));

  // Practices and scenarios are schema-5 only.
  const v4WithPractice = JSON.parse(JSON.stringify(v4));
  v4WithPractice.entries.push({ id: 'PR1', kind: 'practice', text: 'tdd', reason: null, questionId: null, createdAt: new Date().toISOString() });
  assert.throws(() => decodeRecord(Buffer.from(JSON.stringify(v4WithPractice)), 'unit.json'), /practices and scenarios require schema version 5/);

  // Tamper cases on a schema 5 record.
  const v5 = JSON.parse(JSON.stringify(reup.record));
  const withScenario = JSON.parse(JSON.stringify(v5));
  withScenario.entries.push({ id: 'SC1', kind: 'scenario', text: 'Given x, when y, then z', reason: null, questionId: null, criterionId: 'C404', createdAt: new Date().toISOString() });
  assert.throws(() => decodeRecord(Buffer.from(JSON.stringify(withScenario)), 'unit.json'), /scenario refers to a missing criterion/);
  const badLink = JSON.parse(JSON.stringify(v5));
  badLink.entries[0].criterionId = 'C1';
  assert.throws(() => decodeRecord(Buffer.from(JSON.stringify(badLink)), 'unit.json'), /unexpected criterion ID/);
  const badPractice = JSON.parse(JSON.stringify(v5));
  badPractice.entries.push({ id: 'PR1', kind: 'practice', text: 'xp', reason: null, questionId: null, criterionId: null, createdAt: new Date().toISOString() });
  assert.throws(() => decodeRecord(Buffer.from(JSON.stringify(badPractice)), 'unit.json'), /practice must be tdd or bdd/);

  // A check with an invalid expectation is rejected; a valid one survives pending -> outcome.
  const withCheck = addCheck(reup.record, {
    argv: ['node', '-e', ''], cwd: '/', criterionIds: ['C1'], revision: null, dirty: 'unknown',
    provenance: 'unknown', timeoutMs: 1000, captureOutput: true, outputRef: null, caseType: null, expect: 'fail',
  }).record;
  const stream = { bytes: 0, text: '', truncated: false };
  const completed = completeCheck(withCheck, {
    ...withCheck.checks[0], status: 'failed', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    exitCode: 1, signal: null, reason: 'command failed',
    output: { captured: true, limitBytesPerStream: OUTPUT_LIMIT_BYTES, encoding: 'utf8-lossy', stdout: stream, stderr: stream },
  });
  const view = makeHandoff(completed).checks[0];
  assert.equal(view.expect, 'fail');
  assert.equal(view.expectationMet, true);
  const tamperedExpect = JSON.parse(JSON.stringify(completed));
  tamperedExpect.checks[0].expect = 'maybe';
  assert.throws(() => decodeRecord(Buffer.from(JSON.stringify(tamperedExpect)), 'unit.json'), /invalid check expectation/);
});
