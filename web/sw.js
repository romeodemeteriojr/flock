// Flock's service worker (decision 0008). It only shows notifications and opens
// Flock when one is tapped. No offline caching: every page still comes from
// the server.
//
// Messages are WebKit Declarative Web Push JSON:
//   {"web_push": 8030, "notification": {"title", "body", "navigate", "tag", "lang", "dir"}}
// Safari 18.4+ can show them without this file; Chrome, Firefox and older
// Safari need the push handler below.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

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
