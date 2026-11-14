// Contract tests for the data interface (src/data/index.js). Any adapter must pass
// them: call runContract('name', makeData) where makeData() -> {data} (or a Promise of it)
// gives a fresh, empty database. Only the public interface is used here.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DuplicateError, InUseError } from '../../src/data/errors.js';

const T = '2025-01-01T00:00:00.000Z';

function noSecrets(value, where) {
  const seen = new Set();
  const walk = (v) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (v instanceof Map || v instanceof Set) { for (const x of v.values()) walk(x); return; }
    for (const [k, x] of Object.entries(v)) {
      assert.ok(!['passwordHash', 'password_hash', 'failedLogins', 'lockedUntil'].includes(k), `${where} leaks ${k}`);
      walk(x);
    }
  };
  walk(value);
}

function noSnakeCase(value, where) {
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (v instanceof Map || v instanceof Set) { for (const x of v.values()) walk(x); return; }
    for (const [k, x] of Object.entries(v)) {
      if (!Array.isArray(v)) assert.ok(!k.includes('_'), `${where} has raw key ${k}`);
      walk(x);
    }
  };
  walk(value);
}

// Plain, camelCase, secret-free result (everything except the two auth finders).
function clean(value, where) {
  noSecrets(value, where);
  noSnakeCase(value, where);
}

