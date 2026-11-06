// Schedule page (scheduler only): the next 8 weeks. On wide screens a grid
// (dates down, positions across, grouped by team); on phones a card per date.
// Both are in the page; style.css shows the right one. Tapping a slot opens
// the slot panel (suggestions, assign, remove person).
import { html } from '../lib/html.js';
import { formatDate, formatTime, todayString } from '../lib/dates.js';
import { createSlotPanel, statusChip, statusOf, focusPanel } from '../lib/slotpanel.js';
import { addDays, sortServices } from './admin-services.js';

export const title = 'Schedule';
export const WEEKS = 8;

// ---------- pure helpers (tested directly) ----------

// Columns (teams, each with its positions) in the Teams page order, then any
// position only seen in slots. Rows: services by date and time, with the
// slots of each position in slot order.
export function buildSchedule(services, teams) {
  const columns = [];
  const posIndex = new Map();
  const add = (teamId, teamName, posId, posName) => {
    if (posIndex.has(posId)) return;
    let col = columns.find((c) => c.teamId === teamId);
    if (!col) { col = { teamId, teamName, positions: [] }; columns.push(col); }
    col.positions.push({ id: posId, name: posName });
    posIndex.set(posId, col);
  };
  const used = new Set((services ?? []).flatMap((s) => (s.slots ?? []).map((x) => x.positionId)));
  for (const t of teams ?? []) for (const p of t.positions ?? []) if (used.has(p.id)) add(t.id, t.name, p.id, p.name);
  for (const s of services ?? []) for (const x of s.slots ?? []) add(x.teamId, x.teamName, x.positionId, x.positionName);

  const rows = sortServices(services ?? []).map((svc) => {
    const cells = new Map();
    for (const x of [...(svc.slots ?? [])].sort((a, b) => a.id - b.id)) {
      if (!cells.has(x.positionId)) cells.set(x.positionId, []);
      cells.get(x.positionId).push(x);
    }
    return { service: svc, cells };
  });
  return { columns: columns.filter((c) => c.positions.length), rows };
}

// The slot as the panel wants it (adds the service's date, time and title).
export const panelSlot = (slot, svc) => ({ ...slot, date: svc.date, time: svc.time, title: svc.title });

// ---------- rendering ----------

function slotButton(slot) {
  const has = slot.personId !== null && slot.personId !== undefined;
  return html`<button type="button" class="slot-btn" data-action="slot-open" data-id="${slot.id}">
    <span class="slot-who">${has ? slot.personName : 'Nobody yet'}</span>
    ${statusChip(statusOf(slot))}
  </button>`;
}

function grid(s) {
  return html`<div class="table-wrap sched-grid">
    <table>
      <caption class="visually-hidden">Schedule for the next ${WEEKS} weeks</caption>
      <thead>
        <tr><th scope="col" rowspan="2">Date</th>${s.columns.map((c) => html`<th scope="colgroup" colspan="${c.positions.length}" class="sched-team">${c.teamName}</th>`)}</tr>
        <tr>${s.columns.map((c) => c.positions.map((p) => html`<th scope="col">${p.name}</th>`))}</tr>
      </thead>
      <tbody>${s.rows.map((r) => html`<tr data-row="${r.service.id}">
        <th scope="row">${formatDate(r.service.date)}<br>${formatTime(r.service.time)}<br><span class="hint">${r.service.title}</span></th>
        ${s.columns.map((c) => c.positions.map((p) => {
    const slots = r.cells.get(p.id) ?? [];
    return html`<td>${slots.length ? slots.map(slotButton) : html`<span class="hint">Not needed</span>`}</td>`;
  }))}
      </tr>`)}</tbody>
    </table>
  </div>`;
}

function cards(s) {
  return html`<ul class="cards sched-cards">${s.rows.map((r) => html`<li class="card" data-card="${r.service.id}">
    <h2>${formatDate(r.service.date)} at ${formatTime(r.service.time)}</h2>
    <p class="hint">${r.service.title}</p>
    ${s.columns.filter((c) => c.positions.some((p) => r.cells.has(p.id))).map((c) => html`<h3>${c.teamName}</h3>
      <ul class="list">${c.positions.filter((p) => r.cells.has(p.id)).map((p) => html`<li>
        <p><strong>${p.name}</strong></p>
        ${r.cells.get(p.id).map(slotButton)}
      </li>`)}</ul>`)}
    ${r.service.slots?.length ? '' : html`<p class="hint">No positions on this date.</p>`}
  </li>`)}</ul>`;
}

export function renderScreen(m, panelHtml = '') {
  if (m.loading) return String(html`<p class="loading">Loading…</p>`);
  const s = buildSchedule(m.services, m.teams);
  return String(html`
    ${m.error ? html`<p class="form-error" role="alert">${m.error}</p>` : ''}
    ${m.notice ? html`<p class="hint" role="status">${m.notice}</p>` : ''}
    ${panelHtml}
    <p class="hint">${formatDate(m.from)} to ${formatDate(m.to)}. Tap a position to fill it.</p>
    ${s.rows.length ? html`${grid(s)}${cards(s)}`
    : html`<p class="empty">No services in the next ${WEEKS} weeks. Add them on the Services page.</p>`}
  `);
}

// ---------- screen controller ----------

export function createScreen({ api, root, today = todayString() }) {
  const m = { services: [], teams: [], loading: true, error: '', notice: '', from: today, to: addDays(today, WEEKS * 7 - 1) };
  let panelWasOpen = false;
  const paint = () => {
    root.innerHTML = renderScreen(m, panel.render());
    const open = !!panel.state;
    if (open && !panelWasOpen) focusPanel(root);
    panelWasOpen = open;
  };
  const reload = async () => {
    const [t, s] = await Promise.all([api.get('/api/teams'), api.get(`/api/services?from=${m.from}&to=${m.to}`)]);
    m.teams = Array.isArray(t) ? t : [];
    m.services = Array.isArray(s) ? s : [];
  };
  const panel = createSlotPanel({
    api,
    paint: () => paint(),
    changed: async (notice) => {
      m.notice = notice;
      m.error = '';
      try { await reload(); } catch (err) { m.error = String(err?.message || 'Could not reload the schedule.'); }
    },
  });

  function findSlot(id) {
    for (const svc of m.services) {
      const slot = (svc.slots ?? []).find((x) => x.id === id);
      if (slot) return panelSlot(slot, svc);
    }
    return null;
  }

  root.addEventListener('click', (e) => {
    const el = e.target?.closest?.('[data-action]');
    if (!el) return undefined;
    const action = el.dataset.action;
    const id = Number(el.dataset.id);
    if (action === 'slot-open') {
      const slot = findSlot(id);
      if (!slot) return undefined;
      m.notice = '';
      return panel.open(slot);
    }
    const r = panel.handle(action, id);
    return r === true || r === false ? undefined : r;
  });

  const ready = (async () => {
    try { await reload(); } catch (err) { m.error = String(err?.message || 'Could not load the schedule.'); }
    m.loading = false;
    paint();
  })();
  return { model: m, ready, paint, panel };
}

export function render(state) { // eslint-disable-line no-unused-vars
  return String(html`
    <h1 tabindex="-1">${title}</h1>
    <div data-screen><p class="loading">Loading…</p></div>
  `);
}

export function mount(root, ctx) {
  const screen = root?.querySelector?.('[data-screen]');
  if (!screen) return undefined;
  return createScreen({ api: ctx.api, root: screen, today: ctx.today ?? todayString() }).ready;
}
