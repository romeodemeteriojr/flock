// Unit tests for the gaps service: fixed clock, in-memory data layer, made-up people.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeData } from './helpers/data.js';
import { fixedClock } from '../src/infra/clock.js';
import { createGapsService, shortDate } from '../src/services/gaps-service.js';
import { NotFoundError, ValidationError } from '../src/errors.js';

const NOW = '2025-01-05T12:00:00'; // a Sunday
const TODAY = '2025-01-05';
// assignedAt for a local calendar day (the service compares local dates).
const at = (day) => new Date(`${day}T12:00:00`).toISOString();

async function setup({ config = { unansweredDays: 3 } } = {}) {
  const { data } = makeData();
  const clock = fixedClock(new Date(NOW));
  const svc = createGapsService({ data, clock, config });
  const person = async (name, username, { positions = [] } = {}) => {
    const p = await data.people.create({ name, username, passwordHash: 'x', createdAt: NOW });
    if (positions.length) await data.qualifications.setForPerson(p.id, positions);
    return p;
  };
  const deactivate = (p) => data.people.update(p.id, { active: false });
  const band = await data.teams.create({ name: 'Band', sort: 1 });
  const tech = await data.teams.create({ name: 'Tech', sort: 2 });
  const drums = await data.positions.create(band.id, { name: 'Drums' });
  const sound = await data.positions.create(tech.id, { name: 'Sound' });
  async function service(date, positions = [drums.id], time = '09:00', title = 'Sunday service') {
    const s = await data.services.create({ date, time, title });
    const slots = await data.slots.createMany(s.id, positions);
    return { service: s, slots: slots.map((x) => x.id) };
  }
  async function put(slotId, personId, { status = 'pending', assignedOn = TODAY } = {}) {
    await data.slots.assign(slotId, { personId, status: 'pending', assignedAt: at(assignedOn) });
    if (status !== 'pending') await data.slots.respond(slotId, { status, respondedAt: at(assignedOn) });
  }
  const block = (personId, startDate, endDate = startDate) => data.blockouts.create({ personId, startDate, endDate, createdAt: NOW });
  return { data, clock, svc, person, deactivate, band, tech, drums, sound, service, put, block };
}

const rejectsWith = (p, Type, re) => assert.rejects(p, (e) => {
  assert.ok(e instanceof Type, `expected ${Type.name}, got ${e?.name}: ${e?.message}`);
  if (re) assert.match(e.message, re);
  return true;
});

// ---------------- gaps ----------------

test('gaps: every type once, summary counts and the item shape', async () => {
  const { svc, person, deactivate, drums, sound, service, put, block } = await setup();
  const q = { positions: [drums.id, sound.id] };
  const pat = await person('Pat Person', 'pat', q);
  const quinn = await person('Quinn Quill', 'quinn', q);
  const rae = await person('Rae Ray', 'rae', q);
  const sid = await person('Sid Sun', 'sid', q);
  const ola = await person('Ola Okay', 'ola', q);
  const { service: s, slots: [open, declined, unanswered, blocked, inactive, fine] } = await service('2025-01-26',
    [drums.id, drums.id, drums.id, drums.id, sound.id, sound.id]);
  await put(declined, pat.id, { status: 'declined' });
  await put(unanswered, quinn.id, { assignedOn: '2025-01-01' });
  await put(blocked, rae.id, { status: 'accepted' });
  await block(rae.id, '2025-01-20', '2025-01-30');
  await put(inactive, sid.id, { status: 'accepted' });
  await deactivate(sid);
  await put(fine, ola.id, { status: 'accepted' });

  const r = await svc.gaps();
  assert.deepEqual(r.summary, { open: 1, declined: 1, unanswered: 1, blocked: 1, inactive: 1 });
  assert.deepEqual(r.items.map((i) => [i.type, i.slotId]), [
    ['open', open], ['declined', declined], ['unanswered', unanswered], ['blocked', blocked], ['inactive', inactive],
  ]);
  assert.deepEqual(r.items[0], {
    type: 'open', slotId: open, serviceId: s.id, date: '2025-01-26', time: '09:00',
    serviceTitle: 'Sunday service', positionName: 'Drums', teamName: 'Band',
  });
  assert.deepEqual(r.items[1], {
    type: 'declined', slotId: declined, serviceId: s.id, date: '2025-01-26', time: '09:00',
    serviceTitle: 'Sunday service', positionName: 'Drums', teamName: 'Band', personId: pat.id, personName: 'Pat Person',
  });
  assert.equal(r.items[4].teamName, 'Tech');
  assert.equal(r.items[4].personName, 'Sid Sun');
  assert.ok(!r.items.some((i) => i.slotId === fine));
});

