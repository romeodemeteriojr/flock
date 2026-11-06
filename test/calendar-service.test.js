// Unit tests for the calendar service with injected fakes: a fixed clock and
// an in-memory data layer. Only made-up people.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeData } from './helpers/data.js';
import { fixedClock } from '../src/infra/clock.js';
import { createCalendarService } from '../src/services/calendar-service.js';
import { ValidationError, ConflictError, NotFoundError } from '../src/errors.js';

const NOW = '2026-01-05T12:00:00';

async function setup({ wrap } = {}) {
  const { db, data } = makeData();
  const clock = fixedClock(new Date(NOW));
  const svc = createCalendarService({ data: wrap ? wrap(data) : data, clock });
  const band = await data.teams.create({ name: 'Band', sort: 1 });
  const tech = await data.teams.create({ name: 'Tech', sort: 2 });
  const drums = await data.positions.create(band.id, { name: 'Drums', sort: 2 });
  const piano = await data.positions.create(band.id, { name: 'Piano', sort: 1 });
  const sound = await data.positions.create(tech.id, { name: 'Sound', sort: 1 });
  const admin = await data.people.create({ name: 'Ada Admin', username: 'ada', passwordHash: 'x', role: 'admin', createdAt: NOW });
  const pat = await data.people.create({ name: 'Pat Person', username: 'pat', passwordHash: 'x', createdAt: NOW });
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return { db, data, clock, svc, admin, pat, pos: { drums: drums.id, piano: piano.id, sound: sound.id }, count };
}

// The audit repo fails inside transactions, so every multi-step write must roll back.
const failingAudit = (data) => ({
  ...data,
  tx: (fn) => data.tx((d) => fn({ ...d, audit: { ...d.audit, log: async () => { throw new Error('audit is down'); } } })),
});

const rejectsWith = (p, Type, message, code) => assert.rejects(p, (e) => {
  assert.ok(e instanceof Type, `expected ${Type.name}, got ${e?.name}: ${e?.message}`);
  if (message !== undefined) assert.equal(e.message, message);
  if (code !== undefined) assert.equal(e.code, code);
  return true;
});

test('calendar: createService with defaults, slots in team/position order, audit', async () => {
  const { svc, admin, pos, data } = await setup();
  const s = await svc.createService(admin, { date: '2026-03-01', slots: [{ positionId: pos.drums, count: 2 }, { positionId: pos.piano }, { positionId: pos.sound }] });
  assert.equal(s.time, '09:00');
  assert.equal(s.title, 'Sunday service');
  assert.deepEqual(s.slots.map((x) => x.positionName), ['Piano', 'Drums', 'Drums', 'Sound']);
  assert.deepEqual(Object.keys(s.slots[0]), ['id', 'positionId', 'positionName', 'teamId', 'teamName', 'status', 'personId', 'personName']);
  assert.equal(s.slots[0].status, 'open');
  assert.equal(s.slots[0].personId, null);
  const [entry] = await data.audit.list(1);
  assert.equal(entry.action, 'service.create');
  assert.equal(entry.actorId, admin.id);
  assert.equal(entry.at, new Date(NOW).toISOString());
  assert.equal(entry.detail, `service ${s.id} 2026-03-01 09:00 "Sunday service"`);
});

test('calendar: createService validation, count limits and same date+time conflict', async () => {
  const { svc, admin, pos, count } = await setup();
  await svc.createService(admin, { date: '2026-03-01', title: '  Easter  ' });
  await rejectsWith(svc.createService(admin, { date: '2026-03-01' }), ConflictError, 'A service already exists at that date and time');
  assert.equal((await svc.createService(admin, { date: '2026-03-01', time: '18:00' })).time, '18:00');
  const cases = [
    [{ date: '2026-02-30' }, 'Date must be a real date like 2026-03-01'],
    [{}, 'Date must be a real date like 2026-03-01'],
    [{ date: '2026-03-08', time: '24:00' }, 'Time must look like 09:00'],
    [{ date: '2026-03-08', time: null }, 'Time must look like 09:00'],
    [{ date: '2026-03-08', title: '' }, 'Title must be 1 to 100 characters'],
    [{ date: '2026-03-08', title: 'x'.repeat(101) }, 'Title must be 1 to 100 characters'],
    [{ date: '2026-03-08', slots: 'x' }, 'Slots must be a list'],
    [{ date: '2026-03-08', slots: [null] }, 'Each slot needs a positionId'],
    [{ date: '2026-03-08', slots: [{ positionId: 999 }] }, 'One or more positions do not exist'],
    [{ date: '2026-03-08', slots: [{ positionId: pos.drums, count: 0 }] }, 'Count must be a whole number from 1 to 20'],
    [{ date: '2026-03-08', slots: [{ positionId: pos.drums, count: 21 }] }, 'Count must be a whole number from 1 to 20'],
    [{ date: '2026-03-08', slots: [{ positionId: pos.drums, count: 1.5 }] }, 'Count must be a whole number from 1 to 20'],
  ];
  for (const [input, message] of cases) await rejectsWith(svc.createService(admin, input), ValidationError, message);
  assert.equal(count('services'), 2);
  const big = await svc.createService(admin, { date: '2026-03-08', title: 'x'.repeat(100), slots: [{ positionId: pos.drums, count: 20 }] });
  assert.equal(big.slots.length, 20);
  assert.equal((await svc.createService(admin, { date: '2028-02-29' })).date, '2028-02-29');
});

