// Gaps page (scheduler only): what still needs someone, grouped by kind with
// plain labels; tapping an item opens the slot panel. Also the reminders
// panel: drafted messages to copy. Flock never sends anything itself.
import { html } from '../lib/html.js';
import { formatDate, formatTime, todayString } from '../lib/dates.js';
import { createSlotPanel, focusPanel, copyText } from '../lib/slotpanel.js';

export const title = 'Gaps';
export const NEVER_SENDS = 'Flock never sends messages. Copy these into your usual messages app.';

export const GAP_LABELS = Object.freeze({
  open: 'Nobody yet',
  declined: 'Said no',
  unanswered: "Hasn't answered",
  blocked: 'Now away',
  inactive: 'No longer active',
});
const GAP_HINTS = {
  open: 'Nobody is in these positions.',
  declined: 'The person said they can not come. Find someone else.',
  unanswered: 'The person has not said yes or no yet. Remind them, or find someone else.',
  blocked: 'The person added days they can not serve after they were scheduled.',
  inactive: 'The person is no longer active. Find someone else.',
};
export const GAP_ORDER = Object.freeze(Object.keys(GAP_LABELS));

// ---------- pure helpers (tested directly) ----------

export function groupGaps(items) {
  const groups = GAP_ORDER.map((type) => ({ type, label: GAP_LABELS[type], items: [] }));
  for (const it of items ?? []) groups.find((g) => g.type === it.type)?.items.push(it);
  return groups.filter((g) => g.items.length);
}

// A gap item as the slot panel wants it.
export function gapSlot(it) {
  const status = it.type === 'open' ? 'open' : it.type === 'declined' ? 'declined' : it.type === 'unanswered' ? 'pending' : null;
  return {
    id: it.slotId,
    positionName: it.positionName,
    teamName: it.teamName,
    date: it.date,
    time: it.time,
    title: it.serviceTitle,
    personId: it.type === 'open' ? null : (it.personId ?? null),
    personName: it.type === 'open' ? null : (it.personName ?? null),
    status: status ?? 'pending',
    // The gaps list does not say if a now-away person had answered: show the gap instead.
    statusLabel: status ? null : GAP_LABELS[it.type],
  };
}

export function allRemindersText(reminders) {
  return (reminders ?? []).map((r) => `${r.name}\n${r.message}`).join('\n\n');
}

// ---------- rendering ----------

function summary(sum) {
  return html`<ul class="list" data-summary>${GAP_ORDER.map((t) => html`<li><strong data-count="${t}">${Number(sum?.[t] ?? 0)}</strong> ${GAP_LABELS[t]}</li>`)}</ul>`;
}

function gapItem(it) {
  return html`<li>
    <button type="button" class="slot-btn" data-action="slot-open" data-id="${it.slotId}">
      <span class="slot-who"><strong>${it.positionName}</strong> (${it.teamName}), ${formatDate(it.date)} at ${formatTime(it.time)}</span>
      <span class="hint">${it.serviceTitle}${it.personName && it.type !== 'open' ? html`. ${it.personName}` : ''}</span>
    </button>
  </li>`;
}

function reminders(m) {
  const r = m.reminders;
  let body = '';
  if (r.loading) body = html`<p class="loading">Loading…</p>`;
  else if (r.list) {
    body = r.list.length
      ? html`<div class="btn-row"><button type="button" class="btn btn-primary" data-action="copy-all">Copy all</button></div>
        <ul class="list" data-reminders>${r.list.map((x) => html`<li data-reminder="${x.personId}">
          <p><strong>${x.name}</strong></p>
          <p>${x.message}</p>
          <div class="btn-row"><button type="button" class="btn" data-action="copy-one" data-id="${x.personId}">Copy</button></div>
        </li>`)}</ul>`
      : html`<p class="empty">Nobody is scheduled that week.</p>`;
  }
  return html`<section class="card" data-reminders-panel>
    <h2>Reminders</h2>
    <p class="notice"><strong>${NEVER_SENDS}</strong></p>
    ${r.error ? html`<p class="form-error" role="alert">${r.error}</p>` : ''}
    ${r.notice ? html`<p class="hint" role="status">${r.notice}</p>` : ''}
    <form class="form" data-form="reminders" novalidate>
      <div class="field"><label for="week-of">Week starting</label>
        <input id="week-of" name="weekOf" type="date" required value="${r.weekOf}"></div>
      <button type="submit" class="btn btn-primary">Show messages</button>
    </form>
    ${body}
  </section>`;
}

