// Time and calendar edge cases (C-83), all with the injected fixed clock:
// daylight-saving changeover Sundays, a service on today's date, past
// services, year boundaries and February 29. "Today" is the local calendar
// date of the server, so these tests set the process time zone (each test file
// runs in its own process) and move the clock across the interesting moments.
// Made-up people, in-memory databases only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeContainer } from './helpers/container.js';
import { addPerson, loginAs } from './helpers/seed.js';
import { startTestApp } from './helpers/app.js';
import { fixedClock } from '../src/infra/clock.js';
import { todayStr, addDays, weekdayName, daysBetween } from '../src/dates.js';

// Node re-reads TZ whenever it is assigned, so a test can switch zones. The
// original zone is put back afterwards, even if the runner shares the process.
const ORIGINAL_TZ = process.env.TZ;
test.after(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
});

function inZone(tz) {
  process.env.TZ = tz;
}

async function church(iso, tz = 'Europe/London') {
  inZone(tz);
  const clock = fixedClock(iso);
  const c = makeContainer({ clock });
  const adminId = await addPerson(c, { name: 'Ada Admin', email: 'ada@example.com', role: 'admin' });
  const memberId = await addPerson(c, { name: 'Max Member', email: 'max@example.com' });
  const otherId = await addPerson(c, { name: 'Olive Other', email: 'olive@example.com' });
  const actor = { id: adminId };
  const team = await c.services.teams.createTeam(actor, { name: 'Band' });
  const pos = await c.services.teams.createPosition(actor, team.id, { name: 'Keys' });
  await c.services.teams.setQualifications(actor, memberId, [pos.id]);
  await c.services.teams.setQualifications(actor, otherId, [pos.id]);
  const service = (date, time = '10:00') => c.services.calendar.createService(actor, { date, time, slots: [{ positionId: pos.id, count: 2 }] });
  return { c, clock, actor, memberId, otherId, pos, service, s: c.services };
}

const code = async (p) => {
  try { await p; return 'ok'; } catch (e) { return e.code ?? e.name; }
};

// ---------------------------------------------------------------- daylight saving

test('DST: on the spring-forward Sunday (London) the day is "today" before and after the jump', async () => {
  // 2025-03-30: clocks go from 01:00 GMT to 02:00 BST.
  const { c, clock, actor, memberId, service, s } = await church('2025-03-30T00:30:00Z');
  try {
    const svc = await service('2025-03-30');
    assert.equal(todayStr(clock.now()), '2025-03-30'); // 00:30 GMT
    await s.assignments.assign(actor, svc.slots[0].id, { personId: memberId });
    clock.set('2025-03-30T01:30:00Z'); // 02:30 BST: the hour from 01:00 to 02:00 never happened
    assert.equal(todayStr(clock.now()), '2025-03-30');
    assert.equal((await s.assignments.respond(memberId, svc.slots[0].id, 'accept')).status, 'accepted');
    const mine = await s.assignments.mySchedule(memberId);
    assert.equal(mine.nextServing.date, '2025-03-30', 'a service today is the next one');
    clock.set('2025-03-30T22:59:59Z'); // 23:59:59 BST, still Sunday
    assert.equal(await code(s.assignments.respond(memberId, svc.slots[0].id, 'decline')), 'ok');
    clock.set('2025-03-30T23:00:00Z'); // 00:00 BST Monday: only 23 hours after the day began
    assert.equal(todayStr(clock.now()), '2025-03-31');
    assert.equal(await code(s.assignments.respond(memberId, svc.slots[0].id, 'accept')), 'past');
  } finally { c.close(); }
});

test('DST: on the fall-back Sunday (London) the repeated hour is the same day, and the day ends at local midnight', async () => {
  // 2025-10-26: clocks go from 02:00 BST back to 01:00 GMT, so 01:30 happens twice.
  const { c, clock, actor, memberId, service, s } = await church('2025-10-26T00:30:00Z'); // 01:30 BST
  try {
    const svc = await service('2025-10-26', '09:30');
    assert.equal(todayStr(clock.now()), '2025-10-26');
    await s.assignments.assign(actor, svc.slots[0].id, { personId: memberId });
    clock.set('2025-10-26T01:30:00Z'); // 01:30 GMT, the second time round
    assert.equal(todayStr(clock.now()), '2025-10-26');
    assert.equal((await s.assignments.respond(memberId, svc.slots[0].id, 'accept')).status, 'accepted');
    clock.set('2025-10-26T23:59:59Z'); // 23:59:59 GMT: this day was 25 hours long
    assert.equal(await code(s.assignments.unassign(actor, svc.slots[0].id)), 'ok');
    clock.set('2025-10-27T00:00:00Z');
    assert.equal(await code(s.assignments.assign(actor, svc.slots[0].id, { personId: memberId })), 'past');
  } finally { c.close(); }
});

