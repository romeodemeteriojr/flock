// My days off: tap the days I can't serve on a calendar, and remove them again.
// The calendar shows the days already off and the days I am down to serve;
// the form still posts startDate / endDate / reason, from two hidden fields.
import { html } from '../lib/html.js';
import {
  formatDate, formatRange, isDate, todayString, monthGrid, monthLabel, addMonths, daysBetween, shiftDate, longDate,
} from '../lib/dates.js';
import { makeHost, isAlive } from '../lib/host.js';
import { iconSlot } from '../lib/icons.js';
import { toasts } from '../lib/toast.js';
import { skeleton, emptyState, pageHead } from '../lib/ui.js';

export const title = "Days I can't serve";

const GENERIC = 'Something went wrong. Please try again.';

// Returns a plain-language problem with the form values, or '' when fine.
export function checkForm({ from, to }) {
  if (!isDate(from)) return 'Please pick the first day you can\'t serve: tap it on the calendar.';
  if (!isDate(to)) return 'Please pick the last day you can\'t serve: tap it on the calendar.';
  if (to < from) return 'The last day can\'t be before the first day.';
  return '';
}

// How far ahead the calendar goes.
export const MONTHS_AHEAD = 12;

/**
 * A tap on a day: nothing picked or a range picked -> start again on that day;
 * one day picked -> a later day ends the range, an earlier or the same day starts again.
 */
export function tapDay(pick, date) {
  const one = pick?.start && pick.start === pick.end;
  if (one && date > pick.start) return { start: pick.start, end: date };
  return { start: date, end: date };
}

/** "Sat 21 Nov (1 day)", "Sat 21 Nov to Sun 22 Nov (2 days)", or '' when nothing is picked. */
export function rangeText(pick) {
  if (!pick?.start) return '';
  const n = daysBetween(pick.start, pick.end || pick.start);
  return `${formatRange(pick.start, pick.end)} (${n} ${n === 1 ? 'day' : 'days'})`;
}

const inOff = (date, list) => (list ?? []).find((b) => b.startDate <= date && date <= b.endDate);

// One month of days to tap, with what each day already is.
function calendar(view, today) {
  const { year, month } = view.month;
  const { blanks, days } = monthGrid(year, month);
  const first = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
  const last = addMonths(first.year, first.month, MONTHS_AHEAD);
  const atFirst = year === first.year && month === first.month;
  const atLast = year === last.year && month === last.month;
  const pick = view.pick ?? { start: '', end: '' };
  const serving = view.serving ?? new Set();
  const day = (date) => {
    const off = inOff(date, view.list);
    const picked = pick.start && date >= pick.start && date <= (pick.end || pick.start);
    const cls = ['cal-day'];
    if (date === today) cls.push('is-today');
    if (off) {
      cls.push('is-off');
      if (date === off.startDate) cls.push('is-off-start');
      if (date === off.endDate) cls.push('is-off-end');
    }
    if (serving.has(date)) cls.push('is-serving');
    if (picked) cls.push(date === pick.start ? 'is-start' : date === (pick.end || pick.start) ? 'is-end' : 'is-in');
    if (picked && date === pick.start && date === (pick.end || pick.start)) cls.push('is-end');
    const words = [longDate(date)];
    if (date === today) words.push('today');
    if (off) words.push('already off');
    if (serving.has(date)) words.push('you are serving');
    if (picked) words.push('picked');
    return html`<button type="button" class="${cls.join(' ')}" data-action="day" data-date="${date}" aria-pressed="${picked ? 'true' : 'false'}" aria-label="${words.join(', ')}" ${date < today ? 'disabled' : ''}>${Number(date.slice(8))}</button>`;
  };
  return html`<section class="card cal" aria-label="Pick your days off">
    <div class="cal-head"><button type="button" class="icon-btn" data-action="month-prev" aria-label="Previous month" ${atFirst ? 'disabled' : ''}>${iconSlot('chevron-left')}</button><h2 class="cal-month" id="cal-month" aria-live="polite">${monthLabel(year, month)}</h2><button type="button" class="icon-btn" data-action="month-next" aria-label="Next month" ${atLast ? 'disabled' : ''}>${iconSlot('chevron')}</button></div>
    <div class="cal-grid" role="group" aria-labelledby="cal-month" data-cal-grid>${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => html`<span class="cal-dow" aria-hidden="true">${d}</span>`)}${Array.from({ length: blanks }, () => html`<span class="cal-blank"></span>`)}${days.map(day)}</div>
    <p class="cal-legend" aria-hidden="true"><span class="cal-key"><span class="cal-swatch cal-swatch-pick"></span>Picking</span><span class="cal-key"><span class="cal-swatch cal-swatch-off"></span>Already off</span><span class="cal-key"><span class="cal-swatch cal-swatch-serve"></span>You're serving</span></p>
  </section>`;
}

// How often a volunteer can serve; the values match EVERY_WEEKS_CHOICES on the server.
export const FREQUENCIES = Object.freeze([
  [1, 'Every week'],
  [2, 'Every 2 weeks'],
  [3, 'Every 3 weeks'],
  [4, 'Every 4 weeks'],
  [6, 'Every 6 weeks'],
  [8, 'Every 8 weeks'],
  [0, 'Not right now (pause)'],
]);

