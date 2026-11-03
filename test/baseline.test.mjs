// baseline.test.mjs
import test from 'node:test';
import { strict as assert } from 'assert';
import { validateBaseline } from '../dist/baseline.js';
import { usageError } from '../dist/errors.js';

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

// Test that a valid empty record does not throw
await test('validateBaseline accepts minimal valid record', async () => {
  const rec = minimalRecord();
  assert.doesNotThrow(() => validateBaseline(rec, undefined, (msg) => { throw new Error(msg); }));
});

// Test that missing required arrays triggers corrupt error
await test('validateBaseline rejects missing arrays', async () => {
  const rec = {};
  let thrown = false;
  try {
    validateBaseline(rec, undefined, (msg) => { throw new Error(msg); });
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
    validateBaseline(rec, undefined, (msg) => { throw new Error(msg); });
  } catch (e) {
    thrown = true;
    assert.match(e.message, /invalid or duplicate revision ID/);
  }
  assert.ok(thrown);
});
