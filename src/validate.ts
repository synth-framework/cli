import { usageError } from './errors.js';

/** Shared record-validation helpers; every module validates with these so a
 * fix is made once. Behavior matches the previous per-module copies exactly. */

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Exact key set: no missing, no extra keys. */
export function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && Object.keys(value).every((key) => expected.includes(key));
}

/** Subset check: every present key is allowed, but keys may be missing. */
export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** Enum guard that never coerces: a non-string (even one with a hostile toString) is rejected. */
export function oneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === 'string' && allowed.includes(value);
}

export function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function optionalText(value: unknown): value is string | null {
  return value === null || nonblank(value);
}

export function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function optionalTimestamp(value: unknown): boolean {
  return value === null || timestamp(value);
}

export function validId(value: unknown, prefix: string): value is string {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return false;
  const suffix = value.slice(prefix.length);
  return /^[1-9][0-9]*$/.test(suffix) && Number.isSafeInteger(Number(suffix));
}

/** Non-negative safe integer counter. */
export function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Non-negative safe integer counter bounded by a current collection length. */
export function validCount(value: unknown, maximum: number): value is number {
  return count(value) && (value as number) <= maximum;
}

export function references(value: unknown, allowed: Set<string>, required = false, max = 100): value is string[] {
  return Array.isArray(value) && (!required || value.length > 0) && value.length <= max &&
    value.every((id) => typeof id === 'string' && allowed.has(id)) && new Set(value).size === value.length;
}

export function nextId(prefix: string, items: readonly { id: string }[]): string {
  let max = 0;
  for (const item of items) max = Math.max(max, Number(item.id.slice(prefix.length)));
  if (!Number.isSafeInteger(max + 1)) throw usageError(`No more ${prefix} IDs are available.`);
  return `${prefix}${max + 1}`;
}
