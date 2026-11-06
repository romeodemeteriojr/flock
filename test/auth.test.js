import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../src/db.js';
import {
  hashPassword, verifyPassword, validatePassword, generateTempPassword, TEMP_WORDS,
  createSession, getSession, destroySession, destroyAllSessions,
  login, changePassword, setTempPassword, publicPerson,
} from '../src/auth.js';

const T0 = '2025-01-05T12:00:00.000Z';

function makeCtx(start = T0, config = { sessionDays: 14 }) {
  let t = new Date(start).getTime();
  return {
    config,
    now: () => new Date(t),
    advance(ms) { t += ms; },
  };
}

async function seed() {
  const db = openDb();
  const ins = db.prepare('INSERT INTO people (name,username,password_hash,role,must_change_password,active,created_at) VALUES (?,?,?,?,?,?,?)');
  const ann = Number(ins.run('Ann Example', 'ann', await hashPassword('correct horse'), 'admin', 0, 1, T0).lastInsertRowid);
  const bob = Number(ins.run('Bob Sample', 'bob', await hashPassword('bobs password'), 'member', 0, 1, T0).lastInsertRowid);
  const cy = Number(ins.run('Cy Gone', 'cy', await hashPassword('cys password'), 'member', 0, 0, T0).lastInsertRowid);
  return { db, ann, bob, cy };
}

const row = (db, id) => db.prepare('SELECT * FROM people WHERE id=?').get(id);
const sessionCount = (db, id) => db.prepare('SELECT COUNT(*) n FROM sessions WHERE person_id=?').get(id).n;

// ---------- hashing ----------

test('hashPassword format and unique salts', async () => {
  const a = await hashPassword('same password');
  const b = await hashPassword('same password');
  const re = /^scrypt\$16384\$8\$1\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/;
  for (const h of [a, b]) {
    const m = h.match(re);
    assert.ok(m, 'format');
    assert.equal(Buffer.from(m[1], 'base64').length, 16);
    assert.equal(Buffer.from(m[2], 'base64').length, 64);
  }
  assert.notEqual(a, b);
  assert.notEqual(a.split('$')[4], b.split('$')[4]);
  assert.ok(!a.includes('same password'));
});

test('verifyPassword right, wrong, malformed', async () => {
  const h = await hashPassword('correct horse');
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('correct hors', h), false);
  assert.equal(await verifyPassword('Correct horse', h), false);
  assert.equal(await verifyPassword('', h), false);
  assert.equal(await verifyPassword(undefined, h), false);
  const p = h.split('$');
  const malformed = [
    undefined, null, 42, {}, '', 'h', 'scrypt', 'scrypt$$$$$',
    'bcrypt$16384$8$1$' + p[4] + '$' + p[5],
    `scrypt$16383$8$1$${p[4]}$${p[5]}`, // N not a power of two
    `scrypt$1073741824$8$1$${p[4]}$${p[5]}`, // N too big
    `scrypt$16384$999$1$${p[4]}$${p[5]}`,
    `scrypt$16384$8$1$${p[4]}`,
    `scrypt$16384$8$1$${p[4]}$${p[5]}$extra`,
    `scrypt$16384$8$1$!!!$${p[5]}`,
    `scrypt$16384$8$1$${p[4]}$`,
    `scrypt$abc$8$1$${p[4]}$${p[5]}`,
    `scrypt$-16384$8$1$${p[4]}$${p[5]}`,
  ];
  for (const m of malformed) assert.equal(await verifyPassword('correct horse', m), false, String(m));
  // Wrong hash bytes of the same length.
  const flipped = Buffer.from(p[5], 'base64');
  flipped[0] ^= 1;
  assert.equal(await verifyPassword('correct horse', [...p.slice(0, 5), flipped.toString('base64')].join('$')), false);
});

test('validatePassword rules', () => {
  assert.equal(validatePassword('longenough', { username: 'ann' }), null);
  assert.equal(validatePassword('a'.repeat(200), { username: 'ann' }), null);
  assert.match(validatePassword('short', { username: 'ann' }), /at least 8/);
  assert.match(validatePassword('a'.repeat(201), { username: 'ann' }), /at most 200/);
  assert.match(validatePassword('        ', { username: 'ann' }), /spaces/);
  assert.match(validatePassword('annabelle', { username: 'annabelle' }), /username/);
  assert.match(validatePassword('AnnaBelle', { username: 'annabelle' }), /username/);
  assert.match(validatePassword(undefined), /password/i);
  assert.match(validatePassword(12345678), /password/i);
  assert.equal(validatePassword('longenough'), null);
});

