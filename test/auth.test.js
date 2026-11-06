import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { scryptHasher } from '../src/infra/hasher.js';
import { fixedClock } from '../src/infra/clock.js';
import { validatePassword, TEMP_WORDS, publicPerson } from '../src/services/auth-service.js';
import { makeContainer } from './helpers/container.js';

// The old src/auth.js tests, now run against services.auth (built by the
// container with a fixed clock, seeded random and fast hasher).

const T0 = '2025-01-05T12:00:00.000Z';

function makeCtx(start = T0, config) {
  const clock = fixedClock(start);
  const overrides = { clock };
  if (config) overrides.config = { ...makeContainer().config, ...config };
  const c = makeContainer(overrides);
  return { c, auth: c.services.auth, data: c.data, db: c.db, advance: (ms) => clock.advance(ms) };
}

async function seed(ctx = makeCtx()) {
  const add = async (name, username, pw, role, active) => {
    const p = await ctx.data.people.create({
      name, username, role, mustChangePassword: false, passwordHash: await ctx.c.hasher.hash(pw), createdAt: T0,
    });
    if (!active) await ctx.data.people.update(p.id, { active: false });
    return p.id;
  };
  const ann = await add('Ann Example', 'ann', 'correct horse', 'admin', true);
  const bob = await add('Bob Sample', 'bob', 'bobs password', 'member', true);
  const cy = await add('Cy Gone', 'cy', 'cys password', 'member', false);
  return { ...ctx, ann, bob, cy };
}

const row = (s, id) => s.data.people.findAuthById(id);
const sessionCount = (s, id) => s.db.prepare('SELECT COUNT(*) n FROM sessions WHERE person_id=?').get(id).n;
const tryLogin = async (s, u, p) => {
  try {
    const r = await s.auth.login(u, p);
    return { ok: true, ...r };
  } catch (e) {
    if (e.status === 429) return { ok: false, reason: 'locked', retryAfterSec: e.retryAfterSec };
    if (e.status === 401) return { ok: false, reason: e.details?.reason ?? 'invalid' };
    throw e;
  }
};
const tryChange = async (s, id, o, n, opts) => {
  try {
    await s.auth.changePassword(id, o, n, opts);
    return { ok: true };
  } catch (e) {
    if (e.status === 400) return { ok: false, error: e.message };
    throw e;
  }
};
// Sessions without changing the password: log in with the known passwords.
const PW = { ann: 'correct horse', bob: 'bobs password', cy: 'cys password' };
async function loginToken(s, username) {
  return (await s.auth.login(username, PW[username])).token;
}

// ---------- hashing ----------

test('hashPassword format and unique salts', async () => {
  const hasher = scryptHasher();
  const a = await hasher.hash('same password');
  const b = await hasher.hash('same password');
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
  const hasher = scryptHasher();
  const verifyPassword = (pw, h) => hasher.verify(pw, h);
  const h = await hasher.hash('correct horse');
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
  const { auth } = makeCtx();
  assert.ok(TEMP_WORDS.length >= 64);
  assert.equal(new Set(TEMP_WORDS).size, TEMP_WORDS.length);
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const t = auth.generateTempPassword();
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
  const s = await seed();
  const { auth, db, ann } = s;
  const tok = await loginToken(s, 'ann');
  assert.match(tok, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(tok, 'base64url').length, 32);

  const row1 = db.prepare('SELECT * FROM sessions WHERE person_id=?').get(ann);
  assert.equal(row1.created_at, T0);
  assert.equal(row1.expires_at, '2025-01-19T12:00:00.000Z');

  const p = await auth.authenticate(tok);
  assert.equal(p.id, ann);
  assert.equal(p.username, 'ann');
  assert.ok(!('passwordHash' in p) && !('password_hash' in p));

  assert.equal(await auth.authenticate('nope'), null);
  assert.equal(await auth.authenticate(undefined), null);
  assert.equal(await auth.authenticate(crypto.randomBytes(32).toString('base64url')), null);

  s.advance(14 * 86400000 - 1);
  assert.equal((await auth.authenticate(tok)).id, ann);
  s.advance(1);
  assert.equal(await auth.authenticate(tok), null);
  assert.equal(sessionCount(s, ann), 0, 'expired session deleted');

  const tok2 = await loginToken(s, 'ann');
  await auth.logout(tok2);
  assert.equal(await auth.authenticate(tok2), null);
  assert.equal(sessionCount(s, ann), 0);
});