test('DST: weekly repeat across both changeovers stays on Sundays at the same local time', async () => {
  const { c, actor, service, s } = await church('2025-03-01T12:00:00Z');
  try {
    const spring = await service('2025-03-23');
    const r1 = await s.calendar.repeat(actor, { fromServiceId: spring.id, weeks: 3 });
    assert.deepEqual(r1.created.map((x) => [x.date, x.time, weekdayName(x.date)]), [
      ['2025-03-30', '10:00', 'Sunday'], ['2025-04-06', '10:00', 'Sunday'], ['2025-04-13', '10:00', 'Sunday']]);
    const autumn = await service('2025-10-19');
    const r2 = await s.calendar.repeat(actor, { fromServiceId: autumn.id, weeks: 3 });
    assert.deepEqual(r2.created.map((x) => x.date), ['2025-10-26', '2025-11-02', '2025-11-09']);
    assert.ok(r2.created.every((x) => x.slots.length === 2 && x.time === '10:00'));
  } finally { c.close(); }
});

test('DST: the US changeover Sundays behave the same (America/New_York)', async () => {
  // 2025-03-09 02:00 EST -> 03:00 EDT; 2025-11-02 02:00 EDT -> 01:00 EST.
  const { c, clock, actor, memberId, service, s } = await church('2025-03-09T06:59:00Z', 'America/New_York'); // 01:59 EST
  try {
    const march = await service('2025-03-09');
    const nov = await service('2025-11-02');
    assert.equal(todayStr(clock.now()), '2025-03-09');
    await s.assignments.assign(actor, march.slots[0].id, { personId: memberId });
    clock.set('2025-03-09T07:00:00Z'); // 03:00 EDT
    assert.equal(todayStr(clock.now()), '2025-03-09');
    assert.equal((await s.assignments.respond(memberId, march.slots[0].id, 'accept')).status, 'accepted');
    clock.set('2025-11-02T05:30:00Z'); // 01:30 EDT
    await s.assignments.assign(actor, nov.slots[0].id, { personId: memberId });
    clock.set('2025-11-02T06:30:00Z'); // 01:30 EST, the repeated hour
    assert.equal((await s.assignments.respond(memberId, nov.slots[0].id, 'decline')).status, 'declined');
    clock.set('2025-11-03T04:59:59Z'); // 23:59:59 EST Sunday
    assert.equal(todayStr(clock.now()), '2025-11-02');
    clock.set('2025-11-03T05:00:00Z');
    assert.equal(await code(s.assignments.respond(memberId, nov.slots[0].id, 'accept')), 'past');
  } finally { c.close(); }
});

test('DST: a session lasts exactly its length in real time across the changeover', async () => {
  const { c, clock, s } = await church('2025-03-16T12:00:00Z');
  try {
    const { token } = await s.auth.login('max@example.com', 'test-pass-1');
    clock.set('2025-03-30T11:59:59Z'); // 14 days minus one second, across the spring changeover
    assert.ok(await s.auth.authenticate(token));
    clock.set('2025-03-30T12:00:00Z');
    assert.equal(await s.auth.authenticate(token), null, 'expired after exactly 14 x 24 hours');
  } finally { c.close(); }
});

// ---------------------------------------------------------------- today and the past

test('today: a service on today\'s date can still be scheduled, answered, listed and found in gaps', async () => {
  const { c, clock, actor, memberId, service, s } = await church('2025-01-03T18:00:00Z');
  try {
    const yesterday = await service('2025-01-04'); // created while it was still upcoming
    clock.set('2025-01-05T18:00:00Z'); // a Sunday evening
    const svc = await service('2025-01-05', '19:00');
    await s.assignments.assign(actor, svc.slots[0].id, { personId: memberId });
    assert.equal((await s.assignments.respond(memberId, svc.slots[0].id, 'accept')).status, 'accepted');
    assert.deepEqual((await s.calendar.listServices()).map((x) => x.date), ['2025-01-05'], 'the default list starts today');
    const gaps = await s.gaps.gaps();
    assert.ok(gaps.items.some((g) => g.date === '2025-01-05' && g.type === 'open'), 'today\'s open slot is a gap');
    assert.ok(!gaps.items.some((g) => g.date === '2025-01-04'));
    assert.equal((await s.assignments.mySchedule(memberId)).nextServing.date, '2025-01-05');
    const reminders = await s.gaps.reminders();
    assert.deepEqual(reminders.map((r) => r.items[0].date), ['2025-01-05']);
    // Yesterday's service is in the past for every change.
    assert.equal(await code(s.assignments.assign(actor, yesterday.slots[0].id, { personId: memberId })), 'past');
    assert.equal(await code(s.assignments.unassign(actor, yesterday.slots[0].id)), 'past');
  } finally { c.close(); }
});

