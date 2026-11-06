import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/http.js';
import { startTestApp } from './helpers/app.js';

async function withApp(fn) {
  const t = await startTestApp({
    setup(app) {
      const r = app.router;
      r.add('GET', '/api/t/:a/x/:b', ({ params, query }) => ({ status: 200, json: { params, query } }), { auth: 'none' });
      r.add('POST', '/api/t/echo', ({ body }) => ({ status: 201, json: body }), { auth: 'admin' });
      r.add('GET', '/api/t/boom', () => { throw new Error('secret detail'); });
    },
  });
  try { await fn(t); } finally { await t.close(); }
}

test('route params and query', () => withApp(async (t) => {
  const r = await t.request('GET', '/api/t/one/x/two%20words?q=hi&n=2');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { params: { a: 'one', b: 'two words' }, query: { q: 'hi', n: '2' } });
}));

test('post body is parsed', () => withApp(async (t) => {
  const r = await t.request('POST', '/api/t/echo', { body: { a: 1 } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json, { a: 1 });
}));

test('body over 100 KB gives 413', () => withApp(async (t) => {
  const r = await t.request('POST', '/api/t/echo', { body: { s: 'x'.repeat(101 * 1024) } });
  assert.equal(r.status, 413);
  assert.ok(r.json.error);
}));

test('invalid JSON gives 400', () => withApp(async (t) => {
  const r = await t.request('POST', '/api/t/echo', { body: '{nope' });
  assert.equal(r.status, 400);
  assert.ok(r.json.error);
}));

test('unknown api path is 404 JSON', () => withApp(async (t) => {
  const r = await t.request('GET', '/api/nothing/here');
  assert.equal(r.status, 404);
  assert.equal(typeof r.json.error, 'string');
}));

test('traversal is blocked', () => withApp(async (t) => {
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/%2e%2e%2fpackage.json',
    '/static/../../package.json', '//etc/passwd', '/etc/passwd', '/..%5cpackage.json', '/%00', '/%zz']) {
    const r = await t.request('GET', p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.text.includes('"flock"'), p);
  }
}));

test('security headers on every response', () => withApp(async (t) => {
  for (const p of ['/', '/api/health', '/api/nope', '/missing.html', '/api/t/boom']) {
    const r = await t.request('GET', p);
    assert.equal(r.headers['content-security-policy'], "default-src 'self'; frame-ancestors 'none'", p);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    if (p.startsWith('/api')) assert.equal(r.headers['cache-control'], 'no-store');
  }
}));

test('thrown error gives 500 with no leak', () => withApp(async (t) => {
  const orig = console.error;
  console.error = () => {};
  let r;
  try { r = await t.request('GET', '/api/t/boom'); } finally { console.error = orig; }
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: 'Something went wrong' });
  assert.ok(!r.text.includes('secret detail'));
  assert.ok(!r.text.includes('at '));
}));

test('router lists routes with auth levels', () => {
  const r = createRouter();
  r.add('GET', '/api/a', () => ({}));
  r.add('post', '/api/b/:id', () => ({}), { auth: 'admin' });
  r.add('GET', '/api/c', () => ({}), { auth: 'none' });
  assert.deepEqual(r.routes(), [
    { method: 'GET', pattern: '/api/a', auth: 'login' },
    { method: 'POST', pattern: '/api/b/:id', auth: 'admin' },
    { method: 'GET', pattern: '/api/c', auth: 'none' },
  ]);
  assert.throws(() => r.add('GET', '/x', () => ({}), { auth: 'bogus' }));
});
