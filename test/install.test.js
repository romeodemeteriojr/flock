// Putting Flock on the Home Screen (web/lib/install.js, the install card, the iPhone steps).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstall, canInstall, isInstalled, isIosSafari, laterChosen, chooseLater } from '../web/lib/install.js';
import * as steps from '../web/views/install-steps.js';
import * as sched from '../web/views/my-schedule.js';
import { textOf } from './helpers/fakepage.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/122.0 Mobile/15E148 Safari/604.1';
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
  assert.equal(canInstall(install, win), false, 'no prompt yet, not an iPhone');
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

test('the iPhone steps: Share, Add to Home Screen, Add', () => {
  assert.equal(steps.render({}), '');
  const s = steps.render({ installSteps: true });
  assert.match(s, /role="dialog" aria-modal="true" aria-labelledby="install-title"/);
  assert.match(s, /<h2 id="install-title" tabindex="-1">Add Flock to your Home Screen<\/h2>/);
  assert.equal(textOf(s.slice(s.indexOf('<ol'))).replace(/\s+/g, ' ').trim(),
    "1Tap Share in Safari's toolbar. 2Scroll down and choose Add to Home Screen. 3Tap Add. Then open Flock from your Home Screen.");
  for (const icon of ['share', 'add-square', 'check']) assert.match(s, new RegExp(`data-icon="${icon}"`));
  assert.equal((s.match(/data-action="install-close"/g) || []).length, 2);
});

test('My schedule: the install card shows when it can, one invitation at a time', () => {
  const base = { loading: false, data: { items: [] }, today: '2026-11-13' };
  const page = (view) => sched.render({ user: { id: 2, name: 'Mary', role: 'member' } }, { ...base, ...view });
  assert.doesNotMatch(page({}), /data-install-card/);
  const card = page({ showInstall: true });
  assert.match(card, /<section class="card install-card" aria-label="Install Flock" data-install-card>/);
  assert.match(textOf(card), /Put Flock on your Home Screen Opens like an app, and you can get notifications\. Install Not now/);
  assert.match(page({ showInstall: true, iosSteps: true }), /data-action="install"[^>]*>Show me how</);
  assert.doesNotMatch(page({ showInstall: true, showPush: true }), /data-install-card/, 'the notifications card goes first');
});
