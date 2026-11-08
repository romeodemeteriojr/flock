// Login, invites, logout, who am I, change password: thin HTTP adapter over services.auth.
import { v, parse } from '../validate.js';
import { TooManyRequestsError } from '../errors.js';
import { sessionCookie, clearCookie, createIpThrottle, parseCookies, isSecure } from '../guard.js';
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

const STATE_COOKIE = 'flock_sso_state';

// Same base address rule as invite links: FLOCK_PUBLIC_URL, else the request's host.
// The redirect URI must also be registered with the provider, so a forged Host gets nowhere.
function redirectUri(req, config, provider) {
  const base = config.publicUrl ?? `${isSecure(req, { config }) ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}`;
  return `${base}/api/auth/${encodeURIComponent(provider)}/callback`;
}

// Scoped to one provider's path, so each provider only ever sees its own state.
function stateCookie(req, ctx, provider, value, maxAge) {
  return `${STATE_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/api/auth/${encodeURIComponent(provider)}; Max-Age=${maxAge}${isSecure(req, ctx) ? '; Secure' : ''}`;
}

export function register(router, ctx) {
  const auth = ctx.services.auth;
  const throttle = createIpThrottle({ clock: ctx.clock, windowMs: 5 * 60 * 1000, max: 20 });
  const welcomeThrottle = createIpThrottle({ clock: ctx.clock, windowMs: 5 * 60 * 1000, max: 20 });

  async function welcomeAttempt(req, fn) {
    const ip = clientIp(req, ctx.config);
    if (welcomeThrottle.isLimited(ip)) throw new TooManyRequestsError(LOCKED_MESSAGE, 60);
    try { return await fn(); }
    catch (e) { welcomeThrottle.fail(ip); throw e; }
  }

  router.add('POST', '/api/login', async ({ req, body }) => {
    const ip = clientIp(req, ctx.config);
    if (throttle.isLimited(ip)) throw new TooManyRequestsError(LOCKED_MESSAGE, 60);
    let result;
    try {
      result = await auth.login(textOrNone(field(body, 'email')), textOrNone(field(body, 'password')));
    } catch (e) {
      throttle.fail(ip); // only failures count toward the per-IP limit
      throw e;
    }
    const { person, token } = result;
    return {
      status: 200,
      headers: { 'Set-Cookie': sessionCookie(req, ctx, token) },
      json: { person: { id: person.id, name: person.name, role: person.role } },
    };
  }, { auth: 'none' });

  router.add('POST', '/api/welcome/check', async ({ req, body }) => ({
    status: 200,
    json: await welcomeAttempt(req, () => auth.inviteInfo(textOrNone(field(body, 'token')))),
  }), { auth: 'none' });

  router.add('POST', '/api/welcome', async ({ req, body }) => {
    const { person, token } = await welcomeAttempt(req, () => auth.acceptInvite(
      textOrNone(field(body, 'token')), textOrNone(field(body, 'password')),
    ));
    return { status: 200, headers: { 'Set-Cookie': sessionCookie(req, ctx, token) }, json: { person } };
  }, { auth: 'none' });

  // Registered before /api/auth/:provider so "options" is never taken for a provider.
  router.add('GET', '/api/auth/options', () => ({
    status: 200, json: { providers: auth.ssoProviders() },
  }), { auth: 'none' });

  router.add('GET', '/api/auth/:provider', ({ req, params }) => {
    const { url, state } = auth.ssoStart(params.provider, redirectUri(req, ctx.config, params.provider));
    return { status: 302, headers: { Location: url, 'Set-Cookie': stateCookie(req, ctx, params.provider, state, 600) }, json: {} };
  }, { auth: 'none' });

  // The provider sends the browser back here. Every outcome is a redirect into the app,
  // and every refusal looks the same: never reveal who is in Flock.
  router.add('GET', '/api/auth/:provider/callback', async ({ req, params, query }) => {
    const { provider } = params;
    const ip = clientIp(req, ctx.config);
    const back = (where, cookies = []) => ({
      status: 302, headers: { Location: where, 'Set-Cookie': [stateCookie(req, ctx, provider, '', 0), ...cookies] }, json: {},
    });
    if (welcomeThrottle.isLimited(ip)) return back('/#/login?signin=failed');
    try {
      const { token } = await auth.ssoFinish({
        provider, code: query.code, state: query.state,
        expectedState: parseCookies(req.headers.cookie)[STATE_COOKIE],
        redirectUri: redirectUri(req, ctx.config, provider),
      });
      return back('/#/', [sessionCookie(req, ctx, token)]);
    } catch (e) {
      welcomeThrottle.fail(ip);
      if (!e?.details?.reason) throw e;
      return back('/#/login?signin=failed');
    }
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
