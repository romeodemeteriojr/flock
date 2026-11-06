// Login, logout, who am I, change password: thin HTTP adapter over services.auth.
import { v, parse } from '../validate.js';
import { TooManyRequestsError } from '../errors.js';
import { sessionCookie, clearCookie, createIpThrottle } from '../guard.js';
import { LOCKED_MESSAGE } from '../services/auth-service.js';

// Credentials are text; anything else is passed on as "missing", so the
// service answers exactly as before (401 for login, its own 400 message for
// password changes) instead of a generic validation error.
const text = v.string({ trim: false });
function textOrNone(value) {
  try { return parse(text, value); } catch { return undefined; }
}
const field = (body, key) => (body !== null && typeof body === 'object' ? body[key] : undefined);

// Behind a trusted proxy (Fly.io) the real client is in a header; otherwise
// those headers are ignored so a client cannot pick its own IP.
export function clientIp(req, config) {
  if (config?.trustProxy) {
    const one = (h) => (Array.isArray(h) ? h[0] : h);
    const fly = String(one(req.headers?.['fly-client-ip']) ?? '').trim();
    if (fly) return fly;
    const xff = String(one(req.headers?.['x-forwarded-for']) ?? '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

export function register(router, ctx) {
  const auth = ctx.services.auth;
  const throttle = createIpThrottle({ clock: ctx.clock, windowMs: 5 * 60 * 1000, max: 20 });

  router.add('POST', '/api/login', async ({ req, body }) => {
    const ip = clientIp(req, ctx.config);
    if (throttle.isLimited(ip)) throw new TooManyRequestsError(LOCKED_MESSAGE, 60);
    let result;
    try {
      result = await auth.login(textOrNone(field(body, 'username')), textOrNone(field(body, 'password')));
    } catch (e) {
      throttle.fail(ip); // only failures count toward the per-IP limit
      throw e;
    }
    const { person, token } = result;
    return {
      status: 200,
      headers: { 'Set-Cookie': sessionCookie(req, ctx, token) },
      json: { person: { id: person.id, name: person.name, role: person.role, mustChangePassword: person.mustChangePassword } },
    };
  }, { auth: 'none' });

  router.add('POST', '/api/logout', async ({ req }) => {
    await auth.logout(req.sessionToken);
    return { status: 200, headers: { 'Set-Cookie': clearCookie(req, ctx) }, json: { ok: true } };
  }, { auth: 'login' });

  router.add('GET', '/api/me', ({ user }) => ({ status: 200, json: { person: user } }), { auth: 'login' });

  router.add('POST', '/api/password', async ({ req, body, user }) => {
    await auth.changePassword(user.id, textOrNone(field(body, 'oldPassword')), textOrNone(field(body, 'newPassword')),
      { currentToken: req.sessionToken });
    return { status: 200, json: { ok: true } };
  }, { auth: 'login' });
}
