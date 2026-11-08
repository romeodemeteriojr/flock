// Unit tests for the auto-fill planner (pure) and service. Made-up people only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planAutofill, weeksApart, hash32 } from '../src/services/autofill-service.js';
import { mondayOf } from '../src/dates.js';
import { makeContainer } from './helpers/container.js';
import { ValidationError } from '../src/errors.js';

const TODAY = '2025-01-05'; // a Sunday; the clock in makeContainer()
const W1 = '2025-01-06'; // Monday of next week
const DRUMS = 10;
const KEYS = 11;
const NAMES = { [DRUMS]: 'Drums', [KEYS]: 'Keys' };

// A slot as data.slots.listForServices / assignedBetween return it.
let nextId = 1;
const slot = (date, positionId = DRUMS, extra = {}) => ({
  id: extra.id ?? nextId++, serviceId: extra.serviceId ?? Number(date.replaceAll('-', '')) * 100 + (extra.serviceTime === '18:00' ? 1 : 0),
  positionId, personId: null, status: 'open', assignedAt: null, respondedAt: null,
  serviceDate: date, serviceTime: '09:00', serviceTitle: 'Sunday service',
  positionName: NAMES[positionId], positionSort: positionId === DRUMS ? 1 : 2,
  teamId: 1, teamName: 'Band', teamSort: 1, personName: null, ...extra,
});
const held = (date, personId, status = 'accepted', positionId = DRUMS, extra = {}) => slot(date, positionId, { personId, status, ...extra });
const person = (id, name, positionIds = [DRUMS], active = true) => ({ id, name, active, positionIds });

function plan({ slots, history = [], people, availability = new Map(), blockouts = [], start = W1, weeks = 1, today = TODAY }) {
  // history must hold every slot with a person, as assignedBetween would (open slots never appear there).
  return planAutofill({ today, start, weeks, slots, history, people, availability, blockouts });
}
const who = (r) => r.assigned.map((a) => [a.date, a.positionName, a.personName]);

// ---------- date helpers ----------

test('mondayOf: the Monday on or before the date', () => {
  assert.equal(mondayOf('2025-01-05'), '2024-12-30'); // Sunday
  assert.equal(mondayOf('2025-01-06'), '2025-01-06'); // Monday
  assert.equal(mondayOf('2025-01-11'), '2025-01-06'); // Saturday
  assert.equal(mondayOf('2024-02-29'), '2024-02-26'); // leap day, Thursday
  assert.equal(mondayOf('2024-03-03'), '2024-02-26'); // Sunday after the leap day
  assert.throws(() => mondayOf('2025-02-30'));
});

test('weeksApart: whole Monday-to-Sunday weeks between two dates', () => {
  assert.equal(weeksApart('2025-01-06', '2025-01-12'), 0);
  assert.equal(weeksApart('2025-01-12', '2025-01-13'), 1);
  assert.equal(weeksApart('2025-01-13', '2025-01-12'), 1);
  assert.equal(weeksApart('2024-12-29', '2025-01-05'), 1);
  assert.equal(weeksApart('2025-01-12', '2025-03-02'), 7);
});

test('hash32 is FNV-1a', () => {
  assert.equal(hash32(''), 0x811c9dc5);
  assert.equal(hash32('a'), 0xe40c292c);
  assert.equal(hash32('2025-01-06|1'), hash32('2025-01-06|1'));
  assert.notEqual(hash32('2025-01-06|1'), hash32('2025-01-06|2'));
});

// ---------- who may be picked ----------

test('plan: only active, qualified, unpaused, not away, not on that service, not said no to it, not too soon', () => {
  const s = slot('2025-01-12');
  const other = slot('2025-01-12', KEYS, { serviceId: s.serviceId });
  const declined = slot('2025-01-12', KEYS, { serviceId: s.serviceId });
  const people = [
    person(1, 'Ina Inactive', [DRUMS], false),
    person(2, 'Una Unqualified', [KEYS]),
    person(3, 'Pia Paused'),
    person(4, 'Abe Away'),
    person(5, 'Ona OnService'),
    person(6, 'Dee Declined'),
    person(7, 'Rex Recent'),
  ];
  const history = [
    held('2025-01-12', 5, 'pending', KEYS, { id: other.id, serviceId: s.serviceId }),
    held('2025-01-12', 6, 'declined', KEYS, { id: declined.id, serviceId: s.serviceId }),
    held('2025-01-05', 7, 'accepted'), // last week, and Rex chose every 2 weeks
  ];
  const r = plan({
    slots: [s, { ...other, personId: 5, status: 'pending' }, { ...declined, personId: 6, status: 'declined' }],
    history,
    people,
    availability: new Map([[3, 0], [7, 2]]),
    blockouts: [{ personId: 4, startDate: '2025-01-10', endDate: '2025-01-12' }],
  });
  assert.deepEqual(r.assigned, []);
  assert.deepEqual(r.unfilled.map((u) => [u.slotId, u.reason]), [[s.id, 'nobody_free']]);

  // Rex is free again two weeks later.
  const later = slot('2025-01-19');
  const r2 = plan({ slots: [later], history, people: [people[6]], availability: new Map([[7, 2]]), start: '2025-01-13' });
  assert.deepEqual(who(r2), [['2025-01-19', 'Drums', 'Rex Recent']]);
});

