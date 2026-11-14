// Style gallery: every component and every page state, drawn with made-up
// demo data, so the look can be judged in a browser without logging in.
// Open /gallery.html. It is not linked from the app and makes no API calls:
// the one live demo (the schedule with its bottom sheet) talks to a fake,
// in-memory api defined below.
import { html, raw, esc, attr } from './lib/html.js';
import { todayString } from './lib/dates.js';
import { ICON_NAMES, ART_NAMES, iconSlot, watchIcons } from './lib/icons.js';
import { iconButton } from './lib/iconbutton.js';
import { avatar } from './lib/avatar.js';
import { toast, toasts } from './lib/toast.js';
import { skeleton, emptyState } from './lib/ui.js';
import { statusChip, createSlotPanel } from './lib/slotpanel.js';
import * as nav from './views/nav.js';
import * as account from './views/account.js';
import * as offline from './views/offline.js';
import * as installSteps from './views/install-steps.js';
import * as login from './views/login.js';
import * as welcome from './views/welcome.js';
import * as password from './views/password.js';
import * as notifications from './views/notifications.js';
import * as notFound from './views/notfound.js';
import * as mySchedule from './views/my-schedule.js';
import * as myBlockouts from './views/my-blockouts.js';
import * as people from './views/admin-people.js';
import * as teams from './views/admin-teams.js';
import * as services from './views/admin-services.js';
import * as schedule from './views/admin-schedule.js';
import * as gaps from './views/admin-gaps.js';

const { addDays } = services;

// ---------- made-up demo data ----------

