// Teams page (scheduler only): teams, the positions in each team, and how many
// people are able to do each position. A team stays closed until tapped; a
// position shows its buttons once tapped. Deleting asks "Are you sure?" first.
import { html } from '../lib/html.js';
import { iconSlot } from '../lib/icons.js';
import { toasts } from '../lib/toast.js';
import { skeleton, emptyState, pageHead, disclosure, refocus } from '../lib/ui.js';

export const title = 'Teams';

// ---------- pure helpers (tested directly) ----------

export function countWords(n) {
  if (n === 0) return 'Nobody is qualified yet';
  return n === 1 ? '1 person can do this' : `${n} people can do this`;
}

export const positionsWord = (n) => (n === 0 ? 'No positions yet' : n === 1 ? '1 position' : `${n} positions`);

// Panels that belong to a team row (the others belong to a position row).
const TEAM_PANELS = Object.freeze(['rename-team', 'delete-team', 'add-position']);

export function friendlyMessage(err) {
  const text = String(err?.message ?? '');
  if (err?.status === 409 && text) return text.endsWith('.') ? text : `${text}.`;
  return text || 'Something went wrong. Please try again.';
}

const cancelBtn = html`<button type="button" class="btn" data-action="cancel">Cancel</button>`;

function nameForm(formName, id, label, value, button) {
  return html`<form class="form confirm" data-form="${formName}" data-id="${id}" novalidate>
    <div class="field">
      <label for="${formName}-${id}">${label}</label>
      <input id="${formName}-${id}" name="name" type="text" maxlength="60" required value="${value}">
    </div>
    <div class="btn-row"><button type="submit" class="btn btn-primary">${button}</button>${cancelBtn}</div>
  </form>`;
}

function confirmBox(text, yesAction, id, yesLabel) {
  return html`<div class="confirm confirm-danger" role="alertdialog" aria-label="Confirm">
    <p>${text}</p>
    <div class="btn-row">
      <button type="button" class="btn btn-danger" data-action="${yesAction}" data-id="${id}">${yesLabel}</button>
      <button type="button" class="btn" data-action="cancel">No, go back</button>
    </div></div>`;
}

function positionRow(pos, m) {
  const panel = m.panel && m.panel.id === pos.id && !TEAM_PANELS.includes(m.panel.kind) ? m.panel : null;
  const n = (pos.qualifiedPersonIds ?? []).length;
  const selected = m.selected === pos.id;
  let extra = '';
  if (panel?.kind === 'rename-position') extra = nameForm('rename-position', pos.id, 'Position name', pos.name, 'Save name');
  if (panel?.kind === 'delete-position') {
    extra = confirmBox(html`Delete the position <strong>${pos.name}</strong>? This cannot be undone.`, 'delete-position-yes', pos.id, 'Yes, delete it');
  }
  const label = html`<span class="position-main"><strong class="position-name">${pos.name}</strong>
    <span class="chip ${n ? 'chip-info' : 'chip-plain'}" data-count>${iconSlot('users', 'chip-icon')}${countWords(n)}</span></span>`;
  return html`<li class="position-row" data-position-row="${pos.id}">
    ${disclosure({ action: 'select', id: pos.id, open: selected, label, cls: 'row-select' })}
    ${selected ? html`<div class="btn-row btn-row-compact row-actions">
      <button type="button" class="btn btn-sm" data-action="rename-position" data-id="${pos.id}">${iconSlot('edit')} Edit name<span class="visually-hidden"> of ${pos.name}</span></button>
      <button type="button" class="btn btn-sm btn-danger" data-action="delete-position" data-id="${pos.id}">${iconSlot('trash')} Delete<span class="visually-hidden"> ${pos.name}</span></button>
    </div>` : ''}
    ${extra}
  </li>`;
}

function teamCard(t, m) {
  const mine = m.panel && m.panel.id === t.id && TEAM_PANELS.includes(m.panel.kind) ? m.panel : null;
  const open = !!m.open?.has(t.id);
  let extra = '';
  if (mine?.kind === 'rename-team') extra = nameForm('rename-team', t.id, 'Team name', t.name, 'Save name');
  if (mine?.kind === 'delete-team') {
    extra = confirmBox(html`Delete the team <strong>${t.name}</strong>? This cannot be undone. A team that still has positions in use cannot be deleted.`, 'delete-team-yes', t.id, 'Yes, delete it');
  }
  if (mine?.kind === 'add-position') extra = nameForm('add-position', t.id, 'New position name', '', 'Add position');
  const label = html`${t.name}<span class="disclosure-sub">${positionsWord(t.positions.length)}</span>`;
  return html`<section class="card team-card" data-team="${t.id}">
    <h2 class="team-head">${disclosure({ action: 'toggle-team', id: t.id, open, label })}</h2>
    ${open ? html`<div class="btn-row btn-row-compact">
      <button type="button" class="btn btn-sm" data-action="add-position" data-id="${t.id}">${iconSlot('plus')} Add position</button>
      <button type="button" class="btn btn-sm" data-action="rename-team" data-id="${t.id}">${iconSlot('edit')} Edit name<span class="visually-hidden"> of ${t.name}</span></button>
      <button type="button" class="btn btn-sm btn-danger" data-action="delete-team" data-id="${t.id}">${iconSlot('trash')} Delete team</button>
    </div>
    ${extra}
    ${t.positions.length ? html`<ul class="list position-list">${t.positions.map((p) => positionRow(p, m))}</ul>`
    : html`<p class="hint">No positions yet.</p>`}` : ''}
  </section>`;
}

