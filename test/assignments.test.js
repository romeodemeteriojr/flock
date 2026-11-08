// HTTP integration tests for assignments: the real app on an in-memory
// database with a fixed clock. Only made-up people.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { startTestApp } from './helpers/app.js';
import { addPerson, loginAs, seedAdminAndMember } from './helpers/seed.js';

const X = { 'X-Flock': '1' };

async function boot() {
  const db = openDb();
  const app = await startTestApp({ db, now: () => new Date('2025-01-05T12:00:00') });
  const s = await seedAdminAndMember(app, db);
  const { data } = app;
  const team = await data.teams.create({ name: 'Band' });
  const drums = await data.positions.create(team.id, { name: 'Drums' });
  const keys = await data.positions.create(team.id, { name: 'Keys' });
  await data.qualifications.setForPerson(s.memberId, [drums.id, keys.id]);
  const otherId = await addPerson(db, { name: 'Olive Other', email: 'olive@example.com' });
  await data.qualifications.setForPerson(otherId, [drums.id, keys.id]);
  const otherCookie = await loginAs(app, 'olive@example.com');
  async function service(date, positions = [drums.id, keys.id]) {
    const svc = await data.services.create({ date, title: 'Sunday service' });
    return (await data.slots.createMany(svc.id, positions)).map((x) => x.id);
  }
  const call = (method, path, cookie, body) => app.request(method, path, { cookie, body, headers: X });
  return { db, app, data, drums, keys, otherId, otherCookie, service, call, ...s };
}

test('assign, schedule, accept, decline and unassign end to end', async () => {
  const { app, data, service, call, adminCookie, memberCookie, memberId, otherId } = await boot();
  try {
    const [a, b] = await service('2025-01-12');
    const r = await call('PUT', `/api/slots/${a}/assign`, adminCookie, { personId: memberId });
    assert.equal(r.status, 200);
    assert.equal(r.json.slot.id, a);
    assert.equal(r.json.slot.status, 'pending');
    assert.equal(r.json.slot.personName, 'Max Member');
    assert.equal((await call('PUT', `/api/slots/${b}/assign`, adminCookie, { personId: otherId })).status, 200);

    const sched = await app.request('GET', '/api/me/schedule', { cookie: memberCookie });
    assert.equal(sched.status, 200);
    assert.equal(sched.json.nextServing.slotId, a);
    assert.deepEqual(sched.json.items, [{
      slotId: a, date: '2025-01-12', time: '09:00', serviceTitle: 'Sunday service', positionName: 'Drums', teamName: 'Band',
      status: 'pending', coVolunteers: [{ name: 'Olive Other', positionName: 'Keys' }],
    }]);

    const acc = await call('POST', `/api/me/slots/${a}/accept`, memberCookie);
    assert.equal(acc.status, 200);
    assert.equal(acc.json.slot.status, 'accepted');
    assert.equal(typeof acc.json.slot.respondedAt, 'string');
    const dec = await call('POST', `/api/me/slots/${a}/decline`, memberCookie);
    assert.equal(dec.json.slot.status, 'declined');
    assert.equal((await data.slots.findById(a)).status, 'declined');

    const un = await call('DELETE', `/api/slots/${a}/assign`, adminCookie);
    assert.equal(un.status, 200);
    assert.equal(un.json.slot.status, 'open');
    assert.equal(un.json.slot.personId, null);
    const audit = (await data.audit.list()).map((e) => e.action);
    for (const act of ['slot.assign', 'slot.accept', 'slot.decline', 'slot.unassign']) assert.ok(audit.includes(act), act);
  } finally { await app.close(); }
});

test('assign conflicts come back as 409 with a code; force overrides all but inactive', async () => {
  const { app, data, db, service, call, adminCookie, memberId } = await boot();
  try {
    const [a, b] = await service('2025-01-12');
    await call('PUT', `/api/slots/${a}/assign`, adminCookie, { personId: memberId });
    const dbl = await call('PUT', `/api/slots/${b}/assign`, adminCookie, { personId: memberId });
    assert.equal(dbl.status, 409);
    assert.equal(dbl.json.code, 'double_booked');
    assert.equal(typeof dbl.json.error, 'string');
    assert.equal((await call('PUT', `/api/slots/${b}/assign`, adminCookie, { personId: memberId, force: true })).status, 200);

    const newbie = await addPerson(db, { name: 'Nina New', email: 'nina@example.com' });
    const [c] = await service('2025-01-19');
    const nq = await call('PUT', `/api/slots/${c}/assign`, adminCookie, { personId: newbie });
    assert.deepEqual([nq.status, nq.json.code], [409, 'not_qualified']);

    await data.blockouts.create({ personId: memberId, startDate: '2025-01-19', endDate: '2025-01-19', createdAt: 'x' });
    const bl = await call('PUT', `/api/slots/${c}/assign`, adminCookie, { personId: memberId });
    assert.deepEqual([bl.status, bl.json.code], [409, 'blocked']);
    assert.equal((await call('PUT', `/api/slots/${c}/assign`, adminCookie, { personId: memberId, force: true })).status, 200);

    const gone = await addPerson(db, { name: 'Gail Gone', email: 'gail@example.com', active: false });
    for (const force of [false, true]) {
      const r = await call('PUT', `/api/slots/${c}/assign`, adminCookie, { personId: gone, force });
      assert.deepEqual([r.status, r.json.code], [409, 'inactive']);
    }

    const [old] = await service('2025-01-04');
    const p = await call('PUT', `/api/slots/${old}/assign`, adminCookie, { personId: memberId, force: true });
    assert.deepEqual([p.status, p.json.code], [409, 'past']);
    const pd = await call('DELETE', `/api/slots/${old}/assign`, adminCookie);
    assert.deepEqual([pd.status, pd.json.code], [409, 'past']);
  } finally { await app.close(); }
});

