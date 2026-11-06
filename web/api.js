// Small client for this app's own /api.
// Every request sends JSON, the X-Flock: 1 header and same-origin cookies.
// Errors become an ApiError with a plain-language message.

export const NETWORK_MESSAGE = "Can't reach the server. Check your internet and try again.";

const FALLBACK = {
  400: "Something in that form isn't right. Please check it and try again.",
  401: 'Please log in again.',
  403: "You aren't allowed to do that.",
  404: "We couldn't find that.",
  409: 'That changed while you were working. Please reload the page and try again.',
  413: 'That is too much to send at once.',
  429: 'Too many tries. Please wait a few minutes.',
};
const SERVER_MESSAGE = 'Something went wrong on our side. Please try again in a minute.';

export class ApiError extends Error {
  constructor({ status = 0, code = null, message }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function messageFor(status, body) {
  if (body && typeof body.error === 'string' && body.error.trim()) return body.error;
  if (FALLBACK[status]) return FALLBACK[status];
  if (status >= 500) return SERVER_MESSAGE;
  return 'Something went wrong. Please try again.';
}

// hooks: { onUnauthorized(err), onMustChange(err) }. They can also be set later:
//   api.onUnauthorized = () => ...
export function createApi(fetchFn = (url, init) => globalThis.fetch(url, init), hooks = {}) {
  const api = {
    onUnauthorized: hooks.onUnauthorized ?? null,
    onMustChange: hooks.onMustChange ?? null,
  };

  function callHook(fn, err) {
    if (typeof fn !== 'function') return;
    try { fn(err); } catch { /* a broken hook must not hide the real error */ }
  }

  async function request(method, path, body) {
    const headers = { Accept: 'application/json', 'X-Flock': '1' };
    const init = { method, headers, credentials: 'same-origin' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetchFn(path, init);
    } catch {
      throw new ApiError({ status: 0, code: 'network', message: NETWORK_MESSAGE });
    }

    let data = null;
    try {
      const text = await res.text();
      if (text) data = JSON.parse(text);
    } catch {
      data = null;
    }

    if (res.ok) return data;

    const err = new ApiError({
      status: res.status,
      code: data && typeof data.code === 'string' ? data.code : null,
      message: messageFor(res.status, data),
    });
    // A wrong password at /api/login is also a 401, but that is not "logged out".
    if (res.status === 401 && path !== '/api/login') callHook(api.onUnauthorized, err);
    if (err.code === 'must_change_password') callHook(api.onMustChange, err);
    throw err;
  }

  api.request = request;
  api.get = (path) => request('GET', path);
  api.post = (path, body = {}) => request('POST', path, body);
  api.put = (path, body = {}) => request('PUT', path, body);
  api.patch = (path, body = {}) => request('PATCH', path, body);
  api.del = (path, body) => request('DELETE', path, body);
  return api;
}