test('generateTempPassword shape over 200 samples', () => {
  assert.ok(TEMP_WORDS.length >= 64);
  assert.equal(new Set(TEMP_WORDS).size, TEMP_WORDS.length);
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const t = generateTempPassword();
    const m = t.match(/^([a-z]+)-([a-z]+)-([0-9]{2})$/);
    assert.ok(m, t);
    assert.ok(TEMP_WORDS.includes(m[1]) && TEMP_WORDS.includes(m[2]), t);
    assert.equal(validatePassword(t, { username: 'ann' }), null);
    seen.add(t);
  }
  assert.ok(seen.size > 150, 'temp passwords should vary');
});

// ---------- sessions ----------

test('session create, get, expire, destroy', async () => {
  const { db, ann } = await seed();
  const ctx = makeCtx();
  const tok = createSession(db, ctx, ann);
  assert.match(tok, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(tok, 'base64url').length, 32);

  const s = db.prepare('SELECT * FROM sessions WHERE person_id=?').get(ann);
  assert.equal(s.created_at, T0);
  assert.equal(s.expires_at, '2025-01-19T12:00:00.000Z');

  const p = getSession(db, ctx, tok);
  assert.equal(p.id, ann);
  assert.equal(p.username, 'ann');
  assert.ok(!('password_hash' in p));

  assert.equal(getSession(db, ctx, 'nope'), null);
  assert.equal(getSession(db, ctx, undefined), null);
  assert.equal(getSession(db, ctx, crypto.randomBytes(32).toString('base64url')), null);

  ctx.advance(14 * 86400000 - 1);
  assert.equal(getSession(db, ctx, tok).id, ann);
  ctx.advance(1);
  assert.equal(getSession(db, ctx, tok), null);
  assert.equal(sessionCount(db, ann), 0, 'expired session deleted');

  const tok2 = createSession(db, ctx, ann);
  destroySession(db, tok2);
  assert.equal(getSession(db, ctx, tok2), null);
  assert.equal(sessionCount(db, ann), 0);
});

test('sessionDays from config, default 14', async () => {
  const { db, ann, bob } = await seed();
  createSession(db, makeCtx(T0, { sessionDays: 2 }), ann);
  createSession(db, makeCtx(T0, {}), bob);
  assert.equal(db.prepare('SELECT expires_at e FROM sessions WHERE person_id=?').get(ann).e, '2025-01-07T12:00:00.000Z');
  assert.equal(db.prepare('SELECT expires_at e FROM sessions WHERE person_id=?').get(bob).e, '2025-01-19T12:00:00.000Z');
});

test('raw token is never stored', async () => {
  const { db, ann } = await seed();
  const ctx = makeCtx();
  const tok = createSession(db, ctx, ann);
  const s = db.prepare('SELECT * FROM sessions').get();
  assert.equal(s.token_hash, crypto.createHash('sha256').update(tok).digest('hex'));
  const dump = JSON.stringify(db.prepare('SELECT * FROM sessions').all()) + JSON.stringify(db.prepare('SELECT * FROM people').all());
  assert.ok(!dump.includes(tok));
});

test('inactive person session returns null', async () => {
  const { db, cy, bob } = await seed();
  const ctx = makeCtx();
  const tok = createSession(db, ctx, cy);
  assert.equal(getSession(db, ctx, tok), null);
  const tb = createSession(db, ctx, bob);
  assert.equal(getSession(db, ctx, tb).id, bob);
  db.prepare('UPDATE people SET active=0 WHERE id=?').run(bob);
  assert.equal(getSession(db, ctx, tb), null);
});

test('destroyAllSessions with and without exception', async () => {
  const { db, ann, bob } = await seed();
  const ctx = makeCtx();
  const a1 = createSession(db, ctx, ann);
  const a2 = createSession(db, ctx, ann);
  const a3 = createSession(db, ctx, ann);
  const b1 = createSession(db, ctx, bob);
  destroyAllSessions(db, ann, a2);
  assert.equal(getSession(db, ctx, a1), null);
  assert.equal(getSession(db, ctx, a2).id, ann);
  assert.equal(getSession(db, ctx, a3), null);
  destroyAllSessions(db, ann);
  assert.equal(getSession(db, ctx, a2), null);
  assert.equal(getSession(db, ctx, b1).id, bob);
});

