// Schedule page (scheduler only): the next 8 weeks. On wide screens a grid
// (dates down, positions across, grouped by team); on phones a card per date
// that stays closed (a count of open, waiting and confirmed positions) until
// tapped. Both are in the page; style.css shows the right one. Tapping a slot
// opens the slot panel (suggestions, assign, remove person).
import { html, raw } from '../lib/html.js';
import { formatDate, formatTime, todayString } from '../lib/dates.js';
import { createSlotPanel, statusChip, statusOf, STATUS } from '../lib/slotpanel.js';
import { createSheet, host, watchHost } from '../lib/sheet.js';
import { swipeToDismiss } from '../lib/swipe.js';
import { iconSlot } from '../lib/icons.js';
import { toasts } from '../lib/toast.js';
import { skeleton, emptyState, pageHead, disclosure, refocus } from '../lib/ui.js';
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

// The Monday after today (today itself is never returned): the default week to fill.
export function nextMonday(today) {
  const [y, m, d] = String(today).split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(today, ((8 - dow) % 7) || 7);
}

export const AUTOFILL_MAX_WEEKS = 8;

// How many of a service's positions are open, waiting, confirmed and declined.
export function statusCounts(svc) {
  const n = { open: 0, pending: 0, accepted: 0, declined: 0 };
  for (const x of svc?.slots ?? []) n[statusOf(x)] += 1;
  return n;
}

// Every position in the period, counted: { total, open, pending, accepted, declined }.
export function fillTotals(services) {
  const t = { total: 0, open: 0, pending: 0, accepted: 0, declined: 0 };
  for (const svc of services ?? []) {
    const n = statusCounts(svc);
    for (const k of ['open', 'pending', 'accepted', 'declined']) { t[k] += n[k]; t.total += n[k]; }
  }
  return t;
}

// "9 of 12 confirmed, 2 waiting, 1 said no", for the pips' screen-reader name.
export function fillWords(n) {
  const total = n.open + n.pending + n.accepted + n.declined;
  const parts = [`${n.accepted} of ${total} confirmed`];
  if (n.pending) parts.push(`${n.pending} waiting`);
  if (n.declined) parts.push(`${n.declined} said no`);
  if (n.open) parts.push(`${n.open} open`);
  return parts.join(', ');
}

// Past this many positions the pips get too thin to read: the line says it alone.
export const MAX_PIPS = 24;

// One pip per position, confirmed first, then waiting, said no, open. No widths to set.
function pips(svc) {
  const n = statusCounts(svc);
  const total = n.open + n.pending + n.accepted + n.declined;
  if (!total || total > MAX_PIPS) return '';
  const run = (k, cls) => Array.from({ length: n[k] }, () => html`<span class="fill-pip ${cls}"></span>`);
  return html`<span class="fill-pips" role="img" aria-label="${fillWords(n)}">${run('accepted', 'is-ok')}${run('pending', 'is-wait')}${run('declined', 'is-bad')}${run('open', 'is-open')}</span>`;
}

// The slot as the panel wants it (adds the service's date, time and title).
export const panelSlot = (slot, svc) => ({ ...slot, date: svc.date, time: svc.time, title: svc.title });

// ---------- rendering ----------

function slotButton(slot, current = null) {
  const has = slot.personId !== null && slot.personId !== undefined;
  const here = slot.id === current ? html` aria-current="true"` : '';
  if (has) {
    return html`<button type="button" class="slot-btn" data-action="slot-open" data-id="${slot.id}"${here}>
      <span class="slot-who">${slot.personName}</span>
      ${statusChip(statusOf(slot), { compact: true })}
    </button>`;
  }
  return html`<button type="button" class="slot-btn is-open" data-action="slot-open" data-id="${slot.id}" aria-label="Nobody yet, choose someone"${here}>
    ${iconSlot('plus', 'icon-sm')}
  </button>`;
}

const todayContent = html` ${iconSlot('dot', 'icon-today')}<span class="visually-hidden">Today</span>`;

