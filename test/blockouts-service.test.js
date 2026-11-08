// Unit tests for the blockouts service with injected fakes: a fixed clock and
// an in-memory data layer. Only made-up people.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeData } from './helpers/data.js';
import { fixedClock } from '../src/infra/clock.js';
import { createBlockoutsService } from '../src/services/blockouts-service.js';
import { ValidationError, NotFoundError } from '../src/errors.js';

const NOW = '2025-01-05T12:00:00';

async function setup() {
  const { db, data } = makeData();
  const clock = fixedClock(new Date(NOW));
  const svc = createBlockoutsService({ data, clock });
  const pat = await data.people.create({ name: 'Pat Person', email: 'pat@example.com', passwordHash: 'x', createdAt: NOW });
  const quinn = await data.people.create({ name: 'Quinn Quill', email: 'quinn@example.com', passwordHash: 'x', createdAt: NOW });
  const team = await data.teams.create({ name: 'Band' });
  const pos = await data.positions.create(team.id, { name: 'Drums' });
  async function slot(personId, date, status, time = '09:00') {
    const s = await data.services.create({ date, time, title: 'Sunday' });
    const [sl] = await data.slots.createMany(s.id, [pos.id]);
    if (personId) {
      await data.slots.assign(sl.id, { personId, status: status === 'accepted' ? 'accepted' : 'pending', assignedAt: NOW });
      if (status === 'declined') await data.slots.respond(sl.id, { status: 'declined', respondedAt: NOW });
    }
    return sl.id;
  }
  const block = (personId, startDate, endDate, reason = '') => data.blockouts.create({ personId, startDate, endDate, reason, createdAt: NOW });
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM blockouts').get().n;
  return { data, clock, svc, pat, quinn, slot, block, count };
}

const rejectsWith = (p, Type, message) => assert.rejects(p, (e) => {
  assert.ok(e instanceof Type, `expected ${Type.name}, got ${e?.name}: ${e?.message}`);
  if (message !== undefined) assert.equal(e.message, message);
  return true;
});

test('blockouts: isBlocked and blockedPersonIds at the range edges', async () => {
  const { svc, pat, quinn, block } = await setup();
  await block(pat.id, '2025-03-10', '2025-03-10');
  await block(pat.id, '2025-03-11', '2025-03-12');
  await block(quinn.id, '2025-03-12', '2025-03-14');
  assert.equal(await svc.isBlocked(pat.id, '2025-03-09'), false);
  assert.equal(await svc.isBlocked(pat.id, '2025-03-10'), true);
  assert.equal(await svc.isBlocked(pat.id, '2025-03-12'), true);
  assert.equal(await svc.isBlocked(pat.id, '2025-03-13'), false);
  assert.equal(await svc.isBlocked(quinn.id, '2025-03-14'), true);
  assert.equal(await svc.isBlocked(quinn.id, '2025-03-15'), false);
  assert.deepEqual([...(await svc.blockedPersonIds('2025-03-12'))].sort(), [pat.id, quinn.id].sort());
  assert.deepEqual([...(await svc.blockedPersonIds('2025-03-13'))], [quinn.id]);
  assert.equal((await svc.blockedPersonIds('2025-03-15')).size, 0);
});

test('blockouts: conflictsFor only own pending/accepted slots, inclusive, in order, old shape', async () => {
  const { svc, pat, quinn, slot } = await setup();
  await slot(pat.id, '2025-04-06', 'declined', '08:00');
  await slot(null, '2025-04-06', 'open', '10:00');
  const late = await slot(pat.id, '2025-04-06', 'accepted', '18:00');
  const early = await slot(pat.id, '2025-04-06', 'pending', '11:00');
  await slot(quinn.id, '2025-04-06', 'accepted', '12:00');
  const edge = await slot(pat.id, '2025-04-30', 'pending');
  await slot(pat.id, '2025-05-01', 'pending');
  const c = await svc.conflictsFor(pat.id, '2025-04-06', '2025-04-30');
  assert.deepEqual(c.map((x) => x.slotId), [early, late, edge]);
  assert.deepEqual(c[0], { slotId: early, date: '2025-04-06', time: '11:00', serviceTitle: 'Sunday', positionName: 'Drums', teamName: 'Band', status: 'pending' });
});

test('blockouts: add with defaults, trims the reason and returns conflicts', async () => {
  const { svc, pat, slot, data } = await setup();
  const s = await slot(pat.id, '2025-11-08', 'accepted');
  await slot(pat.id, '2025-11-09', 'declined');
  const r = await svc.add(pat.id, { startDate: '2025-11-08', reason: '  trip  ' });
  assert.deepEqual(Object.keys(r.blockout), ['id', 'personId', 'startDate', 'endDate', 'reason']);
  assert.equal(r.blockout.personId, pat.id);
  assert.equal(r.blockout.endDate, '2025-11-08');
  assert.equal(r.blockout.reason, 'trip');
  assert.deepEqual(r.conflicts.map((c) => c.slotId), [s]);
  const [stored] = await data.blockouts.listForPerson(pat.id);
  assert.equal(stored.createdAt, new Date(NOW).toISOString());
  for (const empty of [null, '']) {
    assert.equal((await svc.add(pat.id, { startDate: '2025-06-01', endDate: empty })).blockout.endDate, '2025-06-01');
  }
});

