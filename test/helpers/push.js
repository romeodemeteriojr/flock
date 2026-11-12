// Fakes for push notification tests (decision 0008). No network.
import crypto from 'node:crypto';

/** A browser subscription with real-looking keys. */
export function subscription(n = 1, host = 'fcm.googleapis.com') {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://${host}/fcm/send/device-${n}-${crypto.randomBytes(4).toString('hex')}`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
  };
}

/** Records every send; `status` decides each answer (default 201). */
export function fakePush({ enabled = true } = {}) {
  const sent = [];
  const fake = {
    enabled,
    publicKey: enabled ? 'BTestPublicKey' : null,
    status: new Map(), // endpoint -> status
    sent,
    async send(device, message, opts = {}) {
      const status = fake.status.get(device.endpoint) ?? 201;
      sent.push({ endpoint: device.endpoint, message, opts });
      return { ok: status < 300, status, gone: status === 404 || status === 410, host: new URL(device.endpoint).hostname };
    },
  };
  return fake;
}
