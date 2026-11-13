// Flock's service worker. Two jobs:
//
//  1. Keep the app's own files on the device, so an installed Flock opens at
//     once, even on bad signal or while the server wakes up (decision 0009).
//     Never data: nothing under /api/ is touched.
//  2. Show notifications and open Flock when one is tapped (decision 0008).
//
// The server sends this file with one line in front of it:
//   self.FLOCK_SHELL = {"build": "<hash of all>", "files": {"/app.js": "<hash>", …}};
// so a new release changes these bytes, and the browser installs the new
// worker. A new worker waits until the page asks it to take over (at the next
// page change, see web/lib/worker.js); the first one on a device starts at once.
//
// Messages are WebKit Declarative Web Push JSON:
//   {"web_push": 8030, "notification": {"title", "body", "navigate", "tag", "lang", "dir"}}
// Safari 18.4+ can show them without this file; Chrome, Firefox and older
// Safari need the push handler below.

const SHELL = self.FLOCK_SHELL ?? { build: 'none', files: {} };
const PREFIX = 'flock-shell-';
const CACHE = `${PREFIX}${SHELL.build}`;

// Fetch every file of this version. All or nothing: if one fails or is not
// the expected version (a deploy in between), the new cache is thrown away,
// the install fails, and the old worker keeps its files.
async function fillCache() {
  const cache = await self.caches.open(CACHE);
  try {
    await Promise.all(Object.entries(SHELL.files).map(async ([path, hash]) => {
      const res = await self.fetch(path, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      const tag = res.headers.get('ETag');
      if (tag && tag !== `W/"${hash}"`) throw new Error(`${path}: not this version`);
      await cache.put(path, res);
    }));
  } catch (err) {
    await self.caches.delete(CACHE);
    throw err;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(fillCache().then(() => {
    if (!self.registration.active) return self.skipWaiting();
    return undefined;
  }));
});

self.addEventListener('activate', (event) => event.waitUntil((async () => {
  const names = await self.caches.keys();
  await Promise.all(names.filter((n) => n.startsWith(PREFIX) && n !== CACHE).map((n) => self.caches.delete(n)));
  await self.clients.claim();
})()));

// The cached copy's name for a request, or null when it is not one of the app's files.
function shellPath(request) {
  if (request.method !== 'GET') return null;
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return null;
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  return Object.hasOwn(SHELL.files, path) ? path : null;
}

self.addEventListener('fetch', (event) => {
  const path = shellPath(event.request);
  if (!path) return; // the browser fetches it as usual
  event.respondWith((async () => {
    try {
      const hit = await (await self.caches.open(CACHE)).match(path);
      if (hit) return hit;
    } catch { /* storage cleared or full: use the network */ }
    return self.fetch(event.request);
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});

// Only Flock's own pages are opened.
function sameOriginUrl(raw) {
  try {
    const url = new URL(raw || '/', self.location.origin);
    return url.origin === self.location.origin ? url.href : new URL('/', self.location.origin).href;
  } catch {
    return new URL('/', self.location.origin).href;
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const n = (data && data.notification) || {};
  const options = {
    body: typeof n.body === 'string' ? n.body : '',
    icon: '/icon-192.png',
    badge: '/badge-96.png', // one colour, for the Android status bar
    lang: n.lang || 'en-GB',
    dir: n.dir || 'ltr',
    data: { navigate: sameOriginUrl(n.navigate) },
  };
  if (n.tag) { options.tag = String(n.tag); options.renotify = true; }
  if (n.silent === true) options.silent = true;
  event.waitUntil(self.registration.showNotification(typeof n.title === 'string' && n.title ? n.title : 'Flock', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = sameOriginUrl(event.notification.data && event.notification.data.navigate);
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of open) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      if ('navigate' in client) {
        try { await client.navigate(target); } catch { /* not controlled yet: focus is enough */ }
      }
      if ('focus' in client) return client.focus();
    }
    return self.clients.openWindow(target);
  })());
});
