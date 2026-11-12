// Web Push sending (src/infra/webpush.js, decision 0008). No network: the
// RFC examples pin the crypto, and fetch is a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  encryptPayload, vapidJwt, generateVapidKeys, vapidKeysProblem, subscriptionProblem,
  isPushEndpoint, createWebPush, disabledPush, MAX_PAYLOAD,
} from '../src/infra/webpush.js';

const b64 = (s) => Buffer.from(s.replace(/\s+/g, ''), 'base64url');

// RFC 8291 section 5 and appendix A.
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
         mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
         pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
};

// The receiving side of RFC 8291, written independently from the sender, so a
// round trip checks the sender against the standard rather than against itself.
function decrypt(body, { uaPrivate, uaPublic, auth }) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(b64(uaPrivate));
  const secret = ecdh.computeSecret(asPublic);
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const prkKey = hmac(b64(auth), secret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), b64(uaPublic), asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last record ends with the 0x02 delimiter');
  return { rs, text: plain.subarray(0, -1).toString('utf8') };
}

// A real-looking subscription made fresh for each test.
function device(endpoint = 'https://web.push.apple.com/QGuQyavXutnMH-abc') {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint,
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
  };
}

const NOW = new Date('2026-11-12T10:00:00Z');
const clock = { now: () => NOW };

test('webpush: encrypts exactly like the RFC 8291 example', () => {
  const body = encryptPayload(Buffer.from(RFC8291.plaintext), {
    p256dh: RFC8291.uaPublic, auth: RFC8291.auth,
    salt: b64(RFC8291.salt), senderPrivateKey: b64(RFC8291.asPrivate),
  });
  assert.equal(body.toString('base64url'), RFC8291.body.replace(/\s+/g, ''));
});

test('webpush: a fresh encryption decrypts with the receiver keys', () => {
  const d = device();
  const body = encryptPayload(Buffer.from('Asked to serve: Sound, Sun 15 Nov 9:00 ✓'), d);
  assert.deepEqual(decrypt(body, { uaPrivate: d.privateKey, uaPublic: d.p256dh, auth: d.auth }),
    { rs: 4096, text: 'Asked to serve: Sound, Sun 15 Nov 9:00 ✓' });
  // New salt and sender key every time.
  assert.notDeepEqual(encryptPayload(Buffer.from('x'), d).subarray(0, 86), encryptPayload(Buffer.from('x'), d).subarray(0, 86));
});

test('webpush: refuses a payload that does not fit in one push message', () => {
  const d = device();
  assert.ok(encryptPayload(Buffer.alloc(MAX_PAYLOAD), d).length <= 4096);
  assert.throws(() => encryptPayload(Buffer.alloc(MAX_PAYLOAD + 1), d), /too long/);
});

test('webpush: the RFC 8292 example JWT verifies with its public key', () => {
  // Pins how we read a raw 65-byte key and an ES256 (IEEE P1363) signature.
  const jwt = `eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3
    B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1ha
    Wx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_H
    LGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA`.replace(/\s+/g, '');
  const k = 'BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs';
  assert.equal(verifyJwt(jwt, k), true);
  assert.equal(verifyJwt(jwt.slice(0, -2) + 'AA', k), false);
});

