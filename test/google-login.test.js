// Google sign-in and logging in with an email (decision 0006).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, validateConfig, ConfigError } from '../src/config.js';
import { googleOAuth, TOKEN_URL } from '../src/infra/google.js';
import { startTestApp } from './helpers/app.js';
import { addPerson } from './helpers/seed.js';

const X = { 'X-Flock': '1' };
const NOW = new Date('2025-01-05T12:00:00Z');
const CLIENT = 'cid.apps.googleusercontent.com';
const idToken = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const good = (email, extra = {}) => ({
  aud: CLIENT, iss: 'https://accounts.google.com', exp: NOW.getTime() / 1000 + 300, email, email_verified: true, ...extra,
});

// Google answers every code with these claims; calls are recorded.
function fakeGoogle(claimsFor) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: new URLSearchParams(init.body) });
    const claims = claimsFor(new URLSearchParams(init.body).get('code'));
    if (!claims) return { ok: false, status: 400, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ id_token: idToken(claims) }) };
  };
  return { calls, google: googleOAuth({ clientId: CLIENT, clientSecret: 'shh', fetch }) };
}

async function boot(claimsFor = () => null) {
  const fake = fakeGoogle(claimsFor);
  const t = await startTestApp({ now: () => NOW, container: { google: fake.google } });
  return { ...t, calls: fake.calls };
}

// Start at /api/auth/google, then come back from "Google" with a code.
async function signIn(t, code, { tamperState = false } = {}) {
  const start = await t.request('GET', '/api/auth/google', { headers: { Host: 'localhost:8080' } });
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.location);
  const state = loc.searchParams.get('state');
  const cookie = start.headers['set-cookie'][0].split(';')[0];
  const q = new URLSearchParams({ code, state: tamperState ? state.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) : state });
  return t.request('GET', `/api/auth/google/callback?${q}`, { cookie, headers: { Host: 'localhost:8080' } });
}
const sessionOf = (res) => (res.headers['set-cookie'] ?? []).find((c) => c.startsWith('flock_session=') && !c.startsWith('flock_session=;'));

test('config: Google needs both id and secret, or neither', () => {
  assert.equal(loadConfig({}).googleClientId, undefined);
  const c = loadConfig({ FLOCK_GOOGLE_CLIENT_ID: ' id ', FLOCK_GOOGLE_CLIENT_SECRET: 's' });
  assert.equal(c.googleClientId, 'id');
  assert.throws(() => validateConfig({ ...loadConfig({}), googleClientId: 'id' }), ConfigError);
});

test('options: the Google button only shows when it is set up', async () => {
  const off = await startTestApp();
  const on = await boot();
  try {
    assert.deepEqual((await off.request('GET', '/api/auth/options')).json, { google: false });
    assert.equal((await off.request('GET', '/api/auth/google')).status, 404);
    assert.deepEqual((await on.request('GET', '/api/auth/options')).json, { google: true });
  } finally { await off.close(); await on.close(); }
});

test('start: redirects to Google with state, and the same state in a short HttpOnly cookie', async () => {
  const t = await boot();
  try {
    const r = await t.request('GET', '/api/auth/google', { headers: { Host: 'localhost:8080' } });
    const u = new URL(r.headers.location);
    assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(u.searchParams.get('client_id'), CLIENT);
    assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:8080/api/auth/google/callback');
    assert.equal(u.searchParams.get('scope'), 'openid email');
    const c = r.headers['set-cookie'][0];
    assert.match(c, new RegExp(`^flock_google_state=${u.searchParams.get('state')}; HttpOnly; SameSite=Lax; Path=/api/auth/google; Max-Age=600`));
  } finally { await t.close(); }
});

test('a known, active email logs in; the code is exchanged with our secret', async () => {
  const t = await boot((code) => (code === 'c1' ? good('Ann@Example.com') : null));
  try {
    const id = await addPerson(t, { name: 'Ann', username: 'ann' });
    await t.data.people.update(id, { email: 'ann@example.com' });
    const r = await signIn(t, 'c1');
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/#/');
    const s = sessionOf(r);
    assert.ok(s, 'session cookie set');
    assert.equal(t.calls[0].url, TOKEN_URL);
    assert.equal(t.calls[0].body.get('client_secret'), 'shh');
    assert.equal(t.calls[0].body.get('redirect_uri'), 'http://localhost:8080/api/auth/google/callback');
    const me = await t.request('GET', '/api/me', { cookie: s.split(';')[0] });
    assert.equal(me.json.person.id, id);
  } finally { await t.close(); }
});

