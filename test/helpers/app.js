import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';

export async function startTestApp({ now, db, config, setup } = {}) {
  const database = db ?? new DatabaseSync(':memory:');
  const app = createApp({
    db: database,
    now: now ?? (() => new Date('2025-01-05T12:00:00')),
    config: config ?? loadConfig({}),
  });
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

  return { url, app, db: database, request, close: () => app.close() };
}
