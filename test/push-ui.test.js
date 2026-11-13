// The browser side of notifications (decision 0008): web/lib/push.js against a
// fake browser, the service worker in a sandbox, the pages that show it, and
// the files an installable web app needs. No real browser or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fakeRoot, fakeApi } from './helpers/fakeroot.js';
import { textOf } from './helpers/fakepage.js';
import { startTestApp } from './helpers/app.js';
import * as push from '../web/lib/push.js';
import * as page from '../web/views/notifications.js';
import * as nav from '../web/views/nav.js';
import * as sched from '../web/views/my-schedule.js';

const KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const OTHER_KEY = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
const bytes = (b64url) => new Uint8Array(Buffer.from(b64url, 'base64url'));

const UA = {
  iphone17: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphone15: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1',
  iphone163: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
};

/** A fake browser window with service worker and push. */
function fakeWin({ ua = UA.android, standalone = false, permission = 'default', answer = 'granted', subscription = null, push: hasPush = true, storage = new Map() } = {}) {
  const log = [];
  let sub = subscription;
  const makeSub = (endpoint, key) => ({
    endpoint,
    options: { applicationServerKey: bytes(key).buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: `p256-${endpoint.slice(-1)}`, auth: `auth-${endpoint.slice(-1)}` } }),
    async unsubscribe() { log.push(`unsubscribe ${endpoint}`); sub = null; return true; },
  });
  if (sub) sub = makeSub(sub.endpoint, sub.key);
  let n = 0;
  const reg = {
    pushManager: {
      async getSubscription() { return sub; },
      async subscribe({ userVisibleOnly, applicationServerKey }) {
        assert.equal(userVisibleOnly, true);
        const key = Buffer.from(applicationServerKey).toString('base64url');
        log.push(`subscribe ${key === KEY ? 'KEY' : key === OTHER_KEY ? 'OTHER_KEY' : key}`);
        sub = makeSub(`https://fcm.googleapis.com/fcm/send/new${++n}`, key);
        return sub;
      },
    },
  };
  const win = {
    log,
    navigator: {
      userAgent: ua, platform: ua.includes('Macintosh') ? 'MacIntel' : 'Linux', maxTouchPoints: ua.includes('Macintosh') ? 5 : 0,
      standalone,
      serviceWorker: hasPush ? {
        async register(url, opts) { log.push(`register ${url} ${opts.scope}`); return reg; },
        get ready() { return Promise.resolve(reg); },
        async getRegistration() { return reg; },
      } : undefined,
    },
    matchMedia: () => ({ matches: false }),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
  };
  if (hasPush) {
    win.PushManager = function PushManager() {};
    win.Notification = {
      permission,
      requestPermission() { log.push('ask'); win.Notification.permission = answer; return Promise.resolve(answer); },
    };
  }
  return win;
}

test('support: Android and computers turn on in place; iPhones need the Home Screen and iOS 16.4', () => {
  assert.equal(push.support(fakeWin()), 'ok');
  assert.equal(push.support(fakeWin({ push: false })), 'unsupported');
  assert.equal(push.support(undefined), 'unsupported');
  // Safari on an iPhone has no push until Flock is on the Home Screen.
  assert.equal(push.support(fakeWin({ ua: UA.iphone17, push: false })), 'ios-install');
  assert.equal(push.support(fakeWin({ ua: UA.iphone17, standalone: true })), 'ok');
  assert.equal(push.support(fakeWin({ ua: UA.iphone17, standalone: true, push: false })), 'ios-update');
  assert.equal(push.support(fakeWin({ ua: UA.iphone15, push: false })), 'ios-update');
  assert.equal(push.support(fakeWin({ ua: UA.iphone163, standalone: true })), 'ios-update');
  // An iPad asking for desktop pages still gets the iPhone steps.
  assert.equal(push.support(fakeWin({ ua: UA.ipadDesktop, push: false })), 'ios-install');
  assert.deepEqual(push.iosVersion({ userAgent: UA.iphone17 }), [17, 5]);
  assert.equal(push.iosVersion({ userAgent: UA.android }), null);
});

