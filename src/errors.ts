export type ErrorCode =
  | 'USAGE_ERROR'
  | 'RECORD_NOT_FOUND'
  | 'RECORD_EXISTS'
  | 'RECORD_CORRUPT'
  | 'UNSUPPORTED_SCHEMA'
  | 'RECORD_LOCKED'
  | 'IO_ERROR'
  | 'INTERNAL_ERROR';

export class SynthError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = 'SynthError';
  }
}

export function usageError(message: string): SynthError {
  return new SynthError('USAGE_ERROR', message, 2);
}

export function ioError(action: string, location: string, error: unknown): SynthError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? ` (${error.code})`
      : '';
  return new SynthError(
    'IO_ERROR',
    `Could not ${action} "${location}"${code}. Check the path and permissions.`,
    3,
  );
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