function grid(s, today, current) {
  return html`<div class="table-wrap sched-grid">
    <table class="sched-table">
      <caption class="visually-hidden">Schedule for the next ${WEEKS} weeks</caption>
      <thead>
        <tr><th scope="col" rowspan="2" class="sched-corner">Date</th>${s.columns.map((c) => html`<th scope="colgroup" colspan="${c.positions.length}" class="sched-team">${c.teamName}</th>`)}</tr>
        <tr>${s.columns.map((c) => c.positions.map((p) => html`<th scope="col" class="sched-pos">${p.name}</th>`))}</tr>
      </thead>
      <tbody>${s.rows.map((r) => html`<tr data-row="${r.service.id}"${r.service.date === today ? html` class="is-today"` : ''}>
        <th scope="row" class="sched-date"><span class="sched-day num">${formatDate(r.service.date)}</span>${r.service.date === today ? todayContent : ''}<br><span class="num">${formatTime(r.service.time)}</span><br><span class="hint">${r.service.title}</span>${pips(r.service)}</th>
        ${s.columns.map((c) => c.positions.map((p) => {
    const slots = r.cells.get(p.id) ?? [];
    return html`<td>${slots.length ? slots.map((x) => slotButton(x, current)) : html`<span class="hint not-needed">Not needed</span>`}</td>`;
  }))}
      </tr>`)}</tbody>
    </table>
  </div>`;
}

const COUNT_WORDS = Object.freeze({ open: 'open', pending: 'waiting', accepted: 'confirmed', declined: 'said no' });
const PROBLEMS = ['pending', 'declined', 'open'];

// Chips for what still needs doing: "2 waiting", "1 said no", "1 open" (zeros left out).
function problemChips(n) {
  return PROBLEMS.filter((k) => n[k]).map((k) => html`<span class="chip ${STATUS[k].cls}">${iconSlot(STATUS[k].icon, 'chip-icon')}${n[k]} ${COUNT_WORDS[k]}</span>`);
}

// A closed card still says how the service stands: the pips, "5 of 9 confirmed"
// (or "All 12 confirmed"), and a chip for each kind of problem.
function counts(svc) {
  const n = statusCounts(svc);
  const total = n.open + n.pending + n.accepted + n.declined;
  if (!total) return html`<span class="sched-counts"><span class="disclosure-sub">No positions on this date.</span></span>`;
  const full = n.accepted === total;
  return html`${pips(svc)}<span class="fill-line">${full ? html`${iconSlot('check', 'icon-sm')} All ${total} confirmed` : `${n.accepted} of ${total} confirmed`}</span>${full ? '' : html`<span class="sched-counts">${problemChips(n)}</span>`}`;
}

const isFull = (svc) => { const n = statusCounts(svc); const t = n.open + n.pending + n.accepted + n.declined; return t > 0 && n.accepted === t; };

// The whole period at a glance: how many positions are confirmed, a bar, what
// still needs doing, and the way to fill the open ones.
function fillCard(services) {
  const t = fillTotals(services);
  if (!t.total) return '';
  return html`<section class="card fill-card" aria-label="How full the schedule is" data-fill>
    <p class="fill-head"><span class="fill-num num">${t.accepted}</span><span class="fill-words">of ${t.total} positions confirmed</span></p>
    <progress class="fill-total" max="${t.total}" value="${t.accepted}">${t.accepted} of ${t.total}</progress>
    ${t.accepted < t.total ? html`<p class="sched-counts">${problemChips(t)}</p>` : ''}
    <div class="btn-row"><button type="button" class="btn btn-primary btn-block" data-action="autofill-open" aria-haspopup="dialog">${iconSlot('sparkle')} Fill open positions</button></div>
  </section>`;
}

function cards(s, today, open) {
  return html`<ul class="cards sched-cards">${s.rows.map((r) => {
    const isOpen = open.has(r.service.id);
    const label = html`<span class="num">${formatDate(r.service.date)} at ${formatTime(r.service.time)}</span>${r.service.date === today ? todayContent : ''}
      <span class="disclosure-sub">${r.service.title}</span>${counts(r.service)}`;
    return html`<li class="card sched-card${r.service.date === today ? ' is-today' : ''}${isFull(r.service) ? ' is-full' : ''}" data-card="${r.service.id}">
    <h2 class="sched-card-head">${disclosure({ action: 'toggle-service', id: r.service.id, open: isOpen, label })}</h2>
    ${isOpen ? s.columns.filter((c) => c.positions.some((p) => r.cells.has(p.id))).map((c) => html`<h3 class="team-title">${c.teamName}</h3>
      <ul class="list slot-list">${c.positions.filter((p) => r.cells.has(p.id)).map((p) => html`<li>
        <p class="slot-pos"><strong>${p.name}</strong></p>
        ${r.cells.get(p.id).map(slotButton)}
      </li>`)}</ul>`) : ''}
  </li>`;
  })}</ul>`;
}

