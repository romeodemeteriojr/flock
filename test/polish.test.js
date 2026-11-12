// Design pass (C-68): the look and feel rules, guarded without a browser.
// Made-up names only. Reads files under web/ in this repo; nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contrast, palettes, resolveToken, hexToRgb } from './helpers/contrast.js';
import { fakeRoot, fakeApi } from './helpers/fakeui.js';
import { html } from '../web/lib/html.js';
import { icon, iconSlot, ICON_NAMES, ART_NAMES, hydrateIcons } from '../web/lib/icons.js';
import { avatar, avatarIndex, initials, AVATAR_COLOURS } from '../web/lib/avatar.js';
import { toast, toasts, TOAST_REGION, createToaster } from '../web/lib/toast.js';
import { skeleton, emptyState, pageHead } from '../web/lib/ui.js';
import { createSlotPanel, statusChip } from '../web/lib/slotpanel.js';
import { SHELL } from '../web/app.js';
import { createSheet } from '../web/lib/sheet.js';
import * as nav from '../web/views/nav.js';
import * as login from '../web/views/login.js';
import * as welcome from '../web/views/welcome.js';
import * as password from '../web/views/password.js';
import * as notFound from '../web/views/notfound.js';
import * as mySchedule from '../web/views/my-schedule.js';
import * as myBlockouts from '../web/views/my-blockouts.js';
import * as people from '../web/views/admin-people.js';
import * as teams from '../web/views/admin-teams.js';
import * as services from '../web/views/admin-services.js';
import * as schedule from '../web/views/admin-schedule.js';
import * as gaps from '../web/views/admin-gaps.js';
import { renderGallery, mountGallery, demoData } from '../web/gallery.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const CSS = readFileSync(path.join(WEB, 'style.css'), 'utf8');
const TODAY = '2026-11-08'; // a Sunday
const flush = () => new Promise((r) => setImmediate(r));

function webFiles(dir = WEB) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...webFiles(abs));
    else out.push(abs);
  }
  return out;
}
const rel = (f) => path.relative(WEB, f).split(path.sep).join('/');

// ---------- contrast ----------

// [foreground token, background token, minimum ratio, what it is]
const PAIRS = [
  ['--text', '--bg', 4.5, 'body text on the page'],
  ['--text', '--surface', 4.5, 'text on cards and sheets'],
  ['--text', '--surface-2', 4.5, 'text on soft panels and confirms'],
  ['--text', '--today-bg', 4.5, "text on today's row"],
  ['--text', '--danger-bg', 4.5, 'text in a danger confirm'],
  ['--text', '--warning-bg', 4.5, 'text in a warning notice'],
  ['--muted', '--bg', 4.5, 'muted text on the page'],
  ['--muted', '--surface', 4.5, 'muted text on cards'],
  ['--muted', '--surface-2', 4.5, 'muted text on soft panels (plain chips)'],
  ['--muted', '--today-bg', 4.5, "muted text on today's row"],
  ['--muted', '--bar-bg', 4.5, 'tab labels on the bar'],
  ['--accent-text', '--bg', 4.5, 'links on the page'],
  ['--accent-text', '--surface', 4.5, 'links on cards, current top tab'],
  ['--accent-text', '--bar-bg', 4.5, 'current tab on the bar'],
  ['--on-accent', '--accent', 4.5, 'primary button text (gradient start)'],
  ['--on-accent', '--accent-2', 4.5, 'primary button text (gradient end)'],
  ['--on-accent-soft', '--accent-soft', 4.5, 'current tab, info chips and notices, date tiles'],
  ['--on-hero', '--hero-from', 4.5, 'hero card text (gradient start)'],
  ['--on-hero', '--hero-to', 4.5, 'hero card text'],
  ['--on-hero', '--hero-badge', 4.5, 'hero badge and gallery links'],
  ['--on-brand', '--brand', 4.5, 'the mark on its tile'],
  ['--muted', '--surface-3', 4.5, 'plain chips and the choice bar'],
  ['--text', '--surface-3', 4.5, 'icon buttons'],
  ['--text', '--raised', 4.5, 'the chosen option in the choice bar'],
  ['--text', '--accent-soft', 4.5, 'text in an info notice'],
  ['--on-accent', '--accent', 3, 'empty-state check mark'],
  ['--success', '--success-bg', 4.5, 'success chip text'],
  ['--warning', '--warning-bg', 4.5, 'warning chip text'],
  ['--danger', '--danger-bg', 4.5, 'danger chip text and form errors'],
  ['--danger', '--surface', 4.5, 'danger button text'],
  ['--toast-text', '--toast-bg', 4.5, 'toast text'],
  ['--avatar-text', '--avatar-0', 4.5, 'avatar initials'],
  ...Array.from({ length: 11 }, (_, i) => ['--avatar-text', `--avatar-${i + 1}`, 4.5, 'avatar initials']),
  // Non-text: focus ring, field borders, status borders and icons need 3:1.
  ['--focus', '--bg', 3, 'focus ring on the page'],
  ['--focus', '--surface', 3, 'focus ring on cards'],
  ['--line-strong', '--surface', 3, 'input and button borders'],
  ['--line-strong', '--bg', 3, 'input borders on the page'],
  ['--accent', '--surface', 3, "today's border, password box border"],
  ['--warning', '--surface', 3, 'border of a card waiting for an answer'],
  ['--success', '--success-bg', 3, 'toast success icon'],
  ['--danger', '--danger-bg', 3, 'toast problem icon'],
];