export function demoData(today = todayString()) {
  const sunday = addDays(today, (7 - new Date(`${today}T00:00:00Z`).getUTCDay()) % 7);
  const TEAMS = [
    { id: 1, name: 'Band', positions: [
      { id: 10, name: 'Drums', qualifiedPersonIds: [3, 4] },
      { id: 11, name: 'Keys', qualifiedPersonIds: [5] },
      { id: 12, name: 'Vocals', qualifiedPersonIds: [] },
    ] },
    { id: 2, name: 'Tech', positions: [{ id: 20, name: 'Sound', qualifiedPersonIds: [6, 7] }] },
    { id: 3, name: 'Welcome', positions: [] },
  ];
  const pos = (id) => {
    const t = TEAMS.find((x) => x.positions.some((p) => p.id === id));
    const p = t.positions.find((x) => x.id === id);
    return { positionId: id, positionName: p.name, teamId: t.id, teamName: t.name };
  };
  const slot = (id, positionId, personId = null, personName = null, status = 'open') => ({ id, ...pos(positionId), personId, personName, status });
  const SERVICES = [
    { id: 1, date: today, time: '10:00', title: 'Sunday service', slots: [
      slot(1, 10, 3, 'Priya Demo', 'accepted'), slot(2, 11, 5, 'Tomás Sample', 'pending'),
      slot(3, 12), slot(4, 20, 6, 'Wren Example', 'declined'),
    ] },
    { id: 2, date: addDays(sunday, 7), time: '10:00', title: 'Sunday service', slots: [
      slot(5, 10), slot(6, 11, 5, 'Tomás Sample', 'accepted'), slot(7, 20, 7, 'Juniper Test', 'accepted'),
    ] },
    { id: 3, date: addDays(sunday, 14), time: '18:30', title: 'Evening prayer', slots: [slot(8, 12, 8, 'Ada Placeholder', 'pending'), slot(9, 20)] },
  ];
  const PEOPLE = [
    { id: 1, name: 'Morgan Fictional', email: 'morgan.fictional@example.com', role: 'admin', active: true, joined: true, positionIds: [] },
    { id: 3, name: 'Priya Demo', email: 'priya.demo@example.com', role: 'member', active: true, joined: true, positionIds: [10] },
    { id: 5, name: 'Tomás Sample', email: 'tomas.sample@example.com', role: 'member', active: true, joined: false, positionIds: [11] },
    { id: 6, name: 'Wren Example', email: 'wren.example@example.com', role: 'member', active: true, joined: true, positionIds: [20] },
    { id: 9, name: 'Old Gus Madeup', email: 'gus.madeup@example.com', role: 'member', active: false, joined: false, positionIds: [] },
  ];
  const ITEMS = [
    { slotId: 101, date: addDays(sunday, 0), time: '10:00', serviceTitle: 'Sunday service', positionName: 'Sound', teamName: 'Tech', status: 'pending',
      coVolunteers: [{ name: 'Priya Demo', positionName: 'Drums' }, { name: 'Tomás Sample', positionName: 'Keys' }] },
    { slotId: 102, date: addDays(sunday, 14), time: '18:30', serviceTitle: 'Evening prayer', positionName: 'Sound', teamName: 'Tech', status: 'accepted', coVolunteers: [] },
  ];
  // The full roster of each of those days, as GET /api/me/schedule sends it.
  const seat = (positionName, name, status, mine = false) => ({ positionName, name, status, mine });
  const ROSTERS = {
    [ITEMS[0].date]: [{ time: '10:00', serviceTitle: 'Sunday service', teams: [
      { teamName: 'Band', positions: [seat('Drums', 'Priya Demo', 'accepted'), seat('Keys', 'Tomás Sample', 'pending'), seat('Vocals', null, 'open')] },
      { teamName: 'Tech', positions: [seat('Sound', 'Juniper Test', 'pending', true)] },
    ] }],
    [ITEMS[1].date]: [{ time: '18:30', serviceTitle: 'Evening prayer', teams: [
      { teamName: 'Band', positions: [seat('Vocals', 'Ada Placeholder', 'pending')] },
      { teamName: 'Tech', positions: [seat('Sound', 'Juniper Test', 'accepted', true)] },
    ] }],
  };
  const BLOCKOUTS = [
    { id: 1, startDate: addDays(today, 10), endDate: addDays(today, 13), reason: 'Family trip' },
    { id: 2, startDate: addDays(today, 30), endDate: addDays(today, 30), reason: '' },
  ];
  const GAPS = {
    summary: { open: 3, declined: 1, unanswered: 1, blocked: 1, inactive: 0 },
    items: [
      { type: 'open', slotId: 3, date: today, time: '10:00', serviceTitle: 'Sunday service', positionName: 'Vocals', teamName: 'Band' },
      { type: 'open', slotId: 5, date: addDays(sunday, 7), time: '10:00', serviceTitle: 'Sunday service', positionName: 'Drums', teamName: 'Band' },
      { type: 'open', slotId: 9, date: addDays(sunday, 14), time: '18:30', serviceTitle: 'Evening prayer', positionName: 'Sound', teamName: 'Tech' },
      { type: 'declined', slotId: 4, personId: 6, personName: 'Wren Example', date: today, time: '10:00', serviceTitle: 'Sunday service', positionName: 'Sound', teamName: 'Tech' },
      { type: 'unanswered', slotId: 2, personId: 5, personName: 'Tomás Sample', date: today, time: '10:00', serviceTitle: 'Sunday service', positionName: 'Keys', teamName: 'Band' },
      { type: 'blocked', slotId: 8, personId: 8, personName: 'Ada Placeholder', date: addDays(sunday, 14), time: '18:30', serviceTitle: 'Evening prayer', positionName: 'Vocals', teamName: 'Band' },
    ],
  };
  const REMINDERS = [
    { personId: 3, name: 'Priya Demo', message: 'Hi Priya, a reminder that you are serving as Drums this Sunday at 10:00. Thank you!' },
    { personId: 5, name: 'Tomás Sample', message: 'Hi Tomás, a reminder. Please open Flock and accept or decline. Thank you!' },
  ];
  const CANDIDATES = [
    { personId: 3, name: 'Priya Demo', qualified: true, reasons: ['Has not served in 6 weeks'] },
    { personId: 4, name: 'Kit Invented', qualified: true, reasons: ['Served once in the last 8 weeks'] },
    { personId: 11, name: 'Lou Pretend', qualified: false, reasons: ['Not set up for Vocals'] },
  ];
  return { today, sunday, TEAMS, SERVICES, PEOPLE, ITEMS, ROSTERS, BLOCKOUTS, GAPS, REMINDERS, CANDIDATES };
}

// A fake api: canned answers, no network.
export function demoApi(d) {
  const routes = (path) => {
    if (path === '/api/teams') return d.TEAMS;
    if (path.startsWith('/api/services')) return d.SERVICES;
    if (path.startsWith('/api/admin/suggest')) return { candidates: path.includes('includeUnqualified') ? d.CANDIDATES : d.CANDIDATES.filter((c) => c.qualified) };
    if (path === '/api/admin/gaps') return d.GAPS;
    if (path.startsWith('/api/admin/reminders')) return { reminders: d.REMINDERS };
    return {};
  };
  const later = (v) => new Promise((r) => setTimeout(() => r(v), 350));
  return {
    calls: [],
    get(p) { this.calls.push(`GET ${p}`); return later(routes(p)); },
    post(p) { this.calls.push(`POST ${p}`); return later({}); },
    put(p) { this.calls.push(`PUT ${p}`); return later({}); },
    patch(p) { this.calls.push(`PATCH ${p}`); return later({}); },
    del(p) { this.calls.push(`DELETE ${p}`); return later({}); },
  };
}

