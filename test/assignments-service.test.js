// Unit tests for the assignments service with injected fakes: a fixed clock,
// an in-memory data layer and a fake blockouts service. Only made-up people.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordingNotifications } from './helpers/notifications.js';
import { makeData } from './helpers/data.js';
import { fixedClock } from '../src/infra/clock.js';
import { silentLogger } from '../src/infra/logger.js';
import { createAssignmentsService } from '../src/services/assignments-service.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/errors.js';

const NOW = '2025-01-05T12:00:00'; // a Sunday
const TODAY = '2025-01-05';

async function setup({ blocked = [] } = {}) {
  const { db, data } = makeData();
  const clock = fixedClock(new Date(NOW));
  const blockedSet = new Set(blocked);
  const blockCalls = [];
  const blockouts = {
    async isBlocked(personId, date) { blockCalls.push([personId, date]); return blockedSet.has(`${personId}:${date}`); },
  };
  const svc = createAssignmentsService({ data, clock, blockouts, logger: silentLogger(), notifications: recordingNotifications() });
  const person = async (name, handle, { active = true } = {}) => {
    const p = await data.people.create({ name, email: `${handle}@example.com`, passwordHash: 'x', createdAt: NOW });
    if (!active) await data.people.update(p.id, { active: false });
    return p;
  };
  const admin = await person('Ada Admin', 'ada');
  const pat = await person('Pat Person', 'pat');
  const quinn = await person('Quinn Quill', 'quinn');
  const band = await data.teams.create({ name: 'Band' });
  const drums = await data.positions.create(band.id, { name: 'Drums' });
  const keys = await data.positions.create(band.id, { name: 'Keys' });
  await data.qualifications.setForPerson(pat.id, [drums.id, keys.id]);
  await data.qualifications.setForPerson(quinn.id, [drums.id, keys.id]);
  async function service(date, positions = [drums.id], time = '09:00') {
    const s = await data.services.create({ date, time, title: 'Sunday service' });
    const slots = await data.slots.createMany(s.id, positions);
    return { service: s, slots: slots.map((x) => x.id) };
  }
  const slot = (id) => data.slots.findById(id);
  const auditList = () => data.audit.list();
  return { db, data, clock, svc, admin, pat, quinn, person, drums, keys, service, slot, auditList, blockouts, blockCalls, blockedSet };
}

const conflict = (p, code) => assert.rejects(p, (e) => {
  assert.ok(e instanceof ConflictError, `expected ConflictError, got ${e?.name}: ${e?.message}`);
  assert.equal(e.code, code);
  assert.equal(e.exposeCode, true);
  assert.equal(e.status, 409);
  assert.equal(typeof e.message, 'string');
  return true;
});
const rejectsWith = (p, Type) => assert.rejects(p, (e) => {
  assert.ok(e instanceof Type, `expected ${Type.name}, got ${e?.name}: ${e?.message}`);
  return true;
});

test('assign: sets the person, pending, assignedAt from the clock, clears respondedAt, audits names', async () => {
  const { svc, admin, pat, service, slot, auditList } = await setup();
  const { slots: [id] } = await service('2025-01-12');
  const r = await svc.assign(admin, id, { personId: pat.id });
  assert.equal(r.id, id);
  assert.equal(r.personId, pat.id);
  assert.equal(r.personName, 'Pat Person');
  assert.equal(r.status, 'pending');
  assert.equal(r.assignedAt, new Date(NOW).toISOString());
  assert.equal(r.respondedAt, null);
  assert.equal(r.date, '2025-01-12');
  const stored = await slot(id);
  assert.equal(stored.status, 'pending');
  assert.equal(stored.personId, pat.id);
  const [entry] = await auditList();
  assert.equal(entry.action, 'slot.assign');
  assert.equal(entry.actorId, admin.id);
  assert.match(entry.detail, /Pat Person/);
  assert.doesNotMatch(entry.detail, /password|hash/i);
});

