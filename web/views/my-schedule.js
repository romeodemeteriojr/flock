// My schedule (home page). The hero carries the one thing that matters now:
// the earliest ask to answer (with Yes / I can't right there), or else the
// next time I serve. Below it, other asks, then what is coming up, one line
// each, with the details (who else, the day's full roster) on tap.
import { html } from '../lib/html.js';
import { formatDate, formatTime, relativeDay, todayString } from '../lib/dates.js';
import { makeHost, isAlive } from '../lib/host.js';
import { iconSlot } from '../lib/icons.js';
import { toasts } from '../lib/toast.js';
import { statusChip } from '../lib/slotpanel.js';
import { skeleton, emptyState, pageHead, disclosure, refocus, dateTile as tile } from '../lib/ui.js';
import { showCard, dismissCard } from '../lib/push.js';
import { turnOn } from './notifications.js';
import { answerCount } from '../lib/counts.js';
import { isIosSafari, laterChosen, chooseLater } from '../lib/install.js';
import { avatar } from '../lib/avatar.js';
import { host, watchHost } from '../lib/sheet.js';
import { createFiles, filesLabel } from '../lib/files.js';

export const title = 'My schedule';

const NONE = "You're not scheduled yet. Your scheduler will let you know.";


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

// The service's files and links (decision 0011), behind a disclosure. key is
// the card's slot, so two cards of one service keep their own open state.
function filesBlock(item, view) {
  if (!item?.serviceId) return '';
  const key = item.slotId;
  const open = !!view.openFiles?.has(key);
  const n = view.fileCounts?.get(item.serviceId) ?? item.files ?? 0;
  const label = html`${iconSlot('paperclip', 'icon-sm')} ${filesLabel(n)}<span class="visually-hidden"> for ${formatDate(item.date)}</span>`;
  return html`<div class="files-block">
    ${disclosure({ action: 'files', id: key, open, label })}
    ${open && view.files ? view.files.render(item.serviceId, key) : ''}
  </div>`;
}

// Who else serves at that service, as the hero says it: "With Ana, Bo and Cy",
// or "With Ana, Bo and 3 others". First names, unless two would be the same.
export function withWords(coVolunteers = []) {
  const full = coVolunteers.map((c) => String(c?.name ?? '').trim()).filter(Boolean);
  const firsts = full.map((n) => n.split(/\s+/)[0]);
  const first = new Set(firsts).size === firsts.length ? firsts : full;
  if (!first.length) return '';
  if (first.length === 1) return `With ${first[0]}`;
  if (first.length <= 3) return `With ${first.slice(0, -1).join(', ')} and ${first.at(-1)}`;
  return `With ${first[0]}, ${first[1]} and ${first.length - 2} others`;
}

/**
 * The item the hero carries: the one just confirmed (kept there until the page
 * next loads, so it does not jump away under a finger), else the earliest ask
 * still to answer, else the next time serving, else nothing.
 */
export function heroItem(data, keep = null) {
  const items = data?.items ?? [];
  return items.find((i) => i.slotId === keep)
    ?? items.find((i) => i.status === 'pending')
    ?? data?.nextServing ?? items[0] ?? null;
}

// "Also on Vocals": my other positions at the same service (decision 0010).
export const alsoWords = (item) => (item?.alsoOn?.length
  ? `Also on ${item.alsoOn.length === 1 ? item.alsoOn[0] : `${item.alsoOn.slice(0, -1).join(', ')} and ${item.alsoOn.at(-1)}`}`
  : '');
const several = (item) => !!item?.alsoOn?.length;
const cantAfterAll = (item) => (several(item) ? `I can't do ${item.positionName} after all` : "I can't make it after all");

