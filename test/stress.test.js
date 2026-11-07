// Stress and concurrency over real HTTP (C-83). A made-up church of 70 members
// and 5 schedulers, a month of Sunday services with several positions, then
// many requests at once: logins, accept/decline, schedulers racing for the
// same person or slot, password resets and blockout edits. The database is a
// temporary file (WAL, like production); the clock is fixed and the random
// source seeded, so every run is the same. Nothing real is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp } from './helpers/app.js';
import { createClient, cookieFrom, tokenFromLink } from './helpers/client.js';
import { buildChurch, PASSWORD } from './helpers/church.js';
import { openDb } from '../src/db.js';
import { fixedClock } from '../src/infra/clock.js';
import { seededRandom } from '../src/infra/random.js';

const NOW = '2025-01-05T12:00:00'; // a Sunday (local time)
const SUNDAYS = ['2025-01-12', '2025-01-19', '2025-01-26', '2025-02-02'];

async function boot() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'flock-stress-'));
  const db = openDb(path.join(dir, 'stress.db'));
  const app = await startTestApp({ db, container: { clock: fixedClock(NOW), random: seededRandom('stress') } });
  const church = await buildChurch(app.container, { members: 70, schedulers: 5, sundays: SUNDAYS });
  const client = createClient(app);
  return {
    app, church, client, db,
    async done() {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const auditCount = (db, action, like = '%') => Number(db.prepare(
  'SELECT COUNT(*) AS n FROM audit WHERE action = ? AND detail LIKE ?',
).get(action, like).n);

// Somebody holding two slots on one service (pending or accepted) is a double booking.
function doubleBookings(db) {
  return db.prepare(`SELECT service_id, person_id, COUNT(*) AS n FROM slots
    WHERE person_id IS NOT NULL AND status IN ('pending','accepted')
    GROUP BY service_id, person_id HAVING n > 1`).all();
}

function healthy(db) {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(doubleBookings(db), []);
}

function no500(client) {
  const bad = client.responses.filter((r) => r.status >= 500);
  assert.deepEqual(bad.map((r) => `${r.method} ${r.path} ${r.status}`), []);
}

async function loggedIn(client, username) {
  const b = client.browser();
  const res = await b.login(username, PASSWORD);
  assert.equal(res.status, 200, `${username} logs in`);
  return b;
}

test('stress: 50 members log in at the same moment, each gets their own working session', async () => {
  const ctx = await boot();
  try {
    const browsers = Array.from({ length: 50 }, () => ctx.client.browser());
    const results = await Promise.all(browsers.map((b, i) => b.login(`member${i + 1}`, PASSWORD)));
    assert.deepEqual(results.map((r) => r.status), Array(50).fill(200));
    const cookies = new Set(browsers.map((b) => b.cookie));
    assert.equal(cookies.size, 50, 'every login has a different session token');
    assert.equal(Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n), 50);

    // All 50 use their session at once and each sees only themselves.
    const me = await Promise.all(browsers.map((b) => b.get('/api/me')));
    me.forEach((r, i) => assert.equal(r.json.person.username, `member${i + 1}`));
    no500(ctx.client);
    healthy(ctx.db);
  } finally { await ctx.done(); }
});

test('stress: concurrent wrong passwords for one account are all counted (no lost lockout updates)', async () => {
  const ctx = await boot();
  try {
    const tries = await Promise.all(Array.from({ length: 8 }, () => ctx.client.browser().login('member70', 'wrong-password')));
    const statuses = tries.map((r) => r.status).sort();
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429, 429], 'exactly 5 failures counted, then locked');
    const row = ctx.db.prepare("SELECT failed_logins, locked_until FROM people WHERE username = 'member70'").get();
    assert.equal(row.failed_logins, 5);
    assert.ok(row.locked_until, 'the account is locked');
    no500(ctx.client);
  } finally { await ctx.done(); }
});

