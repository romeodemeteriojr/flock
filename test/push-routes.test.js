// Turning notifications on and off per device, the test button, and every way a
// device is forgotten (decision 0008). A fake push sender stands in for the push
// services; nothing touches the network. Made-up people only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/app.js';
import { addPerson } from './helpers/seed.js';
import { createClient, cookieFrom } from './helpers/client.js';
import { loadConfig } from '../src/config.js';
import { fixedClock } from '../src/infra/clock.js';
import { createLogger } from '../src/infra/logger.js';
import { MAX_DEVICES } from '../src/services/notifications-service.js';
import { fakePush, subscription } from './helpers/push.js';

const NOW = '2026-11-12T09:00:00.000Z';

async function boot({ push = fakePush(), logLines } = {}) {
  const clock = fixedClock(new Date(NOW));
  const extra = { clock, push };
  if (logLines) extra.logger = createLogger({ level: 'debug', clock, write: (l) => logLines.push(l) });
  const t = await startTestApp({ config: loadConfig({ FLOCK_PUBLIC_URL: 'https://flock.example.org' }), container: extra });
  const ada = await addPerson(t, { name: 'Ada Admin', email: 'ada@example.com', role: 'admin' });
  const max = await addPerson(t, { name: 'Max Member', email: 'max@example.com' });
  const client = createClient(t);
  const as = async (email) => { const b = client.browser(); await b.login(email, 'test-pass-1'); return b; };
  return { t, push, clock, ada, max, admin: await as('ada@example.com'), member: await as('max@example.com'), as };
}

const devicesOf = (t, personId) => t.data.pushDevices.listForPerson(personId);

test('push off: settings say so and turning on is refused', async () => {
  const s = await boot({ push: fakePush({ enabled: false }) });
  try {
    assert.deepEqual((await s.member.get('/api/push')).json, { enabled: false, publicKey: null });
    const r = await s.member.post('/api/me/push/on', subscription());
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'push_off');
  } finally { await s.t.close(); }
});

