import { DuplicateError, InUseError } from '../errors.js';

const UNIQUE_CODES = new Set([2067, 1555]); // SQLITE_CONSTRAINT_UNIQUE, SQLITE_CONSTRAINT_PRIMARYKEY
const FK_CODE = 787; // SQLITE_CONSTRAINT_FOREIGNKEY

export function isUnique(e) {
  return !!e && (UNIQUE_CODES.has(e.errcode) || /UNIQUE constraint failed/i.test(String(e.message)));
}
export function isForeignKey(e) {
  return !!e && (e.errcode === FK_CODE || /FOREIGN KEY constraint failed/i.test(String(e.message)));
}

/**
 * Translate a driver error. `unique` / `inUse` are messages for DuplicateError / InUseError;
 * `missing` is a message for a plain Error when an insert/update points at a row that does not exist.
 */
export function translate(e, { unique, inUse, missing } = {}) {
  if (unique && isUnique(e)) return new DuplicateError(unique);
  if (inUse && isForeignKey(e)) return new InUseError(inUse);
  if (missing && isForeignKey(e)) return new Error(missing);
  return e;
}

export const id = (r) => Number(r.lastInsertRowid);
export const changed = (r) => Number(r.changes) > 0;
export const num = (v) => Number(v ?? 0);