test('gaps: unanswered boundary on days since assigned (more than unansweredDays)', async () => {
  const { svc, person, drums, service, put } = await setup();
  const pat = await person('Pat Person', 'pat', { positions: [drums.id] });
  const quinn = await person('Quinn Quill', 'quinn', { positions: [drums.id] });
  const rae = await person('Rae Ray', 'rae', { positions: [drums.id] });
  const { slots: [three, four, accepted] } = await service('2025-01-26', [drums.id, drums.id, drums.id]);
  await put(three, pat.id, { assignedOn: '2025-01-02' }); // 3 days ago: not yet
  await put(four, quinn.id, { assignedOn: '2025-01-01' }); // 4 days ago: unanswered
  await put(accepted, rae.id, { status: 'accepted', assignedOn: '2024-12-01' }); // answered long ago
  const r = await svc.gaps();
  assert.deepEqual(r.items.map((i) => [i.type, i.slotId]), [['unanswered', four]]);
});

test('gaps: unanswered boundary on a service within 7 days', async () => {
  const { svc, person, drums, service, put } = await setup();
  const pat = await person('Pat Person', 'pat', { positions: [drums.id] });
  const quinn = await person('Quinn Quill', 'quinn', { positions: [drums.id] });
  const { slots: [seven] } = await service('2025-01-12');
  const { slots: [eight] } = await service('2025-01-13');
  await put(seven, pat.id); // assigned today, but the service is 7 days away
  await put(eight, quinn.id); // 8 days away and assigned today
  const r = await svc.gaps();
  assert.deepEqual(r.items.map((i) => [i.type, i.slotId]), [['unanswered', seven]]);
});

test('gaps: unansweredDays comes from config (0 means anything older than today; default 3)', async () => {
  const zero = await setup({ config: { unansweredDays: 0 } });
  const p = await zero.person('Pat Person', 'pat', { positions: [zero.drums.id] });
  const { slots: [a, b] } = await zero.service('2025-01-26', [zero.drums.id, zero.drums.id]);
  const q = await zero.person('Quinn Quill', 'quinn', { positions: [zero.drums.id] });
  await zero.put(a, p.id, { assignedOn: TODAY });
  await zero.put(b, q.id, { assignedOn: '2025-01-04' });
  assert.deepEqual((await zero.svc.gaps()).items.map((i) => i.slotId), [b]);

  const dflt = await setup({ config: {} });
  const r = await dflt.person('Rae Ray', 'rae', { positions: [dflt.drums.id] });
  const s = await dflt.person('Sid Sun', 'sid', { positions: [dflt.drums.id] });
  const { slots: [c, d] } = await dflt.service('2025-01-26', [dflt.drums.id, dflt.drums.id]);
  await dflt.put(c, r.id, { assignedOn: '2025-01-02' });
  await dflt.put(d, s.id, { assignedOn: '2025-01-01' });
  assert.deepEqual((await dflt.svc.gaps()).items.map((i) => i.slotId), [d]);
});

test('gaps: blocked only for pending/accepted people whose blockout covers the date; inactive wins over blocked', async () => {
  const { svc, person, deactivate, drums, service, put, block } = await setup();
  const pat = await person('Pat Person', 'pat', { positions: [drums.id] });
  const quinn = await person('Quinn Quill', 'quinn', { positions: [drums.id] });
  const rae = await person('Rae Ray', 'rae', { positions: [drums.id] });
  const { slots: [a, b, c] } = await service('2025-01-26', [drums.id, drums.id, drums.id]);
  await put(a, pat.id, { status: 'accepted' });
  await block(pat.id, '2025-01-26'); // a one-day blockout on the date
  await put(b, quinn.id, { status: 'accepted' });
  await block(quinn.id, '2025-01-27', '2025-02-03'); // starts the day after: not blocked
  await put(c, rae.id, { status: 'accepted' });
  await block(rae.id, '2025-01-26');
  await deactivate(rae);
  const r = await svc.gaps();
  assert.deepEqual(r.items.map((i) => [i.type, i.slotId]), [['blocked', a], ['inactive', c]]);
});