test('turning on saves this device; bad devices, strangers and missing headers are refused', async () => {
  const s = await boot();
  try {
    assert.deepEqual((await s.member.get('/api/push')).json, { enabled: true, publicKey: 'BTestPublicKey' });
    const sub = subscription();
    assert.deepEqual((await s.member.post('/api/me/push/on', sub)).json, { on: true });
    assert.deepEqual((await devicesOf(s.t, s.max)).map((d) => [d.endpoint, d.p256dh, d.auth]), [[sub.endpoint, sub.keys.p256dh, sub.keys.auth]]);
    // The same device again is a refresh, not a second device.
    await s.member.post('/api/me/push/on', sub);
    assert.equal((await devicesOf(s.t, s.max)).length, 1);

    const bad = [
      [{ ...sub, endpoint: 'https://evil.example.org/x' }, /push service/],
      [{ ...sub, endpoint: 'http://fcm.googleapis.com/x' }, /push service/],
      [{ ...sub, keys: { ...sub.keys, p256dh: 'AAAA' } }, /key/],
      [{ ...sub, keys: { ...sub.keys, auth: 'AAAA' } }, /secret/],
      [{ ...sub, extra: 1 }, /Unknown field/],
      [{ endpoint: sub.endpoint }, /Keys/],
    ];
    for (const [body, msg] of bad) {
      const r = await s.member.post('/api/me/push/on', body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
      assert.match(r.json.error, msg);
    }
    const stranger = createClient(s.t).browser();
    assert.equal((await stranger.post('/api/me/push/on', subscription())).status, 401);
    assert.equal((await stranger.get('/api/push')).status, 401);
    assert.equal((await s.member.post('/api/me/push/on', subscription(), { csrf: false })).status, 403);
    assert.equal((await devicesOf(s.t, s.max)).length, 1);
  } finally { await s.t.close(); }
});

test('new keys: the device re-subscribes and its old address is replaced', async () => {
  const s = await boot();
  try {
    const old = subscription(1);
    await s.member.post('/api/me/push/on', old);
    const fresh = subscription(2);
    await s.member.post('/api/me/push/on', { ...fresh, replaces: old.endpoint });
    assert.deepEqual((await devicesOf(s.t, s.max)).map((d) => d.endpoint), [fresh.endpoint]);
    // `replaces` never removes someone else's device.
    const adas = subscription(3);
    await s.admin.post('/api/me/push/on', adas);
    await s.member.post('/api/me/push/on', { ...subscription(4), replaces: adas.endpoint });
    assert.equal((await devicesOf(s.t, s.ada)).length, 1);
  } finally { await s.t.close(); }
});

test(`at most ${MAX_DEVICES} devices per person: the oldest goes`, async () => {
  const s = await boot();
  try {
    const subs = [];
    for (let i = 0; i <= MAX_DEVICES; i++) {
      subs.push(subscription(i));
      await s.member.post('/api/me/push/on', subs[i]);
      s.clock.advance(1000);
    }
    const kept = (await devicesOf(s.t, s.max)).map((d) => d.endpoint);
    assert.equal(kept.length, MAX_DEVICES);
    assert.ok(!kept.includes(subs[0].endpoint));
  } finally { await s.t.close(); }
});

test('a shared phone moves to whoever turned it on last', async () => {
  const s = await boot();
  try {
    const sub = subscription();
    await s.member.post('/api/me/push/on', sub);
    await s.admin.post('/api/me/push/on', sub);
    assert.equal((await devicesOf(s.t, s.max)).length, 0);
    assert.equal((await devicesOf(s.t, s.ada)).length, 1);
  } finally { await s.t.close(); }
});

test('turning off removes only your own device', async () => {
  const s = await boot();
  try {
    const mine = subscription(1);
    const adas = subscription(2);
    await s.member.post('/api/me/push/on', mine);
    await s.admin.post('/api/me/push/on', adas);
    assert.deepEqual((await s.member.post('/api/me/push/off', { endpoint: adas.endpoint })).json, { on: false });
    assert.equal((await devicesOf(s.t, s.ada)).length, 1, 'not Max\'s to remove');
    await s.member.post('/api/me/push/off', { endpoint: mine.endpoint });
    assert.equal((await devicesOf(s.t, s.max)).length, 0);
    assert.equal((await s.member.post('/api/me/push/off', {})).status, 400);
  } finally { await s.t.close(); }
});

test('Send me a test: this device only, once a minute, and gone devices are forgotten', async () => {
  const s = await boot();
  try {
    const sub = subscription();
    await s.member.post('/api/me/push/on', sub);
    await s.member.post('/api/me/push/on', subscription(2)); // another device of Max
    assert.deepEqual((await s.member.post('/api/me/push/test', { endpoint: sub.endpoint })).json, { sent: true });
    assert.equal(s.push.sent.length, 1);
    const { endpoint, message, opts } = s.push.sent[0];
    assert.equal(endpoint, sub.endpoint);
    assert.deepEqual(message, { web_push: 8030, notification: {
      title: 'Flock', body: 'Notifications work on this device.', lang: 'en-GB', dir: 'ltr',
      navigate: 'https://flock.example.org/#/', tag: 'test' } });
    assert.equal(opts.urgency, 'high');

    const again = await s.member.post('/api/me/push/test', { endpoint: sub.endpoint });
    assert.equal(again.status, 429);
    assert.equal(again.headers['retry-after'], '60');
    s.clock.advance(60_000);
    s.push.status.set(sub.endpoint, 500);
    const failed = await s.member.post('/api/me/push/test', { endpoint: sub.endpoint });
    assert.equal(failed.status, 409);
    assert.equal(failed.json.code, 'push_failed');
    assert.equal((await devicesOf(s.t, s.max)).length, 2, 'a failure is not a goodbye');

    s.clock.advance(60_000);
    s.push.status.set(sub.endpoint, 410);
    const gone = await s.member.post('/api/me/push/test', { endpoint: sub.endpoint });
    assert.equal(gone.json.code, 'push_gone');
    assert.equal((await devicesOf(s.t, s.max)).length, 1);

    const adas = subscription(3);
    await s.admin.post('/api/me/push/on', adas);
    assert.equal((await s.member.post('/api/me/push/test', { endpoint: adas.endpoint })).status, 404, 'not Max\'s device');
  } finally { await s.t.close(); }
});

test('a 403 from the push service keeps the device (it is our key, not their phone)', async () => {
  const s = await boot();
  try {
    const sub = subscription();
    await s.member.post('/api/me/push/on', sub);
    s.push.status.set(sub.endpoint, 403);
    assert.equal((await s.member.post('/api/me/push/test', { endpoint: sub.endpoint })).status, 409);
    assert.equal((await devicesOf(s.t, s.max)).length, 1);
  } finally { await s.t.close(); }
});

test('devices are forgotten on logout (that device), Reset login and deactivate (all)', async () => {
  const s = await boot();
  try {
    const a = subscription(1);
    const b = subscription(2);
    await s.member.post('/api/me/push/on', a);
    await s.member.post('/api/me/push/on', b);
    assert.equal((await s.member.post('/api/logout', { pushEndpoint: a.endpoint })).status, 200);
    assert.deepEqual((await devicesOf(s.t, s.max)).map((d) => d.endpoint), [b.endpoint]);
    // Logging out without a device (or with someone else's) still works and removes nothing else.
    const again = await s.as('max@example.com');
    assert.equal((await again.post('/api/logout', {})).status, 200);
    assert.equal((await devicesOf(s.t, s.max)).length, 1);

    const reset = await s.admin.post(`/api/people/${s.max}/reset-login`);
    assert.equal(reset.status, 200, reset.text);
    assert.equal((await devicesOf(s.t, s.max)).length, 0);

    const adaSub = subscription(3);
    await s.admin.post('/api/me/push/on', adaSub);
    const lee = await addPerson(s.t, { name: 'Lee Leaving', email: 'lee@example.com' });
    const leeB = await s.as('lee@example.com');
    await leeB.post('/api/me/push/on', subscription(4));
    const off = await s.admin.patch(`/api/people/${lee}`, { active: false });
    assert.equal(off.status, 200, off.text);
    assert.equal((await devicesOf(s.t, lee)).length, 0);
    assert.equal((await devicesOf(s.t, s.ada)).length, 1, 'others keep theirs');
  } finally { await s.t.close(); }
});

test('sessions renew when used: the cookie comes back at most once a day', async () => {
  const s = await boot();
  try {
    const setCookie = (r) => r.headers['set-cookie'];
    assert.equal(setCookie(await s.member.get('/api/me')), undefined, 'fresh login: nothing to renew');
    s.clock.advance(13 * 86400000);
    const r = await s.member.get('/api/me');
    assert.equal(r.status, 200);
    assert.equal(cookieFrom(r), s.member.cookie, 'the same session, sent again');
    assert.match(String(setCookie(r)), /Max-Age=1209600/);
    assert.equal(setCookie(await s.member.get('/api/me')), undefined, 'once a day');
    s.clock.advance(13 * 86400000);
    assert.equal((await s.member.get('/api/me')).status, 200, 'still in after 26 days of use');
    // Logout's own cookie wins over a renewal on the same request.
    s.clock.advance(2 * 86400000);
    const out = await s.member.post('/api/logout', {});
    assert.match(String(setCookie(out)), /flock_session=;/);
    assert.equal((await s.member.get('/api/me')).status, 401);
  } finally { await s.t.close(); }
});

test('push logs hold the kind, host and status, never endpoints, keys or names', async () => {
  const logLines = [];
  const s = await boot({ logLines });
  try {
    const sub = subscription();
    await s.member.post('/api/me/push/on', sub);
    await s.member.post('/api/me/push/test', { endpoint: sub.endpoint });
    const text = logLines.join('\n');
    const sent = logLines.map((l) => JSON.parse(l)).find((e) => e.msg === 'push sent');
    assert.deepEqual([sent.kind, sent.host, sent.status], ['test', 'fcm.googleapis.com', 201]);
    for (const secret of [sub.endpoint, sub.endpoint.split('/').pop(), sub.keys.p256dh, sub.keys.auth, 'Max Member', 'Notifications work']) {
      assert.ok(!text.includes(secret), `log leaks ${secret.slice(0, 30)}`);
    }
  } finally { await s.t.close(); }
});