test('turnOn asks first (inside the tap), subscribes with the church key and tells the server', async () => {
  const win = fakeWin();
  const api = fakeApi({});
  assert.equal(await push.turnOn(win, api, { enabled: true, publicKey: KEY }), 'on');
  assert.deepEqual(win.log, ['ask', 'register /sw.js /', 'subscribe KEY']);
  assert.deepEqual(api.calls, ['POST /api/me/push/on {"endpoint":"https://fcm.googleapis.com/fcm/send/new1","keys":{"p256dh":"p256-1","auth":"auth-1"}}']);

  const no = fakeWin({ answer: 'denied' });
  const api2 = fakeApi({});
  assert.equal(await push.turnOn(no, api2, { enabled: true, publicKey: KEY }), 'blocked');
  assert.equal(await push.turnOn(fakeWin({ answer: 'default' }), api2, { enabled: true, publicKey: KEY }), 'off');
  assert.deepEqual(api2.calls, []);

  // A subscription made with old keys is replaced.
  const old = fakeWin({ subscription: { endpoint: 'https://fcm.googleapis.com/x/old', key: OTHER_KEY } });
  await push.turnOn(old, fakeApi({}), { enabled: true, publicKey: KEY });
  assert.deepEqual(old.log.slice(-2), ['unsubscribe https://fcm.googleapis.com/x/old', 'subscribe KEY']);
});

test('sync on app open: refreshes the server, re-subscribes after a key change, or reports off/blocked', async () => {
  const settings = { enabled: true, publicKey: KEY };
  const same = fakeWin({ permission: 'granted', subscription: { endpoint: 'https://fcm.googleapis.com/x/a', key: KEY } });
  const api = fakeApi({});
  assert.equal(await push.sync(same, api, settings), 'on');
  assert.deepEqual(api.calls, ['POST /api/me/push/on {"endpoint":"https://fcm.googleapis.com/x/a","keys":{"p256dh":"p256-a","auth":"auth-a"}}']);
  assert.ok(!same.log.includes('ask'), 'never asks without a tap');

  const changed = fakeWin({ permission: 'granted', subscription: { endpoint: 'https://fcm.googleapis.com/x/a', key: OTHER_KEY } });
  const api2 = fakeApi({});
  assert.equal(await push.sync(changed, api2, settings), 'on');
  assert.deepEqual(changed.log, ['register /sw.js /', 'unsubscribe https://fcm.googleapis.com/x/a', 'subscribe KEY']);
  assert.match(api2.calls[0], /"replaces":"https:\/\/fcm.googleapis.com\/x\/a"/);

  const quiet = fakeApi({});
  assert.equal(await push.sync(fakeWin({ permission: 'granted' }), quiet, settings), 'off');
  assert.equal(await push.sync(fakeWin({ permission: 'denied' }), quiet, settings), 'blocked');
  assert.equal(await push.sync(fakeWin({ permission: 'default' }), quiet, settings), 'off');
  assert.equal(await push.sync(fakeWin({ permission: 'granted' }), quiet, { enabled: false }), 'off');
  assert.equal(await push.sync(fakeWin({ ua: UA.iphone17, push: false }), quiet, settings), 'off');
  assert.deepEqual(quiet.calls, []);
});

test('turnOff, logout and the test button use this device only', async () => {
  const win = fakeWin({ permission: 'granted', subscription: { endpoint: 'https://fcm.googleapis.com/x/a', key: KEY } });
  const api = fakeApi({});
  await push.sendTest(win, api);
  assert.equal(await push.turnOff(win, api), 'off');
  assert.deepEqual(api.calls, [
    'POST /api/me/push/test {"endpoint":"https://fcm.googleapis.com/x/a"}',
    'POST /api/me/push/off {"endpoint":"https://fcm.googleapis.com/x/a"}',
  ]);
  assert.deepEqual(win.log, ['unsubscribe https://fcm.googleapis.com/x/a']);
  assert.equal(await push.endpoint(win), null);

  const out = fakeWin({ subscription: { endpoint: 'https://fcm.googleapis.com/x/b', key: KEY } });
  assert.equal(await push.forLogout(out), 'https://fcm.googleapis.com/x/b');
  assert.equal(await push.forLogout(out), undefined, 'already stopped');
  assert.equal(await push.forLogout(fakeWin({ push: false })), undefined);
  const broken = fakeWin();
  broken.navigator.serviceWorker.getRegistration = async () => { throw new Error('no'); };
  assert.equal(await push.forLogout(broken), undefined);
});

