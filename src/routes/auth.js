import { login, createSession, destroySession, changePassword } from '../auth.js';
import { sessionCookie, clearCookie } from '../guard.js';

const IP_WINDOW_MS = 5 * 60 * 1000;
const IP_MAX = 20;

export function register(router, ctx) {
  const attempts = new Map(); // ip -> array of ms timestamps

  function throttled(req) {
    const nowMs = new Date(ctx.now()).getTime();
    for (const [ip, list] of attempts) {
      const kept = list.filter((t) => t > nowMs - IP_WINDOW_MS);
      if (kept.length) attempts.set(ip, kept); else attempts.delete(ip);
    }
    const ip = req.socket?.remoteAddress ?? 'unknown';
    const list = attempts.get(ip) ?? [];
    if (list.length >= IP_MAX) return true;
    list.push(nowMs);
    attempts.set(ip, list);
    return false;
  }

  const tooMany = { status: 429, json: { error: 'Too many tries. Please wait a few minutes.' } };

  router.add('POST', '/api/login', async ({ req, body }) => {
    if (throttled(req)) return tooMany;
    const r = await login(ctx.db, ctx, body?.username, body?.password);
    if (!r.ok) {
      if (r.reason === 'locked') return tooMany;
      return { status: 401, json: { error: 'Wrong username or password' } };
    }
    const token = createSession(ctx.db, ctx, r.person.id);
    return {
      status: 200,
      headers: { 'Set-Cookie': sessionCookie(req, ctx, token) },
      json: { person: { id: r.person.id, name: r.person.name, role: r.person.role, mustChangePassword: !!r.person.must_change_password } },
    };
  }, { auth: 'none' });

  router.add('POST', '/api/logout', ({ req }) => {
    destroySession(ctx.db, req.sessionToken);
    return { status: 200, headers: { 'Set-Cookie': clearCookie(req, ctx) }, json: { ok: true } };
  }, { auth: 'login' });

  router.add('GET', '/api/me', ({ user }) => ({ status: 200, json: { person: user } }), { auth: 'login' });

  router.add('POST', '/api/password', async ({ req, body, user }) => {
    const r = await changePassword(ctx.db, ctx, user.id, body?.oldPassword, body?.newPassword, { exceptToken: req.sessionToken });
    if (!r.ok) return { status: 400, json: { error: r.error } };
    return { status: 200, json: { ok: true } };
  }, { auth: 'login' });
}
