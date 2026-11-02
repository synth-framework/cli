import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { hasErrorCode } from './errors.js';

const MAX_SUBJECT_BYTES = 8 * 1024 * 1024;

export interface FileSnapshot {
  path: string;
  algorithm: 'sha256';
  digest: string | null;
  state: 'captured' | 'missing' | 'unavailable';
  reason: string | null;
  capturedAt: string;
}

export type Freshness = 'matching' | 'changed' | 'unknown';

export function isFileSnapshot(value: unknown): value is FileSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  const expected = ['path', 'algorithm', 'digest', 'state', 'reason', 'capturedAt'];
  if (Object.keys(snapshot).length !== expected.length || !Object.keys(snapshot).every((key) => expected.includes(key))) return false;
  if (typeof snapshot.path !== 'string' || !isAbsolute(snapshot.path) || snapshot.algorithm !== 'sha256') return false;
  if (typeof snapshot.capturedAt !== 'string') return false;
  const time = Date.parse(snapshot.capturedAt);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== snapshot.capturedAt) return false;
  if (snapshot.state === 'captured') return typeof snapshot.digest === 'string' && /^[0-9a-f]{64}$/.test(snapshot.digest) && snapshot.reason === null;
  return (snapshot.state === 'missing' || snapshot.state === 'unavailable') && snapshot.digest === null &&
    typeof snapshot.reason === 'string' && snapshot.reason.trim().length > 0;
}

/** Hash only a user-selected regular file, without following a final symlink. */
export function snapshotFile(inputPath: string): FileSnapshot {
  const path = resolve(inputPath);
  const capturedAt = new Date().toISOString();
  const unavailable = (state: 'missing' | 'unavailable', reason: string): FileSnapshot => ({
    path, algorithm: 'sha256', digest: null, state, reason, capturedAt,
  });
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) return unavailable('unavailable', 'not a regular file');
    if (before.size > BigInt(MAX_SUBJECT_BYTES)) return unavailable('unavailable', 'file exceeds the 8 MiB fingerprint limit');
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      return unavailable('unavailable', 'file changed while opening');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_SUBJECT_BYTES) return unavailable('unavailable', 'file exceeds the 8 MiB fingerprint limit');
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino ||
        opened.size !== after.size || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs) {
      return unavailable('unavailable', 'file changed while fingerprinting');
    }
    return { path, algorithm: 'sha256', digest: hash.digest('hex'), state: 'captured', reason: null, capturedAt };
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return unavailable('missing', 'file not found');
    return unavailable('unavailable', 'file could not be fingerprinted');
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* A fingerprint is only a best-effort observation. */ }
    }
  }
}

/** A match says only that this file's bytes match, not that the evidence is adequate. */
export function fileFreshness(snapshot: FileSnapshot | null): Freshness {
  if (snapshot === null || snapshot.state !== 'captured' || snapshot.digest === null) return 'unknown';
  const current = snapshotFile(snapshot.path);
  if (current.state === 'missing') return 'changed';
  if (current.state !== 'captured') return 'unknown';
  return current.digest === snapshot.digest ? 'matching' : 'changed';
}
