// People page (scheduler only): find, add and look after the people in the church.
// All clicks go through one delegated listener on the screen. Anything risky first
// shows a plain "Are you sure?" step; nothing is sent until the person says yes.
import { html, raw } from '../lib/html.js';
import { iconSlot } from '../lib/icons.js';
import { flashCopied } from '../lib/copyflash.js';
import { iconButton } from '../lib/iconbutton.js';
import { avatar } from '../lib/avatar.js';
import { toasts } from '../lib/toast.js';
import { skeleton, emptyState, pageHead } from '../lib/ui.js';

export const title = 'People';

// ---------- pure helpers (tested directly) ----------

// Keep people whose name or username contains every word typed (ignores case).
export function filterPeople(people, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return people;
  return people.filter((p) => {
    const hay = `${p.name} ${p.username}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// Same idea as the server: "Sam Ortiz" -> "sam.ortiz".
export function suggestUsername(name) {
  let base = String(name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean).join('.');
  base = base.slice(0, 24).replace(/\.+$/, '');
  if (!base) return '';
  if (base.length < 3) base = (base + '.user').slice(0, 24);
  return base;
}

// Turn an API error into plain words for the scheduler.
export function friendlyMessage(err) {
  const text = String(err?.message ?? '');
  if (err?.status === 409) {
    if (/at least one/i.test(text)) {
      return "That would leave nobody in charge. There must always be at least one active scheduler, so make someone else a scheduler first.";
    }
    if (/own account/i.test(text)) return "You can't deactivate your own account.";
    if (/username/i.test(text)) return 'That username is already taken. Please pick a different one, or leave it empty.';
  }
  return text || 'Something went wrong. Please try again.';
}

const roleWord = (p) => (p.role === 'admin' ? 'Scheduler' : 'Volunteer');

// The level a person would get if their role button were pressed.
const nextRole = (p) => (p.role === 'admin' ? 'member' : 'admin');

function roleConfirmPanel(p, target) {
  const yes = target === 'admin' ? 'Yes, make a scheduler' : 'Yes, make a volunteer';
  const text = target === 'admin'
    ? html`Make ${p.name} a scheduler? ${p.name} will be able to change the whole schedule and see every volunteer's name and username.`
    : html`Make ${p.name} a volunteer? ${p.name} will only see their own schedule.`;
  return html`<div class="confirm" role="alertdialog" aria-label="Confirm">
    <p>${text}</p>
    <div class="btn-row">
      <button type="button" class="btn btn-primary" data-action="role-yes" data-id="${p.id}">${yes}</button>
      <button type="button" class="btn" data-action="cancel">No, go back</button>
    </div></div>`;
}

function passwordBox(secret) {
  return html`
    <section class="card secret-box" id="secret-box" role="alert" aria-labelledby="secret-head">
      <h2 id="secret-head">${iconSlot('lock', 'icon-sm')} Password for ${secret.name}</h2>
      <p class="lead">Give this to ${secret.name}: <strong data-secret>${secret.password}</strong>. It is only shown once, and ${secret.name} will choose their own password at first login.</p>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" data-action="copy" data-copy-key="secret">${iconSlot('copy')} Copy</button>
        <button type="button" class="btn" data-action="done">Done</button>
      </div>
    </section>`;
}

function confirmPanel(p, kind) {
  if (kind === 'reset') {
    return html`<div class="confirm" role="alertdialog" aria-label="Confirm">
      <p>Make a new temporary password for <strong>${p.name}</strong>? Their old password will stop working.</p>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" data-action="reset-yes" data-id="${p.id}">Yes, reset it</button>
        <button type="button" class="btn" data-action="cancel">No, go back</button>
      </div></div>`;
  }
  if (p.active) {
    return html`<div class="confirm confirm-danger" role="alertdialog" aria-label="Confirm">
      <p>Deactivate <strong>${p.name}</strong>? They will not be able to log in and will not be offered for scheduling. Nothing is deleted: their history is kept, and you can reactivate them any time.</p>
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

function editPanel(p) {
  return html`<form class="form confirm" data-form="edit-name" data-id="${p.id}" novalidate>
    <div class="field">
      <label for="edit-name-${p.id}">Name</label>
      <input id="edit-name-${p.id}" name="name" type="text" maxlength="80" required value="${p.name}">
    </div>
    <div class="btn-row">
      <button type="submit" class="btn btn-primary">Save name</button>
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
function personRow(p, m) {
  const panel = m.panel && m.panel.id === p.id ? m.panel : null;
  let extra = '';
  if (panel) {
    if (panel.kind === 'reset' || panel.kind === 'active') extra = confirmPanel(p, panel.kind);
    else if (panel.kind === 'role') extra = roleConfirmPanel(p, panel.role);
    else if (panel.kind === 'edit') extra = editPanel(p);
    else if (panel.kind === 'positions') extra = checklistPanel(p, m.teams, panel.checked);
  }
  const roleButton = !p.active ? ''
    : p.id === m.me ? html`<span class="hint">That's you</span>`
      : iconButton('shield', nextRole(p) === 'admin' ? 'Make scheduler' : 'Make volunteer', { dataAction: 'role-ask', dataId: p.id });
  const activeButton = iconButton(p.active ? 'user-off' : 'user-check', p.active ? 'Deactivate' : 'Reactivate', { dataAction: 'active-ask', dataId: p.id, danger: p.active });
  return html`<li data-person="${p.id}">
    <div class="person${p.active ? '' : ' is-inactive'}">
      ${avatar(p.name)}
      <div class="person-text">
        <p class="person-name"><strong>${p.name}</strong> <span class="hint">(${p.username})</span></p>
        <p class="person-chips"><span class="chip chip-plain">${roleWord(p)}</span>
        ${p.active ? '' : html`<span class="chip chip-bad">Deactivated</span>`}</p>
      </div>
    </div>
    <div class="btn-row btn-row-compact">
      ${roleButton}
      ${iconButton('edit', 'Edit name', { dataAction: 'edit', dataId: p.id })}
      ${iconButton('list-check', 'What can they do?', { dataAction: 'positions', dataId: p.id })}
      ${iconButton('key', 'Reset password', { dataAction: 'reset-ask', dataId: p.id })}
      ${activeButton}
    </div>
    ${extra}
  </li>`;
}

export function renderList(m) {
  const shown = filterPeople(m.people, m.query);
  if (!m.people.length) return String(emptyState('No people yet.', 'art-people'));
  if (!shown.length) return String(emptyState('Nobody matches that. Try fewer letters.', 'art-lost'));
  return String(html`<ul class="list people-list">${shown.map((p) => personRow(p, m))}</ul>`);
}

export function renderScreen(m) {
  if (m.loading) return String(skeleton('Loading…', 'list', 4));
  const suggestion = suggestUsername(m.newName);
  return String(html`
    ${m.error ? html`<p class="form-error" role="alert">${m.error}</p>` : ''}
    ${toasts([[m.notice, 'ok']])}
    ${m.secret ? passwordBox(m.secret) : ''}
    ${m.adding ? html`
      <form class="form card form-card" data-form="add-person" novalidate>
        <h2 class="card-title">Add person</h2>
        <div class="field">
          <label for="new-name">Name</label>
          <input id="new-name" name="name" type="text" maxlength="80" required data-action="new-name" value="${m.newName}">
        </div>
        <div class="field">
          <label for="new-username">Username (optional)</label>
          <input id="new-username" name="username" type="text" autocapitalize="none" spellcheck="false" aria-describedby="new-username-hint">
          <p class="hint" id="new-username-hint">Leave it empty and we will use: <strong data-suggest>${suggestion || 'a username made from the name'}</strong></p>
        </div>
        <div class="field">
          <label class="check"><input type="checkbox" name="scheduler"> Make this person a scheduler</label>
        </div>
        <div class="btn-row">
          <button type="submit" class="btn btn-primary">Add person</button>
          <button type="button" class="btn" data-action="add-cancel">Cancel</button>
        </div>
      </form>` : html`<div class="btn-row add-person-row"><button type="button" class="btn btn-primary" data-action="add-open">${iconSlot('plus')} Add person</button></div>`}
    <div class="card info-card">
      ${iconSlot('info', 'info-icon')}
      <div>
      <p>Scheduler: can manage people, teams, services and the schedule.</p>
      <p>Volunteer: can see their own schedule and mark days they cannot serve.</p>
      </div>
    </div>
    <div class="field search-field">
      <label for="people-search">Search by name or username</label>
      <div class="input-icon">${iconSlot('search')}<input id="people-search" type="search" data-action="search" autocomplete="off" value="${m.query}"></div>
    </div>
    <div data-list>${raw(renderList(m))}</div>
  `);
}

// ---------- screen controller ----------

export function createScreen({ api, root, ctx = {}, win = globalThis }) {
  const m = {
    people: [], teams: [], query: '', loading: true, adding: false, newName: '',
    panel: null, secret: null, error: '', notice: '', me: null,
  };
  const hold = { timer: null, key: null };
  const me = () => ctx.state?.user?.id ?? null;
  let busy = false;

  const paint = () => { root.innerHTML = renderScreen(m); };
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

  const actions = {
    'add-open': () => { m.adding = true; m.error = ''; m.notice = ''; paint(); },
    'add-cancel': () => { m.adding = false; m.newName = ''; paint(); },
    cancel: () => { m.panel = null; paint(); },
    done: () => { m.secret = null; paint(); },
    edit: (id) => { m.panel = { kind: 'edit', id }; paint(); },
    'reset-ask': (id) => { m.panel = { kind: 'reset', id }; paint(); },
    'active-ask': (id) => { m.panel = { kind: 'active', id }; paint(); },
    positions: (id) => {
      const p = find(id);
      m.panel = { kind: 'positions', id, checked: new Set(p ? p.positionIds : []) };
      paint();
    },
    'toggle-position': (_id, el) => {
      if (m.panel?.kind !== 'positions') return;
      const pid = Number(el.dataset.position);
      if (el.checked) m.panel.checked.add(pid); else m.panel.checked.delete(pid);
    },
    copy: async (_id, el) => {
      let ok = false;
      try {
        if (!win.navigator?.clipboard?.writeText) throw new Error('no clipboard');
        await win.navigator.clipboard.writeText(m.secret.password);
        m.notice = 'Copied.';
        ok = true;
      } catch {
        m.notice = 'Could not copy. Please select the password and copy it by hand.';
      }
      paint();
      if (ok) flashCopied(win, root, el, 'Copy', hold, 'secret');
    },
    'reset-yes': (id) => attempt(async () => {
      const p = find(id);
      if (m.panel?.kind !== 'reset' || m.panel.id !== Number(id) || !p) return;
      const r = await api.post(`/api/people/${p.id}/reset-password`, {});
      m.secret = { name: p.name, password: r.tempPassword };
      m.panel = null;
    }),
    'role-ask': (id) => {
      const p = find(id);
      if (!p || !p.active || p.id === me()) return;
      m.panel = { kind: 'role', id: p.id, role: nextRole(p) };
      paint();
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
      const username = String(form.elements.username.value ?? '').trim();
      if (!name) { m.error = 'Please type a name.'; return; }
      const body = { name };
      if (username) body.username = username;
      if (form.elements.scheduler.checked) body.role = 'admin';
      const r = await api.post('/api/people', body);
      m.secret = { name: r.person.name, password: r.tempPassword };
      m.adding = false;
      m.newName = '';
      await reload();
    }),
    'edit-name': (form) => attempt(async () => {
      const id = Number(form.dataset.id);
      const name = String(form.elements.name.value ?? '').trim();
      if (!name) { m.error = 'Please type a name.'; return; }
      await api.patch(`/api/people/${id}`, { name });
      m.panel = null;
      await reload();
      m.notice = 'Name saved.';
    }),
  };

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
    if (el.dataset.action === 'new-name') {
      m.newName = el.value;
      const s = root.querySelector('[data-suggest]');
      if (s) s.textContent = suggestUsername(m.newName) || 'a username made from the name';
    }
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
    ${pageHead(title, 'Everyone in the church who can log in.')}
    <div data-screen>${skeleton('Loading…', 'list', 4)}</div>
  `);
}

export function mount(root, ctx) {
  const screen = root.querySelector('[data-screen]');
  if (!screen) return undefined;
  return createScreen({ api: ctx.api, root: screen, ctx }).ready;
}
