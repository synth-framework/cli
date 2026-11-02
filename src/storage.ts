import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { decodeRecord, type WorkRecord } from './domain.js';
import { SynthError, hasErrorCode, ioError, usageError } from './errors.js';

export const DEFAULT_RECORD = '.synth/work.json';

export function recordPath(explicitPath: string | undefined): string {
  if (explicitPath !== undefined && explicitPath.trim().length === 0) {
    throw usageError('--record must be a non-empty path.');
  }
  return resolve(process.cwd(), explicitPath ?? DEFAULT_RECORD);
}

function notFound(location: string): SynthError {
  return new SynthError(
    'RECORD_NOT_FOUND',
    `No work record at "${location}". Run synth init --intent <text>, or specify an existing record with --record.`,
    3,
  );
}

function alreadyExists(location: string): SynthError {
  return new SynthError(
    'RECORD_EXISTS',
    `A path already exists at "${location}". It was not overwritten; use another --record path or inspect it.`,
    3,
  );
}

function regularFileExists(location: string): boolean {
  try {
    const stat = lstatSync(location);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new SynthError('IO_ERROR', `"${location}" is not a regular record file; symlink targets are not supported.`, 3);
    }
    return true;
  } catch (error) {
    if (error instanceof SynthError) throw error;
    if (hasErrorCode(error, 'ENOENT')) return false;
    throw ioError('inspect', location, error);
  }
}

export function readRecord(location: string): WorkRecord {
  if (!regularFileExists(location)) throw notFound(location);
  let bytes: Buffer;
  try {
    bytes = readFileSync(location);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) throw notFound(location);
    throw ioError('read', location, error);
  }
  return decodeRecord(bytes, location);
}

/** A lock coordinates only writers that use the same path and honor this protocol. */
function withLock<T>(location: string, operation: () => T): T {
  const lockPath = `${location}.lock`;
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      throw new SynthError(
        'RECORD_LOCKED',
        `A writer lock exists at "${lockPath}". Verify that no writer is using this record before removing the lock manually; a PID alone is not proof that it is stale.`,
        3,
      );
    }
    if (hasErrorCode(error, 'ENOENT')) throw notFound(location);
    throw ioError('create writer lock', lockPath, error);
  }

  let result: T | undefined;
  let operationError: unknown;
  try {
    try {
      writeFileSync(
        descriptor,
        `${JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() })}\n`,
        'utf8',
      );
      fsyncSync(descriptor);
    } catch (error) {
      throw ioError('write writer lock', lockPath, error);
    }
    result = operation();
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  let sameLock = false;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const current = lstatSync(lockPath, { bigint: true });
    sameLock = opened.dev === current.dev && opened.ino === current.ino;
    if (!sameLock) cleanupError = new Error('lock changed while in use');
  } catch (error) {
    cleanupError = error;
  }
  try {
    closeSync(descriptor);
  } catch (error) {
    cleanupError ??= error;
  }
  if (sameLock) {
    try {
      unlinkSync(lockPath);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (cleanupError !== undefined) {
    throw new SynthError(
      'IO_ERROR',
      `Could not safely clean up writer lock "${lockPath}". The record may have been saved; inspect both before retrying.`,
      3,
    );
  }
  if (operationError !== undefined) throw operationError;
  return result as T;
}

/** Write in the target directory so replacement is atomic on supported local filesystems. */
function writeAtomic(location: string, record: WorkRecord, createOnly: boolean): void {
  let contents: string;
  try {
    contents = `${JSON.stringify(record, null, 2)}\n`;
    decodeRecord(Buffer.from(contents, 'utf8'), location);
  } catch {
    throw new SynthError('INTERNAL_ERROR', 'Refusing to save invalid generated state; the existing record was not changed.', 1);
  }
  const temporary = join(dirname(location), `.${basename(location)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let temporaryExists = false;
  let committed = false;
  let operationError: unknown;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    temporaryExists = true;
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (createOnly) {
      // Linking fails if any file appeared at the destination, including a symlink.
      linkSync(temporary, location);
    } else {
      renameSync(temporary, location);
      temporaryExists = false;
    }
    committed = true;
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (temporaryExists) {
    try {
      unlinkSync(temporary);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (cleanupError !== undefined) {
    throw new SynthError(
      'IO_ERROR',
      `The record ${committed ? 'was saved' : 'was not saved'}, but temporary file "${temporary}" could not be cleaned up. Inspect it before retrying.`,
      3,
    );
  }
  if (operationError !== undefined) {
    if (createOnly && hasErrorCode(operationError, 'EEXIST')) throw alreadyExists(location);
    if (operationError instanceof SynthError) throw operationError;
    throw ioError('write work record', location, operationError);
  }
}

export function initializeRecord(location: string, record: WorkRecord): void {
  try {
    mkdirSync(dirname(location), { recursive: true, mode: 0o700 });
  } catch (error) {
    throw ioError('create the record directory for', location, error);
  }
  withLock(location, () => {
    try {
      lstatSync(location);
      throw alreadyExists(location);
    } catch (error) {
      if (error instanceof SynthError) throw error;
      if (!hasErrorCode(error, 'ENOENT')) throw ioError('inspect', location, error);
    }
    writeAtomic(location, record, true);
  });
}

export function updateRecord<T>(
  location: string,
  update: (record: WorkRecord) => { record: WorkRecord; result: T },
): T {
  return withLock(location, () => {
    const existing = readRecord(location);
    const next = update(existing);
    writeAtomic(location, next.record, false);
    return next.result;
  });
}