export function runContract(name, makeData) {
  describe(`data contract: ${name}`, () => {
    let data;
    const fresh = async () => { ({ data } = await makeData()); return data; };

    // A person by handle: email <handle>@example.com unless extra.email says otherwise (null = none).
    const person = async (handle, extra = {}) => {
      const email = extra.email !== undefined ? extra.email : `${handle}@example.com`;
      const p = await data.people.create({ name: extra.name ?? `P ${handle}`, email, role: extra.role ?? 'member', createdAt: T });
      if (extra.passwordHash !== null) await data.people.setPassword(p.id, extra.passwordHash ?? 'hash-' + handle);
      return data.people.findById(p.id);
    };

    async function world() {
      const ann = await person('ann', { name: 'Ann Able', role: 'admin' });
      const bob = await person('bob', { name: 'bob Baker' });
      const cy = await person('cy', { name: 'Cy Cole' });
      const band = await data.teams.create({ name: 'Band' });
      const tech = await data.teams.create({ name: 'Tech' });
      const drums = await data.positions.create(band.id, { name: 'Drums' });
      const keys = await data.positions.create(band.id, { name: 'Keys' });
      const sound = await data.positions.create(tech.id, { name: 'Sound' });
      return { ann, bob, cy, band, tech, drums, keys, sound };
    }

    // ---------- people ----------
    describe('people', () => {
      test('create returns a public person without secrets', async () => {
        await fresh();
        const p = await person('ann', { name: 'Ann', role: 'admin', passwordHash: null });
        assert.equal(typeof p.id, 'number');
        assert.deepEqual(p, { id: p.id, name: 'Ann', email: 'ann@example.com', role: 'admin', hasPassword: false, joined: false, active: true, createdAt: T, positionIds: [] });
        assert.equal((await data.people.findAuthById(p.id)).passwordHash, null);
        noSecrets(p, 'people.create');
      });

      test('create rejects a duplicate email case-insensitively', async () => {
        await fresh();
        await person('Ann');
        await assert.rejects(person('ann'), DuplicateError);
        await assert.rejects(person('ANN'), (e) => e instanceof DuplicateError && typeof e.message === 'string' && e.message !== '');
      });

      test('findById, findAuthById, findAuthByEmail', async () => {
        await fresh();
        const p = await person('ann');
        const f = await data.people.findById(p.id);
        assert.deepEqual(f, p);
        noSecrets(f, 'people.findById');
        assert.equal(await data.people.findById(999), null);
        const a = await data.people.findAuthById(p.id);
        assert.equal(a.passwordHash, 'hash-ann');
        assert.equal(a.failedLogins, 0);
        assert.equal(a.lockedUntil, null);
        assert.equal(a.email, 'ann@example.com');
        assert.equal(a.active, true);
        const b = await data.people.findAuthByEmail(' ANN@Example.com ');
        assert.equal(b.id, p.id);
        assert.equal(b.passwordHash, 'hash-ann');
        assert.equal(await data.people.findAuthByEmail('nobody@example.com'), null);
        assert.equal(await data.people.findAuthByEmail(''), null);
        assert.equal(await data.people.findAuthById(999), null);
        noSnakeCase(a, 'findAuthById');
      });

      test('email: optional, unique, found case-insensitively', async () => {
        await fresh();
        const ann = await data.people.create({ name: 'Ann', email: 'ann@example.com', createdAt: T });
        assert.equal(ann.email, 'ann@example.com');
        const bob = await person('bob', { email: null });
        assert.equal(bob.email, null);
        await assert.rejects(data.people.update(bob.id, { email: 'ANN@example.com' }), (e) => e instanceof DuplicateError && /email/.test(e.message));
        assert.equal((await data.people.update(bob.id, { email: 'bob@example.com' })).email, 'bob@example.com');
        assert.equal((await data.people.update(bob.id, { email: null })).email, null);
        await person('cy', { email: null }); // several people without an email do not clash
      });

      test('list sorts by name, includes positionIds, no secrets', async () => {
        await fresh();
        const w = await world();
        await data.qualifications.setForPerson(w.bob.id, [w.keys.id, w.drums.id]);
        const list = await data.people.list();
        assert.deepEqual(list.map((p) => p.email), ['ann@example.com', 'bob@example.com', 'cy@example.com']);
        assert.deepEqual(list[1].positionIds, [w.drums.id, w.keys.id].sort((a, b) => a - b));
        assert.deepEqual(list[0].positionIds, []);
        noSecrets(list, 'people.list');
        noSnakeCase(list, 'people.list');
        await data.people.update(w.cy.id, { active: false });
        assert.equal((await data.people.list()).length, 3, 'list includes inactive people');
      });

      test('update changes only given fields', async () => {
        await fresh();
        const p = await person('ann');
        const u = await data.people.update(p.id, { name: 'Ann New' });
        assert.equal(u.name, 'Ann New');
        assert.equal(u.role, 'member');
        const v = await data.people.update(p.id, { role: 'admin', active: false });
        assert.equal(v.role, 'admin');
        assert.equal(v.active, false);
        assert.equal(v.name, 'Ann New');
        assert.deepEqual(await data.people.update(p.id, {}), v);
        assert.equal(await data.people.update(999, { name: 'x' }), null);
        noSecrets(v, 'people.update');
      });

      test('setPassword and setLoginFailures', async () => {
        await fresh();
        const p = await person('ann');
        assert.equal(await data.people.setLoginFailures(p.id, { failedLogins: 5, lockedUntil: '2025-01-01T00:05:00.000Z' }), true);
        let a = await data.people.findAuthById(p.id);
        assert.equal(a.failedLogins, 5);
        assert.equal(a.lockedUntil, '2025-01-01T00:05:00.000Z');
        assert.equal(await data.people.setPassword(p.id, 'new-hash'), true);
        a = await data.people.findAuthById(p.id);
        assert.equal(a.passwordHash, 'new-hash');
        assert.equal(a.hasPassword, true);
        assert.equal(a.failedLogins, 0);
        assert.equal(a.lockedUntil, null);
        await data.people.setPassword(p.id, null);
        assert.equal((await data.people.findById(p.id)).hasPassword, false);
        assert.equal((await data.people.findAuthById(p.id)).passwordHash, null);
        assert.equal(await data.people.setPassword(999, 'h'), false);
        assert.equal(await data.people.setLoginFailures(999, { failedLogins: 1, lockedUntil: null }), false);
      });

      test('countActiveAdmins counts only active admins', async () => {
        await fresh();
        assert.equal(await data.people.countActiveAdmins(), 0);
        const a = await person('a', { role: 'admin' });
        await person('b', { role: 'admin' });
        await person('c');
        await person('pending', { role: 'admin', passwordHash: null });
        assert.equal(await data.people.countActiveAdmins(), 2);
        await data.people.update(a.id, { active: false });
        assert.equal(await data.people.countActiveAdmins(), 1);
      });
    });

    // ---------- identities ----------
    describe('identities', () => {
      test('link, find, one account per provider per person, unlink; a linked account counts as joined', async () => {
        await fresh();
        const a = await person('ann', { role: 'admin', passwordHash: null });
        const b = await person('bob', { passwordHash: null });
        assert.equal(await data.people.countActiveAdmins(), 0);
        await data.identities.link({ provider: 'google', subject: 's-1', personId: a.id, createdAt: T });
        assert.equal(await data.identities.findPersonId('google', 's-1'), a.id);
        assert.equal(await data.identities.findPersonId('google', 's-2'), null);
        assert.equal(await data.identities.findPersonId('other', 's-1'), null);
        const joined = await data.people.findById(a.id);
        assert.equal(joined.joined, true);
        assert.equal(joined.hasPassword, false);
        assert.equal(await data.people.countActiveAdmins(), 1);
        await assert.rejects(data.identities.link({ provider: 'google', subject: 's-1', personId: b.id, createdAt: T }), DuplicateError);
        await assert.rejects(data.identities.link({ provider: 'google', subject: 's-3', personId: a.id, createdAt: T }), DuplicateError);
        await data.identities.link({ provider: 'other', subject: 's-1', personId: a.id, createdAt: T });
        await assert.rejects(data.identities.link({ provider: 'google', subject: 's-9', personId: 999, createdAt: T }));
        assert.equal(await data.identities.deleteForPerson(a.id), 2);
        assert.equal(await data.identities.deleteForPerson(a.id), 0);
        assert.equal((await data.people.findById(a.id)).joined, false);
      });
    });

    // ---------- invites ----------
    describe('invites', () => {
      test('replace and find returns one camelCase row; replacement cancels the old hash', async () => {
        await fresh();
        const p = await person('ann');
        const invite = { personId: p.id, tokenHash: 'invite-hash-1', expiresAt: '2025-01-08T00:00:00.000Z', createdAt: T };
        await data.invites.replace(invite);
        assert.deepEqual(await data.invites.findByTokenHash(invite.tokenHash), invite);
        noSnakeCase(await data.invites.findByTokenHash(invite.tokenHash), 'invites.findByTokenHash');
        const next = { ...invite, tokenHash: 'invite-hash-2', expiresAt: '2025-01-09T00:00:00.000Z' };
        await data.invites.replace(next);
        assert.equal(await data.invites.findByTokenHash(invite.tokenHash), null);
        assert.deepEqual(await data.invites.findByTokenHash(next.tokenHash), next);
        assert.equal(await data.invites.findByTokenHash('unknown'), null);
        assert.equal(await data.invites.deleteForPerson(p.id), 1);
        assert.equal(await data.invites.deleteForPerson(p.id), 0);
      });

      test('unknown people and duplicate token hashes are rejected without overwriting another invite', async () => {
        await fresh();
        const a = await person('ann');
        const b = await person('bob');
        const inv = { personId: a.id, tokenHash: 'unique', expiresAt: T, createdAt: T };
        await data.invites.replace(inv);
        await assert.rejects(data.invites.replace({ ...inv, personId: b.id }), DuplicateError);
        await assert.rejects(data.invites.replace({ ...inv, personId: 999, tokenHash: 'other' }));
        assert.deepEqual(await data.invites.findByTokenHash('unique'), inv);
      });
    });

    // ---------- sessions ----------
    describe('sessions', () => {
      test('create, find and delete by token hash', async () => {
        await fresh();
        const p = await person('ann');
        const s = await data.sessions.create({ tokenHash: 'th1', personId: p.id, expiresAt: '2025-02-01T00:00:00.000Z', createdAt: T });
        assert.equal(s.personId, p.id);
        assert.deepEqual(await data.sessions.findByTokenHash('th1'), { personId: p.id, expiresAt: '2025-02-01T00:00:00.000Z' });
        assert.equal(await data.sessions.findByTokenHash('nope'), null);
        await assert.rejects(data.sessions.create({ tokenHash: 'th1', personId: p.id, expiresAt: T, createdAt: T }), DuplicateError);
        await assert.rejects(data.sessions.create({ tokenHash: 'th2', personId: 9999, expiresAt: T, createdAt: T }), (e) => !(e instanceof DuplicateError));
        assert.equal(await data.sessions.extend('th1', '2025-03-01T00:00:00.000Z'), true);
        assert.deepEqual(await data.sessions.findByTokenHash('th1'), { personId: p.id, expiresAt: '2025-03-01T00:00:00.000Z' });
        assert.equal(await data.sessions.extend('nope', T), false);
        assert.equal(await data.sessions.deleteByTokenHash('th1'), 1);
        assert.equal(await data.sessions.findByTokenHash('th1'), null);
        assert.equal(await data.sessions.deleteByTokenHash('th1'), 0);
      });

      test('deleteForPerson keeps the excepted token', async () => {
        await fresh();
        const a = await person('ann');
        const b = await person('bob');
        for (const t of ['a1', 'a2', 'a3']) await data.sessions.create({ tokenHash: t, personId: a.id, expiresAt: T, createdAt: T });
        await data.sessions.create({ tokenHash: 'b1', personId: b.id, expiresAt: T, createdAt: T });
        assert.equal(await data.sessions.deleteForPerson(a.id, 'a2'), 2);
        assert.ok(await data.sessions.findByTokenHash('a2'));
        assert.equal(await data.sessions.findByTokenHash('a1'), null);
        assert.equal(await data.sessions.deleteForPerson(a.id), 1);
        assert.equal(await data.sessions.findByTokenHash('a2'), null);
        assert.ok(await data.sessions.findByTokenHash('b1'));
      });

      test('deleteExpired removes sessions expiring at or before now', async () => {
        await fresh();
        const a = await person('ann');
        await data.sessions.create({ tokenHash: 'old', personId: a.id, expiresAt: '2025-01-01T00:00:00.000Z', createdAt: T });
        await data.sessions.create({ tokenHash: 'now', personId: a.id, expiresAt: '2025-01-02T00:00:00.000Z', createdAt: T });
        await data.sessions.create({ tokenHash: 'new', personId: a.id, expiresAt: '2025-01-03T00:00:00.000Z', createdAt: T });
        assert.equal(await data.sessions.deleteExpired('2025-01-02T00:00:00.000Z'), 2);
        assert.ok(await data.sessions.findByTokenHash('new'));
        assert.equal(await data.sessions.findByTokenHash('old'), null);
      });
    });

    // ---------- teams and positions ----------
    describe('teams and positions', () => {
      test('teams.create, findById, duplicate names', async () => {
        await fresh();
        const a = await data.teams.create({ name: 'Band' });
        assert.deepEqual(a, { id: a.id, name: 'Band', sort: 1, positions: [] });
        const b = await data.teams.create({ name: 'Tech' });
        assert.equal(b.sort, 2);
        await assert.rejects(data.teams.create({ name: 'band' }), DuplicateError);
        assert.deepEqual(await data.teams.findById(a.id), a);
        assert.equal(await data.teams.findById(999), null);
      });

      test('teams.list sorts teams and positions by sort then name', async () => {
        await fresh();
        const z = await data.teams.create({ name: 'Zeta' });
        const a = await data.teams.create({ name: 'alpha' });
        const m = await data.teams.create({ name: 'Mid' });
        await data.teams.update(z.id, { sort: 0 });
        await data.teams.update(a.id, { sort: 5 });
        await data.teams.update(m.id, { sort: 5 });
        const p1 = await data.positions.create(a.id, { name: 'Zed' });
        const p2 = await data.positions.create(a.id, { name: 'bee' });
        const p3 = await data.positions.create(a.id, { name: 'Ace' });
        await data.positions.update(p1.id, { sort: 0 });
        await data.positions.update(p2.id, { sort: 1 });
        await data.positions.update(p3.id, { sort: 1 });
        const list = await data.teams.list();
        assert.deepEqual(list.map((t) => t.name), ['Zeta', 'alpha', 'Mid']);
        assert.deepEqual(list[1].positions.map((p) => p.name), ['Zed', 'Ace', 'bee']);
        assert.deepEqual(list[1].positions[0], { id: p1.id, teamId: a.id, name: 'Zed', sort: 0 });
        assert.deepEqual(list[0].positions, []);
        clean(list, 'teams.list');
      });

      test('teams.update', async () => {
        await fresh();
        const a = await data.teams.create({ name: 'Band' });
        await data.teams.create({ name: 'Tech' });
        const u = await data.teams.update(a.id, { name: 'Worship', sort: 9 });
        assert.equal(u.name, 'Worship');
        assert.equal(u.sort, 9);
        assert.equal((await data.teams.update(a.id, { sort: 3 })).name, 'Worship');
        await assert.rejects(data.teams.update(a.id, { name: 'TECH' }), DuplicateError);
        assert.equal(await data.teams.update(999, { name: 'x' }), null);
      });

      test('teams.remove cascades positions and qualifications, restricts when used', async () => {
        await fresh();
        const w = await world();
        await data.qualifications.setForPerson(w.bob.id, [w.sound.id, w.drums.id]);
        assert.equal(await data.teams.remove(w.tech.id), true);
        assert.equal(await data.positions.findById(w.sound.id), null);
        assert.deepEqual(await data.qualifications.listPositionIds(w.bob.id), [w.drums.id]);
        const svc = await data.services.create({ date: '2025-01-05', time: '09:00', title: 'Sun' });
        await data.slots.createMany(svc.id, [w.keys.id]);
        await assert.rejects(data.teams.remove(w.band.id), (e) => e instanceof InUseError && e.message.length > 0);
        assert.ok(await data.teams.findById(w.band.id));
        assert.ok(await data.positions.findById(w.drums.id), 'nothing removed on restrict');
        assert.equal(await data.teams.remove(999), false);
      });

      test('positions.create, findById, duplicate, unknown team', async () => {
        await fresh();
        const t = await data.teams.create({ name: 'Band' });
        const t2 = await data.teams.create({ name: 'Tech' });
        const p = await data.positions.create(t.id, { name: 'Drums' });
        assert.deepEqual(p, { id: p.id, teamId: t.id, name: 'Drums', sort: 1 });
        assert.equal((await data.positions.create(t.id, { name: 'Keys' })).sort, 2);
        await assert.rejects(data.positions.create(t.id, { name: 'drums' }), DuplicateError);
        assert.ok(await data.positions.create(t2.id, { name: 'Drums' }), 'same name in another team is fine');
        await assert.rejects(data.positions.create(999, { name: 'X' }), Error);
        assert.deepEqual(await data.positions.findById(p.id), p);
        assert.equal(await data.positions.findById(999), null);
      });

      test('positions.update moves, renames, rejects duplicates', async () => {
        await fresh();
        const t = await data.teams.create({ name: 'Band' });
        const t2 = await data.teams.create({ name: 'Tech' });
        const p = await data.positions.create(t.id, { name: 'Drums' });
        await data.positions.create(t2.id, { name: 'Sound' });
        const u = await data.positions.update(p.id, { name: 'Bass', sort: 4 });
        assert.deepEqual(u, { id: p.id, teamId: t.id, name: 'Bass', sort: 4 });
        const m = await data.positions.update(p.id, { teamId: t2.id });
        assert.equal(m.teamId, t2.id);
        assert.equal(m.name, 'Bass');
        await assert.rejects(data.positions.update(p.id, { name: 'SOUND' }), DuplicateError);
        await assert.rejects(data.positions.update(p.id, { teamId: 999 }), Error);
        assert.equal(await data.positions.update(999, { name: 'x' }), null);
      });

      test('positions.remove and countSlots', async () => {
        await fresh();
        const w = await world();
        const svc = await data.services.create({ date: '2025-01-05', time: '09:00', title: 'Sun' });
        await data.slots.createMany(svc.id, [w.drums.id, w.drums.id]);
        assert.equal(await data.positions.countSlots(w.drums.id), 2);
        assert.equal(await data.positions.countSlots(w.keys.id), 0);
        await assert.rejects(data.positions.remove(w.drums.id), InUseError);
        await data.qualifications.setForPerson(w.ann.id, [w.keys.id]);
        assert.equal(await data.positions.remove(w.keys.id), true);
        assert.deepEqual(await data.qualifications.listPositionIds(w.ann.id), []);
        assert.equal(await data.positions.remove(w.keys.id), false);
      });

      test('positions.retire hides it; slots and qualifications stay; revive brings it back', async () => {
        await fresh();
        const w = await world();
        const svc = await data.services.create({ date: '2025-01-05', time: '09:00', title: 'Sun' });
        await data.slots.createMany(svc.id, [w.drums.id]);
        await data.qualifications.setForPerson(w.ann.id, [w.drums.id, w.keys.id]);
        assert.equal(await data.positions.retire(w.drums.id, T), true);
        assert.equal(await data.positions.retire(w.drums.id, T), false);
        assert.equal(await data.positions.findById(w.drums.id), null);
        assert.deepEqual((await data.teams.findById(w.band.id)).positions.map((p) => p.name), ['Keys']);
        assert.deepEqual((await data.slots.listForService(svc.id)).map((x) => x.positionName), ['Drums']);
        await assert.rejects(data.qualifications.setForPerson(w.ann.id, [w.drums.id]), Error);
        assert.deepEqual(await data.qualifications.setForPerson(w.ann.id, []), []);
        await assert.rejects(data.positions.create(w.band.id, { name: 'drums' }), DuplicateError);
        await assert.rejects(data.positions.update(w.keys.id, { name: 'DRUMS' }), DuplicateError);
        assert.equal(await data.positions.findRetiredByName(w.band.id, 'DRUMS').then((p) => p.id), w.drums.id);
        assert.equal(await data.positions.findRetiredByName(w.tech.id, 'Drums'), null);
        assert.equal(await data.positions.findRetiredByName(w.band.id, 'Keys'), null);
        const back = await data.positions.revive(w.drums.id, { name: 'drums' });
        assert.deepEqual([back.id, back.name, back.sort], [w.drums.id, 'drums', w.keys.sort + 1]);
        assert.deepEqual(await data.qualifications.listPositionIds(w.ann.id), [w.drums.id], 'kept while retired');
        assert.equal(await data.positions.revive(9999, { name: 'X' }), null);
      });

      test('teams.retire retires its positions; revive brings the team back alone', async () => {
        await fresh();
        const w = await world();
        assert.equal(await data.teams.retire(w.band.id, T), true);
        assert.equal(await data.teams.retire(w.band.id, T), false);
        assert.equal(await data.teams.findById(w.band.id), null);
        assert.deepEqual((await data.teams.list()).map((t) => t.name), ['Tech']);
        assert.equal(await data.positions.findById(w.keys.id), null);
        await assert.rejects(data.teams.update(w.tech.id, { name: 'band' }), DuplicateError);
        assert.equal((await data.teams.findRetiredByName('BAND')).id, w.band.id);
        assert.equal(await data.teams.findRetiredByName('Tech'), null);
        const back = await data.teams.revive(w.band.id, { name: 'Band' });
        assert.deepEqual(back, { id: w.band.id, name: 'Band', sort: w.tech.sort + 1, positions: [] });
        assert.equal((await data.positions.findRetiredByName(w.band.id, 'Keys')).id, w.keys.id);
      });
    });

    // ---------- qualifications ----------
    describe('qualifications', () => {
      test('setForPerson replaces, dedupes and sorts', async () => {
        await fresh();
        const w = await world();
        const ids = [w.sound.id, w.drums.id, w.sound.id];
        assert.deepEqual(await data.qualifications.setForPerson(w.ann.id, ids), [w.drums.id, w.sound.id].sort((a, b) => a - b));
        assert.deepEqual(await data.qualifications.setForPerson(w.ann.id, [w.keys.id]), [w.keys.id]);
        assert.deepEqual(await data.qualifications.listPositionIds(w.ann.id), [w.keys.id]);
        assert.deepEqual(await data.qualifications.setForPerson(w.ann.id, []), []);
        assert.deepEqual(await data.qualifications.listPositionIds(w.ann.id), []);
      });

      test('setForPerson with an unknown id throws and changes nothing', async () => {
        await fresh();
        const w = await world();
        await data.qualifications.setForPerson(w.ann.id, [w.drums.id]);
        await assert.rejects(data.qualifications.setForPerson(w.ann.id, [w.keys.id, 9999]), Error);
        assert.deepEqual(await data.qualifications.listPositionIds(w.ann.id), [w.drums.id]);
        await assert.rejects(data.qualifications.setForPerson(9999, [w.keys.id]), Error);
        await data.tx(async (d) => {
          await assert.rejects(d.qualifications.setForPerson(w.ann.id, [w.sound.id, 9999]), Error);
          assert.deepEqual(await d.qualifications.listPositionIds(w.ann.id), [w.drums.id]);
        });
        assert.deepEqual(await data.qualifications.listPositionIds(w.ann.id), [w.drums.id]);
      });

      test('listPeople and mapByPosition only include active people', async () => {
        await fresh();
        const w = await world();
        await data.qualifications.setForPerson(w.cy.id, [w.drums.id]);
        await data.qualifications.setForPerson(w.bob.id, [w.drums.id, w.sound.id]);
        await data.qualifications.setForPerson(w.ann.id, [w.drums.id]);
        assert.deepEqual(await data.qualifications.listPeople(w.drums.id), [
          { id: w.ann.id, name: 'Ann Able' }, { id: w.bob.id, name: 'bob Baker' }, { id: w.cy.id, name: 'Cy Cole' },
        ]);
        await data.people.update(w.bob.id, { active: false });
        assert.deepEqual((await data.qualifications.listPeople(w.drums.id)).map((p) => p.id), [w.ann.id, w.cy.id]);
        assert.deepEqual(await data.qualifications.listPeople(w.sound.id), []);
        clean(await data.qualifications.listPeople(w.drums.id), 'qualifications.listPeople');
        const m = await data.qualifications.mapByPosition();
        assert.ok(m instanceof Map);
        assert.deepEqual(m.get(w.drums.id), [w.ann.id, w.cy.id].sort((a, b) => a - b));
        assert.equal(m.has(w.sound.id), false);
        assert.equal(m.has(w.keys.id), false);
      });
    });

    // ---------- services ----------
    describe('services', () => {
      test('create, find, duplicate date and time', async () => {
        await fresh();
        const s = await data.services.create({ date: '2025-01-05', time: '10:30', title: 'Sunday' });
        assert.deepEqual(s, { id: s.id, date: '2025-01-05', time: '10:30', title: 'Sunday' });
        const d = await data.services.create({ date: '2025-01-05', title: 'Early' });
        assert.equal(d.time, '09:00');
        await assert.rejects(data.services.create({ date: '2025-01-05', time: '10:30', title: 'Again' }), DuplicateError);
        assert.deepEqual(await data.services.findById(s.id), s);
        assert.equal(await data.services.findById(999), null);
        assert.deepEqual(await data.services.findByDateTime('2025-01-05', '10:30'), s);
        assert.equal(await data.services.findByDateTime('2025-01-05', '11:00'), null);
      });

      test('listRange is inclusive and sorted by date and time', async () => {
        await fresh();
        await data.services.create({ date: '2025-01-12', time: '09:00', title: 'B' });
        await data.services.create({ date: '2025-01-05', time: '11:00', title: 'A2' });
        await data.services.create({ date: '2025-01-05', time: '09:00', title: 'A1' });
        await data.services.create({ date: '2025-01-19', time: '09:00', title: 'C' });
        await data.services.create({ date: '2024-12-29', time: '09:00', title: 'Z' });
        const list = await data.services.listRange('2025-01-05', '2025-01-12');
        assert.deepEqual(list.map((s) => s.title), ['A1', 'A2', 'B']);
        clean(list, 'services.listRange');
      });

      test('update and remove (remove cascades slots)', async () => {
        await fresh();
        const w = await world();
        const s = await data.services.create({ date: '2025-01-05', time: '09:00', title: 'Sun' });
        await data.services.create({ date: '2025-01-12', time: '09:00', title: 'Next' });
        const u = await data.services.update(s.id, { title: 'Easter', time: '08:00' });
        assert.deepEqual(u, { id: s.id, date: '2025-01-05', time: '08:00', title: 'Easter' });
        await assert.rejects(data.services.update(s.id, { date: '2025-01-12', time: '09:00' }), DuplicateError);
        assert.equal(await data.services.update(999, { title: 'x' }), null);
        const [slot] = await data.slots.createMany(s.id, [w.drums.id]);
        assert.equal(await data.services.remove(s.id), true);
        assert.equal(await data.slots.findById(slot.id), null);
        assert.equal(await data.services.findById(s.id), null);
        assert.equal(await data.services.remove(s.id), false);
      });

      test('assignedCount counts the people in its slots, each once', async () => {
        await fresh();
        const w = await world();
        const s = await data.services.create({ date: '2025-01-05', time: '09:00', title: 'Sun' });
        const [a, b, c] = await data.slots.createMany(s.id, [w.drums.id, w.keys.id, w.sound.id]);
        assert.equal(await data.services.assignedCount(s.id), 0);
        await data.slots.assign(a.id, { personId: w.ann.id, assignedAt: T });
        await data.slots.assign(c.id, { personId: w.bob.id, status: 'accepted', assignedAt: T });
        assert.equal(await data.services.assignedCount(s.id), 2);
        await data.slots.assign(b.id, { personId: w.ann.id, assignedAt: T }); // Ann in two slots
        assert.equal(await data.services.assignedCount(s.id), 2);
      });
    });

    // ---------- slots ----------
    describe('slots', () => {
      test('createMany returns joined open slots in order', async () => {
        await fresh();
        const w = await world();
        const s = await data.services.create({ date: '2025-01-05', time: '09:00', title: 'Sun' });
        const slots = await data.slots.createMany(s.id, [w.sound.id, w.drums.id, w.drums.id]);
        assert.equal(slots.length, 3);
        assert.deepEqual(slots.map((x) => x.positionId), [w.sound.id, w.drums.id, w.drums.id]);
        assert.deepEqual(slots[0], {
          id: slots[0].id, serviceId: s.id, positionId: w.sound.id, personId: null, status: 'open',
          assignedAt: null, respondedAt: null, serviceDate: '2025-01-05', serviceTime: '09:00', serviceTitle: 'Sun',
          positionName: 'Sound', positionSort: w.sound.sort, teamId: w.tech.id, teamName: 'Tech', teamSort: w.tech.sort,
          personName: null,
        });
        assert.deepEqual(await data.slots.createMany(s.id, []), []);
      });

      test('listForPositionsFrom lists slots of those positions from a date, in service order', async () => {
        await fresh();
        const w = await world();
        const old = await data.services.create({ date: '2025-01-05', time: '09:00', title: 'Sun' });
        const late = await data.services.create({ date: '2025-01-12', time: '11:00', title: 'Sun' });
        const early = await data.services.create({ date: '2025-01-12', time: '09:00', title: 'Sun' });
        await data.slots.createMany(old.id, [w.drums.id]);
        await data.slots.createMany(late.id, [w.drums.id, w.sound.id]);
        await data.slots.createMany(early.id, [w.keys.id, w.drums.id]);
        const got = await data.slots.listForPositionsFrom([w.drums.id, w.keys.id], '2025-01-12');
        assert.deepEqual(got.map((x) => [x.serviceId, x.positionName]), [[early.id, 'Drums'], [early.id, 'Keys'], [late.id, 'Drums']]);
        assert.deepEqual(await data.slots.listForPositionsFrom([], '2025-01-01'), []);
      });

      test('createMany with an unknown position creates nothing', async () => {
        await fresh();
        const w = await world();
        const s = await data.services.create({ date: '2025-01-05', time: '09:00', title: 'Sun' });
        await assert.rejects(data.slots.createMany(s.id, [w.drums.id, 9999]), Error);
        assert.deepEqual(await data.slots.listForService(s.id), []);
        await assert.rejects(data.slots.createMany(9999, [w.drums.id]), Error);
        await data.tx(async (d) => {
          await assert.rejects(d.slots.createMany(s.id, [w.keys.id, 9999]), Error);
          assert.deepEqual(await d.slots.listForService(s.id), []);
        });
      });

      test('findById is joined with service, position, team and person', async () => {
        await fresh();
        const w = await world();
        const s = await data.services.create({ date: '2025-01-05', time: '09:00', title: 'Sun' });
        const [slot] = await data.slots.createMany(s.id, [w.keys.id]);
        await data.slots.assign(slot.id, { personId: w.bob.id, assignedAt: T });
        const f = await data.slots.findById(slot.id);
        assert.equal(f.serviceDate, '2025-01-05');
        assert.equal(f.serviceTime, '09:00');
        assert.equal(f.serviceTitle, 'Sun');
        assert.equal(f.positionName, 'Keys');
        assert.equal(f.teamName, 'Band');
        assert.equal(f.personName, 'bob Baker');
        assert.equal(f.personId, w.bob.id);
        noSecrets(f, 'slots.findById');
        noSnakeCase(f, 'slots.findById');
        assert.equal(await data.slots.findById(9999), null);
      });

      test('listForServices and listForService ordering', async () => {
        await fresh();
        const w = await world();
        await data.teams.update(w.tech.id, { sort: 0 }); // Tech before Band
        await data.positions.update(w.keys.id, { sort: 0 }); // Keys before Drums
        const s2 = await data.services.create({ date: '2025-01-12', time: '09:00', title: 'B' });
        const s1b = await data.services.create({ date: '2025-01-05', time: '11:00', title: 'A2' });
        const s1 = await data.services.create({ date: '2025-01-05', time: '09:00', title: 'A1' });
        const out = await data.services.create({ date: '2025-02-05', time: '09:00', title: 'Out' });
        await data.slots.createMany(out.id, [w.drums.id]);
        await data.slots.createMany(s2.id, [w.drums.id]);
        await data.slots.createMany(s1b.id, [w.drums.id]);
        const one = await data.slots.createMany(s1.id, [w.drums.id, w.keys.id, w.sound.id, w.drums.id]);
        const list = await data.slots.listForServices('2025-01-05', '2025-01-12');
        assert.deepEqual(list.map((x) => `${x.serviceTitle}:${x.positionName}`),
          ['A1:Sound', 'A1:Keys', 'A1:Drums', 'A1:Drums', 'A2:Drums', 'B:Drums']);
        assert.ok(list[2].id < list[3].id);
        const svc = await data.slots.listForService(s1.id);
        assert.deepEqual(svc.map((x) => x.id), [one[2].id, one[1].id, one[0].id, one[3].id]);
        clean(list, 'listForServices');
        clean(svc, 'listForService');
      });

      test('assign, respond, clear, remove', async () => {
        await fresh();
        const w = await world();
        const s = await data.services.create({ date: '2025-01-05', time: '09:00', title: 'Sun' });
        const [slot] = await data.slots.createMany(s.id, [w.drums.id]);
        let x = await data.slots.assign(slot.id, { personId: w.ann.id, assignedAt: T });
        assert.equal(x.personId, w.ann.id);
        assert.equal(x.status, 'pending');
        assert.equal(x.assignedAt, T);
        assert.equal(x.respondedAt, null);
        x = await data.slots.respond(slot.id, { status: 'accepted', respondedAt: '2025-01-02T00:00:00.000Z' });
        assert.equal(x.status, 'accepted');
        assert.equal(x.respondedAt, '2025-01-02T00:00:00.000Z');
        x = await data.slots.assign(slot.id, { personId: w.bob.id, status: 'accepted', assignedAt: T });
        assert.equal(x.status, 'accepted');
        assert.equal(x.respondedAt, null);
        assert.equal(x.personName, 'bob Baker');
        x = await data.slots.clear(slot.id);
        assert.deepEqual([x.personId, x.status, x.assignedAt, x.respondedAt, x.personName], [null, 'open', null, null, null]);
        assert.equal(await data.slots.assign(9999, { personId: w.ann.id, assignedAt: T }), null);
        assert.equal(await data.slots.clear(9999), null);
        assert.equal(await data.slots.respond(9999, { status: 'accepted', respondedAt: T }), null);
        assert.equal(await data.slots.remove(slot.id), true);
        assert.equal(await data.slots.remove(slot.id), false);
      });

      test('deactivating a person keeps their slots', async () => {
        await fresh();
        const w = await world();
        const s = await data.services.create({ date: '2025-01-05', time: '09:00', title: 'Sun' });
        const [slot] = await data.slots.createMany(s.id, [w.drums.id]);
        await data.slots.assign(slot.id, { personId: w.cy.id, assignedAt: T });
        await data.people.update(w.cy.id, { active: false });
        assert.equal((await data.slots.findById(slot.id)).personId, w.cy.id);
      });

      test('listForPerson filters by range and statuses', async () => {
        await fresh();
        const w = await world();
        const a = await data.services.create({ date: '2025-01-05', time: '09:00', title: 'A' });
        const b = await data.services.create({ date: '2025-01-12', time: '09:00', title: 'B' });
        const c = await data.services.create({ date: '2025-01-19', time: '09:00', title: 'C' });
        const [sa] = await data.slots.createMany(a.id, [w.drums.id]);
        const [sb, sb2] = await data.slots.createMany(b.id, [w.keys.id, w.sound.id]);
        const [sc] = await data.slots.createMany(c.id, [w.drums.id]);
        await data.slots.assign(sc.id, { personId: w.ann.id, assignedAt: T });
        await data.slots.assign(sa.id, { personId: w.ann.id, status: 'accepted', assignedAt: T });
        await data.slots.assign(sb.id, { personId: w.ann.id, assignedAt: T });
        await data.slots.respond(sb.id, { status: 'declined', respondedAt: T });
        await data.slots.assign(sb2.id, { personId: w.bob.id, assignedAt: T });
        const all = await data.slots.listForPerson(w.ann.id, '2025-01-01', '2025-12-31');
        assert.deepEqual(all.map((x) => x.id), [sa.id, sb.id, sc.id]);
        assert.equal(all[0].serviceTitle, 'A');
        assert.equal(all[0].positionName, 'Drums');
        assert.equal(all[0].teamName, 'Band');
        const ranged = await data.slots.listForPerson(w.ann.id, '2025-01-12', '2025-01-19');
        assert.deepEqual(ranged.map((x) => x.id), [sb.id, sc.id]);
        const live = await data.slots.listForPerson(w.ann.id, '2025-01-01', '2025-12-31', ['pending', 'accepted']);
        assert.deepEqual(live.map((x) => x.id), [sa.id, sc.id]);
        assert.deepEqual(await data.slots.listForPerson(w.ann.id, '2025-01-01', '2025-12-31', []), []);
        assert.deepEqual((await data.slots.listForPerson(w.ann.id)).map((x) => x.id), [sa.id, sb.id, sc.id]);
        assert.deepEqual(await data.slots.listForPerson(w.cy.id, '2025-01-01', '2025-12-31'), []);
        clean(all, 'listForPerson');
        // same service: team sort, then position sort
        const [k1, k2] = await data.slots.createMany(c.id, [w.keys.id, w.sound.id]);
        await data.slots.assign(k1.id, { personId: w.ann.id, assignedAt: T });
        await data.slots.assign(k2.id, { personId: w.ann.id, assignedAt: T });
        await data.teams.update(w.tech.id, { sort: -1 });
        const onC = await data.slots.listForPerson(w.ann.id, '2025-01-19', '2025-01-19');
        assert.deepEqual(onC.map((x) => x.id), [k2.id, sc.id, k1.id]);
      });

      test('countForPersonOnService and assignedBetween', async () => {
        await fresh();
        const w = await world();
        const a = await data.services.create({ date: '2025-01-05', time: '09:00', title: 'A' });
        const b = await data.services.create({ date: '2025-03-05', time: '09:00', title: 'B' });
        const [x, y, z] = await data.slots.createMany(a.id, [w.drums.id, w.keys.id, w.sound.id]);
        const [q] = await data.slots.createMany(b.id, [w.drums.id]);
        await data.slots.assign(x.id, { personId: w.ann.id, assignedAt: T });
        await data.slots.assign(y.id, { personId: w.ann.id, assignedAt: T });
        await data.slots.assign(z.id, { personId: w.bob.id, assignedAt: T });
        await data.slots.respond(z.id, { status: 'declined', respondedAt: T });
        await data.slots.assign(q.id, { personId: w.bob.id, assignedAt: T });
        assert.equal(await data.slots.countForPersonOnService(w.ann.id, a.id), 2);
        assert.equal(await data.slots.countForPersonOnService(w.bob.id, a.id), 1);
        assert.equal(await data.slots.countForPersonOnService(w.cy.id, a.id), 0);
        const stats = await data.slots.assignedBetween('2025-01-01', '2025-01-31');
        assert.deepEqual(stats.map((s) => s.id), [x.id, y.id, z.id]);
        clean(stats, 'assignedBetween');
        assert.ok(stats.every((s) => s.personId !== null && s.personName));
        assert.equal((await data.slots.assignedBetween('2025-01-01', '2025-12-31')).length, 4);
      });
    });

    // ---------- blockouts ----------
    describe('blockouts', () => {
      test('create and listForPerson', async () => {
        await fresh();
        const w = await world();
        const b1 = await data.blockouts.create({ personId: w.ann.id, startDate: '2025-02-01', endDate: '2025-02-03', reason: 'Trip', createdAt: T });
        assert.deepEqual(b1, { id: b1.id, personId: w.ann.id, startDate: '2025-02-01', endDate: '2025-02-03', reason: 'Trip', createdAt: T });
        const b0 = await data.blockouts.create({ personId: w.ann.id, startDate: '2025-01-01', endDate: '2025-01-02', reason: '', createdAt: T });
        const one = await data.blockouts.create({ personId: w.ann.id, startDate: '2025-03-01', createdAt: T });
        assert.equal(one.endDate, '2025-03-01');
        assert.equal(one.reason, '');
        await data.blockouts.create({ personId: w.bob.id, startDate: '2025-02-01', endDate: '2025-02-01', reason: '', createdAt: T });
        assert.deepEqual((await data.blockouts.listForPerson(w.ann.id)).map((b) => b.id), [b0.id, b1.id, one.id]);
        assert.deepEqual((await data.blockouts.listForPerson(w.ann.id, '2025-02-03')).map((b) => b.id), [b1.id, one.id]);
        const plain = (e) => e instanceof Error && !(e instanceof DuplicateError) && !(e instanceof InUseError) && e.code === undefined;
        await assert.rejects(data.blockouts.create({ personId: w.ann.id, startDate: '2025-02-05', endDate: '2025-02-04', reason: '', createdAt: T }), plain);
        await assert.rejects(data.blockouts.create({ personId: 9999, startDate: '2025-02-05', endDate: '2025-02-05', reason: '', createdAt: T }), plain);
        clean(await data.blockouts.listForPerson(w.ann.id), 'blockouts.listForPerson');
      });

      test('remove only removes your own', async () => {
        await fresh();
        const w = await world();
        const b = await data.blockouts.create({ personId: w.ann.id, startDate: '2025-02-01', endDate: '2025-02-03', reason: '', createdAt: T });
        assert.equal(await data.blockouts.remove(b.id, w.bob.id), false);
        assert.equal(await data.blockouts.remove(b.id, w.ann.id), true);
        assert.equal(await data.blockouts.remove(b.id, w.ann.id), false);
        assert.deepEqual(await data.blockouts.listForPerson(w.ann.id), []);
      });

      test('coversDate and blockedPersonIds', async () => {
        await fresh();
        const w = await world();
        await data.blockouts.create({ personId: w.ann.id, startDate: '2025-02-01', endDate: '2025-02-03', reason: '', createdAt: T });
        await data.blockouts.create({ personId: w.ann.id, startDate: '2025-02-02', endDate: '2025-02-02', reason: '', createdAt: T });
        await data.blockouts.create({ personId: w.bob.id, startDate: '2025-02-03', endDate: '2025-02-09', reason: '', createdAt: T });
        assert.equal(await data.blockouts.coversDate(w.ann.id, '2025-02-01'), true);
        assert.equal(await data.blockouts.coversDate(w.ann.id, '2025-02-03'), true);
        assert.equal(await data.blockouts.coversDate(w.ann.id, '2025-02-04'), false);
        assert.equal(await data.blockouts.coversDate(w.cy.id, '2025-02-02'), false);
        const set = await data.blockouts.blockedPersonIds('2025-02-03');
        assert.ok(set instanceof Set);
        assert.deepEqual([...set].sort((a, b) => a - b), [w.ann.id, w.bob.id].sort((a, b) => a - b));
        assert.deepEqual([...(await data.blockouts.blockedPersonIds('2025-02-02'))], [w.ann.id]);
        assert.equal((await data.blockouts.blockedPersonIds('2025-03-01')).size, 0);
      });

      test('listRange overlaps and includes personName', async () => {
        await fresh();
        const w = await world();
        const a = await data.blockouts.create({ personId: w.ann.id, startDate: '2025-01-28', endDate: '2025-02-02', reason: 'x', createdAt: T });
        const b = await data.blockouts.create({ personId: w.bob.id, startDate: '2025-02-10', endDate: '2025-02-12', reason: '', createdAt: T });
        const c = await data.blockouts.create({ personId: w.cy.id, startDate: '2025-03-01', endDate: '2025-03-01', reason: '', createdAt: T });
        const r = await data.blockouts.listRange('2025-02-01', '2025-02-28');
        assert.deepEqual(r.map((x) => x.id), [a.id, b.id]);
        assert.equal(r[0].personName, 'Ann Able');
        assert.equal(r[0].reason, 'x');
        clean(r, 'blockouts.listRange');
        assert.deepEqual((await data.blockouts.listRange()).map((x) => x.id), [a.id, b.id, c.id]);
        assert.deepEqual((await data.blockouts.listRange('2025-02-11')).map((x) => x.id), [b.id, c.id]);
        assert.deepEqual((await data.blockouts.listRange(null, '2025-02-01')).map((x) => x.id), [a.id]);
      });

      test('conflictingSlots lists pending and accepted slots in the range', async () => {
        await fresh();
        const w = await world();
        const s1 = await data.services.create({ date: '2025-02-02', time: '09:00', title: 'One' });
        const s2 = await data.services.create({ date: '2025-02-09', time: '09:00', title: 'Two' });
        const s3 = await data.services.create({ date: '2025-03-02', time: '09:00', title: 'Out' });
        const [a, d] = await data.slots.createMany(s1.id, [w.drums.id, w.keys.id]);
        const [b] = await data.slots.createMany(s2.id, [w.sound.id]);
        const [c] = await data.slots.createMany(s3.id, [w.drums.id]);
        await data.slots.assign(a.id, { personId: w.ann.id, assignedAt: T });
        await data.slots.assign(b.id, { personId: w.ann.id, status: 'accepted', assignedAt: T });
        await data.slots.assign(c.id, { personId: w.ann.id, assignedAt: T });
        await data.slots.assign(d.id, { personId: w.ann.id, assignedAt: T });
        await data.slots.respond(d.id, { status: 'declined', respondedAt: T });
        const list = await data.blockouts.conflictingSlots(w.ann.id, '2025-02-01', '2025-02-28');
        assert.deepEqual(list, [
          { slotId: a.id, serviceId: s1.id, date: '2025-02-02', time: '09:00', serviceTitle: 'One', positionName: 'Drums', teamName: 'Band', status: 'pending' },
          { slotId: b.id, serviceId: s2.id, date: '2025-02-09', time: '09:00', serviceTitle: 'Two', positionName: 'Sound', teamName: 'Tech', status: 'accepted' },
        ]);
        assert.deepEqual(await data.blockouts.conflictingSlots(w.bob.id, '2025-02-01', '2025-02-28'), []);
        clean(list, 'conflictingSlots');
      });
    });

    // ---------- availability ----------
    describe('availability', () => {
      test('get, set (insert then update), mapAll', async () => {
        await fresh();
        const w = await world();
        assert.equal(await data.availability.get(w.ann.id), null);
        const a1 = await data.availability.set(w.ann.id, { everyWeeks: 2, updatedAt: T });
        assert.deepEqual(a1, { personId: w.ann.id, everyWeeks: 2, updatedAt: T });
        clean(a1, 'availability.set');
        const T2 = '2025-02-01T00:00:00.000Z';
        assert.deepEqual(await data.availability.set(w.ann.id, { everyWeeks: 0, updatedAt: T2 }), { personId: w.ann.id, everyWeeks: 0, updatedAt: T2 });
        assert.deepEqual(await data.availability.get(w.ann.id), { personId: w.ann.id, everyWeeks: 0, updatedAt: T2 });
        await data.availability.set(w.cy.id, { everyWeeks: 4, updatedAt: T });
        const map = await data.availability.mapAll();
        assert.ok(map instanceof Map);
        assert.deepEqual([...map.entries()], [[w.ann.id, 0], [w.cy.id, 4]]);
      });

      test('set refuses an unknown person and a value outside the choices, and changes nothing', async () => {
        await fresh();
        const w = await world();
        const plain = (e) => e instanceof Error && !(e instanceof DuplicateError) && !(e instanceof InUseError);
        await assert.rejects(data.availability.set(9999, { everyWeeks: 2, updatedAt: T }), plain);
        for (const bad of [5, 7, 9, -1]) {
          await assert.rejects(data.availability.set(w.ann.id, { everyWeeks: bad, updatedAt: T }), plain);
        }
        assert.equal(await data.availability.get(w.ann.id), null);
        assert.equal((await data.availability.mapAll()).size, 0);
      });
    });

    // ---------- push devices ----------
    describe('pushDevices', () => {
      const dev = (personId, n, createdAt = T) => ({
        personId, endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, p256dh: `key-${n}`, auth: `auth-${n}`, createdAt,
      });

      test('save, findByEndpoint, listForPerson (oldest first), personIds', async () => {
        await fresh();
        const w = await world();
        const d1 = await data.pushDevices.save(dev(w.ann.id, 'a', '2025-01-02T00:00:00.000Z'));
        assert.deepEqual(d1, { id: d1.id, personId: w.ann.id, endpoint: 'https://fcm.googleapis.com/fcm/send/a', p256dh: 'key-a', auth: 'auth-a', createdAt: '2025-01-02T00:00:00.000Z' });
        clean(d1, 'pushDevices.save');
        await data.pushDevices.save(dev(w.ann.id, 'b', T));
        await data.pushDevices.save(dev(w.cy.id, 'c'));
        assert.deepEqual((await data.pushDevices.listForPerson(w.ann.id)).map((d) => d.endpoint.slice(-1)), ['b', 'a']);
        assert.deepEqual(await data.pushDevices.listForPerson(w.bob.id), []);
        assert.deepEqual(await data.pushDevices.findByEndpoint(d1.endpoint), d1);
        assert.equal(await data.pushDevices.findByEndpoint('https://nope.example/x'), null);
        const ids = await data.pushDevices.personIds();
        assert.ok(ids instanceof Set);
        assert.deepEqual([...ids], [w.ann.id, w.cy.id]);
      });

      test('saving a known endpoint replaces it and moves it to the new person', async () => {
        await fresh();
        const w = await world();
        const first = await data.pushDevices.save(dev(w.ann.id, 'a'));
        const T2 = '2025-03-01T00:00:00.000Z';
        const moved = await data.pushDevices.save({ ...dev(w.bob.id, 'a', T2), p256dh: 'new-key', auth: 'new-auth' });
        assert.deepEqual(moved, { id: first.id, personId: w.bob.id, endpoint: first.endpoint, p256dh: 'new-key', auth: 'new-auth', createdAt: T2 });
        assert.deepEqual(await data.pushDevices.listForPerson(w.ann.id), []);
        const plain = (e) => e instanceof Error && !(e instanceof DuplicateError);
        await assert.rejects(data.pushDevices.save(dev(9999, 'z')), plain);
        assert.equal(await data.pushDevices.findByEndpoint(dev(0, 'z').endpoint), null);
      });

      test('trimForPerson keeps the newest; remove, removeOwn, deleteForPerson', async () => {
        await fresh();
        const w = await world();
        for (const [n, day] of [['a', '03'], ['b', '01'], ['c', '02']]) await data.pushDevices.save(dev(w.ann.id, n, `2025-01-${day}T00:00:00.000Z`));
        await data.pushDevices.save(dev(w.bob.id, 'd'));
        assert.equal(await data.pushDevices.trimForPerson(w.ann.id, 2), 1);
        assert.deepEqual((await data.pushDevices.listForPerson(w.ann.id)).map((d) => d.endpoint.slice(-1)), ['c', 'a']);
        assert.equal(await data.pushDevices.trimForPerson(w.ann.id, 2), 0);
        assert.equal(await data.pushDevices.removeOwn(w.bob.id, dev(0, 'a').endpoint), false, 'not bob\'s');
        assert.equal(await data.pushDevices.removeOwn(w.ann.id, dev(0, 'a').endpoint), true);
        assert.equal(await data.pushDevices.remove(dev(0, 'd').endpoint), true);
        assert.equal(await data.pushDevices.remove(dev(0, 'd').endpoint), false);
        await data.pushDevices.save(dev(w.ann.id, 'e'));
        assert.equal(await data.pushDevices.deleteForPerson(w.ann.id), 2);
        assert.equal(await data.pushDevices.deleteForPerson(w.ann.id), 0);
        assert.equal((await data.pushDevices.personIds()).size, 0);
      });
    });

    // ---------- audit ----------
    describe('audit', () => {
      test('log truncates detail and list returns newest first', async () => {
        await fresh();
        await data.audit.log({ at: T, actorId: 1, action: 'a.one', detail: 'x'.repeat(600) });
        await data.audit.log({ at: new Date('2025-01-02T00:00:00.000Z'), actorId: null, action: 'a.two' });
        await data.audit.log({ at: '2025-01-03T00:00:00.000Z', action: 'a.three', detail: 'hi' });
        const all = await data.audit.list(10);
        assert.deepEqual(all.map((e) => e.action), ['a.three', 'a.two', 'a.one']);
        assert.equal(all[2].detail.length, 500);
        assert.equal(all[2].actorId, 1);
        assert.equal(all[1].actorId, null);
        assert.equal(all[1].at, '2025-01-02T00:00:00.000Z');
        assert.equal(all[1].detail, '');
        assert.deepEqual(Object.keys(all[0]).sort(), ['action', 'actorId', 'at', 'detail', 'id']);
        assert.deepEqual((await data.audit.list(2)).map((e) => e.action), ['a.three', 'a.two']);
        assert.equal((await data.audit.list()).length, 3);
        await data.audit.log({ at: '2025-01-03T00:00:00.000Z', actorId: 1, action: 'a.two' });
        await data.audit.log({ at: '2025-01-04T00:00:00.000Z', actorId: 2, action: 'a.two' });
        const count = (q) => data.audit.countSince({ actorId: 1, actions: ['a.one', 'a.two'], since: '2025-01-01T00:00:00.000Z', ...q });
        assert.equal(await count({}), 2, 'actor 1, either action, both days');
        assert.equal(await count({ since: new Date('2025-01-02T00:00:00.000Z') }), 1);
        assert.equal(await count({ actions: ['a.three'] }), 0);
        assert.equal(await count({ actions: [] }), 0);
        assert.equal(await count({ actorId: 2 }), 1);
      });
    });

    // ---------- maintenance ----------
    describe('maintenance', () => {
      test('personCount', async () => {
        await fresh();
        assert.equal(await data.maintenance.personCount(), 0);
        await person('ann');
        const b = await person('bob');
        await data.people.update(b.id, { active: false });
        assert.equal(await data.maintenance.personCount(), 2);
      });

      test('backupTo writes a copy and refuses to overwrite', async () => {
        await fresh();
        await person('ann');
        const dir = mkdtempSync(path.join(os.tmpdir(), 'flock-data-backup-'));
        try {
          const file = path.join(dir, 'backup.db');
          await data.maintenance.backupTo(file);
          assert.ok(existsSync(file));
          assert.ok(statSync(file).size > 0);
          await assert.rejects(data.maintenance.backupTo(file), Error);
          const other = path.join(dir, 'other.db');
          writeFileSync(other, 'keep me');
          await assert.rejects(data.maintenance.backupTo(other), Error);
          assert.equal(statSync(other).size, 7);
          await assert.rejects(data.tx((d) => d.maintenance.backupTo(path.join(dir, 'in-tx.db'))), Error);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });

    // ---------- attachments (decision 0011) ----------
    describe('attachments', () => {
      const svcOn = (date, time = '09:00') => data.services.create({ date, time, title: `S ${date}` });

      test('create a file and a link, findById, content, listForService, counts', async () => {
        await fresh();
        const w = await world();
        const s1 = await svcOn('2025-01-12');
        const s2 = await svcOn('2025-01-19');
        const bytes = Buffer.from('%PDF-1.4 hello');
        const f = await data.attachments.create({ serviceId: s1.id, kind: 'file', name: 'Setlist.pdf', mime: 'application/pdf', content: bytes, addedBy: w.ann.id, createdAt: T });
        assert.deepEqual(f, {
          id: f.id, serviceId: s1.id, serviceDate: '2025-01-12', kind: 'file', name: 'Setlist.pdf', mime: 'application/pdf',
          size: bytes.length, url: null, addedBy: w.ann.id, addedByName: 'Ann Able', createdAt: T,
        });
        clean(f, 'attachments.create');
        const l = await data.attachments.create({ serviceId: s1.id, kind: 'link', name: 'Video', url: 'https://example.com/v', addedBy: w.bob.id, createdAt: T });
        assert.equal(l.size, 0);
        assert.equal(l.mime, null);
        assert.deepEqual(await data.attachments.findById(f.id), f);
        assert.equal(await data.attachments.findById(9999), null);
        assert.deepEqual(await data.attachments.content(f.id), bytes);
        assert.equal(await data.attachments.content(l.id), null);
        assert.equal(await data.attachments.content(9999), null);
        assert.deepEqual((await data.attachments.listForService(s1.id)).map((a) => a.id), [f.id, l.id]);
        assert.deepEqual(await data.attachments.listForService(s2.id), []);
        assert.equal(await data.attachments.countForService(s1.id), 2);
        assert.equal(await data.attachments.countForService(s2.id), 0);
        assert.deepEqual(await data.attachments.countByService([s1.id, s2.id]), { [s1.id]: 2 });
        assert.deepEqual(await data.attachments.countByService([]), {});
        await data.attachments.create({ serviceId: s2.id, kind: 'file', name: 'b.txt', mime: 'text/plain', content: Buffer.from('12345'), addedBy: w.ann.id, createdAt: T });
        assert.equal(await data.attachments.bytesAddedBy(w.ann.id, '2025-01-12'), bytes.length + 5);
        assert.equal(await data.attachments.bytesAddedBy(w.ann.id, '2025-01-13'), 5, 'only services from that date');
        assert.equal(await data.attachments.bytesAddedBy(w.bob.id, '2025-01-01'), 0, 'links take no bytes');
        assert.equal(await data.services.countFrom('2025-01-12'), 2);
        assert.equal(await data.services.countFrom('2025-01-13'), 1);
        assert.equal(await data.services.countFrom('2025-02-01'), 0);
        await assert.rejects(data.attachments.create({ serviceId: 9999, kind: 'link', name: 'x', url: 'https://x.example', createdAt: T }), Error);
      });

      test('remove; deleting the service or the person', async () => {
        await fresh();
        const w = await world();
        const s1 = await svcOn('2025-01-12');
        const a = await data.attachments.create({ serviceId: s1.id, kind: 'link', name: 'A', url: 'https://a.example', addedBy: w.bob.id, createdAt: T });
        const b = await data.attachments.create({ serviceId: s1.id, kind: 'link', name: 'B', url: 'https://b.example', addedBy: w.bob.id, createdAt: T });
        assert.equal(await data.attachments.remove(a.id), true);
        assert.equal(await data.attachments.remove(a.id), false);
        assert.equal((await data.attachments.findById(b.id)).serviceDate, '2025-01-12');
        await data.services.update(s1.id, { date: '2025-02-02' });
        assert.equal((await data.attachments.findById(b.id)).serviceDate, '2025-02-02', 'the expiry follows the service date');
        await data.services.remove(s1.id);
        assert.equal(await data.attachments.findById(b.id), null);
      });

      test('removeForServicesUpTo deletes only services on or before the date', async () => {
        await fresh();
        const old = await svcOn('2025-01-05');
        const edge = await svcOn('2025-01-12');
        const later = await svcOn('2025-01-13');
        for (const s of [old, edge, later]) {
          await data.attachments.create({ serviceId: s.id, kind: 'file', name: 'f.txt', mime: 'text/plain', content: Buffer.from('abc'), createdAt: T });
        }
        await data.attachments.create({ serviceId: old.id, kind: 'link', name: 'l', url: 'https://l.example', createdAt: T });
        assert.deepEqual(await data.attachments.removeForServicesUpTo('2025-01-12'), { removed: 3, bytes: 6 });
        assert.deepEqual(await data.attachments.countByService([old.id, edge.id, later.id]), { [later.id]: 1 });
        assert.deepEqual(await data.attachments.removeForServicesUpTo('2025-01-12'), { removed: 0, bytes: 0 });
        await data.maintenance.compact();
        await assert.rejects(data.tx((d) => d.maintenance.compact()), Error);
      });
    });

    // ---------- transactions ----------
    describe('tx', () => {
      test('commits and returns the function result', async () => {
        await fresh();
        const r = await data.tx(async (d) => {
          const t = await d.teams.create({ name: 'Band' });
          await d.positions.create(t.id, { name: 'Drums' });
          return t.id;
        });
        assert.equal(typeof r, 'number');
        const t = await data.teams.findById(r);
        assert.equal(t.positions.length, 1);
      });

      test('rolls back everything when the function throws', async () => {
        await fresh();
        await assert.rejects(data.tx(async (d) => {
          await d.teams.create({ name: 'Band' });
          await person('ann');
          throw new Error('boom');
        }), /boom/);
        assert.deepEqual(await data.teams.list(), []);
        assert.deepEqual(await data.people.list(), []);
      });

      test('a failing statement inside tx rolls back earlier statements', async () => {
        await fresh();
        await data.teams.create({ name: 'Tech' });
        await assert.rejects(data.tx(async (d) => {
          await d.teams.create({ name: 'Band' });
          await d.teams.create({ name: 'tech' });
        }), DuplicateError);
        assert.deepEqual((await data.teams.list()).map((t) => t.name), ['Tech']);
      });

      test('nested tx reuses the outer transaction', async () => {
        await fresh();
        await data.tx(async (d) => {
          await d.teams.create({ name: 'A' });
          const inner = await d.tx(async (d2) => { await d2.teams.create({ name: 'B' }); return 'inner'; });
          assert.equal(inner, 'inner');
          await data.tx(async (d3) => { await d3.teams.create({ name: 'C' }); });
        });
        assert.deepEqual((await data.teams.list()).map((t) => t.name), ['A', 'B', 'C']);
        await assert.rejects(data.tx(async (d) => {
          await d.teams.create({ name: 'D' });
          await d.tx(async (d2) => { await d2.teams.create({ name: 'E' }); throw new Error('inner fail'); });
        }), /inner fail/);
        assert.deepEqual((await data.teams.list()).map((t) => t.name), ['A', 'B', 'C']);
      });

      test('nested tx error caught by the outer function: nested work is kept (no savepoint)', async () => {
        await fresh();
        await data.tx(async (d) => {
          await d.tx(async (d2) => { await d2.teams.create({ name: 'Kept' }); throw new Error('caught'); }).catch(() => {});
          await d.teams.create({ name: 'Outer' });
        });
        assert.deepEqual((await data.teams.list()).map((t) => t.name), ['Kept', 'Outer']);
      });

      test('top-level calls inside the tx callback join the transaction', async () => {
        await fresh();
        await assert.rejects(data.tx(async () => {
          await data.teams.create({ name: 'Inside' });
          assert.equal((await data.teams.list()).length, 1);
          throw new Error('undo');
        }), /undo/);
        assert.deepEqual(await data.teams.list(), []);
      });

      test('the bound repositories cannot be used after the tx finished', async () => {
        await fresh();
        let saved;
        await data.tx(async (d) => { saved = d; });
        await assert.rejects(saved.teams.list(), /finished/);
      });

      test('all methods return promises', async () => {
        await fresh();
        const p = data.people.list();
        assert.ok(p instanceof Promise);
        await p;
        const q = data.tx(() => 1);
        assert.ok(q instanceof Promise);
        assert.equal(await q, 1);
      });
    });
  });
}
