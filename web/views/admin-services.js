// Services page (scheduler only): add a service date with the positions it
// needs, repeat it for more weeks, and edit or delete upcoming services. A
// service shows its buttons once tapped (one at a time). Deleting always asks
// first, and says how many people are scheduled.
import { html } from '../lib/html.js';
import { formatDate, formatTime, todayString } from '../lib/dates.js';
import { iconSlot } from '../lib/icons.js';
import { toasts, createNoticeClock, dropProblem } from '../lib/toast.js';
import { skeleton, emptyState, pageHead, disclosure, refocus, dateTile } from '../lib/ui.js';
import { takenOffText, peopleFrom } from '../lib/taken-off.js';
import { createFiles, filesLabel, sizeWords } from '../lib/files.js';

export const title = 'Services';
export const DEFAULT_TIME = '09:00';
export const DEFAULT_TITLE = 'Sunday service';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** "Saturday service" for a Saturday: the title a new service gets unless one is typed. */
export function titleFor(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return DEFAULT_TITLE;
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return Number.isNaN(day) ? DEFAULT_TITLE : `${DAYS[day]} service`;
}
// A title Flock filled in from the day (so it may follow a new date), not one typed.
const isDayTitle = (t) => DAYS.some((d) => t === `${d} service`);
export const LIST_DAYS = 182; // how far ahead the upcoming list looks
const MAX_COUNT = 20;
const MAX_WEEKS = 26;
const RECENT_DAYS = 91; // how far back "Start from" looks

// ---------- pure helpers (tested directly) ----------