test('stress: 5 schedulers assign 30 people at once, then the 30 accept or decline at the same moment', async () => {
  const ctx = await boot();
  try {
    const { church, client, db } = ctx;
    const schedulers = await Promise.all([1, 2, 3, 4, 5].map((i) => loggedIn(client, `sched${i}`)));
    // 30 different people, spread over 4 services (8 slots each, so 30 of 32 slots).
    const slots = church.services.flatMap((s) => s.slots);
    const plan = Array.from({ length: 30 }, (_, i) => ({ slot: slots[i], personId: church.memberIds[i] }));
    const assigned = await Promise.all(plan.map(({ slot, personId }, i) => (
      schedulers[i % 5].put(`/api/slots/${slot.id}/assign`, { personId }))));
    assert.deepEqual(assigned.map((r) => r.status), Array(30).fill(200));
    assert.equal(auditCount(db, 'slot.assign'), 30, 'one audit entry per assignment');

    const members = await Promise.all(plan.map((_, i) => loggedIn(client, `member${i + 1}`)));
    const answers = await Promise.all(plan.map(({ slot }, i) => (
      members[i].post(`/api/me/slots/${slot.id}/${i % 3 === 0 ? 'decline' : 'accept'}`))));
    assert.deepEqual(answers.map((r) => r.status), Array(30).fill(200));
    plan.forEach(({ slot }, i) => {
      const row = db.prepare('SELECT person_id, status FROM slots WHERE id = ?').get(slot.id);
      assert.equal(row.person_id, plan[i].personId);
      assert.equal(row.status, i % 3 === 0 ? 'declined' : 'accepted', `slot ${slot.id} kept its own answer`);
    });
    assert.equal(auditCount(db, 'slot.accept'), 20);
    assert.equal(auditCount(db, 'slot.decline'), 10);

    // Answering again with the same answer, all at once, changes nothing and logs nothing.
    const again = await Promise.all(plan.map(({ slot }, i) => (
      members[i].post(`/api/me/slots/${slot.id}/${i % 3 === 0 ? 'decline' : 'accept'}`))));
    assert.deepEqual(again.map((r) => r.status), Array(30).fill(200));
    assert.equal(auditCount(db, 'slot.accept') + auditCount(db, 'slot.decline'), 30);
    no500(client);
    healthy(db);
  } finally { await ctx.done(); }
});

test('stress: one member sends accept and decline for the same slot at once; the result matches the audit log', async () => {
  const ctx = await boot();
  try {
    const { church, client, db } = ctx;
    const sched = await loggedIn(client, 'sched1');
    const slot = church.services[0].slots[0];
    assert.equal((await sched.put(`/api/slots/${slot.id}/assign`, { personId: church.memberIds[0] })).status, 200);
    const member = await loggedIn(client, 'member1');
    const actions = ['accept', 'decline', 'accept', 'decline', 'accept', 'decline'];
    const res = await Promise.all(actions.map((a) => member.post(`/api/me/slots/${slot.id}/${a}`)));
    assert.deepEqual(res.map((r) => r.status), Array(actions.length).fill(200));
    const status = db.prepare('SELECT status FROM slots WHERE id = ?').get(slot.id).status;
    const last = db.prepare("SELECT detail FROM audit WHERE action IN ('slot.accept','slot.decline') ORDER BY id DESC LIMIT 1").get();
    assert.ok(last.detail.endsWith(`-> ${status}`), 'the newest audit entry describes the final state');
    // Every audit entry is a real change: each one starts from the state the previous one ended in.
    const trail = db.prepare("SELECT detail FROM audit WHERE action IN ('slot.accept','slot.decline') ORDER BY id").all()
      .map((r) => r.detail.match(/ (\w+) -> (\w+)$/).slice(1));
    let state = 'pending';
    for (const [from, to] of trail) {
      assert.equal(from, state);
      assert.notEqual(from, to);
      state = to;
    }
    assert.equal(state, status);
    no500(client);
    healthy(db);
  } finally { await ctx.done(); }
});

