// A small HTTP client for flow tests on top of startTestApp(): keeps a cookie
// per "browser", always sends the X-Flock header (like web/api.js) unless told
// not to, and records every response so a test can scan them all afterwards.
// Made-up people only; nothing here touches real files.

export function cookieFrom(res) {
  const set = res.headers['set-cookie'];
  const first = Array.isArray(set) ? set[0] : set;
  return first ? String(first).split(';')[0] : null;
}

export function createClient(app) {
  const responses = [];

  function browser(cookie = null) {
    const b = {
      cookie,
      async call(method, path, body, { csrf = true, headers = {} } = {}) {
        const h = { ...(csrf ? { 'X-Flock': '1' } : {}), ...headers };
        const res = await app.request(method, path, { body, cookie: b.cookie ?? undefined, headers: h });
        responses.push({ method, path, ...res });
        return res;
      },
      async login(username, password) {
        const res = await b.call('POST', '/api/login', { username, password });
        if (res.status === 200) b.cookie = cookieFrom(res);
        return res;
      },
      async welcome(token, password) {
        const res = await b.call('POST', '/api/welcome', { token, password });
        if (res.status === 200) b.cookie = cookieFrom(res);
        return res;
      },
      get: (path, opts) => b.call('GET', path, undefined, opts),
      post: (path, body = {}, opts) => b.call('POST', path, body, opts),
      put: (path, body = {}, opts) => b.call('PUT', path, body, opts),
      patch: (path, body = {}, opts) => b.call('PATCH', path, body, opts),
      del: (path, opts) => b.call('DELETE', path, undefined, opts),
    };
    return b;
  }

  return { browser, responses };
}

/** Read the capability from an invite link's fragment, like the welcome page does. */
export const tokenFromLink = (link) => new URLSearchParams(new URL(link).hash.split('?')[1]).get('token');

/** Fill a route pattern's :params with the given value. */
export const fillPath = (pattern, value = '1') => pattern.replace(/:[A-Za-z]+/g, value);

export const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