// With other positions at the same service, the words name this one: saying no
// to Sound leaves Vocals as it is.
// One tap is easy to make by mistake, and a "no" tells the scheduler at once,
// so "I can't" always asks first: for an ask, and after saying yes.
const SURE = (item, busy) => html`<div class="notice notice-warn" role="alert">
      ${iconSlot('warning', 'notice-icon')}<div class="notice-body"><p>${several(item)
        ? `Are you sure you can't do ${item.positionName} on ${formatDate(item.date)}?`
        : `Are you sure you can't serve on ${formatDate(item.date)}?`}</p>
      <div class="btn-row">
        <button type="button" class="btn btn-danger" data-action="decline-sure" data-id="${item.slotId}" ${busy}>${several(item) ? `Yes, I can't do ${item.positionName}` : "Yes, I can't make it"}</button>
        <button type="button" class="btn" data-action="keep" data-id="${item.slotId}" ${busy}>${item.status === 'pending' ? 'No, go back' : 'No, keep me on'}</button>
      </div></div>
    </div>`;

// The next thing, big: when, what, who with, and the answer buttons right there.
function hero(item, view, today) {
  const pending = item.status === 'pending';
  const busy = view.busy ? 'disabled' : '';
  const rel = relativeDay(item.date, today);
  const celebrating = view.celebrate === item.slotId && !pending;
  const co = item.coVolunteers ?? [];
  let answer;
  if (pending && view.confirmId === item.slotId) {
    answer = html`<div class="hero-status">${SURE(item, busy)}</div>`;
  } else if (pending) {
    answer = html`<p class="hero-ask" id="hero-ask">Can you serve?</p>
    <div class="hero-actions" role="group" aria-labelledby="hero-ask"><button type="button" class="btn btn-lg btn-hero" data-action="accept" data-id="${item.slotId}" ${busy}>${iconSlot('check')} Yes, I can</button><button type="button" class="btn btn-lg btn-hero-quiet" data-action="decline-ask" data-id="${item.slotId}" ${busy}>I can't</button></div>`;
  } else if (celebrating) {
    answer = html`<p class="hero-done"><span class="done-burst">${iconSlot('check')}</span> You're confirmed. Thank you!</p>`;
  } else if (view.confirmId === item.slotId) {
    answer = html`<div class="hero-status">${SURE(item, busy)}</div>`;
  } else {
    answer = html`<div class="hero-status"><span class="chip hero-chip">${iconSlot('check', 'chip-icon')}Confirmed</span><button type="button" class="hero-link" data-action="decline-ask" data-id="${item.slotId}" ${busy}>${cantAfterAll(item)}</button></div>`;
  }
  return html`<section class="hero hero-next${celebrating ? ' is-celebrating' : ''}" aria-label="Next time you serve" data-slot="${item.slotId}">
    <span class="hero-eyebrow">${iconSlot(pending ? 'clock' : 'sparkle', 'icon-sm')} ${pending ? 'Please answer' : 'Next up'}${rel ? ` · ${rel}` : ''}</span>
    <p class="banner" data-banner>${formatDate(item.date)} at <span class="num">${formatTime(item.time)}</span></p>
    <p class="hero-role"><strong>${item.positionName}</strong> · ${item.teamName}</p>
    ${several(item) ? html`<p class="hero-sub" data-also>${alsoWords(item)}</p>` : ''}
    ${item.serviceTitle ? html`<p class="hero-sub">${item.serviceTitle}</p>` : ''}
    ${co.length ? html`<p class="hero-with"><span class="avatar-stack">${co.slice(0, 3).map((c) => avatar(c.name, 'sm'))}</span> <span>${withWords(co)}</span></p>` : ''}
    ${answer}
  </section>`;
}