test('gaps: sorted per service (date, then time), then team; default range is today to 28 days ahead', async () => {
  const { svc, drums, sound, service } = await setup();
  const { slots: [t1, b1] } = await service('2025-01-12', [sound.id, drums.id]);
  const { slots: [b0] } = await service('2025-01-05', [drums.id]);
  await service('2025-01-04', [drums.id]); // yesterday: outside
  const { slots: [last] } = await service('2025-02-02', [drums.id]); // today + 28: inside
  await service('2025-02-03', [drums.id]); // today + 29: outside
  const { slots: [evening] } = await service('2025-01-12', [drums.id], '18:00', 'Evening');
  const r = await svc.gaps();
  assert.deepEqual(r.items.map((i) => i.slotId), [b0, b1, t1, evening, last]);
});

test('gaps: from/to validation and range limits', async () => {
  const { svc, drums, service } = await setup();
  const { slots: [old] } = await service('2024-12-01', [drums.id]);
  assert.deepEqual((await svc.gaps({ from: '2024-12-01', to: '2024-12-01' })).items.map((i) => i.slotId), [old]);
  assert.deepEqual((await svc.gaps({ from: '2024-11-03' })).items.map((i) => i.slotId), [old]); // to = from + 28
  assert.deepEqual((await svc.gaps({ from: '2024-11-02' })).items, []);
  await rejectsWith(svc.gaps({ from: '2025-02-30' }), ValidationError, /From must be a real date/);
  await rejectsWith(svc.gaps({ to: 'soon' }), ValidationError, /To must be a real date/);
  await rejectsWith(svc.gaps({ from: '2025-01-10', to: '2025-01-09' }), ValidationError, /before the start date/);
  await svc.gaps({ from: '2025-01-01', to: '2026-01-02' }); // 366 days: fine
  await rejectsWith(svc.gaps({ from: '2025-01-01', to: '2026-01-03' }), ValidationError, /at most 366 days/);
});

// ---------------- suggest ----------------

test('suggest: ranking by load, then longest since last served (never first), then name; reasons text', async () => {
  const { svc, person, drums, service, put } = await setup();
  const q = { positions: [drums.id] };
  const busy = await person('Bea Busy', 'bea', q);
  const recent = await person('Cal Recent', 'cal', q);
  const long = await person('Dee Long', 'dee', q);
  const never = await person('Zed Never', 'zed', q);
  const neverToo = await person('amy Never', 'amy', q);
  // Bea: twice in the last 8 weeks
  for (const date of ['2024-12-15', '2024-12-22']) {
    const { slots: [x] } = await service(date);
    await put(x, busy.id, { status: 'accepted', assignedOn: '2024-12-01' });
  }
  // Cal: once, 3 weeks ago (21 days)
  const { slots: [c] } = await service('2024-12-15', [drums.id], '11:00');
  await put(c, recent.id, { status: 'accepted', assignedOn: '2024-12-01' });
  // Dee: once, 10 weeks ago (outside the 8-week window), once pending in 2 weeks (inside the load window)
  const { slots: [d1] } = await service('2024-10-27');
  await put(d1, long.id, { status: 'accepted', assignedOn: '2024-10-01' });
  const { slots: [d2] } = await service('2025-01-19');
  await put(d2, long.id, { assignedOn: TODAY });
  // declined slots do not count
  const { slots: [x] } = await service('2024-12-29');
  await put(x, never.id, { status: 'declined', assignedOn: '2024-12-01' });

  const { slots: [target] } = await service('2025-01-26');
  const { candidates } = await svc.suggest({ slotId: target });
  // load: amy 0, zed 0, cal 1, dee 1, bea 2
  assert.deepEqual(candidates.map((c) => c.name), ['amy Never', 'Zed Never', 'Dee Long', 'Cal Recent', 'Bea Busy']);
  const by = Object.fromEntries(candidates.map((c) => [c.name, c]));
  assert.deepEqual(by['Zed Never'], {
    personId: never.id, name: 'Zed Never', servedLast8Weeks: 0, lastServed: null, qualified: true,
    reasons: ['Has not served in 8 weeks', 'Has never served', 'Nothing scheduled in the next 4 weeks'],
  });
  assert.deepEqual(by['Cal Recent'].reasons, ['Served 1 time in the last 8 weeks', 'Last served 3 weeks ago', 'Nothing scheduled in the next 4 weeks']);
  assert.equal(by['Cal Recent'].lastServed, '2024-12-15');
  assert.deepEqual(by['Dee Long'].reasons, ['Has not served in 8 weeks', 'Last served 10 weeks ago', 'Scheduled 1 time in the next 4 weeks']);
  assert.equal(by['Dee Long'].servedLast8Weeks, 0);
  assert.deepEqual(by['Bea Busy'].reasons, ['Served 2 times in the last 8 weeks', 'Last served 2 weeks ago', 'Nothing scheduled in the next 4 weeks']);
  assert.equal(by['Bea Busy'].servedLast8Weeks, 2);
  assert.equal(by['Bea Busy'].lastServed, '2024-12-22');
});

