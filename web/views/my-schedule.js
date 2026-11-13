// My schedule (home page): the next time I serve, and my upcoming list, each
// with the full roster of that day (opened with a show/hide button).
import { html } from '../lib/html.js';
import { formatDate, formatTime, daysUntil, relativeDay, todayString } from '../lib/dates.js';
import { makeHost, isAlive } from '../lib/host.js';
import { iconSlot } from '../lib/icons.js';
import { toasts } from '../lib/toast.js';
import { statusChip } from '../lib/slotpanel.js';
import { skeleton, emptyState, pageHead, disclosure, refocus } from '../lib/ui.js';
import { showCard, dismissCard } from '../lib/push.js';
import { turnOn } from './notifications.js';
import { answerCount } from '../lib/counts.js';
import { isIosSafari, laterChosen, chooseLater } from '../lib/install.js';

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

// The full roster of the card's day (every service, team and position), shown
// when the volunteer opens it. Rosters come from the server for their days only.
function roster(item, view) {
  const day = view.data?.rosters?.[item.date];
  if (!day?.length) return '';
  const open = !!view.openRosters?.has(item.slotId);
  const label = html`${iconSlot('users', 'icon-sm')} Full roster<span class="visually-hidden"> for ${formatDate(item.date)}</span>`;
  return html`<div class="roster">
    ${disclosure({ action: 'roster', id: item.slotId, open, label })}
    ${open ? html`<div class="roster-body" data-roster="${item.slotId}">${day.map((s) => html`
      <h3 class="roster-service"><span class="num">${formatTime(s.time)}</span> · ${s.serviceTitle}</h3>
      ${s.teams.map((t) => html`<h4 class="team-title">${t.teamName}</h4>
      <ul class="list roster-list">${t.positions.map((p) => html`<li class="roster-row${p.mine ? ' is-mine' : ''}">
        <span class="roster-pos">${p.positionName}</span>
        <span class="roster-who">${p.mine ? html`<strong>You</strong>` : p.name ?? ''} ${statusChip(p.status)}</span>
      </li>`)}</ul>`)}`)}
    </div>` : ''}
  </div>`;
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
  } else if (view.celebrate === item.slotId) {
    // Just said yes: a moment of thanks in place of the buttons, for this one paint.
    actions = html`<p class="serve-done"><span class="done-burst">${iconSlot('check')}</span> You're confirmed. Thank you!</p>`;
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
  return html`<li class="card serve-card${pending ? ' is-pending' : ''}${view.celebrate === item.slotId && !pending ? ' is-celebrating' : ''}" data-slot="${item.slotId}">
    <div class="serve-head">
      ${tile(item.date)}
      <div class="serve-text">
        <h2 class="serve-title">${formatDate(item.date)} · <span class="num">${formatTime(item.time)}</span></h2>
        <p class="serve-meta">${item.serviceTitle ? html`${item.serviceTitle}<br>` : ''}<strong>${item.positionName}</strong> · ${item.teamName}</p>
      </div>
      <span class="chip ${pending ? 'chip-wait' : 'chip-ok'}">${pending ? 'Please answer' : 'Confirmed'}</span>
    </div>
    ${co ? html`<p class="hint serve-with">${iconSlot('users', 'icon-sm')} Serving with: ${co}</p>` : ''}
    ${roster(item, view)}
    ${actions}
  </li>`;
}

// The invitation to turn on notifications (decision 0008), until they are on or dismissed.
function pushInvite(state, view) {
  if (!view.showPush) return '';
  const ios = state?.push?.support === 'ios-install';
  return html`<section class="notice notice-info push-invite" aria-label="Notifications">
    ${iconSlot('bell', 'notice-icon')}
    <div class="notice-body">
      <p><strong>Get a notification when you're asked to serve</strong></p>
      <div class="btn-row">
        ${ios
          ? html`<a class="btn btn-primary" href="#/notifications">Show me how</a>`
          : html`<button type="button" class="btn btn-primary" data-action="push-on" ${view.busy ? 'disabled' : ''}>Turn on</button>`}
        <button type="button" class="btn btn-quiet" data-action="push-later">Not now</button>
      </div>
    </div>
  </section>`;
}

