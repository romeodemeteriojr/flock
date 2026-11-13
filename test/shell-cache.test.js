// The app-shell cache (decision 0009): web/sw.js keeps the app's own files on
// the device; web/lib/worker.js registers it and applies updates.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '../src/http.js';
import { registerWorker, applyUpdate, watchUpdates, checkForUpdate } from '../web/lib/worker.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const ORIGIN = 'https://flock.example.org';
const WORKER_SOURCE = readFileSync(path.join(WEB, 'sw.js'), 'utf8');

// ---------- the worker, run in a sandbox ----------

function fakeCaches() {
  const stores = new Map();
  return {
    stores,
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async put(key, res) { store.set(key, res); },
        async match(key) { return store.get(key); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
}

const response = (body, { status = 200, etag } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  body,
  headers: { get: (h) => (h.toLowerCase() === 'etag' ? etag ?? null : null) },
});

// Runs web/sw.js with `shell` stamped in front, as the server sends it.
function runWorker({ shell, source = WORKER_SOURCE, fetchImpl, active = null, caches = fakeCaches() } = {}) {
  const listeners = {};
  const fetched = [];
  let skipped = 0;
  let claimed = 0;
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => { skipped++; },
    registration: { active, showNotification: async () => {} },
    clients: { claim: async () => { claimed++; }, matchAll: async () => [], openWindow: async () => {} },
    caches,
    fetch: async (req, init) => { fetched.push({ req, init }); return fetchImpl(req, init); },
  };
  const stamp = shell ? `self.FLOCK_SHELL=${JSON.stringify(shell)};\n` : '';
  vm.runInNewContext(stamp + source, { self, URL });
  const fire = async (type, event = {}) => {
    let done = Promise.resolve();
    let answer;
    listeners[type]({ ...event, waitUntil: (p) => { done = p; }, respondWith: (p) => { answer = p; } });
    await done;
    return answer === undefined ? undefined : await answer;
  };
  return { listeners, fetched, caches, fire, skipped: () => skipped, claimed: () => claimed };
}

const SHELL = { build: 'b2', files: { '/app.js': 'hA', '/index.html': 'hI', '/style.css': 'hS' } };
const serveFakes = (overrides = {}) => (req) => {
  const p = typeof req === 'string' ? req : new URL(req.url).pathname;
  return overrides[p] ?? response(`body of ${p}`, { etag: `W/"${SHELL.files[p]}"` });
};

test('install: every listed file goes into the cache named after the build', async () => {
  const w = runWorker({ shell: SHELL, fetchImpl: serveFakes() });
  await w.fire('install');
  const store = w.caches.stores.get('flock-shell-b2');
  assert.deepEqual([...store.keys()].sort(), ['/app.js', '/index.html', '/style.css']);
  assert.equal(store.get('/app.js').body, 'body of /app.js');
  assert.ok(w.fetched.every((f) => f.init.cache === 'no-cache'), 'asks past the browser cache');
  assert.equal(w.skipped(), 1, 'the first worker on a device starts at once');
});

test('install: a new version waits while an older one is running', async () => {
  const w = runWorker({ shell: SHELL, fetchImpl: serveFakes(), active: { state: 'activated' } });
  await w.fire('install');
  assert.ok(w.caches.stores.has('flock-shell-b2'));
  assert.equal(w.skipped(), 0);
});