// What comes after the hero: one line per time, the answer buttons for asks,
// and Details (who else, the full roster, "I can't make it after all") on tap.
function card(item, view) {
  const pending = item.status === 'pending';
  const co = (item.coVolunteers ?? []).map((c) => `${c.name} (${c.positionName})`).join(', ');
  const busy = view.busy ? 'disabled' : '';
  const open = !!view.openCards?.has(item.slotId);
  let actions = '';
  if (pending && view.confirmId === item.slotId) {
    actions = SURE(item, busy);
  } else if (pending) {
    actions = html`<div class="btn-row btn-row-split">
      <button type="button" class="btn btn-primary" data-action="accept" data-id="${item.slotId}" ${busy}>Yes, I can</button>
      <button type="button" class="btn btn-danger" data-action="decline-ask" data-id="${item.slotId}" ${busy}>I can't</button>
    </div>`;
  } else if (view.confirmId === item.slotId) {
    actions = SURE(item, busy);
  } else {
    actions = html`<div class="btn-row"><button type="button" class="btn btn-quiet" data-action="decline-ask" data-id="${item.slotId}" ${busy}>${cantAfterAll(item)}</button></div>`;
  }
  const details = html`${co ? html`<p class="hint serve-with">${iconSlot('users', 'icon-sm')} Serving with: ${co}</p>` : ''}${roster(item, view)}${filesBlock(item, view)}`;
  const hasDetails = !!co || !!view.data?.rosters?.[item.date]?.length || !pending || !!item.serviceId;
  return html`<li class="card serve-card is-compact${pending ? ' is-pending' : ''}" data-slot="${item.slotId}">
    <div class="serve-head">
      ${tile(item.date)}
      <div class="serve-text">
        <h3 class="serve-title">${item.positionName} · ${item.teamName}<span class="visually-hidden">, ${formatDate(item.date)}</span></h3>
        <p class="serve-meta">${item.serviceTitle ? html`${item.serviceTitle} · ` : ''}<span class="num">${formatTime(item.time)}</span></p>
        ${several(item) ? html`<p class="serve-meta" data-also>${alsoWords(item)}</p>` : ''}
      </div>
      ${pending ? '' : html`<span class="chip chip-ok">${iconSlot('check', 'chip-icon')}Confirmed</span>`}
    </div>
    ${pending ? actions : ''}
    ${hasDetails ? disclosure({ action: 'card', id: item.slotId, open, label: html`Details<span class="visually-hidden"> for ${formatDate(item.date)}</span>`, cls: 'serve-more' }) : ''}
    ${open ? html`<div class="serve-details" data-details="${item.slotId}">${details}${pending ? '' : actions}</div>` : ''}
  </li>`;
}

// A service of the past week that still has files (kept a week after it).
// Nothing to answer any more: just when, what, and the files.
function recentCard(item, view) {
  return html`<li class="card serve-card is-compact is-past" data-recent="${item.serviceId}">
    <div class="serve-head">
      ${tile(item.date)}
      <div class="serve-text">
        <h3 class="serve-title">${item.positions.join(', ')}<span class="visually-hidden">, ${formatDate(item.date)}</span></h3>
        <p class="serve-meta">${item.serviceTitle ? html`${item.serviceTitle} · ` : ''}<span class="num">${formatTime(item.time)}</span></p>
      </div>
    </div>
    ${filesBlock(item, view)}
  </li>`;
}