// ---------- login ----------

test('login success, invalid, unknown, inactive', async () => {
  const { db, ann } = await seed();
  const ctx = makeCtx();
  const ok = await login(db, ctx, 'ann', 'correct horse');
  assert.equal(ok.ok, true);
  assert.equal(ok.person.id, ann);
  assert.ok(!('password_hash' in ok.person));
  assert.equal((await login(db, ctx, 'ANN', 'correct horse')).ok, true, 'username is case-insensitive');

  assert.deepEqual(await login(db, ctx, 'ann', 'wrong password'), { ok: false, reason: 'invalid' });
  assert.deepEqual(await login(db, ctx, 'nobody', 'correct horse'), { ok: false, reason: 'invalid' });
  assert.deepEqual(await login(db, ctx, '', ''), { ok: false, reason: 'invalid' });
  assert.deepEqual(await login(db, ctx, undefined, undefined), { ok: false, reason: 'invalid' });
  assert.deepEqual(await login(db, ctx, 'cy', 'cys password'), { ok: false, reason: 'inactive' });
  assert.deepEqual(await login(db, ctx, 'cy', 'wrong password'), { ok: false, reason: 'invalid' });
});

test('lockout after 5 failures, unlock after 5 minutes', async () => {
  const { db, ann } = await seed();
  const ctx = makeCtx();
  for (let i = 0; i < 4; i++) assert.equal((await login(db, ctx, 'ann', 'bad')).reason, 'invalid');
  assert.equal(row(db, ann).failed_logins, 4);
  assert.equal(row(db, ann).locked_until, null);
  assert.equal((await login(db, ctx, 'ann', 'bad')).reason, 'invalid');
  assert.equal(row(db, ann).locked_until, '2025-01-05T12:05:00.000Z');

  const locked = await login(db, ctx, 'ann', 'correct horse');
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, 'locked');
  assert.equal(locked.retryAfterSec, 300);

  ctx.advance(4 * 60 * 1000 + 30 * 1000);
  const still = await login(db, ctx, 'ann', 'correct horse');
  assert.equal(still.reason, 'locked');
  assert.equal(still.retryAfterSec, 30);

  ctx.advance(30 * 1000);
  const ok = await login(db, ctx, 'ann', 'correct horse');
  assert.equal(ok.ok, true);
  assert.equal(row(db, ann).failed_logins, 0);
  assert.equal(row(db, ann).locked_until, null);
});

test('after a lock expires, one more failure does not relock immediately', async () => {
  const { db, ann } = await seed();
  const ctx = makeCtx();
  for (let i = 0; i < 5; i++) await login(db, ctx, 'ann', 'bad');
  ctx.advance(5 * 60 * 1000);
  assert.equal((await login(db, ctx, 'ann', 'bad')).reason, 'invalid');
  assert.equal(row(db, ann).failed_logins, 1);
  assert.equal(row(db, ann).locked_until, null);
  assert.equal((await login(db, ctx, 'ann', 'correct horse')).ok, true);
});

test('success resets the failure counter', async () => {
  const { db, ann } = await seed();
  const ctx = makeCtx();
  for (let i = 0; i < 4; i++) await login(db, ctx, 'ann', 'bad');
  assert.equal((await login(db, ctx, 'ann', 'correct horse')).ok, true);
  assert.equal(row(db, ann).failed_logins, 0);
  for (let i = 0; i < 4; i++) await login(db, ctx, 'ann', 'bad');
  assert.equal((await login(db, ctx, 'ann', 'correct horse')).ok, true, 'not locked: counter was reset');
});

test('lockout of one person does not affect another', async () => {
  const { db } = await seed();
  const ctx = makeCtx();
  for (let i = 0; i < 5; i++) await login(db, ctx, 'ann', 'bad');
  assert.equal((await login(db, ctx, 'bob', 'bobs password')).ok, true);
});

test('concurrent wrong attempts are all counted', async () => {
  const { db, ann } = await seed();
  const ctx = makeCtx();
  await Promise.all(Array.from({ length: 5 }, () => login(db, ctx, 'ann', 'bad')));
  assert.equal(row(db, ann).failed_logins, 5);
  assert.equal((await login(db, ctx, 'ann', 'correct horse')).reason, 'locked');
});

// ---------- changePassword ----------

