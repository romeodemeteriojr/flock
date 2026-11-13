// Problems and "done" news on the scheduler pages: always on screen, never
// brought back by a later repaint, and gone once the person starts fixing it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeRoot, fakeApi, tick } from './helpers/fakeui.js';
import { createNoticeClock, dropProblem, OK_MS } from '../web/lib/toast.js';
import * as teams from '../web/views/admin-teams.js';
import * as services from '../web/views/admin-services.js';
import * as people from '../web/views/admin-people.js';
import * as schedule from '../web/views/admin-schedule.js';
import * as gaps from '../web/views/admin-gaps.js';

const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');

test('notice clock: a notice shows until it has faded, then stays gone on repaints', () => {
  let t = 1000;
  const clock = createNoticeClock({ now: () => t });
  assert.equal(clock.keep('Team added.'), 'Team added.');
  t += 2000;
  assert.equal(clock.keep('Team added.'), 'Team added.', 'still fading');
  t += OK_MS;
  assert.equal(clock.keep('Team added.'), '', 'faded: not shown again');
  assert.equal(clock.keep('Position added.'), 'Position added.', 'new news shows');
  assert.equal(clock.keep(''), '');
  assert.equal(clock.keep('Position added.'), 'Position added.', 'the same words again after a gap are new news');
});

test('notice clock: a repaint carries the fade on instead of starting it again', () => {
  let t = 0;
  const clock = createNoticeClock({ now: () => t });
  const toastEl = { style: {} };
  const root = { querySelectorAll: (sel) => (sel === '.toast-stack .toast-ok' ? [toastEl] : []) };
  clock.keep('Saved.');
  clock.resume(root);
  assert.equal(toastEl.style.animationDelay, undefined, 'a fresh toast animates normally');
  t = 1500;
  clock.keep('Saved.');
  clock.resume(root);
  assert.equal(toastEl.style.animationDelay, `-1500ms, ${OK_MS - 1500}ms`);
});

test('dropProblem takes the problem toast and an empty stack away', () => {
  const stack = { children: [], removed: false, remove() { this.removed = true; } };
  const err = { parentNode: stack, removed: false, remove() { this.removed = true; } };
  dropProblem({ querySelectorAll: () => [err] });
  assert.ok(err.removed && stack.removed);
});

// Each scheduler page: a problem is a toast (fixed on screen), not a line at
// the top of a long page; typing clears it.
const PAGES = [
  ['teams', teams, { 'GET /api/teams': [] }, (root) => root.submit('add-team', { name: ' ' })],
  ['people', people, { 'GET /api/people': [], 'GET /api/teams': [] }, (root) => { root.click('add-open'); root.submit('add-person', { name: ' ', email: '', scheduler: false }); }],
];
for (const [name, view, routes, fail] of PAGES) {
  test(`${name}: a form problem shows as a toast and goes once you type`, async () => {
    const root = fakeRoot();
    view.createScreen({ api: fakeApi(routes), root, ctx: {}, win: { matchMedia: () => ({ matches: false }) } });
    await tick(); await tick();
    fail(root);
    await tick(); await tick();
    assert.match(root.innerHTML, /<div class="toast-stack"><div class="toast toast-error" role="alert"[^>]*>.*Please type a name\./s);
    assert.doesNotMatch(root.innerHTML, /form-error/);
    const asked = [];
    root.querySelectorAll = (sel) => { asked.push(sel); return []; };
    root.fire('input', { closest: () => null });
    assert.deepEqual(asked, ['.toast-stack .toast-error'], 'typing takes the problem toast away');
    root.fire('input', { closest: () => null });
    assert.equal(asked.length, 1, 'and only once: the problem is cleared');
  });
}

test('no scheduler page puts a problem line at the top of the page any more', () => {
  for (const f of ['teams', 'services', 'people', 'schedule', 'gaps']) {
    const src = readFileSync(new URL(`../web/views/admin-${f}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /form-error" role="alert">\$\{m\.error\}/, f);
    assert.match(src, /toasts\(\[\[m\.notice, 'ok'\], \[m\.error, 'error'\]\]\)/, f);
    assert.match(src, /createNoticeClock\(\)/, f);
    assert.match(src, /dropProblem\(root\)/, f);
  }
  assert.ok(services && schedule && gaps);
});

test('CSS: toasts sit over an open sheet, at its top; scrolled-to boxes clear the top bar', () => {
  assert.match(css, /body:has\(\.sheet-layer:not\(\.gallery-frame \.sheet-layer\)\) \.toast-stack \{ z-index: 55; bottom: auto; top:/);
  assert.match(css, /html \{ scroll-padding-top: calc\(52px/);
});

test('CSS: a long unbroken name wraps instead of pushing the page sideways', () => {
  assert.match(css, /body \{[^}]*overflow-wrap: break-word;/);
  assert.match(css, /\.fieldset \{\s*min-width: 0;/, 'a fieldset can shrink below its longest word');
  assert.match(css, /\.fieldset legend \{[^}]*overflow-wrap: anywhere;/);
  assert.match(css, /\.pos-pick \{[^}]*grid-template-columns: minmax\(0, 1fr\) 7rem;/);
  assert.match(css, /\.slot-btn > \* \{ max-width: 100%; overflow-wrap: anywhere; \}/);
  assert.match(css, /\.menu-text \{[^}]*min-width: 0; overflow-wrap: anywhere;/);
  assert.match(css, /\.account-text \{[^}]*min-width: 0; overflow-wrap: anywhere;/);
});
