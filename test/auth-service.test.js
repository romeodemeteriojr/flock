// Unit tests of services.auth with injected fakes: fixed clock, seeded random,
// fast hasher and a recording logger. Made-up people, in-memory database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixedClock } from '../src/infra/clock.js';
import { seededRandom } from '../src/infra/random.js';
import { fastHasher } from '../src/infra/hasher.js';
import { createAuthService, tokenHash, LOCKOUT_MS } from '../src/services/auth-service.js';
import { UnauthenticatedError, TooManyRequestsError, ValidationError, NotFoundError } from '../src/errors.js';
import { makeData } from './helpers/data.js';

const T0 = '2025-03-02T09:00:00.000Z';

function recordingLogger() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  const logger = { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
  logger.child = () => logger;
  return logger;
}

async function setup({ sessionDays = 14 } = {}) {
  const { db, data } = makeData();
  const clock = fixedClock(T0);
  const hasher = fastHasher({ env: {} });
  const logger = recordingLogger();
  const auth = createAuthService({ data, clock, random: seededRandom('auth'), hasher, logger, config: { sessionDays } });
  const add = async (username, password, extra = {}) => {
    const p = await data.people.create({
      name: `Test ${username}`, username, passwordHash: await hasher.hash(password),
      role: extra.role ?? 'member', mustChangePassword: extra.mustChange ?? false, createdAt: T0,
    });
    if (extra.active === false) await data.people.update(p.id, { active: false });
    return p.id;
  };
  const pat = await add('pat', 'pat-secret-1', { role: 'admin' });
  const lee = await add('lee', 'lee-secret-1');
  const old = await add('old', 'old-secret-1', { active: false });
  return { db, data, clock, hasher, logger, auth, pat, lee, old };
}

const rejectsWith = (p, Cls, check) => assert.rejects(p, (e) => {
  assert.ok(e instanceof Cls, `expected ${Cls.name}, got ${e?.name}: ${e?.message}`);
  if (check) check(e);
  return true;
});

test('auth service: login succeeds with a public person and a session token', async () => {
  const s = await setup();
  const r = await s.auth.login('pat', 'pat-secret-1');
  assert.deepEqual(r.person, { id: s.pat, name: 'Test pat', username: 'pat', role: 'admin', mustChangePassword: false, active: true });
  assert.match(r.token, /^[A-Za-z0-9_-]{43}$/);
  const stored = await s.data.sessions.findByTokenHash(tokenHash(r.token));
  assert.equal(stored.personId, s.pat);
  assert.equal(stored.expiresAt, '2025-03-16T09:00:00.000Z');
  assert.equal((await s.auth.login('PAT', 'pat-secret-1')).person.id, s.pat, 'case-insensitive username');
});

test('auth service: wrong password, unknown, empty and inactive all give the same UnauthenticatedError', async () => {
  const s = await setup();
  const attempts = [['pat', 'nope-nope'], ['nobody', 'pat-secret-1'], ['', ''], [undefined, undefined], ['old', 'old-secret-1'], ['pat', 'x'.repeat(5000)]];
  for (const [u, p] of attempts) {
    await rejectsWith(s.auth.login(u, p), UnauthenticatedError, (e) => {
      assert.equal(e.status, 401);
      assert.equal(e.message, 'Wrong username or password');
      assert.equal(e.exposeCode, false);
    });
  }
  await rejectsWith(s.auth.login('old', 'old-secret-1'), UnauthenticatedError, (e) => assert.equal(e.details.reason, 'inactive'));
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
});

test('auth service: lockout after 5 failures and unlock by advancing the clock', async () => {
  const s = await setup();
  for (let i = 0; i < 5; i++) await rejectsWith(s.auth.login('lee', 'wrong-pass'), UnauthenticatedError);
  const p = await s.data.people.findAuthById(s.lee);
  assert.equal(p.failedLogins, 5);
  assert.equal(p.lockedUntil, new Date(Date.parse(T0) + LOCKOUT_MS).toISOString());
  await rejectsWith(s.auth.login('lee', 'lee-secret-1'), TooManyRequestsError, (e) => {
    assert.equal(e.status, 429);
    assert.equal(e.retryAfterSec, 300);
    assert.equal(e.message, 'Too many tries. Please wait a few minutes.');
  });
  s.clock.advance(LOCKOUT_MS - 1000);
  await rejectsWith(s.auth.login('lee', 'lee-secret-1'), TooManyRequestsError, (e) => assert.equal(e.retryAfterSec, 1));
  s.clock.advance(1000);
  assert.equal((await s.auth.login('lee', 'lee-secret-1')).person.id, s.lee);
  const after = await s.data.people.findAuthById(s.lee);
  assert.deepEqual([after.failedLogins, after.lockedUntil], [0, null]);
  // Others are not affected by a lock.
  for (let i = 0; i < 5; i++) await rejectsWith(s.auth.login('lee', 'wrong-pass'), UnauthenticatedError);
  assert.equal((await s.auth.login('pat', 'pat-secret-1')).person.id, s.pat);
});