test('the My schedule invitation: only while off, on a device that can, until dismissed', () => {
  const storage = new Map();
  const win = fakeWin({ storage });
  const p = (o) => ({ enabled: true, support: 'ok', status: 'off', ...o });
  assert.equal(push.showCard(p(), win), true);
  assert.equal(push.showCard(p({ support: 'ios-install' }), win), true);
  for (const o of [{ enabled: false }, { status: 'on' }, { status: 'blocked' }, { support: 'ios-update' }, { support: 'unsupported' }]) {
    assert.equal(push.showCard(p(o), win), false, JSON.stringify(o));
  }
  assert.equal(push.showCard(null, win), false);
  push.dismissCard(win);
  assert.equal(push.showCard(p(), win), false);
  assert.equal(push.showCard(p(), fakeWin()), true, 'per device');
  const noStorage = { localStorage: { getItem() { throw new Error('private'); }, setItem() { throw new Error('private'); } } };
  assert.doesNotThrow(() => push.dismissCard(noStorage));
  assert.equal(push.cardDismissed(noStorage), false);
});

// ---------- the service worker ----------

function runWorker() {
  const listeners = {};
  const shown = [];
  const opened = [];
  const clients = [];
  const self = {
    location: { origin: 'https://flock.example.org' },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting() {},
    registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
    clients: {
      claim: async () => {},
      matchAll: async () => clients,
      openWindow: async (url) => { opened.push(url); },
    },
  };
  vm.runInNewContext(readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8'), { self, URL });
  const fire = async (type, event) => {
    let done;
    listeners[type]({ ...event, waitUntil: (p) => { done = p; } });
    await done;
  };
  return { listeners, shown, opened, clients, fire };
}

test('service worker: shows the declarative message and opens Flock on tap', async () => {
  const w = runWorker();
  assert.deepEqual(Object.keys(w.listeners).sort(), ['activate', 'fetch', 'install', 'message', 'notificationclick', 'push']);
  const msg = { web_push: 8030, notification: { title: 'Flock', body: 'Asked to serve: Sound, Sun 15 Nov 9:00. Tap to answer.', navigate: 'https://flock.example.org/#/gaps', tag: 'asked', lang: 'en-GB', dir: 'ltr' } };
  await w.fire('push', { data: { json: () => msg } });
  assert.equal(w.shown[0].title, 'Flock');
  assert.equal(w.shown[0].options.body, msg.notification.body);
  assert.equal(w.shown[0].options.tag, 'asked');
  assert.equal(w.shown[0].options.renotify, true);
  assert.equal(w.shown[0].options.data.navigate, 'https://flock.example.org/#/gaps');
  assert.equal(w.shown[0].options.icon, '/icon-192.png');
  assert.equal(w.shown[0].options.badge, '/badge-96.png');

  // Never opens another site; broken messages still show something.
  await w.fire('push', { data: { json: () => ({ notification: { body: 'x', navigate: 'https://evil.example.org/' } }) } });
  assert.equal(w.shown[1].options.data.navigate, 'https://flock.example.org/');
  await w.fire('push', { data: { json: () => { throw new Error('not json'); } } });
  assert.deepEqual([w.shown[2].title, w.shown[2].options.body], ['Flock', '']);
  await w.fire('push', { data: null });
  assert.equal(w.shown.length, 4);

  let closed = false;
  const tap = (navigate) => ({ notification: { data: { navigate }, close() { closed = true; } } });
  await w.fire('notificationclick', tap('https://flock.example.org/#/'));
  assert.ok(closed);
  assert.deepEqual(w.opened, ['https://flock.example.org/#/']);
  const visits = [];
  w.clients.push({ url: 'https://flock.example.org/#/blockouts', navigate: async (u) => visits.push(u), focus: async () => visits.push('focus') });
  await w.fire('notificationclick', tap('https://flock.example.org/#/gaps'));
  assert.deepEqual(visits, ['https://flock.example.org/#/gaps', 'focus']);
  assert.equal(w.opened.length, 1, 'an open Flock window is reused');
});

// ---------- pages ----------

const state = (push, role = 'member') => ({ user: { id: 2, name: 'Mary Member', role }, push });

test('Notifications page: every state says what to do', () => {
  const t = (p, role) => textOf(page.render(state(p, role)));
  assert.match(t(null), /Loading/);
  assert.match(t({ enabled: false }), /not set up on this Flock yet/);
  const steps = t({ enabled: true, support: 'ios-install', status: 'off' });
  for (const w of ['Share', 'Add to Home Screen', 'Open Flock from your Home Screen', 'Log in', 'Turn on']) assert.ok(steps.includes(w), w);
  assert.match(t({ enabled: true, support: 'ios-update' }), /iOS 16.4 or newer/);
  assert.match(t({ enabled: true, support: 'unsupported' }), /cannot show notifications/);
  const off = page.render(state({ enabled: true, support: 'ok', status: 'off' }));
  assert.match(off, /data-action="push-on"/);
  assert.doesNotMatch(textOf(off), /scheduler, you also/);
  assert.match(t({ enabled: true, support: 'ok', status: 'off' }, 'admin'), /As a scheduler, you also hear when someone can't serve/);
  const blocked = t({ enabled: true, support: 'ok', status: 'blocked' });
  assert.match(blocked, /blocked for Flock/);
  assert.match(blocked, /Settings → Notifications → Flock/);
  const on = page.render(state({ enabled: true, support: 'ok', status: 'on' }));
  assert.match(textOf(on), /on for this device/);
  assert.match(on, /data-action="push-test"/);
  assert.match(on, /data-action="push-off"/);
  assert.match(textOf(on), /each phone or computer/);
});

test('Notifications page: Turn on, Send me a test and Turn off', async () => {
  const win = fakeWin();
  const api = fakeApi({});
  const root = fakeRoot();
  let tops = 0;
  const ctx = { api, win, state: state({ enabled: true, publicKey: KEY, support: 'ok', status: 'off' }), paintTop: () => { tops++; } };
  page.mount(root, ctx);
  await root.click('push-on');
  assert.equal(ctx.state.push.status, 'on');
  assert.match(textOf(root.innerHTML), /Notifications are on for this device/);
  assert.equal(tops, 1, 'the bell changes too');
  await root.click('push-test');
  assert.match(textOf(root.innerHTML), /Sent/);
  await root.click('push-off');
  assert.equal(ctx.state.push.status, 'off');
  assert.match(textOf(root.innerHTML), /off for this device/);
  assert.deepEqual(api.calls.map((c) => c.split(' ').slice(0, 2).join(' ')), ['POST /api/me/push/on', 'POST /api/me/push/test', 'POST /api/me/push/off']);

  // A refusal from the server is shown in plain words.
  const tooSoon = Object.assign(new Error('Please wait a minute before sending another test'), { status: 429 });
  const r2 = fakeRoot();
  const w2 = fakeWin({ permission: 'granted', subscription: { endpoint: 'https://fcm.googleapis.com/x/a', key: KEY } });
  page.mount(r2, { api: fakeApi({ 'POST /api/me/push/test': tooSoon }), win: w2, state: state({ enabled: true, publicKey: KEY, support: 'ok', status: 'on' }) });
  await r2.click('push-test');
  assert.match(textOf(r2.innerHTML), /wait a minute/);
  // Saying no in the browser explains how to allow it.
  const r3 = fakeRoot();
  const c3 = { api: fakeApi({}), win: fakeWin({ answer: 'denied' }), state: state({ enabled: true, publicKey: KEY, support: 'ok', status: 'off' }) };
  page.mount(r3, c3);
  await r3.click('push-on');
  assert.equal(c3.state.push.status, 'blocked');
  assert.match(textOf(r3.innerHTML), /Settings → Notifications/);
});

test('top bar: the bell shows only when the church turned notifications on, and says when it is on here', () => {
  const user = { id: 2, name: 'Mary Member', role: 'member' };
  assert.doesNotMatch(nav.render({ user }, '#/'), /#\/notifications/);
  assert.doesNotMatch(nav.render({ user, push: { enabled: false } }, '#/'), /#\/notifications/);
  const off = nav.render({ user, push: { enabled: true, status: 'off' } }, '#/');
  assert.match(off, /href="#\/notifications" aria-label="Notifications"/);
  const on = nav.render({ user, push: { enabled: true, status: 'on' } }, '#/');
  assert.match(on, /aria-label="Notifications \(on for this device\)"/);
});

test('logging out stops this device and tells the server which one', async () => {
  const account = await import('../web/views/account.js');
  const btn = { disabled: false };
  const api = fakeApi({});
  const win = fakeWin({ subscription: { endpoint: 'https://fcm.googleapis.com/x/a', key: KEY } });
  let went;
  let user = 'someone';
  await account.logout({ api, win, setUser: (u) => { user = u; }, navigate: (h) => { went = h; }, showError() {} }, btn);
  assert.deepEqual(api.calls, ['POST /api/logout {"pushEndpoint":"https://fcm.googleapis.com/x/a"}']);
  assert.deepEqual(win.log, ['unsubscribe https://fcm.googleapis.com/x/a']);
  assert.equal(went, '#/login');
  assert.equal(user, null);
  // Without push it logs out as before.
  const api2 = fakeApi({});
  await account.logout({ api: api2, win: {}, setUser() {}, navigate() {}, showError() {} }, btn);
  assert.deepEqual(api2.calls, ['POST /api/logout {}']);
});

test('My schedule: the invitation appears once push is known, turns on, and Not now is remembered', async () => {
  const storage = new Map();
  const schedule = { nextServing: null, items: [] };
  const mountWith = async (pushState, win) => {
    const root = fakeRoot();
    const ctx = { api: fakeApi({ 'GET /api/me/schedule': schedule }), win, state: state(pushState), today: '2026-11-04', pushReady: Promise.resolve(pushState) };
    await sched.mount(root, ctx);
    await new Promise((r) => setImmediate(r));
    return { root, ctx };
  };
  const p = () => ({ enabled: true, publicKey: KEY, support: 'ok', status: 'off' });
  const a = await mountWith(p(), fakeWin({ storage }));
  assert.match(textOf(a.root.innerHTML), /Get a notification when you're asked to serve/);
  await a.root.click('push-on');
  assert.equal(a.ctx.state.push.status, 'on');
  assert.doesNotMatch(a.root.innerHTML, /push-invite/, 'gone once on');
  assert.match(textOf(a.root.innerHTML), /on for this device/);

  const b = await mountWith(p(), fakeWin({ storage }));
  await b.root.click('push-later');
  assert.doesNotMatch(b.root.innerHTML, /push-invite/);
  const c = await mountWith(p(), fakeWin({ storage }));
  assert.doesNotMatch(c.root.innerHTML, /push-invite/, 'Not now is remembered on this device');

  const ios = await mountWith({ ...p(), support: 'ios-install' }, fakeWin({ ua: UA.iphone17, push: false }));
  assert.match(ios.root.innerHTML, /href="#\/notifications">Show me how/);
  const off = await mountWith({ enabled: false, support: 'ok', status: 'off' }, fakeWin());
  assert.doesNotMatch(off.root.innerHTML, /push-invite/);
});

// ---------- installable web app ----------

test('the app can be installed: manifest, icons, service worker and the link to them', async () => {
  const t = await startTestApp();
  try {
    const m = await t.request('GET', '/manifest.webmanifest');
    assert.equal(m.status, 200);
    assert.match(m.headers['content-type'], /^application\/manifest\+json/);
    const manifest = JSON.parse(m.text);
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, '/#/');
    assert.equal(manifest.scope, '/');
    for (const icon of manifest.icons.filter((i) => i.type === 'image/png')) {
      const r = await fetch(t.url + icon.src);
      assert.equal(r.status, 200, icon.src);
      const png = Buffer.from(await r.arrayBuffer());
      const [w, h] = icon.sizes.split('x').map(Number);
      assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [w, h], icon.src);
    }
    // Two kinds of home-screen icon: the finished tile, and a full-bleed one the phone crops to its own shape.
    const pngs = manifest.icons.filter((i) => i.type === 'image/png');
    assert.deepEqual(pngs.filter((i) => i.purpose === 'any').map((i) => i.sizes), ['192x192', '512x512']);
    assert.deepEqual(pngs.filter((i) => i.purpose === 'maskable').map((i) => i.sizes), ['192x192', '512x512']);
    assert.equal(pngs.length, 4);
    // The small one-colour picture Android shows in the status bar.
    const badge = await fetch(t.url + '/badge-96.png');
    assert.equal(badge.status, 200);
    const badgePng = Buffer.from(await badge.arrayBuffer());
    assert.deepEqual([badgePng.readUInt32BE(16), badgePng.readUInt32BE(20)], [96, 96]);
    const sw = await t.request('GET', '/sw.js');
    assert.equal(sw.status, 200);
    assert.match(sw.headers['content-type'], /^text\/javascript/);
    const index = await t.request('GET', '/');
    assert.match(index.text, /<link rel="manifest" href="\/manifest.webmanifest">/);
  } finally { await t.close(); }
});

test('home-screen shortcuts: My schedule and Days off, each with a 96px icon that is served', async () => {
  const t = await startTestApp();
  try {
    const manifest = JSON.parse((await t.request('GET', '/manifest.webmanifest')).text);
    assert.deepEqual(manifest.shortcuts.map((s) => [s.name, s.url]), [['My schedule', '/#/'], ['Days off', '/#/blockouts']]);
    const { resolve } = await import('../web/routes.js');
    for (const s of manifest.shortcuts) {
      const r = resolve(s.url.slice(1), { id: 2, name: 'Mary', role: 'member' });
      assert.ok(r.route && !r.redirect, `${s.url} is a real page`);
      assert.equal(s.icons.length, 1);
      const [icon] = s.icons;
      assert.deepEqual([icon.sizes, icon.type], ['96x96', 'image/png']);
      const res = await fetch(t.url + icon.src);
      assert.equal(res.status, 200, icon.src);
      const png = Buffer.from(await res.arrayBuffer());
      assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [96, 96], icon.src);
    }
  } finally { await t.close(); }
});

test('People: a bell chip on everyone with notifications on (not on deactivated people)', async () => {
  const people = await import('../web/views/admin-people.js');
  const base = { email: null, role: 'member', joined: true, positionIds: [] };
  const list = [
    { ...base, id: 1, name: 'Ann On', active: true, notifications: true },
    { ...base, id: 2, name: 'Bo Off', active: true, notifications: false },
    { ...base, id: 3, name: 'Cy Gone', active: false, notifications: true },
  ];
  const out = people.renderScreen({ people: list, teams: [], query: '', loading: false, adding: false, newName: '', panel: null, invite: null, error: '', notice: '', me: 9 });
  const row = (id) => out.split(`data-person="${id}"`)[1].split('data-person=')[0];
  assert.match(row(1), /Notifications on/);
  assert.doesNotMatch(row(2), /Notifications on/);
  assert.doesNotMatch(row(3), /Notifications on/);
});