test('assign: today is allowed, a past service is refused with code past (even with force)', async () => {
  const { svc, admin, pat, service, slot } = await setup();
  const { slots: [todayId] } = await service(TODAY);
  assert.equal((await svc.assign(admin, todayId, { personId: pat.id })).status, 'pending');
  const { slots: [pastId] } = await service('2025-01-04');
  await conflict(svc.assign(admin, pastId, { personId: pat.id }), 'past');
  await conflict(svc.assign(admin, pastId, { personId: pat.id, force: true }), 'past');
  assert.equal((await slot(pastId)).personId, null);
});

test('assign: an inactive person is refused, even with force', async () => {
  const { svc, admin, person, service, slot } = await setup();
  const gone = await person('Gail Gone', 'gail', { active: false });
  const { slots: [id] } = await service('2025-01-12');
  await conflict(svc.assign(admin, id, { personId: gone.id }), 'inactive');
  await conflict(svc.assign(admin, id, { personId: gone.id, force: true }), 'inactive');
  assert.equal((await slot(id)).status, 'open');
});

test('assign: not_qualified unless forced', async () => {
  const { svc, admin, person, service, auditList } = await setup();
  const newbie = await person('Nina New', 'nina');
  const { slots: [id] } = await service('2025-01-12');
  await conflict(svc.assign(admin, id, { personId: newbie.id }), 'not_qualified');
  const r = await svc.assign(admin, id, { personId: newbie.id, force: true });
  assert.equal(r.personId, newbie.id);
  assert.match((await auditList())[0].detail, /forced: not_qualified/);
});

test('assign: blocked (through the blockouts service) unless forced', async () => {
  const ctx = await setup();
  const { svc, admin, pat, service, blockCalls, blockedSet } = ctx;
  blockedSet.add(`${pat.id}:2025-01-12`);
  const { slots: [id] } = await service('2025-01-12');
  await conflict(svc.assign(admin, id, { personId: pat.id }), 'blocked');
  assert.deepEqual(blockCalls.at(-1), [pat.id, '2025-01-12']);
  assert.equal((await svc.assign(admin, id, { personId: pat.id, force: true })).status, 'pending');
});

// ---------- several positions on one service (decision 0010) ----------

// Five positions in the band, Pat and Quinn trained for all of them.
async function fivePositions(ctx) {
  const { data, drums, keys, pat, quinn } = ctx;
  const band = (await data.teams.list()).find((t) => t.name === 'Band');
  const sound = await data.positions.create(band.id, { name: 'Sound' });
  const vocals = await data.positions.create(band.id, { name: 'Vocals' });
  const bass = await data.positions.create(band.id, { name: 'Bass' });
  const all = [drums.id, keys.id, sound.id, vocals.id, bass.id];
  await data.qualifications.setForPerson(pat.id, all);
  await data.qualifications.setForPerson(quinn.id, all);
  return { sound, vocals, bass, all };
}

test('assign: up to 3 positions on one service, with no warning and no force', async () => {
  const ctx = await setup();
  const { svc, admin, pat, service, auditList } = ctx;
  const { all } = await fivePositions(ctx);
  const { slots: [d, k, s] } = await service('2025-01-12', all);
  for (const id of [d, k, s]) {
    const r = await svc.assign(admin, id, { personId: pat.id });
    assert.equal(r.personId, pat.id);
    assert.equal(r.status, 'pending');
  }
  for (const e of await auditList()) assert.doesNotMatch(e.detail, /forced/);
});

