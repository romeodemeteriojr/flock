// Gaps page (scheduler only): what still needs someone, grouped per service
// (each roster day), each with a plain label for its kind; tapping an item
// opens the slot panel. Also the reminders panel: drafted messages to copy.
// Flock never sends anything itself.
import { html } from '../lib/html.js';
import { formatDate, formatTime, todayString } from '../lib/dates.js';
import { createSlotPanel, copyText } from '../lib/slotpanel.js';
import { createSheet } from '../lib/sheet.js';
import { flashCopied } from '../lib/copyflash.js';
import { iconSlot } from '../lib/icons.js';
import { avatar } from '../lib/avatar.js';
import { toasts } from '../lib/toast.js';
import { skeleton, emptyState, pageHead } from '../lib/ui.js';

export const title = 'Gaps';
export const NEVER_SENDS = 'Flock never sends messages. Copy these into your usual messages app.';
export const PUSH_SENDS = 'People with notifications on can get theirs from Flock. Copy the rest into your usual messages app.';

/** "Sent to 9; 3 to copy." after Send reminders. */
export function sentWords(sent, copy) {
  if (!sent) return 'Nothing could be sent as a notification. Copy the messages instead.';
  return copy ? `Sent to ${sent}; ${copy} to copy.` : `Sent to ${sent}.`;
}

export const GAP_LABELS = Object.freeze({
  open: 'Nobody yet',
  declined: 'Said no',
  unanswered: "Hasn't answered",
  blocked: 'Now away',
  inactive: 'No longer active',
});
export const GAP_ORDER = Object.freeze(Object.keys(GAP_LABELS));

// ---------- pure helpers (tested directly) ----------

