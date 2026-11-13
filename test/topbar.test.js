// The slim top bar shows the page title once the page's heading scrolls under it (web/lib/topbar.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { headingIsUnder, watchScroll } from '../web/lib/topbar.js';

function scene({ barBottom = 52, headingBottom = 120 } = {}) {
  const classes = new Set();
  const h1 = { getBoundingClientRect: () => ({ bottom: headingBottom }) };
  const top = {
    getBoundingClientRect: () => ({ bottom: barBottom }),
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
  };
  const main = { querySelector: (sel) => (sel === 'h1' ? scene.h1 ?? h1 : null) };
  const listeners = {};
  const frames = [];
  const win = {
    addEventListener: (type, fn, opts) => { listeners[type] = { fn, opts }; },
    requestAnimationFrame: (fn) => frames.push(fn),
  };
  return {
    top, main, win, listeners, classes,
    move: (bottom) => { headingBottom = bottom; },
    frame: () => { const f = frames.splice(0); f.forEach((fn) => fn()); return f.length; },
  };
}

test('the heading counts as under the bar once its bottom edge passes the bar', () => {
  const s = scene();
  assert.equal(headingIsUnder(s.top, s.main), false);
  s.move(52);
  assert.equal(headingIsUnder(s.top, s.main), true);
  s.move(-200);
  assert.equal(headingIsUnder(s.top, s.main), true);
  assert.equal(headingIsUnder(s.top, { querySelector: () => null }), false, 'a page with no heading');
  assert.equal(headingIsUnder(null, null), false);
});

test('scrolling toggles is-scrolled once per frame, and the check after a page change resets it', () => {
  const s = scene();
  const check = watchScroll(s.win, s.top, s.main);
  assert.deepEqual(s.listeners.scroll.opts, { passive: true });
  s.move(10);
  s.listeners.scroll.fn();
  s.listeners.scroll.fn();
  assert.equal(s.frame(), 1, 'one check per frame');
  assert.ok(s.classes.has('is-scrolled'));
  s.move(200);
  check();
  s.frame();
  assert.ok(!s.classes.has('is-scrolled'), 'a new page starts at the top');
  s.move(40);
  s.listeners.resize.fn();
  s.frame();
  assert.ok(s.classes.has('is-scrolled'));
});

test('without requestAnimationFrame it checks at once; without a window it does nothing', () => {
  const s = scene({ headingBottom: 0 });
  delete s.win.requestAnimationFrame;
  watchScroll(s.win, s.top, s.main)();
  assert.ok(s.classes.has('is-scrolled'));
  assert.equal(typeof watchScroll(undefined, s.top, s.main), 'function');
});
