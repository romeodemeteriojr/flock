import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { startTestApp } from './helpers/app.js';
import { seedAdminAndMember } from './helpers/seed.js';
import {
  isValidDate, isValidTime, addDays, daysBetween, todayStr, weekdayName, compareDates,
} from '../src/dates.js';

const X = { 'X-Flock': '1' };

async function boot() {
  const db = openDb();
  const app = await startTestApp({ db, now: () => new Date(2026, 0, 5, 12, 0, 0) });
  const s = await seedAdminAndMember(app, db);
  const call = (method, path, who, body) => app.request(method, path, {
    body, headers: X, cookie: who === 'admin' ? s.adminCookie : who === 'member' ? s.memberCookie : undefined,
  });
  db.prepare("INSERT INTO teams (id, name, sort) VALUES (1, 'Band', 1), (2, 'Tech', 2)").run();
  db.prepare("INSERT INTO positions (id, team_id, name, sort) VALUES (1, 1, 'Drums', 2), (2, 1, 'Piano', 1), (3, 2, 'Sound', 1)").run();
  return { app, db, s, call };
}

test('date helpers', () => {
  assert.equal(isValidDate('2026-02-28'), true);
  assert.equal(isValidDate('2026-02-30'), false);
  assert.equal(isValidDate('2026-02-29'), false);
  assert.equal(isValidDate('2028-02-29'), true);
  assert.equal(isValidDate('1900-02-29'), false);
  assert.equal(isValidDate('2000-02-29'), true);
  for (const bad of ['2026-13-01', '2026-00-10', '2026-04-31', '2026-1-1', '', null, 5, '2026-01-01x']) {
    assert.equal(isValidDate(bad), false, String(bad));
  }
  assert.equal(isValidTime('09:00'), true);
  assert.equal(isValidTime('23:59'), true);
  assert.equal(isValidTime('24:00'), false);
  assert.equal(isValidTime('9:00'), false);
  assert.equal(isValidTime('12:60'), false);
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-03-01', 0), '2026-03-01');
  assert.throws(() => addDays('2026-02-30', 1));
  assert.equal(daysBetween('2026-01-01', '2026-01-08'), 7);
  assert.equal(daysBetween('2026-01-08', '2026-01-01'), -7);
  assert.equal(daysBetween('2027-01-01', '2028-01-01'), 365);
  assert.equal(daysBetween('2028-01-01', '2029-01-01'), 366);
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2);
  assert.equal(todayStr(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
  assert.equal(todayStr(new Date(2026, 0, 1, 0, 0)), '2026-01-01');
  assert.equal(weekdayName('2026-01-04'), 'Sunday');
  assert.equal(weekdayName('2028-02-29'), 'Tuesday');
  assert.equal(compareDates('2026-01-01', '2026-01-02'), -1);
  assert.equal(compareDates('2026-01-02', '2026-01-01'), 1);
  assert.equal(compareDates('2026-01-01', '2026-01-01'), 0);
});

test('authorization', async () => {
  const { app, call } = await boot();
  try {
    const routes = [
      ['POST', '/api/services', { date: '2026-03-01' }],
      ['POST', '/api/services/repeat', { fromServiceId: 1, weeks: 1 }],
      ['GET', '/api/services'],
      ['PATCH', '/api/services/1', { title: 'x' }],
      ['DELETE', '/api/services/1'],
      ['POST', '/api/services/1/slots', { positionId: 1 }],
      ['DELETE', '/api/slots/1'],
    ];
    for (const [m, p, b] of routes) {
      assert.equal((await call(m, p, 'member', b)).status, 403, `${m} ${p} member`);
      assert.equal((await call(m, p, null, b)).status, 401, `${m} ${p} out`);
    }
  } finally { await app.close(); }
});

test('create with slots, validation and conflicts', async () => {
  const { app, call, db } = await boot();
  try {
    const r = await call('POST', '/api/services', 'admin', {
      date: '2026-03-01', slots: [{ positionId: 1, count: 2 }, { positionId: 2 }, { positionId: 3 }],
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.time, '09:00');
    assert.equal(r.json.title, 'Sunday service');
    assert.deepEqual(r.json.slots.map((s) => s.positionName), ['Piano', 'Drums', 'Drums', 'Sound']);
    assert.equal(r.json.slots[0].status, 'open');
    assert.equal(r.json.slots[0].personId, null);
    assert.equal(r.json.slots[0].teamName, 'Band');
    assert.equal((await call('POST', '/api/services', 'admin', { date: '2026-03-01' })).status, 409);
    assert.equal((await call('POST', '/api/services', 'admin', { date: '2026-03-01', time: '18:00' })).status, 201);
    for (const body of [
      { date: '2026-02-30' }, {}, { date: '2026-03-08', time: '25:00' }, { date: '2026-03-08', title: '' },
      { date: '2026-03-08', slots: [{ positionId: 99 }] }, { date: '2026-03-08', slots: [{ positionId: 1, count: 0 }] },
      { date: '2026-03-08', slots: [{ positionId: 1, count: 21 }] }, { date: '2026-03-08', slots: [{ positionId: 1, count: 1.5 }] },
      { date: '2026-03-08', slots: 'x' },
    ]) {
      assert.equal((await call('POST', '/api/services', 'admin', body)).status, 400, JSON.stringify(body));
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM services').get().n, 2);
    assert.equal((await call('POST', '/api/services', 'admin', { date: '2026-03-08', slots: [{ positionId: 1, count: 20 }] })).status, 201);
    assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'service.create'").get());
  } finally { await app.close(); }
});

test('repeat', async () => {
  const { app, call, db } = await boot();
  try {
    const a = await call('POST', '/api/services', 'admin', { date: '2026-12-27', slots: [{ positionId: 1, count: 2 }, { positionId: 3 }] });
    const sid = a.json.id;
    db.prepare("UPDATE slots SET person_id = 1, status = 'accepted' WHERE service_id = ? AND position_id = 3").run(sid);
    await call('POST', '/api/services', 'admin', { date: '2027-01-10' });
    const r = await call('POST', '/api/services/repeat', 'admin', { fromServiceId: sid, weeks: 3 });
    assert.equal(r.status, 201);
    assert.deepEqual(r.json.skipped, ['2027-01-10']);
    assert.deepEqual(r.json.created.map((s) => s.date), ['2027-01-03', '2027-01-17']);
    for (const s of r.json.created) {
      assert.equal(s.slots.length, 3);
      assert.ok(s.slots.every((x) => x.status === 'open' && x.personId === null));
      assert.equal(s.time, '09:00');
    }
    assert.equal((await call('POST', '/api/services/repeat', 'admin', { fromServiceId: sid, weeks: 0 })).status, 400);
    assert.equal((await call('POST', '/api/services/repeat', 'admin', { fromServiceId: sid, weeks: 27 })).status, 400);
    assert.equal((await call('POST', '/api/services/repeat', 'admin', { fromServiceId: 999, weeks: 2 })).status, 404);
    const big = await call('POST', '/api/services/repeat', 'admin', { fromServiceId: sid, weeks: 26 });
    assert.equal(big.status, 201);
    assert.equal(big.json.created.length + big.json.skipped.length + big.json.overLimit.length, 26);
    assert.equal(big.json.created.length, 6, 'only up to 10 upcoming services');
    const more = await call('POST', '/api/services', 'admin', { date: '2027-12-05' });
    assert.equal(more.status, 409);
    assert.equal(more.json.code, 'too_many_services');
  } finally { await app.close(); }
});

test('range query and ordering', async () => {
  const { app, db, call } = await boot();
  try {
    await call('POST', '/api/services', 'admin', { date: '2026-01-11', time: '11:00', slots: [{ positionId: 3 }, { positionId: 1 }, { positionId: 2 }] });
    await call('POST', '/api/services', 'admin', { date: '2026-01-11', time: '09:00' });
    db.prepare("INSERT INTO services (date, time, title) VALUES ('2026-01-04', '09:00', 'Sunday')").run(); // already past
    await call('POST', '/api/services', 'admin', { date: '2026-03-01' });
    await call('POST', '/api/services', 'admin', { date: '2026-03-02' });
    let r = await call('GET', '/api/services', 'admin');
    assert.equal(r.status, 200);
    // today 2026-01-05, default 8 weeks -> through 2026-03-02
    assert.deepEqual(r.json.map((s) => `${s.date} ${s.time}`), ['2026-01-11 09:00', '2026-01-11 11:00', '2026-03-01 09:00', '2026-03-02 09:00']);
    assert.deepEqual(r.json[1].slots.map((s) => s.positionName), ['Piano', 'Drums', 'Sound']);
    r = await call('GET', '/api/services?from=2026-01-01&to=2026-01-31', 'admin');
    assert.equal(r.json.length, 3);
    assert.equal(r.json[0].date, '2026-01-04');
    r = await call('GET', '/api/services?from=2026-03-02', 'admin');
    assert.equal(r.json.length, 1);
    assert.equal((await call('GET', '/api/services?from=2026-01-01&to=2027-01-03', 'admin')).status, 400);
    assert.equal((await call('GET', '/api/services?from=2026-01-01&to=2027-01-02', 'admin')).status, 200);
    assert.equal((await call('GET', '/api/services?from=2026-02-30', 'admin')).status, 400);
    assert.equal((await call('GET', '/api/services?from=2026-02-01&to=2026-01-01', 'admin')).status, 400);
  } finally { await app.close(); }
});

test('patch', async () => {
  const { app, call } = await boot();
  try {
    const a = (await call('POST', '/api/services', 'admin', { date: '2026-03-01' })).json;
    await call('POST', '/api/services', 'admin', { date: '2026-03-08' });
    let r = await call('PATCH', `/api/services/${a.id}`, 'admin', { title: 'Easter', time: '10:30' });
    assert.equal(r.status, 200);
    assert.equal(r.json.title, 'Easter');
    assert.equal(r.json.time, '10:30');
    assert.equal(r.json.date, '2026-03-01');
    assert.equal((await call('PATCH', `/api/services/${a.id}`, 'admin', { date: '2026-03-08', time: '09:00' })).status, 409);
    assert.equal((await call('PATCH', `/api/services/${a.id}`, 'admin', { date: '2026-03-08' })).status, 200);
    assert.equal((await call('PATCH', `/api/services/${a.id}`, 'admin', { date: '2026-02-30' })).status, 400);
    assert.equal((await call('PATCH', `/api/services/${a.id}`, 'admin', { time: 'noon' })).status, 400);
    assert.equal((await call('PATCH', '/api/services/999', 'admin', { title: 'x' })).status, 404);
  } finally { await app.close(); }
});

test('delete with and without confirm', async () => {
  const { app, call, db, s } = await boot();
  try {
    const a = (await call('POST', '/api/services', 'admin', { date: '2026-03-01', slots: [{ positionId: 1, count: 2 }] })).json;
    let r = await call('DELETE', `/api/services/${a.id}`, 'admin');
    assert.equal(r.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM slots').get().n, 0);
    const b = (await call('POST', '/api/services', 'admin', { date: '2026-03-08', slots: [{ positionId: 1, count: 2 }] })).json;
    // One person in both slots counts once (decision 0010).
    db.prepare("UPDATE slots SET person_id = ?, status = 'pending' WHERE id IN (?, ?)").run(s.memberId, b.slots[0].id, b.slots[1].id);
    r = await call('DELETE', `/api/services/${b.id}`, 'admin');
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'has_people');
    assert.equal(r.json.count, 1);
    assert.equal(r.json.error, '1 person is scheduled on this date');
    db.prepare("UPDATE slots SET person_id = ?, status = 'pending' WHERE id = ?").run(s.adminId, b.slots[1].id);
    r = await call('DELETE', `/api/services/${b.id}`, 'admin');
    assert.equal(r.json.count, 2);
    assert.equal(r.json.error, '2 people are scheduled on this date');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM services').get().n, 1);
    r = await call('DELETE', `/api/services/${b.id}?confirm=1`, 'admin');
    assert.equal(r.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM services').get().n, 0);
    assert.equal((await call('DELETE', '/api/services/999', 'admin')).status, 404);
  } finally { await app.close(); }
});

test('slot add and remove', async () => {
  const { app, call, db, s } = await boot();
  try {
    const a = (await call('POST', '/api/services', 'admin', { date: '2026-03-01' })).json;
    let r = await call('POST', `/api/services/${a.id}/slots`, 'admin', { positionId: 2, count: 3 });
    assert.equal(r.status, 201);
    assert.equal(r.json.length, 3);
    r = await call('POST', `/api/services/${a.id}/slots`, 'admin', { positionId: 3 });
    assert.equal(r.status, 201);
    assert.equal(r.json.length, 1);
    assert.equal((await call('POST', `/api/services/${a.id}/slots`, 'admin', { positionId: 99 })).status, 400);
    assert.equal((await call('POST', `/api/services/${a.id}/slots`, 'admin', { positionId: 1, count: 21 })).status, 400);
    assert.equal((await call('POST', '/api/services/999/slots', 'admin', { positionId: 1 })).status, 404);
    const slotId = r.json[0].id;
    db.prepare("UPDATE slots SET person_id = ?, status = 'accepted' WHERE id = ?").run(s.memberId, slotId);
    r = await call('DELETE', `/api/slots/${slotId}`, 'admin');
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'has_person');
    assert.equal((await call('DELETE', `/api/slots/${slotId}?confirm=1`, 'admin')).status, 200);
    const list = (await call('GET', '/api/services?from=2026-03-01&to=2026-03-01', 'admin')).json;
    assert.equal(list[0].slots.length, 3);
    const open = list[0].slots[0].id;
    assert.equal((await call('DELETE', `/api/slots/${open}`, 'admin')).status, 200);
    assert.equal((await call('DELETE', `/api/slots/${open}`, 'admin')).status, 404);
  } finally { await app.close(); }
});