test('calendar: createService rolls back service and slots when a later step fails', async () => {
  const { svc, admin, pos, count } = await setup({ wrap: failingAudit });
  await assert.rejects(svc.createService(admin, { date: '2026-03-01', slots: [{ positionId: pos.drums, count: 3 }] }), /audit is down/);
  assert.equal(count('services'), 0);
  assert.equal(count('slots'), 0);
});

test('calendar: repeat copies structure weekly, skips existing, caps at 26 weeks', async () => {
  const { svc, admin, pat, pos, data } = await setup();
  const src = await svc.createService(admin, { date: '2026-12-27', time: '10:30', title: 'Carols', slots: [{ positionId: pos.drums, count: 2 }, { positionId: pos.sound }] });
  await data.slots.assign(src.slots.find((s) => s.positionId === pos.sound).id, { personId: pat.id, status: 'accepted', assignedAt: NOW });
  await svc.createService(admin, { date: '2027-01-10', time: '10:30' });
  await svc.createService(admin, { date: '2027-01-03', time: '09:00' }); // other time: not a clash
  const r = await svc.repeat(admin, { fromServiceId: src.id, weeks: 3 });
  assert.deepEqual(r.skipped, ['2027-01-10']);
  assert.deepEqual(r.created.map((s) => `${s.date} ${s.time} ${s.title}`), ['2027-01-03 10:30 Carols', '2027-01-17 10:30 Carols']);
  for (const s of r.created) {
    assert.deepEqual(s.slots.map((x) => x.positionName), ['Drums', 'Drums', 'Sound']);
    assert.ok(s.slots.every((x) => x.status === 'open' && x.personId === null));
  }
  const [entry] = await data.audit.list(1);
  assert.equal(entry.action, 'service.repeat');
  assert.equal(entry.detail, `service ${src.id} for 3 weeks: 2 created, 1 skipped`);
  await rejectsWith(svc.repeat(admin, { fromServiceId: src.id, weeks: 0 }), ValidationError, 'Weeks must be a whole number from 1 to 26');
  await rejectsWith(svc.repeat(admin, { fromServiceId: src.id, weeks: 27 }), ValidationError, 'Weeks must be a whole number from 1 to 26');
  await rejectsWith(svc.repeat(admin, { fromServiceId: src.id, weeks: '2' }), ValidationError);
  await rejectsWith(svc.repeat(admin, { fromServiceId: 999, weeks: 2 }), NotFoundError, 'Service not found');
  await rejectsWith(svc.repeat(admin, { fromServiceId: 'x', weeks: 2 }), NotFoundError);
  const big = await svc.repeat(admin, { fromServiceId: src.id, weeks: 26 });
  assert.equal(big.created.length + big.skipped.length, 26);
  assert.equal(big.created.length, 23);
});

test('calendar: repeat rolls back every copy on failure', async () => {
  const { data, svc: plain, admin, pos, count } = await setup();
  const src = await plain.createService(admin, { date: '2026-03-01', slots: [{ positionId: pos.drums }] });
  const svc = createCalendarService({ data: failingAudit(data), clock: fixedClock(new Date(NOW)) });
  await assert.rejects(svc.repeat(admin, { fromServiceId: src.id, weeks: 4 }), /audit is down/);
  assert.equal(count('services'), 1);
  assert.equal(count('slots'), 1);
});