export function renderScreen(m) {
  if (m.loading) return String(skeleton('Loading…', 'cards', 2));
  return String(html`
    ${m.error ? html`<p class="form-error" role="alert">${m.error}</p>` : ''}
    ${toasts([[m.notice, 'ok']])}
    <form class="form card form-card" data-form="add-team" novalidate>
      <h2 class="card-title">Add team</h2>
      <div class="field">
        <label for="new-team">Team name</label>
        <input id="new-team" name="name" type="text" maxlength="60" required>
      </div>
      <button type="submit" class="btn btn-primary">${iconSlot('plus')} Add team</button>
    </form>
    ${m.teams.length ? m.teams.map((t) => teamCard(t, m)) : emptyState('No teams yet. Add your first team above.', 'art-people')}
  `);
}

// ---------- screen controller ----------

export function createScreen({ api, root }) {
  // open: the teams that are open; selected: the position whose buttons show.
  const m = { teams: [], loading: true, panel: null, error: '', notice: '', open: new Set(), selected: null };
  let busy = false;
  const paint = () => { root.innerHTML = renderScreen(m); };
  const reload = async () => {
    const t = await api.get('/api/teams');
    m.teams = Array.isArray(t) ? t : [];
  };

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
      m.panel = null;
    } finally {
      busy = false;
    }
    paint();
  }

  const asking = (kind, id) => m.panel?.kind === kind && m.panel.id === Number(id);
  const ask = (kind) => (id) => {
    if (TEAM_PANELS.includes(kind)) m.open.add(id); else m.selected = id;
    m.panel = { kind, id };
    m.error = '';
    m.notice = '';
    paint();
  };

  const actions = {
    cancel: () => { m.panel = null; paint(); },
    'toggle-team': (id) => { if (m.open.delete(id)) m.panel = null; else m.open.add(id); paint(); refocus(root, 'toggle-team', id); },
    select: (id) => { m.selected = m.selected === id ? null : id; m.panel = null; paint(); refocus(root, 'select', id); },
    'add-position': ask('add-position'),
    'rename-team': ask('rename-team'),
    'delete-team': ask('delete-team'),
    'rename-position': ask('rename-position'),
    'delete-position': ask('delete-position'),
    'delete-team-yes': (id) => attempt(async () => {
      if (!asking('delete-team', id)) return;
      await api.del(`/api/teams/${Number(id)}`);
      m.panel = null;
      await reload();
      m.notice = 'Team deleted.';
    }),
    'delete-position-yes': (id) => attempt(async () => {
      if (!asking('delete-position', id)) return;
      await api.del(`/api/positions/${Number(id)}`);
      m.panel = null;
      await reload();
      m.notice = 'Position deleted.';
    }),
  };

  const cleanName = (form) => String(form.elements.name.value ?? '').trim();
  const nameSaver = (kind, path, method, done) => (form) => attempt(async () => {
    const id = Number(form.dataset.id);
    const name = cleanName(form);
    if (!name) { m.error = 'Please type a name.'; return; }
    await method(path(id), { name });
    if (kind) m.panel = null;
    await reload();
    m.notice = done;
  });
  const forms = {
    'add-team': nameSaver(false, () => '/api/teams', async (p, b) => {
      const team = await api.post(p, b);
      if (team?.id) m.open.add(team.id); // open, ready for its first position
    }, 'Team added.'),
    'rename-team': nameSaver(true, (id) => `/api/teams/${id}`, (p, b) => api.patch(p, b), 'Team renamed.'),
    'add-position': nameSaver(true, (id) => `/api/teams/${id}/positions`, (p, b) => api.post(p, b), 'Position added.'),
    'rename-position': nameSaver(true, (id) => `/api/positions/${id}`, (p, b) => api.patch(p, b), 'Position renamed.'),
  };

  root.addEventListener('click', (e) => {
    const el = e.target?.closest?.('[data-action]');
    const fn = el && actions[el.dataset.action];
    if (fn) fn(Number(el.dataset.id));
  });
  root.addEventListener('submit', (e) => {
    const form = e.target?.closest?.('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const fn = forms[form.dataset.form];
    if (fn) fn(form);
  });

  const ready = (async () => {
    try { await reload(); } catch (err) { m.error = friendlyMessage(err); }
    m.loading = false;
    paint();
  })();
  return { model: m, ready, paint };
}

export function render(state) { // eslint-disable-line no-unused-vars
  return String(html`
    ${pageHead(title, 'Teams, the positions in each, and who can do them.')}
    <div data-screen>${skeleton('Loading…', 'cards', 2)}</div>
  `);
}

export function mount(root, ctx) {
  const screen = root.querySelector('[data-screen]');
  if (!screen) return undefined;
  return createScreen({ api: ctx.api, root: screen }).ready;
}
