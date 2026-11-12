import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AppError, ValidationError, UnauthenticatedError, ForbiddenError, NotFoundError, ConflictError, TooManyRequestsError,
} from '../src/errors.js';
import { v, parse } from '../src/validate.js';
import { systemClock, fixedClock } from '../src/infra/clock.js';
import { secureRandom, seededRandom } from '../src/infra/random.js';
import { scryptHasher, fastHasher } from '../src/infra/hasher.js';
import { createLogger, silentLogger } from '../src/infra/logger.js';
import { loadConfig, validateConfig, ConfigError, VERSION } from '../src/config.js';
import { createRouter, mapError } from '../src/http.js';

// ---------- errors ----------

test('error classes have the right status and code', () => {
  const cases = [
    [new ValidationError('Name is required'), 400, 'validation_error'],
    [new UnauthenticatedError(), 401, 'unauthenticated'],
    [new ForbiddenError(), 403, 'forbidden'],
    [new NotFoundError(), 404, 'not_found'],
    [new ConflictError('That name is taken', 'duplicate_name'), 409, 'duplicate_name'],
    [new TooManyRequestsError('Slow down', 30), 429, 'too_many_requests'],
  ];
  for (const [err, status, code] of cases) {
    assert.ok(err instanceof AppError, err.name);
    assert.ok(err instanceof Error, err.name);
    assert.equal(err.status, status, err.name);
    assert.equal(err.code, code, err.name);
    assert.equal(typeof err.message, 'string');
    assert.ok(err.message.length > 0);
  }
  assert.equal(new UnauthenticatedError().message, 'Please log in');
  assert.equal(new NotFoundError().message, 'Not found');
  assert.equal(new ConflictError('x').code, 'conflict');
  assert.equal(new TooManyRequestsError('Slow down', 30).retryAfterSec, 30);
  assert.equal(new TooManyRequestsError('Slow down', 2.2).retryAfterSec, 3);
  assert.equal(new TooManyRequestsError('Slow down', -5).retryAfterSec, 1);
  const f = new ForbiddenError('Operation not allowed', { code: 'operation_forbidden', details: { a: 1 } });
  assert.equal(f.code, 'operation_forbidden');
  assert.deepEqual(f.details, { a: 1 });
  const base = new AppError(418, 'teapot', 'I am a teapot', { x: 1 });
  assert.equal(base.status, 418);
  assert.equal(base.code, 'teapot');
  assert.deepEqual(base.details, { x: 1 });
  assert.equal(new ValidationError('x').name, 'ValidationError');
});

// ---------- validator ----------

function message(fn) {
  try { fn(); } catch (e) { assert.ok(e instanceof ValidationError, `expected ValidationError, got ${e}`); return e.message; }
  assert.fail('expected a ValidationError');
}

test('validator: valid values pass and strings are trimmed', () => {
  const schema = v.object({
    name: v.string({ min: 1, max: 20 }),
    age: v.integer({ min: 0, max: 120 }),
    admin: v.boolean(),
    role: v.enum(['admin', 'volunteer']),
    date: v.date(),
    time: v.time(),
    tags: v.array(v.string({ max: 5 }), { max: 3 }),
  });
  const out = parse(schema, {
    name: '  Ann Example  ', age: 40, admin: false, role: 'volunteer', date: '2026-11-08', time: '09:30', tags: [' a ', 'b'],
  });
  assert.deepEqual(out, {
    name: 'Ann Example', age: 40, admin: false, role: 'volunteer', date: '2026-11-08', time: '09:30', tags: ['a', 'b'],
  });
  assert.equal(parse(v.string({ trim: false }), '  x '), '  x ');
});