test('blockouts: add validation rules and boundary dates', async () => {
  const { svc, pat, count } = await setup();
  const cases = [
    [{}, 'Start date must be a real date like 2025-11-08'],
    [{ startDate: '2025-02-30' }, 'Start date must be a real date like 2025-11-08'],
    [{ startDate: 5 }, 'Start date must be a real date like 2025-11-08'],
    [{ startDate: '2025-03-01', endDate: 'x' }, 'End date must be a real date like 2025-11-08'],
    [{ startDate: '2025-03-01', endDate: '2025-02-28' }, 'End date cannot be before the start date'],
    [{ startDate: '2025-01-01', endDate: '2025-01-04' }, 'That time is already past'],
    [{ startDate: '2024-12-01' }, 'That time is already past'],
    [{ startDate: '2025-01-10', endDate: '2026-01-11' }, 'A blockout can be at most 366 days'],
    [{ startDate: '2025-01-10', reason: 7 }, 'Reason must be text'],
    [{ startDate: '2025-01-10', reason: 'a'.repeat(201) }, 'Reason can be at most 200 characters'],
  ];
  for (const [input, message] of cases) await rejectsWith(svc.add(pat.id, input), ValidationError, message);
  assert.equal(count(), 0);
  // Boundaries that are allowed.
  await svc.add(pat.id, { startDate: '2025-01-05' }); // today
  await svc.add(pat.id, { startDate: '2025-01-01', endDate: '2025-01-05' }); // ends today
  await svc.add(pat.id, { startDate: '2025-01-10', endDate: '2026-01-10' }); // exactly 366 days
  await svc.add(pat.id, { startDate: '2025-01-10', reason: 'a'.repeat(200) });
  await svc.add(pat.id, { startDate: '2028-02-29' });
  await svc.add(pat.id, { startDate: '2025-01-10', reason: `  ${'a'.repeat(200)}  ` }); // trimmed first
  assert.equal(count(), 6);
});

test('blockouts: "today" follows the clock (local date)', async () => {
  const { svc, clock, pat } = await setup();
  clock.set(new Date(2025, 5, 1, 23, 59));
  await svc.add(pat.id, { startDate: '2025-06-01' });
  clock.advance(60_000);
  await rejectsWith(svc.add(pat.id, { startDate: '2025-06-01' }), ValidationError, 'That time is already past');
  assert.deepEqual(await svc.listMine(pat.id), []);
});

test('blockouts: listMine hides past ones and other people, sorted', async () => {
  const { svc, pat, quinn, block } = await setup();
  await block(pat.id, '2025-11-08', '2025-11-08');
  await block(pat.id, '2025-02-01', '2025-02-03');
  await block(pat.id, '2025-01-01', '2025-01-05');
  await block(pat.id, '2024-01-01', '2025-01-04');
  await block(quinn.id, '2025-03-01', '2025-03-01');
  const mine = await svc.listMine(pat.id);
  assert.deepEqual(mine.map((b) => b.startDate), ['2025-01-01', '2025-02-01', '2025-11-08']);
  assert.ok(mine.every((b) => b.personId === pat.id && !('createdAt' in b)));
});

test('blockouts: removeOwn only removes your own', async () => {
  const { svc, pat, quinn, block, count } = await setup();
  const theirs = await block(quinn.id, '2025-05-01', '2025-05-02');
  const mine = await block(pat.id, '2025-05-03', '2025-05-04');
  await rejectsWith(svc.removeOwn(pat.id, theirs.id), NotFoundError, 'Blockout not found');
  await rejectsWith(svc.removeOwn(pat.id, null), NotFoundError, 'Blockout not found');
  assert.equal(count(), 2);
  assert.deepEqual(await svc.removeOwn(pat.id, mine.id), { ok: true });
  await rejectsWith(svc.removeOwn(pat.id, mine.id), NotFoundError);
  assert.deepEqual(await svc.removeOwn(quinn.id, theirs.id), { ok: true });
  assert.equal(count(), 0);
});

test('blockouts: admin listings', async () => {
  const { svc, pat, quinn, block } = await setup();
  await block(pat.id, '2025-05-03', '2025-05-10', 'away');
  await block(pat.id, '2024-07-01', '2024-07-01');
  await block(quinn.id, '2025-06-30', '2025-07-02');
  const p = await svc.listForPerson(pat.id);
  assert.deepEqual(p.map((b) => b.startDate), ['2024-07-01', '2025-05-03']); // past ones too
  assert.deepEqual(Object.keys(p[0]), ['id', 'personId', 'startDate', 'endDate', 'reason', 'personName']);
  assert.equal(p[0].personName, 'Pat Person');
  await rejectsWith(svc.listForPerson(9999), NotFoundError, 'Person not found');
  await rejectsWith(svc.listForPerson(null), NotFoundError, 'Person not found');
  assert.equal((await svc.listRange()).length, 3);
  const f = await svc.listRange('2025-05-10', '2025-06-30');
  assert.deepEqual(f.map((b) => `${b.startDate} ${b.personName}`), ['2025-05-03 Pat Person', '2025-06-30 Quinn Quill']);
  assert.equal((await svc.listRange('2025-05-11', '2025-06-29')).length, 0);
  assert.equal((await svc.listRange('2025-07-02')).length, 1);
  assert.equal((await svc.listRange(undefined, '2024-07-01')).length, 1);
  await rejectsWith(svc.listRange('bad'), ValidationError, 'From must be a real date like 2025-11-08');
  await rejectsWith(svc.listRange('2025-01-01', '2025-02-30'), ValidationError, 'To must be a real date like 2025-11-08');
});

test('blockouts: add stores nothing when the transaction fails', async () => {
  const { data, clock, pat, count } = await setup();
  const broken = {
    ...data,
    tx: (fn) => data.tx((d) => fn({ ...d, blockouts: { ...d.blockouts, conflictingSlots: async () => { throw new Error('read failed'); } } })),
  };
  const svc = createBlockoutsService({ data: broken, clock });
  await assert.rejects(svc.add(pat.id, { startDate: '2025-06-01' }), /read failed/);
  assert.equal(count(), 0);
});
