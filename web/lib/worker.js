// The service worker from the page's side (decision 0009). Every browser part
// comes from `win`, so tests pass a fake window and nothing runs at import.
//
//   registerWorker(win)  registers /sw.js for everyone at start-up
//   applyUpdate(win)     a new version is waiting: let it take over (the page
//                        reloads once). Called at the next page change.
//   watchUpdates(win)    reload when the new version takes over; ask the
//                        browser to look for one when the app comes back to
//                        the screen, at most every 30 minutes

const CHECK_EVERY_MS = 30 * 60 * 1000;

// win -> { reg, checkedAt, applied }
const known = new WeakMap();

const isLocal = (win) => ['localhost', '127.0.0.1', '[::1]'].includes(win?.location?.hostname);
const now = (win) => win?.performance?.now?.() ?? 0;

/**
 * Registers the worker; the browser ignores repeats. Resolves to the
 * registration, or null when this browser has no service workers.
 * Rejects when registering fails.
 */
export async function registerWorker(win) {
  const sw = win?.navigator?.serviceWorker;
  if (typeof sw?.register !== 'function') return null;
  const reg = await sw.register('/sw.js', { scope: '/', updateViaCache: 'none' });
  const first = !known.has(win);
  const entry = known.get(win) ?? { checkedAt: now(win), applied: false };
  entry.reg = reg;
  known.set(win, entry);
  if (first && isLocal(win)) applyAtOnce(win, reg);
  return reg;
}

// While developing, a new worker takes over as soon as it is ready.
function applyAtOnce(win, reg) {
  applyUpdate(win);
  reg.addEventListener?.('updatefound', () => {
    const next = reg.installing;
    next?.addEventListener?.('statechange', () => {
      if (next.state === 'installed') applyUpdate(win);
    });
  });
}

/** If a new version is waiting, tell it to take over. True when it did. */
export function applyUpdate(win) {
  const entry = known.get(win);
  const waiting = entry?.reg?.waiting;
  if (!waiting || !entry.reg.active) return false;
  entry.applied = true;
  waiting.postMessage({ type: 'skip-waiting' });
  return true;
}

/** Asks the browser to look for a new version, unless it looked in the last 30 minutes. */
export function checkForUpdate(win) {
  const entry = known.get(win);
  if (!entry?.reg?.update) return false;
  const t = now(win);
  if (t - entry.checkedAt < CHECK_EVERY_MS) return false;
  entry.checkedAt = t;
  Promise.resolve().then(() => entry.reg.update()).catch(() => { /* offline: try next time */ });
  return true;
}

/**
 * Call once at start-up, before registerWorker. Reloads the page when a new
 * version takes over, if this page was running an older one (not when the
 * very first worker starts controlling a fresh page).
 */
export function watchUpdates(win) {
  const sw = win?.navigator?.serviceWorker;
  if (typeof sw?.addEventListener !== 'function') return;
  const hadController = !!sw.controller;
  let reloading = false;
  sw.addEventListener('controllerchange', () => {
    if (reloading || !(hadController || known.get(win)?.applied)) return;
    reloading = true;
    win.location.reload();
  });
  const doc = win.document;
  doc?.addEventListener?.('visibilitychange', () => {
    if (doc.visibilityState === 'visible') checkForUpdate(win);
  });
}
