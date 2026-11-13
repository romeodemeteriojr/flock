// Unit tests of the teams service with injected fakes: in-memory data, fixed clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamsService } from '../src/services/teams-service.js';
import { fixedClock } from '../src/infra/clock.js';
import { silentLogger } from '../src/infra/logger.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/errors.js';
import { makeData } from './helpers/data.js';
import { recordingNotifications } from './helpers/notifications.js';

const NOW = '2025-01-05T12:00:00.000Z';

async function setup() {
  const { data } = makeData();
  const notifications = recordingNotifications();
  const teams = createTeamsService({ data, clock: fixedClock(NOW), logger: silentLogger(), notifications });
  const add = async (name, handle, role = 'member', active = true) => {
    const p = await data.people.create({ name, email: `${handle}@example.com`, role, passwordHash: 'x', createdAt: NOW });
    if (!active) await data.people.update(p.id, { active: false });
    return p.id;
  };
  const adminId = await add('Ada Admin', 'ada', 'admin');
  const memberId = await add('Max Member', 'max');
  const admin = { id: adminId, role: 'admin' };
  const member = { id: memberId, role: 'member' };
  const actions = async () => (await data.audit.list()).reverse();
  return { data, teams, add, admin, member, adminId, memberId, actions, notifications };
}

const conflict = (msg) => (e) => e instanceof ConflictError && e.status === 409 && e.message === msg;

test('teams service: create, rename, re-sort and delete a team with audit rows', async () => {
  const { teams, data, admin, actions } = await setup();
  const t = await teams.createTeam(admin, { name: 'Band' });
  assert.deepEqual(t, { id: t.id, name: 'Band', sort: 1 });
  const u = await teams.updateTeam(admin, t.id, { name: 'Worship Band', sort: 4 });
  assert.deepEqual(u, { id: t.id, name: 'Worship Band', sort: 4 });
  await teams.createPosition(admin, t.id, { name: 'Drums' });
  assert.deepEqual(await teams.deleteTeam(admin, t.id), { ok: true });
  assert.equal(await data.teams.findById(t.id), null);
  const rows = await actions();
  assert.deepEqual(rows.map((r) => r.action), ['team.create', 'team.update', 'position.create', 'team.delete']);
  assert.deepEqual(rows.map((r) => r.detail), [
    `team ${t.id} "Band"`, `team ${t.id} "Worship Band" sort 4`, `position 1 "Drums" in team ${t.id}`, `team ${t.id} "Worship Band"`,
  ]);
  for (const r of rows) { assert.equal(r.actorId, admin.id); assert.equal(r.at, NOW); }
});

test('teams service: duplicate team names become ConflictError with the old message', async () => {
  const { teams, admin } = await setup();
  const band = await teams.createTeam(admin, { name: 'Band' });
  await teams.createTeam(admin, { name: 'Sound' });
  await assert.rejects(teams.createTeam(admin, { name: 'band' }), conflict('A team with that name already exists'));
  await assert.rejects(teams.updateTeam(admin, band.id, { name: 'SOUND' }), conflict('A team with that name already exists'));
});

test('teams service: unknown teams and positions are NotFoundError', async () => {
  const { teams, admin } = await setup();
  await assert.rejects(teams.updateTeam(admin, 999, { name: 'Z' }), (e) => e instanceof NotFoundError && e.message === 'Team not found');
  await assert.rejects(teams.deleteTeam(admin, 999), NotFoundError);
  await assert.rejects(teams.createPosition(admin, 999, { name: 'A' }), (e) => e instanceof NotFoundError && e.message === 'Team not found');
  await assert.rejects(teams.updatePosition(admin, 999, { name: 'A' }), (e) => e instanceof NotFoundError && e.message === 'Position not found');
  await assert.rejects(teams.deletePosition(admin, 999), NotFoundError);
  await assert.rejects(teams.listPeopleForPosition(999), NotFoundError);
});

test('teams service: positions CRUD, moving teams and duplicate names', async () => {
  const { teams, admin, actions } = await setup();
  const t1 = (await teams.createTeam(admin, { name: 'Band' })).id;
  const t2 = (await teams.createTeam(admin, { name: 'Sound' })).id;
  const p = await teams.createPosition(admin, t1, { name: 'Drums' });
  assert.deepEqual(p, { id: p.id, teamId: t1, name: 'Drums', sort: 1 });
  await assert.rejects(teams.createPosition(admin, t1, { name: 'drums' }), conflict('That team already has a position with that name'));
  const moved = await teams.updatePosition(admin, p.id, { name: 'Keys', sort: 5, teamId: t2 });
  assert.deepEqual(moved, { id: p.id, teamId: t2, name: 'Keys', sort: 5 });
  await assert.rejects(teams.updatePosition(admin, p.id, { teamId: 999 }),
    (e) => e instanceof ValidationError && e.message === 'That team does not exist');
  await teams.createPosition(admin, t1, { name: 'Keys' });
  await assert.rejects(teams.updatePosition(admin, p.id, { teamId: t1 }), conflict('That team already has a position with that name'));
  assert.deepEqual(await teams.deletePosition(admin, p.id), { ok: true });
  const rows = await actions();
  assert.ok(rows.some((r) => r.action === 'position.update' && r.detail === `position ${p.id} "Keys" team ${t2} sort 5`));
  assert.ok(rows.some((r) => r.action === 'position.delete' && r.detail === `position ${p.id} "Keys"`));
});

