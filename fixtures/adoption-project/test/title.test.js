import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTitle } from '../src/title.js';

test('trims whitespace at the edges of a title', () => {
  assert.equal(normalizeTitle('  Sample note  '), 'Sample note');
});
