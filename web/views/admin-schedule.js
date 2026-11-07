// Schedule page (scheduler only): the next 8 weeks. On wide screens a grid
// (dates down, positions across, grouped by team); on phones a card per date.
// Both are in the page; style.css shows the right one. Tapping a slot opens
// the slot panel (suggestions, assign, remove person).
import { html } from '../lib/html.js';
import { formatDate, formatTime, todayString } from '../lib/dates.js';
import { createSlotPanel, statusChip, statusOf } from '../lib/slotpanel.js';
import { createSheet } from '../lib/sheet.js';
import { iconSlot } from '../lib/icons.js';
import { toasts } from '../lib/toast.js';
import { skeleton, emptyState, pageHead } from '../lib/ui.js';
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
  if (has) {
    return html`<button type="button" class="slot-btn" data-action="slot-open" data-id="${slot.id}">
      <span class="slot-who">${slot.personName}</span>
      ${statusChip(statusOf(slot), { compact: true })}
    </button>`;
  }
  return html`<button type="button" class="slot-btn is-open" data-action="slot-open" data-id="${slot.id}" aria-label="Nobody yet, choose someone">
    ${iconSlot('plus', 'icon-sm')}
  </button>`;
}

const todayContent = html` ${iconSlot('dot', 'icon-today')}<span class="visually-hidden">Today</span>`;

function grid(s, today) {
  return html`<div class="table-wrap sched-grid">
    <table class="sched-table">
      <caption class="visually-hidden">Schedule for the next ${WEEKS} weeks</caption>
      <thead>
        <tr><th scope="col" rowspan="2" class="sched-corner">Date</th>${s.columns.map((c) => html`<th scope="colgroup" colspan="${c.positions.length}" class="sched-team">${c.teamName}</th>`)}</tr>
        <tr>${s.columns.map((c) => c.positions.map((p) => html`<th scope="col" class="sched-pos">${p.name}</th>`))}</tr>
      </thead>
      <tbody>${s.rows.map((r) => html`<tr data-row="${r.service.id}"${r.service.date === today ? html` class="is-today"` : ''}>
        <th scope="row" class="sched-date"><span class="sched-day num">${formatDate(r.service.date)}</span>${r.service.date === today ? todayContent : ''}<br><span class="num">${formatTime(r.service.time)}</span><br><span class="hint">${r.service.title}</span></th>
        ${s.columns.map((c) => c.positions.map((p) => {
    const slots = r.cells.get(p.id) ?? [];
    return html`<td>${slots.length ? slots.map(slotButton) : html`<span class="hint not-needed">Not needed</span>`}</td>`;
  }))}
      </tr>`)}</tbody>
    </table>
  </div>`;
}

function cards(s, today) {
  return html`<ul class="cards sched-cards">${s.rows.map((r) => html`<li class="card sched-card${r.service.date === today ? ' is-today' : ''}" data-card="${r.service.id}">
    <h2 class="num">${formatDate(r.service.date)} at ${formatTime(r.service.time)}${r.service.date === today ? todayContent : ''}</h2>
    <p class="hint">${r.service.title}</p>
    ${s.columns.filter((c) => c.positions.some((p) => r.cells.has(p.id))).map((c) => html`<h3 class="team-title">${c.teamName}</h3>
      <ul class="list slot-list">${c.positions.filter((p) => r.cells.has(p.id)).map((p) => html`<li>
        <p class="slot-pos"><strong>${p.name}</strong></p>
        ${r.cells.get(p.id).map(slotButton)}
      </li>`)}</ul>`)}
    ${r.service.slots?.length ? '' : html`<p class="hint">No positions on this date.</p>`}
  </li>`)}</ul>`;
}

export function renderScreen(m, panelHtml = '') {
  if (m.loading) return String(skeleton('Loading…', 'rows', 6));
  const s = buildSchedule(m.services, m.teams);
  return String(html`
    ${m.error ? html`<p class="form-error" role="alert">${m.error}</p>` : ''}
    ${toasts([[m.notice, 'ok']])}
    ${panelHtml}
    <p class="hint sched-range">${iconSlot('calendar', 'icon-sm')} <span class="num">${formatDate(m.from)} to ${formatDate(m.to)}</span>. Tap a position to fill it.</p>
    ${s.rows.length ? html`${grid(s, m.today)}${cards(s, m.today)}`
    : emptyState(`No services in the next ${WEEKS} weeks. Add them on the Services page.`, 'art-calendar')}
  `);
}

// ---------- screen controller ----------

export function createScreen({ api, root, today = todayString() }) {
  const m = { services: [], teams: [], loading: true, error: '', notice: '', today, from: today, to: addDays(today, WEEKS * 7 - 1) };
  const paint = () => {
    sheet.before();
    root.innerHTML = renderScreen(m, panel.render());
    sheet.update();
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

  const sheet = createSheet({ root, isOpen: () => !!panel.state, close: () => panel.close() });

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
      sheet.opened(id);
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
    ${pageHead(title, `The next ${WEEKS} weeks. Tap any position to fill it.`)}
    <div data-screen>${skeleton('Loading…', 'rows', 6)}</div>
  `);
}

export function mount(root, ctx) {
  const screen = root?.querySelector?.('[data-screen]');
  if (!screen) return undefined;
  return createScreen({ api: ctx.api, root: screen, today: ctx.today ?? todayString() }).ready;
}