test('teams service: deleting a position retires it; past slots keep it, upcoming open slots go', async () => {
  const { teams, data, admin, memberId, notifications } = await setup();
  const t = (await teams.createTeam(admin, { name: 'Band' })).id;
  const p = (await teams.createPosition(admin, t, { name: 'Drums' })).id;
  await data.qualifications.setForPerson(memberId, [p]);
  const past = await data.services.create({ date: '2025-01-04', title: 'Sunday' });
  const [pastSlot] = await data.slots.createMany(past.id, [p]);
  await data.slots.assign(pastSlot.id, { personId: memberId, status: 'accepted', assignedAt: NOW });
  const today = await data.services.create({ date: '2025-01-05', title: 'Sunday' });
  await data.slots.createMany(today.id, [p, p]);
  assert.deepEqual(await teams.deletePosition(admin, p), { ok: true });
  assert.equal(await data.positions.findById(p), null);
  assert.deepEqual((await data.teams.findById(t)).positions, []);
  assert.equal((await data.slots.listForService(today.id)).length, 0, 'upcoming open slots removed');
  const kept = (await data.slots.listForService(past.id));
  assert.deepEqual(kept.map((x) => [x.positionName, x.personId]), [['Drums', memberId]], 'past roster unchanged');
  assert.deepEqual(notifications.events, []);
  await assert.rejects(teams.deletePosition(admin, p), (e) => e instanceof NotFoundError);
});

test('teams service: deleting a position with people on upcoming services needs confirm, then tells them', async () => {
  const { teams, data, admin, memberId, add, notifications, actions } = await setup();
  const otherId = await add('Sam Singer', 'sam');
  const t = (await teams.createTeam(admin, { name: 'Band' })).id;
  const p = (await teams.createPosition(admin, t, { name: 'Drums' })).id;
  const svc = await data.services.create({ date: '2025-02-02', title: 'Sunday' });
  const [held, declined] = await data.slots.createMany(svc.id, [p, p]);
  await data.slots.assign(held.id, { personId: memberId, status: 'pending', assignedAt: NOW });
  await data.slots.assign(declined.id, { personId: otherId, status: 'declined', assignedAt: NOW });
  await assert.rejects(teams.deletePosition(admin, p), (e) => e instanceof ConflictError && e.code === 'has_people'
    && e.details.count === 1 && e.details.people[0].name === 'Max Member' && e.details.people[0].date === '2025-02-02');
  assert.ok(await data.positions.findById(p), 'nothing changed without confirm');
  assert.equal((await data.slots.listForService(svc.id)).length, 2);
  await teams.deletePosition(admin, p, { confirm: true });
  assert.equal((await data.slots.listForService(svc.id)).length, 0);
  assert.deepEqual(notifications.events.map((e) => [e[0], e[2].personId]), [['removed', memberId]], 'declined person not told');
  const [last] = (await actions()).slice(-1);
  assert.equal(last.action, 'position.delete');
  assert.match(last.detail, /\(1 people taken off\)$/);
});

test('teams service: deleting a team retires its positions with one confirm', async () => {
  const { teams, data, admin, memberId, notifications } = await setup();
  const t = (await teams.createTeam(admin, { name: 'Band' })).id;
  const a = (await teams.createPosition(admin, t, { name: 'Drums' })).id;
  const b = (await teams.createPosition(admin, t, { name: 'Bass' })).id;
  const old = (await teams.createPosition(admin, t, { name: 'Harp' })).id;
  await teams.deletePosition(admin, old);
  const svc = await data.services.create({ date: '2025-02-02', title: 'Sunday' });
  const [sa] = await data.slots.createMany(svc.id, [a, b]);
  await data.slots.assign(sa.id, { personId: memberId, status: 'accepted', assignedAt: NOW });
  await assert.rejects(teams.deleteTeam(admin, t), (e) => e.code === 'has_people' && e.details.count === 1);
  assert.ok(await data.teams.findById(t));
  await teams.deleteTeam(admin, t, { confirm: true });
  assert.equal(await data.teams.findById(t), null);
  assert.equal(await data.positions.findById(a), null);
  assert.equal(await data.positions.findById(b), null);
  assert.equal((await data.slots.listForService(svc.id)).length, 0);
  assert.equal(notifications.events.length, 1);
});

