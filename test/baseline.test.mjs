// baseline.test.mjs
import test from 'node:test';
import { strict as assert } from 'assert';
import { validateBaseline } from '../dist/baseline.js';

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