test('sessionDays from config, default 14', async () => {
  const a = await seed(makeCtx(T0, { sessionDays: 2 }));
  const b = await seed(makeCtx(T0));
  await loginToken(a, 'ann');
  await loginToken(b, 'bob');
  assert.equal(a.db.prepare('SELECT expires_at e FROM sessions WHERE person_id=?').get(a.ann).e, '2025-01-07T12:00:00.000Z');
  assert.equal(b.db.prepare('SELECT expires_at e FROM sessions WHERE person_id=?').get(b.bob).e, '2025-01-19T12:00:00.000Z');
});

test('raw token is never stored', async () => {
  const s = await seed();
  const tok = await loginToken(s, 'ann');
  const r = s.db.prepare('SELECT * FROM sessions').get();
  assert.equal(r.token_hash, crypto.createHash('sha256').update(tok).digest('hex'));
  const dump = JSON.stringify(s.db.prepare('SELECT * FROM sessions').all()) + JSON.stringify(s.db.prepare('SELECT * FROM people').all());
  assert.ok(!dump.includes(tok));
});

test('inactive person session returns null', async () => {
  const s = await seed();
  const { auth, data, bob } = s;
  const tb = await loginToken(s, 'bob');
  assert.equal((await auth.authenticate(tb)).id, bob);
  await data.people.update(bob, { active: false });
  assert.equal(await auth.authenticate(tb), null);
  // A session that somehow exists for an inactive person is not accepted either.
  const raw = crypto.randomBytes(32).toString('base64url');
  await data.sessions.create({ tokenHash: crypto.createHash('sha256').update(raw).digest('hex'), personId: s.cy, expiresAt: '2030-01-01T00:00:00.000Z', createdAt: T0 });
  assert.equal(await auth.authenticate(raw), null);
});

test('destroyAllSessions with and without exception', async () => {
  const s = await seed();
  const { auth, ann, bob } = s;
  const a1 = await loginToken(s, 'ann');
  const a2 = await loginToken(s, 'ann');
  const a3 = await loginToken(s, 'ann');
  const b1 = await loginToken(s, 'bob');
  // With an exception: a password change keeps the current session only.
  await auth.changePassword(ann, 'correct horse', 'brand new pw', { currentToken: a2 });
  assert.equal(await auth.authenticate(a1), null);
  assert.equal((await auth.authenticate(a2)).id, ann);
  assert.equal(await auth.authenticate(a3), null);
  assert.equal(await auth.endSessions(ann), 1);
  assert.equal(await auth.authenticate(a2), null);
  assert.equal((await auth.authenticate(b1)).id, bob);
});

// ---------- login ----------

test('login success, invalid, unknown, inactive', async () => {
  const s = await seed();
  const { ann } = s;
  const ok = await tryLogin(s, 'ann', 'correct horse');
  assert.equal(ok.ok, true);
  assert.equal(ok.person.id, ann);
  assert.ok(!('passwordHash' in ok.person));
  assert.equal((await tryLogin(s, 'ANN', 'correct horse')).ok, true, 'username is case-insensitive');

  assert.deepEqual(await tryLogin(s, 'ann', 'wrong password'), { ok: false, reason: 'invalid' });
  assert.deepEqual(await tryLogin(s, 'nobody', 'correct horse'), { ok: false, reason: 'invalid' });
  assert.deepEqual(await tryLogin(s, '', ''), { ok: false, reason: 'invalid' });
  assert.deepEqual(await tryLogin(s, undefined, undefined), { ok: false, reason: 'invalid' });
  assert.deepEqual(await tryLogin(s, 'cy', 'cys password'), { ok: false, reason: 'inactive' });
  assert.deepEqual(await tryLogin(s, 'cy', 'wrong password'), { ok: false, reason: 'invalid' });
});