export function addDays(date, n) {
  const [y, m, d] = String(date).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  const p = (x, w = 2) => String(x).padStart(w, '0');
  return `${p(t.getUTCFullYear(), 4)}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

// Counted like the server does for the delete warning: everyone in a slot, once
// each, however many positions they have there.
export const scheduledCount = (svc) => new Set((svc?.slots ?? [])
  .filter((s) => s.personId !== null && s.personId !== undefined).map((s) => s.personId)).size;

export function peopleWords(n) {
  return n === 1 ? '1 person is scheduled on this date' : `${n} people are scheduled on this date`;
}

const val = (els, name) => String(els?.[name]?.value ?? '').trim();
const ticked = (els, name) => !!els?.[name]?.checked;

// The POST /api/services body from the form's elements, or { error }.
export function serviceBody(elements, teams) {
  const date = val(elements, 'date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Please pick a date.' };
  const time = val(elements, 'time');
  if (!/^\d{2}:\d{2}$/.test(time)) return { error: 'Please pick a time, like 9:00 am.' };
  const titleText = val(elements, 'title') || titleFor(date);
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

// "Drums, Keys x2" for what is picked in a team, or "None picked".
export function teamSummary(team, pos = {}) {
  const parts = [];
  for (const p of team?.positions ?? []) {
    if (!pos[p.id]?.on) continue;
    const n = Number(pos[p.id].count);
    parts.push(n > 1 ? `${p.name} x${n}` : p.name);
  }
  return parts.length ? parts.join(', ') : 'None picked';
}

const startKeyOf = (svc) => `${svc.title}|${svc.time}`;

// The services a new one can start from: the latest of each title and time
// that has positions, newest first, at most 4. Past ones count.
export function startChoices(list) {
  const latest = new Map();
  for (const s of list ?? []) {
    if (!s.slots?.length) continue;
    const k = startKeyOf(s);
    const cur = latest.get(k);
    if (!cur || s.date > cur.date || (s.date === cur.date && s.id > cur.id)) latest.set(k, s);
  }
  return sortServices([...latest.values()]).reverse().slice(0, 4);
}

// A week after the source, then on a week at a time until it is today or later
// and nothing is on at that time.
export function nextFreeDate(src, list, today) {
  const taken = new Set((list ?? []).filter((s) => s.time === src.time).map((s) => s.date));
  let date = addDays(src.date, 7);
  for (let i = 0; i < 52; i++) {
    if (date >= today && !taken.has(date)) return date;
    date = addDays(date, 7);
  }
  return today;
}

// The add form's values when starting from a service: its time, title and
// positions, on the next free week.
export function draftFrom(src, list, today) {
  return { ...draftOf(src), date: nextFreeDate(src, list, today) };
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
  const over = r?.overLimit ?? [];
  if (over.length) text += ` Not added: ${over.map(formatDate).join(', ')}. You can have at most 10 upcoming services.`;
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

// '8 spots', '1 spot', or 'No positions yet': how big a service is, in a word.
export function spotsWords(svc) {
  const n = svc?.slots?.length ?? 0;
  return n === 0 ? 'No positions yet' : n === 1 ? '1 spot' : `${n} spots`;
}

export function sortServices(list) {
  return [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
    || (a.time < b.time ? -1 : a.time > b.time ? 1 : 0) || a.id - b.id);
}

// ---------- rendering ----------

// The positions and how many of each, one folded line per team. Folded teams
// stay in the form (hidden), so what is picked is still sent. prefix keeps
// element ids unique when the edit form is open next to the add form.
function positionPicker(teams, d, prefix = '', open = new Set()) {
  // Teams with no positions have nothing to pick: one line about them, not one each.
  const usable = teams.filter((t) => t.positions?.length);
  const bare = teams.length - usable.length;
  const bareNote = bare && usable.length ? html`<p class="hint" data-bare-teams>${bare === 1 ? '1 team has' : `${bare} teams have`} no positions yet, so ${bare === 1 ? 'it is' : 'they are'} not shown. Add positions on the Teams page.</p>` : '';
  if (teams.length && !usable.length) return html`<p class="hint">No positions yet. Add positions on the Teams page first.</p>`;
  return html`${usable.length ? usable.map((t) => {
    const isOpen = open.has(t.id);
    const label = html`<span class="pick-team-name">${t.name}</span><span class="disclosure-sub" data-team-sum="${t.id}">${teamSummary(t, d.pos)}</span>`;
    return html`<div class="field fieldset pick-team" data-team="${t.id}" role="group" aria-label="${t.name}">
      ${disclosure({ action: 'toggle-pick-team', id: t.id, open: isOpen, label })}
      <div class="pick-team-body" data-team-body="${t.id}"${isOpen ? '' : html` hidden`}>
      ${t.positions.map((p) => html`<div class="field pos-pick">
        <label class="check" for="${prefix}pos-${p.id}"><input id="${prefix}pos-${p.id}" name="pos-${p.id}" type="checkbox"${d.pos[p.id]?.on ? html` checked` : ''}> ${p.name}</label>
        <label class="count-label" for="${prefix}count-${p.id}">How many ${p.name}</label>
        <input id="${prefix}count-${p.id}" name="count-${p.id}" type="number" min="1" max="${MAX_COUNT}" value="${d.pos[p.id]?.count ?? '1'}" inputmode="numeric">
      </div>`)}
      </div>
    </div>`;
  }) : html`<p class="hint">No teams yet. Add teams and positions on the Teams page first.</p>`}${bareNote}`;
}

// Buttons to copy a recent service into the form, and Blank to start clean.
function startFrom(m) {
  const choices = startChoices(m.recent);
  if (!choices.length) return '';
  const chip = (id, on, text) => html`<button type="button" class="btn btn-sm start-choice" data-action="start-from" data-id="${id}" aria-pressed="${on ? 'true' : 'false'}">${text}</button>`;
  return html`<div class="field" data-start-from>
    <h3 id="start-from-head">Start from</h3>
    <div class="start-row" role="group" aria-labelledby="start-from-head">
      ${choices.map((c, i) => chip(i, m.startKey === startKeyOf(c), `${c.title} · ${formatTime(c.time)}`))}
      ${chip(-1, m.startKey === null, 'Blank')}
    </div>
  </div>`;
}

function createForm(m) {
  const { teams, today } = m;
  const d = m.draft ?? { date: today, time: DEFAULT_TIME, title: titleFor(today), pos: {} };
  return html`<form class="form card form-card form-wide" data-form="create" novalidate>
    <h2 class="card-title" id="add-title" tabindex="-1">Add a service</h2>
    ${startFrom(m)}
    <div class="field-pair">
    <div class="field"><label for="svc-date">Date</label>
      <input id="svc-date" name="date" type="date" required min="${today}" value="${d.date}"></div>
    <div class="field"><label for="svc-time">Time</label>
      <input id="svc-time" name="time" type="time" required value="${d.time}"></div>
    </div>
    <div class="field"><label for="svc-title">Title</label>
      <input id="svc-title" name="title" type="text" maxlength="100" value="${d.title}"></div>
    <h3>Positions needed</h3>
    ${positionPicker(teams, d, '', m.openTeams)}
    <div class="btn-row"><button type="submit" class="btn btn-primary">${iconSlot('plus')} Add service</button>
      <button type="button" class="btn" data-action="add-cancel">Cancel</button></div>
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
      ${positionPicker(m.teams, d, `edit-${id}-`, m.openTeams)}
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
  if (mine?.kind === 'files' && m.files) {
    extra = html`<div class="confirm files-panel">${m.files.render(svc.id, `svc-${svc.id}`)}</div>`;
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
  // A row is a date, a title and a size. The roster is on Schedule; the
  // positions show here once the row is tapped, next to Edit.
  const label = html`<span class="service-main">
      ${dateTile(svc.date)}
      <span class="service-text">
        <span class="service-title"><span class="visually-hidden">${formatDate(svc.date)}: </span>${svc.title}</span>
        <span class="disclosure-sub num">${formatTime(svc.time)} · ${spotsWords(svc)}</span>
      </span>
    </span>`;
  return html`<li class="service-row" data-service="${svc.id}">
    ${disclosure({ action: 'select', id: svc.id, open: selected, label, cls: 'row-select' })}
    ${selected ? html`<p class="service-detail" data-detail>${svc.slots?.length ? `${positionsSummary(svc, m.teams)}.` : 'No positions yet.'}${n ? html` ${peopleWords(n)}.` : ''}</p>
    <div class="btn-row btn-row-compact row-actions">
      <button type="button" class="btn btn-sm" data-action="repeat" data-id="${svc.id}">Repeat for more weeks</button>
      <button type="button" class="btn btn-sm" data-action="files" data-id="${svc.id}" aria-expanded="${mine?.kind === 'files' ? 'true' : 'false'}">${iconSlot('paperclip')} ${filesLabel(svc.files)}</button>
      <button type="button" class="btn btn-sm" data-action="edit" data-id="${svc.id}">${iconSlot('edit')} Edit</button>
      <button type="button" class="btn btn-sm btn-danger" data-action="delete" data-id="${svc.id}">${iconSlot('trash')} Delete</button>
    </div>` : ''}
    ${extra}
  </li>`;
}

export function renderScreen(m) {
  if (m.loading) return String(skeleton('Loading…', 'cards', 2));
  return String(html`
    ${toasts([[m.notice, 'ok'], [m.error, 'error']])}
    ${m.adding ? createForm(m) : html`<div class="btn-row"><button type="button" class="btn btn-primary" data-action="add-open">${iconSlot('plus')} Add a service</button></div>`}
    <h2 class="section-title">Upcoming services</h2>
    ${m.services.length ? html`<ul class="list card service-list" data-services>${m.services.map((s) => serviceCard(s, m))}</ul>`
    : emptyState('No upcoming services yet. Tap Add a service above.', 'art-calendar')}
    <section class="card purge-card" aria-label="Expired files">
      <h2 class="section-title">Expired files</h2>
      <p class="hint">Files and links are kept until a week after their service. After that nobody can open them; clearing them frees the space.</p>
      <div class="btn-row"><button type="button" class="btn btn-sm" data-action="purge-files">${iconSlot('trash')} Clear expired files</button></div>
    </section>
  `);
}

// ---------- screen controller ----------

export function createScreen({ api, root, today = todayString() }) {
  // selected: the service whose buttons show.
  const m = { teams: [], services: [], recent: [], loading: true, panel: null, error: '', notice: '', today, draft: null, selected: null, adding: false, startKey: null, openTeams: new Set() };
  let busy = false;
  const notices = createNoticeClock();
  const paint = () => {
    m.notice = notices.keep(m.notice);
    root.innerHTML = renderScreen(m);
    notices.resume(root);
  };
  const reload = async () => {
    const [t, s] = await Promise.all([
      api.get('/api/teams'),
      api.get(`/api/services?from=${addDays(m.today, -RECENT_DAYS)}&to=${addDays(m.today, LIST_DAYS)}`),
    ]);
    m.teams = Array.isArray(t) ? t : [];
    m.recent = sortServices(Array.isArray(s) ? s : []);
    m.services = m.recent.filter((x) => x.date >= m.today);
    // A lone team has nothing to choose between: start it open.
    const usable = m.teams.filter((x) => x.positions?.length);
    if (usable.length === 1) m.openTeams.add(usable[0].id);
  };
  const find = (id) => m.services.find((s) => s.id === Number(id));
  m.files = createFiles({ api, paint: () => paint(), onCount: (id, n) => { const svc = find(id); if (svc) svc.files = n; } });

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
    m.adding = false; // one form open at a time
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
    'add-open': () => {
      m.adding = true; m.draft = null; m.startKey = null; m.panel = null; m.selected = null; m.error = ''; m.notice = '';
      paint();
      root.querySelector?.('#add-title')?.focus?.();
    },
    'add-cancel': () => {
      m.adding = false; m.draft = null; m.startKey = null; m.error = '';
      paint();
      root.querySelector?.('[data-action="add-open"]')?.focus?.();
    },
    'start-from': (id) => {
      const src = startChoices(m.recent)[id];
      m.error = '';
      if (src) { m.draft = draftFrom(src, m.recent, m.today); m.startKey = startKeyOf(src); } else { m.draft = null; m.startKey = null; }
      paint();
    },
    // Fold or unfold in place: no repaint, so nothing typed is lost.
    'toggle-pick-team': (id, el) => {
      const open = !m.openTeams.has(id);
      if (open) m.openTeams.add(id); else m.openTeams.delete(id);
      const body = root.querySelector?.(`[data-team-body="${id}"]`);
      if (body) body.hidden = !open;
      el?.setAttribute?.('aria-expanded', open ? 'true' : 'false');
    },
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
    files: (id) => {
      if (m.panel?.kind === 'files' && m.panel.id === id) { m.panel = null; paint(); return; }
      if (!find(id)) return;
      m.panel = { kind: 'files', id };
      m.selected = id;
      m.error = '';
      m.notice = '';
      paint();
      m.files.open(id);
    },
    'purge-files': () => attempt(async () => {
      const r = await api.post('/api/admin/files/purge');
      m.notice = r?.removed
        ? `Cleared ${r.removed} expired ${r.removed === 1 ? 'file or link' : 'files and links'} (${sizeWords(r.bytes)} freed).`
        : 'Nothing to clear: no files have expired.';
    }),
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
      m.adding = false;
      m.startKey = null;
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

  // A problem goes away once the person starts fixing it.
  // A new date brings its day's title, unless a title was typed.
  root.addEventListener('change', (e) => {
    // A ticked position or a new count updates its team's folded line.
    const hit = /^(?:pos|count)-(\d+)$/.exec(e.target?.name ?? '');
    const form = hit && e.target.form;
    if (form?.elements) {
      const team = m.teams.find((t) => (t.positions ?? []).some((p) => p.id === Number(hit[1])));
      const sum = team && root.querySelector?.(`[data-team-sum="${team.id}"]`);
      if (sum) sum.textContent = teamSummary(team, readDraft(form.elements, m.teams).pos);
      return;
    }
    if (e.target?.id !== 'svc-date') return;
    const title = root.querySelector?.('#svc-title');
    if (title && (!title.value || isDayTitle(title.value))) title.value = titleFor(e.target.value);
  });
  root.addEventListener('change', (e) => { m.files.change(e); });
  root.addEventListener('input', () => {
    if (!m.error) return;
    m.error = '';
    dropProblem(root);
  });
  root.addEventListener('click', (e) => {
    const el = e.target?.closest?.('[data-action]');
    if (el && m.files.click(el)) return;
    const fn = el && actions[el.dataset.action];
    if (fn) fn(Number(el.dataset.id), el);
  });
  root.addEventListener('submit', (e) => {
    const form = e.target?.closest?.('form[data-form]');
    if (!form) return;
    e.preventDefault();
    if (m.files.submit(form)) return;
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
