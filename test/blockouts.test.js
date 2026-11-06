import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createData } from '../src/data/index.js';
import { createBlockoutsService } from '../src/services/blockouts-service.js';
import { fixedClock } from '../src/infra/clock.js';
import { startTestApp } from './helpers/app.js';
import { addPerson, seedAdminAndMember } from './helpers/seed.js';

const X = { 'X-Flock': '1' };

function addBlock(db, pid, s, e, reason = '') {
  return Number(db.prepare('INSERT INTO blockouts (person_id,start_date,end_date,reason,created_at) VALUES (?,?,?,?,?)')
    .run(pid, s, e, reason, 'x').lastInsertRowid);
}
function addSlot(db, pid, date, status, time = '09:00') {
  let team = db.prepare("SELECT id FROM teams WHERE name='Band'").get();
  if (!team) team = { id: Number(db.prepare("INSERT INTO teams (name) VALUES ('Band')").run().lastInsertRowid) };
  let pos = db.prepare("SELECT id FROM positions WHERE name='Drums'").get();
  if (!pos) pos = { id: Number(db.prepare("INSERT INTO positions (team_id,name) VALUES (?, 'Drums')").run(team.id).lastInsertRowid) };
  const sv = Number(db.prepare('INSERT INTO services (date,time,title) VALUES (?,?,?)').run(date, time, 'Sunday').lastInsertRowid);
  return Number(db.prepare('INSERT INTO slots (service_id,position_id,person_id,status) VALUES (?,?,?,?)')
    .run(sv, pos.id, pid, status).lastInsertRowid);
}

// The blockout helpers now live in the blockouts service (async, on the data layer).
function helpers(db) {
  const svc = createBlockoutsService({ data: createData(db), clock: fixedClock(new Date('2025-01-05T12:00:00')) });
  return { isBlocked: svc.isBlocked, blockedPersonIds: svc.blockedPersonIds, conflictsFor: svc.conflictsFor };
}

async function boot() {
  const db = openDb();
  const app = await startTestApp({ db, now: () => new Date('2025-01-05T12:00:00') });
  const s = await seedAdminAndMember(app, db);
  return { db, app, ...s };
}

test('helpers: single day, range edges, adjacent ranges', async () => {
  const db = openDb();
  const { isBlocked, blockedPersonIds, conflictsFor } = helpers(db);
  const p = await addPerson(db, { name: 'Pat', username: 'pat' });
  const q = await addPerson(db, { name: 'Quinn', username: 'quinn' });
  addBlock(db, p, '2025-03-10', '2025-03-10');
  addBlock(db, p, '2025-03-11', '2025-03-12');
  addBlock(db, q, '2025-03-12', '2025-03-14');
  assert.equal(await isBlocked(p, '2025-03-09'), false);
  assert.equal(await isBlocked(p, '2025-03-10'), true);
  assert.equal(await isBlocked(p, '2025-03-11'), true);
  assert.equal(await isBlocked(p, '2025-03-12'), true);
  assert.equal(await isBlocked(p, '2025-03-13'), false);
  assert.deepEqual([...(await blockedPersonIds('2025-03-12'))].sort(), [p, q].sort());
  assert.deepEqual([...(await blockedPersonIds('2025-03-10'))], [p]);
  assert.equal((await blockedPersonIds('2025-03-15')).size, 0);
  const a = addSlot(db, p, '2025-03-10', 'accepted');
  addSlot(db, p, '2025-03-13', 'pending');
  assert.deepEqual((await conflictsFor(p, '2025-03-10', '2025-03-10')).map((c) => c.slotId), [a]);
  assert.equal((await conflictsFor(p, '2025-03-10', '2025-03-13')).length, 2);
  assert.equal((await conflictsFor(p, '2025-03-11', '2025-03-12')).length, 0);
});

test('conflicts only pending/accepted and own', async () => {
  const db = openDb();
  const { conflictsFor } = helpers(db);
  const p = await addPerson(db, { name: 'Pat', username: 'pat' });
  const q = await addPerson(db, { name: 'Quinn', username: 'quinn' });
  addSlot(db, p, '2025-04-06', 'declined', '08:00');
  addSlot(db, p, '2025-04-06', 'open', '10:00');
  const ok = addSlot(db, p, '2025-04-06', 'pending', '11:00');
  addSlot(db, q, '2025-04-06', 'accepted', '12:00');
  const c = await conflictsFor(p, '2025-04-01', '2025-04-30');
  assert.deepEqual(c, [{ slotId: ok, date: '2025-04-06', time: '11:00', serviceTitle: 'Sunday', positionName: 'Drums', teamName: 'Band', status: 'pending' }]);
});

test('member create, defaults, list sorted and hides past', async () => {
  const { db, app, memberCookie, memberId } = await boot();
  try {
    const post = (body) => app.request('POST', '/api/me/blockouts', { body, cookie: memberCookie, headers: X });
    const slot = addSlot(db, memberId, '2025-11-08', 'accepted');
    addSlot(db, memberId, '2025-11-09', 'declined');
    const r = await post({ startDate: '2025-11-08', reason: '  trip  ' });
    assert.equal(r.status, 201);
    assert.equal(r.json.blockout.endDate, '2025-11-08');
    assert.equal(r.json.blockout.reason, 'trip');
    assert.deepEqual(r.json.conflicts.map((c) => c.slotId), [slot]);
    assert.equal((await post({ startDate: '2025-02-01', endDate: '2025-02-03' })).status, 201);
    assert.equal((await post({ startDate: '2025-01-05' })).status, 201); // today ok
    assert.equal((await post({ startDate: '2025-01-01', endDate: '2025-01-05' })).status, 201);
    addBlock(db, memberId, '2024-01-01', '2024-01-04');
    const l = await app.request('GET', '/api/me/blockouts', { cookie: memberCookie });
    assert.equal(l.status, 200);
    assert.deepEqual(l.json.blockouts.map((b) => b.startDate), ['2025-01-01', '2025-01-05', '2025-02-01', '2025-11-08']);
  } finally { await app.close(); }
});

