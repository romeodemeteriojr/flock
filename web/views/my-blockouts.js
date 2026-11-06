// My days off: add days I can't serve, and remove them again.
import { html } from '../lib/html.js';
import { formatDate, formatRange, isDate, todayString } from '../lib/dates.js';
import { makeHost, isAlive } from '../lib/host.js';
import { iconSlot } from '../lib/icons.js';
import { toasts } from '../lib/toast.js';
import { skeleton, emptyState, pageHead } from '../lib/ui.js';

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
    list = skeleton('Loading…', 'list', 2);
  } else if (!view.list.length) {
    list = emptyState("You have no days off saved. Add one above if there is a time you can't serve.", 'art-done');
  } else {
    list = html`<ul class="cards">${view.list.map((b) => html`<li class="card off-card" data-blockout="${b.id}">
      <span class="off-icon">${iconSlot('calendar')}</span>
      <div class="off-text">
        <h3 class="num">${formatRange(b.startDate, b.endDate)}</h3>
        ${b.reason ? html`<p class="hint">${b.reason}</p>` : ''}
      </div>
      <button type="button" class="btn btn-danger btn-quiet" data-action="remove" data-id="${b.id}" ${busy}>Remove</button>
    </li>`)}</ul>`;
  }
  const conflicts = view.conflicts ?? [];
  return String(html`
    ${pageHead(title, 'Tell your scheduler when you are away, so nobody asks you on those days.')}
    ${toasts([[view.message, 'ok', 'data-note'], [view.problem, 'error', 'data-problem']])}
    ${conflicts.length ? html`<div class="notice notice-warn" role="alert" data-conflicts>
      ${iconSlot('warning', 'notice-icon')}<div class="notice-body"><ul>${conflicts.map((c) => html`<li>${conflictLine(c)}</li>`)}</ul></div>
    </div>` : ''}
    <form class="form card form-card" data-form="blockout" novalidate>
      <h2 class="card-title">Add days off</h2>
      <div class="field-pair">
        <div class="field">
          <label for="bo-from">From</label>
          <input id="bo-from" name="from" type="date" required value="${f.from}">
        </div>
        <div class="field">
          <label for="bo-to">To</label>
          <input id="bo-to" name="to" type="date" required value="${f.to}">
        </div>
      </div>
      <div class="field">
        <label for="bo-reason">Reason (optional)</label>
        <input id="bo-reason" name="reason" type="text" maxlength="200" value="${f.reason}">
      </div>
      <button type="submit" class="btn btn-primary btn-block" ${busy}>${iconSlot('plus')} Add</button>
    </form>
    <h2 class="section-title">Days I have off</h2>
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
