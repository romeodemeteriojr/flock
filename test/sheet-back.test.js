// The phone's Back button closes an open sheet instead of leaving the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { backStep } from '../web/lib/sheet.js';

function fakeWin() {
  const listeners = {};
  const stack = [{ state: null, href: 'x/#/schedule' }];
  let at = 0;
  const win = {
    location: {
      get href() { return stack[at].href; },
      set hash(h) { win.goTo(`x/${h}`); },
      replace(h) { stack[at] = { state: null, href: `x/${h}` }; win.fire('hashchange'); },
    },
    addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); },
    fire: (t) => (listeners[t] ?? []).forEach((fn) => fn({})),
    history: {
      get state() { return stack[at].state; },
      pushState(state, _t, href) { stack.splice(at + 1); stack.push({ state, href }); at++; },
      back() { at--; win.fire('popstate'); },
    },
    pressBack() { at--; win.fire('popstate'); },
    goTo(href) { stack.splice(at + 1); stack.push({ state: null, href }); at++; win.fire('hashchange'); },
    get depth() { return at; },
    get href() { return stack[at].href; },
    hrefAt: (i) => stack[i].href,
  };
  return win;
}

function sheet(win) {
  let open = false;
  let closes = 0;
  const step = backStep(win, {}, () => open, () => { closes++; open = false; step.closed(); });
  return {
    open() { open = true; step.opened(); },
    closeByButton() { open = false; step.closed(); },
    closeByLink(to) { open = false; step.closed(to); },
    get closes() { return closes; },
    get isOpen() { return open; },
  };
}

test('Back closes an open sheet and stays on the page', () => {
  const win = fakeWin();
  const s = sheet(win);
  s.open();
  assert.equal(win.depth, 1, 'opening adds one history step');
  win.pressBack();
  assert.equal(s.isOpen, false);
  assert.equal(s.closes, 1);
  assert.equal(win.depth, 0, 'back on the page itself');
});

test('closing with a button takes the step off, so the next Back leaves the page', () => {
  const win = fakeWin();
  const s = sheet(win);
  s.open();
  s.closeByButton();
  assert.equal(win.depth, 0);
  assert.equal(s.closes, 0, 'our own back does not close twice');
  s.open();
  assert.equal(win.depth, 1, 'opening again adds a fresh step');
});

test('a link in the sheet goes to its page, and Back from there returns to the page under it', () => {
  const win = fakeWin();
  const s = sheet(win);
  s.open();
  s.closeByLink('#/notifications');
  assert.equal(win.href, 'x/#/notifications', 'the link is followed, not undone by stepping back');
  assert.equal(win.depth, 1, 'the sheet step became the new page: no extra step');
  assert.equal(win.hrefAt(0), 'x/#/schedule');
  win.pressBack();
  assert.equal(win.href, 'x/#/schedule');
  assert.equal(s.closes, 0);
});

test('without its step (already gone), a link still goes to its page', () => {
  const win = fakeWin();
  const s = sheet(win);
  s.closeByLink('#/password');
  assert.equal(win.href, 'x/#/password');
  const bare = { location: {} };
  backStep(bare, {}, () => false, () => {}).closed('#/password');
  assert.equal(bare.location.hash, '#/password', 'no history API: a plain hash change');
});

test('a sheet left open when going to another page is never closed by a later Back', () => {
  const win = fakeWin();
  const s = sheet(win);
  s.open();
  win.goTo('x/#/gaps');
  win.pressBack();
  win.pressBack();
  assert.equal(s.closes, 0, 'the old page is gone: its sheet is left alone');
});

test('without history (tests, old browsers) nothing breaks', () => {
  const step = backStep({}, {}, () => true, () => {});
  step.opened(); step.closed();
  assert.ok(true);
});
