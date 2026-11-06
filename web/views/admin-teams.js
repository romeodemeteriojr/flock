// Teams page (scheduler only): teams, the positions in each team, and how many
// people are able to do each position. Deleting asks "Are you sure?" first.
import { html } from '../lib/html.js';

export const title = 'Teams';

// ---------- pure helpers (tested directly) ----------

export function countWords(n) {
  if (n === 0) return 'Nobody is qualified yet';
  return n === 1 ? '1 person can do this' : `${n} people can do this`;
}

export function friendlyMessage(err) {
  const text = String(err?.message ?? '');
  if (err?.status === 409 && text) return text.endsWith('.') ? text : `${text}.`;
  return text || 'Something went wrong. Please try again.';
}

const cancelBtn = html`<button type="button" class="btn" data-action="cancel">Cancel</button>`;

function nameForm(formName, id, label, value, button) {
  return html`<form class="form card" data-form="${formName}" data-id="${id}" novalidate>
    <div class="field">
      <label for="${formName}-${id}">${label}</label>
      <input id="${formName}-${id}" name="name" type="text" maxlength="60" required value="${value}">
    </div>
    <div class="btn-row"><button type="submit" class="btn btn-primary">${button}</button>${cancelBtn}</div>
  </form>`;
}

function confirmBox(text, yesAction, id, yesLabel) {
  return html`<div class="card" role="alertdialog" aria-label="Confirm">
    <p>${text}</p>
    <div class="btn-row">
      <button type="button" class="btn btn-danger" data-action="${yesAction}" data-id="${id}">${yesLabel}</button>
      <button type="button" class="btn" data-action="cancel">No, go back</button>
    </div></div>`;
}

function positionRow(pos, m) {
  const panel = m.panel && m.panel.id === pos.id && m.panel.kind.endsWith('-position') ? m.panel : null;
  const n = (pos.qualifiedPersonIds ?? []).length;
  let extra = '';
  if (panel?.kind === 'rename-position') extra = nameForm('rename-position', pos.id, 'Position name', pos.name, 'Save name');
  if (panel?.kind === 'delete-position') {
    extra = confirmBox(html`Delete the position <strong>${pos.name}</strong>? This cannot be undone.`, 'delete-position-yes', pos.id, 'Yes, delete it');
  }
  return html`<li data-position-row="${pos.id}">
    <p><strong>${pos.name}</strong> <span class="chip chip-plain" data-count>${countWords(n)}</span></p>
    <div class="btn-row">
      <button type="button" class="btn" data-action="rename-position" data-id="${pos.id}">Rename</button>
      <button type="button" class="btn btn-danger" data-action="delete-position" data-id="${pos.id}">Delete</button>
    </div>
    ${extra}
  </li>`;
}

function teamCard(t, m) {
  const mine = m.panel && m.panel.id === t.id ? m.panel : null;
  let extra = '';
  if (mine?.kind === 'rename-team') extra = nameForm('rename-team', t.id, 'Team name', t.name, 'Save name');
  if (mine?.kind === 'delete-team') {
    extra = confirmBox(html`Delete the team <strong>${t.name}</strong>? This cannot be undone. A team that still has positions in use cannot be deleted.`, 'delete-team-yes', t.id, 'Yes, delete it');
  }
  if (mine?.kind === 'add-position') extra = nameForm('add-position', t.id, 'New position name', '', 'Add position');
  return html`<section class="card" data-team="${t.id}">
    <h2>${t.name}</h2>
    <div class="btn-row">
      <button type="button" class="btn" data-action="add-position" data-id="${t.id}">Add position</button>
      <button type="button" class="btn" data-action="rename-team" data-id="${t.id}">Rename team</button>
      <button type="button" class="btn btn-danger" data-action="delete-team" data-id="${t.id}">Delete team</button>
    </div>
    ${extra}
    ${t.positions.length ? html`<ul class="list">${t.positions.map((p) => positionRow(p, m))}</ul>`
    : html`<p class="hint">No positions yet.</p>`}
  </section>`;
}

export function renderScreen(m) {
  if (m.loading) return String(html`<p class="loading">Loading…</p>`);
  return String(html`
    ${m.error ? html`<p class="form-error" role="alert">${m.error}</p>` : ''}
    ${m.notice ? html`<p class="hint" role="status">${m.notice}</p>` : ''}
    <form class="form card" data-form="add-team" novalidate>
      <h2>Add team</h2>
      <div class="field">
        <label for="new-team">Team name</label>
        <input id="new-team" name="name" type="text" maxlength="60" required>
      </div>
      <button type="submit" class="btn btn-primary">Add team</button>
    </form>
    ${m.teams.length ? m.teams.map((t) => teamCard(t, m)) : html`<p class="hint">No teams yet. Add your first team above.</p>`}
  `);
}

// ---------- screen controller ----------

export function createScreen({ api, root }) {
  const m = { teams: [], loading: true, panel: null, error: '', notice: '' };
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
  const ask = (kind) => (id) => { m.panel = { kind, id }; m.error = ''; m.notice = ''; paint(); };

  const actions = {
    cancel: () => { m.panel = null; paint(); },
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
    'add-team': nameSaver(false, () => '/api/teams', (p, b) => api.post(p, b), 'Team added.'),
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
    <h1 tabindex="-1">${title}</h1>
    <div data-screen><p class="loading">Loading…</p></div>
  `);
}

export function mount(root, ctx) {
  const screen = root.querySelector('[data-screen]');
  if (!screen) return undefined;
  return createScreen({ api: ctx.api, root: screen }).ready;
}