test('someone who never joined joins through Google: no password needed, invite used up', async () => {
  const t = await boot(() => good('new@example.com'));
  try {
    const id = await addPerson(t, { name: 'New', username: 'new', password: null });
    await t.data.people.update(id, { email: 'new@example.com' });
    await t.data.invites.replace({ personId: id, tokenHash: 'a'.repeat(64), expiresAt: '2025-02-01T00:00:00.000Z', createdAt: NOW.toISOString() });
    const r = await signIn(t, 'c');
    assert.ok(sessionOf(r));
    assert.equal((await t.data.people.findById(id)).hasPassword, true);
    assert.equal(await t.data.invites.findByTokenHash('a'.repeat(64)), null);
  } finally { await t.close(); }
});

test('refused, always with the same answer: unknown, unverified, deactivated, wrong audience, bad state, Google error', async () => {
  const claims = {
    unknown: good('stranger@example.com'),
    unverified: good('ann@example.com', { email_verified: false }),
    aud: good('ann@example.com', { aud: 'someone-else' }),
    expired: good('ann@example.com', { exp: NOW.getTime() / 1000 - 1 }),
    ok: good('ann@example.com'),
    off: good('off@example.com'),
  };
  const t = await boot((code) => claims[code] ?? null);
  try {
    const ann = await addPerson(t, { name: 'Ann', username: 'ann' });
    await t.data.people.update(ann, { email: 'ann@example.com' });
    const off = await addPerson(t, { name: 'Off', username: 'off', active: false });
    await t.data.people.update(off, { email: 'off@example.com' });
    const cases = [
      ['unknown', {}, 'failed'], ['unverified', {}, 'failed'], ['off', {}, 'failed'],
      ['aud', {}, 'failed'], ['expired', {}, 'failed'], ['nope', {}, 'failed'],
      ['ok', { tamperState: true }, 'failed'],
    ];
    for (const [code, opts, why] of cases) {
      const r = await signIn(t, code, opts);
      assert.equal(r.status, 302, code);
      assert.equal(r.headers.location, `/#/login?google=${why}`, code);
      assert.equal(sessionOf(r), undefined, `${code} must not log in`);
    }
    // No state cookie at all.
    const r = await t.request('GET', '/api/auth/google/callback?code=ok&state=x');
    assert.equal(r.headers.location, '/#/login?google=failed');
  } finally { await t.close(); }
});

test('password login also accepts the email', async () => {
  const t = await startTestApp();
  try {
    const id = await addPerson(t, { name: 'Ann', username: 'ann' });
    await t.data.people.update(id, { email: 'ann@example.com' });
    const ok = await t.request('POST', '/api/login', { body: { username: ' ANN@example.com ', password: 'test-pass-1' }, headers: X });
    assert.equal(ok.status, 200);
    const bad = await t.request('POST', '/api/login', { body: { username: 'ann@example.com', password: 'wrong-pass' }, headers: X });
    assert.equal(bad.status, 401);
  } finally { await t.close(); }
});

test('admins set, change, clear and validate emails; duplicates are refused', async () => {
  const t = await startTestApp();
  try {
    await addPerson(t, { name: 'Boss', username: 'boss', role: 'admin' });
    const login = await t.request('POST', '/api/login', { body: { username: 'boss', password: 'test-pass-1' }, headers: X });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const call = (m, p, body) => t.request(m, p, { body, cookie, headers: X });
    const a = await call('POST', '/api/people', { name: 'Ann', email: 'Ann@Example.com' });
    assert.equal(a.status, 201);
    assert.equal(a.json.person.email, 'ann@example.com');
    assert.equal((await call('POST', '/api/people', { name: 'Bob', email: 'not-an-email' })).status, 400);
    const dup = await call('POST', '/api/people', { name: 'Bob', email: 'ann@example.com' });
    assert.equal(dup.status, 409);
    assert.match(dup.json.error, /email/);
    const id = a.json.person.id;
    assert.equal((await call('PATCH', `/api/people/${id}`, { email: 'ann2@example.com' })).json.person.email, 'ann2@example.com');
    assert.equal((await call('PATCH', `/api/people/${id}`, { email: '' })).json.person.email, null);
    assert.equal((await call('PATCH', `/api/people/${id}`, { email: 5 })).status, 400);
  } finally { await t.close(); }
});
