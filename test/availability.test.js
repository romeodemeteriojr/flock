// Availability (how often a volunteer serves) and auto-fill over real HTTP. Made-up people only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/app.js';
import { seedAdminAndMember } from './helpers/seed.js';
import { makeData } from './helpers/data.js';
import { fixedClock } from '../src/infra/clock.js';
import { createAvailabilityService, DEFAULT_EVERY_WEEKS } from '../src/services/availability-service.js';
import { ValidationError } from '../src/errors.js';

const X = { 'X-Flock': '1' };
const NOW = '2025-01-05T12:00:00';

async function boot() {
  const app = await startTestApp({ now: () => new Date(NOW) });
  const s = await seedAdminAndMember(app);
  return { app, ...s };
}

// ---------- service ----------

test('availability service: default until chosen, then the choice; bad values refused', async () => {
  const { data } = makeData();
  const svc = createAvailabilityService({ data, clock: fixedClock(new Date(NOW)) });
  const p = await data.people.create({ name: 'Pat', email: 'pat@example.com', passwordHash: 'x', createdAt: NOW });
  assert.equal(DEFAULT_EVERY_WEEKS, 2);
  assert.deepEqual(await svc.getMine(p.id), { everyWeeks: 2, isDefault: true, updatedAt: null });
  const saved = await svc.setMine(p.id, { everyWeeks: 4 });
  assert.deepEqual(saved, { everyWeeks: 4, isDefault: false, updatedAt: new Date(NOW).toISOString() });
  assert.deepEqual(await svc.getMine(p.id), saved);
  assert.deepEqual((await svc.setMine(p.id, { everyWeeks: 0 })).everyWeeks, 0);
  for (const bad of [5, 7, 9, -1, '2', null, undefined, 1.5]) {
    await assert.rejects(svc.setMine(p.id, { everyWeeks: bad }), ValidationError, String(bad));
  }
  assert.equal((await svc.getMine(p.id)).everyWeeks, 0);
});

// ---------- routes ----------

test('GET/PUT /api/me/availability: a member reads and sets their own', async () => {
  const { app, memberCookie, memberId } = await boot();
  try {
    let r = await app.request('GET', '/api/me/availability', { cookie: memberCookie });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { availability: { everyWeeks: 2, isDefault: true, updatedAt: null } });

    r = await app.request('PUT', '/api/me/availability', { cookie: memberCookie, headers: X, body: { everyWeeks: 3 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.availability.everyWeeks, 3);
    assert.equal(r.json.availability.isDefault, false);
    assert.equal((await app.data.availability.get(memberId)).everyWeeks, 3);

    for (const body of [{ everyWeeks: 5 }, { everyWeeks: '3' }, {}, { everyWeeks: 3, personId: 1 }, []]) {
      const bad = await app.request('PUT', '/api/me/availability', { cookie: memberCookie, headers: X, body });
      assert.equal(bad.status, 400, JSON.stringify(body));
      assert.equal(typeof bad.json.error, 'string');
    }
    assert.equal((await app.data.availability.get(memberId)).everyWeeks, 3);
  } finally { await app.close(); }
});

test('PUT /api/me/availability only changes the caller', async () => {
  const { app, memberCookie, adminId } = await boot();
  try {
    await app.request('PUT', '/api/me/availability', { cookie: memberCookie, headers: X, body: { everyWeeks: 8 } });
    assert.equal(await app.data.availability.get(adminId), null);
  } finally { await app.close(); }
});

test('POST /api/admin/autofill: scheduler only; preview then apply', async () => {
  const { app, adminCookie, memberCookie, memberId } = await boot();
  try {
    const team = (await app.request('POST', '/api/teams', { cookie: adminCookie, headers: X, body: { name: 'Band' } })).json;
    const drums = (await app.request('POST', `/api/teams/${team.id}/positions`, { cookie: adminCookie, headers: X, body: { name: 'Drums' } })).json;
    await app.request('PUT', `/api/people/${memberId}/positions`, { cookie: adminCookie, headers: X, body: { positionIds: [drums.id] } });
    const svc = (await app.request('POST', '/api/services', { cookie: adminCookie, headers: X, body: { date: '2025-01-12', slots: [{ positionId: drums.id }] } })).json;

    assert.equal((await app.request('POST', '/api/admin/autofill', { cookie: memberCookie, headers: X, body: {} })).status, 403);

    const preview = await app.request('POST', '/api/admin/autofill', { cookie: adminCookie, headers: X, body: { weekOf: '2025-01-06' } });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.applied, false);
    assert.deepEqual(preview.json.assigned.map((a) => [a.slotId, a.personId, a.personName]), [[svc.slots[0].id, memberId, 'Max Member']]);
    assert.deepEqual(preview.json.unfilled, []);

    const done = await app.request('POST', '/api/admin/autofill', { cookie: adminCookie, headers: X, body: { weekOf: '2025-01-06', apply: true } });
    assert.equal(done.status, 200);
    assert.equal(done.json.applied, true);
    const mine = await app.request('GET', '/api/me/schedule', { cookie: memberCookie });
    assert.deepEqual(mine.json.items.map((i) => [i.date, i.positionName, i.status]), [['2025-01-12', 'Drums', 'pending']]);

    for (const body of [{ weeks: 0 }, { weeks: 9 }, { weekOf: 'soon' }, { apply: 'yes' }, { surprise: 1 }]) {
      const bad = await app.request('POST', '/api/admin/autofill', { cookie: adminCookie, headers: X, body });
      assert.equal(bad.status, 400, JSON.stringify(body));
    }
  } finally { await app.close(); }
});
