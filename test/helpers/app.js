import http from 'node:http';
import { createApp } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { openDb } from '../../src/db.js';
import { makeContainer } from './container.js';
import { registerContainer } from './seed.js';

// Starts the real app on a free port. Old arguments still work; `container`
// lets a test pass any extra overrides (clock, random, hasher, logger, ...).
export async function startTestApp({ now, db, config, setup, container: overrides = {} } = {}) {
  const database = db ?? overrides.db ?? openDb(':memory:');
  const parts = { config: config ?? loadConfig({}), db: database, ...overrides };
  if (now && !overrides.clock) {
    parts.clock = { now: () => { const n = now(); return n instanceof Date ? n : new Date(n); } };
  }
  const container = makeContainer(parts);
  registerContainer(database, container);
  const app = createApp({ container });
  if (setup) setup(app);
  const port = await app.listen(0);
  const url = `http://127.0.0.1:${port}`;

  // Uses node:http so paths like /../x are sent exactly as written.
  function request(method, path, { body, cookie, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const h = { ...headers };
      let payload;
      if (body !== undefined) {
        payload = typeof body === 'string' ? body : JSON.stringify(body);
        h['Content-Type'] ??= 'application/json';
        h['Content-Length'] = Buffer.byteLength(payload);
      }
      if (cookie) h.Cookie = cookie;
      const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(text); } catch { json = undefined; }
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      });
      req.on('error', (e) => { if (e.code !== 'EPIPE' && e.code !== 'ECONNRESET') reject(e); });
      req.end(payload);
    });
  }

  return { url, app, container, data: container.data, db: database, request, close: () => app.close() };
}