test('validator: messages name the field in plain English', () => {
  const schema = v.object({ name: v.string({ min: 1 }), firstName: v.string().optional(), serviceDate: v.date().optional() });
  assert.equal(message(() => parse(schema, {})), 'Name is required');
  assert.equal(message(() => parse(schema, { name: '   ' })), 'Name is required');
  assert.equal(message(() => parse(schema, { name: null })), 'Name is required');
  assert.equal(message(() => parse(schema, { name: 5 })), 'Name must be text');
  assert.equal(message(() => parse(schema, { name: 'a', firstName: 1 })), 'First name must be text');
  assert.equal(message(() => parse(schema, { name: 'a', serviceDate: '2026-02-30' })),
    'Service date must be a real date like 2026-11-08');
  assert.equal(message(() => parse(v.object({ date: v.date() }), { date: 'tomorrow' })), 'Date must be a real date like 2026-11-08');
  assert.equal(message(() => parse(schema, 'nope')), 'The request must be an object');
  assert.equal(message(() => parse(schema, [])), 'The request must be an object');
  assert.equal(message(() => parse(v.object({ n: v.string().label('Team name') }), {})), 'Team name is required');
  const e = (() => { try { parse(schema, { name: 'a', serviceDate: 'x' }); } catch (err) { return err; } })();
  assert.equal(e.status, 400);
  assert.deepEqual(e.details, { field: 'serviceDate' });
});

test('validator: boundaries', () => {
  const s = v.string({ min: 2, max: 4 });
  assert.equal(parse(s, 'ab'), 'ab');
  assert.equal(parse(s, 'abcd'), 'abcd');
  assert.equal(message(() => parse(s, 'a')), 'The request must be at least 2 characters');
  assert.equal(message(() => parse(s, 'abcde')), 'The request must be at most 4 characters');
  const i = v.object({ count: v.integer({ min: 1, max: 10 }) });
  assert.deepEqual(parse(i, { count: 1 }), { count: 1 });
  assert.deepEqual(parse(i, { count: 10 }), { count: 10 });
  assert.equal(message(() => parse(i, { count: 0 })), 'Count must be at least 1');
  assert.equal(message(() => parse(i, { count: 11 })), 'Count must be at most 10');
  assert.equal(message(() => parse(i, { count: 1.5 })), 'Count must be a whole number');
  assert.equal(message(() => parse(i, { count: '3' })), 'Count must be a whole number');
  assert.equal(message(() => parse(i, { count: NaN })), 'Count must be a whole number');
  const a = v.object({ ids: v.array(v.integer(), { min: 1, max: 2 }) });
  assert.deepEqual(parse(a, { ids: [1, 2] }), { ids: [1, 2] });
  assert.equal(message(() => parse(a, { ids: [] })), 'Ids must have at least 1 item');
  assert.equal(message(() => parse(a, { ids: [1, 2, 3] })), 'Ids must have at most 2 items');
  assert.equal(message(() => parse(a, { ids: 'x' })), 'Ids must be a list');
  assert.equal(message(() => parse(a, { ids: [1, 'x'] })), 'Ids item 2 must be a whole number');
  const p = v.object({ code: v.string({ pattern: /^[A-Z]{3}$/ }) });
  assert.deepEqual(parse(p, { code: 'ABC' }), { code: 'ABC' });
  assert.equal(message(() => parse(p, { code: 'abc' })), 'Code is not in the right format');
});

test('validator: booleans, enums, dates and times', () => {
  const b = v.object({ on: v.boolean() });
  assert.equal(message(() => parse(b, { on: 'true' })), 'On must be true or false');
  const e = v.object({ role: v.enum(['admin', 'volunteer']) });
  assert.equal(message(() => parse(e, { role: 'boss' })), 'Role must be one of: admin, volunteer');
  for (const good of ['2026-11-08', '2024-02-29', '2026-12-31', '2026-01-01']) assert.equal(parse(v.date(), good), good);
  for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-1-1', '2026-11-08T00:00', 20261108, '']) {
    assert.throws(() => parse(v.date(), bad), ValidationError, String(bad));
  }
  for (const good of ['00:00', '09:30', '23:59']) assert.equal(parse(v.time(), good), good);
  for (const bad of ['24:00', '9:30', '12:60', '12:30:00', 930]) {
    assert.throws(() => parse(v.time(), bad), ValidationError, String(bad));
  }
  assert.equal(message(() => parse(v.object({ start: v.time() }), { start: '25:00' })), 'Start must be a time like 09:30');
});