// The icons added in the new-look and app-feel passes, each showing the thing itself.
const NEW_ICONS = [
  ['calendar-off', 'days you cannot serve'],
  ['team', 'a team of people'],
  ['church', 'a service'],
  ['puzzle', 'a gap: a position still to fill'],
  ['share', "the phone's share sheet"],
  ['install', 'put Flock on the Home Screen'],
  ['add-square', "iOS's Add to Home Screen"],
  ['offline', "can't reach the server"],
  ['chevron-left', 'back, the month before'],
  ['bell-off', 'notifications are off on this device'],
];

// ---------- gallery pieces ----------

const TOKENS = ['brand', 'bg', 'surface', 'surface-2', 'surface-3', 'line', 'text', 'muted', 'accent', 'accent-2', 'accent-soft',
  'hero-from', 'hero-to', 'hero-badge', 'success', 'success-bg', 'warning', 'warning-bg', 'danger', 'danger-bg', 'toast-bg', 'today-bg'];

const section = (id, title, body, note = '') => html`<section class="gallery-section" id="g-${id}" aria-labelledby="g-${id}-h">
  <h2 class="gallery-h" id="g-${id}-h">${title}</h2>${note ? html`<p class="hint gallery-note">${note}</p>` : ''}
  ${body}
</section>`;

const frame = (label, body) => html`<figure class="gallery-frame-wrap"><figcaption class="gallery-cap">${label}</figcaption><div class="gallery-frame">${raw(String(body))}</div></figure>`;

// A slot panel in a given state, drawn without any api calls.
function panelHtml(d, slot, state = {}) {
  const panel = createSlotPanel({ api: { get: () => new Promise(() => {}) }, paint: () => {} });
  panel.open(slot);
  Object.assign(panel.state, { loading: false, candidates: d.CANDIDATES.filter((c) => c.qualified), ...state });
  return panel.render();
}

