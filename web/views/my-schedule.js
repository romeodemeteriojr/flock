// My schedule (home page): the next time I serve, and my upcoming list.
import { html } from '../lib/html.js';
import { formatDate, formatTime, daysUntil, relativeDay, todayString } from '../lib/dates.js';
import { makeHost, isAlive } from '../lib/host.js';
import { iconSlot } from '../lib/icons.js';
import { toasts } from '../lib/toast.js';
import { skeleton, emptyState, pageHead } from '../lib/ui.js';

export const title = 'My schedule';

const NONE = "You're not scheduled yet. Your scheduler will let you know.";

export function bannerText(next, today) {
  if (!next) return NONE;
  const n = daysUntil(next.date, today);
  if (!(n >= 0)) return NONE;
  if (n <= 7) {
    const r = relativeDay(next.date, today);
    const when = r[0].toLowerCase() + r.slice(1);
    return `You're serving ${when} as ${next.positionName} at ${formatTime(next.time)}`;
  }
  return `Next time you serve: ${formatDate(next.date)}, ${next.positionName}`;
}

// '2026-11-08' -> { day: '8', month: 'Nov', dow: 'Sun' } for the date tile.
function tile(date) {
  const [dow = '', day = '', month = ''] = formatDate(date).split(' ');
  return html`<span class="date-tile" aria-hidden="true"><span class="date-tile-dow">${dow}</span><span class="date-tile-day num">${day}</span><span class="date-tile-mon">${month}</span></span>`;
}

function card(item, view) {
  const pending = item.status === 'pending';
  const co = (item.coVolunteers ?? []).map((c) => `${c.name} (${c.positionName})`).join(', ');
  const busy = view.busy ? 'disabled' : '';
  let actions = '';
  if (pending) {
    actions = html`<div class="btn-row btn-row-split">
      <button type="button" class="btn btn-primary" data-action="accept" data-id="${item.slotId}" ${busy}>Yes, I can</button>
      <button type="button" class="btn btn-danger" data-action="decline" data-id="${item.slotId}" ${busy}>I can't</button>
    </div>`;
  } else if (view.confirmId === item.slotId) {
    actions = html`<div class="notice notice-warn" role="alert">
      ${iconSlot('warning', 'notice-icon')}<div class="notice-body"><p>Are you sure you can't serve on ${formatDate(item.date)}?</p>
      <div class="btn-row">
        <button type="button" class="btn btn-danger" data-action="decline-sure" data-id="${item.slotId}" ${busy}>Yes, I can't make it</button>
        <button type="button" class="btn" data-action="keep" data-id="${item.slotId}" ${busy}>No, keep me on</button>
      </div></div>
    </div>`;
  } else {
    actions = html`<div class="btn-row"><button type="button" class="btn btn-quiet" data-action="decline-ask" data-id="${item.slotId}" ${busy}>I can't make it after all</button></div>`;
  }
  return html`<li class="card serve-card${pending ? ' is-pending' : ''}" data-slot="${item.slotId}">
    <div class="serve-head">
      ${tile(item.date)}
      <div class="serve-text">
        <h2 class="serve-title">${formatDate(item.date)} · <span class="num">${formatTime(item.time)}</span></h2>
        <p class="serve-meta">${item.serviceTitle ? html`${item.serviceTitle}<br>` : ''}<strong>${item.positionName}</strong> · ${item.teamName}</p>
      </div>
      <span class="chip ${pending ? 'chip-wait' : 'chip-ok'}">${pending ? 'Please answer' : 'Confirmed'}</span>
    </div>
    ${co ? html`<p class="hint serve-with">${iconSlot('users', 'icon-sm')} Serving with: ${co}</p>` : ''}
    ${actions}
  </li>`;
}

// view: { loading, error, data, message, confirmId, busy, today }
export function render(state, view = { loading: true }) {
  const today = view.today ?? todayString();
  let body;
  if (view.error) {
    body = html`<p class="form-error" role="alert">${view.error}</p>
      <p><button type="button" class="btn btn-primary" data-action="retry">Try again</button></p>`;
  } else if (view.loading || !view.data) {
    body = html`<div class="hero hero-loading">${skeleton('Loading…', 'rows', 2)}</div>${skeleton('Loading…', 'cards', 2)}`;
  } else {
    const items = view.data.items ?? [];
    const next = view.data.nextServing ?? items[0] ?? null;
    body = html`
      <section class="hero${next ? '' : ' hero-quiet'}" aria-label="Next time you serve">
        <span class="hero-eyebrow">${iconSlot(next ? 'sparkle' : 'calendar', 'icon-sm')} ${next ? 'Next up' : 'Nothing yet'}</span>
        <p class="banner" data-banner>${bannerText(next, today)}</p>
      </section>
      ${items.length
        ? html`<h2 class="section-title">Coming up</h2><ul class="cards">${items.map((i) => card(i, view))}</ul>`
        : emptyState('You have nothing coming up. When you are asked to serve, it will show here.', 'art-calendar')}`;
  }
  return String(html`
    ${pageHead(title)}
    ${toasts([[view.message, 'ok', 'data-note'], [view.problem, 'error']])}
    ${body}
  `);
}

export function mount(main, ctx) {
  const root = makeHost(main);
  const view = { loading: true, today: ctx.today ?? todayString() };
  const paint = () => { if (isAlive(root, main)) root.innerHTML = render(ctx.state, view); };

  async function load() {
    try {
      view.data = await ctx.api.get('/api/me/schedule');
      view.error = null;
    } catch (err) {
      view.error = err?.message || 'Something went wrong. Please try again.';
    }
    view.loading = false;
    paint();
  }

  async function answer(id, verb, done) {
    view.busy = true;
    view.confirmId = null;
    view.message = null;
    view.problem = null;
    paint();
    try {
      await ctx.api.post(`/api/me/slots/${id}/${verb}`);
      view.message = done;
    } catch (err) {
      view.problem = err?.message || 'Something went wrong. Please try again.';
    }
    view.busy = false;
    await load();
  }

  root.addEventListener('click', (e) => {
    const el = e.target?.closest?.('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    const id = Number(el.dataset.id);
    if (action === 'retry') { view.loading = true; paint(); return load(); }
    if (action === 'accept') return answer(id, 'accept', 'Thank you! You are confirmed.');
    if (action === 'decline') return answer(id, 'decline', "Thanks for letting us know. Your scheduler will find someone else.");
    if (action === 'decline-ask') { view.confirmId = id; view.message = null; paint(); return; }
    if (action === 'keep') { view.confirmId = null; paint(); return; }
    if (action === 'decline-sure') return answer(id, 'decline', "Thanks for letting us know. Your scheduler will find someone else.");
  });

  paint();
  return load();
}
