// My days off: add days I can't serve, and remove them again.
import { html } from '../lib/html.js';
import { formatDate, formatRange, isDate, todayString } from '../lib/dates.js';
import { makeHost, isAlive } from '../lib/host.js';

export const title = "Days I can't serve";

const GENERIC = 'Something went wrong. Please try again.';

// Returns a plain-language problem with the form values, or '' when fine.
export function checkForm({ from, to }) {
  if (!isDate(from)) return 'Please pick the first day you can\'t serve (From).';
  if (!isDate(to)) return 'Please pick the last day you can\'t serve (To).';
  if (to < from) return 'The "To" day can\'t be before the "From" day.';
  return '';
}

export function conflictLine(c) {
  return `You are already scheduled on ${formatDate(c.date)} as ${c.positionName}. Please tell your scheduler.`;
}

// view: { loading, error, list, message, problem, conflicts, busy, today, form }
export function render(state, view = { loading: true }) {
  const today = view.today ?? todayString();
  const f = view.form ?? { from: today, to: today, reason: '' };
  const busy = view.busy ? 'disabled' : '';
  let list;
  if (view.error) {
    list = html`<p class="form-error" role="alert">${view.error}</p>
      <p><button type="button" class="btn btn-primary" data-action="retry">Try again</button></p>`;
  } else if (view.loading || !view.list) {
    list = html`<p class="loading">Loading…</p>`;
  } else if (!view.list.length) {
    list = html`<p class="empty">You have no days off saved. Add one above if there is a time you can't serve.</p>`;
  } else {
    list = html`<ul class="cards">${view.list.map((b) => html`<li class="card" data-blockout="${b.id}">
      <h3>${formatRange(b.startDate, b.endDate)}</h3>
      ${b.reason ? html`<p>${b.reason}</p>` : ''}
      <button type="button" class="btn btn-danger" data-action="remove" data-id="${b.id}" ${busy}>Remove</button>
    </li>`)}</ul>`;
  }
  const conflicts = view.conflicts ?? [];
  return String(html`
    <h1 tabindex="-1">${title}</h1>
    ${view.message ? html`<p class="message message-ok" role="status" data-note>${view.message}</p>` : ''}
    ${view.problem ? html`<p class="message message-error" role="alert" data-problem>${view.problem}</p>` : ''}
    ${conflicts.length ? html`<div class="notice" role="alert" data-conflicts>
      <ul>${conflicts.map((c) => html`<li>${conflictLine(c)}</li>`)}</ul>
    </div>` : ''}
    <form class="form" data-form="blockout" novalidate>
      <div class="field">
        <label for="bo-from">From</label>
        <input id="bo-from" name="from" type="date" required value="${f.from}">
      </div>
      <div class="field">
        <label for="bo-to">To</label>
        <input id="bo-to" name="to" type="date" required value="${f.to}">
      </div>
      <div class="field">
        <label for="bo-reason">Reason (optional)</label>
        <input id="bo-reason" name="reason" type="text" maxlength="200" value="${f.reason}">
      </div>
      <button type="submit" class="btn btn-primary btn-block" ${busy}>Add</button>
    </form>
    <h2>Days I have off</h2>
    ${list}
  `);
}

export function mount(main, ctx) {
  const root = makeHost(main);
  const view = { loading: true, today: ctx.today ?? todayString() };
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
    if (el.dataset.action === 'remove') return remove(Number(el.dataset.id));
    if (el.dataset.action === 'retry') { view.loading = true; paint(); return load(); }
  });
  root.addEventListener('submit', (e) => {
    const form = e.target?.closest?.('form[data-form="blockout"]');
    if (!form) return;
    e.preventDefault();
    return add(form.elements);
  });

  paint();
  return load();
}