test('lockout after 5 failures, unlock after 5 minutes', async () => {
  const s = await seed();
  const { ann } = s;
  for (let i = 0; i < 4; i++) assert.equal((await tryLogin(s, 'ann', 'bad')).reason, 'invalid');
  assert.equal((await row(s, ann)).failedLogins, 4);
  assert.equal((await row(s, ann)).lockedUntil, null);
  assert.equal((await tryLogin(s, 'ann', 'bad')).reason, 'invalid');
  assert.equal((await row(s, ann)).lockedUntil, '2025-01-05T12:05:00.000Z');

  const locked = await tryLogin(s, 'ann', 'correct horse');
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, 'locked');
  assert.equal(locked.retryAfterSec, 300);

  s.advance(4 * 60 * 1000 + 30 * 1000);
  const still = await tryLogin(s, 'ann', 'correct horse');
  assert.equal(still.reason, 'locked');
  assert.equal(still.retryAfterSec, 30);

  s.advance(30 * 1000);
  const ok = await tryLogin(s, 'ann', 'correct horse');
  assert.equal(ok.ok, true);
  assert.equal((await row(s, ann)).failedLogins, 0);
  assert.equal((await row(s, ann)).lockedUntil, null);
});

test('after a lock expires, one more failure does not relock immediately', async () => {
  const s = await seed();
  const { ann } = s;
  for (let i = 0; i < 5; i++) await tryLogin(s, 'ann', 'bad');
  s.advance(5 * 60 * 1000);
  assert.equal((await tryLogin(s, 'ann', 'bad')).reason, 'invalid');
  assert.equal((await row(s, ann)).failedLogins, 1);
  assert.equal((await row(s, ann)).lockedUntil, null);
  assert.equal((await tryLogin(s, 'ann', 'correct horse')).ok, true);
});

test('success resets the failure counter', async () => {
  const s = await seed();
  for (let i = 0; i < 4; i++) await tryLogin(s, 'ann', 'bad');
  assert.equal((await tryLogin(s, 'ann', 'correct horse')).ok, true);
  assert.equal((await row(s, s.ann)).failedLogins, 0);
  for (let i = 0; i < 4; i++) await tryLogin(s, 'ann', 'bad');
  assert.equal((await tryLogin(s, 'ann', 'correct horse')).ok, true, 'not locked: counter was reset');
});

test('lockout of one person does not affect another', async () => {
  const s = await seed();
  for (let i = 0; i < 5; i++) await tryLogin(s, 'ann', 'bad');
  assert.equal((await tryLogin(s, 'bob', 'bobs password')).ok, true);
});

test('concurrent wrong attempts are all counted', async () => {
  const s = await seed();
  await Promise.all(Array.from({ length: 5 }, () => tryLogin(s, 'ann', 'bad')));
  assert.equal((await row(s, s.ann)).failedLogins, 5);
  assert.equal((await tryLogin(s, 'ann', 'correct horse')).reason, 'locked');
});

// ---------- changePassword ----------