function lastWeek(view) {
  const recent = view.data?.recent ?? [];
  if (!recent.length) return '';
  return html`<h2 class="section-title">Last week</h2>
    <p class="hint section-hint">Files stay for a week after the service.</p>
    <ul class="cards">${recent.map((i) => recentCard(i, view))}</ul>`;
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

// view: { loading, error, data, message, confirmId, busy, today, openRosters, openCards, celebrate, keep, showPush, showInstall, iosSteps }
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
    const top = heroItem(view.data, view.celebrate ?? view.keep);
    const rest = items.filter((i) => i.slotId !== top?.slotId); // never twice
    const asks = rest.filter((i) => i.status === 'pending');
    const later = rest.filter((i) => i.status !== 'pending');
    const dayRoster = top ? roster(top, view) : '';
    if (!top) {
      body = html`<section class="hero hero-quiet" aria-label="Next time you serve">
        <span class="hero-eyebrow">${iconSlot('calendar', 'icon-sm')} Nothing yet</span>
        <p class="banner" data-banner>${NONE}</p>
      </section>
      ${emptyState('You have nothing coming up. When you are asked to serve, it will show here.', 'art-calendar')}`;
    } else {
      const first = html`${hero(top, view, today)}
        ${dayRoster || top.serviceId ? html`<div class="card hero-roster">${dayRoster}${filesBlock(top, view)}</div>` : ''}
        ${asks.length ? html`<h2 class="section-title">Also needs your answer</h2><ul class="cards">${asks.map((i) => card(i, view))}</ul>` : ''}`;
      const coming = later.length ? html`<ul class="cards">${later.map((i) => card(i, view))}</ul>` : '';
      // Wide screens: what comes up sits beside the hero.
      body = view.wide && coming
        ? html`<div class="split split-wide"><div>${first}</div><aside class="pane" aria-label="Coming up"><h2 class="section-title pane-title">Coming up</h2>${coming}</aside></div>`
        : html`${first}${coming ? html`<h2 class="section-title">Coming up</h2>${coming}` : ''}`;
    }
  }
  return String(html`
    ${pageHead(title)}
    ${toasts([[view.message, 'ok', 'data-note'], [view.problem, 'error']])}
    ${pushInvite(state, view)}
    ${installCard(view)}
    ${body}
    ${view.data && !view.error && !view.loading ? lastWeek(view) : ''}
  `);
}

export function mount(main, ctx) {
  const root = makeHost(main);
  const view = { loading: true, today: ctx.today ?? todayString(), openRosters: new Set(), openCards: new Set(), openFiles: new Set(), fileCounts: new Map() };
  view.wide = host(ctx.win) === 'pane';
  const paint = () => { if (isAlive(root, main)) root.innerHTML = render(ctx.state, view); };
  view.files = createFiles({ api: ctx.api, paint, onCount: (id, n) => view.fileCounts.set(id, n) });

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
      view.keep = null;
      if (verb === 'accept') {
        view.celebrate = id;
        view.keep = id;
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
    if (view.files.click(el)) return;
    if (action === 'files') {
      if (!view.openFiles.delete(id)) {
        view.openFiles.add(id);
        const item = [...(view.data?.items ?? []), ...(view.data?.recent ?? [])].find((i) => i.slotId === id);
        if (item?.serviceId) view.files.open(item.serviceId);
      }
      paint();
      refocus(root, action, id);
      return;
    }
    if (action === 'card') { if (!view.openCards.delete(id)) view.openCards.add(id); paint(); refocus(root, action, id); return; }
    if (action === 'accept') return answer(id, 'accept', 'Thank you! You are confirmed.');
    if (action === 'decline') return answer(id, 'decline', "Thanks for letting us know. Your scheduler will find someone else.");
    if (action === 'decline-ask') { view.confirmId = id; view.message = null; paint(); return; }
    if (action === 'keep') { view.confirmId = null; paint(); return; }
    if (action === 'decline-sure') return answer(id, 'decline', "Thanks for letting us know. Your scheduler will find someone else.");
  });

  root.addEventListener('change', (e) => { view.files.change(e); });
  root.addEventListener('submit', (e) => {
    const form = e.target?.closest?.('form[data-form]');
    if (form && view.files.submit(form)) e.preventDefault?.();
  });

  ctx.pushReady?.then(() => { view.showPush = showCard(ctx.state.push, ctx.win); paint(); });
  // The install prompt can arrive after the page has painted (or go, once installed).
  function checkInstall() {
    view.showInstall = !!ctx.canInstall?.() && !laterChosen(ctx.win);
    view.iosSteps = isIosSafari(ctx.win);
  }
  checkInstall();
  const stopWide = watchHost(ctx.win, () => {
    if (!isAlive(root, main)) { stopWide(); return; }
    view.wide = host(ctx.win) === 'pane';
    paint();
  });
  const stop = ctx.installer?.onChange?.(() => {
    if (!isAlive(root, main)) { stop?.(); return; }
    checkInstall();
    paint();
  });
  paint();
  return load();
}