test('suggest: window edges (8 weeks back, 4 weeks ahead) and recent days wording', async () => {
  const { svc, person, drums, service, put } = await setup();
  const q = { positions: [drums.id] };
  const edge = await person('Eve Edge', 'eve', q);
  const out = await person('Oli Out', 'oli', q);
  const ahead = await person('Abe Ahead', 'abe', q);
  const days = await person('Dan Days', 'dan', q);
  const { slots: [e] } = await service('2024-11-10'); // exactly 56 days ago: inside
  await put(e, edge.id, { status: 'accepted', assignedOn: '2024-11-01' });
  const { slots: [o] } = await service('2024-11-09'); // 57 days ago: outside
  await put(o, out.id, { status: 'accepted', assignedOn: '2024-11-01' });
  const { slots: [a] } = await service('2025-02-03'); // today + 29: outside the load window
  await put(a, ahead.id, { assignedOn: TODAY });
  const { slots: [dd] } = await service('2025-01-01'); // 4 days ago
  await put(dd, days.id, { status: 'accepted', assignedOn: '2024-12-20' });
  const { slots: [target] } = await service('2025-01-26');
  const { candidates } = await svc.suggest({ slotId: target });
  const by = Object.fromEntries(candidates.map((c) => [c.name, c]));
  assert.equal(by['Eve Edge'].servedLast8Weeks, 1);
  assert.equal(by['Oli Out'].servedLast8Weeks, 0);
  assert.equal(by['Abe Ahead'].reasons[2], 'Nothing scheduled in the next 4 weeks');
  assert.equal(by['Dan Days'].reasons[1], 'Last served 4 days ago');
  // Abe (never served, load 0) first; Oli (load 0, served long ago) next; then Eve and Dan with load 1, longest first.
  assert.deepEqual(candidates.map((c) => c.name), ['Abe Ahead', 'Oli Out', 'Eve Edge', 'Dan Days']);
});

test('suggest: excludes inactive, unqualified, blocked, already on the service and the person who declined', async () => {
  const { svc, person, deactivate, drums, sound, service, put, block } = await setup();
  const fine = await person('Fay Fine', 'fay', { positions: [drums.id] });
  const gone = await person('Gus Gone', 'gus', { positions: [drums.id] });
  await deactivate(gone);
  const unq = await person('Uma Unq', 'uma', { positions: [sound.id] });
  const blocked = await person('Bo Blocked', 'bo', { positions: [drums.id] });
  await block(blocked.id, '2025-01-20', '2025-01-30');
  const onIt = await person('Ona On', 'ona', { positions: [drums.id, sound.id] });
  const decl = await person('Dex Declined', 'dex', { positions: [drums.id] });
  const otherDecl = await person('Ora Other', 'ora', { positions: [drums.id, sound.id] });
  const { slots: [target, soundSlot, soundSlot2] } = await service('2025-01-26', [drums.id, sound.id, sound.id]);
  await put(soundSlot, onIt.id, { status: 'accepted' });
  await put(target, decl.id, { status: 'declined' });
  await put(soundSlot2, otherDecl.id, { status: 'declined' }); // declined another slot: still a candidate

  const { candidates } = await svc.suggest({ slotId: target });
  assert.deepEqual(candidates.map((c) => c.personId).sort(), [fine.id, otherDecl.id].sort());

  const all = await svc.suggest({ slotId: target, includeUnqualified: true });
  const u = all.candidates.find((c) => c.personId === unq.id);
  assert.equal(u.qualified, false);
  assert.equal(u.reasons[0], 'Not set up for Drums');
  assert.ok(all.candidates.filter((c) => c.personId !== unq.id).every((c) => c.qualified === true));
  for (const p of [gone, blocked, onIt, decl]) assert.ok(!all.candidates.some((c) => c.personId === p.id), p.name);
});

