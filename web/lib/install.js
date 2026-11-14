// Putting Flock on the Home Screen. Two ways, depending on the browser:
//  - Where the browser offers an install prompt (beforeinstallprompt: Chrome,
//    Edge, Samsung Internet), we keep it and show it when the person taps Install.
//  - Everywhere else on a phone we show steps for that phone and browser
//    (installKind below, the steps in web/views/install-steps.js).
// Every browser part comes from `win`; nothing runs at import.
import { isIos, isStandalone, iosVersion } from './push.js';

const LATER_KEY = 'flock.install.later';

// Browsers inside other apps (a link tapped in Facebook, Instagram, Gmail…).
// They cannot add to the Home Screen: the page must be opened in the real browser first.
const IN_APP = /FBAN|FBAV|FBIOS|Instagram|Line\/|LinkedInApp|Twitter|Snapchat|TikTok|musical_ly|MicroMessenger|GSA\/|Messenger|Pinterest/;
// iPhone browsers other than Safari. They can add to the Home Screen from iOS 16.4.
const IOS_OTHER = /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|YaBrowser/;

/** Already opened from the Home Screen (or installed as an app window). */
export function isInstalled(win) {
  return isStandalone(win);
}

/**
 * Which steps put Flock on this device's Home Screen:
 *   'installed'      opened from the Home Screen already
 *   'ios-safari'     iPhone or iPad in Safari: Share (or ••• → Share), Add to Home Screen
 *   'ios-browser'    Chrome, Edge, Firefox… on an iPhone (iOS 16.4+): their Share menu
 *   'ios-inapp'      inside another app, or an older iPhone browser: open in Safari first
 *   'android'        Android browser with no install prompt: its menu, Add to Home screen
 *   'android-inapp'  inside another app on Android: open in Chrome first
 *   'other'          a computer: no steps (the browser's own prompt, if any)
 */
export function installKind(win) {
  if (isInstalled(win)) return 'installed';
  const nav = win?.navigator;
  const ua = String(nav?.userAgent ?? '');
  if (isIos(nav)) {
    if (IN_APP.test(ua)) return 'ios-inapp';
    if (IOS_OTHER.test(ua)) {
      const v = iosVersion(nav);
      return v && (v[0] < 16 || (v[0] === 16 && v[1] < 4)) ? 'ios-inapp' : 'ios-browser';
    }
    return 'ios-safari';
  }
  if (/Android/.test(ua)) return IN_APP.test(ua) || /; wv\)/.test(ua) ? 'android-inapp' : 'android';
  return 'other';
}

/** A phone that is not installed yet: there are steps to show. */
export function hasSteps(kind) {
  return kind !== 'installed' && kind !== 'other';
}

/** iPhone or iPad in Safari itself (other iOS browsers have their own menus). */
export function isIosSafari(win) {
  return installKind(win) === 'ios-safari';
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
  return !!install?.canPrompt?.() || hasSteps(installKind(win));
}

/** The person tapped "Not now" on the install card on this device. */
export function laterChosen(win) {
  try { return win?.localStorage?.getItem(LATER_KEY) === 'later'; } catch { return false; }
}

export function chooseLater(win) {
  try { win?.localStorage?.setItem(LATER_KEY, 'later'); } catch { /* private mode: it comes back */ }
}