test('assign: a 4th position on one service is refused (too_many_positions), even with force, and changes nothing', async () => {
  const ctx = await setup();
  const { svc, admin, pat, service, slot, auditList } = ctx;
  const { all } = await fivePositions(ctx);
  const { slots: [d, k, s, v] } = await service('2025-01-12', all);
  for (const id of [d, k, s]) await svc.assign(admin, id, { personId: pat.id });
  const before = (await auditList()).length;
  for (const force of [false, true]) {
    await conflict(svc.assign(admin, v, { personId: pat.id, force }), 'too_many_positions');
  }
  await assert.rejects(svc.assign(admin, v, { personId: pat.id }),
    { message: 'Pat Person already has 3 positions at this service, the most one person can have' });
  assert.equal((await slot(v)).personId, null);
  assert.equal((await slot(v)).status, 'open');
  assert.equal((await auditList()).length, before, 'a refusal is not audited as a change');
});

test('assign: accepted counts toward the limit, declined does not; taking someone off frees a place', async () => {
  const ctx = await setup();
  const { svc, admin, pat, service, data } = ctx;
  const { all } = await fivePositions(ctx);
  const { slots: [d, k, s, v, b] } = await service('2025-01-12', all);
  for (const id of [d, k, s]) await svc.assign(admin, id, { personId: pat.id });
  await data.slots.respond(d, { status: 'accepted', respondedAt: NOW });
  await conflict(svc.assign(admin, v, { personId: pat.id }), 'too_many_positions');
  await data.slots.respond(s, { status: 'declined', respondedAt: NOW });
  assert.equal((await svc.assign(admin, v, { personId: pat.id })).personId, pat.id); // d accepted, k + v pending
  await conflict(svc.assign(admin, b, { personId: pat.id }), 'too_many_positions');
  await svc.unassign(admin, k);
  assert.equal((await svc.assign(admin, b, { personId: pat.id })).personId, pat.id);
});

test('assign: at the limit, giving Pat a slot Pat already holds again is fine (not a 4th)', async () => {
  const ctx = await setup();
  const { svc, admin, pat, service, data } = ctx;
  const { all } = await fivePositions(ctx);
  const { slots: [d, k, s] } = await service('2025-01-12', all);
  for (const id of [d, k, s]) await svc.assign(admin, id, { personId: pat.id });
  assert.equal((await svc.assign(admin, s, { personId: pat.id })).status, 'pending');
  // A slot Pat declined, given back to Pat while Pat holds 2 others: 3 in all, fine.
  await data.slots.respond(s, { status: 'declined', respondedAt: NOW });
  assert.equal((await svc.assign(admin, s, { personId: pat.id })).status, 'pending');
});

test('assign: replacing someone else still counts Pat\'s own positions (too_many_positions beats accepted)', async () => {
  const ctx = await setup();
  const { svc, admin, pat, quinn, service, data, slot } = ctx;
  const { all } = await fivePositions(ctx);
  const { slots: [d, k, s, v] } = await service('2025-01-12', all);
  for (const id of [d, k, s]) await svc.assign(admin, id, { personId: pat.id });
  await svc.assign(admin, v, { personId: quinn.id });
  await data.slots.respond(v, { status: 'accepted', respondedAt: NOW });
  for (const force of [false, true]) await conflict(svc.assign(admin, v, { personId: pat.id, force }), 'too_many_positions');
  assert.equal((await slot(v)).personId, quinn.id, 'Quinn keeps the slot');
  assert.equal((await slot(v)).status, 'accepted');
});

test('assign: the limit is per service: another service the same day, or another week, does not count', async () => {
  const ctx = await setup();
  const { svc, admin, pat, service } = ctx;
  const { all } = await fivePositions(ctx);
  const { slots: [d, k, s] } = await service('2025-01-12', all);
  for (const id of [d, k, s]) await svc.assign(admin, id, { personId: pat.id });
  const { slots: evening } = await service('2025-01-12', all, '18:00');
  for (const id of evening.slice(0, 3)) assert.equal((await svc.assign(admin, id, { personId: pat.id })).personId, pat.id);
  const { slots: [next] } = await service('2025-01-19', all);
  assert.equal((await svc.assign(admin, next, { personId: pat.id })).personId, pat.id);
});