test('suggest: validation and not found', async () => {
  const { svc } = await setup();
  await rejectsWith(svc.suggest({ slotId: 'x' }), ValidationError, /Slot id/);
  await rejectsWith(svc.suggest({}), ValidationError);
  await rejectsWith(svc.suggest({ slotId: 1, includeUnqualified: 'yes' }), ValidationError);
  await rejectsWith(svc.suggest({ slotId: 999 }), NotFoundError, /Slot not found/);
});

// ---------------- reminders ----------------

test('reminders: one message per person combining slots; skips declined, open, inactive and other weeks', async () => {
  const { svc, person, deactivate, drums, sound, service, put } = await setup();
  const sam = await person('Sam Ortiz', 'sam', { positions: [drums.id, sound.id] });
  const ann = await person('Ann Lee', 'ann', { positions: [drums.id, sound.id] });
  const dec = await person('Dee Declined', 'dee', { positions: [drums.id] });
  const old = await person('Ian Inactive', 'ian', { positions: [drums.id] });
  const { slots: [s1, open, d1, i1] } = await service('2025-01-12', [sound.id, drums.id, drums.id, drums.id]);
  const { slots: [s2] } = await service('2025-01-15', [drums.id], '19:00', 'Midweek');
  const { slots: [a1] } = await service('2025-01-18', [sound.id]); // weekOf + 6: inside
  const { slots: [later] } = await service('2025-01-19', [sound.id]); // weekOf + 7: outside
  const { slots: [before] } = await service('2025-01-11', [sound.id]); // the day before: outside
  void open;
  await put(s1, sam.id);
  await put(s2, sam.id, { status: 'accepted' });
  await put(a1, ann.id, { status: 'accepted' });
  await put(later, ann.id);
  await put(before, ann.id);
  await put(d1, dec.id, { status: 'declined' });
  await put(i1, old.id);
  await deactivate(old);

  const r = await svc.reminders({ weekOf: '2025-01-12' });
  assert.deepEqual(r.map((x) => x.name), ['Ann Lee', 'Sam Ortiz']);
  const [annR, samR] = r;
  assert.equal(samR.personId, sam.id);
  assert.equal(samR.message,
    'Hi Sam, a reminder that you are serving as Sound on Sun 12 Jan at 09:00 and Drums on Wed 15 Jan at 19:00. '
    + 'Please open Flock and accept or decline the ones you have not answered yet. Thank you!');
  assert.deepEqual(samR.items, [
    { slotId: s1, serviceId: samR.items[0].serviceId, date: '2025-01-12', time: '09:00', serviceTitle: 'Sunday service', positionName: 'Sound', teamName: 'Tech', status: 'pending' },
    { slotId: s2, serviceId: samR.items[1].serviceId, date: '2025-01-15', time: '19:00', serviceTitle: 'Midweek', positionName: 'Drums', teamName: 'Band', status: 'accepted' },
  ]);
  assert.equal(annR.message, 'Hi Ann, a reminder that you are serving as Sound on Sat 18 Jan at 09:00. We are glad you can make it. Thank you!');
  assert.deepEqual(annR.items.map((i) => i.slotId), [a1]);
});

test('reminders: all pending asks to accept or decline; default week starts today; validation', async () => {
  const { svc, person, drums, service, put } = await setup();
  const sam = await person('Sam', 'sam', { positions: [drums.id] });
  const { slots: [a] } = await service('2025-01-05');
  await put(a, sam.id);
  const r = await svc.reminders();
  assert.equal(r.length, 1);
  assert.equal(r[0].message, 'Hi Sam, a reminder that you are serving as Drums on Sun 5 Jan at 09:00. Please open Flock and accept or decline. Thank you!');
  assert.deepEqual(await svc.reminders({ weekOf: '2025-03-01' }), []);
  await rejectsWith(svc.reminders({ weekOf: '2025-13-01' }), ValidationError, /Week of must be a real date/);
});

test('reminders never send anything: no audit entries and no data changes', async () => {
  const { svc, data, person, drums, service, put } = await setup();
  const sam = await person('Sam Ortiz', 'sam', { positions: [drums.id] });
  const { slots: [a] } = await service('2025-01-12');
  await put(a, sam.id);
  const before = await data.slots.findById(a);
  await svc.reminders({ weekOf: '2025-01-12' });
  assert.deepEqual(await data.slots.findById(a), before);
  assert.deepEqual(await data.audit.list(), []);
});

test('shortDate formats like Sun 8 Nov', () => {
  assert.equal(shortDate('2026-11-08'), 'Sun 8 Nov');
  assert.equal(shortDate('2025-01-15'), 'Wed 15 Jan');
});