export function frequencyLabel(n) {
  return FREQUENCIES.find(([v]) => v === n)?.[1] ?? '';
}

function availabilityCard(a, busy) {
  const current = a?.everyWeeks ?? 2;
  return html`<form class="form card form-card" data-form="availability" novalidate>
      <h2 class="card-title">How often can you serve?</h2>
      <div class="field">
        <label for="av-every">I can serve</label>
        <select id="av-every" name="everyWeeks">${FREQUENCIES.map(([v, label]) => html`<option value="${v}"${v === current ? html` selected` : ''}>${label}</option>`)}</select>
      </div>
      <p class="hint">${a && !a.isDefault ? 'Flock uses this when it fills the schedule.' : 'You have not chosen yet, so Flock asks you at most every 2 weeks.'}</p>
      <button type="submit" class="btn btn-primary btn-block" ${busy}>Save</button>
    </form>`;
}

export function conflictLine(c) {
  return `You are already scheduled on ${formatDate(c.date)} as ${c.positionName}. Please tell your scheduler.`;
}

const andList = (parts) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);

// One line per service, not per position: "as Sound and Vocals" (decision 0010).
// Keeps the server's order (date, time, team, position).
export function groupConflicts(conflicts = []) {
  const by = new Map();
  for (const c of conflicts) {
    const key = `${c.date}|${c.time ?? ''}|${c.serviceTitle ?? ''}`;
    if (!by.has(key)) by.set(key, { ...c, names: [] });
    by.get(key).names.push(c.positionName);
  }
  return [...by.values()].map(({ names, ...c }) => ({ ...c, positionName: andList(names) }));
}

// view: { loading, error, list, message, problem, conflicts, busy, today, form }
export function render(state, view = { loading: true }) {
  const today = view.today ?? todayString();
  const f = view.form ?? { reason: '' };
  const busy = view.busy ? 'disabled' : '';
  let list;
  if (view.error) {
    list = html`<p class="form-error" role="alert">${view.error}</p>
      <p><button type="button" class="btn btn-primary" data-action="retry">Try again</button></p>`;
  } else if (view.loading || !view.list) {
    list = skeleton('Loading…', 'list', 2);
  } else if (!view.list.length) {
    list = emptyState("You have no days off saved. Tap the days on the calendar above if there is a time you can't serve.", 'art-done');
  } else {
    list = html`<ul class="cards">${view.list.map((b) => html`<li class="card off-card" data-blockout="${b.id}">
      <span class="off-icon">${iconSlot('calendar-off')}</span>
      <div class="off-text">
        <h3 class="num">${formatRange(b.startDate, b.endDate)}</h3>
        ${b.reason ? html`<p class="hint">${b.reason}</p>` : ''}
      </div>
      <button type="button" class="btn btn-danger btn-quiet" data-action="remove" data-id="${b.id}" ${busy}>Remove</button>
    </li>`)}</ul>`;
  }
  const conflicts = view.conflicts ?? [];
  const pick = view.pick ?? { start: '', end: '' };
  const range = rangeText(pick);
  const viewWithMonth = view.month ? view : { ...view, month: { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) } };
  return String(html`
    ${pageHead(title, 'Tap the days you are away, so nobody asks you then.')}
    ${toasts([[view.message, 'ok', 'data-note'], [view.problem, 'error', 'data-problem']])}
    ${conflicts.length ? html`<div class="notice notice-warn" role="alert" data-conflicts>
      ${iconSlot('warning', 'notice-icon')}<div class="notice-body"><ul>${groupConflicts(conflicts).map((c) => html`<li>${conflictLine(c)}</li>`)}</ul></div>
    </div>` : ''}
    <form class="form form-wide" data-form="blockout" novalidate>
      ${calendar(viewWithMonth, today)}
      <div class="cal-pick">
        <p class="cal-range num${range ? '' : ' cal-range-empty'}" data-range aria-live="polite">${range || 'Tap a day to start.'}</p>
        <input type="hidden" name="from" value="${pick.start}"><input type="hidden" name="to" value="${pick.end || pick.start}">
        <div class="field">
          <label for="bo-reason">Reason (optional)</label>
          <input id="bo-reason" name="reason" type="text" maxlength="200" value="${f.reason}">
        </div>
        <button type="submit" class="btn btn-primary btn-block btn-lg" ${busy}>${iconSlot('plus')} Add days off</button>
      </div>
    </form>
    <h2 class="section-title">Days I have off</h2>
    ${list}
    ${availabilityCard(view.availability, busy)}
  `);
}