test('contrast helper: WCAG maths', () => {
  assert.equal(contrast('#000000', '#ffffff').toFixed(1), '21.0');
  assert.equal(contrast('#fff', '#fff'), 1);
  assert.equal(contrast('#777777', '#ffffff').toFixed(2), '4.48');
  assert.deepEqual(hexToRgb('#0a0'), [0, 170, 0]);
  assert.throws(() => hexToRgb('red'));
});

for (const theme of ['light', 'dark']) {
  test(`contrast: every declared text/background pair passes in the ${theme} theme`, () => {
    const pal = palettes(CSS)[theme];
    const bad = [];
    for (const [fg, bg, min, what] of PAIRS) {
      const a = resolveToken(pal, fg);
      const b = resolveToken(pal, bg);
      assert.ok(a && b, `${fg} or ${bg} is not defined`);
      const r = contrast(a, b);
      if (r < min) bad.push(`${what}: ${fg} ${a} on ${bg} ${b} is ${r.toFixed(2)} (needs ${min})`);
    }
    assert.deepEqual(bad, []);
  });
}

test('contrast: the dark theme really changes the surfaces and text', () => {
  const { light, dark } = palettes(CSS);
  for (const t of ['--bg', '--surface', '--text', '--muted', '--accent-text']) assert.notEqual(light[t], dark[t], t);
});

// ---------- the stylesheet ----------