test('assign: two slots of the same position on one service is refused (same_position), even with force', async () => {
  const { svc, admin, pat, drums, keys, service, slot, data } = await setup();
  const { slots: [d1, d2, k] } = await service('2025-01-12', [drums.id, drums.id, keys.id]);
  await svc.assign(admin, d1, { personId: pat.id });
  for (const force of [false, true]) await conflict(svc.assign(admin, d2, { personId: pat.id, force }), 'same_position');
  await assert.rejects(svc.assign(admin, d2, { personId: pat.id }), { message: 'Pat Person is already on Drums at this service' });
  assert.equal((await slot(d2)).personId, null);
  // A different position is fine.
  assert.equal((await svc.assign(admin, k, { personId: pat.id })).personId, pat.id);
  // Once Pat said no to the first Drums, the second one is open to Pat.
  await data.slots.respond(d1, { status: 'declined', respondedAt: NOW });
  assert.equal((await svc.assign(admin, d2, { personId: pat.id })).personId, pat.id);
});

test('assign: the hard limits come before the overridable checks, and past/inactive before them', async () => {
  const ctx = await setup();
  const { svc, admin, pat, person, drums, service, blockedSet, data } = ctx;
  const { all } = await fivePositions(ctx);
  const { slots: [d, k, s, v] } = await service('2025-01-12', all);
  for (const id of [d, k, s]) await svc.assign(admin, id, { personId: pat.id });
  // Blocked and at the limit: the limit is what the scheduler hears, so a forced retry is not offered for nothing.
  blockedSet.add(`${pat.id}:2025-01-12`);
  await conflict(svc.assign(admin, v, { personId: pat.id }), 'too_many_positions');
  // Not trained and the same position: same_position.
  const nina = await person('Nina New', 'nina');
  const { slots: [x1, x2] } = await service('2025-01-19', [drums.id, drums.id]);
  await svc.assign(admin, x1, { personId: nina.id, force: true });
  await conflict(svc.assign(admin, x2, { personId: nina.id }), 'same_position');
  // Inactive beats the limits.
  await data.people.update(pat.id, { active: false });
  await conflict(svc.assign(admin, v, { personId: pat.id, force: true }), 'inactive');
});

test('assign: reassigning pending or declined slots is allowed; an accepted one needs force', async () => {
  const { svc, admin, pat, quinn, service, data, slot } = await setup();
  const { slots: [id] } = await service('2025-01-12');
  await svc.assign(admin, id, { personId: pat.id });
  assert.equal((await svc.assign(admin, id, { personId: quinn.id })).personId, quinn.id); // pending
  await data.slots.respond(id, { status: 'declined', respondedAt: NOW });
  const r = await svc.assign(admin, id, { personId: pat.id }); // declined
  assert.equal(r.personId, pat.id);
  assert.equal(r.status, 'pending');
  assert.equal(r.respondedAt, null);
  await data.slots.respond(id, { status: 'accepted', respondedAt: NOW });
  await conflict(svc.assign(admin, id, { personId: quinn.id }), 'accepted');
  assert.equal((await slot(id)).personId, pat.id);
  assert.equal((await svc.assign(admin, id, { personId: quinn.id, force: true })).personId, quinn.id);
});

test('assign: unknown slot or person, bad input', async () => {
  const { svc, admin, pat, service } = await setup();
  const { slots: [id] } = await service('2025-01-12');
  await rejectsWith(svc.assign(admin, 9999, { personId: pat.id }), NotFoundError);
  await rejectsWith(svc.assign(admin, null, { personId: pat.id }), NotFoundError);
  await rejectsWith(svc.assign(admin, id, { personId: 9999 }), NotFoundError);
  await rejectsWith(svc.assign(admin, id, { personId: 'x' }), ValidationError);
  await rejectsWith(svc.assign(admin, id, { personId: pat.id, force: 'yes' }), ValidationError);
});

