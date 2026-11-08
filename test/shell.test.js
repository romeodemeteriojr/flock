import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startTestApp } from './helpers/app.js';
import { addPerson } from './helpers/seed.js';
import { openDb } from '../src/db.js';
import { esc, html, raw, attr } from '../web/lib/html.js';
import { createApi, ApiError, NETWORK_MESSAGE } from '../web/api.js';
import { resolve, routes, pathOf } from '../web/routes.js';
import * as loginView from '../web/views/login.js';
import * as passwordView from '../web/views/password.js';
import * as nav from '../web/views/nav.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

async function webFiles(dir = WEB) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await webFiles(p));
    else out.push(p);
  }
  return out.sort();
}
const rel = (f) => '/' + path.relative(WEB, f).split(path.sep).join('/');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };

const member = { id: 2, name: 'Mary', role: 'member' };
const admin = { id: 1, name: 'Ann', role: 'admin' };

// ---------- static files ----------

test('every web file is served with the right content type', async () => {
  const t = await startTestApp();
  try {
    const files = await webFiles();
    for (const want of ['/index.html', '/app.js', '/api.js', '/routes.js', '/style.css', '/lib/html.js',
      '/views/nav.js', '/views/login.js', '/views/password.js', '/views/notfound.js',
      '/views/my-schedule.js', '/views/my-blockouts.js', '/views/admin-people.js', '/views/admin-teams.js',
      '/views/admin-services.js', '/views/admin-schedule.js', '/views/admin-gaps.js']) {
      assert.ok(files.map(rel).includes(want), `missing ${want}`);
    }
    for (const f of files) {
      const type = TYPES[path.extname(f)];
      assert.ok(type, `unexpected file type ${rel(f)}`);
      const r = await fetch(t.url + rel(f));
      assert.equal(r.status, 200, rel(f));
      assert.ok(r.headers.get('content-type').startsWith(type), `${rel(f)}: ${r.headers.get('content-type')}`);
      assert.deepEqual(Buffer.from(await r.arrayBuffer()), await readFile(f));
    }
    const root = await t.request('GET', '/');
    assert.equal(root.status, 200);
    assert.match(root.headers['content-type'], /^text\/html/);
  } finally { await t.close(); }
});

