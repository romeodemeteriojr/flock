// Wide screens (1024px and up): side navigation and two panes (release 4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { host, watchHost, createSheet, WIDE } from '../web/lib/sheet.js';
import { createSlotPanel } from '../web/lib/slotpanel.js';
import * as gaps from '../web/views/admin-gaps.js';
import * as schedule from '../web/views/admin-schedule.js';
import * as people from '../web/views/admin-people.js';
import * as sched from '../web/views/my-schedule.js';
import * as account from '../web/views/account.js';

const winAt = (wide) => {
  const listeners = new Set();
  return {
    listeners,
    matchMedia: (q) => ({ matches: q === WIDE && wide, addEventListener: (t, fn) => listeners.add(fn), removeEventListener: (t, fn) => listeners.delete(fn) }),
  };
};

test('host: a pane at 1024px and up, else a layer; watchHost follows the width and can stop', () => {
  assert.equal(WIDE, '(min-width: 1024px)');
  assert.equal(host(winAt(true)), 'pane');
  assert.equal(host(winAt(false)), 'layer');
  assert.equal(host({}), 'layer');
  assert.equal(host(undefined), 'layer');
  assert.equal(host({ matchMedia: () => { throw new Error('no'); } }), 'layer');
  const w = winAt(true);
  let calls = 0;
  const stop = watchHost(w, () => calls++);
  assert.equal(w.listeners.size, 1);
  for (const fn of w.listeners) fn();
  assert.equal(calls, 1);
  stop();
  assert.equal(w.listeners.size, 0);
  assert.equal(typeof watchHost({}, () => {}), 'function');
});