test('validator: optional and default', () => {
  const schema = v.object({
    note: v.string().optional(),
    count: v.integer().default(3),
    tags: v.array(v.string()).default([]),
    title: v.string({ min: 1 }).optional(),
  });
  const out = parse(schema, { title: '   ' });
  assert.deepEqual(out, { count: 3, tags: [] });
  assert.ok(!('note' in out));
  assert.ok(!('title' in out));
  assert.deepEqual(parse(schema, { note: ' hi ', count: 5, tags: ['x'] }), { note: 'hi', count: 5, tags: ['x'] });
  // defaults are copied, never shared
  const a = parse(schema, {});
  a.tags.push('changed');
  assert.deepEqual(parse(schema, {}).tags, []);
  // the base schema is not changed by .optional()
  const base = v.string({ min: 1 });
  base.optional();
  assert.throws(() => parse(v.object({ x: base }), {}), ValidationError);
  assert.equal(parse(v.string().nullable(), null), null);
  assert.deepEqual(parse(v.object({ x: v.string().default(null) }), {}), { x: null });
  assert.deepEqual(parse(v.object({ x: v.string().default(undefined) }), {}), {});
  assert.deepEqual(parse(v.array(v.integer().optional()), [1, null, 2]), [1, 2]);
});

test('validator: strict mode rejects unknown keys; loose mode drops them', () => {
  const loose = v.object({ name: v.string() });
  const strict = v.object({ name: v.string() }, { strict: true });
  assert.deepEqual(parse(loose, { name: 'a', extra: 1 }), { name: 'a' });
  assert.equal(message(() => parse(strict, { name: 'a', extra: 1 })), 'Unknown field: extra');
  assert.equal(message(() => parse(strict, { name: 'a', x: 1, y: 2 })), 'Unknown fields: x, y');
  const nested = v.object({ slot: v.object({ id: v.integer() }, { strict: true }) });
  assert.equal(message(() => parse(nested, { slot: { id: 1, bad: 2 } })), 'Unknown field in Slot: bad');
});

test('validator: never returns prototype-polluting keys', () => {
  const loose = v.object({ name: v.string() });
  const strict = v.object({ name: v.string() }, { strict: true });
  for (const raw of ['{"name":"a","__proto__":{"admin":true}}', '{"name":"a","constructor":{"prototype":{"admin":true}}}', '{"name":"a","prototype":1}']) {
    const input = JSON.parse(raw);
    const out = parse(loose, input);
    assert.deepEqual(Object.keys(out), ['name']);
    assert.equal(out.admin, undefined);
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.equal({}.admin, undefined);
    assert.throws(() => parse(strict, input), ValidationError);
  }
  const nested = parse(v.object({ list: v.array(v.object({ n: v.integer() })) }), JSON.parse('{"list":[{"n":1,"__proto__":{"x":1}}]}'));
  assert.deepEqual(Object.keys(nested.list[0]), ['n']);
  assert.equal(nested.list[0].x, undefined);
  const protoShape = Object.defineProperty({}, '__proto__', { value: v.string(), enumerable: true });
  assert.throws(() => v.object(protoShape), TypeError);
  assert.throws(() => v.object({ constructor: v.string() }), TypeError);
});

// ---------- clock and random ----------

test('clocks: fixed clock advances; system clock is current', () => {
  const c = fixedClock('2026-11-08T09:00:00.000Z');
  const t1 = c.now();
  assert.ok(t1 instanceof Date);
  assert.equal(t1.toISOString(), '2026-11-08T09:00:00.000Z');
  t1.setFullYear(2000); // callers cannot change the clock through the returned Date
  assert.equal(c.now().toISOString(), '2026-11-08T09:00:00.000Z');
  assert.equal(c.advance(90_000), c);
  assert.equal(c.now().toISOString(), '2026-11-08T09:01:30.000Z');
  c.advance(24 * 3600 * 1000);
  assert.equal(c.now().toISOString(), '2026-11-09T09:01:30.000Z');
  assert.equal(fixedClock(new Date('2026-01-01T00:00:00Z')).now().toISOString(), '2026-01-01T00:00:00.000Z');
  assert.throws(() => fixedClock('not a date'), TypeError);
  const s = systemClock().now();
  assert.ok(s instanceof Date);
  assert.ok(Math.abs(s.getTime() - Date.now()) < 5000);
});