test('assign: rolls back when something fails inside the transaction', async () => {
  const ctx = await setup();
  const { data, clock, blockouts, admin, pat, service, slot } = ctx;
  const failing = {
    ...data,
    tx: (fn) => data.tx((d) => fn({ ...d, audit: { log: async () => { throw new Error('disk full'); } } })),
  };
  const svc = createAssignmentsService({ data: failing, clock, blockouts, notifications: recordingNotifications() });
  const { slots: [id] } = await service('2025-01-12');
  await assert.rejects(svc.assign(admin, id, { personId: pat.id }), /disk full/);
  const s = await slot(id);
  assert.equal(s.personId, null);
  assert.equal(s.status, 'open');
  await ctx.svc.assign(admin, id, { personId: pat.id });
  await data.slots.respond(id, { status: 'accepted', respondedAt: NOW });
  await assert.rejects(svc.respond(pat.id, id, 'decline'), /disk full/);
  assert.equal((await slot(id)).status, 'accepted');
  await assert.rejects(svc.unassign(admin, id), /disk full/);
  assert.equal((await slot(id)).personId, pat.id);
});

test('unassign: back to open, audited; past refused; unknown 404', async () => {
  const { svc, admin, pat, service, slot, auditList } = await setup();
  const { slots: [id] } = await service('2025-01-12');
  await svc.assign(admin, id, { personId: pat.id });
  const r = await svc.unassign(admin, id);
  assert.equal(r.status, 'open');
  assert.equal(r.personId, null);
  assert.equal(r.assignedAt, null);
  const s = await slot(id);
  assert.equal(s.status, 'open');
  assert.equal(s.personId, null);
  const [entry] = await auditList();
  assert.equal(entry.action, 'slot.unassign');
  assert.match(entry.detail, /Pat Person/);
  assert.equal((await svc.unassign(admin, id)).status, 'open'); // already open: fine
  await rejectsWith(svc.unassign(admin, 9999), NotFoundError);
  const { slots: [pastId] } = await service('2024-12-29');
  await conflict(svc.unassign(admin, pastId), 'past');
});

test('respond: transitions pending/accepted/declined and respondedAt', async () => {
  const { svc, admin, pat, service, slot, clock, auditList } = await setup();
  const { slots: [id] } = await service('2025-01-12');
  await svc.assign(admin, id, { personId: pat.id });
  clock.advance(60000);
  const a = await svc.respond(pat.id, id, 'accept');
  assert.equal(a.status, 'accepted');
  assert.equal(a.respondedAt, clock.now().toISOString());
  assert.equal((await slot(id)).status, 'accepted');
  assert.equal((await auditList())[0].action, 'slot.accept');
  assert.equal((await auditList())[0].actorId, pat.id);
  // accepted -> declined (change of mind)
  clock.advance(60000);
  const d = await svc.respond(pat.id, id, 'decline');
  assert.equal(d.status, 'declined');
  assert.equal(d.respondedAt, clock.now().toISOString());
  // declined -> accepted while the slot is still theirs
  assert.equal((await svc.respond(pat.id, id, 'accept')).status, 'accepted');
  // same answer twice changes nothing
  const before = (await slot(id)).respondedAt;
  clock.advance(60000);
  assert.equal((await svc.respond(pat.id, id, 'accept')).respondedAt, before);
  // pending -> declined
  const { slots: [id2] } = await service('2025-01-19');
  await svc.assign(admin, id2, { personId: pat.id });
  assert.equal((await svc.respond(pat.id, id2, 'decline')).status, 'declined');
});