test('style.css: dark theme, reduced motion and print rules; only a bundled font URL', () => {
  assert.match(CSS, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  const rm = CSS.slice(CSS.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/));
  assert.ok(rm.length < CSS.length, 'has prefers-reduced-motion');
  assert.match(rm, /animation-duration:\s*0\.01ms\s*!important/);
  assert.match(rm, /transition-duration:\s*0\.01ms\s*!important/);
  assert.match(rm, /animation-iteration-count:\s*1\s*!important/);
  const print = CSS.slice(CSS.search(/@media print/));
  assert.match(print, /\.sched-grid\s*\{\s*display:\s*block/);
  assert.match(print, /#000/);
  assert.doesNotMatch(CSS, /@import/i);
  assert.doesNotMatch(CSS, /https?:|\/\/[a-z0-9]/i);
  const urls = [...CSS.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((m) => m[1]);
  assert.deepEqual(urls, ['/fonts/inter.woff2']);
  assert.equal(readFileSync(path.join(WEB, 'fonts/inter.woff2')).subarray(0, 4).toString(), 'wOF2');
  assert.match(CSS, /@font-face\s*\{[^}]*font-display:\s*swap/);
  assert.match(CSS, /font-weight:\s*100 900/);
  assert.match(readFileSync(path.join(WEB, '../licenses/Inter-OFL.txt'), 'utf8'), /SIL OPEN FONT LICENSE/);
});

test('style.css: Inter with system fallback, neutral rounded controls, 4px spacing, short transitions', () => {
  assert.match(CSS, /--font:\s*"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto/);
  assert.match(CSS, /font-variant-numeric:\s*tabular-nums/);
  const px = (name) => Number((new RegExp(`${name}:\\s*(\\d+)px`).exec(CSS) ?? [])[1]);
  assert.deepEqual(['--radius-sm', '--radius', '--radius-lg'].map(px), [8, 12, 16]);
  for (let i = 1; i <= 6; i++) assert.equal(px(`--s-${i}`), i * 4, `--s-${i}`);
  const ms = [...CSS.matchAll(/--(fast|med):\s*(\d+)ms/g)].map((m) => Number(m[2]));
  assert.ok(ms.length === 2 && ms.every((n) => n >= 120 && n <= 200), `transitions ${ms}`);
  assert.match(CSS, /\.btn:active\s*\{[^}]*scale\(0\.9\d\)/, 'press scales down slightly');
  assert.match(CSS, /\.btn-primary\s*\{[^}]*background:\s*var\(--accent\)/, 'flat primary button');
  assert.match(CSS, /\.hero\s*\{[^}]*background:\s*var\(--hero-from\)/, 'neutral hero');
  assert.doesNotMatch(CSS, /linear-gradient\(135deg/);
  assert.match(CSS, /backdrop-filter/, 'blurred top bar');
  assert.match(CSS, /@keyframes shimmer/, 'skeleton shimmer');
});

// Flattened rules: { sel: ['a', 'b'], body } (rules inside @media included).
const RULES = [...CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => ({ sel: m[1].trim().split(',').map((s) => s.trim()), body: m[2] }));
function toPx(v) {
  if (v.startsWith('var(')) v = resolveToken(palettes(CSS).light, v.slice(4, -1));
  return v.endsWith('rem') ? parseFloat(v) * 16.2 : parseFloat(v);
}

test('density: fonts and fine-pointer controls shrink by 10%; touch and hybrid targets do not', () => {
  const fontSize = Number(/html\s*\{\s*font-size:\s*([\d.]+)px/.exec(CSS)?.[1]);
  assert.equal(fontSize, 18 * 0.9);
  const fine = /@media \(hover: hover\) and \(pointer: fine\)\s*\{([^]*?)\n\}/.exec(CSS);
  const coarse = /@media \(any-pointer: coarse\)\s*\{([^]*?)\n\}/.exec(CSS);
  assert.ok(fine && coarse && coarse.index > fine.index, 'touch override follows mouse density');
  assert.equal(Number(/--control-size:\s*([\d.]+)px/.exec(fine[1])?.[1]), 48 * 0.9);
  assert.equal(Number(/--control-lg-size:\s*([\d.]+)px/.exec(fine[1])?.[1]), 56 * 0.9);
  assert.match(coarse[1], /--control-size:\s*48px/);
  assert.match(coarse[1], /--control-lg-size:\s*56px/);
});

test('tap targets: buttons, tabs, segments, fields and checkboxes are at least 48px tall', () => {
  for (const sel of ['.btn', '.nav-list a', '.nav-more', '.segment', '.icon-btn', '.toast-close', '.check', '.slot-btn',
    '.brand', 'input[type="text"]', 'input[type="date"]', 'select', '.gallery-toc a']) {
    const rule = RULES.find((r) => r.sel.includes(sel) && /(min-)?height:/.test(r.body));
    assert.ok(rule, `no size rule for ${sel}`);
    const v = /(?:min-height|(?<![-\w])height):\s*([\d.]+(?:px|rem)|var\(--[\w-]+\))/.exec(rule.body);
    assert.ok(v && toPx(v[1]) >= 48, `${sel} is ${v?.[1]}`);
  }
  assert.ok(RULES.some((r) => r.sel.includes('.icon-btn') && /width:\s*var\(--control-size\)/.test(r.body)), 'icon buttons use the shared target size');
  assert.equal(toPx('var(--control-size)'), 48);
});

test('focus ring is always visible and status never relies on colour alone', () => {
  const focus = RULES.find((r) => r.sel.includes(':focus-visible'));
  assert.match(focus.body, /outline:\s*3px solid var\(--focus\)/);
  for (const c of ['chip-ok', 'chip-wait', 'chip-bad', 'chip-open', 'chip-today']) {
    assert.match(CSS, new RegExp(`\\.${c}::before\\s*\\{\\s*content:\\s*"[^"]+"`), `${c} has a symbol`);
  }
  assert.match(CSS, /a\[aria-current="page"\]::after/, 'current tab has a bar, not just a colour');
  assert.match(CSS, /a\[aria-current="page"\] \.nav-label/, 'current tab label is underlined');
  assert.match(CSS, /\.segment\[aria-pressed="true"\]::before\s*\{\s*content:/, 'pressed segment has a tick');
});

// ---------- every class used is defined ----------

const TEAMS = [
  { id: 1, name: 'Band', positions: [{ id: 10, name: 'Drums', qualifiedPersonIds: [2] }, { id: 11, name: 'Keys', qualifiedPersonIds: [] }] },
  { id: 2, name: 'Empty team', positions: [] },
];
const slot = (id, positionId, extra = {}) => ({ id, positionId, positionName: positionId === 10 ? 'Drums' : 'Keys', teamId: 1, teamName: 'Band', status: 'open', personId: null, personName: null, ...extra });
const SERVICES = [
  { id: 1, date: TODAY, time: '09:00', title: 'Sunday service', slots: [slot(1, 10, { status: 'accepted', personId: 2, personName: 'Pat Demo' }), slot(2, 11, { status: 'pending', personId: 3, personName: 'Rue Sample' })] },
  { id: 2, date: '2026-11-15', time: '18:30', title: 'Evening', slots: [slot(3, 10, { status: 'declined', personId: 4, personName: 'Sol Example' })] },
  { id: 3, date: '2026-11-22', time: '09:00', title: 'Empty', slots: [] },
];
const PEOPLE = [
  { id: 1, name: 'Ari Admin', email: 'ari@example.com', role: 'admin', active: true, joined: true, positionIds: [] },
  { id: 2, name: 'Pat Demo', email: 'pat@example.com', role: 'member', active: true, joined: true, positionIds: [10] },
  { id: 3, name: 'Old Rue', email: 'rue@example.com', role: 'member', active: false, joined: false, positionIds: [] },
];
const ITEM = (o = {}) => ({ slotId: 1, date: '2026-11-08', time: '09:00', serviceTitle: 'Sunday service', positionName: 'Sound', teamName: 'Tech', status: 'pending', coVolunteers: [{ name: 'Pat Demo', positionName: 'Keys' }], ...o });
const CANDS = [{ personId: 2, name: 'Pat Demo', qualified: true, reasons: ['Has never served'] }, { personId: 5, name: 'Kit New', qualified: false, reasons: ['Not set up'] }];

function panelStates() {
  const out = [];
  const base = schedule.panelSlot(SERVICES[0].slots[0], SERVICES[0]);
  const states = [
    { loading: true }, { candidates: CANDS }, { candidates: [] }, { candidates: [], showAll: true },
    { candidates: CANDS, error: 'Person not found' }, { conflict: { code: 'blocked', personId: 2, message: 'Away. Assign anyway?', force: true } },
    { conflict: { code: 'past', personId: 2, message: 'Too late.', force: false } }, { removeAsk: true },
  ];
  for (const s of states) {
    const panel = createSlotPanel({ api: { get: () => new Promise(() => {}) }, paint: () => {} });
    panel.open(base);
    Object.assign(panel.state, { loading: false }, s);
    out.push(String(panel.render()));
  }
  const panel = createSlotPanel({ api: { get: () => new Promise(() => {}) }, paint: () => {} });
  panel.open({ ...gaps.gapSlot({ type: 'blocked', slotId: 9, personId: 2, personName: 'Pat Demo', date: TODAY, time: '09:00', serviceTitle: 'S', positionName: 'Drums', teamName: 'Band' }) });
  out.push(String(panel.render()));
  return out;
}

function allViewHtml() {
  const out = [];
  const add = (s) => out.push(String(s));
  // Shell, nav, simple pages.
  add(SHELL);
  for (const user of [{ id: 1, name: 'Ari Admin', role: 'admin' }, { id: 2, name: 'Pat Demo', role: 'member' }, { id: 3, name: 'New', role: 'member' }]) {
    for (const hash of ['#/', '#/blockouts', '#/schedule', '#/teams']) add(nav.render({ user }, hash));
  }
  add(login.render({})); add(login.render({}, { error: 'Wrong', username: 'x' }));
  add(password.render({ user: {} })); add(password.render({ user: {} }, { error: 'No' }));
  add(welcome.render({}));
  add(welcome.render({}, { info: { name: 'Pat Demo', email: 'pat.demo@example.com' } }));
  add(welcome.render({}, { error: 'This link has expired or was already used.' }));
  add(notFound.render({}));
  // My schedule, every state.
  const ms = (v) => add(mySchedule.render({}, { today: '2026-11-04', loading: false, ...v }));
  add(mySchedule.render({}));
  ms({ error: 'Down' });
  ms({ data: { nextServing: ITEM(), items: [ITEM(), ITEM({ slotId: 2, status: 'accepted', coVolunteers: [] })] }, message: 'Yes', problem: 'No' });
  ms({ confirmId: 2, busy: true, data: { items: [ITEM({ slotId: 2, status: 'accepted' })] } });
  ms({ data: { nextServing: null, items: [] } });
  // Days off, every state.
  const mb = (v) => add(myBlockouts.render({}, { today: TODAY, loading: false, ...v }));
  add(myBlockouts.render({}));
  mb({ error: 'Down' }); mb({ list: [] });
  mb({ list: [{ id: 1, startDate: TODAY, endDate: '2026-11-10', reason: 'Trip' }, { id: 2, startDate: TODAY, endDate: TODAY, reason: '' }], message: 'Saved', problem: 'Bad', conflicts: [{ date: TODAY, positionName: 'Sound' }], busy: true });
  // People.
  const pm = (x = {}) => people.renderScreen({ people: PEOPLE, teams: TEAMS, query: '', loading: false, adding: false, newName: '', panel: null, invite: null, error: '', notice: '', me: 1, ...x });
  add(people.render({})); add(pm({ loading: true })); add(pm({ error: 'E', notice: 'N', invite: { name: 'Pat Demo', email: 'pat.demo@example.com', link: '/#/welcome?token=example', localOnly: true } }));
  add(pm({ adding: true, newName: 'Kit New' })); add(pm({ people: [] })); add(pm({ query: 'zzz' }));
  for (const panel of [{ kind: 'reset', id: 2 }, { kind: 'active', id: 2 }, { kind: 'active', id: 3 }, { kind: 'role', id: 2, role: 'admin' }, { kind: 'role', id: 1, role: 'member' }, { kind: 'edit', id: 2 }, { kind: 'positions', id: 2, checked: new Set([10]) }]) add(pm({ panel }));
  add(pm({ panel: { kind: 'positions', id: 2, checked: new Set() }, teams: [] }));
  // Teams.
  const tm = (x = {}) => teams.renderScreen({ teams: TEAMS, loading: false, panel: null, error: '', notice: '', ...x });
  add(teams.render({})); add(tm({ loading: true })); add(tm({ error: 'E', notice: 'N' })); add(tm({ teams: [] }));
  for (const panel of [{ kind: 'rename-team', id: 1 }, { kind: 'delete-team', id: 1 }, { kind: 'add-position', id: 1 }, { kind: 'rename-position', id: 10 }, { kind: 'delete-position', id: 10 }]) add(tm({ panel }));
  // Services.
  const sm = (x = {}) => services.renderScreen({ teams: TEAMS, services: SERVICES, loading: false, panel: null, error: '', notice: '', today: TODAY, draft: null, ...x });
  add(services.render({})); add(sm({ loading: true })); add(sm({ error: 'E', notice: 'N' })); add(sm({ services: [], teams: [] }));
  for (const panel of [{ kind: 'edit', id: 1 }, { kind: 'repeat', id: 1 }, { kind: 'delete', id: 1, count: 2 }, { kind: 'delete', id: 3, count: 0 }]) add(sm({ panel }));
  // Schedule.
  const sc = (x = {}, p = '') => schedule.renderScreen({ services: SERVICES, teams: TEAMS, loading: false, error: '', notice: '', today: TODAY, from: TODAY, to: '2027-01-02', ...x }, p);
  add(schedule.render({})); add(sc({ loading: true })); add(sc({ error: 'E', notice: 'N' })); add(sc({ services: [] }));
  for (const p of panelStates()) { add(p); add(sc({}, p)); }
  // Gaps.
  const items = ['open', 'declined', 'unanswered', 'blocked', 'inactive'].map((type, i) => ({ type, slotId: i + 1, personId: 2, personName: 'Pat Demo', date: TODAY, time: '09:00', serviceTitle: 'S', positionName: 'Drums', teamName: 'Band' }));
  const gm = (x = {}, r = {}) => gaps.renderScreen({ loading: false, error: '', notice: '', summary: { open: 1, declined: 1, unanswered: 0 }, items, reminders: { weekOf: TODAY, list: null, loading: false, error: '', notice: '', ...r }, ...x });
  add(gaps.render({})); add(gm({ loading: true })); add(gm({ error: 'E', notice: 'N' }, { loading: true })); add(gm({ items: [] }, { list: [] }));
  add(gm({}, { list: [{ personId: 2, name: 'Pat Demo', message: 'Hi' }], error: 'E', notice: 'Copied.' }));
  // Shared pieces.
  add(toasts([['ok', 'ok', 'data-note'], ['bad', 'error', 'data-problem']])); add(TOAST_REGION);
  for (const shape of ['cards', 'list', 'rows']) add(skeleton('Loading…', shape));
  add(emptyState('Nothing', 'art-done')); add(pageHead('T', 'lead'));
  for (const s of ['open', 'pending', 'accepted', 'declined']) add(statusChip(s));
  for (const n of ['A', 'B c', 'Pat Demo', 'Rue', 'Sol', 'Kit', 'Lou', 'Ada', 'Gus', 'Noor', 'Bea', 'Cy', 'Ivy', 'Max']) { add(avatar(n)); add(avatar(n, 'sm')); add(avatar(n, 'lg')); }
  return out;
}

function classesIn(htmlText) {
  return new Set([...htmlText.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/).filter(Boolean)));
}

test('every class used by every view (all states), the shell, the shared pieces and the gallery is defined in style.css', () => {
  const pieces = allViewHtml();
  pieces.push(renderGallery({ today: TODAY }));
  for (const n of [...ICON_NAMES, ...ART_NAMES]) pieces.push(icon(n));
  // The toaster builds its markup with the DOM: capture it with a tiny fake.
  const made = [];
  const doc = { createElement: () => { const el = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {} }; made.push(el); return el; } };
  const t = createToaster({ ownerDocument: doc, appendChild() {} }, { win: { setTimeout: () => 1, clearTimeout() {} } });
  t.show('Saved', 'ok'); t.show('Oops', 'error');
  for (const el of made) pieces.push(`<div class="${el.className}">${el.innerHTML}</div>`);
  const used = new Set(pieces.flatMap((p) => [...classesIn(p)]));
  assert.ok(used.size > 150, `only ${used.size} classes seen`);
  const missing = [...used].filter((c) => !new RegExp(`\\.${c.replace(/[^\w-]/g, '\\$&')}(?![\\w-])`).test(CSS));
  assert.deepEqual(missing, []);
});

test('every view still escapes: no raw tags from hostile data, and no SVG in view output', () => {
  for (const h of [...allViewHtml(), renderGallery({ today: TODAY })]) {
    assert.doesNotMatch(h, /<(?:script|img|svg|iframe)\b/i);
  }
  const bad = '<img src=x onerror=alert(1)>';
  const out = [nav.render({ user: { name: bad, role: 'admin' } }, '#/'), String(avatar(bad)), String(toast(bad, 'error')), String(emptyState(bad))].join('');
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /&lt;img/);
});

// ---------- web files ----------

test('no style= attribute, no on* attribute and no inline script in any web file', () => {
  for (const f of webFiles().filter((p) => !p.endsWith('.woff2'))) {
    const s = readFileSync(f, 'utf8');
    assert.doesNotMatch(s, /\sstyle\s*=/i, `${rel(f)} has a style attribute`);
    assert.doesNotMatch(s, /<[a-z][^>]*\son[a-z]+\s*=/i, `${rel(f)} has an on* attribute`);
    assert.doesNotMatch(s, /<style/i, `${rel(f)} has a <style> block`);
    for (const m of s.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) assert.equal(m[2].trim(), '', `${rel(f)}: inline script`);
  }
});

test('accessibility basics: lang, viewport, landmarks, labelled menu with aria-current, modal dialogs', () => {
  for (const page of ['index.html', 'gallery.html']) {
    const s = readFileSync(path.join(WEB, page), 'utf8');
    assert.match(s, /<html lang="en">/, page);
    assert.match(s, /<meta name="viewport" content="width=device-width, initial-scale=1">/, page);
    assert.match(s, /<meta name="color-scheme" content="light dark">/, page);
  }
  assert.match(SHELL, /<header class="top"/);
  assert.match(SHELL, /<main class="main" id="main"/);
  const n = nav.render({ user: { id: 1, name: 'Ari Admin', role: 'admin' } }, '#/gaps');
  assert.match(n, /<nav class="nav[^"]*" aria-label="Main menu">/);
  assert.equal((n.match(/aria-current="page"/g) ?? []).length, 1);
  assert.match(n, /<a href="#\/gaps" aria-current="page">/);
  assert.match(n, /aria-expanded="false" aria-controls="nav-more-menu"/);
  for (const p of panelStates()) {
    assert.match(p, /role="dialog" aria-modal="true" aria-labelledby="slot-panel-title"/);
    assert.match(p, /id="slot-panel-title"/);
  }
});

test('phone tab bar: members get My schedule and Days off; admins get Schedule, Gaps, People and More', () => {
  const tabs = (h) => {
    const list = h.slice(h.indexOf('<ul class="nav-list">'));
    const top = list.split('nav-sub-wrap')[0];
    return [...top.matchAll(/class="nav-label(?:-short)?">([^<]+)</g)].map((m) => m[1]);
  };
  const m = nav.render({ user: { id: 2, name: 'Pat Demo', role: 'member' } }, '#/');
  assert.deepEqual(tabs(m), ['My schedule', 'Days I can&#39;t serve', 'Days off']);
  const a = nav.render({ user: { id: 1, name: 'Ari Admin', role: 'admin' } }, '#/');
  assert.deepEqual(tabs(a), ['Schedule', 'Gaps', 'People', 'More']);
  assert.match(a, /nav-more has-current/, 'More shows that the current page is inside it');
});

test('every input in every view has a label', () => {
  const pieces = [...allViewHtml(), renderGallery({ today: TODAY })];
  for (const h of pieces) {
    const labelled = new Set([...h.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map((m) => m[1]));
    for (const m of h.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
      const attrs = m[2];
      if (/type="(hidden|submit|button)"/.test(attrs)) continue;
      const id = /\sid="([^"]+)"/.exec(attrs)?.[1];
      const before = h.slice(0, m.index);
      const insideLabel = before.lastIndexOf('<label') > before.lastIndexOf('</label>');
      assert.ok((id && labelled.has(id)) || insideLabel, `unlabelled ${m[0].slice(0, 80)}`);
    }
  }
});

// ---------- icons, avatars, toasts ----------

test('icons: the 20 named icons exist and each is a valid, self-contained, hidden SVG', () => {
  for (const n of ['calendar', 'check', 'x', 'clock', 'user', 'users', 'plus', 'search', 'copy', 'lock', 'warning', 'bell',
    'logout', 'home', 'grid', 'mail', 'trash', 'edit', 'chevron', 'sparkle']) assert.ok(ICON_NAMES.includes(n), n);
  assert.ok(ICON_NAMES.length >= 20);
  for (const n of [...ICON_NAMES, ...ART_NAMES]) {
    const s = icon(n);
    assert.match(s, /^<svg [^>]*>[\s\S]*<\/svg>$/, n);
    assert.match(s, /aria-hidden="true"/, n);
    assert.match(s, /currentColor/, n);
    assert.match(s, /viewBox="0 0 \d+ \d+"/, n);
    assert.doesNotMatch(s, /<script|<foreignObject|href|url\(|style=|\son[a-z]+=|https?:|<!--/i, n);
    // Tags balance: every open tag closes, self-closing tags stand alone.
    const stack = [];
    for (const t of s.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) {
      if (t[3]) continue;
      if (t[1]) assert.equal(stack.pop(), t[2], `${n}: </${t[2]}>`);
      else stack.push(t[2]);
    }
    assert.deepEqual(stack, [], n);
  }
  assert.equal(icon('nope'), '');
  assert.equal(icon('__proto__'), '');
  assert.equal(String(iconSlot('bell', 'icon-sm')), '<span class="icon icon-sm" data-icon="bell" aria-hidden="true"></span>');
  assert.equal(hydrateIcons({}), 0, 'no DOM, nothing to do');
  // With a DOM-like root, empty slots are filled and filled ones left alone.
  const els = [{ firstChild: null, innerHTML: '', getAttribute: () => 'check' }, { firstChild: {}, innerHTML: 'x', getAttribute: () => 'check' }, { firstChild: null, innerHTML: '', getAttribute: () => 'nope' }];
  assert.equal(hydrateIcons({ querySelectorAll: () => els }), 1);
  assert.equal(els[0].innerHTML, icon('check'));
  assert.equal(els[1].innerHTML, 'x');
});

test('avatar: deterministic, always one of the 12 classes, initials escaped', () => {
  assert.equal(AVATAR_COLOURS, 12);
  const names = Array.from({ length: 300 }, (_, i) => `Person ${i} Madeup`);
  const seen = new Set();
  for (const n of names) {
    const i = avatarIndex(n);
    assert.ok(Number.isInteger(i) && i >= 0 && i < 12, `${n} -> ${i}`);
    assert.equal(avatarIndex(n), i);
    assert.equal(String(avatar(n)), String(avatar(n)));
    assert.match(String(avatar(n)), new RegExp(`class="avatar avatar-${i}"`));
    seen.add(i);
  }
  assert.equal(seen.size, 12, 'all 12 colours get used');
  assert.equal(avatarIndex('  Pat Demo '), avatarIndex('pat demo'));
  assert.equal(initials('Pat Demo'), 'PD');
  assert.equal(initials('Mary Ann Example'), 'ME');
  assert.equal(initials('élodie'), 'É');
  assert.equal(initials(''), '?');
  assert.equal(initials('<<< >>>'), '?');
  assert.equal(String(avatar('"><b>x</b>')), `<span class="avatar avatar-${avatarIndex('"><b>x</b>')}" aria-hidden="true">B</span>`);
  for (let i = 0; i < 12; i++) assert.match(CSS, new RegExp(`\\.avatar-${i}\\s*\\{\\s*background:\\s*var\\(--avatar-${i}\\)`));
  assert.doesNotMatch(String(avatar('x', 'lg')), /style=/);
});

test('toast: polite live region, roles, escaping, and auto-dismiss', () => {
  assert.match(TOAST_REGION, /aria-live="polite"/);
  assert.match(SHELL, /aria-live="polite"/);
  const ok = String(toast('Saved <b>', 'ok', 'data-note'));
  assert.match(ok, /^<div class="toast toast-ok" role="status" aria-live="polite" data-note>/);
  assert.match(ok, /Saved &lt;b&gt;/);
  const bad = String(toast('Oops', 'error', 'onclick'));
  assert.match(bad, /^<div class="toast toast-error" role="alert">/, 'unknown marks are dropped');
  assert.equal(toasts([['', 'ok'], null]), '');
  assert.match(String(toasts([['A', 'ok']])), /^<div class="toast-stack">/);
  assert.match(CSS, /\.toast-stack \.toast-ok\s*\{[^}]*toast-out[^}]*5s/);
  assert.doesNotMatch(CSS, /\.toast-stack \.toast-error\s*\{[^}]*toast-out/, 'problems inside a view stay put');
  assert.doesNotMatch(CSS, /\.toast-region:empty\s*\{[^}]*display:\s*none/, 'the live region stays in the accessibility tree');

  // The app's toaster, on a fake DOM with fake timers.
  const timers = [];
  const win = { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {} };
  const kids = [];
  const doc = { createElement: () => { const el = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, fn) { this.click = fn; }, remove() { kids.splice(kids.indexOf(this), 1); } }; return el; } };
  const t = createToaster({ ownerDocument: doc, appendChild: (el) => kids.push(el) }, { win });
  t.show('Saved', 'ok');
  t.show('Saved', 'ok'); // shown once
  t.show('Oops', 'error');
  assert.equal(kids.length, 2);
  assert.equal(kids[0].attrs.role, 'status');
  assert.equal(kids[1].attrs.role, 'alert');
  assert.match(kids[0].innerHTML, /data-action="toast-close" aria-label="Close message"/);
  assert.deepEqual(timers.map((x) => x.ms), [5000, 5000, 9000], 'a repeat restarts the timer');
  timers[1].fn();
  assert.deepEqual(kids.map((k) => k.attrs.role), ['alert']);
  kids[0].click({ target: { closest: () => ({}) } });
  assert.equal(kids.length, 0);
  t.show('Again', 'ok');
  t.clear();
  assert.equal(kids.length, 0);
});

// ---------- bottom sheet ----------

// A fake screen root that knows keyboard events and focus.
function sheetRoot() {
  const handlers = {};
  const focused = [];
  const root = {
    innerHTML: '',
    addEventListener(type, fn) { (handlers[type] ??= []).push(fn); },
    querySelector(sel) {
      if (sel.startsWith('[data-slot-panel]') && !root.innerHTML.includes('data-slot-panel')) return null;
      const id = /data-id="(\d+)"/.exec(sel)?.[1];
      if (id && !root.innerHTML.includes(`data-action="slot-open" data-id="${id}"`)) return null;
      return { focus: () => focused.push(sel) };
    },
    fire(type, e) { for (const fn of handlers[type] ?? []) fn(e); },
    click(action, id) { root.fire('click', { target: { dataset: { action, id: String(id) }, closest() { return this; } } }); },
    press(key) { const e = { key, prevented: false, preventDefault() { e.prevented = true; } }; root.fire('keydown', e); return e; },
    focused,
  };
  return root;
}

for (const [name, view, routes, id] of [
  ['schedule', schedule, { 'GET /api/teams': TEAMS, [`GET /api/services?from=${TODAY}&to=2027-01-02`]: SERVICES }, 2],
  ['gaps', gaps, { 'GET /api/admin/gaps': { summary: { open: 1 }, items: [{ type: 'open', slotId: 7, date: TODAY, time: '09:00', serviceTitle: 'S', positionName: 'Keys', teamName: 'Band' }] } }, 7],
]) {
  test(`bottom sheet (${name}): focus moves in, Escape closes it and focus returns to the slot`, async () => {
    const api = fakeApi({ ...routes, [`GET /api/admin/suggest?slotId=${id}`]: { candidates: CANDS } });
    const root = sheetRoot();
    const s = view.createScreen({ api, root, today: TODAY, win: {} });
    await s.ready;
    assert.equal(root.press('Escape').prevented, false, 'Escape does nothing while closed');
    root.click('slot-open', id);
    await flush();
    assert.match(root.innerHTML, /role="dialog" aria-modal="true"/);
    assert.match(root.innerHTML, /class="sheet-backdrop" data-action="slot-close"/, 'tapping outside closes it');
    assert.deepEqual(root.focused, ['[data-slot-panel] h2']);
    const e = root.press('Escape');
    assert.equal(e.prevented, true);
    assert.equal(s.panel.state, null);
    assert.ok(!root.innerHTML.includes('data-slot-panel'));
    assert.deepEqual(root.focused, ['[data-slot-panel] h2', `[data-action="slot-open"][data-id="${id}"]`]);
    // Other keys are ignored; the backdrop closes it too.
    root.click('slot-open', id);
    await flush();
    root.press('a');
    assert.ok(s.panel.state);
    root.click('slot-close');
    assert.equal(s.panel.state, null);
    assert.equal(root.focused.at(-1), `[data-action="slot-open"][data-id="${id}"]`);
  });
}

test('bottom sheet slides in once, not again on every repaint', () => {
  const panel = createSlotPanel({ api: { get: () => new Promise(() => {}) }, paint: () => {} });
  panel.open(schedule.panelSlot(SERVICES[0].slots[0], SERVICES[0]));
  assert.match(String(panel.render()), /class="sheet-layer is-entering"/);
  assert.match(String(panel.render()), /class="sheet-layer" data-sheet/);
  assert.match(CSS, /\.is-entering \.sheet\s*\{\s*animation:/);
  assert.doesNotMatch(CSS, /^\s*\.sheet\s*\{[^}]*animation:/m, 'the sheet itself does not animate on repaint');
});

test('bottom sheet: a repaint while open puts focus back on the same control inside it', () => {
  const focused = [];
  let open = true;
  const doc = {};
  const active = { getAttribute: (k) => ({ 'data-action': 'slot-assign', 'data-id': '30' })[k] ?? null };
  doc.activeElement = active;
  const panelEl = { ownerDocument: doc, contains: (el) => el === active };
  const root = {
    addEventListener() {},
    querySelector(sel) { return sel === '[data-slot-panel]' ? panelEl : { focus: () => focused.push(sel) }; },
  };
  const sheet = createSheet({ root, isOpen: () => open, close: () => { open = false; } });
  sheet.update(); // just opened: heading
  sheet.before(); // focus was on Assign for person 30
  sheet.update();
  assert.deepEqual(focused, ['[data-slot-panel] h2', '[data-slot-panel] [data-action="slot-assign"][data-id="30"]']);
  doc.activeElement = null; // focus was elsewhere: leave it alone
  sheet.before();
  sheet.update();
  assert.equal(focused.length, 2);
});

test('bottom sheet works with the shared test root too (no focus support needed)', async () => {
  const api = fakeApi({ 'GET /api/teams': TEAMS, [`GET /api/services?from=${TODAY}&to=2027-01-02`]: SERVICES, 'GET /api/admin/suggest?slotId=1': { candidates: CANDS } });
  const root = fakeRoot();
  const s = schedule.createScreen({ api, root, today: TODAY });
  await s.ready;
  await root.click('slot-open', 1);
  await flush();
  root.fire('keydown', { key: 'Escape', preventDefault() {} });
  assert.ok(s.panel.state, 'this shared fake passes no key, so nothing happens');
  root.click('slot-close');
  assert.equal(s.panel.state, null);
});

// ---------- the gallery ----------

test('gallery: loads only local assets and renders every component and page without throwing', async () => {
  const page = readFileSync(path.join(WEB, 'gallery.html'), 'utf8');
  const refs = [...page.matchAll(/\b(?:src|href)\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(refs.sort(), ['/gallery.js', '/style.css']);
  for (const r of refs) assert.ok(existsSync(path.join(WEB, r.slice(1))), r);
  assert.match(page, /<script type="module" src="\/gallery\.js"><\/script>/);
  assert.match(page, /<div id="gallery"/);
  assert.doesNotMatch(readFileSync(path.join(WEB, 'index.html'), 'utf8'), /gallery/, 'not linked from the app');
  for (const f of webFiles().filter((x) => x.endsWith('.js'))) {
    if (rel(f) !== 'gallery.js') assert.doesNotMatch(readFileSync(f, 'utf8'), /gallery\.html/, `${rel(f)} links the gallery`);
  }

  const out = renderGallery({ today: TODAY });
  for (const id of ['palette', 'type', 'buttons', 'chips', 'avatars', 'icons', 'segmented', 'toasts', 'skeleton', 'empty', 'forms', 'nav', 'sheet',
    'p-login', 'p-welcome', 'p-password', 'p-home', 'p-off', 'p-people', 'p-teams', 'p-services', 'p-schedule', 'p-gaps', 'p-404', 'live']) {
    assert.match(out, new RegExp(`id="g-${id}"`), id);
  }
  for (const text of ["You&#39;re serving", 'Waiting for answer', 'Nobody yet', 'Copy all', 'Days I have off', 'Invite message']) assert.ok(out.includes(text), text);
  assert.doesNotMatch(out, /https?:|<script|style=/i);
  // Only made-up demo names.
  const d = demoData(TODAY);
  assert.ok(d.PEOPLE.every((p) => /Demo|Sample|Example|Test|Placeholder|Fictional|Madeup|Invented|Pretend/.test(p.name)));

  // Mounting with a fake root draws it and starts no network (the fake root has no live host).
  const root = { innerHTML: '' };
  await mountGallery(root, { win: {}, today: TODAY });
  assert.equal(root.innerHTML, out);
  // With a host, the live demo runs on the in-memory api.
  const live = fakeRoot();
  const host = { innerHTML: '', querySelector: () => live, querySelectorAll: () => [] };
  await mountGallery(host, { win: {}, today: TODAY });
  assert.match(live.innerHTML, /sched-grid/);
});

test('gallery: html helper output used by the gallery stays escaped', () => {
  assert.equal(String(html`${'<b>'}`), '&lt;b&gt;');
});