test('stress: two schedulers race to put the SAME person on one service: exactly one wins, no double booking', async () => {
  const ctx = await boot();
  try {
    const { church, client, db } = ctx;
    const [a, b] = await Promise.all([loggedIn(client, 'sched1'), loggedIn(client, 'sched2')]);
    let wins = 0;
    for (let round = 0; round < 8; round++) {
      const svc = church.services[round % 4];
      const personId = church.memberIds[40 + round];
      const [s1, s2] = [svc.slots[(round * 2) % 8], svc.slots[(round * 2 + 1) % 8]];
      const [r1, r2] = await Promise.all([
        a.put(`/api/slots/${s1.id}/assign`, { personId }),
        b.put(`/api/slots/${s2.id}/assign`, { personId }),
      ]);
      const statuses = [r1.status, r2.status].sort();
      assert.deepEqual(statuses, [200, 409], `round ${round}: one assignment, one refusal`);
      const loser = r1.status === 409 ? r1 : r2;
      assert.equal(loser.json.code, 'double_booked');
      wins++;
    }
    assert.equal(auditCount(db, 'slot.assign'), wins, 'only the winning assignments are in the audit log');
    no500(client);
    healthy(db);
  } finally { await ctx.done(); }
});

test('stress: 5 schedulers race to fill the SAME slot: one person holds it, every change is audited once', async () => {
  const ctx = await boot();
  try {
    const { church, client, db } = ctx;
    const schedulers = await Promise.all([1, 2, 3, 4, 5].map((i) => loggedIn(client, `sched${i}`)));
    const slot = church.services[1].slots[3];
    const candidates = church.memberIds.slice(50, 55);
    const res = await Promise.all(schedulers.map((s, i) => s.put(`/api/slots/${slot.id}/assign`, { personId: candidates[i] })));
    assert.deepEqual(res.map((r) => r.status), Array(5).fill(200));
    const row = db.prepare('SELECT person_id, status FROM slots WHERE id = ?').get(slot.id);
    assert.equal(row.status, 'pending');
    assert.ok(candidates.includes(row.person_id));
    // Each assignment is applied in turn: one audit entry each, and each one
    // (after the first) names the person it replaced, so nothing is silently lost.
    const trail = db.prepare("SELECT detail FROM audit WHERE action = 'slot.assign' AND detail LIKE ? ORDER BY id")
      .all(`slot ${slot.id} %`).map((r) => r.detail);
    assert.equal(trail.length, 5);
    assert.ok(!trail[0].includes('replacing'));
    for (const d of trail.slice(1)) assert.match(d, /replacing Member \d+ \(pending\)/);
    const holder = db.prepare('SELECT name FROM people WHERE id = ?').get(row.person_id).name;
    assert.match(trail.at(-1), new RegExp(`: ${holder}, replacing`), 'the last audit entry names the person who holds the slot');

    // Once the holder accepts, nobody else can take the slot, however many try at once.
    const holderIndex = church.memberIds.indexOf(row.person_id) + 1;
    const holderBrowser = await loggedIn(client, `member${holderIndex}`);
    assert.equal((await holderBrowser.post(`/api/me/slots/${slot.id}/accept`)).status, 200);
    const others = church.memberIds.slice(60, 65);
    const late = await Promise.all(schedulers.map((s, i) => s.put(`/api/slots/${slot.id}/assign`, { personId: others[i] })));
    assert.deepEqual(late.map((r) => [r.status, r.json.code]), Array(5).fill([409, 'accepted']));
    assert.equal(db.prepare('SELECT person_id FROM slots WHERE id = ?').get(slot.id).person_id, row.person_id);
    assert.equal(auditCount(db, 'slot.assign', `slot ${slot.id} %`), 5);
    no500(client);
    healthy(db);
  } finally { await ctx.done(); }
});

