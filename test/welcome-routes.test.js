import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/app.js';
import { seedAdminAndMember } from './helpers/seed.js';
import { createClient, tokenFromLink } from './helpers/client.js';
import { fixedClock } from '../src/infra/clock.js';
import { loadConfig } from '../src/config.js';
import { INVITE_GONE_MESSAGE } from '../src/services/auth-service.js';

async function setup(t, env = {}) {
  const clock = fixedClock('2025-03-02T09:00:00.000Z');
  const app = await startTestApp({ config: loadConfig(env), container: { clock } });
  t.after(() => app.close());
  const seeded = await seedAdminAndMember(app);
  const client = createClient(app);
  return { app, clock, client, admin: client.browser(seeded.adminCookie), member: client.browser(seeded.memberCookie), ...seeded };
}
const makeInvite = async (s) => {
  const result = await s.admin.post('/api/people', { name: 'Pat Smith', email: 'pat.smith@example.com' });
  assert.equal(result.status, 201);
  return result.json;
};

test('welcome routes: new people receive a local, fragment-only invite with no password', async (t) => {
  const s = await setup(t);
  const created = await makeInvite(s);
  assert.match(created.invite.link, /^http:\/\/127\.0\.0\.1:\d+\/#\/welcome\?token=[A-Za-z0-9_-]{43}$/);
  assert.equal(created.invite.localOnly, true);
  assert.equal(created.person.joined, false);
  assert.deepEqual(Object.keys(created.invite), ['link', 'expiresAt', 'localOnly']);
  assert.equal(new URL(created.invite.link).search, '');
});

test('welcome routes: FLOCK_PUBLIC_URL supplies the shared address, even behind a proxy', async (t) => {
  const s = await setup(t, { FLOCK_PUBLIC_URL: 'https://flock.example.org///', FLOCK_SECURE_COOKIES: '1' });
  const created = await makeInvite(s);
  assert.ok(created.invite.link.startsWith('https://flock.example.org/#/welcome?token='));
  assert.equal(created.invite.localOnly, false);
  const guest = s.client.browser();
  const accepted = await guest.welcome(tokenFromLink(created.invite.link), 'my password 1');
  assert.equal(accepted.status, 200);
  assert.match(accepted.headers['set-cookie'][0], /HttpOnly; SameSite=Lax; Path=\//);
  assert.match(accepted.headers['set-cookie'][0], /; Secure/);
});

test('welcome routes: localhost and IPv6 loopback receive the local-only warning', async (t) => {
  const s = await setup(t);
  const created = await makeInvite(s);
  for (const host of ['localhost:8080', '[::1]:8080']) {
    const result = await s.admin.post(`/api/people/${created.person.id}/invite`, {}, { headers: { Host: host } });
    assert.equal(result.status, 200);
    assert.equal(result.json.invite.localOnly, true);
    assert.ok(result.json.invite.link.startsWith(`http://${host}/#/welcome?token=`));
  }
});

test('welcome routes: checking greets the person; claiming logs them in and consumes the link', async (t) => {
  const s = await setup(t);
  const created = await makeInvite(s);
  const token = tokenFromLink(created.invite.link);
  const guest = s.client.browser();
  const checked = await guest.post('/api/welcome/check', { token });
  assert.deepEqual([checked.status, checked.json], [200, { name: 'Pat Smith', email: 'pat.smith@example.com' }]);
  const accepted = await guest.welcome(token, 'my password 1');
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.person.id, created.person.id);
  assert.equal(accepted.json.person.hasPassword, true);
  assert.equal((await guest.get('/api/me')).status, 200);
  for (const path of ['/api/welcome/check', '/api/welcome']) {
    const gone = await guest.post(path, { token, password: 'another password' });
    assert.deepEqual([gone.status, gone.json], [404, { error: INVITE_GONE_MESSAGE }]);
  }
});

test('welcome routes: expired links, malformed tokens and non-POST requests cannot claim an account', async (t) => {
  const s = await setup(t);
  const created = await makeInvite(s);
  const guest = s.client.browser();
  s.clock.advance(7 * 86400000);
  for (const token of [tokenFromLink(created.invite.link), '', null, 7, '!'.repeat(43)]) {
    for (const path of ['/api/welcome/check', '/api/welcome']) {
      const r = await guest.post(path, { token, password: 'my password 1' });
      assert.deepEqual([r.status, r.json], [404, { error: INVITE_GONE_MESSAGE }]);
    }
  }
  assert.equal((await guest.get('/api/welcome/check')).status, 405);
  assert.equal((await guest.get('/api/welcome')).status, 405);
  assert.equal((await guest.get('/api/me')).status, 401);
});

test('welcome routes: X-Flock is required even though the welcome routes are public', async (t) => {
  const s = await setup(t);
  const created = await makeInvite(s);
  const guest = s.client.browser();
  const body = { token: tokenFromLink(created.invite.link), password: 'my password 1' };
  for (const path of ['/api/welcome/check', '/api/welcome']) {
    const r = await guest.post(path, body, { csrf: false });
    assert.deepEqual([r.status, r.json], [403, { error: 'Request not allowed' }]);
  }
  assert.equal((await guest.welcome(body.token, body.password)).status, 200);
});

test('welcome routes: twenty failures share one throttle; login uses a different throttle', async (t) => {
  const s = await setup(t);
  const guest = s.client.browser();
  for (let i = 0; i < 20; i++) {
    assert.equal((await guest.post(i % 2 ? '/api/welcome' : '/api/welcome/check', { token: 'bad', password: 'my password 1' })).status, 404);
  }
  assert.equal((await guest.post('/api/welcome/check', { token: 'bad' })).status, 429);
  assert.equal((await guest.post('/api/welcome', { token: 'bad', password: 'my password 1' })).status, 429);
  assert.equal((await guest.login('ada@example.com', 'test-pass-1')).status, 200, 'welcome failures do not block login');
  s.clock.advance(5 * 60 * 1000 + 1);
  assert.equal((await guest.post('/api/welcome/check', { token: 'bad' })).status, 404);
});

test('welcome routes: successful checks do not count; weak passwords do not consume an invite', async (t) => {
  const s = await setup(t);
  const created = await makeInvite(s);
  const token = tokenFromLink(created.invite.link);
  const guest = s.client.browser();
  for (let i = 0; i < 30; i++) assert.equal((await guest.post('/api/welcome/check', { token })).status, 200);
  assert.equal((await guest.welcome(token, 'short')).status, 400);
  assert.equal((await guest.welcome(token, 'my password 1')).status, 200);
});

test('welcome routes: only schedulers can reinvite unjoined people; reset ends old cookies', async (t) => {
  const s = await setup(t);
  const created = await makeInvite(s);
  assert.equal((await s.member.post(`/api/people/${created.person.id}/invite`, {})).status, 403);
  assert.equal((await s.admin.post(`/api/people/${s.memberId}/invite`, {})).status, 400, 'joined people need a reset');
  const fresh = await s.admin.post(`/api/people/${created.person.id}/invite`, {});
  const guest = s.client.browser();
  assert.equal((await guest.welcome(tokenFromLink(created.invite.link), 'my password 1')).status, 404);
  assert.equal((await guest.welcome(tokenFromLink(fresh.json.invite.link), 'my password 1')).status, 200);
  const reset = await s.admin.post(`/api/people/${created.person.id}/reset-login`, {});
  assert.equal(reset.status, 200);
  assert.equal((await guest.get('/api/me')).status, 401);
  assert.equal((await guest.login('pat.smith@example.com', 'my password 1')).status, 401);
  assert.equal((await guest.welcome(tokenFromLink(reset.json.invite.link), 'my new password')).status, 200);
});