test('validation errors', async () => {
  const { app, memberCookie } = await boot();
  try {
    const post = (body) => app.request('POST', '/api/me/blockouts', { body, cookie: memberCookie, headers: X });
    const cases = [
      {}, { startDate: 'nope' }, { startDate: '2025-02-30' }, { startDate: '2025-13-01' }, { startDate: 5 },
      { startDate: '2025-03-01', endDate: '2025-02-28' }, { startDate: '2025-03-01', endDate: 'x' },
      { startDate: '2025-01-01', endDate: '2025-01-04' }, { startDate: '2024-12-01' },
      { startDate: '2025-01-10', endDate: '2026-01-11' }, // 367 days
      { startDate: '2025-01-10', reason: 'a'.repeat(201) }, { startDate: '2025-01-10', reason: 7 },
    ];
    for (const c of cases) {
      const r = await post(c);
      assert.equal(r.status, 400, JSON.stringify(c));
      assert.equal(typeof r.json.error, 'string');
    }
    assert.equal((await post({ startDate: '2025-01-10', endDate: '2026-01-10' })).status, 201); // 366 days
    assert.equal((await post({ startDate: '2025-01-10', reason: 'a'.repeat(200) })).status, 201);
    assert.equal((await post({ startDate: '2028-02-29' })).status, 201);
  } finally { await app.close(); }
});

test('member cannot see or delete another member\'s blockout; can delete own', async () => {
  const { db, app, memberCookie, memberId, adminCookie, adminId } = await boot();
  try {
    const theirs = addBlock(db, adminId, '2025-05-01', '2025-05-02');
    const mine = addBlock(db, memberId, '2025-05-03', '2025-05-04');
    const l = await app.request('GET', '/api/me/blockouts', { cookie: memberCookie });
    assert.deepEqual(l.json.blockouts.map((b) => b.id), [mine]);
    const d = await app.request('DELETE', `/api/me/blockouts/${theirs}`, { cookie: memberCookie, headers: X });
    assert.equal(d.status, 404);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM blockouts WHERE id=?').get(theirs).n, 1);
    assert.equal((await app.request('DELETE', '/api/me/blockouts/abc', { cookie: memberCookie, headers: X })).status, 404);
    assert.equal((await app.request('DELETE', `/api/me/blockouts/${mine}`, { cookie: memberCookie, headers: X })).status, 200);
    assert.equal((await app.request('DELETE', `/api/me/blockouts/${mine}`, { cookie: memberCookie, headers: X })).status, 404);
    assert.equal((await app.request('DELETE', `/api/me/blockouts/${theirs}`, { cookie: adminCookie, headers: X })).status, 200);
  } finally { await app.close(); }
});

test('admin lists', async () => {
  const { db, app, adminCookie, memberId } = await boot();
  try {
    addBlock(db, memberId, '2025-05-03', '2025-05-10');
    addBlock(db, memberId, '2025-07-01', '2025-07-01');
    const p = await app.request('GET', `/api/people/${memberId}/blockouts`, { cookie: adminCookie });
    assert.equal(p.status, 200);
    assert.equal(p.json.blockouts.length, 2);
    assert.equal(p.json.blockouts[0].personName, 'Max Member');
    assert.equal((await app.request('GET', '/api/people/9999/blockouts', { cookie: adminCookie })).status, 404);
    const all = await app.request('GET', '/api/blockouts', { cookie: adminCookie });
    assert.equal(all.json.blockouts.length, 2);
    const f = await app.request('GET', '/api/blockouts?from=2025-05-10&to=2025-06-30', { cookie: adminCookie });
    assert.deepEqual(f.json.blockouts.map((b) => b.startDate), ['2025-05-03']);
    const g = await app.request('GET', '/api/blockouts?from=2025-05-11&to=2025-06-30', { cookie: adminCookie });
    assert.equal(g.json.blockouts.length, 0);
    assert.equal((await app.request('GET', '/api/blockouts?from=bad', { cookie: adminCookie })).status, 400);
  } finally { await app.close(); }
});

test('authorization matrix', async () => {
  const { app, memberCookie, memberId } = await boot();
  try {
    for (const [m, path] of [['GET', '/api/me/blockouts'], ['POST', '/api/me/blockouts'], ['DELETE', '/api/me/blockouts/1'],
      ['GET', `/api/people/${memberId}/blockouts`], ['GET', '/api/blockouts']]) {
      const r = await app.request(m, path, { headers: X, body: m === 'POST' ? { startDate: '2025-06-01' } : undefined });
      assert.equal(r.status, 401, `${m} ${path}`);
    }
    for (const path of [`/api/people/${memberId}/blockouts`, '/api/blockouts']) {
      assert.equal((await app.request('GET', path, { cookie: memberCookie })).status, 403);
    }
    const noHeader = await app.request('POST', '/api/me/blockouts', { cookie: memberCookie, body: { startDate: '2025-06-01' } });
    assert.equal(noHeader.status, 403);
  } finally { await app.close(); }
});