function components(d) {
  const names = ['Priya Demo', 'Tomás Sample', 'Wren Example', 'Juniper Test', 'Ada Placeholder', 'Kit Invented',
    'Lou Pretend', 'Morgan Fictional', 'Gus Madeup', 'Noor Imaginary', 'Bea Specimen', 'Cy Mockup'];
  return html`
  ${section('palette', 'Colours', html`<ul class="gallery-swatches">${TOKENS.map((t) => html`<li class="gallery-swatch"><span class="swatch swatch-${t}"></span><code>--${t}</code></li>`)}</ul>`,
    'Light by default; switch your device to dark mode to see the dark theme.')}
  ${section('type', 'Type', html`<div class="card">
    <h1>Headline, bold and friendly</h1><h2>Section heading</h2><h3>Small heading</h3>
    <p class="lead">Lead text for a short introduction.</p><p>Body text for everyday reading. Times and counts use tabular numbers: <span class="num">9:00 am, 10:30 am, 12 people</span>.</p>
    <p class="hint">Hint text, quieter and smaller.</p><p><a href="#g-type">A link</a></p></div>`)}
  ${section('buttons', 'Buttons', html`<div class="card"><div class="btn-row">
    <button type="button" class="btn btn-primary">${iconSlot('check')} Primary</button>
    <button type="button" class="btn">Default</button>
    <button type="button" class="btn btn-danger">${iconSlot('trash')} Danger</button>
    <button type="button" class="btn btn-ghost">Ghost</button>
    <button type="button" class="btn btn-sm">Small</button>
    <button type="button" class="btn" disabled>Disabled</button>
    <button type="button" class="icon-btn" aria-label="Close">${iconSlot('x')}</button>
  </div><div class="btn-row"><button type="button" class="btn btn-primary btn-block btn-lg">Big full-width button</button></div></div>`)}
  ${section('chips', 'Status chips', html`<div class="card"><p class="gallery-row">
    ${statusChip('open')} ${statusChip('pending')} ${statusChip('accepted')} ${statusChip('declined')}
    <span class="chip chip-plain">Volunteer</span> <span class="chip chip-info">${iconSlot('users', 'chip-icon')}2 people can do this</span> <span class="chip chip-today">Today</span>
  </p></div>`, 'Every chip has a symbol and words, never colour alone.')}
  ${section('avatars', 'Avatars', html`<div class="card"><p class="gallery-row">${names.map((n) => html`<span class="gallery-avatar">${avatar(n)}<span class="hint">${n}</span></span>`)}</p>
    <p class="gallery-row">${avatar('Priya Demo', 'sm')} ${avatar('Priya Demo')} ${avatar('Priya Demo', 'lg')}</p></div>`)}
  ${section('icons', 'Icons', html`<ul class="gallery-icons">${ICON_NAMES.map((n) => html`<li class="gallery-icon" title="${attr(n)}">${iconSlot(n, 'icon-lg')}<code>${n}</code></li>`)}</ul>`)}
  ${section('new-icons', 'New icons', html`<p class="hint gallery-note">The icons added with the new look and the app feel, each with what it means. Every other icon was redrawn on the same grid.</p>
    <ul class="gallery-icons">${NEW_ICONS.map(([n, meaning]) => html`<li class="gallery-icon" title="${attr(n)}">${iconSlot(n, 'icon-lg')}<code>${n}</code><span class="hint icon-meaning">${esc(meaning)}</span></li>`)}</ul>`)}
  ${section('icon-buttons', 'Icon buttons', html`<p class="hint gallery-note">Real buttons built with <code>iconButton()</code>: 48×48, a visible keyboard focus ring, and a danger variant. Tab to them.</p>
    <div class="card"><p class="gallery-row">
      ${iconButton('bell', 'Notifications', { dataAction: 'demo' })}
      ${iconButton('trash', 'Delete service', { dataAction: 'delete-service', danger: true })}
      ${iconButton('refresh', 'Reload', { disabled: true })}
    </p></div>`)}
  ${section('segmented', 'Segmented control', html`<div class="card"><div class="segmented" role="group" aria-label="Demo">
    <button type="button" class="segment" aria-pressed="true">Only people trained for this</button>
    <button type="button" class="segment" aria-pressed="false">Show people not trained for this</button></div></div>`)}
  ${section('toasts', 'Toasts', html`<div class="gallery-static">${toasts([['Thank you! You are confirmed.', 'ok'], ["Can't reach the server. Check your internet and try again.", 'error']])}
    ${toast('A single toast', 'ok')}</div>`, 'In the app they float above the tab bar and fade away by themselves.')}
  ${section('skeleton', 'Loading skeletons', html`${skeleton('Loading…', 'cards', 1)}${skeleton('Loading…', 'list', 2)}${skeleton('Loading…', 'rows', 2)}`)}
  ${section('empty', 'Empty states', html`<div class="gallery-grid">${ART_NAMES.map((a) => emptyState(`Empty state picture: ${a.replace('art-', '')}`, a))}</div>`)}
  ${section('forms', 'Form fields', html`<form class="form card form-card" data-form="demo" novalidate>
    <p class="form-error" role="alert">Please type your email and password.</p>
    <div class="field"><label for="g-name">Name</label><input id="g-name" type="text" value="Priya Demo"></div>
    <div class="field-pair"><div class="field"><label for="g-date">Date</label><input id="g-date" type="date" value="${d.today}"></div>
    <div class="field"><label for="g-time">Time</label><input id="g-time" type="time" value="10:00"></div></div>
    <div class="field search-field"><label for="g-search">Search</label><div class="input-icon">${iconSlot('search')}<input id="g-search" type="search" value=""></div></div>
    <div class="field"><label class="check"><input type="checkbox" checked> A checkbox with a big tap area</label></div>
    <div class="notice notice-warn">${iconSlot('warning', 'notice-icon')}<div class="notice-body"><p>A warning notice.</p></div></div>
    <p class="notice notice-info">${iconSlot('mail', 'notice-icon')}<strong>An information notice.</strong></p>
  </form>`)}
  ${section('nav', 'Top bar and menu', html`
    ${frame('Volunteer', html`<header class="top">${raw(nav.render({ user: { id: 3, name: 'Priya Demo', role: 'member' } }, '#/'))}</header>`)}
    ${frame('Scheduler', html`<header class="top">${raw(nav.render({ user: { id: 1, name: 'Morgan Fictional', role: 'admin' } }, '#/schedule'))}</header>`)}
    ${frame('Notifications off on this device: a crossed-out bell', html`<header class="top">${raw(nav.render({ user: { id: 3, name: 'Priya Demo', role: 'member' }, push: { enabled: true, status: 'off' } }, '#/'))}</header>`)}
    ${frame('Notifications on: a solid bell', html`<header class="top">${raw(nav.render({ user: { id: 3, name: 'Priya Demo', role: 'member' }, push: { enabled: true, status: 'on' } }, '#/'))}</header>`)}
    ${frame('Scrolled: the page title takes the place of "Flock"', html`<header class="top is-scrolled">${raw(nav.render({ user: { id: 3, name: 'Priya Demo', role: 'member' } }, '#/', 'My schedule'))}</header>`)}
    ${frame('Counts on the tabs (2 to answer, 7 gaps)', html`<header class="top">${raw(nav.render({ user: { id: 1, name: 'Morgan Fictional', role: 'admin' }, counts: { answer: 2, gaps: 7 } }, '#/schedule'))}</header>`)}
    ${frame('More, open (a sheet from behind the tab bar)', html`<header class="top">${raw(nav.render({ user: { id: 1, name: 'Morgan Fictional', role: 'admin' }, counts: { answer: 1, gaps: 7 } }, '#/schedule')
      .replace('class="nav nav-admin"', 'class="nav nav-admin is-open"').replace('aria-expanded="false" aria-controls', 'aria-expanded="true" aria-controls'))}</header>`)}`,
  'On a phone the menu is a tab bar at the bottom; on a wide screen it is a row of tabs. Resize the window to see both. The avatar opens the account sheet.')}
  ${section('account', 'Account sheet (menu rows)', html`
    ${frame('Volunteer, notifications on, can install', account.render({ user: { id: 3, name: 'Priya Demo', role: 'member', email: 'priya.demo@example.com' }, accountOpen: true, push: { enabled: true, status: 'on' } }, { canInstall: true }))}
    ${frame('Scheduler who signs in with Google', account.render({ user: { id: 1, name: 'Morgan Fictional', role: 'admin', email: 'morgan.fictional@example.com', hasPassword: false }, accountOpen: true }))}`,
  'Opened by the avatar in the top bar. Swipe down, tap outside, the X or Escape to close.')}
  ${section('installed', 'Installed-app pieces', html`
    ${frame("Can't reach the server (start-up)", offline.render())}
    ${frame('Trying again', offline.render({ busy: true }))}
    ${frame('Add Flock to your Home Screen (iPhone)', installSteps.render({ installSteps: true }))}`)}
  ${section('sheet', 'Bottom sheet (slot panel)', html`
    ${frame('Suggestions', panelHtml(d, schedule.panelSlot(d.SERVICES[0].slots[2], d.SERVICES[0])))}
    ${frame('A conflict to confirm', panelHtml(d, schedule.panelSlot(d.SERVICES[0].slots[1], d.SERVICES[0]), { conflict: { code: 'blocked', personId: 3, message: 'Priya Demo is away on that date. Assign anyway?', force: true } }))}
    ${frame('Remove person?', panelHtml(d, schedule.panelSlot(d.SERVICES[0].slots[0], d.SERVICES[0]), { removeAsk: true }))}
    ${frame('Loading', panelHtml(d, schedule.panelSlot(d.SERVICES[0].slots[2], d.SERVICES[0]), { loading: true }))}`,
  'Live: open the schedule demo below and tap a position. Escape or tapping outside closes it.')}`;
}