test('random: seeded is deterministic; tokens are base64url; int stays in bounds', () => {
  const a = seededRandom('seed-1');
  const b = seededRandom('seed-1');
  const c = seededRandom('seed-2');
  const seqA = [a.token(), a.int(1000), a.bytes(7).toString('hex')];
  const seqB = [b.token(), b.int(1000), b.bytes(7).toString('hex')];
  const seqC = [c.token(), c.int(1000), c.bytes(7).toString('hex')];
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  for (const r of [secureRandom(), seededRandom(42)]) {
    const t = r.token();
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    assert.match(r.token(12), /^[A-Za-z0-9_-]{16}$/);
    assert.equal(r.bytes(16).length, 16);
    assert.ok(Buffer.isBuffer(r.bytes(3)));
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
      const n = r.int(6);
      assert.ok(Number.isInteger(n) && n >= 0 && n < 6, String(n));
      seen.add(n);
    }
    assert.equal(seen.size, 6);
    assert.equal(r.int(1), 0);
    assert.throws(() => r.int(0), RangeError);
    assert.throws(() => r.int(1.5), RangeError);
    assert.throws(() => r.bytes(-1), RangeError);
  }
  assert.notEqual(secureRandom().token(), secureRandom().token());
});

// ---------- hashers ----------

test('scrypt hasher: format, verify right and wrong, malformed stored values', async () => {
  const h = scryptHasher();
  const stored = await h.hash('correct horse battery');
  assert.match(stored, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/);
  assert.notEqual(stored, await h.hash('correct horse battery')); // salted
  assert.equal(await h.verify('correct horse battery', stored), true);
  assert.equal(await h.verify('wrong horse', stored), false);
  for (const bad of [undefined, null, '', 'nope', 'scrypt$1$8$1$abc$def', 'scrypt$16384$8$1$!!$??',
    'scrypt$999999999$8$1$c2FsdHNhbHQ=$aGFzaGhhc2hoYXNoaGFzaA==', stored.replace('scrypt', 'bcrypt'), `${stored}$x`]) {
    assert.equal(await h.verify('correct horse battery', bad), false, String(bad));
  }
  assert.equal(await h.verify(123, stored), false);
  // stored values asking for absurd memory are refused without running scrypt
  assert.equal(await h.verify('x', 'scrypt$1048576$32$16$c2FsdHNhbHQ=$aGFzaGhhc2hoYXNoaGFzaA=='), false);
  await assert.rejects(() => h.hash(5), TypeError);
});

