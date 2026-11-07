// Thin HTTP adapter over services.auth: reads the session cookie, enforces the
// auth level declared on each route and the CSRF header. It never touches data itself.
import { send } from './http.js';

export const COOKIE_NAME = 'flock_session';

export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export function isSecure(req, ctx) {
  const xfp = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  return !!ctx.config?.secureCookies || xfp === 'https';
}

export function sessionCookie(req, ctx, token) {
  const days = Number(ctx.config?.sessionDays);
  const secs = Math.round((Number.isFinite(days) && days > 0 ? days : 14) * 86400);
  return cookieString(req, ctx, token, secs);
}

export function clearCookie(req, ctx) {
  return cookieString(req, ctx, '', 0);
}

function cookieString(req, ctx, value, maxAge) {
  let c = `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
  if (isSecure(req, ctx)) c += '; Secure';
  return c;
}

/**
 * Per-IP attempt counter (used for logins): at most `max` attempts per
 * `windowMs`, timed by the injected clock. hit(ip) records an attempt and
 * returns true when the IP is over the limit (the attempt is then not counted).
 */
export function createIpThrottle({ clock, windowMs = 5 * 60 * 1000, max = 20 }) {
  const attempts = new Map(); // ip -> array of ms timestamps
  return {
    // True when the IP already has `max` failures in the window. Counts nothing.
    isLimited(ip = 'unknown') {
      const nowMs = clock.now().getTime();
      const list = (attempts.get(ip) ?? []).filter((t) => t > nowMs - windowMs);
      return list.length >= max;
    },
    // Records one failed attempt for the IP.
    fail(ip = 'unknown') {
      const nowMs = clock.now().getTime();
      const list = (attempts.get(ip) ?? []).filter((t) => t > nowMs - windowMs);
      list.push(nowMs);
      attempts.set(ip, list);
    },
    hit(ip = 'unknown') {
      const nowMs = clock.now().getTime();
      for (const [k, list] of attempts) {
        const kept = list.filter((t) => t > nowMs - windowMs);
        if (kept.length) attempts.set(k, kept); else attempts.delete(k);
      }
      const list = attempts.get(ip) ?? [];
      if (list.length >= max) return true;
      list.push(nowMs);
      attempts.set(ip, list);
      return false;
    },
  };
}

export function createGuard() {
  return async function guard({ req, res, route, ctx }) {
    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && !(method === 'POST' && route.pattern === '/api/login')) {
      if (req.headers['x-flock'] !== '1') {
        send(res, 403, { error: 'Request not allowed' });
        return null;
      }
    }
    if (route.auth === 'none') return null;

    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const user = await ctx.services.auth.authenticate(token);
    if (!user) {
      send(res, 401, { error: 'Please log in' });
      return null;
    }
    req.sessionToken = token;
    if (route.auth === 'admin' && user.role !== 'admin') {
      send(res, 403, { error: 'Only the scheduler can do that' });
      return null;
    }
    return user;
  };
}
