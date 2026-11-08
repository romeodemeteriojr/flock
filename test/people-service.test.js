// Unit tests of the people service with injected fakes: in-memory data, fixed
// clock, seeded random, fast hasher and a small fake auth service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeopleService, baseUsername } from '../src/services/people-service.js';
import { fixedClock } from '../src/infra/clock.js';
import { seededRandom } from '../src/infra/random.js';
import { fastHasher } from '../src/infra/hasher.js';
import { silentLogger } from '../src/infra/logger.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/errors.js';
import { makeData } from './helpers/data.js';
import { addPerson } from './helpers/seed.js';
import { createAuthService, tokenHash } from '../src/services/auth-service.js';

const NOW = '2025-01-05T12:00:00.000Z';

function fakeAuth(deps) {
  const calls = { endSessions: [], newInvite: 0 };
  const base = createAuthService({ ...deps, logger: silentLogger(), config: { sessionDays: 14 } });
  return {
    ...base, calls,
    newInvite() { calls.newInvite++; return base.newInvite(); },
    async endSessions(personId) {
      calls.endSessions.push(personId);
      return base.endSessions(personId);
    },
  };
}

async function setup() {
  const { data } = makeData();
  const clock = fixedClock(NOW);
  const random = seededRandom('people');
  const hasher = fastHasher({ env: {} });
  const auth = fakeAuth({ data, random, hasher, clock });
  const people = createPeopleService({ data, clock, auth, logger: silentLogger() });
  const add = (name, username, role = 'member') => addPerson({ data, hasher }, { name, username, role, password: 'pw-123456' });
  const adminId = await add('Ada Admin', 'ada', 'admin');
  const memberId = await add('Max Member', 'max');
  const admin = { id: adminId, role: 'admin' };
  const session = (personId, tag) => data.sessions.create({ tokenHash: `hash-${tag}`, personId, expiresAt: '2025-02-01T00:00:00.000Z', createdAt: NOW });
  return { data, clock, hasher, auth, people, adminId, memberId, admin, session };
}

test('people service: list is sorted, has positionIds and no secrets', async () => {
  const { people } = await setup();
  const list = await people.list();
  assert.deepEqual(list.map((p) => p.name), ['Ada Admin', 'Max Member']);
  assert.deepEqual(Object.keys(list[0]), ['id', 'name', 'username', 'email', 'role', 'active', 'joined', 'positionIds']);
  assert.doesNotMatch(JSON.stringify(list), /fast\$|hash/i);
});

test('people service: create returns an invite once and stores only its hash', async () => {
  const { people, data, admin, auth } = await setup();
  const { person, invite } = await people.create(admin, { name: 'Sam Jones', username: ' Sam_J ' });
  assert.equal(person.username, 'sam_j');
  assert.equal(person.role, 'member');
  assert.equal(person.joined, false);
  assert.equal(person.active, true);
  assert.equal(auth.calls.newInvite, 1);
  const stored = await data.people.findAuthById(person.id);
  assert.equal(stored.passwordHash, null);
  assert.equal((await data.invites.findByTokenHash(tokenHash(invite.token))).personId, person.id);
  assert.equal(stored.createdAt, NOW);
  assert.ok(!JSON.stringify(await people.list()).includes(invite.token));
  const admin2 = await people.create(admin, { name: 'Bo Boss', role: 'admin' });
  assert.equal(admin2.person.role, 'admin');
});

test('people service: username generation and duplicates', async () => {
  const { people, admin } = await setup();
  assert.equal((await people.create(admin, { name: 'Sam Jones' })).person.username, 'sam.jones');
  assert.equal((await people.create(admin, { name: 'Sam  Jones' })).person.username, 'sam.jones2');
  assert.equal((await people.create(admin, { name: 'Sam-Jones' })).person.username, 'sam.jones3');
  assert.equal((await people.create(admin, { name: 'Zoë' })).person.username, 'zoe');
  assert.equal(baseUsername('Ab'), 'ab.user');
  assert.match(baseUsername('X'.repeat(50)), /^x{24}$/);
  await assert.rejects(people.create(admin, { name: 'Dup', username: 'SAM.JONES' }),
    (e) => e instanceof ConflictError && e.status === 409 && e.message === 'That username is already taken');
  await assert.rejects(people.create(admin, { name: 'Dup', username: 'MAX' }), ConflictError);
});

test('people service: create validates username and role', async () => {
  const { people, admin, auth } = await setup();
  for (const username of ['ab', 'a b c', 'x'.repeat(31), 5]) {
    await assert.rejects(people.create(admin, { name: 'A B', username }),
      (e) => e instanceof ValidationError && /username must be 3 to 30/.test(e.message));
  }
  await assert.rejects(people.create(admin, { name: 'A B', role: 'boss' }),
    (e) => e instanceof ValidationError && e.message === 'The role must be admin or member.');
  assert.equal(auth.calls.newInvite, 0, 'no invite made for bad input');
});