test('stress: two schedulers edit the same person at once (name and role): neither change is lost', async () => {
  const ctx = await boot();
  try {
    const { church, client, db } = ctx;
    const [a, b] = await Promise.all([loggedIn(client, 'sched1'), loggedIn(client, 'sched2')]);
    const results = [];
    for (let i = 0; i < 10; i++) {
      const id = church.memberIds[i];
      results.push(...await Promise.all([
        a.patch(`/api/people/${id}`, { name: `Renamed ${i}` }),
        b.patch(`/api/people/${id}`, { role: 'admin' }),
      ]));
      const row = db.prepare('SELECT name, role FROM people WHERE id = ?').get(id);
      assert.deepEqual({ ...row }, { name: `Renamed ${i}`, role: 'admin' });
    }
    assert.deepEqual(results.map((r) => r.status), Array(20).fill(200));
    assert.equal(auditCount(db, 'person.update'), 20, 'one audit entry per change');
    no500(client);
    healthy(db);
  } finally { await ctx.done(); }
});

test('stress: simultaneous resets: one audit entry each, exactly one invite can be claimed', async () => {
  const ctx = await boot();
  try {
    const { church, client, db } = ctx;
    const schedulers = await Promise.all([1, 2, 3, 4, 5].map((i) => loggedIn(client, `sched${i}`)));
    const victim = await loggedIn(client, 'member7');
    const id = church.memberIds[6];
    const res = await Promise.all(schedulers.map((s) => s.post(`/api/people/${id}/reset-password`)));
    assert.deepEqual(res.map((r) => r.status), Array(5).fill(200));
    assert.equal(auditCount(db, 'person.reset_password', `person ${id}`), 5);
    assert.equal((await victim.get('/api/me')).status, 401, 'the old session ended');

    const tokens = res.map((r) => tokenFromLink(r.json.invite.link));
    assert.equal(new Set(tokens).size, 5, 'every reset made a new invite');
    let working = 0;
    for (const token of tokens) {
      const r = await client.browser().welcome(token, 'member7 own password');
      if (r.status === 200) {
        working++;
        assert.equal(r.json.person.hasPassword, true);
      }
    }
    assert.equal(working, 1, 'only the last reset counts');

    // Resetting 20 different people at once: 20 audit entries, 20 usable invites.
    const ids = church.memberIds.slice(10, 30);
    const many = await Promise.all(ids.map((pid, i) => schedulers[i % 5].post(`/api/people/${pid}/reset-password`)));
    assert.deepEqual(many.map((r) => r.status), Array(20).fill(200));
    const logins = await Promise.all(many.map((r) => client.browser().welcome(tokenFromLink(r.json.invite.link), 'my own password 1')));
    assert.deepEqual(logins.map((r) => r.status), Array(20).fill(200));
    assert.equal(auditCount(db, 'person.reset_password'), 25);
    no500(client);
    healthy(db);
  } finally { await ctx.done(); }
});

test('stress: 30 members add and remove blockouts at once; one member adds 10 at once; nothing is lost', async () => {
  const ctx = await boot();
  try {
    const { client, db, church } = ctx;
    const members = await Promise.all(Array.from({ length: 30 }, (_, i) => loggedIn(client, `member${i + 1}`)));
    const added = await Promise.all(members.flatMap((m, i) => [
      m.post('/api/me/blockouts', { startDate: '2025-01-19', endDate: '2025-01-19', reason: `Trip ${i}` }),
      m.post('/api/me/blockouts', { startDate: '2025-02-02', reason: `Visit ${i}` }),
    ]));
    assert.deepEqual(added.map((r) => r.status), Array(60).fill(201));
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM blockouts').get().n), 60);

    // Each removes their first blockout while another member adds one, all at once.
    const firstIds = added.filter((_, k) => k % 2 === 0).map((r) => r.json.blockout.id);
    const mixed = await Promise.all(members.flatMap((m, i) => [
      m.del(`/api/me/blockouts/${firstIds[i]}`),
      m.del(`/api/me/blockouts/${firstIds[(i + 1) % 30]}`), // someone else's: refused
    ]));
    assert.deepEqual(mixed.map((r) => r.status), Array.from({ length: 60 }, (_, k) => (k % 2 === 0 ? 200 : 404)));
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM blockouts').get().n), 30);
    assert.deepEqual(
      db.prepare('SELECT person_id, COUNT(*) AS n FROM blockouts GROUP BY person_id').all().map((r) => r.n),
      Array(30).fill(1), 'everyone kept exactly their second blockout');

    const busy = members[0];
    const ten = await Promise.all(Array.from({ length: 10 }, (_, d) => busy.post('/api/me/blockouts', { startDate: `2025-03-${String(d + 10)}` })));
    assert.deepEqual(ten.map((r) => r.status), Array(10).fill(201));
    assert.equal((await busy.get('/api/me/blockouts')).json.blockouts.length, 11);
    // Blocked people are refused by the scheduler, even while blockouts arrive.
    const sched = await loggedIn(client, 'sched1');
    const slot = church.services[3].slots[0]; // 2025-02-02: member2 kept that blockout (Visit)
    const blocked = await sched.put(`/api/slots/${slot.id}/assign`, { personId: church.memberIds[1] });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, 'blocked');
    no500(client);
    healthy(db);
  } finally { await ctx.done(); }
});

