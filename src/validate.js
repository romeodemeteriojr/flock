// A tiny schema validator with plain-English messages.
//
//   const schema = v.object({ name: v.string({ min: 1, max: 100 }), date: v.date() }, { strict: true });
//   const clean = parse(schema, body); // throws ValidationError('Name is required')
//
// Field labels come from the key ('firstName' -> 'First name') or `.label('...')`.
import { ValidationError } from './errors.js';

const MISSING = Symbol('missing');
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function humanize(key) {
  const s = String(key)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Value';
}

function fail(label, path, message) {
  throw new ValidationError(`${label} ${message}.`, { details: { field: path.join('.') || null } });
}

function clone(x) {
  return x !== null && typeof x === 'object' ? structuredClone(x) : x;
}

function short(k) {
  const s = String(k).replace(/[^\x20-\x7e]/g, '?');
  return s.length > 30 ? `${s.slice(0, 30)}...` : s;
}

class Schema {
  constructor(check, opts = {}) {
    this._check = check;
    this._optional = opts.optional ?? false;
    this._nullable = opts.nullable ?? false;
    this._default = Object.hasOwn(opts, 'default') ? opts.default : MISSING;
    this._label = opts.label;
  }

  _with(changes) {
    return new Schema(this._check, {
      optional: this._optional, nullable: this._nullable, label: this._label,
      ...(this._default === MISSING ? {} : { default: this._default }),
      ...changes,
    });
  }

  optional() { return this._with({ optional: true }); }
  nullable() { return this._with({ nullable: true }); }
  default(value) { return this._with({ default: value }); }
  label(text) { return this._with({ label: String(text) }); }

  // Returns MISSING when the value is absent and optional (the key is then left out).
  _run(value, label, path) {
    const name = this._label ?? label;
    if (value === null && this._nullable) return null;
    if (value === undefined || value === null) {
      if (this._default !== MISSING) return this._default === undefined ? MISSING : clone(this._default);
      if (this._optional) return MISSING;
      fail(name, path, 'is required');
    }
    return this._check(value, name, path, this);
  }
}

function string({ min, max, trim = true, pattern, patternMessage } = {}) {
  return new Schema((value, label, path, self) => {
    if (typeof value !== 'string') fail(label, path, 'must be text');
    const s = trim ? value.trim() : value;
    if (s.length === 0 && (min ?? 0) > 0) {
      if (self._default !== MISSING) return self._default === undefined ? MISSING : clone(self._default);
      if (self._optional) return MISSING;
      fail(label, path, 'is required');
    }
    if (min !== undefined && s.length < min) fail(label, path, `must be at least ${min} characters`);
    if (max !== undefined && s.length > max) fail(label, path, `must be at most ${max} characters`);
    if (pattern && !pattern.test(s)) fail(label, path, patternMessage ?? 'is not in the right format');
    return s;
  });
}

function integer({ min, max } = {}) {
  return new Schema((value, label, path) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail(label, path, 'must be a whole number');
    if (min !== undefined && value < min) fail(label, path, `must be at least ${min}`);
    if (max !== undefined && value > max) fail(label, path, `must be at most ${max}`);
    return value;
  });
}

function boolean() {
  return new Schema((value, label, path) => {
    if (typeof value !== 'boolean') fail(label, path, 'must be true or false');
    return value;
  });
}

function enumOf(values) {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError('v.enum needs a list of values');
  const allowed = [...values];
  return new Schema((value, label, path) => {
    if (!allowed.includes(value)) fail(label, path, `must be one of: ${allowed.join(', ')}`);
    return value;
  });
}

export function isRealDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function date() {
  return new Schema((value, label, path) => {
    if (!isRealDate(value)) fail(label, path, 'must be a real date like 2026-11-08');
    return value;
  });
}

function time() {
  return new Schema((value, label, path) => {
    if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      fail(label, path, 'must be a time like 09:30');
    }
    return value;
  });
}

function array(item, { min, max } = {}) {
  if (!(item instanceof Schema)) throw new TypeError('v.array needs an item schema');
  return new Schema((value, label, path) => {
    if (!Array.isArray(value)) fail(label, path, 'must be a list');
    if (min !== undefined && value.length < min) fail(label, path, `must have at least ${min} item${min === 1 ? '' : 's'}`);
    if (max !== undefined && value.length > max) fail(label, path, `must have at most ${max} item${max === 1 ? '' : 's'}`);
    const out = [];
    for (let i = 0; i < value.length; i++) {
      const r = item._run(value[i], `${label} item ${i + 1}`, [...path, i]);
      if (r !== MISSING) out.push(r); // absent optional items are dropped
    }
    return out;
  });
}

function object(shape, { strict = false } = {}) {
  if (!shape || typeof shape !== 'object') throw new TypeError('v.object needs a shape');
  const keys = Object.keys(shape);
  for (const k of keys) {
    if (BAD_KEYS.has(k)) throw new TypeError(`v.object cannot use the key "${k}"`);
    if (!(shape[k] instanceof Schema)) throw new TypeError(`v.object: "${k}" is not a schema`);
  }
  return new Schema((value, label, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(label, path, 'must be an object');
    if (strict) {
      const unknown = Object.keys(value).filter((k) => !Object.hasOwn(shape, k));
      if (unknown.length) {
        const list = unknown.slice(0, 5).map(short).join(', ') + (unknown.length > 5 ? ', ...' : '');
        const where = path.length ? ` in ${label}` : '';
        throw new ValidationError(`Unknown field${unknown.length === 1 ? '' : 's'}${where}: ${list}`, {
          details: { field: path.join('.') || null, unknown: unknown.slice(0, 5).map(short) },
        });
      }
    }
    const out = {};
    for (const k of keys) {
      const raw = Object.hasOwn(value, k) ? value[k] : undefined;
      const r = shape[k]._run(raw, humanize(k), [...path, k]);
      if (r !== MISSING) out[k] = r;
    }
    return out;
  });
}

export const v = { string, integer, boolean, enum: enumOf, date, time, array, object };

export function parse(schema, input, label = 'The request') {
  if (!(schema instanceof Schema)) throw new TypeError('parse needs a schema');
  const r = schema._run(input, label, []);
  return r === MISSING ? undefined : r;
}

// A name someone types for a person, team or position: text, trimmed, at most
// `max` characters, no control characters (a NUL, a line break), and at least
// one character you can see. Zero-width and other invisible characters on
// their own (U+200B, U+3164 and friends) would show as a blank name.
const CONTROL = /\p{Cc}/u;
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{Z}ᅟᅠㅤﾠ⠀]/gu;
export function checkName(value, { max }) {
  if (typeof value !== 'string' || !value.replace(INVISIBLE, '')) throw new ValidationError('Please type a name.');
  const name = value.trim();
  if (CONTROL.test(name)) throw new ValidationError('The name cannot contain control characters.');
  if (name.length > max) throw new ValidationError(`The name must be ${max} characters or fewer.`);
  return name;
}