test('people service: update changes name and role and writes an audit row', async () => {
  const { people, data, admin, memberId } = await setup();
  const p = await people.update(admin, memberId, { name: 'Max Q', role: 'admin' });
  assert.equal(p.name, 'Max Q');
  assert.equal(p.role, 'admin');
  const [row] = await data.audit.list();
  assert.equal(row.action, 'person.update');
  assert.equal(row.actorId, admin.id);
  assert.equal(row.at, NOW);
  assert.equal(row.detail, `person ${memberId}: name, role member -> admin`);
  await assert.rejects(people.update(admin, memberId, { role: 'boss' }), ValidationError);
});

test('people service: the last active admin can never be demoted or deactivated', async () => {
  const { people, data, admin, adminId, memberId } = await setup();
  await assert.rejects(people.update({ id: memberId }, adminId, { role: 'member' }),
    (e) => e instanceof ConflictError && e.message === 'There must always be at least one active admin');
  await assert.rejects(people.update({ id: memberId }, adminId, { active: false }),
    (e) => e instanceof ConflictError && e.message === 'There must always be at least one active admin');
  await assert.rejects(people.update(admin, adminId, { role: 'member' }), ConflictError);
  // With a second admin, demoting yourself is fine.
  await people.update(admin, memberId, { role: 'admin' });
  assert.equal((await people.update(admin, adminId, { role: 'member' })).role, 'member');
  // Max is now the last one.
  await assert.rejects(people.update({ id: memberId }, memberId, { role: 'member' }), ConflictError);
  assert.equal((await data.people.findById(memberId)).role, 'admin');
  // An inactive admin does not count.
  await people.update({ id: memberId }, adminId, { role: 'admin' });
  await people.update({ id: memberId }, adminId, { active: false });
  await assert.rejects(people.update({ id: adminId }, memberId, { active: false }), ConflictError);
});

test('people service: an admin cannot deactivate themselves', async () => {
  const { people, admin, adminId, memberId } = await setup();
  await people.update(admin, memberId, { role: 'admin' });
  await assert.rejects(people.update(admin, adminId, { active: false }),
    (e) => e instanceof ConflictError && e.message === 'You cannot deactivate your own account');
});

test('people service: deactivating ends sessions; reactivating works', async () => {
  const { people, data, admin, memberId, adminId, auth, session } = await setup();
  await session(memberId, 'm1');
  await session(memberId, 'm2');
  await session(adminId, 'a1');
  const p = await people.update(admin, memberId, { active: false });
  assert.equal(p.active, false);
  assert.deepEqual(auth.calls.endSessions, [memberId]);
  assert.equal(await data.sessions.findByTokenHash('hash-m1'), null);
  assert.equal(await data.sessions.findByTokenHash('hash-m2'), null);
  assert.ok(await data.sessions.findByTokenHash('hash-a1'));
  assert.equal((await people.update(admin, memberId, { active: true })).active, true);
  const details = (await data.audit.list()).map((r) => r.detail).reverse();
  assert.deepEqual(details, [`person ${memberId}: deactivated`, `person ${memberId}: reactivated`]);
});

test('people service: unknown people give NotFoundError', async () => {
  const { people, admin, auth } = await setup();
  await assert.rejects(people.update(admin, 9999, { name: 'Nope' }),
    (e) => e instanceof NotFoundError && e.message === 'That person was not found');
  await assert.rejects(people.resetPassword(admin, 9999), NotFoundError);
  assert.equal(auth.calls.newInvite, 0);
});

test('people service: resetPassword clears the password and returns an invite once', async () => {
  const { people, data, admin, memberId, session } = await setup();
  await session(memberId, 'm1');
  const r = await people.resetPassword(admin, memberId);
  assert.deepEqual(Object.keys(r), ['person', 'invite']);
  const stored = await data.people.findAuthById(memberId);
  assert.equal(stored.passwordHash, null);
  assert.equal(r.person.joined, false);
  assert.equal((await data.invites.findByTokenHash(tokenHash(r.invite.token))).personId, memberId);
  assert.equal(await data.sessions.findByTokenHash('hash-m1'), null);
});

test('people service: audit rows have no secrets', async () => {
  const { people, data, admin, memberId } = await setup();
  const c = await people.create(admin, { name: 'Sam Jones' });
  await people.update(admin, memberId, { active: false });
  const rs = await people.resetPassword(admin, memberId);
  const rows = (await data.audit.list()).reverse();
  assert.deepEqual(rows.map((r) => r.action), ['person.create', 'person.update', 'person.reset_password']);
  assert.equal(rows[0].detail, `person ${c.person.id} (sam.jones) role member`);
  const hashes = [tokenHash(c.invite.token), tokenHash(rs.invite.token)];
  for (const r of rows) {
    assert.equal(r.actorId, admin.id);
    for (const secret of [c.invite.token, rs.invite.token, ...hashes]) assert.ok(!r.detail.includes(secret));
    assert.doesNotMatch(r.detail, /fast\$|scrypt|password/i);
  }
});

test('people service: a failed create writes nothing', async () => {
  const { people, data, admin } = await setup();
  await assert.rejects(people.create(admin, { name: 'X', username: 'ada' }), ConflictError);
  assert.equal((await data.audit.list()).length, 0);
  assert.equal((await people.list()).length, 2);
});