function pages(d) {
  const me = { id: 1, name: 'Morgan Fictional', role: 'admin' };
  const sched = (view) => mySchedule.render({}, { today: d.today, loading: false, ...view });
  const off = (view) => myBlockouts.render({}, { today: d.today, loading: false, ...view });
  const peopleModel = (extra = {}) => ({ people: d.PEOPLE, teams: d.TEAMS, query: '', loading: false, adding: false, newName: '', panel: null, invite: null, error: '', notice: '', me: 1, ...extra });
  const teamsModel = (extra = {}) => ({ teams: d.TEAMS, loading: false, panel: null, error: '', notice: '', ...extra });
  const svcModel = (extra = {}) => ({ teams: d.TEAMS, services: d.SERVICES, recent: d.SERVICES, loading: false, panel: null, error: '', notice: '', today: d.today, draft: null, adding: false, startKey: null, openTeams: new Set(), ...extra });
  const schedModel = (extra = {}) => ({ services: d.SERVICES, teams: d.TEAMS, loading: false, error: '', notice: '', today: d.today, from: d.today, to: addDays(d.today, 55), ...extra });
  const gapsModel = (extra = {}) => ({ loading: false, error: '', notice: '', summary: d.GAPS.summary, items: d.GAPS.items,
    reminders: { weekOf: d.sunday, list: d.REMINDERS, loading: false, error: '', notice: '' }, ...extra });
  const screen = (h1, body) => html`<h1 tabindex="-1">${h1}</h1>${raw(String(body))}`;
  return html`
  ${section('p-login', 'Log in', html`${frame('Empty', login.render({}))}${frame('Wrong password', login.render({}, { error: 'Wrong email or password', email: 'priya.demo@example.com' }))}`)}
  ${section('p-welcome', 'Join with an invite', html`${frame('Checking', welcome.render({}))}${frame('Choose a password', welcome.render({}, { info: { name: 'Priya Demo', email: 'priya.demo@example.com' } }))}${frame('Link gone', welcome.render({}, { error: 'This link has expired or was already used. Ask your scheduler for a new one.' }))}`)}
  ${section('p-password', 'Change my password', html`${frame('Change password', password.render({ user: me }))}${frame('With a problem', password.render({ user: me }, { error: "The two new passwords don't match. Please type them again." }))}`)}
  ${section('p-notifications', 'Notifications (the bell)', html`
    ${frame('Off', notifications.render({ user: me, push: { enabled: true, support: 'ok', status: 'off' } }))}
    ${frame('On, test sent', notifications.render({ user: me, push: { enabled: true, support: 'ok', status: 'on' } }, { message: 'Sent. It should arrive in a few seconds.' }))}
    ${frame('Blocked in the browser', notifications.render({ user: me, push: { enabled: true, support: 'ok', status: 'blocked' } }))}
    ${frame('iPhone in Safari', notifications.render({ user: me, push: { enabled: true, support: 'ios-install', status: 'off' } }))}
    ${frame('Old iPhone', notifications.render({ user: me, push: { enabled: true, support: 'ios-update', status: 'off' } }))}
    ${frame('Not set up', notifications.render({ user: me, push: { enabled: false } }))}`)}
  ${section('p-home', 'My schedule (volunteer home)', html`
    ${frame('Loading', mySchedule.render({}, { today: d.today, loading: true }))}
    ${frame('Invited to turn on notifications', mySchedule.render({ push: { support: 'ok' } }, { today: d.today, loading: false, showPush: true, data: { nextServing: d.ITEMS[0], items: [d.ITEMS[0]], rosters: d.ROSTERS } }))}
    ${frame('Serving soon, one to answer', sched({ data: { nextServing: d.ITEMS[0], items: d.ITEMS, rosters: d.ROSTERS } }))}
    ${frame('Full roster of the day, opened', sched({ openRosters: new Set([101]), data: { nextServing: d.ITEMS[0], items: d.ITEMS, rosters: d.ROSTERS } }))}
    ${frame('Put Flock on your Home Screen', sched({ showInstall: true, data: { nextServing: d.ITEMS[1], items: [d.ITEMS[1]], rosters: d.ROSTERS } }))}
    ${frame('The moment after Yes, I can', sched({ celebrate: 102, message: 'Thank you! You are confirmed.', data: { nextServing: d.ITEMS[1], items: [d.ITEMS[1]], rosters: d.ROSTERS } }))}
    ${frame('After saying yes', sched({ message: 'Thank you! You are confirmed.', data: { nextServing: d.ITEMS[1], items: [d.ITEMS[1]], rosters: d.ROSTERS } }))}
    ${frame('Are you sure?', sched({ confirmId: 102, data: { nextServing: d.ITEMS[1], items: [d.ITEMS[1]], rosters: d.ROSTERS } }))}
    ${frame('A problem', sched({ problem: 'Someone else took it.', data: { nextServing: d.ITEMS[0], items: [d.ITEMS[0]], rosters: d.ROSTERS } }))}
    ${frame('Last week, its files still there', sched({ data: { nextServing: d.ITEMS[1], items: [d.ITEMS[1]], rosters: d.ROSTERS, recent: [{ slotId: 140, serviceId: 40, files: 3, date: addDays(d.today, -3), time: '10:00', serviceTitle: 'Sunday service', positions: ['Vocals', 'Acoustic guitar'] }] } }))}
    ${frame('Nothing yet', sched({ data: { nextServing: null, items: [] } }))}
    ${frame('Could not load', sched({ error: "Can't reach the server. Check your internet and try again." }))}`)}
  ${section('p-off', "Days I can't serve", html`
    ${frame('Loading', myBlockouts.render({}, { today: d.today, loading: true }))}
    ${frame('With days off', off({ list: d.BLOCKOUTS }))}
    ${frame('Picking three days', off({ list: d.BLOCKOUTS, pick: { start: addDays(d.today, 8), end: addDays(d.today, 10) }, serving: new Set([d.sunday]) }))}
    ${frame('Saved, with a clash', off({ list: d.BLOCKOUTS, message: 'Saved. You are off Sun 8 Nov.', conflicts: [{ date: d.sunday, positionName: 'Sound' }] }))}
    ${frame('Nothing saved', off({ list: [] }))}
    ${frame('A problem', off({ list: [], problem: 'Please pick the first day you can\'t serve (From).' }))}`)}
  ${section('p-people', 'People', html`
    ${frame('Loading', people.render({}))}
    ${frame('List', screen('People', people.renderScreen(peopleModel())))}
    ${frame('A person tapped: their buttons', screen('People', people.renderScreen(peopleModel({ selected: 5 }))))}
    ${frame('Adding someone', screen('People', people.renderScreen(peopleModel({ adding: true, newName: 'Noor Imaginary' }))))}
    ${frame('Invite message', screen('People', people.renderScreen(peopleModel({ invite: { name: 'Noor Imaginary', email: 'noor.imaginary@example.com', link: '/#/welcome?token=gallery-example', localOnly: true }, notice: 'Copied.' }))))}
    ${frame("A person's sheet", screen('People', people.renderScreen(peopleModel({ selected: 5, entered: true }))))}
    ${frame('Are you sure? (in the sheet)', screen('People', people.renderScreen(peopleModel({ selected: 3, entered: true, panel: { kind: 'active', id: 3 } }))))}
    ${frame('Add a person', screen('People', people.renderScreen(peopleModel({ adding: true, entered: true }))))}
    ${frame('Only "Not joined"', screen('People', people.renderScreen(peopleModel({ filter: 'invited' }))))}
    ${frame('Wide screen: the person in a pane beside the list (1024px and up)', screen('People', people.renderScreen(peopleModel({ wide: true, selected: 5 }))))}
    ${frame('Invite message on a phone that can share', screen('People', people.renderScreen(peopleModel({ canShare: true, invite: { name: 'Noor Imaginary', email: 'noor.imaginary@example.com', link: '/#/welcome?token=gallery-example', localOnly: false } }))))}
    ${frame('What can they do?', screen('People', people.renderScreen(peopleModel({ selected: 3, panel: { kind: 'positions', id: 3, checked: new Set([10]) } }))))}
    ${frame('Deactivate?', screen('People', people.renderScreen(peopleModel({ selected: 5, panel: { kind: 'active', id: 5 } }))))}
    ${frame('Make a scheduler?', screen('People', people.renderScreen(peopleModel({ selected: 6, panel: { kind: 'role', id: 6, role: 'admin' } }))))}
    ${frame('Nobody matches', screen('People', people.renderScreen(peopleModel({ query: 'zzz' }))))}`)}
  ${section('p-teams', 'Teams', html`
    ${frame('Teams, all closed', screen('Teams', teams.renderScreen(teamsModel())))}
    ${frame('A team opened, a position tapped', screen('Teams', teams.renderScreen(teamsModel({ notice: 'Position added.', open: new Set([1]), selected: 10 }))))}
    ${frame('Delete a team?', screen('Teams', teams.renderScreen(teamsModel({ open: new Set([3]), panel: { kind: 'delete-team', id: 3 } }))))}
    ${frame('Rename a position', screen('Teams', teams.renderScreen(teamsModel({ open: new Set([1]), selected: 11, panel: { kind: 'rename-position', id: 11 } }))))}
    ${frame('No teams yet', screen('Teams', teams.renderScreen(teamsModel({ teams: [] }))))}`)}
  ${section('p-services', 'Services', html`
    ${frame('The list, with the add button', screen('Services', services.renderScreen(svcModel())))}
    ${frame('Add a service, teams folded', screen('Services', services.renderScreen(svcModel({ adding: true }))))}
    ${frame('Add a service, one team open', screen('Services', services.renderScreen(svcModel({ adding: true, openTeams: new Set([d.TEAMS[0].id]) }))))}
    ${frame('A service tapped: its buttons', screen('Services', services.renderScreen(svcModel({ selected: 2 }))))}
    ${frame('Delete?', screen('Services', services.renderScreen(svcModel({ selected: 1, panel: { kind: 'delete', id: 1, count: 3 } }))))}
    ${frame('Repeat', screen('Services', services.renderScreen(svcModel({ selected: 2, panel: { kind: 'repeat', id: 2 } }))))}
    ${frame('With a problem', screen('Services', services.renderScreen(svcModel({ error: 'How many Drums? Please type a number from 1 to 20.' }))))}
    ${frame('Nothing yet', screen('Services', services.renderScreen(svcModel({ services: [] }))))}`)}
  ${section('p-schedule', 'Schedule', html`
    ${frame('Loading', schedule.render({}))}
    ${frame('Grid (wide) or cards (phone), today highlighted and opened', screen('Schedule', schedule.renderScreen(schedModel({ notice: 'Priya Demo is now on Vocals. Waiting for their answer.', open: new Set([1]) }))))}
    ${frame('Fill open positions (sheet)', screen('Schedule', schedule.renderScreen(schedModel({ autofill: { open: true, entered: true, weekOf: d.today, weeks: 2, result: { assigned: [], unfilled: [] } } }))))}
    ${frame('No services', screen('Schedule', schedule.renderScreen(schedModel({ services: [] }))))}`)}
  ${section('p-gaps', 'Gaps', html`
    ${frame('Gaps', screen('Gaps', gaps.renderScreen(gapsModel())))}
    ${frame('Gaps, only "Said no"', screen('Gaps', gaps.renderScreen(gapsModel({ filter: 'declined' }))))}
    ${frame('Reminders', screen('Gaps', gaps.renderScreen(gapsModel({ tab: 'reminders' }))))}
    ${frame('Reminders on a phone that can share', screen('Gaps', gaps.renderScreen(gapsModel({ tab: 'reminders', canShare: true }))))}
    ${frame('Reminders with notifications on', screen('Gaps', gaps.renderScreen(gapsModel({ tab: 'reminders', reminders: { weekOf: d.sunday, push: true, sent: new Set(), loading: false, error: '', notice: '',
      list: d.REMINDERS.map((x, i) => ({ ...x, hasPush: i % 2 === 0 })) } }))))}
    ${frame('Reminders sent', screen('Gaps', gaps.renderScreen(gapsModel({ tab: 'reminders', reminders: { weekOf: d.sunday, push: true, loading: false, error: '',
      sent: new Set(d.REMINDERS.filter((x, i) => i % 2 === 0).map((x) => x.personId)),
      notice: gaps.sentWords(Math.ceil(d.REMINDERS.length / 2), Math.floor(d.REMINDERS.length / 2)),
      list: d.REMINDERS.map((x, i) => ({ ...x, hasPush: i % 2 === 0 })) } }))))}
    ${frame('No gaps', screen('Gaps', gaps.renderScreen(gapsModel({ summary: {}, items: [], reminders: { weekOf: d.sunday, list: [], loading: false, error: '', notice: '' } }))))}`)}
  ${section('p-404', 'Page not found', frame('Not found', notFound.render({ user: me })))}
  ${section('live', 'Live demo: schedule and bottom sheet', html`<div class="gallery-live" data-live-schedule></div>`,
    'Works like the real page with made-up data. Nothing is saved.')}`;
}