// "Fill open positions" in a bottom sheet (side panel on wide screens), opened
// from the fill card. All wording as before; nothing changes until "Ask these people".
function autofillSheet(a) {
  if (!a.open) return '';
  const busy = a.busy ? 'disabled' : '';
  const r = a.result;
  let body = '';
  if (r) {
    body = html`<div data-autofill-result>
      <h3 class="team-title">Who Flock would ask (${r.assigned.length})</h3>
      ${r.assigned.length ? html`<ul class="list">${r.assigned.map((x) => html`<li data-autofill-slot="${x.slotId}">
        <span class="num">${formatDate(x.date)} ${formatTime(x.time)}</span>: ${x.teamName} / ${x.positionName}: <strong>${x.personName}</strong>
      </li>`)}</ul>` : html`<p class="hint">Nobody can be asked for these weeks.</p>`}
      ${r.unfilled.length ? html`<h3 class="team-title">Still open (${r.unfilled.length})</h3>
      <ul class="list">${r.unfilled.map((x) => html`<li data-autofill-open="${x.slotId}">
        <span class="num">${formatDate(x.date)} ${formatTime(x.time)}</span>: ${x.teamName} / ${x.positionName}. <span class="hint">${x.message}</span>
      </li>`)}</ul>` : ''}
    </div>`;
  }
  return html`<div class="sheet-layer${a.entered ? '' : ' is-entering'}" data-autofill-sheet>
  <div class="sheet-backdrop" data-action="autofill-close"></div>
  <section class="sheet" data-autofill role="dialog" aria-modal="true" aria-labelledby="autofill-title">
    <div class="sheet-grab" aria-hidden="true"></div>
    <div class="sheet-head"><h2 id="autofill-title" tabindex="-1">Fill open positions</h2><button type="button" class="icon-btn" data-action="autofill-close" aria-label="Close">${iconSlot('x')}</button></div>
    <div class="sheet-body">
      <p class="hint">Flock picks people who are set up for the position, are not away, and have not served more often than they said they can. Nothing changes until you choose "Ask these people".</p>
      ${toasts([[a.error, 'error']])}
      <form class="form form-inline" data-form="autofill" novalidate>
        <div class="field"><label for="af-week">Week starting</label>
          <input id="af-week" name="weekOf" type="date" required value="${a.weekOf}"></div>
        <div class="field"><label for="af-weeks">Weeks</label>
          <select id="af-weeks" name="weeks">${Array.from({ length: AUTOFILL_MAX_WEEKS }, (_, i) => i + 1).map((n) => html`<option value="${n}"${n === a.weeks ? html` selected` : ''}>${n}</option>`)}</select></div>
        <button type="submit" class="btn${r ? '' : ' btn-primary'}" ${busy}>Preview</button>
      </form>
      ${body}
    </div>
    ${r ? html`<div class="sheet-foot"><div class="btn-row btn-row-split">
      ${r.assigned.length ? html`<button type="button" class="btn btn-primary" data-action="autofill-apply" ${busy}>Ask these people</button>` : ''}
      <button type="button" class="btn" data-action="autofill-cancel" ${busy}>Cancel</button>
    </div></div>` : ''}
  </section></div>`;
}

/**
 * panelHtml: the slot panel as a layer. paneHtml: on wide screens (m.wide) it
 * docks beside the grid instead, and the picked position is marked.
 */
export function renderScreen(m, panelHtml = '', paneHtml = '') {
  if (m.loading) return String(skeleton('Loading…', 'rows', 6));
  const s = buildSchedule(m.services, m.teams);
  const main = html`<p class="hint sched-range">${iconSlot('calendar', 'icon-sm')} <span class="num">${formatDate(m.from)} to ${formatDate(m.to)}</span></p>
    ${fillCard(m.services)}
    ${s.rows.length ? html`${grid(s, m.today, m.current)}${cards(s, m.today, m.open ?? new Set())}`
    : emptyState(`No services in the next ${WEEKS} weeks. Add them on the Services page.`, 'art-calendar')}`;
  return String(html`
    ${m.error ? html`<p class="form-error" role="alert">${m.error}</p>` : ''}
    ${toasts([[m.notice, 'ok']])}
    ${panelHtml}
    ${autofillSheet(m.autofill ?? { weekOf: '', weeks: 1 })}
    ${m.wide ? html`<div class="split split-wide"><div>${main}</div><aside class="card pane" aria-label="Position">${paneHtml ? raw(String(paneHtml)) : html`<p class="pane-empty">${iconSlot('calendar', 'icon-lg')}Choose a position.</p>`}</aside></div>` : main}
  `);
}

// ---------- screen controller ----------