test('stress: everything at once, then the database is intact and the audit log matches the changes', async () => {
  const ctx = await boot();
  try {
    const { church, client, db } = ctx;
    const schedulers = await Promise.all([1, 2, 3, 4, 5].map((i) => loggedIn(client, `sched${i}`)));
    const members = await Promise.all(Array.from({ length: 40 }, (_, i) => loggedIn(client, `member${i + 1}`)));
    const slots = church.services.flatMap((s) => s.slots);
    const before = Number(db.prepare('SELECT COUNT(*) AS n FROM audit').get().n);

    // Wave 1: schedulers fill every slot (several people per slot compete),
    // members add blockouts and read their schedules, all interleaved.
    const wave1 = await Promise.all([
      ...slots.map((slot, i) => schedulers[i % 5].put(`/api/slots/${slot.id}/assign`, { personId: church.memberIds[i % 40] })),
      ...slots.map((slot, i) => schedulers[(i + 1) % 5].put(`/api/slots/${slot.id}/assign`, { personId: church.memberIds[(i * 7) % 40] })),
      ...members.map((m, i) => m.post('/api/me/blockouts', { startDate: '2025-03-01', endDate: '2025-03-02', reason: `Away ${i}` })),
      ...members.map((m) => m.get('/api/me/schedule')),
      ...schedulers.map((s) => s.get('/api/admin/gaps?from=2025-01-05&to=2025-02-28')),
    ]);
    assert.ok(wave1.every((r) => [200, 201, 409].includes(r.status)), 'only success or a clear conflict');

    // Wave 2: everyone holding a slot answers it, while schedulers reset passwords
    // of people who hold nothing (their sessions end, nothing else changes).
    const held = db.prepare("SELECT s.id, p.username FROM slots s JOIN people p ON p.id = s.person_id WHERE s.status = 'pending'").all();
    const byName = new Map(members.map((m, i) => [`member${i + 1}`, m]));
    const wave2 = await Promise.all([
      ...held.map((h, i) => byName.get(h.username).post(`/api/me/slots/${h.id}/${i % 2 ? 'decline' : 'accept'}`)),
      ...church.memberIds.slice(60, 70).map((id, i) => schedulers[i % 5].post(`/api/people/${id}/reset-password`)),
    ]);
    assert.ok(wave2.every((r) => r.status === 200));

    const successes = (method, re) => client.responses.filter((r) => r.method === method && re.test(r.path) && r.status === 200).length;
    const after = Number(db.prepare('SELECT COUNT(*) AS n FROM audit').get().n);
    const expected = successes('PUT', /\/assign$/) + held.length + 10; // assignments + answers + resets
    assert.equal(after - before, expected, 'exactly one audit entry per change, none for reads or refusals');
    assert.equal(auditCount(db, 'slot.accept') + auditCount(db, 'slot.decline'), held.length);
    no500(client);
    healthy(db);
  } finally { await ctx.done(); }
});
