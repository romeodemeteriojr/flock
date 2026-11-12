// HTTP integration tests for the scheduler tools (gaps, suggestions, reminders):
// the real app on an in-memory database with a fixed clock. Only made-up people.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { startTestApp } from './helpers/app.js';
import { addPerson, seedAdminAndMember } from './helpers/seed.js';

async function boot() {
  const db = openDb();
  const app = await startTestApp({ db, now: () => new Date('2025-01-05T12:00:00') });
  const s = await seedAdminAndMember(app, db);
  const { data } = app;
  const team = await data.teams.create({ name: 'Band' });
  const drums = await data.positions.create(team.id, { name: 'Drums' });
  await data.qualifications.setForPerson(s.memberId, [drums.id]);
  const otherId = await addPerson(db, { name: 'Olive Other', email: 'olive@example.com' });
  await data.qualifications.setForPerson(otherId, [drums.id]);
  const svc = await data.services.create({ date: '2025-01-12', title: 'Sunday service' });
  const [open, pending] = (await data.slots.createMany(svc.id, [drums.id, drums.id])).map((x) => x.id);
  await data.slots.assign(pending, { personId: s.memberId, status: 'pending', assignedAt: new Date('2025-01-05T10:00:00').toISOString() });
  const get = (path, cookie) => app.request('GET', path, { cookie });
  return { app, data, drums, otherId, svc, open, pending, get, ...s };
}

test('admin routes: log in required (401) and admin only (403)', async () => {
  const { app, get, memberCookie } = await boot();
  try {
    for (const path of ['/api/admin/gaps', '/api/admin/suggest?slotId=1', '/api/admin/reminders']) {
      const anon = await get(path);
      assert.equal(anon.status, 401, path);
      assert.equal(anon.json.error, 'Please log in');
      const member = await get(path, memberCookie);
      assert.equal(member.status, 403, path);
      assert.equal(typeof member.json.error, 'string');
    }
  } finally { await app.close(); }
});

test('GET /api/admin/gaps: shape, defaults and validation errors', async () => {
  const { app, get, adminCookie, svc, open, pending, memberId } = await boot();
  try {
    const r = await get('/api/admin/gaps', adminCookie);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {
      summary: { open: 1, declined: 0, unanswered: 1, blocked: 0, inactive: 0 },
      items: [
        { type: 'open', slotId: open, serviceId: svc.id, date: '2025-01-12', time: '09:00', serviceTitle: 'Sunday service', positionName: 'Drums', teamName: 'Band' },
        { type: 'unanswered', slotId: pending, serviceId: svc.id, date: '2025-01-12', time: '09:00', serviceTitle: 'Sunday service', positionName: 'Drums', teamName: 'Band', personId: memberId, personName: 'Max Member' },
      ],
    });
    const empty = await get('/api/admin/gaps?from=2025-02-01&to=2025-02-10', adminCookie);
    assert.deepEqual(empty.json, { summary: { open: 0, declined: 0, unanswered: 0, blocked: 0, inactive: 0 }, items: [] });
    assert.equal((await get('/api/admin/gaps?from=&to=', adminCookie)).json.items.length, 2);

    for (const q of ['from=nope', 'to=2025-02-30', 'from=2025-02-01&to=2025-01-01', 'from=2025-01-01&to=2026-06-01']) {
      const bad = await get(`/api/admin/gaps?${q}`, adminCookie);
      assert.equal(bad.status, 400, q);
      assert.equal(typeof bad.json.error, 'string');
    }
  } finally { await app.close(); }
});

test('GET /api/admin/suggest: shape, includeUnqualified and validation errors', async () => {
  const { app, get, adminCookie, open, otherId, adminId } = await boot();
  try {
    const r = await get(`/api/admin/suggest?slotId=${open}`, adminCookie);
    assert.equal(r.status, 200);
    // Max is already on this service; Olive is qualified; Ada is not set up for Drums.
    assert.deepEqual(r.json, {
      candidates: [{
        personId: otherId, name: 'Olive Other', servedLast8Weeks: 0, lastServed: null, qualified: true,
        reasons: ['Has not served in 8 weeks', 'Has never served', 'Nothing scheduled in the next 4 weeks'],
      }],
    });
    for (const flag of ['true', '1']) {
      const all = await get(`/api/admin/suggest?slotId=${open}&includeUnqualified=${flag}`, adminCookie);
      assert.equal(all.status, 200);
      const ada = all.json.candidates.find((c) => c.personId === adminId);
      assert.equal(ada.qualified, false);
    }
    const no = await get(`/api/admin/suggest?slotId=${open}&includeUnqualified=false`, adminCookie);
    assert.equal(no.json.candidates.length, 1);

    for (const q of ['', 'slotId=', 'slotId=abc', 'slotId=-1', `slotId=${open}&includeUnqualified=maybe`]) {
      const bad = await get(`/api/admin/suggest?${q}`, adminCookie);
      assert.equal(bad.status, 400, q);
      assert.equal(typeof bad.json.error, 'string');
    }
    const missing = await get('/api/admin/suggest?slotId=9999', adminCookie);
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, 'Slot not found');
  } finally { await app.close(); }
});

test('GET /api/admin/reminders: drafts only, shape and validation errors', async () => {
  const { app, data, get, adminCookie, memberId, pending } = await boot();
  try {
    const r = await get('/api/admin/reminders?weekOf=2025-01-06', adminCookie);
    assert.equal(r.status, 200);
    assert.equal(r.json.reminders.length, 1);
    const [m] = r.json.reminders;
    assert.equal(m.personId, memberId);
    assert.equal(m.name, 'Max Member');
    assert.equal(m.message, 'Hi Max, a reminder that you are serving as Drums on Sun 12 Jan at 09:00. Please open Flock and accept or decline. Thank you!');
    assert.deepEqual(m.items.map((i) => [i.slotId, i.status]), [[pending, 'pending']]);
    // default week starts today (2025-01-05 .. 2025-01-11): the 12th is outside
    assert.deepEqual((await get('/api/admin/reminders', adminCookie)).json, { reminders: [], push: false });
    const bad = await get('/api/admin/reminders?weekOf=next', adminCookie);
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /Week of/);
    assert.deepEqual(await data.audit.list(), []);
  } finally { await app.close(); }
});