// One group per service, by date and time (a service is unique by its date and
// time), keeping the items' order inside each group.
export function groupGaps(items) {
  const groups = new Map();
  for (const it of items ?? []) {
    if (!Object.hasOwn(GAP_LABELS, it.type)) continue; // only the kinds this page knows
    const key = `${it.date}T${it.time}`;
    if (!groups.has(key)) groups.set(key, { key, date: it.date, time: it.time, serviceTitle: it.serviceTitle, items: [] });
    groups.get(key).items.push(it);
  }
  return [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
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
  return html`<ul class="stats" data-summary>${GAP_ORDER.map((t) => {
    const n = Number(sum?.[t] ?? 0);
    return html`<li class="stat${n ? ' stat-' + GAP_TONE[t] : ''}"><strong class="stat-num num" data-count="${t}">${n}</strong> ${GAP_LABELS[t]}</li>`;
  })}</ul>`;
}

// Colour family per kind (the label words always go with it).
const GAP_TONE = { open: 'bad', declined: 'bad', unanswered: 'wait', blocked: 'wait', inactive: 'wait' };

// Status icon per gap kind (mirrors the slotpanel STATUS icons where they overlap).
const GAP_ICONS = Object.freeze({
  open: 'plus',
  declined: 'x',
  unanswered: 'clock',
  blocked: 'user-off',
  inactive: 'user-off',
});

const gapWords = (n) => (n === 1 ? '1 gap' : `${n} gaps`);

function gapItem(it) {
  return html`<li>
    <button type="button" class="slot-btn gap-btn" data-action="slot-open" data-id="${it.slotId}">
      <span class="slot-who"><strong>${it.positionName}</strong> (${it.teamName})</span>
      <span class="gap-kind"><span class="chip chip-${GAP_TONE[it.type]}" data-gap-type="${it.type}">${iconSlot(GAP_ICONS[it.type], 'chip-icon')}${GAP_LABELS[it.type]}</span>${it.personName && it.type !== 'open' ? html` <span class="hint">${it.personName}</span>` : ''}</span>
      ${iconSlot('chevron', 'gap-chevron')}
    </button>
  </li>`;
}

/** The reminders still to copy: everyone not reached by Send reminders. */
export const toCopy = (r) => (r.list ?? []).filter((x) => !r.sent?.has(x.personId));

function reminders(m) {
  const r = m.reminders;
  let body = '';
  if (r.loading) body = skeleton('Loading…', 'list', 2);
  else if (r.list) {
    const canSend = r.push && r.list.some((x) => x.hasPush && !r.sent?.has(x.personId));
    const reachable = r.list.filter((x) => x.hasPush).length;
    body = r.list.length
      ? html`<div class="btn-row">
          ${canSend ? html`<button type="button" class="btn btn-primary" data-action="send-reminders" ${r.sending ? 'disabled' : ''}>${iconSlot('bell')} ${r.sending ? 'Sending…' : `Send reminders (${reachable})`}</button>` : ''}
          <button type="button" class="btn${canSend ? '' : ' btn-primary'}" data-action="copy-all" data-copy-key="all">${iconSlot('copy')} Copy all</button></div>
        <ul class="list reminder-list" data-reminders>${r.list.map((x) => html`<li class="reminder" data-reminder="${x.personId}">
          <p class="reminder-who">${avatar(x.name, 'sm')}<strong>${x.name}</strong>
            ${r.sent?.has(x.personId) ? html`<span class="chip chip-ok">${iconSlot('check', 'chip-icon')}Sent</span>`
              : r.push && x.hasPush ? html`<span class="chip chip-plain" title="Gets notifications from Flock">${iconSlot('bell', 'chip-icon')}Notifications on</span>` : ''}</p>
          <p class="reminder-text">${x.message}</p>
          ${r.sent?.has(x.personId) ? '' : html`<div class="btn-row"><button type="button" class="btn btn-sm" data-action="copy-one" data-id="${x.personId}" data-copy-key="${x.personId}">${iconSlot('copy')} Copy</button></div>`}
        </li>`)}</ul>`
      : emptyState('Nobody is scheduled that week.', 'art-calendar');
  }
  return html`<section class="card reminders-card" data-reminders-panel>
    <h2 class="card-title">${iconSlot('bell', 'icon-sm')} Reminders</h2>
    <p class="notice notice-info">${iconSlot('mail', 'notice-icon')}<strong>${r.push ? PUSH_SENDS : NEVER_SENDS}</strong></p>
    ${toasts([[r.notice, 'ok'], [r.error, 'error']])}
    <form class="form form-inline" data-form="reminders" novalidate>
      <div class="field"><label for="week-of">Week starting</label>
        <input id="week-of" name="weekOf" type="date" required value="${r.weekOf}"></div>
      <button type="submit" class="btn btn-primary">${iconSlot('send')} Show messages</button>
    </form>
    ${body}
  </section>`;
}

export function renderScreen(m, panelHtml = '') {
  if (m.loading) return String(skeleton('Loading…', 'list', 4));
  const groups = groupGaps(m.items);
  return String(html`
    ${m.error ? html`<p class="form-error" role="alert">${m.error}</p>` : ''}
    ${toasts([[m.notice, 'ok']])}
    ${panelHtml}
    <h2 class="section-title">Next 4 weeks</h2>
    ${summary(m.summary)}
    ${groups.length ? html`<p class="hint">Tap a position to find someone.</p>
    ${groups.map((g) => html`<section class="gap-group" data-gap-service="${g.key}">
      <h3 class="gap-title"><span class="gap-icon">${iconSlot('calendar')}</span> <span class="gap-label num">${formatDate(g.date)} at ${formatTime(g.time)}</span> <span class="gap-count" role="img" data-gap-count="${g.key}" aria-label="${gapWords(g.items.length)}">${g.items.length}</span></h3>
      <p class="hint">${g.serviceTitle}</p>
      <ul class="list gap-list">${g.items.map(gapItem)}</ul>
    </section>`)}` : emptyState('No gaps. Every position has someone.', 'art-done')}
    ${reminders(m)}
  `);
}

// ---------- screen controller ----------

export function createScreen({ api, root, today = todayString(), win = globalThis }) {
  const m = {
    loading: true, error: '', notice: '', summary: {}, items: [],
    reminders: { weekOf: today, list: null, loading: false, error: '', notice: '', push: false, sent: new Set(), sending: false },
  };
  const hold = { timer: null, key: null };
  let reminderSeq = 0;
  const paint = () => {
    sheet.before();
    root.innerHTML = renderScreen(m, panel.render());
    sheet.update();
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

  const sheet = createSheet({ root, isOpen: () => !!panel.state, close: () => panel.close() });

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
      r.push = res?.push === true;
      r.sent = new Set();
    } catch (err) {
      if (seq !== reminderSeq) return;
      r.list = null;
      if (err?.status !== 401) r.error = String(err?.message || 'Could not load the messages.');
    }
    r.loading = false;
    paint();
  }

  // Send the shown week's reminders as notifications; whoever is not reached keeps Copy.
  async function sendReminders() {
    const r = m.reminders;
    if (r.sending) return;
    r.sending = true;
    r.notice = '';
    r.error = '';
    paint();
    try {
      const res = await api.post('/api/admin/reminders/send', { weekOf: r.weekOf });
      for (const id of res?.sent ?? []) r.sent.add(id);
      r.notice = sentWords(r.sent.size, toCopy(r).length);
    } catch (err) {
      if (err?.status !== 401) r.error = String(err?.message || 'Could not send the reminders. Copy them instead.');
    }
    r.sending = false;
    paint();
  }

  async function copy(text, target, label, key) {
    const ok = await copyText(win, text);
    m.reminders.notice = ok ? 'Copied. Paste it into your messages app.' : '';
    m.reminders.error = ok ? '' : 'Could not copy. Please select the text and copy it by hand.';
    paint();
    if (ok) flashCopied(win, root, target, label, hold, key);
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
      m.reminders.notice = '';
      sheet.opened(id);
      return panel.open(gapSlot(it));
    }
    if (action === 'copy-all') return copy(allRemindersText(toCopy(m.reminders)), el, 'Copy all', 'all');
    if (action === 'send-reminders') return sendReminders();
    if (action === 'copy-one') {
      const x = (m.reminders.list ?? []).find((y) => y.personId === id);
      return x ? copy(x.message, el, 'Copy', String(id)) : undefined;
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
    ${pageHead(title, 'What still needs someone, and reminders to send.')}
    <div data-screen>${skeleton('Loading…', 'list', 4)}</div>
  `);
}

export function mount(root, ctx) {
  const screen = root?.querySelector?.('[data-screen]');
  if (!screen) return undefined;
  return createScreen({ api: ctx.api, root: screen, today: ctx.today ?? todayString() }).ready;
}
