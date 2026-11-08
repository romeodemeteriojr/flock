import test from 'node:test';
import assert from 'node:assert/strict';
import { makeContainer } from './helpers/container.js';
import { addPerson } from './helpers/seed.js';
import { fixedClock } from '../src/infra/clock.js';
import { fastHasher } from '../src/infra/hasher.js';
import { createAuthService, tokenHash, inviteLink, INVITE_GONE_MESSAGE, INVITE_DAYS } from '../src/services/auth-service.js';
import { NotFoundError, ValidationError, UnauthenticatedError, ConflictError } from '../src/errors.js';

const NOW = '2025-03-02T09:00:00.000Z';
const GOOD = 'a good password 1';
const gone = (p) => assert.rejects(p, (e) => e instanceof NotFoundError && e.message === INVITE_GONE_MESSAGE);

function setup(t, overrides = {}) {
  const logs = [];
  const record = (...args) => logs.push(args);
  const logger = { debug: record, info: record, warn: record, error: record, child: () => logger };
  const c = makeContainer({ clock: fixedClock(NOW), logger, ...overrides });
  t.after(() => c.close());
  return { ...c, auth: c.services.auth, people: c.services.people, logs };
}
const create = (s, input = {}) => s.people.create(null, { name: 'Pat Smith', email: 'pat.smith@example.com', ...input });

test('invite: created once for 7 days; the stored row contains only its hash', async (t) => {
  const s = setup(t);
  const { person, invite } = await create(s);
  assert.match(invite.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(invite.expiresAt, '2025-03-09T09:00:00.000Z');
  assert.equal(INVITE_DAYS, 7);
  assert.equal(person.joined, false);
  assert.equal((await s.data.people.findAuthById(person.id)).passwordHash, null);
  assert.deepEqual(await s.data.invites.findByTokenHash(tokenHash(invite.token)), {
    personId: person.id, tokenHash: tokenHash(invite.token), createdAt: NOW, expiresAt: invite.expiresAt,
  });
  assert.equal(await s.data.invites.findByTokenHash(invite.token), null);
  assert.deepEqual(await s.auth.inviteInfo(invite.token), { name: 'Pat Smith', email: 'pat.smith@example.com' });
  assert.equal(inviteLink('https://flock.example.org///', invite.token), `https://flock.example.org/#/welcome?token=${invite.token}`);
});

test('invite: acceptance sets a password, consumes the link and starts a valid session', async (t) => {
  const s = setup(t);
  const { person, invite } = await create(s);
  const result = await s.auth.acceptInvite(invite.token, GOOD);
  assert.equal(result.person.hasPassword, true);
  assert.equal((await s.auth.authenticate(result.token)).id, person.id);
  assert.equal(await s.data.invites.findByTokenHash(tokenHash(invite.token)), null);
  assert.ok(await s.hasher.verify(GOOD, (await s.data.people.findAuthById(person.id)).passwordHash));
  await gone(s.auth.inviteInfo(invite.token));
  await gone(s.auth.acceptInvite(invite.token, 'another password'));
});

test('invite: exact expiry boundary, including the millisecond before it', async (t) => {
  const s = setup(t);
  const { invite } = await create(s);
  s.clock.set(Date.parse(invite.expiresAt) - 1);
  assert.equal((await s.auth.inviteInfo(invite.token)).email, 'pat.smith@example.com');
  s.clock.advance(1);
  await gone(s.auth.inviteInfo(invite.token));
  await gone(s.auth.acceptInvite(invite.token, GOOD));
  s.clock.advance(1);
  await gone(s.auth.inviteInfo(invite.token));
});

test('invite: a replacement cancels the previous link, but joined/inactive people cannot be reinvited', async (t) => {
  const s = setup(t);
  const { person, invite } = await create(s);
  const next = await s.people.invite(null, person.id);
  await gone(s.auth.inviteInfo(invite.token));
  const latest = await s.people.invite(null, person.id);
  await gone(s.auth.inviteInfo(next.invite.token));
  await s.auth.acceptInvite(latest.invite.token, GOOD);
  await assert.rejects(s.people.invite(null, person.id), ValidationError);
  const other = await create(s, { name: 'Lee', email: 'lee.example@example.com' });
  await s.data.people.update(other.person.id, { active: false });
  await assert.rejects(s.people.invite(null, other.person.id), ValidationError);
  await assert.rejects(s.people.invite(null, 9999), NotFoundError);
});

test('invite: reset immediately clears the password, lockout and all sessions', async (t) => {
  const s = setup(t);
  const { person, invite } = await create(s);
  const first = await s.auth.acceptInvite(invite.token, GOOD);
  const second = await s.auth.login(person.email, GOOD);
  await s.data.people.setLoginFailures(person.id, { failedLogins: 5, lockedUntil: '2025-03-02T10:00:00.000Z' });
  const reset = await s.people.resetLogin(null, person.id);
  const p = await s.data.people.findAuthById(person.id);
  assert.deepEqual([p.passwordHash, p.failedLogins, p.lockedUntil], [null, 0, null]);
  assert.equal(reset.person.joined, false);
  assert.equal(await s.auth.authenticate(first.token), null);
  assert.equal(await s.auth.authenticate(second.token), null);
  await assert.rejects(s.auth.login(person.email, GOOD), UnauthenticatedError);
  assert.equal((await s.auth.acceptInvite(reset.invite.token, 'a different password')).person.id, person.id);
});

test('invite: deactivated people cannot claim links; reactivation restores a still-live link', async (t) => {
  const s = setup(t);
  const { person, invite } = await create(s);
  await s.data.people.update(person.id, { active: false });
  await gone(s.auth.inviteInfo(invite.token));
  await gone(s.auth.acceptInvite(invite.token, GOOD));
  const reset = await s.people.resetLogin(null, person.id);
  await gone(s.auth.inviteInfo(reset.invite.token));
  await s.data.people.update(person.id, { active: true });
  assert.equal((await s.auth.acceptInvite(reset.invite.token, GOOD)).person.id, person.id);
});

test('invite: weak passwords do not consume the link', async (t) => {
  const s = setup(t);
  const { invite } = await create(s);
  for (const password of ['short', 'PAT.SMITH@example.com', ' '.repeat(8), 'x'.repeat(201), undefined]) {
    await assert.rejects(s.auth.acceptInvite(invite.token, password), ValidationError);
    assert.equal((await s.auth.inviteInfo(invite.token)).email, 'pat.smith@example.com');
  }
  await s.auth.acceptInvite(invite.token, GOOD);
});

test('invite: garbage tokens never reach the data lookup', async (t) => {
  const s = setup(t);
  s.data.invites.findByTokenHash = () => assert.fail('garbage reached SQL');
  for (const token of ['', 'x', '!'.repeat(43), 7, null, undefined]) {
    await gone(s.auth.inviteInfo(token));
    await gone(s.auth.acceptInvite(token, GOOD));
  }
});

test('invite: people without a password cannot log in or accumulate failed-logins', async (t) => {
  const s = setup(t);
  const { person } = await create(s);
  for (let i = 0; i < 8; i++) {
    await assert.rejects(s.auth.login(person.email, GOOD), (e) => e instanceof UnauthenticatedError && e.message === 'Wrong email or password');
  }
  const p = await s.data.people.findAuthById(person.id);
  assert.deepEqual([p.failedLogins, p.lockedUntil], [0, null]);
});

test('invite: two simultaneous claims have exactly one winner and one session', async (t) => {
  const s = setup(t);
  const { invite } = await create(s);
  const results = await Promise.allSettled([s.auth.acceptInvite(invite.token, GOOD), s.auth.acceptInvite(invite.token, 'second good password')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason instanceof NotFoundError).length, 1);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 1);
});