test('changePassword rules', async () => {
  const s = await seed();
  const { ann, db } = s;
  assert.equal((await tryChange(s, ann, 'wrong one', 'brand new pw')).ok, false);
  assert.match((await tryChange(s, ann, 'wrong one', 'brand new pw')).error, /current password/);
  assert.match((await tryChange(s, ann, 'correct horse', 'short')).error, /at least 8/);
  assert.match((await tryChange(s, ann, 'correct horse', 'correct horse')).error, /different/);
  assert.match((await tryChange(s, ann, 'correct horse', '          ')).error, /spaces/);
  db.prepare("UPDATE people SET username='annexample' WHERE id=?").run(ann);
  assert.match((await tryChange(s, ann, 'correct horse', 'annexample')).error, /username/);
  assert.equal((await tryChange(s, 9999, 'x', 'brand new pw')).ok, false);

  db.prepare('UPDATE people SET must_change_password=1 WHERE id=?').run(ann);
  assert.deepEqual(await tryChange(s, ann, 'correct horse', 'brand new pw'), { ok: true });
  assert.equal((await row(s, ann)).mustChangePassword, false);
  assert.equal(await s.c.hasher.verify('brand new pw', (await row(s, ann)).passwordHash), true);
  assert.equal((await tryLogin(s, 'annexample', 'correct horse')).ok, false);
  assert.equal((await tryLogin(s, 'annexample', 'brand new pw')).ok, true);
});

test('changePassword destroys other sessions but keeps the current one', async () => {
  const s = await seed();
  const { auth, ann, bob } = s;
  const cur = await loginToken(s, 'ann');
  const other1 = await loginToken(s, 'ann');
  const other2 = await loginToken(s, 'ann');
  const bobs = await loginToken(s, 'bob');
  assert.equal((await tryChange(s, ann, 'correct horse', 'brand new pw', { currentToken: cur })).ok, true);
  assert.equal((await auth.authenticate(cur)).id, ann);
  assert.equal(await auth.authenticate(other1), null);
  assert.equal(await auth.authenticate(other2), null);
  assert.equal((await auth.authenticate(bobs)).id, bob);
});

test('failed changePassword keeps sessions and hash', async () => {
  const s = await seed();
  const other = await loginToken(s, 'ann');
  const before = (await row(s, s.ann)).passwordHash;
  await tryChange(s, s.ann, 'wrong one', 'brand new pw');
  assert.equal((await s.auth.authenticate(other)).id, s.ann);
  assert.equal((await row(s, s.ann)).passwordHash, before);
});

// ---------- setTempPassword ----------

test('setTempPassword forces change, clears lockout, drops sessions', async () => {
  const s = await seed();
  const { auth, ann } = s;
  const tok = await loginToken(s, 'ann');
  for (let i = 0; i < 5; i++) await tryLogin(s, 'ann', 'bad');
  assert.ok((await row(s, ann)).lockedUntil);

  const temp = await auth.issueTempPassword(ann);
  assert.match(temp, /^[a-z]+-[a-z]+-[0-9]{2}$/);
  const r = await row(s, ann);
  assert.equal(r.mustChangePassword, true);
  assert.equal(r.failedLogins, 0);
  assert.equal(r.lockedUntil, null);
  assert.ok(!r.passwordHash.includes(temp));
  assert.equal(await auth.authenticate(tok), null);
  assert.equal(sessionCount(s, ann), 0);

  const res = await tryLogin(s, 'ann', temp);
  assert.equal(res.ok, true);
  assert.equal(publicPerson(res.person).mustChangePassword, true);
  assert.equal((await tryLogin(s, 'ann', 'correct horse')).ok, false);

  assert.equal((await tryChange(s, ann, temp, 'my own password')).ok, true);
  assert.equal((await row(s, ann)).mustChangePassword, false);
});

test('setTempPassword on unknown person throws', async () => {
  const s = await seed();
  await assert.rejects(s.auth.issueTempPassword(9999));
});

// ---------- publicPerson ----------

test('publicPerson exposes no hash', async () => {
  const s = await seed();
  const p = publicPerson(await row(s, s.ann));
  assert.deepEqual(p, { id: s.ann, name: 'Ann Example', username: 'ann', role: 'admin', mustChangePassword: false, active: true });
  assert.ok(!JSON.stringify(p).includes('fast$') && !JSON.stringify(p).includes('scrypt'));
  assert.equal(publicPerson(await row(s, s.cy)).active, false);
  assert.equal(publicPerson(null), null);
});