export function mount(main, ctx) {
  const root = makeHost(main);
  const today = ctx.today ?? todayString();
  const view = {
    loading: true, today, pick: { start: '', end: '' }, serving: new Set(),
    month: { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) },
  };
  const paint = () => { if (isAlive(root, main)) root.innerHTML = render(ctx.state, view); };

  async function load() {
    try {
      const r = await ctx.api.get('/api/me/blockouts');
      view.list = r?.blockouts ?? [];
      view.error = null;
    } catch (err) {
      view.error = err?.message || GENERIC;
    }
    view.loading = false;
    paint();
  }

  // The days I am down to serve (not declined), dotted on the calendar. A hint only.
  async function loadServing() {
    try {
      const r = await ctx.api.get('/api/me/schedule');
      view.serving = new Set((r?.items ?? []).filter((i) => i.status !== 'declined').map((i) => i.date));
    } catch { /* the calendar works without the dots */ }
    paint();
  }

  async function loadAvailability() {
    try {
      const r = await ctx.api.get('/api/me/availability');
      view.availability = r?.availability ?? null;
    } catch {
      view.availability = null; // the form still shows the default
    }
    paint();
  }

  async function saveAvailability(form) {
    const everyWeeks = Number(form.everyWeeks?.value);
    view.message = null;
    view.problem = null;
    view.conflicts = [];
    view.busy = true;
    paint();
    try {
      const r = await ctx.api.put('/api/me/availability', { everyWeeks });
      view.availability = r?.availability ?? null;
      view.message = everyWeeks === 0 ? 'Saved. Flock will not ask you for now.' : `Saved. ${frequencyLabel(everyWeeks)} at most.`;
    } catch (err) {
      view.problem = err?.message || GENERIC;
    }
    view.busy = false;
    paint();
  }

  async function add(form) {
    const values = {
      from: String(form.from?.value ?? '').trim(),
      to: String(form.to?.value ?? '').trim(),
      reason: String(form.reason?.value ?? '').trim(),
    };
    view.form = values;
    view.message = null;
    view.conflicts = [];
    view.problem = checkForm(values);
    if (view.problem) { paint(); return; }
    view.busy = true;
    paint();
    try {
      const r = await ctx.api.post('/api/me/blockouts', {
        startDate: values.from, endDate: values.to, reason: values.reason,
      });
      view.conflicts = r?.conflicts ?? [];
      view.message = `Saved. You are off ${formatRange(values.from, values.to)}.`;
      view.form = null;
      view.pick = { start: '', end: '' }; // the month stays where it was
    } catch (err) {
      view.problem = err?.message || GENERIC;
    }
    view.busy = false;
    await load();
  }

  async function remove(id) {
    view.busy = true;
    view.message = null;
    view.problem = null;
    view.conflicts = [];
    paint();
    try {
      await ctx.api.del(`/api/me/blockouts/${id}`);
      view.message = 'Removed. You can be scheduled on those days again.';
    } catch (err) {
      view.problem = err?.message || GENERIC;
    }
    view.busy = false;
    await load();
  }

  root.addEventListener('click', (e) => {
    const el = e.target?.closest?.('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'day') {
      if (el.disabled || !isDate(el.dataset.date) || el.dataset.date < today) return undefined;
      view.pick = tapDay(view.pick, el.dataset.date);
      view.problem = null;
      paint();
      root.querySelector?.(`[data-action="day"][data-date="${el.dataset.date}"]`)?.focus?.();
      return undefined;
    }
    if (action === 'month-prev' || action === 'month-next') {
      // Between this month and MONTHS_AHEAD months on, whatever was tapped.
      const next = addMonths(view.month.year, view.month.month, action === 'month-next' ? 1 : -1);
      const first = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
      const last = addMonths(first.year, first.month, MONTHS_AHEAD);
      const at = (m) => m.year * 12 + m.month;
      if (at(next) < at(first) || at(next) > at(last)) return undefined;
      view.month = next;
      paint();
      root.querySelector?.(`[data-action="${action}"]`)?.focus?.();
      return undefined;
    }
    if (el.dataset.action === 'remove') return remove(Number(el.dataset.id));
    if (el.dataset.action === 'retry') { view.loading = true; paint(); return load(); }
  });
  root.addEventListener('submit', (e) => {
    const form = e.target?.closest?.('form[data-form]');
    if (!form) return;
    e.preventDefault();
    if (form.dataset.form === 'availability') return saveAvailability(form.elements);
    return add(form.elements);
  });

  // Arrow keys move between days (a week up and down); off the month's edge turns the page.
  root.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    const date = e.target?.dataset?.date;
    if (!step || !date || e.target?.dataset?.action !== 'day') return;
    const next = shiftDate(date, step);
    const limit = addMonths(Number(today.slice(0, 4)), Number(today.slice(5, 7)), MONTHS_AHEAD);
    const nextMonth = { year: Number(next.slice(0, 4)), month: Number(next.slice(5, 7)) };
    if (next < today || nextMonth.year * 12 + nextMonth.month > limit.year * 12 + limit.month) return;
    e.preventDefault?.();
    if (nextMonth.year !== view.month.year || nextMonth.month !== view.month.month) { view.month = nextMonth; paint(); }
    root.querySelector?.(`[data-action="day"][data-date="${next}"]`)?.focus?.();
  });

  paint();
  return Promise.all([loadAvailability(), load(), loadServing()]);
}
