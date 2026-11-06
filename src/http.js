import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BODY_LIMIT = 100 * 1024;
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
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

export function createRouter() {
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
    const url = new URL(req.url, 'http://localhost');
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    securityHeaders(res, isApi);
    try {
      if (isApi) return await handleApi(req, res, ctx, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, { error: 'That is not allowed here' });
      }
      return await serveStatic(req, res, req.url);
    } catch (err) {
      console.error(err);
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      return send(res, 500, { error: 'Something went wrong' });
    }
  }

  async function handleApi(req, res, ctx, url) {
    const m = match(req.method, url.pathname);
    if (!m.route) {
      if (m.pathMatched) return send(res, 405, { error: 'That is not allowed here' });
      return send(res, 404, { error: 'Not found' });
    }
    let user = null;
    if (guard) {
      user = await guard({ req, res, route: m.route, ctx });
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