test('fast hasher: works for tests and refuses production', async () => {
  const h = fastHasher({ env: {} });
  assert.equal(h.testOnly, true);
  const stored = await h.hash('pw-123456');
  assert.equal(await h.verify('pw-123456', stored), true);
  assert.equal(await h.verify('pw-nope', stored), false);
  assert.equal(await h.verify('pw-123456', 'garbage'), false);
  assert.equal(await h.verify('pw-123456', 'fast$s1$zz'), false);
  assert.equal(await h.verify('pw-123456', null), false);
  assert.throws(() => fastHasher({ env: { NODE_ENV: 'production' } }), /tests only/);
  // a hasher created earlier also refuses once the environment says production
  const env = {};
  const late = fastHasher({ env });
  env.NODE_ENV = 'production';
  await assert.rejects(() => late.hash('x'), /tests only/);
  await assert.rejects(() => late.verify('x', stored), /tests only/);
  // default reads process.env
  const old = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { assert.throws(() => fastHasher(), /tests only/); } finally {
    if (old === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old;
  }
});

// ---------- logger ----------

function captureLogger(opts = {}) {
  const lines = [];
  const logger = createLogger({ clock: fixedClock('2026-11-08T09:00:00.000Z'), write: (l) => lines.push(l), ...opts });
  return { logger, lines, entries: () => lines.map((l) => JSON.parse(l)) };
}

test('logger: one JSON line per event with time, level, msg and fields', () => {
  const { logger, lines, entries } = captureLogger();
  logger.info('hello', { a: 1, nested: { b: 'x' } });
  logger.warn('careful');
  logger.debug('hidden at info level');
  assert.equal(lines.length, 2);
  for (const l of lines) assert.ok(!l.includes('\n'));
  assert.deepEqual(entries(), [
    { time: '2026-11-08T09:00:00.000Z', level: 'info', msg: 'hello', a: 1, nested: { b: 'x' } },
    { time: '2026-11-08T09:00:00.000Z', level: 'warn', msg: 'careful' },
  ]);
  // fields cannot overwrite the core keys
  logger.error('boom', { level: 'debug', time: 'x', msg: 'y' });
  assert.deepEqual(entries()[2], { time: '2026-11-08T09:00:00.000Z', level: 'error', msg: 'boom' });
  const dbg = captureLogger({ level: 'debug' });
  dbg.logger.debug('shown');
  assert.equal(dbg.lines.length, 1);
  assert.throws(() => createLogger({ level: 'loud' }));
});

test('logger: deep redaction of secrets', () => {
  const { logger, lines, entries } = captureLogger();
  logger.info('login', {
    email: 'ann@example.com',
    password: 'hunter2-secret',
    newPassword: 'n3w-secret',
    sessionToken: 'tok-abc',
    headers: { cookie: 'flock_session=cookie-value', Authorization: 'Bearer auth-value', 'set-cookie': ['a=cookie2'] },
    person: { name: 'Ann', password_hash: 'scrypt$hash-value', apiSecret: 'sec-value' },
    list: [{ token: 'tok-in-list' }],
    device: { endpoint: 'https://fcm.googleapis.com/fcm/send/ep-value', p256dh: 'p256-value', auth: 'auth-secret-value', host: 'fcm.googleapis.com' },
    push: { privateKey: 'vapid-private-value' },
  });
  const text = lines.join('\n');
  for (const s of ['hunter2-secret', 'n3w-secret', 'tok-abc', 'cookie-value', 'auth-value', 'cookie2', 'hash-value', 'sec-value', 'tok-in-list', 'ep-value', 'p256-value', 'auth-secret-value', 'vapid-private-value']) {
    assert.ok(!text.includes(s), s);
  }
  const e = entries()[0];
  assert.equal(e.email, 'ann@example.com');
  assert.equal(e.password, '[REDACTED]');
  assert.equal(e.headers.cookie, '[REDACTED]');
  assert.equal(e.headers.Authorization, '[REDACTED]');
  assert.equal(e.person.name, 'Ann');
  assert.equal(e.person.password_hash, '[REDACTED]');
  assert.equal(e.list[0].token, '[REDACTED]');
  assert.equal(e.device.host, 'fcm.googleapis.com', 'the push host is fine to log');
  // circular values and errors do not break logging
  const circ = { a: 1 };
  circ.self = circ;
  const err = new Error('bad thing');
  err.token = 'err-token';
  logger.error('oops', { circ, err });
  const last = entries().at(-1);
  assert.equal(last.circ.self, '[Circular]');
  assert.equal(last.err.message, 'bad thing');
  assert.equal(last.err.token, '[REDACTED]');
});

test('logger: child adds fields; silent logger does nothing', () => {
  const { logger, entries } = captureLogger();
  const child = logger.child({ requestId: 'r-1', password: 'x' });
  child.info('step', { n: 1 });
  child.child({ userId: 7 }).info('deeper');
  logger.info('parent');
  const [a, b, c] = entries();
  assert.equal(a.requestId, 'r-1');
  assert.equal(a.password, '[REDACTED]');
  assert.equal(a.n, 1);
  assert.equal(b.requestId, 'r-1');
  assert.equal(b.userId, 7);
  assert.equal(c.requestId, undefined);
  const s = silentLogger();
  for (const m of ['debug', 'info', 'warn', 'error']) assert.equal(s[m]('x', { a: 1 }), undefined);
  assert.equal(typeof s.child({}).info, 'function');
});

// ---------- config ----------

test('validateConfig accepts the defaults and lists every problem together', () => {
  assert.deepEqual(validateConfig(loadConfig({})), loadConfig({}));
  const good = loadConfig({});
  assert.doesNotThrow(() => validateConfig({ ...good, port: 0 }));
  assert.doesNotThrow(() => validateConfig({ ...good, port: 65535, sessionDays: 90, unansweredDays: 0 }));
  assert.doesNotThrow(() => validateConfig({ ...good, sessionDays: 1, unansweredDays: 30 }));
  let err;
  try {
    validateConfig({ port: 70000, dbPath: '', sessionDays: 0, unansweredDays: 31, secureCookies: 'yes' });
  } catch (e) { err = e; }
  assert.ok(err instanceof ConfigError);
  assert.equal(err.problems.length, 5);
  for (const word of ['port', 'dbPath', 'sessionDays', 'unansweredDays', 'secureCookies']) {
    assert.ok(err.message.includes(word), word);
  }
  assert.match(err.message, /5 problems/);
  assert.throws(() => validateConfig({ ...good, sessionDays: 91 }), /sessionDays/);
  assert.throws(() => validateConfig({ ...good, port: -1 }), /port/);
  assert.throws(() => validateConfig({ ...good, port: 80.5 }), /port/);
  assert.throws(() => validateConfig({ ...good, dbPath: undefined }), /dbPath/);
  assert.throws(() => validateConfig(null), ConfigError);
  const one = (() => { try { validateConfig({ ...good, unansweredDays: -1 }); } catch (e) { return e; } })();
  assert.equal(one.problems.length, 1);
  assert.match(one.message, /a problem/);
});

test('FLOCK_PUBLIC_URL is a clean HTTP base URL, never credentials or a fragment', () => {
  assert.equal(loadConfig({ FLOCK_PUBLIC_URL: ' https://flock.example.org/// ' }).publicUrl, 'https://flock.example.org');
  assert.equal(loadConfig({}).publicUrl, undefined);
  for (const value of ['ftp://x', 'not a url', 'https://user:password@example.org', 'https://x.org/?query=1', 'https://x.org/#fragment']) {
    assert.throws(() => loadConfig({ FLOCK_PUBLIC_URL: value }), (e) => e instanceof ConfigError && e.message.includes('FLOCK_PUBLIC_URL'));
  }
});

// ---------- HTTP: error mapper, request ids, request log ----------

class DuplicateError extends Error { constructor(m) { super(m); this.name = 'DuplicateError'; } }
class InUseError extends Error { constructor(m) { super(m); this.name = 'InUseError'; } }

async function withLoggedApp(fn, { random } = {}) {
  const lines = [];
  const clock = fixedClock('2026-11-08T09:00:00.000Z');
  const logger = createLogger({ clock, write: (l) => lines.push(l) });
  const { createApp } = await import('../src/server.js');
  const { DatabaseSync } = await import('node:sqlite');
  const app = createApp({ db: new DatabaseSync(':memory:'), now: () => clock.now(), config: loadConfig({}), logger, clock, random });
  const r = app.router;
  const add = (method, p, h) => r.add(method, p, h, { auth: 'none' });
  add('GET', '/api/t/validation', () => { throw new ValidationError('Name is required'); });
  add('GET', '/api/t/unauth', () => { throw new UnauthenticatedError(); });
  add('GET', '/api/t/forbidden', () => { throw new ForbiddenError('Operation not allowed', 'operation_forbidden'); });
  add('GET', '/api/t/notfound', () => { throw new NotFoundError('That person does not exist'); });
  add('GET', '/api/t/conflict', () => { throw new ConflictError('That name is already taken', 'duplicate_name'); });
  add('GET', '/api/t/limit', () => { throw new TooManyRequestsError('Too many tries', 42); });
  add('GET', '/api/t/dup', () => { throw new DuplicateError('A team with that name already exists'); });
  add('GET', '/api/t/inuse', () => { throw new InUseError('That position is still used'); });
  add('GET', '/api/t/boom', () => { const e = new Error('secret detail password=hunter2'); throw e; });
  add('POST', '/api/t/secret', ({ body }) => ({ status: 200, json: { ok: !!body.password } }));
  add('GET', '/api/t/ok', () => ({ status: 200, json: { ok: true } }));
  const port = await app.listen(0);
  const http = await import('node:http');
  function request(method, p, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const h = { ...headers };
      let payload;
      if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
      const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(text); } catch { json = undefined; }
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }
  const entries = () => lines.map((l) => JSON.parse(l));
  // the request log line is written when the response finishes; give it a tick
  const settle = () => new Promise((r) => setImmediate(r));
  try { await fn({ request, lines, entries, settle, clock }); } finally { await app.close(); }
}

