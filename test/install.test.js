// Putting Flock on the Home Screen (web/lib/install.js, the install card, the iPhone steps).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstall, canInstall, isInstalled, isIosSafari, installKind, hasSteps, laterChosen, chooseLater } from '../web/lib/install.js';
import * as steps from '../web/views/install-steps.js';
import * as sched from '../web/views/my-schedule.js';
import { textOf } from './helpers/fakepage.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/122.0 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Mobile Safari/537.36';

function fakeWin({ ua = ANDROID, standalone = false, storage = new Map() } = {}) {
  const handlers = {};
  return {
    navigator: { userAgent: ua, standalone: ua === IPHONE && standalone ? true : undefined },
    matchMedia: (q) => ({ matches: standalone && q === '(display-mode: standalone)' }),
    addEventListener: (type, fn) => { handlers[type] = fn; },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    fire: (type, e = {}) => handlers[type]?.(e),
  };
}

const promptEvent = (outcome) => {
  const e = { prevented: false, shown: 0 };
  e.preventDefault = () => { e.prevented = true; };
  e.prompt = async () => { e.shown++; };
  e.userChoice = Promise.resolve({ outcome });
  return e;
};

test('the browser prompt is kept, shown on Install, and used once', async () => {
  const win = fakeWin();
  const install = createInstall(win);
  const changes = [];
  install.onChange(() => changes.push(install.canPrompt()));
  assert.equal(install.canPrompt(), false);
  assert.equal(canInstall(install, win), true, 'no prompt yet on Android: the steps instead');
  const computer = fakeWin({ ua: DESKTOP });
  assert.equal(canInstall(createInstall(computer), computer), false, 'a computer with no prompt: nothing to offer');
  assert.equal(await install.prompt(), 'unavailable');

  const e = promptEvent('accepted');
  win.fire('beforeinstallprompt', e);
  assert.ok(e.prevented, 'the browser does not show its own banner');
  assert.equal(canInstall(install, win), true);
  assert.equal(await install.prompt(), 'accepted');
  assert.equal(e.shown, 1);
  assert.equal(install.canPrompt(), false, 'a prompt can be shown once');

  win.fire('beforeinstallprompt', promptEvent('dismissed'));
  assert.equal(await install.prompt(), 'dismissed');
  win.fire('beforeinstallprompt', promptEvent('accepted'));
  win.fire('appinstalled');
  assert.equal(install.canPrompt(), false, 'installed: nothing to offer');
  assert.deepEqual(changes, [true, false, true, false, true, false]);

  const broken = promptEvent('accepted');
  broken.prompt = async () => { throw new Error('not allowed'); };
  win.fire('beforeinstallprompt', broken);
  assert.equal(await install.prompt(), 'unavailable');
});

test('iPhone in Safari gets the steps; other iPhone browsers, installed apps and Android do not', () => {
  assert.equal(isIosSafari(fakeWin({ ua: IPHONE })), true);
  assert.equal(isIosSafari(fakeWin({ ua: IPHONE_CHROME })), false);
  assert.equal(isIosSafari(fakeWin({ ua: IPHONE, standalone: true })), false);
  assert.equal(isIosSafari(fakeWin({ ua: ANDROID })), false);
  assert.equal(isIosSafari(undefined), false);
  assert.equal(canInstall(createInstall(fakeWin({ ua: IPHONE })), fakeWin({ ua: IPHONE })), true);
  const home = fakeWin({ ua: ANDROID, standalone: true });
  const install = createInstall(home);
  home.fire('beforeinstallprompt', promptEvent('accepted'));
  assert.equal(isInstalled(home), true);
  assert.equal(canInstall(install, home), false, 'already on the Home Screen');
});

test('"Not now" is remembered on this device, and private mode does not break it', () => {
  const win = fakeWin();
  assert.equal(laterChosen(win), false);
  chooseLater(win);
  assert.equal(laterChosen(win), true);
  const locked = { localStorage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } };
  assert.equal(laterChosen(locked), false);
  chooseLater(locked);
});