test('plan: nobody set up for the position gives nobody_qualified, with a message', () => {
  const s = slot('2025-01-12', KEYS);
  const r = plan({ slots: [s], people: [person(1, 'Pat Drums')] });
  assert.deepEqual(r.unfilled, [{
    slotId: s.id, serviceId: s.serviceId, date: '2025-01-12', time: '09:00', serviceTitle: 'Sunday service',
    teamName: 'Band', positionName: 'Keys', reason: 'nobody_qualified', message: 'Nobody is set up for Keys',
  }]);
});

test('plan: anyone who never chose counts as every 2 weeks', () => {
  const r = plan({ slots: [slot('2025-01-12')], history: [held('2025-01-05', 1)], people: [person(1, 'Pat Default')] });
  assert.deepEqual(r.assigned, []);
  assert.equal(r.unfilled[0].reason, 'nobody_free');
});

test('plan: an existing assignment LATER than the week also keeps the spacing', () => {
  const r = plan({
    slots: [slot('2025-01-12')],
    history: [held('2025-01-19', 1, 'pending')],
    people: [person(1, 'Pat Later')],
    availability: new Map([[1, 2]]),
  });
  assert.deepEqual(r.assigned, []);
});

test('plan: at most one slot per person per week, even across two services that week', () => {
  const sat = slot('2025-01-11', DRUMS, { serviceTime: '18:00' });
  const sun = slot('2025-01-12');
  const r = plan({ slots: [sun, sat], people: [person(1, 'Pat Only')], availability: new Map([[1, 1]]) });
  assert.deepEqual(who(r), [['2025-01-11', 'Drums', 'Pat Only']]);
  assert.deepEqual(r.unfilled.map((u) => [u.slotId, u.reason]), [[sun.id, 'nobody_free']]);
});

test('plan: past, filled, pending, accepted and declined slots are left alone', () => {
  const past = slot('2025-01-04'); // the Saturday before today
  const pending = slot('2025-01-12', DRUMS, { personId: 9, status: 'pending' });
  const r = plan({ slots: [past, pending], people: [person(1, 'Pat')], start: '2024-12-30', weeks: 2 });
  assert.deepEqual(r, { assigned: [], unfilled: [] });
});

// ---------- fairness ----------

test('plan: fewer services relative to how often they offered wins (load = count x every weeks)', () => {
  // Pat (every week) served twice in the last 8 weeks: load 2. Quinn (every 4 weeks) once: load 4.
  const history = [held('2024-12-15', 1), held('2024-12-22', 1), held('2024-11-24', 2)];
  const people = [person(1, 'Pat Weekly'), person(2, 'Quinn Monthly')];
  const r = plan({ slots: [slot('2025-01-12')], history, people, availability: new Map([[1, 1], [2, 4]]) });
  assert.deepEqual(who(r), [['2025-01-12', 'Drums', 'Pat Weekly']]);
});

test('plan: services before the 8-week look-back do not count', () => {
  // Quinn served twice, 9 and 10 weeks before the week: load 0. Pat once inside the window: load 1.
  const history = [held('2024-10-27', 2), held('2024-11-03', 2), held('2024-12-22', 1)];
  const people = [person(1, 'Pat'), person(2, 'Quinn')];
  const r = plan({ slots: [slot('2025-01-12')], history, people, availability: new Map([[1, 1], [2, 1]]) });
  assert.deepEqual(who(r), [['2025-01-12', 'Drums', 'Quinn']]);
});