test('calendar: listServices defaults from the clock, inclusive ends, range limits', async () => {
  const { svc, admin, pos } = await setup();
  await svc.createService(admin, { date: '2026-01-11', time: '11:00', slots: [{ positionId: pos.sound }, { positionId: pos.drums }, { positionId: pos.piano }] });
  await svc.createService(admin, { date: '2026-01-11', time: '09:00' });
  await svc.createService(admin, { date: '2026-01-04' });
  await svc.createService(admin, { date: '2026-01-05' });
  await svc.createService(admin, { date: '2026-03-02' }); // today + 56 days
  await svc.createService(admin, { date: '2026-03-03' });
  const list = await svc.listServices();
  assert.deepEqual(list.map((s) => `${s.date} ${s.time}`), ['2026-01-05 09:00', '2026-01-11 09:00', '2026-01-11 11:00', '2026-03-02 09:00']);
  assert.deepEqual(list[2].slots.map((s) => s.positionName), ['Piano', 'Drums', 'Sound']);
  assert.deepEqual(list[0].slots, []);
  assert.equal((await svc.listServices('2026-01-04', '2026-01-04')).length, 1);
  assert.equal((await svc.listServices('2026-03-03')).length, 1);
  assert.equal((await svc.listServices('2026-01-01', '2027-01-02')).length, 6); // exactly 366 days
  await rejectsWith(svc.listServices('2026-01-01', '2027-01-03'), ValidationError, 'The date range can be at most 366 days');
  await rejectsWith(svc.listServices('2026-02-30'), ValidationError, 'Date must be a real date like 2026-03-01');
  await rejectsWith(svc.listServices('2026-01-01', 'soon'), ValidationError, 'Date must be a real date like 2026-03-01');
  await rejectsWith(svc.listServices('2026-02-01', '2026-01-31'), ValidationError, 'The end date must not be before the start date');
});

test('calendar: listServices "today" is the local date of the clock', async () => {
  const { data, admin } = await setup();
  const clock = fixedClock(new Date(2026, 11, 31, 23, 59));
  const svc = createCalendarService({ data, clock });
  await svc.createService(admin, { date: '2026-12-30' });
  await svc.createService(admin, { date: '2026-12-31' });
  assert.deepEqual((await svc.listServices()).map((s) => s.date), ['2026-12-31']);
  clock.advance(60_000);
  assert.deepEqual(await svc.listServices(), []);
});

test('calendar: updateService changes fields, keeps others, refuses clashes', async () => {
  const { svc, admin, data } = await setup();
  const a = await svc.createService(admin, { date: '2026-03-01' });
  await svc.createService(admin, { date: '2026-03-08' });
  const u = await svc.updateService(admin, a.id, { title: 'Easter', time: '10:30' });
  assert.deepEqual([u.date, u.time, u.title], ['2026-03-01', '10:30', 'Easter']);
  const [entry] = await data.audit.list(1);
  assert.equal(entry.action, 'service.update');
  assert.equal(entry.detail, `service ${a.id} 2026-03-01 10:30 "Easter"`);
  await rejectsWith(svc.updateService(admin, a.id, { date: '2026-03-08', time: '09:00' }), ConflictError, 'A service already exists at that date and time');
  assert.equal((await svc.updateService(admin, a.id, { date: '2026-03-08' })).date, '2026-03-08');
  assert.equal((await svc.updateService(admin, a.id, { time: '10:30' })).time, '10:30'); // its own slot is no clash
  await rejectsWith(svc.updateService(admin, a.id, { date: '2026-02-30' }), ValidationError, 'Date must be a real date like 2026-03-01');
  await rejectsWith(svc.updateService(admin, a.id, { time: 'noon' }), ValidationError, 'Time must look like 09:00');
  await rejectsWith(svc.updateService(admin, a.id, { title: '   ' }), ValidationError, 'Title must be 1 to 100 characters');
  await rejectsWith(svc.updateService(admin, 999, { title: 'x' }), NotFoundError, 'Service not found');
  await rejectsWith(svc.updateService(admin, null, { title: 'x' }), NotFoundError);
});

test('calendar: deleteService needs confirm when people are scheduled (has_people)', async () => {
  const { svc, admin, pat, pos, data, count } = await setup();
  const a = await svc.createService(admin, { date: '2026-03-01', slots: [{ positionId: pos.drums, count: 2 }] });
  assert.deepEqual(await svc.deleteService(admin, a.id), { ok: true });
  assert.equal(count('slots'), 0);
  const b = await svc.createService(admin, { date: '2026-03-08', slots: [{ positionId: pos.drums, count: 3 }] });
  for (const s of b.slots.slice(0, 2)) await data.slots.assign(s.id, { personId: pat.id, assignedAt: NOW });
  await assert.rejects(svc.deleteService(admin, b.id), (e) => {
    assert.ok(e instanceof ConflictError);
    assert.equal(e.code, 'has_people');
    assert.equal(e.exposeCode, true);
    assert.equal(e.message, '2 people are scheduled on this date');
    assert.deepEqual(e.details, { count: 2 });
    return true;
  });
  assert.equal(count('services'), 1);
  assert.deepEqual(await svc.deleteService(admin, b.id, { confirm: true }), { ok: true });
  assert.equal(count('services'), 0);
  assert.equal(count('slots'), 0);
  const [entry] = await data.audit.list(1);
  assert.equal(entry.action, 'service.delete');
  assert.equal(entry.detail, `service ${b.id} 2026-03-08 09:00 "Sunday service" (2 people scheduled)`);
  await rejectsWith(svc.deleteService(admin, 999), NotFoundError, 'Service not found');
});