test('teams service: adding a deleted name brings the old one back', async () => {
  const { teams, data, admin, memberId, actions } = await setup();
  const t = (await teams.createTeam(admin, { name: 'Band' })).id;
  const p = (await teams.createPosition(admin, t, { name: 'Drums' })).id;
  await teams.setQualifications(admin, memberId, [p]);
  const past = await data.services.create({ date: '2025-01-01', title: 'Sunday' });
  await data.slots.createMany(past.id, [p]);
  await teams.deletePosition(admin, p);
  // Saving someone's positions while Drums is retired keeps the hidden qualification.
  await teams.setQualifications(admin, memberId, []);
  const back = await teams.createPosition(admin, t, { name: 'drums' });
  assert.equal(back.id, p);
  assert.equal(back.name, 'drums');
  assert.equal(back.revived, true);
  assert.equal(back.qualifiedCount, 1);
  assert.equal((await data.slots.listForService(past.id))[0].positionName, 'drums');
  await teams.deleteTeam(admin, t);
  const team = await teams.createTeam(admin, { name: 'BAND' });
  assert.equal(team.id, t);
  assert.equal(team.revived, true);
  assert.deepEqual((await data.teams.findById(t)).positions, [], 'positions stay retired');
  assert.equal((await teams.createPosition(admin, t, { name: 'Drums' })).id, p);
  const acts = (await actions()).map((r) => r.action);
  assert.ok(acts.includes('team.revive') && acts.includes('position.revive'));
});

test('teams service: renaming or moving onto a deleted name is a clear conflict', async () => {
  const { teams, admin } = await setup();
  const t = (await teams.createTeam(admin, { name: 'Band' })).id;
  const t2 = (await teams.createTeam(admin, { name: 'Tech' })).id;
  const old = (await teams.createPosition(admin, t, { name: 'Drums' })).id;
  await teams.deletePosition(admin, old);
  const p = (await teams.createPosition(admin, t, { name: 'Keys' })).id;
  await assert.rejects(teams.updatePosition(admin, p, { name: 'DRUMS' }),
    conflict('A deleted position has that name. Add it as a new position to bring it back'));
  const q = (await teams.createPosition(admin, t2, { name: 'Drums' })).id;
  await assert.rejects(teams.updatePosition(admin, q, { teamId: t }),
    conflict('A deleted position has that name. Add it as a new position to bring it back'));
  await teams.deleteTeam(admin, t2);
  await assert.rejects(teams.updateTeam(admin, t, { name: 'tech' }),
    conflict('A deleted team has that name. Add it as a new team to bring it back'));
});

test('teams service: setQualifications replaces, validates and audits', async () => {
  const { teams, data, admin, memberId, actions } = await setup();
  const t = (await teams.createTeam(admin, { name: 'Band' })).id;
  const a = (await teams.createPosition(admin, t, { name: 'Drums' })).id;
  const b = (await teams.createPosition(admin, t, { name: 'Bass' })).id;
  assert.deepEqual(await teams.setQualifications(admin, memberId, [b, a, b]), [a, b]);
  assert.deepEqual(await teams.setQualifications(admin, memberId, [b]), [b]);
  await assert.rejects(teams.setQualifications(admin, memberId, [b, 9999]),
    (e) => e instanceof ValidationError && e.message === 'One or more positions do not exist');
  await assert.rejects(teams.setQualifications(admin, memberId, 'x'),
    (e) => e instanceof ValidationError && e.message === 'positionIds must be a list of position ids');
  await assert.rejects(teams.setQualifications(admin, memberId, [1.5]), ValidationError);
  await assert.rejects(teams.setQualifications(admin, 999, []), (e) => e instanceof NotFoundError && e.message === 'Person not found');
  assert.deepEqual(await data.qualifications.listPositionIds(memberId), [b]);
  const q = (await actions()).filter((r) => r.action === 'person.positions').map((r) => r.detail);
  assert.deepEqual(q, [`person ${memberId} positions [${b},${a}]`, `person ${memberId} positions [${b}]`]);
});

