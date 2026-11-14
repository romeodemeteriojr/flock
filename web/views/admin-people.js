// People page (scheduler only): find, add and look after the people in the church.
// Quiet rows (a picture, the name, the email, only the tags that apply); tapping
// one opens that person's sheet with everything you can do for them. Adding a
// person is a sheet too. All clicks go through one delegated listener on the
// screen. Anything risky first shows a plain "Are you sure?" step inside the
// sheet; nothing is sent until the scheduler says yes.
import { html, raw } from '../lib/html.js';
import { iconSlot } from '../lib/icons.js';
import { flashCopied } from '../lib/copyflash.js';
import { avatar } from '../lib/avatar.js';
import { toasts, createNoticeClock, dropProblem } from '../lib/toast.js';
import { inviteMessage } from '../lib/invite.js';
import { copyText } from '../lib/slotpanel.js';
import { canShare, share } from '../lib/share.js';
import { skeleton, emptyState, pageHead } from '../lib/ui.js';
import { createSheet, host, watchHost } from '../lib/sheet.js';
import { swipeToDismiss } from '../lib/swipe.js';

export const title = 'People';

// ---------- pure helpers (tested directly) ----------

// Keep people whose name or email contains every word typed (ignores case).
export function filterPeople(people, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return people;
  return people.filter((p) => {
    const hay = `${p.name} ${p.email ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// Turn an API error into plain words for the scheduler.
export function friendlyMessage(err) {
  const text = String(err?.message ?? '');
  if (err?.status === 409) {
    if (/at least one/i.test(text)) {
      return "That would leave nobody in charge. There must always be at least one active scheduler, so make someone else a scheduler first.";
    }
    if (/own account/i.test(text)) return "You can't deactivate your own account.";
  }
  return text || 'Something went wrong. Please try again.';
}

const roleWord = (p) => (p.role === 'admin' ? 'Scheduler' : 'Volunteer');

// The list's filters: who each one keeps.
export const PEOPLE_FILTERS = Object.freeze({
  all: ['All', () => true],
  admins: ['Schedulers', (p) => p.role === 'admin'],
  invited: ['Not joined', (p) => !!p.email && !p.joined && p.active],
  inactive: ['Deactivated', (p) => !p.active],
});
export function filterKind(people, kind) {
  const keep = (PEOPLE_FILTERS[kind] ?? PEOPLE_FILTERS.all)[1];
  return people.filter(keep);
}

// The level a person would get if their role button were pressed.
const nextRole = (p) => (p.role === 'admin' ? 'member' : 'admin');

function roleConfirmPanel(p, target) {
  const yes = target === 'admin' ? 'Yes, make a scheduler' : 'Yes, make a volunteer';
  const text = target === 'admin'
    ? html`Make ${p.name} a scheduler? ${p.name} will be able to change the whole schedule and see every volunteer's name and email.`
    : html`Make ${p.name} a volunteer? ${p.name} will only see their own schedule.`;
  return html`<div class="confirm" role="alertdialog" aria-label="Confirm">
    <p>${text}</p>
    <div class="btn-row">
      <button type="button" class="btn btn-primary" data-action="role-yes" data-id="${p.id}">${yes}</button>
      <button type="button" class="btn" data-action="cancel">No, go back</button>
    </div></div>`;
}

// Share (the phone's share sheet) comes first where there is one; Copy is always there.
function inviteBox(invite, sharing = false) {
  return html`
    <section class="card secret-box" id="invite-box" role="alert" aria-labelledby="invite-head">
      <h2 id="invite-head">${iconSlot('send', 'icon-sm')} Invite for ${invite.name}</h2>
      <p class="lead" data-invite-text>${inviteMessage(invite)}</p>
      ${invite.localOnly ? html`<p class="notice">This link uses localhost, so it only works on this computer. Set FLOCK_PUBLIC_URL, or open Flock using this computer's network address, then copy a new invite.</p>` : ''}
      <div class="btn-row">
        ${sharing ? html`<button type="button" class="btn btn-primary" data-action="share">${iconSlot('share')} Share</button>` : ''}
        <button type="button" class="btn${sharing ? '' : ' btn-primary'}" data-action="copy" data-copy-key="invite">${iconSlot('copy')} Copy message</button>
        <button type="button" class="btn" data-action="done">Done</button>
      </div>
    </section>`;
}

function confirmPanel(p, kind) {
  if (kind === 'reset') {
    return html`<div class="confirm" role="alertdialog" aria-label="Confirm">
      <p>Reset the login of <strong>${p.name}</strong>? Their password and any linked sign-in (such as Google) stop working right away, they are logged out everywhere, and you get a new invite link for them.</p>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" data-action="reset-yes" data-id="${p.id}">Yes, reset login</button>
        <button type="button" class="btn" data-action="cancel">No, go back</button>
      </div></div>`;
  }
  if (p.active) {
    return html`<div class="confirm confirm-danger" role="alertdialog" aria-label="Confirm">
      <p>Deactivate <strong>${p.name}</strong>? They will not be able to log in and will not be offered for scheduling. Nothing is deleted: their history is kept, and you can reactivate them any time.</p>
      ${p.upcoming ? html`<p data-upcoming><strong>${p.name} is on ${p.upcoming === 1 ? '1 upcoming service' : `${p.upcoming} upcoming services`}.</strong> They stay on the schedule, and Gaps will list ${p.upcoming === 1 ? 'that spot' : 'those spots'} so you can find someone else.</p>` : ''}
      <div class="btn-row">
        <button type="button" class="btn btn-danger" data-action="deactivate-yes" data-id="${p.id}">Yes, deactivate</button>
        <button type="button" class="btn" data-action="cancel">No, go back</button>
      </div></div>`;
  }
  return html`<div class="confirm" role="alertdialog" aria-label="Confirm">
    <p>Reactivate <strong>${p.name}</strong>? They will be able to log in again, and all their history is still there.</p>
    <div class="btn-row">
      <button type="button" class="btn btn-primary" data-action="reactivate-yes" data-id="${p.id}">Yes, reactivate</button>
      <button type="button" class="btn" data-action="cancel">No, go back</button>
    </div></div>`;
}

// The email is the login: it can only change before the person joins (Reset login unlocks it).
function editPanel(p) {
  return html`<form class="form confirm" data-form="edit-name" data-id="${p.id}" novalidate>
    <div class="field">
      <label for="edit-name-${p.id}">Name</label>
      <input id="edit-name-${p.id}" name="name" type="text" maxlength="80" required value="${p.name}">
    </div>
    ${p.joined ? html`<p class="hint">They log in with ${p.email}. To change it, use Reset login first.</p>` : html`
    <div class="field">
      <label for="edit-email-${p.id}">Email (needed to log in)</label>
      <input id="edit-email-${p.id}" name="email" type="email" maxlength="254" autocapitalize="none" spellcheck="false" value="${p.email ?? ''}">
    </div>`}
    <div class="btn-row">
      <button type="submit" class="btn btn-primary">Save</button>
      <button type="button" class="btn" data-action="cancel">Cancel</button>
    </div></form>`;
}

function checklistPanel(p, teams, checked) {
  const groups = teams.filter((t) => t.positions.length);
  return html`<div class="confirm checklist" data-checklist="${p.id}">
    <h3>What can ${p.name} do?</h3>
    ${groups.length ? groups.map((t) => html`
      <fieldset class="fieldset">
        <legend>${t.name}</legend>
        ${t.positions.map((pos) => html`
          <div class="field"><label class="check"><input type="checkbox" data-action="toggle-position" data-position="${pos.id}"
            ${checked.has(pos.id) ? raw('checked') : ''}> ${pos.name}</label></div>`)}
      </fieldset>`) : html`<p class="hint">There are no positions yet. Add some on the Teams page.</p>`}
    <div class="btn-row">
      <button type="button" class="btn btn-primary" data-action="positions-save" data-id="${p.id}">Save</button>
      <button type="button" class="btn" data-action="cancel">Cancel</button>
    </div></div>`;
}
// Only the tags that apply, each a word with its icon. The sheet leaves out
// the Scheduler tag (its line under the name already says the role).
function tags(p, m, { role = true } = {}) {
  const list = [];
  if (role && p.role === 'admin') list.push(html`<span class="chip chip-info">${iconSlot('shield', 'chip-icon')}Scheduler</span>`);
  if (p.id === m.me) list.push(html`<span class="chip chip-plain">${iconSlot('user', 'chip-icon')}That's you</span>`);
  if (p.email && !p.joined && p.active) list.push(html`<span class="chip chip-wait">${iconSlot('clock', 'chip-icon')}Not joined yet</span>`);
  if (!p.email && p.active) list.push(html`<span class="chip chip-bad">${iconSlot('warning', 'chip-icon')}No email, cannot log in</span>`);
  if (p.notifications && p.active) list.push(html`<span class="chip chip-plain" title="Gets notifications from Flock">${iconSlot('bell', 'chip-icon')}Notifications on</span>`);
  if (!p.active) list.push(html`<span class="chip chip-plain">${iconSlot('user-off', 'chip-icon')}Deactivated</span>`);
  return list;
}

function personRow(p, m) {
  const t = tags(p, m);
  const here = m.wide && m.selected === p.id ? html` aria-current="true"` : '';
  return html`<li data-person="${p.id}"><button type="button" class="menu-row person-row${p.active ? '' : ' is-inactive'}" data-action="select" data-id="${p.id}"${m.wide ? '' : html` aria-haspopup="dialog"`}${here}>
    ${avatar(p.name)}<span class="menu-text"><strong>${p.name}</strong>${p.email ? html`<span class="menu-sub">${p.email}</span>` : ''}${t.length ? html`<span class="person-tags">${t}</span>` : ''}</span><span class="menu-end">${iconSlot('chevron', 'icon-sm')}</span>
  </button></li>`;
}

export function renderList(m) {
  if (!m.people.length) return String(emptyState('No people yet.', 'art-people'));
  const shown = filterPeople(filterKind(m.people, m.filter), m.query);
  if (!shown.length) return String(emptyState('Nobody matches that. Try fewer letters.', 'art-lost'));
  return String(html`<ul class="list people-list">${shown.map((p) => personRow(p, m))}</ul>`);
}

// The names of the positions a person can do, in the Teams page order.
function positionNames(p, teams) {
  const mine = new Set(p.positionIds ?? []);
  return teams.flatMap((t) => t.positions.filter((pos) => mine.has(pos.id)).map((pos) => pos.name));
}

const row = ({ icon, label, sub = '', end = '', action, id, danger = false }) => html`<li><button type="button" class="menu-row${danger ? ' is-danger' : ''}" data-action="${action}" data-id="${id}">
    ${iconSlot(icon, 'menu-icon')}<span class="menu-text">${label}${sub ? html`<span class="menu-sub">${sub}</span>` : ''}</span>${danger ? '' : html`<span class="menu-end">${end}${iconSlot('chevron', 'icon-sm')}</span>`}</button></li>`;

// One person's sheet: who they are, then everything you can do for them. A
// confirm step, the name form or the positions list takes the rows' place.
function personSheet(p, m, { pane = false } = {}) {
  const panel = m.panel && m.panel.id === p.id ? m.panel : null;
  let body;
  if (panel) {
    if (panel.kind === 'reset' || panel.kind === 'active') body = confirmPanel(p, panel.kind);
    else if (panel.kind === 'role') body = roleConfirmPanel(p, panel.role);
    else if (panel.kind === 'edit') body = editPanel(p);
    else body = checklistPanel(p, m.teams, panel.checked);
    body = html`<div class="sheet-body person-panel">${body}</div>`;
  } else {
    const isMe = p.id === m.me;
    const can = positionNames(p, m.teams);
    body = html`<ul class="menu sheet-menu">
      ${row({ icon: 'puzzle', label: 'Positions', end: can.length ? can.join(', ') : 'None yet', action: 'positions', id: p.id })}
      ${row({ icon: 'edit', label: 'Change name', action: 'edit', id: p.id })}
      ${p.active && !isMe ? row({ icon: 'shield', label: nextRole(p) === 'admin' ? 'Make a scheduler' : 'Make a volunteer', sub: nextRole(p) === 'admin' ? 'Can change the schedule and people' : 'Sees only their own schedule', action: 'role-ask', id: p.id }) : ''}
      ${p.email && !p.joined && p.active ? row({ icon: 'mail', label: 'Copy new invite', action: 'invite', id: p.id }) : ''}
      ${p.email ? row({ icon: 'key', label: 'Reset login', action: 'reset-ask', id: p.id }) : ''}
      ${isMe ? '' : html`<li class="menu-sep" role="separator"></li>
      ${p.active ? row({ icon: 'user-off', label: 'Deactivate', action: 'active-ask', id: p.id, danger: true }) : row({ icon: 'user-check', label: 'Reactivate', action: 'active-ask', id: p.id })}`}
    </ul>`;
  }
  const t = tags(p, m, { role: false });
  const section = html`<section class="sheet person-sheet" data-person-panel="${p.id}" ${pane ? '' : html`role="dialog" aria-modal="true" `}aria-labelledby="person-name">
    <div class="sheet-grab" aria-hidden="true"></div>
    <div class="account-head">${avatar(p.name, 'lg')}
      <div class="account-text"><h2 class="account-name" id="person-name" tabindex="-1">${p.name}</h2><p class="account-sub">${roleWord(p)}${p.email ? html` · ${p.email}` : ''}</p>${t.length ? html`<p class="person-tags">${t}</p>` : ''}</div>
      <button type="button" class="icon-btn" data-action="person-close" aria-label="Close">${iconSlot('x')}</button>
    </div>
    ${body}
  </section>`;
  return pane ? section : html`<div class="sheet-layer${m.entered ? '' : ' is-entering'}" data-person-sheet>
  <div class="sheet-backdrop" data-action="person-close"></div>
  ${section}</div>`;
}

// Adding someone: name, email, and whether they schedule (explained right there).
function addSheet(m) {
  return html`<div class="sheet-layer${m.entered ? '' : ' is-entering'}" data-add-sheet>
  <div class="sheet-backdrop" data-action="add-cancel"></div>
  <section class="sheet" data-add-panel role="dialog" aria-modal="true" aria-labelledby="add-title">
    <div class="sheet-grab" aria-hidden="true"></div>
    <div class="sheet-head"><h2 id="add-title" tabindex="-1">Add a person</h2><button type="button" class="icon-btn" data-action="add-cancel" aria-label="Close">${iconSlot('x')}</button></div>
    <div class="sheet-body">
      <form class="form" data-form="add-person" novalidate>
        <div class="field">
          <label for="new-name">Name</label>
          <input id="new-name" name="name" type="text" maxlength="80" required data-action="new-name" value="${m.newName}">
        </div>
        <div class="field">
          <label for="new-email">Email</label>
          <input id="new-email" name="email" type="email" maxlength="254" autocapitalize="none" spellcheck="false" aria-describedby="new-email-hint">
          <p class="hint" id="new-email-hint">How they log in, with a password or with Google. Leave it empty for someone who will not log in; you can still schedule them.</p>
        </div>
        <div class="field">
          <label class="check"><input type="checkbox" name="scheduler" aria-describedby="new-role-hint"> Make this person a scheduler</label>
          <div class="hint" id="new-role-hint"><p>Scheduler: can manage people, teams, services and the schedule.</p><p>Volunteer: can see their own schedule and mark days they cannot serve.</p></div>
        </div>
        <div class="btn-row">
          <button type="submit" class="btn btn-primary">Add person</button>
          <button type="button" class="btn" data-action="add-cancel">Cancel</button>
        </div>
      </form>
    </div>
  </section></div>`;
}

function filters(m) {
  const chip = ([key, [label]]) => {
    const n = filterKind(m.people, key).length;
    if (!n && key !== 'all') return '';
    return html`<button type="button" class="filter-chip" data-action="filter" data-filter="${key}" aria-pressed="${(m.filter ?? 'all') === key ? 'true' : 'false'}">${label} <span class="filter-count num" data-count="${key}">${n}</span></button>`;
  };
  return html`<div class="filters" role="group" aria-label="Show">${Object.entries(PEOPLE_FILTERS).map(chip)}</div>`;
}

export function renderScreen(m) {
  if (m.loading) return String(skeleton('Loading…', 'list', 4));
  const open = m.selected !== null && m.selected !== undefined ? m.people.find((p) => p.id === m.selected) : null;
  return String(html`
    ${toasts([[m.notice, 'ok'], [m.error, 'error']])}
    ${m.invite ? inviteBox(m.invite, m.canShare) : ''}
    <div class="people-tools">
      <div class="field search-field">
        <label for="people-search" class="visually-hidden">Search by name or email</label>
        <div class="input-icon">${iconSlot('search')}<input id="people-search" type="search" data-action="search" autocomplete="off" placeholder="Search by name or email" value="${m.query}"></div>
      </div>
      <button type="button" class="btn btn-primary" data-action="add-open" aria-label="Add a person" aria-haspopup="dialog">${iconSlot('plus')}</button>
    </div>
    ${filters(m)}
    ${m.wide ? html`<div class="split"><section class="card people-card"><div data-list>${raw(renderList(m))}</div></section>
      <aside class="card pane" aria-label="${open ? open.name : 'Person'}">${open && !m.adding ? personSheet(open, m, { pane: true }) : html`<p class="pane-empty">${iconSlot('users', 'icon-lg')}Choose a person.</p>`}</aside></div>`
    : html`<section class="card people-card"><div data-list>${raw(renderList(m))}</div></section>`}
    ${m.adding ? addSheet(m) : open && !m.wide ? personSheet(open, m) : ''}
  `);
}

// ---------- screen controller ----------

export function createScreen({ api, root, ctx = {}, win = globalThis }) {
  const m = {
    people: [], teams: [], query: '', loading: true, adding: false, newName: '',
    panel: null, invite: null, error: '', notice: '', me: null,
    selected: null, // the person whose sheet is open
    filter: 'all',
    entered: false, // the open sheet has slid in (it does not slide again on a repaint)
    canShare: canShare(win),
  };
  const hold = { timer: null, key: null };
  const me = () => ctx.state?.user?.id ?? null;
  let busy = false;

  const notices = createNoticeClock();
  let invitePainted = null;
  const paint = () => {
    personSheet.before();
    addSheetFocus.before();
    m.notice = notices.keep(m.notice);
    root.innerHTML = renderScreen(m);
    notices.resume(root);
    m.entered = m.selected !== null || m.adding;
    personSheet.update();
    addSheetFocus.update();
    const open = root.querySelector?.('[data-person-panel], [data-add-panel]');
    if (open) swipeToDismiss(open, { win, onDismiss: () => (m.adding ? actions['add-cancel']() : actions['person-close']()) });
    // A new invite box opens at the top of the page: bring it into view (after
    // the closing sheet has handed focus back, which scrolls too).
    if (m.invite && m.invite !== invitePainted) root.querySelector?.('#invite-box')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    invitePainted = m.invite;
  };
  const personSheet = createSheet({
    root, isOpen: () => m.selected !== null && !m.adding, close: () => actions['person-close'](), modal: () => !m.wide,
    panel: '[data-person-panel]', opener: (id) => `[data-action="select"][data-id="${id}"]`,
  });
  const addSheetFocus = createSheet({
    root, isOpen: () => m.adding, close: () => actions['add-cancel'](),
    panel: '[data-add-panel]', opener: () => '[data-action="add-open"]',
  });
  // Wide screens: the person's sheet sits in a pane beside the list.
  m.wide = host(win) === 'pane';
  const stopWatching = watchHost(win, () => {
    if (root.isConnected === false) { stopWatching(); return; }
    m.wide = host(win) === 'pane';
    paint();
  });
  const paintList = () => {
    const el = root.querySelector('[data-list]');
    if (el) el.innerHTML = renderList(m);
  };
  const find = (id) => m.people.find((p) => p.id === Number(id));

  async function reload() {
    m.me = me();
    const [people, teams] = await Promise.all([api.get('/api/people'), api.get('/api/teams')]);
    m.people = Array.isArray(people) ? people : [];
    m.teams = Array.isArray(teams) ? teams : [];
  }

  // Run one change: clear old messages, show friendly errors, redraw.
  async function attempt(fn) {
    if (busy) return;
    busy = true;
    m.error = '';
    m.notice = '';
    try {
      await fn();
    } catch (err) {
      if (err?.status === 401) return;
      m.error = friendlyMessage(err);
    } finally {
      busy = false;
    }
    paint();
  }

  // A step (confirm, name, positions) shows in that person's sheet.
  const openPanel = (panel) => { m.panel = panel; m.selected = panel.id; paint(); };

  const actions = {
    'add-open': () => { m.adding = true; m.selected = null; m.panel = null; m.entered = false; m.error = ''; m.notice = ''; addSheetFocus.opened('add'); paint(); },
    'add-cancel': () => { if (!m.adding) return; m.adding = false; m.newName = ''; paint(); },
    cancel: () => { m.panel = null; paint(); },
    done: () => { m.invite = null; paint(); },
    select: (id) => {
      if (!find(id)) return;
      m.selected = id; m.panel = null; m.adding = false; m.entered = false;
      personSheet.opened(id);
      paint();
    },
    'person-close': () => { if (m.selected === null) return; m.selected = null; m.panel = null; paint(); },
    filter: (_id, el) => {
      m.filter = Object.hasOwn(PEOPLE_FILTERS, el?.dataset?.filter) ? el.dataset.filter : 'all';
      paint();
      root.querySelector?.(`[data-action="filter"][data-filter="${m.filter}"]`)?.focus?.();
    },
    edit: (id) => openPanel({ kind: 'edit', id }),
    'reset-ask': (id) => openPanel({ kind: 'reset', id }),
    'active-ask': (id) => openPanel({ kind: 'active', id }),
    positions: (id) => {
      const p = find(id);
      openPanel({ kind: 'positions', id, checked: new Set(p ? p.positionIds : []) });
    },
    'toggle-position': (_id, el) => {
      if (m.panel?.kind !== 'positions') return;
      const pid = Number(el.dataset.position);
      if (el.checked) m.panel.checked.add(pid); else m.panel.checked.delete(pid);
    },
    share: async () => {
      if (!m.invite) return;
      try {
        await share(win, { title: `Invite for ${m.invite.name}`, text: inviteMessage(m.invite) });
      } catch {
        // The share sheet failed (not closed by the person): copy instead.
        await actions.copy(null, root.querySelector('[data-action="copy"]'));
      }
    },
    copy: async (_id, el) => {
      if (!m.invite) return;
      const ok = await copyText(win, inviteMessage(m.invite));
      m.notice = ok ? 'Copied.' : '';
      m.error = ok ? '' : 'Could not copy. Please select the message and copy it by hand.';
      paint();
      if (ok) flashCopied(win, root, el, 'Copy message', hold, 'invite');
    },
    invite: (id) => attempt(async () => {
      const p = find(id);
      if (!p || p.joined || !p.active || !p.email) return;
      const r = await api.post(`/api/people/${p.id}/invite`, {});
      m.invite = { name: r.person.name, email: r.person.email, ...r.invite };
      m.panel = null;
      m.selected = null; // the sheet makes way for the invite box
    }),
    'reset-yes': (id) => attempt(async () => {
      const p = find(id);
      if (m.panel?.kind !== 'reset' || m.panel.id !== Number(id) || !p) return;
      const r = await api.post(`/api/people/${p.id}/reset-login`, {});
      m.invite = { name: r.person.name, email: r.person.email, ...r.invite };
      m.people = m.people.map((person) => person.id === p.id ? r.person : person);
      m.panel = null;
      m.selected = null; // the sheet makes way for the invite box
    }),
    'role-ask': (id) => {
      const p = find(id);
      if (!p || !p.active || p.id === me()) return;
      openPanel({ kind: 'role', id: p.id, role: nextRole(p) });
    },
    'role-yes': (id) => attempt(async () => {
      const p = find(id);
      if (m.panel?.kind !== 'role' || m.panel.id !== Number(id) || !p) return;
      if (!p.active || p.id === me() || m.panel.role !== nextRole(p)) return;
      const role = m.panel.role;
      await api.patch(`/api/people/${p.id}`, { role });
      m.panel = null;
      await reload();
      m.notice = role === 'admin' ? `${p.name} is now a scheduler.` : `${p.name} is now a volunteer.`;
    }),
    'deactivate-yes': (id) => setActive(id, false, 'active'),
    'reactivate-yes': (id) => setActive(id, true, 'active'),
    'positions-save': (id) => attempt(async () => {
      if (m.panel?.kind !== 'positions' || m.panel.id !== Number(id)) return;
      const p = find(id);
      await api.put(`/api/people/${Number(id)}/positions`, { positionIds: [...m.panel.checked].sort((a, b) => a - b) });
      m.panel = null;
      await reload();
      m.notice = `Saved what ${p ? p.name : 'they'} can do.`;
    }),
  };

  function setActive(id, active, kind) {
    return attempt(async () => {
      const p = find(id);
      if (m.panel?.kind !== kind || m.panel.id !== Number(id) || !p) return;
      await api.patch(`/api/people/${p.id}`, { active });
      m.panel = null;
      await reload();
      m.notice = active ? `${p.name} is active again.` : `${p.name} is deactivated. Their history is kept.`;
    });
  }

  const forms = {
    'add-person': (form) => attempt(async () => {
      const name = String(form.elements.name.value ?? '').trim();
      if (!name) { m.error = 'Please type a name.'; return; }
      const body = { name };
      const email = String(form.elements.email?.value ?? '').trim();
      if (email) body.email = email;
      if (form.elements.scheduler.checked) body.role = 'admin';
      const r = await api.post('/api/people', body);
      m.invite = r.invite ? { name: r.person.name, email: r.person.email, ...r.invite } : null;
      if (!r.invite) m.notice = `${r.person.name} is added. Without an email they cannot log in, but you can schedule them.`;
      m.adding = false;
      m.newName = '';
      await reload();
    }),
    'edit-name': (form) => attempt(async () => {
      const id = Number(form.dataset.id);
      const name = String(form.elements.name.value ?? '').trim();
      if (!name) { m.error = 'Please type a name.'; return; }
      // No email field once they joined: the email is locked then.
      const email = form.elements.email ? String(form.elements.email.value ?? '').trim() : undefined;
      const old = m.people.find((x) => x.id === id)?.email ?? '';
      await api.patch(`/api/people/${id}`, email === undefined || email === old ? { name } : { name, email });
      m.panel = null;
      await reload();
      m.notice = 'Saved.';
    }),
  };

  // A problem goes away once the person starts fixing it.
  root.addEventListener('input', () => {
    if (!m.error) return;
    m.error = '';
    dropProblem(root);
  });
  root.addEventListener('click', (e) => {
    const el = e.target?.closest?.('[data-action]');
    if (!el || el.tagName === 'INPUT') return;
    const fn = actions[el.dataset.action];
    if (fn) fn(Number(el.dataset.id), el);
  });
  root.addEventListener('change', (e) => {
    const el = e.target?.closest?.('[data-action="toggle-position"]');
    if (el) actions['toggle-position'](0, el);
  });
  root.addEventListener('input', (e) => {
    const el = e.target?.closest?.('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'search') { m.query = el.value; paintList(); }
    if (el.dataset.action === 'new-name') m.newName = el.value;
  });
  root.addEventListener('submit', (e) => {
    const form = e.target?.closest?.('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const fn = forms[form.dataset.form];
    if (fn) fn(form);
  });

  const ready = (async () => {
    try {
      await reload();
    } catch (err) {
      m.error = friendlyMessage(err);
    }
    m.loading = false;
    paint();
  })();

  return { model: m, ready, paint };
}

export function render(state) { // eslint-disable-line no-unused-vars
  return String(html`
    ${pageHead(title, 'Everyone in the church you schedule.')}
    <div data-screen>${skeleton('Loading…', 'list', 4)}</div>
  `);
}

export function mount(root, ctx) {
  const screen = root.querySelector('[data-screen]');
  if (!screen) return undefined;
  return createScreen({ api: ctx.api, root: screen, ctx, win: ctx.win ?? globalThis }).ready;
}
