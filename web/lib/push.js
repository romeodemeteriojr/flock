// Push notifications in the browser (decision 0008). Every browser part comes
// from `win`, so tests pass a fake window. Nothing here throws on a browser
// that cannot do push: support() says what it can do.
//
//   support(win)  'ok' | 'ios-install' (iPhone in Safari: add to Home Screen first)
//                 | 'ios-update' (iOS older than 16.4) | 'unsupported'
//   status        'on' | 'off' | 'blocked' (the person said no in the browser)

import { registerWorker } from './worker.js';

const CARD_KEY = 'flock.pushCard';

export function isIos(nav) {
  const ua = String(nav?.userAgent ?? '');
  // iPads ask for desktop pages and look like a Mac with a touch screen.
  return /iPhone|iPad|iPod/.test(ua) || (nav?.platform === 'MacIntel' && nav?.maxTouchPoints > 1);
}

/** [major, minor] of iOS, or null when it cannot be told (then assume new enough). */
export function iosVersion(nav) {
  const m = String(nav?.userAgent ?? '').match(/(?:iPhone|CPU) OS (\d+)_(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function isStandalone(win) {
  try {
    return win?.navigator?.standalone === true || !!win?.matchMedia?.('(display-mode: standalone)')?.matches;
  } catch { return false; }
}

export function support(win) {
  const nav = win?.navigator;
  const capable = !!(nav?.serviceWorker && win?.PushManager && win?.Notification);
  if (isIos(nav)) {
    const v = iosVersion(nav);
    if (v && (v[0] < 16 || (v[0] === 16 && v[1] < 4))) return 'ios-update';
    if (!isStandalone(win)) return 'ios-install';
    return capable ? 'ok' : 'ios-update';
  }
  return capable ? 'ok' : 'unsupported';
}

export function permission(win) {
  try { return win?.Notification?.permission ?? 'default'; } catch { return 'default'; }
}

function keyBytes(b64url, win) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  const bin = win.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sameKey(buffer, b64url, win) {
  if (!buffer) return false;
  const a = new Uint8Array(buffer);
  const b = keyBytes(b64url, win);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function deviceBody(sub) {
  const j = sub.toJSON();
  return { endpoint: j.endpoint, keys: { p256dh: j.keys?.p256dh, auth: j.keys?.auth } };
}

// Registers the worker (the browser ignores repeats; see lib/worker.js) and waits until it runs.
async function registration(win) {
  await registerWorker(win);
  return win.navigator.serviceWorker.ready;
}

// The registration if there is one, without waiting for anything.
async function existing(win) {
  try { return (await win.navigator.serviceWorker?.getRegistration?.('/')) ?? null; } catch { return null; }
}

async function subscribe(reg, settings, win) {
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(settings.publicKey, win) });
}

/**
 * When the app opens: if this device has notifications on, tell the server
 * again (it may have forgotten them, or the person changed), and re-subscribe
 * quietly if the church changed its keys. Returns the status.
 */
export async function sync(win, api, settings) {
  if (!settings?.enabled || support(win) !== 'ok') return 'off';
  if (permission(win) === 'denied') return 'blocked';
  if (permission(win) !== 'granted') return 'off';
  const reg = await registration(win);
  let sub = await reg.pushManager.getSubscription();
  if (!sub) return 'off';
  let replaces;
  if (!sameKey(sub.options?.applicationServerKey, settings.publicKey, win)) {
    replaces = sub.endpoint;
    await sub.unsubscribe();
    sub = await subscribe(reg, settings, win);
  }
  await api.post('/api/me/push/on', { ...deviceBody(sub), ...(replaces ? { replaces } : {}) });
  return 'on';
}

/** Turn on for this device. Call straight from the tap: iPhones only ask then. */
export async function turnOn(win, api, settings) {
  const asked = win.Notification.requestPermission(); // first, before anything else waits
  const reg = await registration(win);
  const answer = await asked;
  if (answer === 'denied') return 'blocked';
  if (answer !== 'granted') return 'off';
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options?.applicationServerKey, settings.publicKey, win)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await subscribe(reg, settings, win);
  await api.post('/api/me/push/on', deviceBody(sub));
  return 'on';
}

/** This device's push address, or null. */
export async function endpoint(win) {
  const reg = await existing(win);
  try { return (await reg?.pushManager?.getSubscription())?.endpoint ?? null; } catch { return null; }
}

/** Turn off for this device. */
export async function turnOff(win, api) {
  const reg = await existing(win);
  const sub = await reg?.pushManager?.getSubscription();
  if (sub) {
    const { endpoint: address } = sub;
    await sub.unsubscribe();
    await api.post('/api/me/push/off', { endpoint: address });
  }
  return 'off';
}

/** Before logging out: stop this device and hand back its address for the server. Never throws. */
export async function forLogout(win) {
  try {
    const reg = await existing(win);
    const sub = await reg?.pushManager?.getSubscription();
    if (!sub) return undefined;
    const address = sub.endpoint;
    await sub.unsubscribe();
    return address;
  } catch { return undefined; }
}

/** "Send me a test" to this device. */
export async function sendTest(win, api) {
  const address = await endpoint(win);
  return api.post('/api/me/push/test', { endpoint: address ?? '' });
}

/** The My schedule card, once dismissed on this device, stays away. */
export function cardDismissed(win) {
  try { return win?.localStorage?.getItem(CARD_KEY) === 'dismissed'; } catch { return false; }
}

export function dismissCard(win) {
  try { win?.localStorage?.setItem(CARD_KEY, 'dismissed'); } catch { /* private mode: it just comes back */ }
}

/** Whether the My schedule card should invite this person to turn notifications on. */
export function showCard(push, win) {
  if (!push?.enabled || push.status !== 'off') return false;
  if (push.support !== 'ok' && push.support !== 'ios-install') return false;
  return !cardDismissed(win);
}
