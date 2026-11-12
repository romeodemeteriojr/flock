// Standard Web Push, sent by Flock itself (decision 0008). node:crypto only.
//
//   VAPID (RFC 8292): each request carries an ES256 JWT for the push service's
//   origin, signed with the church's private key, plus the public key.
//   Encryption (RFC 8291, aes128gcm): only the device can read the message;
//   the push service sees its size and timing.
//
// send() never throws: it answers {ok, status, gone, host}. `gone` means the
// device is no longer subscribed (404/410) and should be forgotten.
import crypto from 'node:crypto';

const RECORD_SIZE = 4096;
// One record: 86-byte header + plaintext + 1 delimiter + 16 tag <= 4096.
export const MAX_PAYLOAD = RECORD_SIZE - 86 - 1 - 16;
const MAX_TTL = 28 * 86400;
const JWT_HOURS = 12;
const TIMEOUT_MS = 10_000;
const URGENCIES = new Set(['very-low', 'low', 'normal', 'high']);

// The push services browsers use: Safari, Chrome/Android/Edge-on-Android,
// Firefox, Edge on Windows. Anything else could be an address inside our own
// network, so it is never contacted.
const PUSH_HOST_SUFFIXES = ['.push.apple.com', '.push.services.mozilla.com', '.notify.windows.com'];
const PUSH_HOSTS = ['fcm.googleapis.com'];
const MAX_ENDPOINT = 2000;

const B64URL = /^[A-Za-z0-9_-]*$/;
function fromB64(s) {
  if (typeof s !== 'string' || !B64URL.test(s)) return null;
  return Buffer.from(s, 'base64url');
}
const b64 = (buf) => Buffer.from(buf).toString('base64url');

/** True for an https URL on a known push service, default port, no credentials. */
export function isPushEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT) return false;
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

function publicKeyObject(raw) {
  if (!raw || raw.length !== 65 || raw[0] !== 4) return null;
  try {
    return crypto.createPublicKey({ format: 'jwk', key: {
      kty: 'EC', crv: 'P-256', x: b64(raw.subarray(1, 33)), y: b64(raw.subarray(33)) } });
  } catch {
    return null; // not a point on the curve
  }
}

/**
 * What is wrong with a browser subscription, in words, or null when it is fine.
 * @param {{endpoint: string, p256dh: string, auth: string}} sub
 */
export function subscriptionProblem(sub) {
  if (!sub || !isPushEndpoint(sub.endpoint)) return 'That is not a known push service';
  if (!publicKeyObject(fromB64(sub.p256dh))) return 'The device key is not valid';
  if (fromB64(sub.auth)?.length !== 16) return 'The device secret is not valid';
  return null;
}

/** A new key pair for the settings: base64url, 65-byte public and 32-byte private. */
export function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(ecdh.getPrivateKey()) };
}

function publicFromPrivate(raw) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(raw);
  return ecdh.getPublicKey();
}

/** What is wrong with a VAPID key pair, or null when it is a matching pair. */
export function vapidKeysProblem(publicKey, privateKey) {
  const pub = fromB64(publicKey);
  if (!publicKeyObject(pub)) return 'The push public key is not valid (FLOCK_VAPID_PUBLIC_KEY)';
  const priv = fromB64(privateKey);
  let derived = null;
  if (priv?.length === 32) {
    try { derived = publicFromPrivate(priv); } catch { /* reported below */ }
  }
  if (!derived) return 'The push private key is not valid (FLOCK_VAPID_PRIVATE_KEY)';
  if (!derived.equals(pub)) return 'The push keys do not belong together (FLOCK_VAPID_PUBLIC_KEY and FLOCK_VAPID_PRIVATE_KEY)';
  return null;
}

function privateKeyObject(publicKey, privateKey) {
  const pub = fromB64(publicKey);
  return crypto.createPrivateKey({ format: 'jwk', key: {
    kty: 'EC', crv: 'P-256', d: privateKey, x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33)) } });
}

/**
 * The VAPID token (RFC 8292) for one push service origin.
 * @param {{audience: string, subject: string, publicKey: string, privateKey: string|crypto.KeyObject, now: Date}} o
 */
export function vapidJwt({ audience, subject, publicKey, privateKey, now }) {
  const key = typeof privateKey === 'string' ? privateKeyObject(publicKey, privateKey) : privateKey;
  const part = (o) => b64(Buffer.from(JSON.stringify(o)));
  const exp = Math.floor(now.getTime() / 1000) + JWT_HOURS * 3600;
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: audience, exp, sub: subject })}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${b64(sig)}`;
}

const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

/**
 * Encrypt one message for one device (RFC 8291). `salt` and `senderPrivateKey`
 * are only passed by tests; normally both are new for every message.
 * @param {Buffer} plaintext
 * @param {{p256dh: string, auth: string, salt?: Buffer, senderPrivateKey?: Buffer}} to
 * @returns {Buffer} the request body
 */
export function encryptPayload(plaintext, { p256dh, auth, salt = crypto.randomBytes(16), senderPrivateKey }) {
  if (plaintext.length > MAX_PAYLOAD) throw new Error('The push message is too long');
  const uaPublic = fromB64(p256dh);
  const ecdh = crypto.createECDH('prime256v1');
  if (senderPrivateKey) ecdh.setPrivateKey(senderPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(secret, fromB64(auth), keyInfo, 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.update(Buffer.from([2])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, ct]);
}

const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * The push sender used by the app.
 * @param {{publicKey: string, privateKey: string, subject: string, clock: {now: () => Date},
 *          fetch?: Function, timeoutMs?: number}} o
 */
export function createWebPush({ publicKey, privateKey, subject, clock, fetch = (u, i) => globalThis.fetch(u, i), timeoutMs = TIMEOUT_MS }) {
  const key = privateKeyObject(publicKey, privateKey);
  return {
    enabled: true,
    publicKey,

    /**
     * @param {{endpoint: string, p256dh: string, auth: string}} device
     * @param {object} message  sent as JSON
     * @param {{ttl?: number, urgency?: string, topic?: string}} [opts]
     * @returns {Promise<{ok: boolean, status: number, gone: boolean, host: string|null}>}
     */
    async send(device, message, { ttl = MAX_TTL, urgency = 'normal', topic } = {}) {
      if (!isPushEndpoint(device?.endpoint)) return { ok: false, status: 0, gone: true, host: null };
      const url = new URL(device.endpoint);
      const host = url.hostname;
      try {
        const body = encryptPayload(Buffer.from(JSON.stringify(message)), device);
        const jwt = vapidJwt({ audience: url.origin, subject, publicKey, privateKey: key, now: clock.now() });
        const headers = {
          Authorization: `vapid t=${jwt}, k=${publicKey}`,
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'aes128gcm',
          TTL: String(Math.max(0, Math.min(MAX_TTL, Math.floor(ttl)))),
          Urgency: URGENCIES.has(urgency) ? urgency : 'normal',
        };
        if (typeof topic === 'string' && TOPIC.test(topic)) headers.Topic = topic;
        const res = await fetch(device.endpoint, {
          method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        });
        const status = res.status;
        return { ok: status >= 200 && status < 300, status, gone: status === 404 || status === 410, host };
      } catch {
        return { ok: false, status: 0, gone: false, host };
      }
    },
  };
}

/** Push while the church has not set its keys: nothing is sent. */
export function disabledPush() {
  return {
    enabled: false,
    publicKey: null,
    send: async () => ({ ok: false, status: 0, gone: false, host: null }),
  };
}