test('teams service: list shows qualified people to admins only (active people only)', async () => {
  const { teams, add, admin, member, memberId } = await setup();
  const t = (await teams.createTeam(admin, { name: 'Band' })).id;
  const a = (await teams.createPosition(admin, t, { name: 'Drums' })).id;
  const b = (await teams.createPosition(admin, t, { name: 'Bass' })).id;
  const gone = await add('Old Timer', 'old', 'member', false);
  await teams.setQualifications(admin, memberId, [a, b]);
  await teams.setQualifications(admin, gone, [a]);
  const forAdmin = await teams.list(admin);
  assert.deepEqual(forAdmin, [{ id: t, name: 'Band', positions: [
    { id: a, name: 'Drums', qualifiedPersonIds: [memberId] },
    { id: b, name: 'Bass', qualifiedPersonIds: [memberId] },
  ] }]);
  const forMember = await teams.list(member);
  assert.deepEqual(forMember, [{ id: t, name: 'Band', positions: [{ id: a, name: 'Drums' }, { id: b, name: 'Bass' }] }]);
  assert.ok(!JSON.stringify(forMember).includes('qualified'));
  assert.deepEqual(await teams.listPeopleForPosition(a), [{ id: memberId, name: 'Max Member' }]);
});

test('teams service: myPositions in team and position order; sorting by sort then name', async () => {
  const { teams, admin, adminId, memberId } = await setup();
  const z = (await teams.createTeam(admin, { name: 'Zeta' })).id;
  const al = (await teams.createTeam(admin, { name: 'Alpha' })).id;
  await teams.updateTeam(admin, z, { sort: 0 });
  await teams.updateTeam(admin, al, { sort: 0 });
  const zb = (await teams.createPosition(admin, z, { name: 'B' })).id;
  const za = (await teams.createPosition(admin, z, { name: 'A' })).id;
  await teams.updatePosition(admin, zb, { sort: 0 });
  await teams.updatePosition(admin, za, { sort: 0 });
  const ax = (await teams.createPosition(admin, al, { name: 'X' })).id;
  await teams.setQualifications(admin, memberId, [zb, ax, za]);
  assert.deepEqual(await teams.myPositions(memberId), [
    { id: ax, name: 'X', teamId: al, teamName: 'Alpha' },
    { id: za, name: 'A', teamId: z, teamName: 'Zeta' },
    { id: zb, name: 'B', teamId: z, teamName: 'Zeta' },
  ]);
  assert.deepEqual(await teams.myPositions(adminId), []);
  assert.deepEqual((await teams.list(admin)).map((t) => t.name), ['Alpha', 'Zeta']);
});

test('teams service: raw input is checked in the old order and a refused change writes nothing', async () => {
  const { teams, data, admin, memberId } = await setup();
  const band = (await teams.createTeam(admin, { name: '  Band  ' })).id;
  assert.equal((await data.teams.findById(band)).name, 'Band');
  await teams.createTeam(admin, { name: 'Sound' });
  const p = (await teams.createPosition(admin, band, { name: 'Drums' })).id;
  const msg = (cls, m) => (e) => e instanceof cls && e.message === m;
  await assert.rejects(teams.createTeam(admin, {}), msg(ValidationError, 'Name must be 1 to 60 characters'));
  await assert.rejects(teams.createTeam(admin, { name: 'x'.repeat(61) }), msg(ValidationError, 'Name must be 1 to 60 characters'));
  await assert.rejects(teams.updateTeam(admin, 999, { name: '', sort: 'x' }), msg(NotFoundError, 'Team not found'));
  await assert.rejects(teams.updateTeam(admin, band, { name: 'SOUND', sort: 'x' }), msg(ConflictError, 'A team with that name already exists'));
  await assert.rejects(teams.updateTeam(admin, band, { name: 'Worship', sort: 1.5 }), msg(ValidationError, 'Sort must be a whole number'));
  assert.equal((await data.teams.findById(band)).name, 'Band', 'rename rolled back when sort was bad');
  await assert.rejects(teams.createPosition(admin, 999, { name: '' }), msg(NotFoundError, 'Team not found'));
  await assert.rejects(teams.createPosition(admin, band, { name: ' ' }), msg(ValidationError, 'Name must be 1 to 60 characters'));
  await assert.rejects(teams.updatePosition(admin, 999, { sort: 'x' }), msg(NotFoundError, 'Position not found'));
  await assert.rejects(teams.updatePosition(admin, p, { name: 'Keys', sort: 'x', teamId: 999 }), msg(ValidationError, 'Sort must be a whole number'));
  await assert.rejects(teams.updatePosition(admin, p, { teamId: 'x' }), msg(ValidationError, 'That team does not exist'));
  await assert.rejects(teams.setQualifications(admin, 999, 'x'), msg(NotFoundError, 'Person not found'));
  await assert.rejects(teams.setQualifications(admin, memberId, undefined), msg(ValidationError, 'positionIds must be a list of position ids'));
  const actions = (await data.audit.list()).map((r) => r.action);
  assert.deepEqual(actions.filter((a) => a.endsWith('.update') || a === 'person.positions'), []);
});
