import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { startTestApp } from './helpers/app.js';
import { addPerson, loginAs, seedAdminAndMember } from './helpers/seed.js';

const X = { 'X-Flock': '1' };

async function boot(opts = {}) {
  const db = openDb();
  let t = new Date('2025-01-05T12:00:00Z').getTime();
  const clock = { advance(ms) { t += ms; } };
  const app = await startTestApp({
    db,
    now: () => new Date(t),
    setup: (a) => {
      a.router.add('GET', '/api/test-admin', () => ({ status: 200, json: { ok: true } }), { auth: 'admin' });
      a.router.add('GET', '/api/test-login', () => ({ status: 200, json: { ok: true } }));
      a.router.add('POST', '/api/test-post', () => ({ status: 200, json: { ok: true } }));
    },
    ...opts,
  });
  return { app, db, clock };
}

const login = (app, username, password, headers = {}) =>
  app.request('POST', '/api/login', { body: { username, password }, headers: { ...X, ...headers } });

test('login success sets cookie with flags and returns person', async () => {
  const { app, db } = await boot();
  try {
    await addPerson(db, { name: 'Ann Example', username: 'ann' });
    const r = await login(app, 'ann', 'test-pass-1');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json.person).sort(), ['id', 'name', 'role']);
    const c = r.headers['set-cookie'][0];
    assert.match(c, /^flock_session=[A-Za-z0-9_-]{43};/);
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Lax/);
    assert.match(c, /Path=\//);
    assert.match(c, /Max-Age=1209600/);
    assert.doesNotMatch(c, /Secure/);
  } finally { await app.close(); }
});

test('Secure flag with secureCookies or X-Forwarded-Proto', async () => {
  const { app, db } = await boot({ config: { ...loadConfig({}), secureCookies: true } });
  const b = await boot();
  try {
    await addPerson(db, { name: 'Ann', username: 'ann' });
    const r = await login(app, 'ann', 'test-pass-1');
    assert.match(r.headers['set-cookie'][0], /; Secure/);
    await addPerson(b.db, { name: 'Ann', username: 'ann' });
    const r2 = await login(b.app, 'ann', 'test-pass-1', { 'X-Forwarded-Proto': 'https' });
    assert.match(r2.headers['set-cookie'][0], /; Secure/);
  } finally { await app.close(); await b.app.close(); }
});

test('wrong password, unknown user and inactive give the same 401', async () => {
  const { app, db } = await boot();
  try {
    await addPerson(db, { name: 'Ann', username: 'ann' });
    await addPerson(db, { name: 'Gone', username: 'gone', active: false });
    const a = await login(app, 'ann', 'nope-nope');
    const b = await login(app, 'nobody', 'nope-nope');
    const c = await login(app, 'gone', 'test-pass-1');
    for (const r of [a, b, c]) {
      assert.equal(r.status, 401);
      assert.deepEqual(r.json, { error: 'Wrong username or password' });
      assert.equal(r.headers['set-cookie'], undefined);
    }
  } finally { await app.close(); }
});

test('lockout after 5 wrong tries gives 429', async () => {
  const { app, db } = await boot();
  try {
    await addPerson(db, { name: 'Ann', username: 'ann' });
    for (let i = 0; i < 5; i++) assert.equal((await login(app, 'ann', 'bad-bad-bad')).status, 401);
    const r = await login(app, 'ann', 'test-pass-1');
    assert.equal(r.status, 429);
    assert.equal(r.json.error, 'Too many tries. Please wait a few minutes.');
  } finally { await app.close(); }
});

test('per-IP throttle: 20 attempts per 5 minutes', async () => {
  const { app, clock } = await boot();
  try {
    for (let i = 0; i < 20; i++) assert.equal((await login(app, `u${i}`, 'whatever1')).status, 401);
    assert.equal((await login(app, 'u99', 'whatever1')).status, 429);
    clock.advance(5 * 60 * 1000 + 1000);
    assert.equal((await login(app, 'u99', 'whatever1')).status, 401);
  } finally { await app.close(); }
});

