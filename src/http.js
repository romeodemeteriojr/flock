import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './errors.js';
import { silentLogger } from './infra/logger.js';
import { systemClock } from './infra/clock.js';
import { secureRandom } from './infra/random.js';

export const BODY_LIMIT = 100 * 1024;
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

export function securityHeaders(res, isApi) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  if (isApi) res.setHeader('Cache-Control', 'no-store');
}

export function send(res, status, obj, headers = {}) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(obj ?? {});
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Turns any thrown error into { status, body, headers, unexpected }.
// AppError -> its status and message (code only when given explicitly);
// data-layer DuplicateError / InUseError -> 409; anything else -> generic 500.
export function mapError(err) {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: err.message }, headers: {}, unexpected: false };
  }
  if (err instanceof AppError && Number.isInteger(err.status) && err.status >= 400 && err.status <= 599) {
    const body = { error: err.message };
    if (err.exposeCode && err.code) body.code = err.code;
    const headers = {};
    if (err.status === 429) headers['Retry-After'] = String(err.retryAfterSec ?? 60);
    return { status: err.status, body, headers, unexpected: false };
  }
  if (err && (err.name === 'DuplicateError' || err.name === 'InUseError') && typeof err.message === 'string') {
    return { status: 409, body: { error: err.message }, headers: {}, unexpected: false };
  }
  return { status: 500, body: { error: 'Something went wrong' }, headers: {}, unexpected: true };
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,64}$/;

export function requestIdFrom(header, random) {
  const v = Array.isArray(header) ? header[0] : header;
  if (typeof v === 'string' && SAFE_REQUEST_ID.test(v)) return v;
  return random.token(12);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > BODY_LIMIT) {
        failed = true;
        chunks.length = 0;
        reject(new HttpError(413, 'That request is too big'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new HttpError(400, 'That request was not valid JSON')); }
    });
    req.on('error', (e) => { if (!failed) { failed = true; reject(e); } });
  });
}

function compile(pattern) {
  const names = [];
  const parts = pattern.split('/').filter(Boolean).map((seg) => {
    if (seg.startsWith(':')) { names.push(seg.slice(1)); return null; }
    return seg;
  });
  return { parts, names };
}

export function createRouter({ logger, clock, random } = {}) {
  const log = logger ?? silentLogger();
  const clk = clock ?? systemClock();
  const rnd = random ?? secureRandom();
  const list = [];
  let guard = null;

  function add(method, pattern, handler, opts = {}) {
    const auth = opts.auth ?? 'login';
    if (!['none', 'login', 'admin'].includes(auth)) throw new Error(`Bad auth level: ${auth}`);
    list.push({ method: method.toUpperCase(), pattern, handler, auth, ...compile(pattern) });
  }

  function routes() {
    return list.map(({ method, pattern, auth }) => ({ method, pattern, auth }));
  }

  function match(method, pathname) {
    const segs = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const r of list) {
      if (r.parts.length !== segs.length) continue;
      const params = {};
      let ok = true;
      let n = 0;
      for (let i = 0; i < segs.length; i++) {
        if (r.parts[i] === null) {
          try { params[r.names[n++]] = decodeURIComponent(segs[i]); } catch { ok = false; break; }
        } else if (r.parts[i] !== segs[i]) { ok = false; break; }
      }
      if (!ok) continue;
      pathMatched = true;
      if (r.method === method) return { route: r, params };
    }
    return { route: null, pathMatched };
  }

  // The auth card installs a guard: async ({req, res, route, ctx}) => user | null.
  // Return a user to continue; send a response itself (or throw) to stop.
  function setGuard(fn) { guard = fn; }

  async function handle(req, res, ctx) {
    const started = clk.now().getTime();
    const requestId = requestIdFrom(req.headers['x-request-id'], rnd);
    const state = { requestId, userId: null, path: '/' };
    req.id = requestId;
    res.setHeader('X-Request-Id', requestId);
    let logged = false;
    const logRequest = () => {
      if (logged) return;
      logged = true;
      const aborted = !res.writableFinished;
      log.info('request', {
        method: req.method,
        path: state.path,
        status: res.statusCode,
        durationMs: Math.max(0, clk.now().getTime() - started),
        requestId,
        userId: state.userId ?? undefined,
        aborted: aborted || undefined,
      });
    };
    res.once('finish', logRequest);
    res.once('close', logRequest);

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      securityHeaders(res, false);
      return send(res, 404, { error: 'Not found' });
    }
    state.path = url.pathname;
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    securityHeaders(res, isApi);
    try {
      if (isApi) return await handleApi(req, res, ctx, url, state);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, { error: 'That is not allowed here' });
      }
      return await serveStatic(req, res, req.url);
    } catch (err) {
      const m = mapError(err);
      if (m.unexpected) {
        if (logger) log.error('Unhandled error', { requestId, method: req.method, path: state.path, err });
        else console.error(err);
      }
      // A handler that already started a response cannot get a clean error now.
      if (res.headersSent) return res.destroy();
      return send(res, m.status, m.body, m.headers);
    }
  }

  async function handleApi(req, res, ctx, url, state = {}) {
    const m = match(req.method, url.pathname);
    if (!m.route) {
      if (m.pathMatched) return send(res, 405, { error: 'That is not allowed here' });
      return send(res, 404, { error: 'Not found' });
    }
    let user = null;
    if (guard) {
      user = await guard({ req, res, route: m.route, ctx });
      if (user && user.id !== undefined) state.userId = user.id;
      if (res.headersSent || res.writableEnded) return;
    }
    let body = {};
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) body = await readBody(req);
    const query = Object.fromEntries(url.searchParams);
    const result = await m.route.handler({ req, res, params: m.params, query, body, user, ctx });
    if (res.headersSent || res.writableEnded) return;
    if (result && typeof result === 'object') {
      return send(res, result.status ?? 200, result.json ?? {}, result.headers);
    }
    send(res, 204 === result ? 204 : 500, { error: 'Something went wrong' });
  }

  return { add, routes, match, setGuard, handle };
}

export async function serveStatic(req, res, rawUrl, root = WEB_ROOT) {
  const notFound = () => send(res, 404, { error: 'Not found' });
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname);
  } catch { return notFound(); }
  if (pathname.includes('\0') || pathname.includes('\\')) return notFound();
  if (pathname.endsWith('/')) pathname += 'index.html';
  const base = path.resolve(root);
  const file = path.resolve(base, '.' + pathname);
  if (file !== base && !file.startsWith(base + path.sep)) return notFound();
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type) return notFound();
  let data;
  try { data = await readFile(file); } catch { return notFound(); }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
  res.end(req.method === 'HEAD' ? undefined : data);
}