test('error mapper: each kind of error becomes the right response', () => withLoggedApp(async ({ request }) => {
  const expect = [
    ['/api/t/validation', 400, { error: 'Name is required' }],
    ['/api/t/unauth', 401, { error: 'Please log in' }],
    ['/api/t/forbidden', 403, { error: 'Operation not allowed', code: 'operation_forbidden' }],
    ['/api/t/notfound', 404, { error: 'That person does not exist' }],
    ['/api/t/conflict', 409, { error: 'That name is already taken', code: 'duplicate_name' }],
    ['/api/t/limit', 429, { error: 'Too many tries' }],
    ['/api/t/dup', 409, { error: 'A team with that name already exists' }],
    ['/api/t/inuse', 409, { error: 'That position is still used' }],
    ['/api/t/boom', 500, { error: 'Something went wrong' }],
  ];
  for (const [p, status, json] of expect) {
    const r = await request('GET', p);
    assert.equal(r.status, status, p);
    assert.deepEqual(r.json, json, p);
    assert.equal(r.headers['cache-control'], 'no-store', p);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
  }
  const limited = await request('GET', '/api/t/limit');
  assert.equal(limited.headers['retry-after'], '42');
  const ok = await request('GET', '/api/t/notfound');
  assert.equal(ok.headers['retry-after'], undefined);
}));

