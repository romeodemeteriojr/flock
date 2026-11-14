// The phone's Back button closes an open sheet instead of leaving the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { backStep } from '../web/lib/sheet.js';

function fakeWin() {
  const listeners = {};
  const stack = [{ state: null, href: 'x/#/schedule' }];
  let at = 0;
  const win = {
    location: { get href() { return stack[at].href; } },
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
