// Services page (scheduler only): add a service date with the positions it
// needs, repeat it for more weeks, and edit or delete upcoming services. A
// service shows its buttons once tapped (one at a time). Deleting always asks
// first, and says how many people are scheduled.
import { html } from '../lib/html.js';
import { formatDate, formatTime, todayString } from '../lib/dates.js';
import { iconSlot } from '../lib/icons.js';
import { toasts } from '../lib/toast.js';
import { skeleton, emptyState, pageHead, disclosure, refocus } from '../lib/ui.js';
import { takenOffText, peopleFrom } from '../lib/taken-off.js';

export const title = 'Services';
export const DEFAULT_TIME = '09:00';
export const DEFAULT_TITLE = 'Sunday service';
export const LIST_DAYS = 182; // how far ahead the upcoming list looks
const MAX_COUNT = 20;
const MAX_WEEKS = 26;

// ---------- pure helpers (tested directly) ----------

export function addDays(date, n) {
  const [y, m, d] = String(date).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  const p = (x, w = 2) => String(x).padStart(w, '0');
  return `${p(t.getUTCFullYear(), 4)}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

// Counted like the server does for the delete warning: any slot with a person in it.
export const scheduledCount = (svc) => (svc?.slots ?? []).filter((s) => s.personId !== null && s.personId !== undefined).length;

export function peopleWords(n) {
  return n === 1 ? '1 person is scheduled on this date' : `${n} people are scheduled on this date`;
}

const val = (els, name) => String(els?.[name]?.value ?? '').trim();
const ticked = (els, name) => !!els?.[name]?.checked;

// The POST /api/services body from the form's elements, or { error }.
export function serviceBody(elements, teams) {
  const date = val(elements, 'date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Please pick a date.' };
  const time = val(elements, 'time') || DEFAULT_TIME;
  if (!/^\d{2}:\d{2}$/.test(time)) return { error: 'Please pick a time, like 9:00 am.' };
  const titleText = val(elements, 'title') || DEFAULT_TITLE;
  if (titleText.length > 100) return { error: 'The title is too long. Please keep it under 100 letters.' };
  const slots = [];
  for (const t of teams ?? []) {
    for (const pos of t.positions ?? []) {
      if (!ticked(elements, `pos-${pos.id}`)) continue;
      const raw = val(elements, `count-${pos.id}`) || '1';
      const count = Number(raw);
      if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
        return { error: `How many ${pos.name}? Please type a number from 1 to ${MAX_COUNT}.` };
      }
      slots.push({ positionId: pos.id, count });
    }
  }
  return { body: { date, time, title: titleText, slots } };
}

// What the scheduler typed in a form, so an error does not wipe it.
export function readDraft(elements, teams) {
  const d = { date: val(elements, 'date'), time: val(elements, 'time'), title: String(elements?.title?.value ?? ''), pos: {} };
  for (const t of teams ?? []) {
    for (const pos of t.positions ?? []) {
      d.pos[pos.id] = { on: ticked(elements, `pos-${pos.id}`), count: val(elements, `count-${pos.id}`) || '1' };
    }
  }
  return d;
}

// The edit form's starting values: the service's fields and its positions with counts.
export function draftOf(svc) {
  const pos = {};
  for (const sl of svc?.slots ?? []) {
    const cur = pos[sl.positionId];
    pos[sl.positionId] = { on: true, count: String(cur ? Number(cur.count) + 1 : 1) };
  }
  return { date: svc?.date ?? '', time: svc?.time ?? '', title: svc?.title ?? '', pos };
}

export function weeksFrom(elements) {
  const n = Number(val(elements, 'weeks'));
  return Number.isInteger(n) && n >= 1 && n <= MAX_WEEKS ? n : null;
}

export function repeatNotice(r) {
  const made = r?.created?.length ?? 0;
  const skipped = r?.skipped ?? [];
  let text = made === 1 ? 'Added 1 more service.' : `Added ${made} more services.`;
  if (skipped.length) text += ` Skipped ${skipped.map(formatDate).join(', ')}: there is already a service then, or it has passed.`;
  const gone = r?.skippedPositions ?? [];
  if (gone.length) text += ` Left out ${gone.join(', ')}: deleted on the Teams page.`;
  return text;
}

// Positions of a service, grouped: 'Band: Drums, Keys x2. Sound: Mixer'.
// Teams and positions follow the Teams page order (teams), then any others.
export function positionsSummary(svc, order = []) {
  const rank = new Map();
  order.forEach((t, i) => (t.positions ?? []).forEach((p, j) => rank.set(p.id, i * 1000 + j)));
  const r = (s) => rank.get(s.positionId) ?? Number.MAX_SAFE_INTEGER;
  const slots = [...(svc.slots ?? [])].sort((a, b) => r(a) - r(b) || a.id - b.id);
  const teams = new Map();
  for (const s of slots) {
    if (!teams.has(s.teamName)) teams.set(s.teamName, new Map());
    const pos = teams.get(s.teamName);
    pos.set(s.positionName, (pos.get(s.positionName) ?? 0) + 1);
  }
  return [...teams].map(([team, pos]) => `${team}: ${[...pos].map(([n, c]) => (c > 1 ? `${n} x${c}` : n)).join(', ')}`).join('. ');
}

export function sortServices(list) {
  return [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
    || (a.time < b.time ? -1 : a.time > b.time ? 1 : 0) || a.id - b.id);
}

// ---------- rendering ----------

// The positions and how many of each. prefix keeps element ids unique when
// the edit form is open next to the add form; the names stay the same.
function positionPicker(teams, d, prefix = '') {
  return html`${teams.length ? teams.map((t) => html`<fieldset class="field fieldset" data-team="${t.id}">
      <legend><strong>${t.name}</strong></legend>
      ${t.positions.length ? t.positions.map((p) => html`<div class="field pos-pick">
        <label class="check" for="${prefix}pos-${p.id}"><input id="${prefix}pos-${p.id}" name="pos-${p.id}" type="checkbox"${d.pos[p.id]?.on ? html` checked` : ''}> ${p.name}</label>
        <label class="count-label" for="${prefix}count-${p.id}">How many ${p.name}</label>
        <input id="${prefix}count-${p.id}" name="count-${p.id}" type="number" min="1" max="${MAX_COUNT}" value="${d.pos[p.id]?.count ?? '1'}" inputmode="numeric">
      </div>`) : html`<p class="hint">No positions in this team yet.</p>`}
    </fieldset>`) : html`<p class="hint">No teams yet. Add teams and positions on the Teams page first.</p>`}`;
}

function createForm(teams, today, draft) {
  const d = draft ?? { date: today, time: DEFAULT_TIME, title: DEFAULT_TITLE, pos: {} };
  return html`<form class="form card form-card form-wide" data-form="create" novalidate>
    <h2 class="card-title">Add a service</h2>
    <div class="field-pair">
    <div class="field"><label for="svc-date">Date</label>
      <input id="svc-date" name="date" type="date" required value="${d.date}"></div>
    <div class="field"><label for="svc-time">Time</label>
      <input id="svc-time" name="time" type="time" required value="${d.time}"></div>
    </div>
    <div class="field"><label for="svc-title">Title</label>
      <input id="svc-title" name="title" type="text" maxlength="100" value="${d.title}"></div>
    <h3>Positions needed</h3>
    ${positionPicker(teams, d)}
    <button type="submit" class="btn btn-primary">${iconSlot('plus')} Add service</button>
  </form>`;
}

function serviceCard(svc, m) {
  const mine = m.panel && m.panel.id === svc.id ? m.panel : null;
  let extra = '';
  if (mine?.kind === 'edit') {
    const d = mine.draft ?? draftOf(svc);
    const id = svc.id;
    extra = html`<form class="form confirm form-wide" data-form="edit" data-id="${id}" novalidate>
      <div class="field-pair">
      <div class="field"><label for="edit-date-${id}">Date</label>
        <input id="edit-date-${id}" name="date" type="date" required value="${d.date}"></div>
      <div class="field"><label for="edit-time-${id}">Time</label>
        <input id="edit-time-${id}" name="time" type="time" required value="${d.time}"></div>
      </div>
      <div class="field"><label for="edit-title-${id}">Title</label>
        <input id="edit-title-${id}" name="title" type="text" maxlength="100" value="${d.title}"></div>
      <h3>Positions needed</h3>
      ${positionPicker(m.teams, d, `edit-${id}-`)}
      ${mine.people ? html`<div class="confirm confirm-danger" role="alertdialog" aria-label="Confirm">
        <p><strong>${takenOffText(mine.people) || mine.message}</strong> ${mine.people.length === 1 ? 'is' : 'are'} on a position you took off. They will be taken off and told.</p>
        <div class="btn-row">
          <button type="button" class="btn btn-danger" data-action="edit-yes" data-id="${id}">Yes, save</button>
          <button type="button" class="btn" data-action="edit-back" data-id="${id}">No, go back</button>
        </div></div>`
    : html`<div class="btn-row"><button type="submit" class="btn btn-primary">Save changes</button>
        <button type="button" class="btn" data-action="cancel">Cancel</button></div>`}
    </form>`;
  }
  if (mine?.kind === 'repeat') {
    extra = html`<form class="form confirm" data-form="repeat" data-id="${svc.id}" novalidate>
      <div class="field"><label for="weeks-${svc.id}">Repeat for how many more weeks?</label>
        <input id="weeks-${svc.id}" name="weeks" type="number" min="1" max="${MAX_WEEKS}" value="${mine.weeks ?? '4'}" inputmode="numeric">
        <p class="hint">Same day of the week, time, title and positions. People are not copied.</p></div>
      <div class="btn-row"><button type="submit" class="btn btn-primary">Repeat</button>
        <button type="button" class="btn" data-action="cancel">Cancel</button></div>
    </form>`;
  }
  if (mine?.kind === 'delete') {
    const n = mine.count;
    extra = html`<div class="confirm confirm-danger" role="alertdialog" aria-label="Confirm">
      <p>${n > 0 ? html`<strong>${mine.text || peopleWords(n)}.</strong> They will be taken off. ` : ''}Delete ${svc.title} on ${formatDate(svc.date)}? This cannot be undone.</p>
      <div class="btn-row">
        <button type="button" class="btn btn-danger" data-action="delete-yes" data-id="${svc.id}">Yes, delete it</button>
        <button type="button" class="btn" data-action="cancel">No, go back</button>
      </div></div>`;
  }
  const n = scheduledCount(svc);
  const selected = m.selected === svc.id;
  const label = html`<span class="service-main">
      <span class="service-icon">${iconSlot('calendar')}</span>
      <span class="service-text">
        <span class="service-title"><strong class="num">${formatDate(svc.date)} at ${formatTime(svc.time)}</strong>: ${svc.title}</span>
        <span class="disclosure-sub">${svc.slots?.length ? `${positionsSummary(svc, m.teams)}.` : 'No positions yet.'}${n ? html` ${peopleWords(n)}.` : ''}</span>
      </span>
    </span>`;
  return html`<li class="service-row" data-service="${svc.id}">
    ${disclosure({ action: 'select', id: svc.id, open: selected, label, cls: 'row-select' })}
    ${selected ? html`<div class="btn-row btn-row-compact row-actions">
      <button type="button" class="btn btn-sm" data-action="repeat" data-id="${svc.id}">Repeat for more weeks</button>
      <button type="button" class="btn btn-sm" data-action="edit" data-id="${svc.id}">${iconSlot('edit')} Edit</button>
      <button type="button" class="btn btn-sm btn-danger" data-action="delete" data-id="${svc.id}">${iconSlot('trash')} Delete</button>
    </div>` : ''}
    ${extra}
  </li>`;
}

export function renderScreen(m) {
  if (m.loading) return String(skeleton('Loading…', 'cards', 2));
  return String(html`
    ${m.error ? html`<p class="form-error" role="alert">${m.error}</p>` : ''}
    ${toasts([[m.notice, 'ok']])}
    ${createForm(m.teams, m.today, m.draft)}
    <h2 class="section-title">Upcoming services</h2>
    ${m.services.length ? html`<ul class="list card-list" data-services>${m.services.map((s) => serviceCard(s, m))}</ul>`
    : emptyState('No upcoming services yet. Add one above.', 'art-calendar')}
  `);
}

// ---------- screen controller ----------

export function createScreen({ api, root, today = todayString() }) {
  // selected: the service whose buttons show.
  const m = { teams: [], services: [], loading: true, panel: null, error: '', notice: '', today, draft: null, selected: null };
  let busy = false;
  const paint = () => { root.innerHTML = renderScreen(m); };
  const reload = async () => {
    const [t, s] = await Promise.all([
      api.get('/api/teams'),
      api.get(`/api/services?from=${m.today}&to=${addDays(m.today, LIST_DAYS)}`),
    ]);
    m.teams = Array.isArray(t) ? t : [];
    m.services = sortServices(Array.isArray(s) ? s : []);
  };
  const find = (id) => m.services.find((s) => s.id === Number(id));

  async function attempt(fn) {
    if (busy) return;
    busy = true;
    m.error = '';
    m.notice = '';
    try {
      await fn();
    } catch (err) {
      if (err?.status !== 401) m.error = String(err?.message || 'Something went wrong. Please try again.');
    } finally {
      busy = false;
    }
    paint();
  }

  const ask = (kind) => (id) => {
    const svc = find(id);
    if (!svc) return;
    m.panel = { kind, id: svc.id, count: scheduledCount(svc) };
    m.selected = svc.id; // a panel under a row keeps that row open
    m.error = '';
    m.notice = '';
    paint();
  };

  // Save an edit. When it would take people off, ask again naming them and
  // only then send the confirmation they saw.
  async function saveEdit(id, body, confirmed) {
    try {
      await api.patch(`/api/services/${id}${confirmed ? '?confirm=1' : ''}`, body);
    } catch (err) {
      const people = peopleFrom(err);
      if (!people || m.panel?.id !== id) throw err;
      m.panel = { ...m.panel, body, people, message: err.message };
      return;
    }
    m.panel = null;
    await reload();
    m.notice = 'Service saved.';
  }

  const actions = {
    cancel: () => { m.panel = null; paint(); },
    'edit-back': (id) => {
      if (m.panel?.kind !== 'edit' || m.panel.id !== Number(id)) return;
      m.panel = { kind: 'edit', id: m.panel.id, draft: m.panel.draft };
      paint();
    },
    'edit-yes': (id) => attempt(async () => {
      const panel = m.panel;
      if (panel?.kind !== 'edit' || panel.id !== Number(id) || !panel.people) return;
      await saveEdit(panel.id, panel.body, true);
    }),
    select: (id) => { m.selected = m.selected === id ? null : id; m.panel = null; paint(); refocus(root, 'select', id); },
    edit: ask('edit'),
    repeat: ask('repeat'),
    delete: ask('delete'),
    'delete-yes': (id) => attempt(async () => {
      const panel = m.panel;
      if (panel?.kind !== 'delete' || panel.id !== Number(id)) return;
      try {
        // Only send the confirmation the scheduler actually saw.
        await api.del(`/api/services/${panel.id}${panel.count > 0 ? '?confirm=1' : ''}`);
      } catch (err) {
        if (err?.status === 409 && err.code === 'has_people') {
          // People were added since the page loaded: warn and ask again.
          const n = Number(/^(\d+)/.exec(err.message)?.[1]) || 1;
          m.panel = { kind: 'delete', id: panel.id, count: n, text: err.message };
          return;
        }
        throw err;
      }
      m.panel = null;
      await reload();
      m.notice = 'Service deleted.';
    }),
  };

  const forms = {
    create: (form) => attempt(async () => {
      m.draft = readDraft(form.elements, m.teams);
      const r = serviceBody(form.elements, m.teams);
      if (r.error) { m.error = r.error; return; }
      await api.post('/api/services', r.body);
      m.draft = null;
      await reload();
      m.notice = `Service added for ${formatDate(r.body.date)} at ${formatTime(r.body.time)}.`;
    }),
    edit: (form) => attempt(async () => {
      const svc = find(form.dataset.id);
      if (!svc) return;
      const draft = readDraft(form.elements, m.teams);
      if (m.panel?.id === svc.id) m.panel.draft = draft;
      if (!draft.date || !draft.time || !draft.title.trim()) { m.error = 'Please fill in the date, time and title.'; return; }
      const r = serviceBody(form.elements, m.teams);
      if (r.error) { m.error = r.error; return; }
      await saveEdit(svc.id, r.body, false);
    }),
    repeat: (form) => attempt(async () => {
      const svc = find(form.dataset.id);
      if (!svc) return;
      if (m.panel?.id === svc.id) m.panel.weeks = val(form.elements, 'weeks');
      const weeks = weeksFrom(form.elements);
      if (!weeks) { m.error = `Please type a number of weeks from 1 to ${MAX_WEEKS}.`; return; }
      const r = await api.post('/api/services/repeat', { fromServiceId: svc.id, weeks });
      m.panel = null;
      await reload();
      m.notice = repeatNotice(r);
    }),
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
    try { await reload(); } catch (err) { m.error = String(err?.message || 'Could not load the services.'); }
    m.loading = false;
    paint();
  })();
  return { model: m, ready, paint };
}

export function render(state) { // eslint-disable-line no-unused-vars
  return String(html`
    ${pageHead(title, 'Service dates and the positions each one needs.')}
    <div data-screen>${skeleton('Loading…', 'cards', 2)}</div>
  `);
}

export function mount(root, ctx) {
  const screen = root?.querySelector?.('[data-screen]');
  if (!screen) return undefined;
  return createScreen({ api: ctx.api, root: screen, today: ctx.today ?? todayString() }).ready;
}