test('a sheet in a pane does not trap Tab; Escape still closes it', () => {
  const handlers = {};
  const root = { addEventListener: (t, fn) => { handlers[t] = fn; }, querySelector: () => null };
  let closed = 0;
  let modal = false;
  createSheet({ root, isOpen: () => true, close: () => closed++, modal: () => modal });
  let prevented = false;
  handlers.keydown({ key: 'Tab', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  handlers.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(closed, 1);
  modal = true; // a layer: the trap applies (nothing focusable here, so it simply returns)
  handlers.keydown({ key: 'Tab', preventDefault() {} });
});

const SLOT = { id: 4, positionName: 'Keys', teamName: 'Band', date: '2026-11-15', time: '09:00', personId: null, status: 'open' };

test('the slot panel in a pane: the same section, no layer, not a modal dialog', () => {
  const panel = createSlotPanel({ api: { get: () => new Promise(() => {}) }, paint: () => {} });
  panel.open(SLOT);
  const layer = String(panel.render());
  const pane = String(panel.render({ pane: true }));
  assert.match(layer, /^<div class="sheet-layer/);
  assert.match(layer, /role="dialog" aria-modal="true"/);
  assert.match(pane, /^<section class="sheet slot-panel" data-slot-panel="4" aria-labelledby="slot-panel-title"/);
  assert.doesNotMatch(pane, /sheet-layer|sheet-backdrop|aria-modal/);
});

const GAP = { type: 'open', slotId: 4, date: '2026-11-15', time: '09:00', serviceTitle: 'Sunday service', positionName: 'Keys', teamName: 'Band' };
const gm = (x = {}) => ({ loading: false, error: '', notice: '', summary: {}, items: [GAP], tab: 'gaps', filter: 'all', reminders: { weekOf: '2026-11-13', list: null }, ...x });

test('gaps on a wide screen: the list and a pane; the picked position is marked', () => {
  assert.doesNotMatch(gaps.renderScreen(gm()), /class="split"/, 'phones and tablets: no panes');
  const empty = gaps.renderScreen(gm({ wide: true }));
  assert.match(empty, /<div class="split"><div>[\s\S]*<\/div><aside class="card pane" aria-label="Position"><p class="pane-empty">.*Choose a position\.<\/p><\/aside><\/div>/);
  const picked = gaps.renderScreen(gm({ wide: true, current: 4 }), '', '<section class="sheet slot-panel" data-slot-panel="4"></section>');
  assert.match(picked, /data-action="slot-open" data-id="4" aria-current="true"/);
  assert.match(picked, /<aside class="card pane" aria-label="Position"><section class="sheet slot-panel"/);
  assert.doesNotMatch(gaps.renderScreen(gm({ wide: true, tab: 'reminders' })), /class="split"/, 'reminders use the full width');
});

test('schedule on a wide screen: grid and fill card on the left, the slot panel docked on the right', () => {
  const svc = { id: 1, date: '2026-11-15', time: '09:00', title: 'Sunday service', slots: [{ id: 4, positionId: 10, positionName: 'Keys', teamId: 1, teamName: 'Band', personId: null, status: 'open' }] };
  const m = { services: [svc], teams: [], loading: false, error: '', notice: '', today: '2026-11-13', from: '2026-11-13', to: '2027-01-07', open: new Set(), autofill: { weekOf: '2026-11-16', weeks: 1 }, wide: true, current: 4 };
  const h = schedule.renderScreen(m, '', '<section class="sheet slot-panel" data-slot-panel="4"></section>');
  assert.match(h, /<div class="split split-wide"><div><p class="hint sched-range">/);
  assert.match(h, /data-action="slot-open" data-id="4" aria-label="Nobody yet, choose someone" aria-current="true"/);
  assert.match(schedule.renderScreen({ ...m, current: null }), /Choose a position\./);
});

const P = (id, name, extra = {}) => ({ id, name, email: `${name.toLowerCase()}@example.com`, role: 'member', active: true, joined: true, positionIds: [], ...extra });

test('people on a wide screen: the list and the person in a pane (not a layer); Add stays a sheet', () => {
  const base = { people: [P(1, 'Ann'), P(2, 'Bo')], teams: [], query: '', loading: false, adding: false, newName: '', panel: null, invite: null, error: '', notice: '', me: 9, filter: 'all', wide: true };
  const none = people.renderScreen({ ...base, selected: null });
  assert.match(none, /<aside class="card pane" aria-label="Person"><p class="pane-empty">.*Choose a person\.<\/p><\/aside>/);
  const bo = people.renderScreen({ ...base, selected: 2 });
  assert.match(bo, /<aside class="card pane" aria-label="Bo"><section class="sheet person-sheet" data-person-panel="2" aria-labelledby="person-name">/);
  assert.doesNotMatch(bo, /data-person-sheet|aria-modal/);
  assert.match(bo, /data-action="select" data-id="2" aria-current="true"/);
  assert.doesNotMatch(bo, /data-action="select" data-id="\d+" aria-haspopup/, 'rows open a pane, not a dialog');
  const adding = people.renderScreen({ ...base, selected: null, adding: true });
  assert.match(adding, /data-add-sheet[\s\S]*role="dialog" aria-modal="true"/);
});

test('my schedule on a wide screen: the hero on the left, what comes up in a pane on the right', () => {
  const item = (o) => ({ slotId: 1, date: '2026-11-15', time: '09:00', serviceTitle: 'S', positionName: 'Sound', teamName: 'Tech', status: 'pending', coVolunteers: [], ...o });
  const data = { nextServing: null, items: [item(), item({ slotId: 2, status: 'accepted', date: '2026-11-22' })] };
  const h = sched.render({}, { loading: false, today: '2026-11-13', data, wide: true, openRosters: new Set(), openCards: new Set() });
  assert.match(h, /<div class="split split-wide"><div><section class="hero hero-next"/);
  assert.match(h, /<aside class="pane" aria-label="Coming up"><h2 class="section-title pane-title">Coming up<\/h2><ul class="cards">.*data-slot="2"/s);
  assert.doesNotMatch(sched.render({}, { loading: false, today: '2026-11-13', data, openRosters: new Set(), openCards: new Set() }), /class="split/);
});

test('account: a small menu above the button on wide screens', () => {
  const state = { user: { id: 1, name: 'Ann', role: 'admin', email: 'a@example.com' }, accountOpen: true };
  assert.match(account.render(state, { pop: true }), /<div class="sheet-layer is-entering account-pop" data-account-sheet>/);
  assert.doesNotMatch(account.render(state), /account-pop/);
});

test('wide-screen CSS: a side column only when there is a menu, and the layer takes no room', () => {
  const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  const wide = css.slice(css.indexOf('@media (min-width: 1024px)'));
  assert.match(css, /#layer \{ display: contents; \}/);
  assert.match(wide, /#app \{ display: grid; grid-template-columns: 256px minmax\(0, 1fr\);/);
  assert.match(wide, /#app:has\(\.top:empty\) \{ display: block; \}/, 'login and offline pages are not squeezed into the side column');
  assert.match(wide, /\.pane \.sheet \{ position: static;/);
});
