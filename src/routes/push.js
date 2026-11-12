// Push notifications (decision 0008): thin HTTP adapters over services.notifications.
import { v, parse } from '../validate.js';

const ok = (json, status = 200) => ({ status, json });
const endpoint = v.string({ min: 1, max: 2000, trim: false });
const key = v.string({ min: 1, max: 200, trim: false });
const onBody = v.object({
  endpoint,
  keys: v.object({ p256dh: key, auth: key }),
  replaces: endpoint.optional(),
}, { strict: true });
const deviceBody = v.object({ endpoint }, { strict: true });

export function register(router, ctx) {
  const notifications = () => ctx.services.notifications;

  router.add('GET', '/api/push', () => ok(notifications().settings()), { auth: 'login' });

  router.add('POST', '/api/me/push/on', async ({ user, body }) => {
    const b = parse(onBody, body);
    return ok(await notifications().turnOn(user.id, {
      endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth, replaces: b.replaces,
    }));
  }, { auth: 'login' });

  router.add('POST', '/api/me/push/off', async ({ user, body }) => (
    ok(await notifications().turnOff(user.id, parse(deviceBody, body).endpoint))
  ), { auth: 'login' });

  router.add('POST', '/api/me/push/test', async ({ user, body }) => (
    ok(await notifications().sendTest(user.id, parse(deviceBody, body).endpoint))
  ), { auth: 'login' });
}