test('respond: only the slot\'s own person; declined -> accepted only while still theirs', async () => {
  const { svc, admin, pat, quinn, service, slot } = await setup();
  const { slots: [mine] } = await service('2025-01-19');
  await svc.assign(admin, mine, { personId: pat.id });
  await rejectsWith(svc.respond(quinn.id, mine, 'accept'), NotFoundError);
  assert.equal((await slot(mine)).status, 'pending');
  await svc.respond(pat.id, mine, 'decline');
  await svc.assign(admin, mine, { personId: quinn.id }); // the slot goes to someone else
  await rejectsWith(svc.respond(pat.id, mine, 'accept'), NotFoundError);
  assert.equal((await slot(mine)).personId, quinn.id);
  assert.equal((await slot(mine)).status, 'pending');
  const { slots: [empty] } = await service('2025-01-26');
  await rejectsWith(svc.respond(pat.id, empty, 'accept'), NotFoundError);
  await rejectsWith(svc.respond(pat.id, 9999, 'accept'), NotFoundError);
  await rejectsWith(svc.respond(pat.id, 'abc', 'accept'), NotFoundError);
  await rejectsWith(svc.respond(quinn.id, mine, 'maybe'), ValidationError);
});

test('respond: today is fine, the past is refused with code past', async () => {
  const { svc, admin, pat, service, data, clock } = await setup();
  const { slots: [t] } = await service(TODAY);
  await svc.assign(admin, t, { personId: pat.id });
  assert.equal((await svc.respond(pat.id, t, 'accept')).status, 'accepted');
  const { slots: [old] } = await service('2025-01-04');
  await data.slots.assign(old, { personId: pat.id, assignedAt: NOW });
  await conflict(svc.respond(pat.id, old, 'accept'), 'past');
  clock.set('2025-01-06T08:00:00');
  await conflict(svc.respond(pat.id, t, 'decline'), 'past');
});

test('mySchedule: pending and accepted only, 12 weeks from today, coVolunteers are names and positions only', async () => {
  const { svc, admin, pat, quinn, person, drums, keys, service, data } = await setup();
  const rae = await person('Rae Ray', 'rae');
  await data.qualifications.setForPerson(rae.id, [drums.id, keys.id]);
  const { service: s1, slots: [p1, q1, r1, open1] } = await service('2025-01-12', [drums.id, keys.id, keys.id, keys.id]);
  await svc.assign(admin, p1, { personId: pat.id });
  await svc.assign(admin, q1, { personId: quinn.id });
  await data.slots.respond(q1, { status: 'accepted', respondedAt: NOW });
  await svc.assign(admin, r1, { personId: rae.id });
  await data.slots.respond(r1, { status: 'declined', respondedAt: NOW });
  void open1;
  const { slots: [declined] } = await service('2025-01-19');
  await svc.assign(admin, declined, { personId: pat.id });
  await data.slots.respond(declined, { status: 'declined', respondedAt: NOW });
  const { slots: [acc] } = await service('2025-03-30'); // day 84: included
  await svc.assign(admin, acc, { personId: pat.id });
  await data.slots.respond(acc, { status: 'accepted', respondedAt: NOW });
  const { slots: [far] } = await service('2025-04-06'); // day 91: outside
  await svc.assign(admin, far, { personId: pat.id });
  const { slots: [past] } = await service('2024-12-29');
  await data.slots.assign(past, { personId: pat.id, assignedAt: NOW });

  const r = await svc.mySchedule(pat.id);
  assert.deepEqual(r.items.map((i) => i.slotId), [p1, acc]);
  assert.deepEqual(r.items[0], {
    slotId: p1, serviceId: s1.id, files: 0, date: '2025-01-12', time: '09:00', serviceTitle: s1.title, positionName: 'Drums', teamName: 'Band',
    status: 'pending', alsoOn: [], coVolunteers: [{ name: 'Quinn Quill', positionName: 'Keys' }],
  });
  assert.deepEqual(Object.keys(r.items[0].coVolunteers[0]).sort(), ['name', 'positionName']);
  assert.deepEqual(r.items[1].coVolunteers, []);
  assert.equal(r.nextServing.slotId, p1);
  // Privacy: nothing about other people beyond name and position.
  const text = JSON.stringify(r);
  assert.doesNotMatch(text, /Rae Ray|quinn|personId|@example\.com/);

  const fromPast = await svc.mySchedule(pat.id, { from: '2024-12-29' });
  assert.deepEqual(fromPast.items.map((i) => i.slotId), [past, p1]);
  assert.equal(fromPast.nextServing.slotId, p1); // the next one from today, not the past one
  const empty = await svc.mySchedule(rae.id);
  assert.deepEqual(empty, { nextServing: null, items: [], rosters: {}, recent: [] });
  await rejectsWith(svc.mySchedule(pat.id, { from: '2025-02-30' }), ValidationError);
});

