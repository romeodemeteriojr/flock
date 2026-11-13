// Motion and touch: swipe to dismiss (web/lib/swipe.js), the success moment,
// and the page fade (web/app.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { swipeToDismiss, DISMISS_SHARE, FLICK_PX_PER_MS } from '../web/lib/swipe.js';
import * as sched from '../web/views/my-schedule.js';
import { textOf } from './helpers/fakepage.js';

function fakeSheet({ height = 400, scrollTop = 0 } = {}) {
  const handlers = {};
  const classes = new Set();
  const props = new Map();
  const sheet = {
    classes, props, captured: null,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) },
    getBoundingClientRect: () => ({ height }),
    querySelector: (sel) => (sel.includes('.sheet-body') ? { scrollTop } : null),
    setPointerCapture(id) { this.captured = id; },
    addEventListener: (t, fn) => { handlers[t] = fn; },
    removeEventListener: (t) => { delete handlers[t]; },
    handlers,
  };
  return sheet;
}
const on = (part) => ({ closest: (sel) => (sel.split(',').map((x) => x.trim()).includes(part) ? {} : null) });
const phone = (narrow = true) => ({ matchMedia: () => ({ matches: narrow }) });
const ev = (target, y, t, id = 1) => ({ target, clientY: y, timeStamp: t, pointerId: id, button: 0 });

test('a slow drag past 30% of the height closes the sheet', () => {
  const s = fakeSheet();
  let closed = 0;
  swipeToDismiss(s, { win: phone(), onDismiss: () => closed++ });
  s.handlers.pointerdown(ev(on('.sheet-grab'), 100, 0));
  assert.ok(s.classes.has('is-dragging'));
  assert.equal(s.captured, 1);
  s.handlers.pointermove(ev(null, 160, 400));
  assert.equal(s.props.get('--sheet-drag'), '60px', 'the sheet follows the finger');
  s.handlers.pointermove(ev(null, 100 + 400 * DISMISS_SHARE + 10, 1000));
  s.handlers.pointerup(ev(null, 100 + 400 * DISMISS_SHARE + 10, 1100));
  assert.equal(closed, 1);
  assert.ok(!s.classes.has('is-dragging'));
  assert.equal(s.props.has('--sheet-drag'), false);
});

test('a short slow drag settles back; a quick flick closes', () => {
  const s = fakeSheet();
  let closed = 0;
  swipeToDismiss(s, { win: phone(), onDismiss: () => closed++ });
  s.handlers.pointerdown(ev(on('.sheet-head'), 100, 0));
  s.handlers.pointermove(ev(null, 140, 500));
  s.handlers.pointerup(ev(null, 140, 600));
  assert.equal(closed, 0);
  assert.ok(s.classes.has('is-settling'));
  assert.equal(s.props.get('--sheet-drag'), '0px');

  s.handlers.pointerdown(ev(on('.sheet-grab'), 100, 1000));
  assert.ok(!s.classes.has('is-settling'));
  s.handlers.pointermove(ev(null, 110, 1010));
  s.handlers.pointermove(ev(null, 110 + (FLICK_PX_PER_MS + 0.5) * 20, 1030));
  s.handlers.pointerup(ev(null, 130, 1031));
  assert.equal(closed, 1, 'fast enough');
});

test('dragging up never moves the sheet up; cancel settles back', () => {
  const s = fakeSheet();
  swipeToDismiss(s, { win: phone(), onDismiss: () => assert.fail('should not close') });
  s.handlers.pointerdown(ev(on('.sheet-grab'), 300, 0));
  s.handlers.pointermove(ev(null, 200, 100));
  assert.equal(s.props.get('--sheet-drag'), '0px');
  s.handlers.pointercancel(ev(null, 200, 120));
  assert.ok(s.classes.has('is-settling'));
});

test('no swipe: on wide screens, from the list or a button, while the list is scrolled, or another finger', () => {
  let closed = 0;
  const tries = [
    [fakeSheet(), phone(false), on('.sheet-grab')],
    [fakeSheet(), phone(), on('.sheet-body')],
    [fakeSheet(), phone(), { closest: (sel) => (sel.includes('button') || sel.includes('.sheet-head') ? {} : null) }],
    [fakeSheet({ scrollTop: 40 }), phone(), on('.sheet-grab')],
    [fakeSheet(), undefined, on('.sheet-grab')],
  ];
  for (const [s, win, target] of tries) {
    swipeToDismiss(s, { win, onDismiss: () => closed++ });
    s.handlers.pointerdown(ev(target, 0, 0));
    s.handlers.pointermove(ev(null, 390, 10));
    s.handlers.pointerup(ev(null, 390, 20));
    assert.ok(!s.classes.has('is-dragging'));
    assert.equal(s.props.size, 0);
  }
  const s = fakeSheet();
  swipeToDismiss(s, { win: phone(), onDismiss: () => closed++ });
  s.handlers.pointerdown(ev(on('.sheet-grab'), 0, 0, 1));
  s.handlers.pointerup(ev(null, 390, 20, 2));
  assert.equal(closed, 0);
  assert.equal(typeof swipeToDismiss(null, {}), 'function');
  const off = swipeToDismiss(fakeSheet(), { win: phone() });
  off();
});

test('success moment: the card just confirmed shows the thank-you strip once', () => {
  const item = { slotId: 7, status: 'confirmed', date: '2026-11-15', time: '10:00', positionName: 'Sound', teamName: 'Tech', serviceTitle: 'Sunday service' };
  const view = { loading: false, today: '2026-11-13', data: { items: [item], nextServing: item }, openRosters: new Set() };
  const moment = sched.render({ user: { id: 2, name: 'Mary', role: 'member' } }, { ...view, celebrate: 7 });
  assert.match(moment, /class="card serve-card is-celebrating" data-slot="7"/);
  assert.match(moment, /<p class="serve-done"><span class="done-burst"><span class="icon" data-icon="check" aria-hidden="true"><\/span><\/span> You're confirmed\. Thank you!<\/p>/);
  assert.doesNotMatch(moment, /data-action="decline-ask"/, 'the strip takes the buttons\' place');
  const after = sched.render({ user: { id: 2, name: 'Mary', role: 'member' } }, view);
  assert.doesNotMatch(after, /is-celebrating|serve-done/);
  assert.match(textOf(after), /I can't make it after all/);
});

test('My schedule marks the accepted card, buzzes once, and clears the moment after that paint', () => {
  const src = readFileSync(new URL('../web/views/my-schedule.js', import.meta.url), 'utf8');
  assert.match(src, /if \(verb === 'accept'\) \{\s*view\.celebrate = id;\s*try \{ ctx\.win\?\.navigator\?\.vibrate\?\.\(12\); \}/);
  assert.match(src, /await load\(\);\s*view\.celebrate = null;/);
});

test('page change: the page fades in on a new route only; motion rules respect reduced motion', () => {
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(app, /if \(shownPath !== null && path !== shownPath\) main\.classList\.add\('is-entering'\);/);
  assert.match(app, /main\.addEventListener\('animationend', \(e\) => \{ if \(e\.target === main\) main\.classList\.remove\('is-entering'\); \}\);/);
  const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.main\.is-entering \{ animation: fade-in/);
  assert.doesNotMatch(css, /\.main(\.is-entering)? \{[^}]*transform/, 'no transform on .main');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  for (const sel of ['.serve-card:active', '.is-celebrating .done-burst path', '.sheet, .nav.is-open .nav-sub-wrap']) {
    assert.ok(reduced.slice(0, 1500).includes(sel), `${sel} is calmed under reduced motion`);
  }
});
