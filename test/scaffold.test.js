import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { startTestApp } from './helpers/app.js';

test('config defaults', () => {
  assert.deepEqual(loadConfig({}), {
    port: 8080, dbPath: './data/flock.db', secureCookies: false, trustProxy: false, publicUrl: undefined, unansweredDays: 3, sessionDays: 14,
    googleClientId: undefined, googleClientSecret: undefined,
  });
});

test('config overrides', () => {
  const c = loadConfig({ FLOCK_PORT: '9000', FLOCK_DB: '/tmp/x.db', FLOCK_SECURE_COOKIES: '1' });
  assert.equal(c.port, 9000);
  assert.equal(c.dbPath, '/tmp/x.db');
  assert.equal(c.secureCookies, true);
});

test('health endpoint works and is public', async () => {
  const t = await startTestApp();
  try {
    const r = await t.request('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    const route = t.app.router.routes().find((x) => x.pattern === '/api/health');
    assert.equal(route.auth, 'none');
  } finally { await t.close(); }
});

test('home page is served', async () => {
  const t = await startTestApp();
  try {
    const r = await t.request('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.match(r.text, /id="app"/);
  } finally { await t.close(); }
});

test('version is 0.2.0 everywhere', async () => {
  const { readFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { VERSION } = await import('../src/config.js');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '0.2.0');
  assert.equal(VERSION, pkg.version);
  const bin = new URL('../bin/flock.js', import.meta.url).pathname;
  for (const arg of ['version', '--version']) {
    assert.equal(execFileSync(process.execPath, [bin, arg], { encoding: 'utf8' }).trim(), 'flock 0.2.0');
  }
});