test('auth service: authenticate, session expiry and logout', async () => {
  const s = await setup({ sessionDays: 3 });
  const { token } = await s.auth.login('lee', 'lee-secret-1');
  assert.equal((await s.auth.authenticate(token)).id, s.lee);
  assert.equal(await s.auth.authenticate('short'), null);
  assert.equal(await s.auth.authenticate(null), null);
  s.clock.advance(3 * 86400000 - 1);
  assert.equal((await s.auth.authenticate(token)).username, 'lee');
  s.clock.advance(1);
  assert.equal(await s.auth.authenticate(token), null);
  assert.equal(await s.data.sessions.findByTokenHash(tokenHash(token)), null, 'expired session removed');

  const t2 = (await s.auth.login('lee', 'lee-secret-1')).token;
  await s.auth.logout(t2);
  await s.auth.logout(undefined);
  assert.equal(await s.auth.authenticate(t2), null);

  const t3 = (await s.auth.login('lee', 'lee-secret-1')).token;
  await s.data.people.update(s.lee, { active: false });
  assert.equal(await s.auth.authenticate(t3), null, 'deactivated person is logged out');
});

test('auth service: changePassword rules and session handling', async () => {
  const s = await setup();
  const cur = (await s.auth.login('pat', 'pat-secret-1')).token;
  const other = (await s.auth.login('pat', 'pat-secret-1')).token;
  const msg = async (...args) => {
    try { await s.auth.changePassword(...args); return null; } catch (e) { assert.ok(e instanceof ValidationError); return e.message; }
  };
  assert.match(await msg(s.pat, 'wrong', 'new-secret-9'), /current password/);
  assert.match(await msg(s.pat, 'pat-secret-1', 'short'), /at least 8/);
  assert.match(await msg(s.pat, 'pat-secret-1', 'pat-secret-1'), /different/);
  assert.match(await msg(9999, 'x', 'new-secret-9'), /cannot be changed/);
  assert.match(await msg(s.old, 'old-secret-1', 'new-secret-9'), /cannot be changed/);
  assert.equal((await s.auth.authenticate(other)).id, s.pat, 'failed changes keep sessions');

  assert.equal(await msg(s.pat, 'pat-secret-1', 'new-secret-9', { currentToken: cur }), null);
  assert.equal((await s.auth.authenticate(cur)).id, s.pat);
  assert.equal(await s.auth.authenticate(other), null);
  await rejectsWith(s.auth.login('pat', 'pat-secret-1'), UnauthenticatedError);
  assert.equal((await s.auth.login('pat', 'new-secret-9')).person.id, s.pat);
});

test('auth service: temp password flow and newTempCredentials', async () => {
  const s = await setup();
  const before = (await s.auth.login('lee', 'lee-secret-1')).token;
  const temp = await s.auth.issueTempPassword(s.lee);
  assert.match(temp, /^[a-z]+-[a-z]+-\d{2}$/);
  assert.equal(await s.auth.authenticate(before), null, 'sessions ended');
  await rejectsWith(s.auth.login('lee', 'lee-secret-1'), UnauthenticatedError);
  const r = await s.auth.login('lee', temp);
  assert.equal(r.person.mustChangePassword, true);
  await s.auth.changePassword(s.lee, temp, 'my-own-secret', { currentToken: r.token });
  assert.equal((await s.auth.authenticate(r.token)).mustChangePassword, false);
  await rejectsWith(s.auth.issueTempPassword(9999), NotFoundError);

  const creds = await s.auth.newTempCredentials();
  assert.match(creds.tempPassword, /^[a-z]+-[a-z]+-\d{2}$/);
  assert.equal(await s.hasher.verify(creds.tempPassword, creds.passwordHash), true);
  assert.ok(!creds.passwordHash.includes(creds.tempPassword));

  const t1 = (await s.auth.login('pat', 'pat-secret-1')).token;
  const t2 = (await s.auth.login('pat', 'pat-secret-1')).token;
  assert.equal(await s.auth.endSessions(s.pat), 2);
  assert.equal(await s.auth.authenticate(t1), null);
  assert.equal(await s.auth.authenticate(t2), null);
});

test('auth service: seeded random makes temp passwords repeatable', async () => {
  const a = await setup();
  const b = await setup();
  const seqA = Array.from({ length: 5 }, () => a.auth.generateTempPassword());
  const seqB = Array.from({ length: 5 }, () => b.auth.generateTempPassword());
  assert.deepEqual(seqA, seqB);
});

test('auth service: no hash or raw token is ever returned or logged', async () => {
  const s = await setup();
  const { token, person } = await s.auth.login('pat', 'pat-secret-1');
  for (let i = 0; i < 5; i++) await s.auth.login('lee', 'bad-bad-bad').catch(() => {});
  await s.auth.login('lee', 'lee-secret-1').catch(() => {});
  await s.auth.login('nobody', 'whatever-1').catch(() => {});
  await s.auth.changePassword(s.pat, 'pat-secret-1', 'new-secret-9', { currentToken: token });
  const temp = await s.auth.issueTempPassword(s.lee);
  const me = await s.auth.authenticate(token);

  const hashes = s.db.prepare('SELECT password_hash h FROM people').all().map((r) => r.h);
  const returned = JSON.stringify([person, me]);
  const logged = JSON.stringify(s.logger.lines);
  assert.ok(s.logger.lines.length > 0, 'the service logs events');
  for (const h of hashes) {
    assert.ok(!returned.includes(h), 'no hash returned');
    assert.ok(!logged.includes(h), 'no hash logged');
  }
  assert.doesNotMatch(returned + logged, /passwordHash|fast\$/);
  for (const secret of [token, tokenHash(token), temp, 'pat-secret-1', 'new-secret-9', 'bad-bad-bad', 'whatever-1']) {
    assert.ok(!logged.includes(secret), `logged a secret: ${secret.slice(0, 6)}...`);
  }
  assert.ok(!returned.includes(token));
});