// "Put Flock on your Home Screen", when this device can and the notifications
// card is not showing (one invitation at a time), until installed or "Not now".
function installCard(view) {
  if (!view.showInstall || view.showPush) return '';
  return html`<section class="card install-card" aria-label="Install Flock" data-install-card>
    ${iconSlot('install', 'menu-icon')}
    <div class="install-text"><p><strong>Put Flock on your Home Screen</strong></p><p class="hint">Opens like an app, and you can get notifications.</p>
    <div class="btn-row"><button type="button" class="btn btn-primary" data-action="install" ${view.busy ? 'disabled' : ''}>${view.iosSteps ? 'Show me how' : 'Install'}</button><button type="button" class="btn btn-quiet" data-action="install-later">Not now</button></div></div>
  </section>`;
}

// view: { loading, error, data, message, confirmId, busy, today, openRosters, showPush, showInstall, iosSteps }
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
    ${pushInvite(state, view)}
    ${installCard(view)}
    ${body}
  `);
}

export function mount(main, ctx) {
  const root = makeHost(main);
  const view = { loading: true, today: ctx.today ?? todayString(), openRosters: new Set() };
  const paint = () => { if (isAlive(root, main)) root.innerHTML = render(ctx.state, view); };

  async function load() {
    try {
      view.data = await ctx.api.get('/api/me/schedule');
      view.error = null;
      ctx.setCounts?.({ answer: answerCount(view.data) }); // the tab's badge and the app icon
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
      if (verb === 'accept') {
        view.celebrate = id;
        try { ctx.win?.navigator?.vibrate?.(12); } catch { /* no buzz: fine */ }
      }
    } catch (err) {
      view.problem = err?.message || 'Something went wrong. Please try again.';
    }
    view.busy = false;
    await load();
    view.celebrate = null; // the next paint shows the usual confirmed card
  }

  root.addEventListener('click', (e) => {
    const el = e.target?.closest?.('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    const id = Number(el.dataset.id);
    if (action === 'push-later') { dismissCard(ctx.win); view.showPush = false; paint(); return; }
    if (action === 'install-later') { chooseLater(ctx.win); view.showInstall = false; paint(); return; }
    if (action === 'install') {
      return Promise.resolve(ctx.install?.()).then((result) => {
        if (result === 'accepted') view.showInstall = false;
        else checkInstall();
        paint();
      });
    }
    if (action === 'push-on') {
      view.busy = true; view.message = null; view.problem = null; paint();
      return turnOn(ctx).then((msg) => { view.message = msg; }, (err) => {
        if (err?.status !== 401) view.problem = err?.message || 'Something went wrong. Please try again.';
      }).finally(() => {
        view.busy = false;
        view.showPush = showCard(ctx.state.push, ctx.win);
        paint();
      });
    }
    if (action === 'retry') { view.loading = true; paint(); return load(); }
    if (action === 'roster') { if (!view.openRosters.delete(id)) view.openRosters.add(id); paint(); refocus(root, action, id); return; }
    if (action === 'accept') return answer(id, 'accept', 'Thank you! You are confirmed.');
    if (action === 'decline') return answer(id, 'decline', "Thanks for letting us know. Your scheduler will find someone else.");
    if (action === 'decline-ask') { view.confirmId = id; view.message = null; paint(); return; }
    if (action === 'keep') { view.confirmId = null; paint(); return; }
    if (action === 'decline-sure') return answer(id, 'decline', "Thanks for letting us know. Your scheduler will find someone else.");
  });

  ctx.pushReady?.then(() => { view.showPush = showCard(ctx.state.push, ctx.win); paint(); });
  // The install prompt can arrive after the page has painted (or go, once installed).
  function checkInstall() {
    view.showInstall = !!ctx.canInstall?.() && !laterChosen(ctx.win);
    view.iosSteps = isIosSafari(ctx.win);
  }
  checkInstall();
  const stop = ctx.installer?.onChange?.(() => {
    if (!isAlive(root, main)) { stop?.(); return; }
    checkInstall();
    paint();
  });
  paint();
  return load();
}