for (const mutation of ['expiry', 'replacement', 'deactivation']) {
  test(`invite: ${mutation} while hashing is rechecked before consumption`, async (t) => {
    const base = fastHasher({ env: {} });
    let change = async () => {};
    const hasher = { ...base, hash: async (password) => { const hash = await base.hash(password); await change(); return hash; } };
    const s = setup(t, { hasher });
    const { person, invite } = await create(s);
    change = async () => {
      if (mutation === 'expiry') s.clock.set(invite.expiresAt);
      else if (mutation === 'replacement') await s.people.invite(null, person.id);
      else await s.data.people.update(person.id, { active: false });
    };
    await gone(s.auth.acceptInvite(invite.token, GOOD));
    assert.equal((await s.data.people.findAuthById(person.id)).passwordHash, null);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
  });
}

test('invite: a session-write failure rolls back password and token consumption', async (t) => {
  const s = setup(t);
  const { person, invite } = await create(s);
  const data = { ...s.data, sessions: { ...s.data.sessions, create: async () => { throw new Error('session write failed'); } } };
  const auth = createAuthService({ ...s, data });
  await assert.rejects(auth.acceptInvite(invite.token, GOOD), /session write failed/);
  assert.equal((await s.data.people.findAuthById(person.id)).passwordHash, null);
  assert.ok(await s.auth.inviteInfo(invite.token));
});

test('invite: pending schedulers do not bypass last-joined-scheduler protection', async (t) => {
  const s = setup(t);
  const id = await addPerson(s, { name: 'Ada', email: 'ada.admin@example.com', role: 'admin' });
  const pending = await create(s, { name: 'Next Admin', email: 'next.admin@example.com', role: 'admin' });
  await assert.rejects(s.people.update({ id }, id, { role: 'member' }), ConflictError);
  // An unused invitation may still be deactivated when a joined scheduler remains.
  await s.people.update({ id }, pending.person.id, { active: false });
  await s.people.update({ id }, pending.person.id, { active: true });
  await s.auth.acceptInvite(pending.invite.token, GOOD);
  assert.equal((await s.people.update({ id }, id, { role: 'member' })).role, 'member');
});

test('invite: a reset immediately after login commits cannot recreate its session', async (t) => {
  const s = setup(t);
  const { person, invite } = await create(s);
  await s.auth.acceptInvite(invite.token, GOOD);
  const data = { ...s.data, tx: async (fn) => {
    const result = await s.data.tx(fn);
    await s.people.resetLogin(null, person.id);
    return result;
  } };
  const auth = createAuthService({ ...s, data });
  const login = await auth.login(person.email, GOOD);
  assert.equal(await s.data.sessions.findByTokenHash(tokenHash(login.token)), null);
  assert.equal(await s.auth.authenticate(login.token), null);
});

test('invite: raw links, tokens, passwords and hashes never reach the logger or audit detail', async (t) => {
  const s = setup(t);
  const created = await create(s);
  const accepted = await s.auth.acceptInvite(created.invite.token, GOOD);
  const reset = await s.people.resetLogin(null, created.person.id);
  const text = JSON.stringify(s.logs) + JSON.stringify(await s.data.audit.list());
  for (const secret of [created.invite.token, tokenHash(created.invite.token), reset.invite.token, accepted.token, GOOD]) assert.ok(!text.includes(secret));
});
