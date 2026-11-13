// Putting Flock on the Home Screen. Two ways, depending on the browser:
//  - Chrome, Edge, Samsung Internet (Android, desktop): the browser offers an
//    install prompt (beforeinstallprompt). We keep it and show it when the
//    person taps Install.
//  - iPhone and iPad in Safari: there is no prompt; we show the three steps
//    (Share, Add to Home Screen, Add).
// Every browser part comes from `win`; nothing runs at import.
import { isIos, isStandalone } from './push.js';

const LATER_KEY = 'flock.install.later';

/** Already opened from the Home Screen (or installed as an app window). */
export function isInstalled(win) {
  return isStandalone(win);
}

/** iPhone or iPad in Safari itself (other iOS browsers have their own menus). */
export function isIosSafari(win) {
  const nav = win?.navigator;
  if (!isIos(nav) || isInstalled(win)) return false;
  return !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(String(nav?.userAgent ?? ''));
}

/**
 * Listens for the browser's install prompt. canPrompt(): one is ready.
 * prompt(): shows it; 'accepted' | 'dismissed' | 'unavailable'. onChange(fn):
 * called when a prompt arrives or Flock gets installed; returns a function
 * that stops listening.
 */
export function createInstall(win) {
  let saved = null;
  const listeners = new Set();
  const changed = () => { for (const fn of [...listeners]) fn(); };
  win?.addEventListener?.('beforeinstallprompt', (e) => {
    e.preventDefault?.(); // ours to show, from the Install button
    saved = e;
    changed();
  });
  win?.addEventListener?.('appinstalled', () => {
    saved = null;
    changed();
  });
  return {
    canPrompt: () => !!saved,
    async prompt() {
      const e = saved;
      if (!e?.prompt) return 'unavailable';
      saved = null; // a prompt can be shown once
      try {
        await e.prompt();
        const choice = await e.userChoice;
        return choice?.outcome === 'accepted' ? 'accepted' : 'dismissed';
      } catch {
        return 'unavailable';
      } finally {
        changed();
      }
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

/** Can this device put Flock on its Home Screen right now? */
export function canInstall(install, win) {
  if (isInstalled(win)) return false;
  return !!install?.canPrompt?.() || isIosSafari(win);
}

/** The person tapped "Not now" on the install card on this device. */
export function laterChosen(win) {
  try { return win?.localStorage?.getItem(LATER_KEY) === 'later'; } catch { return false; }
}

export function chooseLater(win) {
  try { win?.localStorage?.setItem(LATER_KEY, 'later'); } catch { /* private mode: it comes back */ }
}