test('every kind of phone gets its own install steps', () => {
  const kind = (ua, extra) => installKind(fakeWin({ ua, ...extra }));
  const IOS = (v, tail = 'Version/17.4 Mobile/15E148 Safari/604.1') => `Mozilla/5.0 (iPhone; CPU iPhone OS ${v} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ${tail}`;
  assert.equal(kind(IPHONE), 'ios-safari');
  assert.equal(kind(IOS('27_0_1', 'Version/27.0 Mobile/15E148 Safari/604.1')), 'ios-safari', 'iOS 27 (iPhone 11)');
  assert.equal(installKind({ navigator: { userAgent: DESKTOP.replace('Chrome/122.0 ', 'Version/17.4 '), platform: 'MacIntel', maxTouchPoints: 5 }, matchMedia: () => ({ matches: false }) }), 'ios-safari', 'an iPad asks for the desktop page');
  assert.equal(kind(IPHONE_CHROME), 'ios-browser');
  assert.equal(kind(IOS('17_4', 'FxiOS/124.0 Mobile/15E148 Safari/605.1.15')), 'ios-browser');
  assert.equal(kind(IOS('17_4', 'EdgiOS/122.0 Mobile/15E148 Safari/605.1.15')), 'ios-browser');
  assert.equal(kind(IOS('16_1', 'CriOS/110.0 Mobile/15E148 Safari/604.1')), 'ios-inapp', 'before iOS 16.4 only Safari can');
  assert.equal(kind(IOS('17_4', 'Mobile/15E148 [FBAN/FBIOS;FBAV/450.0]')), 'ios-inapp');
  assert.equal(kind(IOS('17_4', 'Mobile/15E148 Instagram 320.0')), 'ios-inapp');
  assert.equal(kind(IOS('17_4', 'GSA/300.0 Mobile/15E148 Safari/604.1')), 'ios-inapp', 'the Google app');
  assert.equal(kind(ANDROID), 'android');
  assert.equal(kind('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0 Mobile Safari/537.36'), 'android');
  assert.equal(kind('Mozilla/5.0 (Android 14; Mobile; rv:124.0) Gecko/124.0 Firefox/124.0'), 'android');
  assert.equal(kind('Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0 Mobile Safari/537.36'), 'android-inapp');
  assert.equal(kind(ANDROID + ' [FB_IAB/FB4A;FBAV/450.0]'), 'android-inapp');
  assert.equal(kind(DESKTOP), 'other');
  assert.equal(kind(IPHONE, { standalone: true }), 'installed');
  assert.equal(installKind(undefined), 'other');
  for (const k of ['ios-safari', 'ios-browser', 'ios-inapp', 'android', 'android-inapp']) assert.equal(hasSteps(k), true, k);
  for (const k of ['installed', 'other']) assert.equal(hasSteps(k), false, k);
});

test('the steps sheet: words for each phone, the ••• fallback, Copy link where it must move browser', () => {
  assert.equal(steps.render({}), '');
  assert.equal(steps.render({ installSteps: 'other' }), '', 'a computer has no steps');
  const text = (kind) => textOf(steps.render({ installSteps: kind })).replace(/\s+/g, ' ').trim();
  const safari = steps.render({ installSteps: 'ios-safari' });
  assert.match(safari, /role="dialog" aria-modal="true" aria-labelledby="install-title"/);
  assert.match(safari, /<h2 id="install-title" tabindex="-1">Add Flock to your Home Screen<\/h2>/);
  assert.equal(text('ios-safari').slice(text('ios-safari').indexOf('1')),
    "1Tap Share in Safari's toolbar. No Share button? Tap ••• first, then Share. 2Scroll down and tap Add to Home Screen. Not in the list? Tap View More or More at the bottom. 3Leave Open as Web App on if you see it, then tap Add. 4Open Flock from your Home Screen and log in.");
  for (const icon of ['share', 'add-square', 'check', 'flock']) assert.match(safari, new RegExp(`data-icon="${icon}"`));
  assert.equal((safari.match(/data-action="install-close"/g) || []).length, 2);
  assert.doesNotMatch(safari, /install-copy/);
  assert.match(text('ios-browser'), /Tap Share\. It's next to the address bar, or in the browser's menu/);
  assert.match(text('ios-inapp'), /^Open Flock in Safari first .*Open in Safari.*Copy link.*paste it in the address bar/);
  assert.match(steps.render({ installSteps: 'ios-inapp' }), /data-action="install-copy"/);
  assert.match(text('android'), /Tap the browser's menu: ⋮ .*Add to Home screen or Install app.*Samsung Internet: Add page to, then Home screen/);
  assert.match(steps.render({ installSteps: 'android' }), /data-icon="more-vertical"/);
  assert.match(text('android-inapp'), /^Open Flock in Chrome first .*Open in Chrome.*Copy link/);
  assert.match(steps.render({ installSteps: 'android-inapp' }), /data-action="install-copy"/);
});

test('My schedule: the install card shows when it can, one invitation at a time', () => {
  const base = { loading: false, data: { items: [] }, today: '2026-11-13' };
  const page = (view) => sched.render({ user: { id: 2, name: 'Mary', role: 'member' } }, { ...base, ...view });
  assert.doesNotMatch(page({}), /data-install-card/);
  const card = page({ showInstall: true });
  assert.match(card, /<section class="card install-card" aria-label="Install Flock" data-install-card>/);
  assert.match(textOf(card), /Put Flock on your Home Screen It opens like an app, one tap away\. Install Not now/);
  assert.doesNotMatch(textOf(card), /notification/i, 'one thing at a time: installing, not notifications');
  assert.match(page({ showInstall: true, steps: true }), /data-action="install"[^>]*>Show me how</);
  const both = page({ showInstall: true, showPush: true });
  assert.match(both, /data-install-card/, 'installing goes first');
  assert.doesNotMatch(both, /push-invite/, 'one invitation at a time');
  assert.match(page({ showPush: true }), /push-invite/, 'notifications once installed (or install declined)');
});