test('mySchedule rosters: the whole day of each day I serve, by service, team and position; names only, never another day', async () => {
  const { svc, admin, pat, quinn, person, data, drums, keys } = await setup();
  const rae = await person('Rae Ray', 'rae');
  const sam = await person('Sam Sun', 'sam');
  await data.qualifications.setForPerson(rae.id, [drums.id, keys.id]);
  await data.qualifications.setForPerson(sam.id, [drums.id, keys.id]);
  const tech = await data.teams.create({ name: 'Tech' });
  const sound = await data.positions.create(tech.id, { name: 'Sound' });
  const slotsOf = async (date, time, title, positions) => {
    const s = await data.services.create({ date, time, title });
    return (await data.slots.createMany(s.id, positions)).map((x) => x.id);
  };
  // Pat's day: an evening service first (made first on purpose), then the morning one Pat is on.
  const [eDrums] = await slotsOf('2025-01-12', '18:00', 'Evening', [drums.id]);
  const [mSound, mKeys2, mKeys, mDrums] = await slotsOf('2025-01-12', '09:00', 'Morning', [sound.id, keys.id, keys.id, drums.id]);
  const [oDrums] = await slotsOf('2025-01-19', '09:00', 'Other day', [drums.id]); // not Pat's day
  void mSound;
  await svc.assign(admin, mDrums, { personId: pat.id });
  await svc.assign(admin, mKeys, { personId: quinn.id });
  await data.slots.respond(mKeys, { status: 'accepted', respondedAt: NOW });
  await svc.assign(admin, mKeys2, { personId: rae.id });
  await data.slots.respond(mKeys2, { status: 'declined', respondedAt: NOW });
  await svc.assign(admin, eDrums, { personId: sam.id });
  await svc.assign(admin, oDrums, { personId: quinn.id });

  const r = await svc.mySchedule(pat.id);
  assert.deepEqual(r.rosters, {
    '2025-01-12': [
      { time: '09:00', serviceTitle: 'Morning', teams: [
        { teamName: 'Band', positions: [
          { positionName: 'Drums', name: 'Pat Person', status: 'pending', mine: true },
          { positionName: 'Keys', name: null, status: 'open', mine: false }, // Rae said no: open, and no name
          { positionName: 'Keys', name: 'Quinn Quill', status: 'accepted', mine: false },
        ] },
        { teamName: 'Tech', positions: [{ positionName: 'Sound', name: null, status: 'open', mine: false }] },
      ] },
      { time: '18:00', serviceTitle: 'Evening', teams: [
        { teamName: 'Band', positions: [{ positionName: 'Drums', name: 'Sam Sun', status: 'pending', mine: false }] },
      ] },
    ],
  });
  // "Serving with" still means the same service only.
  assert.deepEqual(r.items[0].coVolunteers, [{ name: 'Quinn Quill', positionName: 'Keys' }]);
  assert.doesNotMatch(JSON.stringify(r), /Rae Ray|Other day|personId|@example\.com/);
  // Saying no makes it not my day any more: no roster for it.
  await svc.respond(pat.id, mDrums, 'decline');
  assert.deepEqual(await svc.mySchedule(pat.id), { nextServing: null, items: [], rosters: {}, recent: [] });
});

// ---------- several positions on one service: answering and my schedule (decision 0010) ----------