test('index.html has lang, viewport, title, #app, module script and stylesheet', async () => {
  const s = await readFile(path.join(WEB, 'index.html'), 'utf8');
  assert.match(s, /<html lang="en">/);
  assert.match(s, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(s, /<title>Flock<\/title>/);
  assert.match(s, /<div id="app">/);
  assert.match(s, /<script type="module" src="\/app\.js"><\/script>/);
  assert.match(s, /<link rel="stylesheet" href="\/style\.css">/);
});

test('no external URLs, inline scripts, inline handlers or inline styles in web files', async () => {
  for (const f of (await webFiles()).filter((p) => !p.endsWith('.woff2'))) {
    const s = await readFile(f, 'utf8');
    const name = rel(f);
    assert.doesNotMatch(s, /https?:\/\//i, `${name}: has an http(s) URL`);
    assert.doesNotMatch(s, /["'`(=]\s*\/\/[a-z0-9]/i, `${name}: has a protocol-relative URL`);
    assert.doesNotMatch(s, /@import/i, `${name}: has @import`);
    assert.doesNotMatch(s, /javascript:/i, `${name}: has javascript: URL`);
    assert.doesNotMatch(s, /<[a-z][^>]*\son[a-z]+\s*=/i, `${name}: has an inline on* handler`);
    assert.doesNotMatch(s, /<[a-z][^>]*\sstyle\s*=/i, `${name}: has an inline style attribute`);
    assert.doesNotMatch(s, /<style/i, `${name}: has a <style> block`);
    assert.doesNotMatch(s, /\.on[a-z]+\s*=(?!=)/, `${name}: sets an on* property; use addEventListener`);
    for (const m of s.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(m[1], /\ssrc="\/[^/]/, `${name}: script without a local src`);
      assert.equal(m[2].trim(), '', `${name}: inline script content`);
    }
  }
});

test('style.css has the basics', async () => {
  const s = await readFile(path.join(WEB, 'style.css'), 'utf8');
  assert.match(s, /font-size:\s*16\.2px/);
  assert.match(s, /system-ui/);
  assert.match(s, /--control-size:\s*48px/);
  assert.match(s, /min-height:\s*var\(--control-size\)/);
  assert.match(s, /:focus-visible/);
  assert.match(s, /max-width:\s*960px/);
  assert.match(s, /@media print/);
  assert.match(s, /\.btn-primary/);
  assert.match(s, /\.chip/);
});

// ---------- escaping ----------

test('esc escapes <script>, quotes and ampersands', () => {
  assert.equal(esc('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.equal(esc(`Tom & Jerry's "show"`), 'Tom &amp; Jerry&#39;s &quot;show&quot;');
  assert.equal(esc('&amp;'), '&amp;amp;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0');
});

test('html escapes every value in text and attributes', () => {
  const name = '<script>alert(1)</script>';
  const title = `" onmouseover="x' & y`;
  const out = String(html`<p title="${title}">${name}</p>`);
  assert.equal(out, '<p title="&quot; onmouseover=&quot;x&#39; &amp; y">&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.ok(!out.includes('<script>'));
});

test('html: nested templates and arrays stay safe, raw() is not escaped', () => {
  const items = ['<b>', 'a & b'];
  const out = String(html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`);
  assert.equal(out, '<ul><li>&lt;b&gt;</li><li>a &amp; b</li></ul>');
  assert.equal(String(html`<div>${raw('<em>ok</em>')}</div>`), '<div><em>ok</em></div>');
  assert.equal(String(html`${null}${undefined}${false}`), '');
});

test('attr escapes for attributes and is not escaped twice', () => {
  assert.equal(String(attr(`a"b'c<d>&`)), 'a&quot;b&#39;c&lt;d&gt;&amp;');
  assert.equal(String(html`<input value="${attr('"x"')}">`), '<input value="&quot;x&quot;">');
});

// ---------- routes ----------

test('route table has the pages with roles', () => {
  const byPath = Object.fromEntries(routes.map((r) => [r.path, r.role]));
  assert.deepEqual(byPath, {
    '/login': 'public', '/welcome': 'open', '/password': 'any', '/': 'member', '/blockouts': 'member',
    '/people': 'admin', '/teams': 'admin', '/services': 'admin', '/schedule': 'admin', '/gaps': 'admin',
  });
  for (const r of routes) {
    assert.equal(typeof r.view.render, 'function');
    assert.equal(typeof r.view.mount, 'function');
    assert.equal(typeof r.view.title, 'string');
  }
});

test('pathOf normalises hashes', () => {
  assert.equal(pathOf(''), '/');
  assert.equal(pathOf('#'), '/');
  assert.equal(pathOf('#/'), '/');
  assert.equal(pathOf('#/people/'), '/people');
  assert.equal(pathOf('#/people?x=1'), '/people');
  assert.equal(pathOf('#people'), '/people');
});

test('resolve: logged out goes to login', () => {
  for (const h of ['', '#/', '#/blockouts', '#/people', '#/password', '#/nope']) {
    assert.deepEqual(resolve(h, null), { redirect: '#/login' }, h);
  }
  assert.equal(resolve('#/login', null).route.path, '/login');
});

test('resolve: welcome is open whether the person is logged in or out', () => {
  for (const user of [null, member, admin]) assert.equal(resolve('#/welcome?token=example', user).route.path, '/welcome');
});

test('resolve: member vs admin pages', () => {
  for (const h of ['#/people', '#/teams', '#/services', '#/schedule', '#/gaps']) {
    assert.deepEqual(resolve(h, member), { redirect: '#/' }, h);
    assert.equal(resolve(h, admin).route.path, h.slice(1));
  }
  for (const h of ['', '#/', '#/blockouts', '#/password']) {
    assert.ok(resolve(h, member).route, h);
    assert.ok(resolve(h, admin).route, h);
  }
  assert.equal(resolve('', member).route.path, '/');
  assert.deepEqual(resolve('#/login', member), { redirect: '#/' });
});

test('resolve: unknown hash is not found', () => {
  const r = resolve('#/what', member);
  assert.equal(r.route.path, null);
  assert.match(r.route.view.render({ user: member }), /couldn't find/);
});

// ---------- api client ----------

function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = await responder(url, init);
    const text = r.body === undefined ? '' : (typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => text };
  };
  fn.calls = calls;
  return fn;
}

test('api sends JSON, X-Flock and same-origin credentials', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { ok: 1 } }));
  const api = createApi(f);
  assert.deepEqual(await api.post('/api/things', { a: '<b>' }), { ok: 1 });
  assert.deepEqual(await api.get('/api/me'), { ok: 1 });
  await api.put('/api/x', { b: 1 });
  await api.patch('/api/x', { c: 1 });
  await api.del('/api/x');
  assert.deepEqual(f.calls.map((c) => c.init.method), ['POST', 'GET', 'PUT', 'PATCH', 'DELETE']);
  for (const c of f.calls) {
    assert.equal(c.init.headers['X-Flock'], '1');
    assert.equal(c.init.credentials, 'same-origin');
  }
  assert.equal(f.calls[0].url, '/api/things');
  assert.equal(f.calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(f.calls[0].init.body, JSON.stringify({ a: '<b>' }));
  assert.equal(f.calls[1].init.body, undefined);
});

test('api: empty body returns null', async () => {
  const api = createApi(fakeFetch(() => ({ status: 204 })));
  assert.equal(await api.del('/api/x'), null);
});

test('api maps errors to ApiError with plain messages', async () => {
  const api = createApi(fakeFetch((url) => {
    if (url === '/api/a') return { status: 400, body: { error: 'Please type a name.' } };
    if (url === '/api/b') return { status: 500, body: 'oops not json' };
    if (url === '/api/c') return { status: 404 };
    return { status: 409, body: { error: 'Already taken', code: 'conflict' } };
  }));
  await assert.rejects(api.post('/api/a', {}), (e) => e instanceof ApiError && e.status === 400 && e.message === 'Please type a name.' && e.code === null);
  await assert.rejects(api.get('/api/b'), (e) => e.status === 500 && /went wrong/.test(e.message) && !/oops/.test(e.message));
  await assert.rejects(api.get('/api/c'), (e) => e.status === 404 && e.message === "We couldn't find that.");
  await assert.rejects(api.get('/api/d'), (e) => e.status === 409 && e.code === 'conflict' && e.message === 'Already taken');
});

test('api calls onUnauthorized on 401 (but not for a failed login)', async () => {
  let n = 0;
  const api = createApi(fakeFetch(() => ({ status: 401, body: { error: 'Please log in' } })), { onUnauthorized: () => n++ });
  await assert.rejects(api.get('/api/me'), (e) => e.status === 401 && e.message === 'Please log in');
  assert.equal(n, 1);
  await assert.rejects(api.post('/api/login', { email: 'a@example.com', password: 'b' }), (e) => e.status === 401);
  assert.equal(n, 1);
  // hooks can also be set later
  let later = 0;
  api.onUnauthorized = () => later++;
  await assert.rejects(api.get('/api/me'));
  assert.equal(later, 1);
});

test('api does not treat a forbidden response as being logged out', async () => {
  let unauth = 0;
  const api = createApi(fakeFetch(() => ({ status: 403, body: { error: 'Only the scheduler can do that', code: 'forbidden' } })),
    { onUnauthorized: () => unauth++ });
  await assert.rejects(api.get('/api/teams'), (e) => e.status === 403 && e.code === 'forbidden');
  assert.equal(unauth, 0);
});

test('api turns a network failure into a plain message', async () => {
  const api = createApi(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(api.get('/api/me'), (e) => e instanceof ApiError && e.status === 0 && e.message === NETWORK_MESSAGE);
  assert.equal(NETWORK_MESSAGE, "Can't reach the server. Check your internet and try again.");
});

test('api works against the real server: 401, wrong login, X-Flock and voluntary password change', async () => {
  const db = openDb();
  const t = await startTestApp({
    db,
    setup: (a) => a.router.add('GET', '/api/test-login', () => ({ status: 200, json: { ok: true } })),
  });
  try {
    await addPerson(db, { name: 'New <Person>', email: 'newbie@example.com' });
    let cookie = '';
    const jarFetch = async (u, init) => {
      const res = await fetch(t.url + u, { ...init, headers: { ...init.headers, ...(cookie ? { Cookie: cookie } : {}) } });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return res;
    };
    let unauth = 0;
    const api = createApi(jarFetch, { onUnauthorized: () => unauth++ });
    await assert.rejects(api.get('/api/me'), (e) => e.status === 401);
    assert.equal(unauth, 1);
    await assert.rejects(api.post('/api/login', { email: 'newbie@example.com', password: 'wrong-password' }),
      (e) => e.status === 401 && e.message === 'Wrong email or password');
    assert.equal(unauth, 1);
    const r = await api.post('/api/login', { email: 'newbie@example.com', password: 'test-pass-1' });
    assert.equal(typeof r.person.id, 'number');
    assert.equal((await api.get('/api/me')).person.name, 'New <Person>');
    assert.deepEqual(await api.get('/api/test-login'), { ok: true });
    // POST without the client's X-Flock header is refused by the server; the client always sends it.
    assert.deepEqual(await api.post('/api/password', { oldPassword: 'test-pass-1', newPassword: 'apple-river-22' }), { ok: true });
    assert.deepEqual(await api.get('/api/test-login'), { ok: true });
    assert.deepEqual(await api.post('/api/logout'), { ok: true });
  } finally { await t.close(); }
});

// ---------- views ----------

test('login view has labelled fields with the right autocomplete', () => {
  const s = loginView.render({ user: null });
  assert.match(s, /<label for="login-email">Email<\/label>/);
  assert.match(s, /<input id="login-email"[^>]*type="email"[^>]*autocomplete="username"/);
  assert.match(s, /<label for="login-password">Password<\/label>/);
  assert.match(s, /<input id="login-password"[^>]*type="password"[^>]*autocomplete="current-password"/);
  assert.match(s, /<button type="submit"[^>]*>Log in<\/button>/);
  assert.ok(!s.includes('form-error'));
});

test('login view escapes error text and email', () => {
  const s = loginView.render({ user: null }, { error: '<img src=x>Bad & "wrong"', email: '"><script>' });
  assert.ok(s.includes('&lt;img src=x&gt;Bad &amp; &quot;wrong&quot;'));
  assert.ok(s.includes('value="&quot;&gt;&lt;script&gt;"'));
  assert.ok(!s.includes('<img'));
  assert.ok(!s.includes('<script'));
  assert.match(s, /role="alert"/);
});

test('password view: labels, autocomplete and the 8-character rule', () => {
  const s = passwordView.render({ user: member });
  assert.match(s, /Change my password/);
  assert.match(s, /<label for="pw-old">/);
  assert.match(s, /<input id="pw-old"[^>]*autocomplete="current-password"/);
  assert.match(s, /<label for="pw-new">/);
  assert.match(s, /<input id="pw-new"[^>]*autocomplete="new-password"/);
  assert.match(s, /<label for="pw-confirm">/);
  assert.match(s, /<input id="pw-confirm"[^>]*autocomplete="new-password"/);
  assert.match(s, /At least 8 characters/);
  assert.match(s, /Current password/);
});

test('password view escapes error text', () => {
  const s = passwordView.render({ user: member }, { error: '<b>x</b> & "y"' });
  assert.ok(s.includes('&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;'));
  assert.ok(!s.includes('<b>'));
});

test('password checks happen before sending', () => {
  const { checkPasswords } = passwordView;
  assert.match(checkPasswords('', 'abcdefgh', 'abcdefgh'), /current password/);
  assert.match(checkPasswords('old-pass-1', 'short', 'short'), /at least 8 characters/);
  assert.match(checkPasswords('old-pass-1', 'abcdefgh', 'abcdefgX'), /don't match/);
  assert.match(checkPasswords('abcdefgh', 'abcdefgh', 'abcdefgh'), /different/);
  assert.equal(checkPasswords('old-pass-1', 'apple-river-22', 'apple-river-22'), '');
});

test('nav differs by role and marks the current page', () => {
  const m = nav.render({ user: member }, '#/blockouts');
  assert.match(m, /My schedule/);
  assert.match(m, /Days I can&#39;t serve/);
  assert.match(m, /Log out/);
  for (const w of ['People', 'Teams', 'Services', 'Schedule<', 'Gaps']) assert.ok(!m.includes(w), w);
  assert.match(m, /<a href="#\/blockouts" aria-current="page">/);
  assert.equal((m.match(/aria-current/g) || []).length, 1);

  const a = nav.render({ user: admin }, '#/');
  for (const w of ['My schedule', 'People', 'Teams', 'Services', 'Schedule<', 'Gaps', 'Log out']) assert.ok(a.includes(w), w);
  assert.match(a, /<a href="#\/" aria-current="page">/);

  assert.equal(nav.render({ user: null }, '#/login'), '');
  const f = nav.render({ user: member }, '#/password');
  assert.match(f, /My schedule/);
  assert.match(f, /aria-label="Change my password"/);
  assert.match(f, /Log out/);
  // People who only sign in with a provider have no password to change.
  assert.doesNotMatch(nav.render({ user: { ...member, hasPassword: false } }, '#/'), /Change my password/);
});

test('nav escapes the person name', () => {
  const s = nav.render({ user: { ...member, name: '<script>x</script>' } }, '#/');
  assert.ok(!s.includes('<script>'));
  assert.ok(s.includes('&lt;script&gt;'));
});

test('stub views say Coming soon and mount does nothing', async () => {
  for (const name of []) {
    const v = await import(`../web/views/${name}.js`);
    assert.equal(typeof v.title, 'string');
    assert.match(v.render({ user: member }), /Coming soon/);
    assert.equal(v.mount({}, {}), undefined);
  }
});

test('every web module imports in Node without touching document or window', async () => {
  const files = (await webFiles()).filter((f) => f.endsWith('.js'));
  const touched = [];
  const had = { document: Object.getOwnPropertyDescriptor(globalThis, 'document'), window: Object.getOwnPropertyDescriptor(globalThis, 'window') };
  for (const k of ['document', 'window']) {
    Object.defineProperty(globalThis, k, { configurable: true, get() { touched.push(k); return undefined; } });
  }
  try {
    for (const f of files.filter((x) => rel(x) !== '/app.js')) {
      await import(pathToFileURL(f).href + '?probe');
      assert.deepEqual(touched, [], `${rel(f)} touched ${touched.join(', ')} at import`);
    }
    // app.js checks `typeof document` to decide whether to boot; it must not fail without one.
    await import(pathToFileURL(path.join(WEB, 'app.js')).href + '?probe');
  } finally {
    for (const k of ['document', 'window']) {
      if (had[k]) Object.defineProperty(globalThis, k, had[k]); else delete globalThis[k];
    }
  }
});