/** onChange(): something was assigned, removed or asked (the tab badges may be different now). */
export function createScreen({ api, root, today = todayString(), onChange = () => {}, win = globalThis }) {
  const m = {
    services: [], teams: [], loading: true, error: '', notice: '', today, from: today, to: addDays(today, WEEKS * 7 - 1),
    open: new Set(), // the phone cards that are open
    autofill: { open: false, entered: false, weekOf: nextMonday(today), weeks: 1, input: null, result: null, busy: false, error: '' },
  };
  const paint = () => {
    sheet.before();
    fillSheet.before();
    m.current = panel.state?.slot?.id ?? null;
    root.innerHTML = m.wide ? renderScreen(m, '', panel.render({ pane: true })) : renderScreen(m, panel.render());
    m.autofill.entered = m.autofill.open; // slide in once, not on every repaint
    sheet.update();
    fillSheet.update();
    const open = root.querySelector?.('[data-slot-panel]');
    if (open) swipeToDismiss(open, { win, onDismiss: () => panel.close() });
    const af = root.querySelector?.('[data-autofill]');
    if (af) swipeToDismiss(af, { win, onDismiss: () => closeAutofill() });
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
      onChange();
    },
  });

  const sheet = createSheet({ root, isOpen: () => !!panel.state, close: () => panel.close(), modal: () => !m.wide });
  m.wide = host(win) === 'pane';
  const stopWatching = watchHost(win, () => {
    if (root.isConnected === false) { stopWatching(); return; }
    m.wide = host(win) === 'pane';
    paint();
  });
  const fillSheet = createSheet({
    root, isOpen: () => m.autofill.open, close: () => closeAutofill(),
    panel: '[data-autofill]', opener: () => '[data-action="autofill-open"]',
  });
  function openAutofill() {
    m.autofill.open = true;
    m.autofill.entered = false;
    m.notice = '';
    fillSheet.opened('autofill');
    paint();
  }
  function closeAutofill() {
    const a = m.autofill;
    if (!a.open) return;
    Object.assign(a, { open: false, result: null, input: null, error: '' });
    paint();
  }

  function findSlot(id) {
    for (const svc of m.services) {
      const slot = (svc.slots ?? []).find((x) => x.id === id);
      if (slot) return panelSlot(slot, svc);
    }
    return null;
  }

  async function preview(form) {
    const a = m.autofill;
    const weekOf = String(form?.weekOf?.value ?? '').trim();
    const weeks = Number(form?.weeks?.value ?? 1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) { a.error = 'Please pick a date.'; paint(); return; }
    a.weekOf = weekOf;
    a.weeks = weeks;
    a.busy = true;
    a.error = '';
    a.result = null;
    m.notice = '';
    paint();
    try {
      const r = await api.post('/api/admin/autofill', { weekOf, weeks, apply: false });
      a.input = { weekOf, weeks };
      a.result = { assigned: r?.assigned ?? [], unfilled: r?.unfilled ?? [] };
    } catch (err) {
      a.error = String(err?.message || 'Could not plan those weeks.');
    }
    a.busy = false;
    paint();
  }

  async function applyPlan() {
    const a = m.autofill;
    if (!a.input || a.busy) return;
    a.busy = true;
    a.error = '';
    paint();
    try {
      const r = await api.post('/api/admin/autofill', { ...a.input, apply: true });
      const n = r?.assigned?.length ?? 0;
      a.result = null;
      a.input = null;
      m.notice = n === 1 ? 'Asked 1 person. They will see it in My schedule.' : `Asked ${n} people. They will see it in My schedule.`;
      a.open = false;
      await reload();
      onChange();
    } catch (err) {
      a.error = String(err?.message || 'Could not fill those weeks.');
    }
    a.busy = false;
    paint();
  }

  root.addEventListener('submit', (e) => {
    const form = e.target?.closest?.('form[data-form]');
    if (!form || form.dataset.form !== 'autofill') return undefined;
    e.preventDefault();
    return preview(form.elements);
  });

  root.addEventListener('click', (e) => {
    const el = e.target?.closest?.('[data-action]');
    if (!el) return undefined;
    const action = el.dataset.action;
    const id = Number(el.dataset.id);
    if (action === 'autofill-apply') return applyPlan();
    if (action === 'autofill-open') { openAutofill(); return undefined; }
    if (action === 'autofill-cancel' || action === 'autofill-close') { closeAutofill(); return undefined; }
    if (action === 'toggle-service') { if (!m.open.delete(id)) m.open.add(id); paint(); refocus(root, action, id); return undefined; }
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
    ${pageHead(title, `The next ${WEEKS} weeks.`)}
    <div data-screen>${skeleton('Loading…', 'rows', 6)}</div>
  `);
}

export function mount(root, ctx) {
  const screen = root?.querySelector?.('[data-screen]');
  if (!screen) return undefined;
  return createScreen({ api: ctx.api, root: screen, today: ctx.today ?? todayString(), onChange: () => ctx.refreshCounts?.().catch(() => {}), win: ctx.win ?? globalThis }).ready;
}