test('past: answers, assignments and blockouts in the past are refused over HTTP with a clear 4xx', async () => {
  inZone('Europe/London');
  const clock = fixedClock('2025-01-08T12:00:00Z'); // a Wednesday
  const app = await startTestApp({ container: { clock } });
  try {
    const { services } = app.container;
    const adminId = await addPerson(app, { name: 'Ada Admin', email: 'ada@example.com', role: 'admin' });
    const memberId = await addPerson(app, { name: 'Max Member', email: 'max@example.com' });
    const actor = { id: adminId };
    const team = await services.teams.createTeam(actor, { name: 'Band' });
    const pos = await services.teams.createPosition(actor, team.id, { name: 'Keys' });
    await services.teams.setQualifications(actor, memberId, [pos.id]);
    // Made while it was still the Sunday before, then the clock moves on.
    clock.set('2025-01-05T09:00:00Z');
    const svc = await services.calendar.createService(actor, { date: '2025-01-05', slots: [{ positionId: pos.id }] });
    await services.assignments.assign(actor, svc.slots[0].id, { personId: memberId });
    clock.set('2025-01-08T12:00:00Z');
    const admin = await loginAs(app, 'ada@example.com');
    const member = await loginAs(app, 'max@example.com');
    const h = { 'X-Flock': '1' };
    const accept = await app.request('POST', `/api/me/slots/${svc.slots[0].id}/accept`, { cookie: member, headers: h });
    assert.equal(accept.status, 409);
    assert.equal(accept.json.error, 'That service is in the past');
    const assign = await app.request('PUT', `/api/slots/${svc.slots[0].id}/assign`, { cookie: admin, headers: h, body: { personId: memberId } });
    assert.equal(assign.status, 409);
    assert.equal(assign.json.code, 'past');
    const block = await app.request('POST', '/api/me/blockouts', { cookie: member, headers: h, body: { startDate: '2025-01-01', endDate: '2025-01-07' } });
    assert.equal(block.status, 400);
    assert.equal(block.json.error, 'That time is already past');
    const today = await app.request('POST', '/api/me/blockouts', { cookie: member, headers: h, body: { startDate: '2025-01-01', endDate: '2025-01-08' } });
    assert.equal(today.status, 201, 'a blockout ending today is still allowed');
    // My schedule from today no longer shows the past service.
    const mine = await app.request('GET', '/api/me/schedule', { cookie: member });
    assert.deepEqual(mine.json.items, []);
    const earlier = await app.request('GET', '/api/me/schedule?from=2025-01-01', { cookie: member });
    assert.deepEqual(earlier.json.items.map((i) => i.date), ['2025-01-05'], 'but it can still be looked up');
  } finally { await app.close(); }
});

// ---------------------------------------------------------------- year boundaries

test('year boundary: the last second of the year, then the first of the next', async () => {
  const { c, clock, actor, memberId, otherId, service, s } = await church('2025-12-31T23:59:59Z');
  try {
    const eve = await service('2025-12-31', '23:00');
    const first = await service('2026-01-04');
    assert.equal(todayStr(clock.now()), '2025-12-31');
    await s.assignments.assign(actor, eve.slots[0].id, { personId: memberId });
    clock.advance(1000);
    assert.equal(todayStr(clock.now()), '2026-01-01');
    assert.equal(await code(s.assignments.respond(memberId, eve.slots[0].id, 'accept')), 'past');
    await s.assignments.assign(actor, first.slots[0].id, { personId: memberId });
    // A blockout across the new year blocks a service in January.
    clock.set('2025-12-20T12:00:00Z');
    await s.blockouts.add(otherId, { startDate: '2025-12-30', endDate: '2026-01-05', reason: 'New year' });
    assert.equal(await code(s.assignments.assign(actor, first.slots[1].id, { personId: otherId })), 'blocked');
    const gaps = await s.gaps.gaps({ from: '2025-12-28', to: '2026-01-10' });
    assert.deepEqual([...new Set(gaps.items.map((g) => g.date))], ['2025-12-31', '2026-01-04']);
    // My schedule from December reaches into January.
    const mine = await s.assignments.mySchedule(memberId);
    assert.deepEqual(mine.items.map((i) => i.date), ['2025-12-31', '2026-01-04']);
    // Reminders for the week that spans the new year.
    const rem = await s.gaps.reminders({ weekOf: '2025-12-29' });
    assert.deepEqual(rem[0].items.map((i) => i.date), ['2025-12-31', '2026-01-04']);
    assert.match(rem[0].message, /Keys on .*Wed.*31.*Dec.* and Keys on .*Sun.*4.*Jan/s);
  } finally { c.close(); }
});