test('error mapper: unexpected errors leak nothing and are logged', () => withLoggedApp(async ({ request, entries, settle }) => {
  const r = await request('GET', '/api/t/boom');
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: 'Something went wrong' });
  assert.ok(!r.text.includes('secret detail'));
  assert.ok(!r.text.includes('at '));
  assert.ok(!r.text.includes('stack'));
  await settle();
  const err = entries().find((e) => e.level === 'error');
  assert.ok(err, 'error was logged');
  assert.equal(err.err.message, 'secret detail password=hunter2');
  assert.equal(err.requestId, r.headers['x-request-id']);
}));

test('mapError as a plain function', () => {
  assert.deepEqual(mapError(new TooManyRequestsError('Wait', 9)),
    { status: 429, body: { error: 'Wait' }, headers: { 'Retry-After': '9' }, unexpected: false });
  assert.deepEqual(mapError(new DuplicateError('dup')).status, 409);
  assert.deepEqual(mapError(new ValidationError('x', { code: 'bad_x' })).body, { error: 'x', code: 'bad_x' });
  const m = mapError(new TypeError('internal'));
  assert.deepEqual(m, { status: 500, body: { error: 'Something went wrong' }, headers: {}, unexpected: true });
  assert.equal(mapError(null).status, 500);
  assert.equal(mapError(new AppError(undefined, 'x', 'bad status')).status, 500);
  assert.equal(mapError(new AppError(200, 'x', 'not an error status')).status, 500);
  assert.equal(mapError('string thrown').status, 500);
});

test('request id: generated, echoed from a safe incoming value, unsafe ones replaced', () => withLoggedApp(async ({ request, entries, settle }) => {
  const a = await request('GET', '/api/t/ok');
  const b = await request('GET', '/api/t/ok');
  assert.match(a.headers['x-request-id'], /^[A-Za-z0-9_-]{16}$/);
  assert.notEqual(a.headers['x-request-id'], b.headers['x-request-id']);
  const safe = await request('GET', '/api/t/ok', { headers: { 'X-Request-Id': 'abc-123_DEF.456' } });
  assert.equal(safe.headers['x-request-id'], 'abc-123_DEF.456');
  for (const bad of ['<script>alert(1)</script>', 'a b c d e f g h', 'short', 'x'.repeat(65), 'id"; drop', 'a/b/c/d/e/f', '../../etc/passwd']) {
    const r = await request('GET', '/api/t/ok', { headers: { 'X-Request-Id': bad } });
    assert.notEqual(r.headers['x-request-id'], bad, bad);
    assert.match(r.headers['x-request-id'], /^[A-Za-z0-9_-]{16}$/, bad);
  }
  // also on static files, 404s and errors
  for (const p of ['/', '/api/nope', '/api/t/boom', '/missing.html']) {
    const r = await request('GET', p);
    assert.ok(r.headers['x-request-id'], p);
  }
  await settle();
  const logged = entries().filter((e) => e.msg === 'request').map((e) => e.requestId);
  assert.ok(logged.includes('abc-123_DEF.456'));
  assert.ok(logged.includes(a.headers['x-request-id']));
}));