test('respond: taking back a decline is refused when Pat now holds the most positions (too_many_positions)', async () => {
  const ctx = await setup();
  const { svc, admin, pat, service, slot } = ctx;
  const { all } = await fivePositions(ctx);
  const { slots: [d, k, s, v] } = await service('2025-01-12', all);
  await svc.assign(admin, d, { personId: pat.id });
  await svc.respond(pat.id, d, 'decline');
  for (const id of [k, s, v]) await svc.assign(admin, id, { personId: pat.id });
  await conflict(svc.respond(pat.id, d, 'accept'), 'too_many_positions');
  await assert.rejects(svc.respond(pat.id, d, 'accept'),
    { message: 'You already have 3 positions at this service, the most one person can have' });
  assert.equal((await slot(d)).status, 'declined');
  // Saying no to one of the others frees the place, and then the take-back works.
  await svc.respond(pat.id, v, 'decline');
  assert.equal((await svc.respond(pat.id, d, 'accept')).status, 'accepted');
});

test('respond: taking back a decline is refused when Pat now holds that position in another slot (same_position)', async () => {
  const { svc, admin, pat, drums, service, slot } = await setup();
  const { slots: [d1, d2] } = await service('2025-01-12', [drums.id, drums.id]);
  await svc.assign(admin, d1, { personId: pat.id });
  await svc.respond(pat.id, d1, 'decline');
  await svc.assign(admin, d2, { personId: pat.id });
  await conflict(svc.respond(pat.id, d1, 'accept'), 'same_position');
  await assert.rejects(svc.respond(pat.id, d1, 'accept'), { message: 'You are already on Drums at this service' });
  assert.equal((await slot(d1)).status, 'declined');
});

test('respond: at the limit, accepting a pending ask and saying no are always fine', async () => {
  const ctx = await setup();
  const { svc, admin, pat, service } = ctx;
  const { all } = await fivePositions(ctx);
  const { slots: [d, k, s] } = await service('2025-01-12', all);
  for (const id of [d, k, s]) await svc.assign(admin, id, { personId: pat.id });
  for (const id of [d, k, s]) assert.equal((await svc.respond(pat.id, id, 'accept')).status, 'accepted');
  assert.equal((await svc.respond(pat.id, k, 'decline')).status, 'declined');
  assert.equal((await svc.respond(pat.id, k, 'accept')).status, 'accepted'); // back to 3, not 4
});

test('mySchedule: each position is its own item, and alsoOn names my other positions at that service only', async () => {
  const ctx = await setup();
  const { svc, admin, pat, quinn, service } = ctx;
  const { all } = await fivePositions(ctx);
  const { slots: [d, k, s, v] } = await service('2025-01-12', all);
  const { slots: [evening] } = await service('2025-01-12', all, '18:00');
  await svc.assign(admin, d, { personId: pat.id });
  await svc.assign(admin, k, { personId: pat.id });
  await svc.assign(admin, s, { personId: pat.id });
  await svc.respond(pat.id, s, 'decline'); // declined: not mine any more
  await svc.assign(admin, v, { personId: quinn.id });
  await svc.assign(admin, evening, { personId: pat.id });
  await svc.respond(pat.id, d, 'accept');

  const r = await svc.mySchedule(pat.id);
  assert.deepEqual(r.items.map((i) => [i.slotId, i.positionName, i.alsoOn]), [
    [d, 'Drums', ['Keys']],
    [k, 'Keys', ['Drums']],
    [evening, 'Drums', []],
  ]);
  // Pat is never a co-volunteer of Pat.
  for (const i of r.items) assert.ok(i.coVolunteers.every((c) => c.name !== 'Pat Person'));
  assert.deepEqual(r.items[0].coVolunteers, [{ name: 'Quinn Quill', positionName: 'Vocals' }]);
  // The roster marks both of Pat's positions as mine.
  const morning = r.rosters['2025-01-12'].find((x) => x.time === '09:00');
  const mine = morning.teams.flatMap((t) => t.positions).filter((p) => p.mine).map((p) => p.positionName);
  assert.deepEqual(mine, ['Drums', 'Keys']);
});