test('changePassword rules', async () => {
  const { db, ann } = await seed();
  const ctx = makeCtx();
  assert.equal((await changePassword(db, ctx, ann, 'wrong one', 'brand new pw')).ok, false);
  assert.match((await changePassword(db, ctx, ann, 'wrong one', 'brand new pw')).error, /current password/);
  assert.match((await changePassword(db, ctx, ann, 'correct horse', 'short')).error, /at least 8/);
  assert.match((await changePassword(db, ctx, ann, 'correct horse', 'correct horse')).error, /different/);
  assert.match((await changePassword(db, ctx, ann, 'correct horse', '          ')).error, /spaces/);
  db.prepare("UPDATE people SET username='annexample' WHERE id=?").run(ann);
  assert.match((await changePassword(db, ctx, ann, 'correct horse', 'annexample')).error, /username/);
  assert.equal((await changePassword(db, ctx, 9999, 'x', 'brand new pw')).ok, false);

  db.prepare('UPDATE people SET must_change_password=1 WHERE id=?').run(ann);
  assert.deepEqual(await changePassword(db, ctx, ann, 'correct horse', 'brand new pw'), { ok: true });
  assert.equal(row(db, ann).must_change_password, 0);
  assert.equal(await verifyPassword('brand new pw', row(db, ann).password_hash), true);
  assert.equal((await login(db, ctx, 'annexample', 'correct horse')).ok, false);
  assert.equal((await login(db, ctx, 'annexample', 'brand new pw')).ok, true);
});

test('changePassword destroys other sessions but keeps the current one', async () => {
  const { db, ann, bob } = await seed();
  const ctx = makeCtx();
  const cur = createSession(db, ctx, ann);
  const other1 = createSession(db, ctx, ann);
  const other2 = createSession(db, ctx, ann);
  const bobs = createSession(db, ctx, bob);
  assert.equal((await changePassword(db, ctx, ann, 'correct horse', 'brand new pw', { exceptToken: cur })).ok, true);
  assert.equal(getSession(db, ctx, cur).id, ann);
  assert.equal(getSession(db, ctx, other1), null);
  assert.equal(getSession(db, ctx, other2), null);
  assert.equal(getSession(db, ctx, bobs).id, bob);
});

test('failed changePassword keeps sessions and hash', async () => {
  const { db, ann } = await seed();
  const ctx = makeCtx();
  const other = createSession(db, ctx, ann);
  const before = row(db, ann).password_hash;
  await changePassword(db, ctx, ann, 'wrong one', 'brand new pw');
  assert.equal(getSession(db, ctx, other).id, ann);
  assert.equal(row(db, ann).password_hash, before);
});

// ---------- setTempPassword ----------

test('setTempPassword forces change, clears lockout, drops sessions', async () => {
  const { db, ann } = await seed();
  const ctx = makeCtx();
  const s = createSession(db, ctx, ann);
  for (let i = 0; i < 5; i++) await login(db, ctx, 'ann', 'bad');
  assert.ok(row(db, ann).locked_until);

  const temp = await setTempPassword(db, ctx, ann);
  assert.match(temp, /^[a-z]+-[a-z]+-[0-9]{2}$/);
  const r = row(db, ann);
  assert.equal(r.must_change_password, 1);
  assert.equal(r.failed_logins, 0);
  assert.equal(r.locked_until, null);
  assert.ok(!r.password_hash.includes(temp));
  assert.equal(getSession(db, ctx, s), null);
  assert.equal(sessionCount(db, ann), 0);

  const res = await login(db, ctx, 'ann', temp);
  assert.equal(res.ok, true);
  assert.equal(publicPerson(res.person).mustChangePassword, true);
  assert.equal((await login(db, ctx, 'ann', 'correct horse')).ok, false);

  assert.equal((await changePassword(db, ctx, ann, temp, 'my own password')).ok, true);
  assert.equal(row(db, ann).must_change_password, 0);
});

test('setTempPassword on unknown person throws', async () => {
  const { db } = await seed();
  await assert.rejects(setTempPassword(db, makeCtx(), 9999));
});

// ---------- publicPerson ----------

test('publicPerson exposes no hash', async () => {
  const { db, ann, cy } = await seed();
  const p = publicPerson(row(db, ann));
  assert.deepEqual(p, { id: ann, name: 'Ann Example', username: 'ann', role: 'admin', mustChangePassword: false, active: true });
  assert.ok(!JSON.stringify(p).includes('scrypt'));
  assert.equal(publicPerson(row(db, cy)).active, false);
  assert.equal(publicPerson(null), null);
});