test('request id uses the injected random', () => withLoggedApp(async ({ request }) => {
  const expected = seededRandom('ids').token(12);
  const r = await request('GET', '/api/t/ok');
  assert.equal(r.headers['x-request-id'], expected);
}, { random: seededRandom('ids') }));

test('request log line: method, path without query, status, duration, id, user id, no secrets', async () => {
  await withLoggedApp(async ({ request, entries, settle, lines }) => {
    await request('GET', '/api/t/ok?token=query-secret&password=pw-secret');
    await request('POST', '/api/t/secret', {
      headers: { 'X-Flock': '1', Cookie: 'flock_session=cookie-secret', Authorization: 'Bearer auth-secret' },
      body: { password: 'body-secret' },
    });
    await request('GET', '/api/t/notfound');
    await settle();
    const reqs = entries().filter((e) => e.msg === 'request');
    assert.equal(reqs.length, 3);
    const [first, second, third] = reqs;
    assert.deepEqual(Object.keys(first).sort(), ['durationMs', 'level', 'method', 'msg', 'path', 'requestId', 'status', 'time'].sort());
    assert.equal(first.method, 'GET');
    assert.equal(first.path, '/api/t/ok');
    assert.equal(first.status, 200);
    assert.equal(first.durationMs, 0); // fixed clock
    assert.equal(first.level, 'info');
    assert.equal(second.method, 'POST');
    assert.equal(second.status, 200);
    assert.equal(third.status, 404);
    const text = lines.join('\n');
    for (const s of ['query-secret', 'pw-secret', 'cookie-secret', 'auth-secret', 'body-secret']) assert.ok(!text.includes(s), s);
  });
});

test('request log line includes the user id when logged in', async () => {
  const lines = [];
  const logger = createLogger({ write: (l) => lines.push(l) });
  // A router whose guard returns a logged-in user.
  const router = createRouter({ logger, clock: fixedClock('2026-01-01T00:00:00Z'), random: seededRandom(1) });
  router.setGuard(async () => ({ id: 17, name: 'Test Person' }));
  router.add('GET', '/api/me-ish', ({ user }) => ({ status: 200, json: { id: user.id } }));
  const http = await import('node:http');
  const server = http.createServer((req, res) => router.handle(req, res, {}));
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/me-ish`);
  assert.equal(res.status, 200);
  await res.text();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => server.close(r));
  const entry = lines.map((l) => JSON.parse(l)).find((e) => e.msg === 'request');
  assert.equal(entry.userId, 17);
  assert.equal(entry.path, '/api/me-ish');
});

test('router works without options (silent logger, system clock, secure random)', async () => {
  const router = createRouter();
  router.add('GET', '/api/x', () => { throw new NotFoundError('Nope'); });
  const http = await import('node:http');
  const server = http.createServer((req, res) => router.handle(req, res, {}));
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/x`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Nope' });
    assert.match(res.headers.get('x-request-id'), /^[A-Za-z0-9_-]{16}$/);
  } finally { await new Promise((r) => server.close(r)); }
});

// ---------- bin/flock.js serve: startup log and graceful shutdown ----------

test('serve logs startup and shuts down cleanly on SIGTERM', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'flock-serve-'));
  const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'flock.js');
  try {
    const child = spawn(process.execPath, [bin, 'serve'], {
      env: { PATH: process.env.PATH, FLOCK_PORT: '0', FLOCK_DB: path.join(dir, 'test.db'), HOME: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stderr.on('data', (c) => { err += c; });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no startup line: ${out} ${err}`)), 10000);
      child.stdout.on('data', (c) => {
        out += c;
        const m = out.match(/"msg":"flock started"[^\n]*"port":(\d+)/);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      });
      child.once('exit', () => reject(new Error(`exited early: ${err}`)));
    });
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    await health.text();
    const code = await new Promise((resolve) => {
      child.once('exit', (c) => resolve(c));
      child.kill('SIGTERM');
    });
    assert.equal(code, 0, err);
    const events = out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    const msgs = events.map((e) => e.msg);
    assert.ok(msgs.includes('flock started'));
    assert.ok(msgs.includes('flock stopping'));
    assert.ok(msgs.includes('flock stopped'));
    const started = events.find((e) => e.msg === 'flock started');
    assert.equal(started.version, VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