test('year boundary: weekly repeat and date ranges cross into the next year', async () => {
  const { c, actor, service, s } = await church('2025-12-01T12:00:00Z');
  try {
    const src = await service('2025-12-21');
    const r = await s.calendar.repeat(actor, { fromServiceId: src.id, weeks: 4 });
    assert.deepEqual(r.created.map((x) => x.date), ['2025-12-28', '2026-01-04', '2026-01-11', '2026-01-18']);
    const listed = await s.calendar.listServices('2025-12-25', '2026-01-05');
    assert.deepEqual(listed.map((x) => x.date), ['2025-12-28', '2026-01-04']);
    assert.equal(addDays('2025-12-31', 1), '2026-01-01');
    assert.equal(daysBetween('2025-12-25', '2026-01-05'), 11);
  } finally { c.close(); }
});

test('year boundary: when it is already next year in UTC but still New Year\'s Eve locally, today is the local date', async () => {
  const { c, clock, actor, memberId, service, s } = await church('2026-01-01T05:00:00Z', 'America/Los_Angeles'); // 21:00 Dec 31 PST
  try {
    const eve = await service('2025-12-31', '22:00');
    assert.equal(todayStr(clock.now()), '2025-12-31');
    assert.equal(await code(s.assignments.assign(actor, eve.slots[0].id, { personId: memberId })), 'ok');
    clock.set('2026-01-01T08:00:00Z'); // midnight in Los Angeles
    assert.equal(await code(s.assignments.respond(memberId, eve.slots[0].id, 'accept')), 'past');
  } finally { c.close(); }
});

// ---------------------------------------------------------------- February 29

test('February 29: a Sunday service on 2032-02-29 works on the day; non-leap Feb 29 is refused', async () => {
  const { c, clock, actor, memberId, service, s } = await church('2032-02-29T09:00:00Z');
  try {
    assert.equal(weekdayName('2032-02-29'), 'Sunday');
    const svc = await service('2032-02-29');
    await s.assignments.assign(actor, svc.slots[0].id, { personId: memberId });
    assert.equal((await s.assignments.respond(memberId, svc.slots[0].id, 'accept')).status, 'accepted');
    assert.equal((await s.assignments.mySchedule(memberId)).nextServing.date, '2032-02-29');
    for (const bad of ['2031-02-29', '2100-02-29', '2032-02-30', '2032-02-31']) {
      assert.equal(await code(service(bad)), 'validation_error', bad);
      assert.equal(await code(s.blockouts.add(memberId, { startDate: bad })), 'validation_error', bad);
    }
    assert.equal(await code(service('2400-02-29')), 'ok', '2400 is a leap year');
    clock.set('2032-03-01T00:00:00Z'); // the next day
    assert.equal(await code(s.assignments.respond(memberId, svc.slots[0].id, 'decline')), 'past');
  } finally { c.close(); }
});

test('February 29: weekly repeat, blockouts and the 366-day limit around a leap day', async () => {
  const { c, actor, memberId, otherId, service, s } = await church('2028-01-01T12:00:00Z');
  try {
    const src = await service('2028-02-22'); // a Tuesday service, repeated weekly
    const r = await s.calendar.repeat(actor, { fromServiceId: src.id, weeks: 2 });
    assert.deepEqual(r.created.map((x) => x.date), ['2028-02-29', '2028-03-07']);
    // A blockout over the leap day covers it.
    await s.blockouts.add(otherId, { startDate: '2028-02-28', endDate: '2028-03-01' });
    assert.equal(await code(s.assignments.assign(actor, r.created[0].slots[0].id, { personId: otherId })), 'blocked');
    assert.equal(await code(s.assignments.assign(actor, r.created[0].slots[0].id, { personId: memberId })), 'ok');
    // 2028 has 366 days: the whole leap year is allowed, one more day is not.
    assert.equal(await code(s.blockouts.add(memberId, { startDate: '2028-01-01', endDate: '2028-12-31' })), 'ok');
    assert.equal(await code(s.blockouts.add(memberId, { startDate: '2028-01-01', endDate: '2029-01-01' })), 'validation_error');
    assert.equal(daysBetween('2028-02-28', '2028-03-01'), 2);
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addDays('2027-02-28', 1), '2027-03-01');
  } finally { c.close(); }
});