test('plan: equal load goes to whoever served longest ago, never-served first', () => {
  const people = [person(1, 'Ann'), person(2, 'Bo'), person(3, 'Cy')];
  const availability = new Map([[1, 1], [2, 1], [3, 1]]);
  // Each served once in the window, Bo longest ago.
  const history = [held('2024-12-29', 1), held('2024-11-17', 2), held('2024-12-22', 3)];
  assert.deepEqual(who(plan({ slots: [slot('2025-01-12')], history, people, availability })), [['2025-01-12', 'Drums', 'Bo']]);
  // A newcomer (never served, load 0) beats everyone.
  const r = plan({ slots: [slot('2025-01-12')], history, people: [...people, person(4, 'Dee New')], availability });
  assert.deepEqual(who(r), [['2025-01-12', 'Drums', 'Dee New']]);
});

test('plan: a full tie is broken by hash32(week|id), not by name, and is repeatable', () => {
  // Ids chosen so the hash winner (8) is neither the lowest id nor the first name.
  const people = [person(2, 'Ann'), person(3, 'Bo'), person(8, 'Cy')];
  const s = slot('2025-01-12');
  const expected = [...people].sort((a, b) => hash32(`${W1}|${a.id}`) - hash32(`${W1}|${b.id}`))[0].name;
  assert.equal(expected, 'Cy');
  const a = plan({ slots: [s], people });
  const b = plan({ slots: [s], people: [...people].reverse() });
  assert.equal(a.assigned[0].personName, 'Cy');
  assert.deepEqual(a, b);
});

test('plan: weekly rotation over 6 weeks gives three weekly volunteers two turns each, in a repeating order', () => {
  const people = [person(1, 'Ann'), person(2, 'Bo'), person(3, 'Cy')];
  const availability = new Map([[1, 1], [2, 1], [3, 1]]);
  const sundays = ['2025-01-12', '2025-01-19', '2025-01-26', '2025-02-02', '2025-02-09', '2025-02-16'];
  const r = plan({ slots: sundays.map((d) => slot(d)), people, availability, weeks: 6 });
  const ids = r.assigned.map((a) => a.personId);
  assert.equal(ids.length, 6);
  for (const id of [1, 2, 3]) assert.equal(ids.filter((x) => x === id).length, 2);
  assert.deepEqual(ids.slice(3), ids.slice(0, 3));
});

test('plan: every 4 weeks is never asked more than once in 4 weeks', () => {
  const people = [person(1, 'Pat Weekly'), person(2, 'Quinn Monthly')];
  const sundays = ['2025-01-12', '2025-01-19', '2025-01-26', '2025-02-02'];
  const r = plan({ slots: sundays.map((d) => slot(d)), people, availability: new Map([[1, 1], [2, 4]]), weeks: 4 });
  const ids = r.assigned.map((a) => a.personId);
  assert.equal(ids.length, 4);
  assert.equal(ids.filter((x) => x === 2).length, 1);
  assert.equal(ids.filter((x) => x === 1).length, 3);
});

test('plan: the most constrained slot is filled first', () => {
  // Keys: only Pat. Drums: Pat or Quinn, and Pat would win Drums on fairness (Quinn has load 1).
  const svc = 202501120;
  const drums = slot('2025-01-12', DRUMS, { serviceId: svc });
  const keys = slot('2025-01-12', KEYS, { serviceId: svc });
  const people = [person(1, 'Pat Both', [DRUMS, KEYS]), person(2, 'Quinn Drums', [DRUMS])];
  const r = plan({ slots: [drums, keys], history: [held('2024-12-15', 2)], people, availability: new Map([[1, 1], [2, 1]]) });
  assert.deepEqual(who(r), [['2025-01-12', 'Drums', 'Quinn Drums'], ['2025-01-12', 'Keys', 'Pat Both']]);
});

test('plan: the assigned item shape', () => {
  const s = slot('2025-01-12');
  const r = plan({ slots: [s], people: [person(1, 'Pat')], availability: new Map([[1, 3]]) });
  assert.deepEqual(r, {
    assigned: [{
      slotId: s.id, serviceId: s.serviceId, date: '2025-01-12', time: '09:00', serviceTitle: 'Sunday service',
      teamName: 'Band', positionName: 'Drums', personId: 1, personName: 'Pat', everyWeeks: 3,
    }],
    unfilled: [],
  });
});

// ---------- the service ----------