test('calendar: deleteService rolls back on failure', async () => {
  const { data, svc: plain, admin, pos, count } = await setup();
  const a = await plain.createService(admin, { date: '2026-03-01', slots: [{ positionId: pos.drums }] });
  const svc = createCalendarService({ data: failingAudit(data), clock: fixedClock(new Date(NOW)) });
  await assert.rejects(svc.deleteService(admin, a.id), /audit is down/);
  assert.equal(count('services'), 1);
  assert.equal(count('slots'), 1);
});

test('calendar: addSlots adds 1-20 open slots and audits', async () => {
  const { svc, admin, pos, data } = await setup();
  const a = await svc.createService(admin, { date: '2026-03-01' });
  const three = await svc.addSlots(admin, a.id, { positionId: pos.piano, count: 3 });
  assert.equal(three.length, 3);
  assert.ok(three.every((s) => s.positionName === 'Piano' && s.status === 'open'));
  assert.equal((await svc.addSlots(admin, a.id, { positionId: pos.sound })).length, 1);
  assert.equal((await svc.addSlots(admin, a.id, { positionId: pos.sound, count: 20 })).length, 20);
  const [entry] = await data.audit.list(1);
  assert.equal(entry.action, 'slot.create');
  assert.equal(entry.detail, `service ${a.id} position ${pos.sound} x20`);
  await rejectsWith(svc.addSlots(admin, a.id, { positionId: 999 }), ValidationError, 'That position does not exist');
  await rejectsWith(svc.addSlots(admin, a.id, { positionId: pos.drums, count: 21 }), ValidationError, 'Count must be a whole number from 1 to 20');
  await rejectsWith(svc.addSlots(admin, a.id, { positionId: pos.drums, count: 0 }), ValidationError, 'Count must be a whole number from 1 to 20');
  await rejectsWith(svc.addSlots(admin, 999, { positionId: pos.drums }), NotFoundError, 'Service not found');
  assert.equal((await svc.getService(a.id)).slots.length, 24);
});

test('calendar: addSlots rolls back on failure', async () => {
  const { data, svc: plain, admin, pos, count } = await setup();
  const a = await plain.createService(admin, { date: '2026-03-01' });
  const svc = createCalendarService({ data: failingAudit(data), clock: fixedClock(new Date(NOW)) });
  await assert.rejects(svc.addSlots(admin, a.id, { positionId: pos.drums, count: 5 }), /audit is down/);
  assert.equal(count('slots'), 0);
});

test('calendar: removeSlot needs confirm when someone is in it (has_person)', async () => {
  const { svc, admin, pat, pos, data, count } = await setup();
  const a = await svc.createService(admin, { date: '2026-03-01', slots: [{ positionId: pos.drums, count: 2 }] });
  const [taken, open] = a.slots;
  await data.slots.assign(taken.id, { personId: pat.id, status: 'accepted', assignedAt: NOW });
  await rejectsWith(svc.removeSlot(admin, taken.id), ConflictError, 'Someone is scheduled in this slot', 'has_person');
  assert.equal(count('slots'), 2);
  assert.deepEqual(await svc.removeSlot(admin, taken.id, { confirm: true }), { ok: true });
  let [entry] = await data.audit.list(1);
  assert.equal(entry.action, 'slot.delete');
  assert.equal(entry.detail, `slot ${taken.id} service ${a.id} position ${pos.drums} person ${pat.id}`);
  assert.deepEqual(await svc.removeSlot(admin, open.id), { ok: true });
  [entry] = await data.audit.list(1);
  assert.equal(entry.detail, `slot ${open.id} service ${a.id} position ${pos.drums} person none`);
  await rejectsWith(svc.removeSlot(admin, open.id), NotFoundError, 'Slot not found');
  await rejectsWith(svc.removeSlot(admin, null), NotFoundError, 'Slot not found');
});

test('calendar: removeSlot rolls back on failure', async () => {
  const { data, svc: plain, admin, pos, count } = await setup();
  const a = await plain.createService(admin, { date: '2026-03-01', slots: [{ positionId: pos.drums }] });
  const svc = createCalendarService({ data: failingAudit(data), clock: fixedClock(new Date(NOW)) });
  await assert.rejects(svc.removeSlot(admin, a.slots[0].id), /audit is down/);
  assert.equal(count('slots'), 1);
});