export function renderScreen(m, panelHtml = '') {
  if (m.loading) return String(html`<p class="loading">Loading…</p>`);
  const groups = groupGaps(m.items);
  return String(html`
    ${m.error ? html`<p class="form-error" role="alert">${m.error}</p>` : ''}
    ${m.notice ? html`<p class="hint" role="status">${m.notice}</p>` : ''}
    ${panelHtml}
    <h2>Next 4 weeks</h2>
    ${summary(m.summary)}
    ${groups.length ? groups.map((g) => html`<section data-gap-group="${g.type}">
      <h3>${g.label} (${g.items.length})</h3>
      <p class="hint">${GAP_HINTS[g.type]}</p>
      <ul class="list">${g.items.map(gapItem)}</ul>
    </section>`) : html`<p class="empty">No gaps. Every position has someone.</p>`}
    ${reminders(m)}
  `);
}

// ---------- screen controller ----------

export function createScreen({ api, root, today = todayString(), win = globalThis }) {
  const m = {
    loading: true, error: '', notice: '', summary: {}, items: [],
    reminders: { weekOf: today, list: null, loading: false, error: '', notice: '' },
  };
  let panelWasOpen = false;
  let reminderSeq = 0;
  const paint = () => {
    root.innerHTML = renderScreen(m, panel.render());
    const open = !!panel.state;
    if (open && !panelWasOpen) focusPanel(root);
    panelWasOpen = open;
  };
  const reload = async () => {
    const r = await api.get('/api/admin/gaps');
    m.summary = r?.summary ?? {};
    m.items = Array.isArray(r?.items) ? r.items : [];
  };
  const panel = createSlotPanel({
    api,
    paint: () => paint(),
    changed: async (notice) => {
      m.notice = notice;
      m.error = '';
      try { await reload(); } catch (err) { m.error = String(err?.message || 'Could not reload the gaps.'); }
    },
  });

  async function loadReminders(weekOf) {
    const r = m.reminders;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) { r.error = 'Please pick a date.'; paint(); return; }
    r.weekOf = weekOf;
    const seq = ++reminderSeq; // only the newest week may fill the list
    r.loading = true;
    r.error = '';
    r.notice = '';
    paint();
    try {
      const res = await api.get(`/api/admin/reminders?weekOf=${weekOf}`);
      if (seq !== reminderSeq) return;
      r.list = Array.isArray(res?.reminders) ? res.reminders : [];
    } catch (err) {
      if (seq !== reminderSeq) return;
      r.list = null;
      if (err?.status !== 401) r.error = String(err?.message || 'Could not load the messages.');
    }
    r.loading = false;
    paint();
  }

  async function copy(text) {
    const ok = await copyText(win, text);
    m.reminders.notice = ok ? 'Copied. Paste it into your messages app.' : 'Could not copy. Please select the text and copy it by hand.';
    paint();
  }

  root.addEventListener('click', (e) => {
    const el = e.target?.closest?.('[data-action]');
    if (!el) return undefined;
    const action = el.dataset.action;
    const id = Number(el.dataset.id);
    if (action === 'slot-open') {
      const it = m.items.find((x) => x.slotId === id);
      if (!it) return undefined;
      m.notice = '';
      return panel.open(gapSlot(it));
    }
    if (action === 'copy-all') return copy(allRemindersText(m.reminders.list));
    if (action === 'copy-one') {
      const x = (m.reminders.list ?? []).find((y) => y.personId === id);
      return x ? copy(x.message) : undefined;
    }
    const r = panel.handle(action, id);
    return r === true || r === false ? undefined : r;
  });
  root.addEventListener('submit', (e) => {
    const form = e.target?.closest?.('form[data-form]');
    if (!form || form.dataset.form !== 'reminders') return undefined;
    e.preventDefault();
    return loadReminders(String(form.elements?.weekOf?.value ?? '').trim());
  });

  const ready = (async () => {
    try { await reload(); } catch (err) { m.error = String(err?.message || 'Could not load the gaps.'); }
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