test('logout invalidates the cookie and clears it', async () => {
  const { app, db } = await boot();
  try {
    await addPerson(db, { name: 'Ann', username: 'ann' });
    const cookie = await loginAs(app, 'ann');
    assert.equal((await app.request('GET', '/api/me', { cookie })).status, 200);
    const out = await app.request('POST', '/api/logout', { cookie, headers: X });
    assert.equal(out.status, 200);
    assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
    const r = await app.request('GET', '/api/me', { cookie });
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: 'Please log in' });
  } finally { await app.close(); }
});

test('GET /api/me returns the person; no hash or token in bodies', async () => {
  const { app, db } = await boot();
  try {
    await addPerson(db, { name: 'Ann', username: 'ann' });
    const lr = await login(app, 'ann', 'test-pass-1');
    const cookie = lr.headers['set-cookie'][0].split(';')[0];
    const token = cookie.split('=')[1];
    const me = await app.request('GET', '/api/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.json.person.username, 'ann');
    const pw = await app.request('POST', '/api/password', { cookie, headers: X, body: { oldPassword: 'x', newPassword: 'y' } });
    for (const r of [lr, me, pw]) {
      assert.doesNotMatch(r.text, /scrypt|password_hash|passwordHash/);
      assert.ok(!r.text.includes(token));
    }
  } finally { await app.close(); }
});

test('password change flow keeps this session and kills others', async () => {
  const { app, db } = await boot();
  try {
    await addPerson(db, { name: 'Ann', username: 'ann' });
    const c1 = await loginAs(app, 'ann');
    const c2 = await loginAs(app, 'ann');
    const bad = await app.request('POST', '/api/password', { cookie: c1, headers: X, body: { oldPassword: 'wrong-one', newPassword: 'brand-new-pw' } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /current password/);
    const short = await app.request('POST', '/api/password', { cookie: c1, headers: X, body: { oldPassword: 'test-pass-1', newPassword: 'short' } });
    assert.equal(short.status, 400);
    assert.match(short.json.error, /at least 8/);
    const ok = await app.request('POST', '/api/password', { cookie: c1, headers: X, body: { oldPassword: 'test-pass-1', newPassword: 'brand-new-pw' } });
    assert.deepEqual([ok.status, ok.json], [200, { ok: true }]);
    assert.equal((await app.request('GET', '/api/me', { cookie: c1 })).status, 200);
    assert.equal((await app.request('GET', '/api/me', { cookie: c2 })).status, 401);
    assert.equal((await login(app, 'ann', 'test-pass-1')).status, 401);
    assert.equal((await login(app, 'ann', 'brand-new-pw')).status, 200);
  } finally { await app.close(); }
});

test('people without passwords cannot log in or gain sessions', async () => {
  const { app, db } = await boot();
  try {
    const id = await addPerson(db, { name: 'New', username: 'newbie', password: null });
    const lr = await login(app, 'newbie', 'test-pass-1');
    assert.deepEqual([lr.status, lr.json], [401, { error: 'Wrong username or password' }]);
    assert.equal(lr.headers['set-cookie'], undefined);
    assert.equal(db.prepare('SELECT failed_logins FROM people WHERE id = ?').get(id).failed_logins, 0);
    assert.equal((await app.request('GET', '/api/test-login')).status, 401);
  } finally { await app.close(); }
});

test('CSRF header required on non-GET requests except login', async () => {
  const { app, db } = await boot();
  try {
    await addPerson(db, { name: 'Ann', username: 'ann' });
    const cookie = await loginAs(app, 'ann');
    const r = await app.request('POST', '/api/test-post', { cookie });
    assert.deepEqual([r.status, r.json], [403, { error: 'Request not allowed' }]);
    assert.equal((await app.request('POST', '/api/logout', { cookie })).status, 403);
    assert.equal((await app.request('POST', '/api/test-post', { cookie, headers: { 'X-Flock': '0' } })).status, 403);
    assert.equal((await app.request('POST', '/api/test-post', { cookie, headers: X })).status, 200);
    // login itself does not need the header
    const l = await app.request('POST', '/api/login', { body: { username: 'ann', password: 'test-pass-1' } });
    assert.equal(l.status, 200);
  } finally { await app.close(); }
});

test('login-level and admin-level routes', async () => {
  const { app, db } = await boot();
  try {
    const { adminCookie, memberCookie } = await seedAdminAndMember(app, db);
    assert.deepEqual((await app.request('GET', '/api/test-admin')).json, { error: 'Please log in' });
    assert.equal((await app.request('GET', '/api/test-admin')).status, 401);
    assert.equal((await app.request('GET', '/api/test-login')).status, 401);
    const m = await app.request('GET', '/api/test-admin', { cookie: memberCookie });
    assert.deepEqual([m.status, m.json], [403, { error: 'Only the scheduler can do that' }]);
    assert.equal((await app.request('GET', '/api/test-admin', { cookie: adminCookie })).status, 200);
    assert.equal((await app.request('GET', '/api/test-login', { cookie: memberCookie })).status, 200);
    assert.equal((await app.request('GET', '/api/health')).status, 200);
  } finally { await app.close(); }
});

test('per-IP throttle: successful logins do not count', async () => {
  const { app, db } = await boot();
  try {
    await addPerson(db, { name: 'Ann', username: 'ann' });
    for (let i = 0; i < 31; i++) assert.equal((await login(app, 'ann', 'test-pass-1')).status, 200);
  } finally { await app.close(); }
});

test('per-IP throttle: failures over the limit are throttled', async () => {
  const { app } = await boot();
  try {
    for (let i = 0; i < 20; i++) assert.equal((await login(app, `f${i}`, 'whatever1')).status, 401);
    assert.equal((await login(app, 'f99', 'whatever1')).status, 429);
  } finally { await app.close(); }
});

test('proxy headers are ignored when FLOCK_TRUST_PROXY is off', async () => {
  const { app } = await boot();
  try {
    for (let i = 0; i < 20; i++) await login(app, `s${i}`, 'whatever1', { 'Fly-Client-IP': `9.9.9.${i}` });
    assert.equal((await login(app, 's99', 'whatever1', { 'X-Forwarded-For': '8.8.8.8' })).status, 429);
  } finally { await app.close(); }
});

test('proxy headers are honoured when FLOCK_TRUST_PROXY is on, per IP', async () => {
  const config = { ...loadConfig({ FLOCK_TRUST_PROXY: '1' }), dbPath: ':memory:' };
  const { app } = await boot({ config });
  try {
    for (let i = 0; i < 20; i++) assert.equal((await login(app, `p${i}`, 'whatever1', { 'Fly-Client-IP': '1.1.1.1', 'X-Forwarded-For': '5.5.5.5' })).status, 401);
    assert.equal((await login(app, 'p99', 'whatever1', { 'Fly-Client-IP': '1.1.1.1' })).status, 429);
    assert.equal((await login(app, 'p99', 'whatever1', { 'Fly-Client-IP': '2.2.2.2' })).status, 401);
    // no Fly header: first X-Forwarded-For entry
    assert.equal((await login(app, 'p99', 'whatever1', { 'X-Forwarded-For': '3.3.3.3, 10.0.0.1' })).status, 401);
    for (let i = 0; i < 19; i++) await login(app, `q${i}`, 'whatever1', { 'X-Forwarded-For': '3.3.3.3' });
    assert.equal((await login(app, 'q99', 'whatever1', { 'X-Forwarded-For': '3.3.3.3, 10.9.9.9' })).status, 429);
    assert.equal((await login(app, 'q99', 'whatever1', { 'X-Forwarded-For': '4.4.4.4' })).status, 401);
  } finally { await app.close(); }
});