/** The whole gallery as an HTML string. */
export function renderGallery({ today = todayString() } = {}) {
  const d = demoData(today);
  return String(html`
    <header class="gallery-head">
      <p class="hero-eyebrow">${iconSlot('flock', 'icon-sm')} Style gallery</p>
      <h1>Flock: how it looks</h1>
      <p class="lead">Every part of the app, drawn with made-up names. Nothing here is real or saved.</p>
      <nav class="gallery-toc" aria-label="Gallery sections"><a href="#g-palette">Components</a> <a href="#g-p-login">Pages</a> <a href="#g-live">Live demo</a></nav>
    </header>
    <main class="gallery-main" id="gallery-main">
      ${components(d)}
      ${pages(d)}
    </main>`);
}

/** Draw the gallery into root and start the live demo. */
export function mountGallery(root, { win = globalThis, today = todayString() } = {}) {
  root.innerHTML = renderGallery({ today });
  watchIcons(root, win);
  const live = typeof root.querySelector === 'function' ? root.querySelector('[data-live-schedule]') : null;
  if (live && typeof live.addEventListener === 'function') {
    const d = demoData(today);
    return schedule.createScreen({ api: demoApi(d), root: live, today }).ready;
  }
  return Promise.resolve();
}

// Boot only in a browser on the gallery page (Node has no `location`).
if (typeof location !== 'undefined' && /gallery\.html$/.test(String(globalThis.location?.pathname ?? ''))) {
  const root = globalThis.document.getElementById('gallery');
  if (root) mountGallery(root, { win: globalThis.window });
}