test('install: one wrong or missing file throws the new cache away and fails', async () => {
  for (const bad of [
    { '/style.css': response('newer', { etag: 'W/"other"' }) },
    { '/app.js': response('gone', { status: 404, etag: 'W/"hA"' }) },
  ]) {
    const w = runWorker({ shell: SHELL, fetchImpl: serveFakes(bad), active: { state: 'activated' } });
    w.caches.stores.set('flock-shell-old', new Map([['/app.js', 'old']]));
    await assert.rejects(w.fire('install'));
    assert.deepEqual([...w.caches.stores.keys()], ['flock-shell-old'], 'the old files stay');
    assert.equal(w.skipped(), 0);
  }
  const offline = runWorker({ shell: SHELL, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(offline.fire('install'));
  assert.equal(offline.caches.stores.size, 0);
});

test('install: an answer without an ETag (a proxy dropped it) is still kept', async () => {
  const w = runWorker({ shell: SHELL, fetchImpl: serveFakes({ '/app.js': response('x') }) });
  await w.fire('install');
  assert.equal(w.caches.stores.get('flock-shell-b2').size, 3);
});

test('activate: older versions are deleted, other caches are left alone, pages are taken over', async () => {
  const w = runWorker({ shell: SHELL, fetchImpl: serveFakes() });
  for (const name of ['flock-shell-a1', 'flock-shell-b2', 'flock-shell-zz', 'something-else']) w.caches.stores.set(name, new Map());
  await w.fire('activate');
  assert.deepEqual([...w.caches.stores.keys()].sort(), ['flock-shell-b2', 'something-else']);
  assert.equal(w.claimed(), 1);
});

test('fetch: the app files come from the cache; data and everything else go to the network', async () => {
  const w = runWorker({ shell: SHELL, fetchImpl: serveFakes() });
  await w.fire('install');
  w.fetched.length = 0;
  const get = (url, method = 'GET') => w.fire('fetch', { request: { method, url } });

  assert.equal((await get(`${ORIGIN}/app.js`)).body, 'body of /app.js');
  assert.equal((await get(`${ORIGIN}/`)).body, 'body of /index.html', '/ is index.html');
  assert.equal((await get(`${ORIGIN}/?from=home#/blockouts`)).body, 'body of /index.html', 'query ignored');
  assert.equal((await get(`${ORIGIN}/style.css?v=2`)).body, 'body of /style.css');
  assert.equal(w.fetched.length, 0, 'no network for cached files');

  for (const [url, method] of [
    [`${ORIGIN}/api/me`, 'GET'],
    [`${ORIGIN}/api/me/schedule`, 'GET'],
    [`${ORIGIN}/app.js`, 'POST'],
    [`${ORIGIN}/app.js`, 'HEAD'],
    [`${ORIGIN}/gallery.html`, 'GET'],
    [`${ORIGIN}/sw.js`, 'GET'],
    ['https://other.example.org/app.js', 'GET'],
    ['not a url', 'GET'],
  ]) {
    assert.equal(await get(url, method), undefined, `${method} ${url} is left to the browser`);
  }
});

test('fetch: a file missing from the cache is fetched from the network', async () => {
  const w = runWorker({ shell: SHELL, fetchImpl: serveFakes() });
  const request = { method: 'GET', url: `${ORIGIN}/app.js` };
  const res = await w.fire('fetch', { request });
  assert.equal(res.body, 'body of /app.js');
  assert.equal(w.fetched[0].req, request);
});

test('message: skip-waiting lets the new version take over; other messages do nothing', async () => {
  const w = runWorker({ shell: SHELL, fetchImpl: serveFakes(), active: { state: 'activated' } });
  w.listeners.message({ data: { type: 'hello' } });
  w.listeners.message({ data: null });
  assert.equal(w.skipped(), 0);
  w.listeners.message({ data: { type: 'skip-waiting' } });
  assert.equal(w.skipped(), 1);
});

test('without a stamp (as in the push tests) the worker caches nothing and serves nothing', async () => {
  const w = runWorker({ fetchImpl: serveFakes() });
  await w.fire('install');
  assert.equal(w.fetched.length, 0);
  assert.equal(await w.fire('fetch', { request: { method: 'GET', url: `${ORIGIN}/app.js` } }), undefined);
});

test('the worker the server sends installs every app file, and each matches its listed version', async () => {
  const server = http.createServer((req, res) => { serveStatic(req, res, req.url, WEB); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const served = await (await fetch(base + '/sw.js')).text();
    const shell = JSON.parse(/^self\.FLOCK_SHELL=(.*);\n/.exec(served)[1]);
    // The served file already carries its stamp, so run it as it is.
    const w = runWorker({
      source: served,
      fetchImpl: async (p) => {
        const r = await fetch(base + p);
        return response(Buffer.from(await r.arrayBuffer()), { status: r.status, etag: r.headers.get('etag') });
      },
    });
    await w.fire('install');
    const store = w.caches.stores.get(`flock-shell-${shell.build}`);
    assert.ok(store, 'cache named after the build');
    assert.deepEqual([...store.keys()].sort(), Object.keys(shell.files));
    assert.deepEqual(store.get('/index.html').body, readFileSync(path.join(WEB, 'index.html')));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

// ---------- the page side: web/lib/worker.js ----------

function fakeWin({ hostname = 'flock.example.org', controller = null, hasWorker = true } = {}) {
  const log = [];
  const swListeners = {};
  const docListeners = {};
  let clock = 1_000_000;
  const reg = {
    waiting: null,
    active: { state: 'activated' },
    installing: null,
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    async update() { log.push('update'); },
  };
  const win = {
    location: { hostname, reload: () => log.push('reload') },
    performance: { now: () => clock },
    document: {
      visibilityState: 'visible',
      addEventListener: (type, fn) => { docListeners[type] = fn; },
    },
    navigator: hasWorker ? {
      serviceWorker: {
        controller,
        async register(url, opts) { log.push(`register ${url} ${opts.scope} ${opts.updateViaCache}`); return reg; },
        addEventListener: (type, fn) => { swListeners[type] = fn; },
      },
    } : {},
  };
  const waitingWorker = () => ({ state: 'installed', postMessage: (m) => log.push(`post ${m.type}`) });
  return {
    win, reg, log, waitingWorker,
    tick: (ms) => { clock += ms; },
    fireSw: (type) => swListeners[type]?.(),
    fireDoc: (type) => docListeners[type]?.(),
  };
}

test('registerWorker: registers /sw.js for the whole app, never from the browser cache', async () => {
  const f = fakeWin();
  assert.equal(await registerWorker(f.win), f.reg);
  assert.deepEqual(f.log, ['register /sw.js / none']);
  assert.equal(await registerWorker(fakeWin({ hasWorker: false }).win), null, 'no service workers: null');
  assert.equal(await registerWorker({}), null);
  const broken = fakeWin();
  broken.win.navigator.serviceWorker.register = async () => { throw new Error('denied'); };
  await assert.rejects(registerWorker(broken.win), /denied/);
});

test('applyUpdate: only when a new version is waiting behind a running one', async () => {
  const f = fakeWin();
  assert.equal(applyUpdate(f.win), false, 'before registering');
  await registerWorker(f.win);
  assert.equal(applyUpdate(f.win), false, 'nothing waiting');
  f.reg.waiting = f.waitingWorker();
  assert.equal(applyUpdate(f.win), true);
  assert.deepEqual(f.log.slice(1), ['post skip-waiting']);
});

test('watchUpdates: reloads once when a new version takes over a page that ran an older one', async () => {
  const f = fakeWin({ controller: { state: 'activated' } });
  watchUpdates(f.win);
  await registerWorker(f.win);
  f.fireSw('controllerchange');
  f.fireSw('controllerchange');
  assert.deepEqual(f.log.filter((l) => l === 'reload'), ['reload']);
});

test('watchUpdates: the very first worker taking over a fresh page does not reload it', async () => {
  const f = fakeWin({ controller: null });
  watchUpdates(f.win);
  await registerWorker(f.win);
  f.fireSw('controllerchange');
  assert.ok(!f.log.includes('reload'));
  // ...but an update this page asked for does reload it.
  f.reg.waiting = f.waitingWorker();
  applyUpdate(f.win);
  f.fireSw('controllerchange');
  assert.ok(f.log.includes('reload'));
});

test('coming back to the screen looks for a new version at most every 30 minutes', async () => {
  const f = fakeWin();
  watchUpdates(f.win);
  await registerWorker(f.win);
  f.fireDoc('visibilitychange');
  assert.equal(checkForUpdate(f.win), false, 'just registered: the browser just looked');
  f.tick(31 * 60 * 1000);
  f.win.document.visibilityState = 'hidden';
  f.fireDoc('visibilitychange');
  await Promise.resolve();
  assert.ok(!f.log.includes('update'), 'not while hidden');
  f.win.document.visibilityState = 'visible';
  f.fireDoc('visibilitychange');
  f.fireDoc('visibilitychange');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.log.filter((l) => l === 'update'), ['update']);
  f.reg.update = async () => { throw new Error('offline'); };
  f.tick(31 * 60 * 1000);
  assert.equal(checkForUpdate(f.win), true, 'a failed look is quiet');
  await new Promise((r) => setImmediate(r));
});

test('on localhost a new version takes over as soon as it is ready', async () => {
  const f = fakeWin({ hostname: 'localhost' });
  f.reg.waiting = f.waitingWorker();
  await registerWorker(f.win);
  assert.ok(f.log.includes('post skip-waiting'), 'one already waiting');
  f.reg.waiting = f.waitingWorker();
  const next = { state: 'installing', listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; } };
  f.reg.installing = next;
  f.reg.listeners.updatefound();
  next.state = 'installed';
  next.listeners.statechange();
  assert.equal(f.log.filter((l) => l === 'post skip-waiting').length, 2);

  const live = fakeWin();
  live.reg.waiting = live.waitingWorker();
  await registerWorker(live.win);
  assert.ok(!live.log.includes('post skip-waiting'), 'elsewhere it waits for a page change');
});

test('the app registers the worker at start and applies a waiting update at the next page change', () => {
  const app = readFileSync(path.join(WEB, 'app.js'), 'utf8');
  assert.match(app, /registerWorker\(win\)/);
  assert.match(app, /watchUpdates\(win\)/);
  assert.match(app, /addEventListener\('hashchange', onHashChange\)/);
  assert.match(app, /function onHashChange\(\) \{[\s\S]{0,120}?applyUpdate\(win\);[\s\S]*?render\(\);/);
  const push = readFileSync(path.join(WEB, 'lib', 'push.js'), 'utf8');
  assert.doesNotMatch(push, /serviceWorker\.register\(/, 'push reuses registerWorker');
});