function verifyJwt(jwt, publicKey) {
  const [h, p, s] = jwt.split('.');
  const pub = b64(publicKey);
  const key = crypto.createPublicKey({ format: 'jwk', key: {
    kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  return crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
}

test('webpush: our VAPID JWT is ES256, for the push origin, at most 12 hours', () => {
  const keys = generateVapidKeys();
  const jwt = vapidJwt({ audience: 'https://web.push.apple.com', subject: 'https://flock.example.org', ...keys, now: NOW });
  const [h, p] = jwt.split('.').slice(0, 2).map((x) => JSON.parse(Buffer.from(x, 'base64url').toString()));
  assert.deepEqual(h, { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(p, { aud: 'https://web.push.apple.com', exp: NOW.getTime() / 1000 + 12 * 3600, sub: 'https://flock.example.org' });
  assert.equal(verifyJwt(jwt, keys.publicKey), true);
});

test('webpush: generated keys are a matching base64url pair; mismatches are found', () => {
  const a = generateVapidKeys();
  const b = generateVapidKeys();
  assert.equal(b64(a.publicKey).length, 65);
  assert.equal(b64(a.privateKey).length, 32);
  assert.match(a.publicKey + a.privateKey, /^[A-Za-z0-9_-]+$/);
  assert.equal(vapidKeysProblem(a.publicKey, a.privateKey), null);
  assert.match(vapidKeysProblem(a.publicKey, b.privateKey), /do not belong together/);
  assert.match(vapidKeysProblem('abc', a.privateKey), /public key/);
  assert.match(vapidKeysProblem(a.publicKey, 'abc'), /private key/);
  assert.match(vapidKeysProblem(a.publicKey, '+/+/'), /private key/);
});

test('webpush: only real push services are accepted as endpoints', () => {
  for (const ok of [
    'https://web.push.apple.com/QGuQyavXutnMH',
    'https://fcm.googleapis.com/fcm/send/abc:def',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
  ]) assert.equal(isPushEndpoint(ok), true, ok);
  for (const bad of [
    'http://web.push.apple.com/x', 'https://evil.example.org/x', 'https://push.apple.com.evil.org/x',
    'https://fcm.googleapis.com:8443/x', 'https://user@fcm.googleapis.com/x', 'https://127.0.0.1/x',
    'https://evilpush.apple.com/x', 'not a url', '', null, 42, `https://fcm.googleapis.com/${'a'.repeat(2000)}`,
  ]) assert.equal(isPushEndpoint(bad), false, String(bad).slice(0, 60));
});

test('webpush: subscriptions need a push endpoint, a P-256 point and a 16-byte secret', () => {
  const d = device();
  assert.equal(subscriptionProblem(d), null);
  assert.match(subscriptionProblem({ ...d, endpoint: 'https://evil.example.org/x' }), /push service/);
  assert.match(subscriptionProblem({ ...d, p256dh: 'abc' }), /key/);
  // 65 bytes starting with 4, but not on the curve.
  const off = Buffer.alloc(65, 1); off[0] = 4;
  assert.match(subscriptionProblem({ ...d, p256dh: off.toString('base64url') }), /key/);
  assert.match(subscriptionProblem({ ...d, auth: Buffer.alloc(15).toString('base64url') }), /secret/);
  assert.match(subscriptionProblem({ ...d, auth: 7 }), /secret/);
  assert.match(subscriptionProblem(null), /push service/);
});

function fakeFetch(status = 201) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return { status, ok: status >= 200 && status < 300 }; };
  return { fetch, calls };
}

test('webpush: send posts an encrypted, signed declarative message', async () => {
  const keys = generateVapidKeys();
  const { fetch, calls } = fakeFetch(201);
  const push = createWebPush({ ...keys, subject: 'https://flock.example.org', fetch, clock });
  assert.equal(push.enabled, true);
  assert.equal(push.publicKey, keys.publicKey);
  const d = device();
  const message = { web_push: 8030, notification: { title: 'Flock', body: 'Hi', navigate: 'https://flock.example.org/#/' } };
  const r = await push.send(d, message, { ttl: 3600, urgency: 'high', topic: 'asked' });
  assert.deepEqual(r, { ok: true, status: 201, gone: false, host: 'web.push.apple.com' });
  const { url, init } = calls[0];
  assert.equal(url, d.endpoint);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(init.headers['Content-Type'], 'application/octet-stream');
  assert.equal(init.headers.TTL, '3600');
  assert.equal(init.headers.Urgency, 'high');
  assert.equal(init.headers.Topic, 'asked');
  const m = init.headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(m[2], keys.publicKey);
  assert.equal(verifyJwt(m[1], keys.publicKey), true);
  assert.equal(JSON.parse(Buffer.from(m[1].split('.')[1], 'base64url')).aud, 'https://web.push.apple.com');
  const { text } = decrypt(Buffer.from(init.body), { uaPrivate: d.privateKey, uaPublic: d.p256dh, auth: d.auth });
  assert.deepEqual(JSON.parse(text), message);
});

test('webpush: send reports gone devices and never throws', async () => {
  const keys = generateVapidKeys();
  const d = device('https://fcm.googleapis.com/fcm/send/x');
  for (const [status, gone] of [[404, true], [410, true], [403, false], [429, false], [500, false]]) {
    const push = createWebPush({ ...keys, subject: 'https://f.example.org', fetch: fakeFetch(status).fetch, clock });
    assert.deepEqual(await push.send(d, { a: 1 }), { ok: false, status, gone, host: 'fcm.googleapis.com' });
  }
  const broken = createWebPush({ ...keys, subject: 'https://f.example.org', clock, fetch: async () => { throw new Error('ECONNRESET'); } });
  assert.deepEqual(await broken.send(d, { a: 1 }), { ok: false, status: 0, gone: false, host: 'fcm.googleapis.com' });
  const { fetch, calls } = fakeFetch();
  const push = createWebPush({ ...keys, subject: 'https://f.example.org', clock, fetch });
  assert.deepEqual(await push.send({ ...d, endpoint: 'https://evil.example.org/x' }, { a: 1 }), { ok: false, status: 0, gone: true, host: null });
  assert.equal(calls.length, 0, 'never posts to an unknown host');
  // Defaults: 4 weeks at most, normal urgency, no topic.
  await push.send(d, { a: 1 });
  assert.equal(calls[0].init.headers.TTL, String(28 * 86400));
  assert.equal(calls[0].init.headers.Urgency, 'normal');
  assert.equal('Topic' in calls[0].init.headers, false);
  await push.send(d, { a: 1 }, { ttl: 99 * 86400, topic: 'not a valid topic!' });
  assert.equal(calls[1].init.headers.TTL, String(28 * 86400));
  assert.equal('Topic' in calls[1].init.headers, false);
});

test('webpush: when push is off, sending does nothing', async () => {
  const push = disabledPush();
  assert.equal(push.enabled, false);
  assert.equal(push.publicKey, null);
  assert.deepEqual(await push.send(device(), { a: 1 }), { ok: false, status: 0, gone: false, host: null });
});