async function setup() {
  const c = makeContainer();
  const { data, services } = c;
  const at = '2025-01-01T00:00:00.000Z';
  const admin = await data.people.create({ name: 'Ada Admin', email: 'ada@example.com', role: 'admin', passwordHash: 'x', createdAt: at });
  const band = await data.teams.create({ name: 'Band' });
  const drums = await data.positions.create(band.id, { name: 'Drums' });
  const add = async (name, username, everyWeeks) => {
    const p = await data.people.create({ name, username, passwordHash: 'x', createdAt: at });
    await data.qualifications.setForPerson(p.id, [drums.id]);
    if (everyWeeks !== undefined) await data.availability.set(p.id, { everyWeeks, updatedAt: at });
    return p;
  };
  const sunday = async (date) => {
    const s = await data.services.create({ date, title: 'Sunday service' });
    return (await data.slots.createMany(s.id, [drums.id]))[0];
  };
  const run = (input) => services.autofill.run({ id: admin.id }, input);
  return { c, data, admin, drums, add, sunday, run };
}

test('service: a preview writes nothing; apply makes pending assignments and one audit entry', async () => {
  const { data, add, sunday, run, admin } = await setup();
  const pat = await add('Pat Person', 'pat', 1);
  const s1 = await sunday('2025-01-12');
  const s2 = await sunday('2025-01-19');
  const auditBefore = (await data.audit.list()).length;

  const preview = await run({ weekOf: '2025-01-08', weeks: 2 });
  assert.equal(preview.applied, false);
  assert.equal(preview.weekOf, W1);
  assert.equal(preview.weeks, 2);
  assert.deepEqual(preview.assigned.map((a) => [a.slotId, a.personId]), [[s1.id, pat.id], [s2.id, pat.id]]);
  assert.equal((await data.slots.findById(s1.id)).status, 'open');
  assert.equal((await data.audit.list()).length, auditBefore);

  const done = await run({ weekOf: '2025-01-08', weeks: 2, apply: true });
  assert.equal(done.applied, true);
  assert.deepEqual(done.assigned, preview.assigned);
  for (const id of [s1.id, s2.id]) {
    const s = await data.slots.findById(id);
    assert.equal(s.personId, pat.id);
    assert.equal(s.status, 'pending');
  }
  const audit = await data.audit.list();
  assert.equal(audit.length, auditBefore + 3); // two slot.assign and one schedule.autofill
  assert.equal(audit[0].action, 'schedule.autofill');
  assert.equal(audit[0].actorId, admin.id);
  assert.equal(audit[0].detail, '2025-01-06 for 2 week(s): 2 assigned, 0 left open');

  // Running again finds nothing open, changes nothing and logs nothing.
  const again = await run({ weekOf: '2025-01-08', weeks: 2, apply: true });
  assert.deepEqual([again.assigned, again.unfilled], [[], []]);
  assert.equal((await data.audit.list()).length, auditBefore + 3);
});

test('service: weekOf defaults to next week, weeks to 1', async () => {
  const { add, sunday, run } = await setup();
  await add('Pat Person', 'pat', 1);
  const next = await sunday('2025-01-12');
  await sunday('2025-01-19');
  const r = await run({});
  assert.equal(r.weekOf, W1);
  assert.equal(r.weeks, 1);
  assert.deepEqual(r.assigned.map((a) => a.slotId), [next.id]);
});

test('service: bad input is a ValidationError', async () => {
  const { run } = await setup();
  const bad = [
    [{ weekOf: '2025-02-30' }, /real date/],
    [{ weekOf: 20250106 }, /real date/],
    [{ weeks: 0 }, /from 1 to 8/],
    [{ weeks: 9 }, /from 1 to 8/],
    [{ weeks: 1.5 }, /from 1 to 8/],
    [{ apply: 'yes' }, /true or false/],
    [{ weekOf: '2024-12-29' }, /already over/], // the week of 2024-12-23 ended before today
  ];
  for (const [input, re] of bad) {
    await assert.rejects(run(input), (e) => e instanceof ValidationError && re.test(e.message), JSON.stringify(input));
  }
  // The current week is still allowed (today is its Sunday).
  assert.equal((await run({ weekOf: TODAY })).weekOf, '2024-12-30');
});

test('service: a slot changed by hand between preview and apply is respected', async () => {
  const { data, add, sunday, run } = await setup();
  const pat = await add('Pat Person', 'pat', 1);
  const quinn = await add('Quinn Quill', 'quinn', 1);
  const s1 = await sunday('2025-01-12');
  const preview = await run({ weekOf: W1 });
  assert.equal(preview.assigned.length, 1);
  const other = preview.assigned[0].personId === pat.id ? quinn : pat;
  await data.slots.assign(s1.id, { personId: other.id, status: 'accepted', assignedAt: '2025-01-05T12:00:00.000Z' });
  const done = await run({ weekOf: W1, apply: true });
  assert.deepEqual(done.assigned, []);
  assert.equal((await data.slots.findById(s1.id)).personId, other.id);
});