test('bad input and unknown ids', async () => {
  const { app, service, call, adminCookie, memberCookie, memberId } = await boot();
  try {
    const [a] = await service('2025-01-12');
    for (const body of [{}, { personId: 'x' }, { personId: 0 }, { personId: memberId, force: 'yes' }]) {
      const r = await call('PUT', `/api/slots/${a}/assign`, adminCookie, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(typeof r.json.error, 'string');
    }
    assert.equal((await call('PUT', '/api/slots/9999/assign', adminCookie, { personId: memberId })).status, 404);
    assert.equal((await call('PUT', '/api/slots/abc/assign', adminCookie, { personId: memberId })).status, 404);
    assert.equal((await call('PUT', `/api/slots/${a}/assign`, adminCookie, { personId: 9999 })).status, 404);
    assert.equal((await call('DELETE', '/api/slots/9999/assign', adminCookie)).status, 404);
    assert.equal((await call('POST', '/api/me/slots/9999/accept', memberCookie)).status, 404);
    assert.equal((await call('POST', '/api/me/slots/abc/decline', memberCookie)).status, 404);
    assert.equal((await app.request('GET', '/api/me/schedule?from=2025-02-30', { cookie: memberCookie })).status, 400);
  } finally { await app.close(); }
});

test('a member cannot touch another member\'s slot', async () => {
  const { app, data, service, call, adminCookie, memberCookie, memberId, otherCookie } = await boot();
  try {
    const [a] = await service('2025-01-12');
    await call('PUT', `/api/slots/${a}/assign`, adminCookie, { personId: memberId });
    for (const action of ['accept', 'decline']) {
      const r = await call('POST', `/api/me/slots/${a}/${action}`, otherCookie);
      assert.equal(r.status, 404);
    }
    assert.equal((await data.slots.findById(a)).status, 'pending');
    const theirs = await app.request('GET', '/api/me/schedule', { cookie: otherCookie });
    assert.deepEqual(theirs.json, { nextServing: null, items: [] });
    // Members cannot assign or unassign at all, not even themselves.
    assert.equal((await call('PUT', `/api/slots/${a}/assign`, memberCookie, { personId: memberId })).status, 403);
    assert.equal((await call('DELETE', `/api/slots/${a}/assign`, memberCookie)).status, 403);
    assert.equal((await data.slots.findById(a)).personId, memberId);
  } finally { await app.close(); }
});

test('responding to a past service is 409 past', async () => {
  const { app, data, service, call, memberCookie, memberId } = await boot();
  try {
    const [old] = await service('2025-01-04');
    await data.slots.assign(old, { personId: memberId, assignedAt: 'x' });
    const r = await call('POST', `/api/me/slots/${old}/accept`, memberCookie);
    assert.deepEqual([r.status, r.json.code], [409, 'past']);
  } finally { await app.close(); }
});

test('authorization matrix', async () => {
  const { app, service, memberCookie, memberId } = await boot();
  try {
    const [a] = await service('2025-01-12');
    const routes = [
      ['PUT', `/api/slots/${a}/assign`, { personId: memberId }], ['DELETE', `/api/slots/${a}/assign`],
      ['GET', '/api/me/schedule'], ['POST', `/api/me/slots/${a}/accept`], ['POST', `/api/me/slots/${a}/decline`],
    ];
    for (const [m, path, body] of routes) {
      const r = await app.request(m, path, { headers: X, body });
      assert.equal(r.status, 401, `${m} ${path}`);
    }
    for (const [m, path, body] of routes.slice(0, 2)) {
      assert.equal((await app.request(m, path, { headers: X, body, cookie: memberCookie })).status, 403, `${m} ${path}`);
    }
    for (const [m, path, body] of routes.filter(([m]) => m !== 'GET')) {
      const r = await app.request(m, path, { body, cookie: memberCookie });
      assert.equal(r.status, 403, `no X-Flock: ${m} ${path}`);
    }
  } finally { await app.close(); }
});
