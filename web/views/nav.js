// Top bar and main menu. Members see their own pages; admins also see the
// scheduling pages. One menu serves both screen sizes (style.css):
//  - phones: a bottom tab bar with icons (members: My schedule, Days off;
//    admins: Schedule, Gaps, People, More; "More" opens the other pages);
//  - wide screens: a row of tabs under the top bar, every page in a line.
// The current page has aria-current="page" (exactly one link).
//
// The top bar is slim: the mark and "Flock" (which cross-fade to the page's
// title once its heading scrolls under the bar, see web/app.js), the bell,
// and the person's avatar, which opens the account sheet (views/account.js:
// notifications, password, install, log out).
import { html } from '../lib/html.js';
import { navRoutes, pathOf, isAdmin } from '../routes.js';
import { iconSlot } from '../lib/icons.js';
import { avatar } from '../lib/avatar.js';
import { badgeText } from '../lib/counts.js';
import { swipeToDismiss } from '../lib/swipe.js';

// One picture per page, each showing the thing itself: a crossed-out calendar
// for days off, a calendar for the schedule, a missing puzzle piece for gaps.
const ICONS = {
  '/': 'home', '/blockouts': 'calendar-off', '/people': 'users', '/teams': 'team',
  '/services': 'church', '/schedule': 'calendar', '/gaps': 'puzzle',
};
const SHORT = { '/blockouts': 'Days off' };
// The admin's tabs on a phone, in this order; the rest go under "More".
export const ADMIN_TABS = Object.freeze(['/schedule', '/gaps', '/people']);

// A count on a tab: the number for the eye, the words for a screen reader.
function badge(n, words) {
  const text = badgeText(n);
  return text ? html`<span class="nav-badge" aria-hidden="true">${text}</span><span class="visually-hidden">, ${n} ${words}</span>` : '';
}

function link(r, current, extra = '') {
  return html`<li class="nav-item"><a href="#${r.path}" ${r.path === current ? html`aria-current="page"` : ''}>${iconSlot(ICONS[r.path] ?? 'chevron', 'nav-icon')}<span class="nav-label">${r.label}</span>${SHORT[r.path] ? html`<span class="nav-label-short">${SHORT[r.path]}</span>` : ''}${extra}</a></li>`;
}

// The bell (decision 0008): opens the Notifications page. On here: a solid
// accent bell. Off: a plain, crossed-out bell.
function bell(push) {
  const on = push.status === 'on';
  const label = on ? 'Notifications: on for this device' : 'Notifications: off for this device';
  return html`<a class="icon-btn ${on ? 'is-on' : 'is-off'}" href="#/notifications" aria-label="${label}" title="${label}">${iconSlot(on ? 'bell' : 'bell-off')}</a>`;
}

/** state.accountOpen marks the avatar button as expanded; title is the page's own name. */
export function render(state, hash = '', title = '') {
  const user = state?.user;
  if (!user) return '';
  const current = pathOf(hash);
  const all = navRoutes(user);
  const admin = isAdmin(user);
  const main = admin ? ADMIN_TABS.map((p) => all.find((r) => r.path === p)).filter(Boolean) : all;
  const extra = admin ? all.filter((r) => !ADMIN_TABS.includes(r.path)) : [];
  const extraCurrent = extra.some((r) => r.path === current);
  // Badges: what you have to answer (on My schedule, wherever it is) and, for
  // schedulers, the gaps. On a phone My schedule is inside More, so More carries it too.
  const answer = state.counts?.answer ?? 0;
  const badges = { '/': badge(answer, 'to answer'), '/gaps': badge(state.counts?.gaps ?? 0, 'gaps') };
  const tab = (r) => link(r, current, badges[r.path] ?? '');
  const moreHasAnswer = extra.some((r) => r.path === '/');
  const menu = all.length ? html`
    <nav class="nav${admin ? ' nav-admin' : ''}" aria-label="Main menu">
      <ul class="nav-list">
        ${main.map(tab)}
        ${extra.length ? html`<li class="nav-item nav-more-item">
          <button type="button" class="nav-more${extraCurrent ? ' has-current' : ''}" data-action="nav-more" aria-expanded="false" aria-controls="nav-more-menu">${iconSlot('more', 'nav-icon')}<span class="nav-label-short">More</span>${extraCurrent ? html`<span class="visually-hidden"> (the page you are on is in here)</span>` : ''}${moreHasAnswer ? badge(answer, 'to answer') : ''}</button>
        </li>
        <li class="nav-item nav-sub-wrap"><div class="sheet-grab" aria-hidden="true"></div><h2 class="nav-sub-title" id="nav-more-title">More</h2><ul class="nav-sub" id="nav-more-menu" aria-labelledby="nav-more-title">${extra.map(tab)}</ul></li>` : ''}
      </ul>
      ${extra.length ? html`<div class="nav-scrim" data-action="nav-close"></div>` : ''}
    </nav>` : '';
  return String(html`
    <div class="topbar">
      <a class="brand" href="#/" aria-label="Flock, my schedule">${iconSlot('flock', 'brand-mark')}<span class="top-titles"><span class="brand-name">Flock</span><span class="top-title" aria-hidden="true">${title}</span></span></a>
      <div class="nav-user">
        ${state.push?.enabled ? bell(state.push) : ''}
        <button type="button" class="avatar-btn" data-action="account" aria-haspopup="dialog" aria-expanded="${state.accountOpen ? 'true' : 'false'}" aria-label="Your account: ${user.name}">${avatar(user.name, 'sm')}<span class="avatar-name" aria-hidden="true">${user.name}</span></button>
      </div>
    </div>
    ${menu}
  `);
}

export function mount(root, ctx) {
  const nav = typeof root.querySelector === 'function' ? root.querySelector('.nav') : null;
  const more = nav ? nav.querySelector('[data-action="nav-more"]') : null;
  if (nav && more) {
    const setOpen = (open) => {
      nav.classList.toggle('is-open', open);
      more.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    nav.addEventListener('click', (e) => {
      const el = e.target?.closest?.('[data-action], a');
      if (!el) return;
      if (el.dataset?.action === 'nav-more') setOpen(!nav.classList.contains('is-open'));
      else setOpen(false); // a link or the scrim
    });
    swipeToDismiss(nav.querySelector('.nav-sub-wrap'), { win: ctx.win, onDismiss: () => { setOpen(false); more.focus?.(); } });
    nav.addEventListener('keydown', (e) => {
      if ((e.key === 'Escape' || e.key === 'Esc') && nav.classList.contains('is-open')) {
        setOpen(false);
        more.focus();
      }
    });
  }

  const account = typeof root.querySelector === 'function' ? root.querySelector('[data-action="account"]') : null;
  account?.addEventListener('click', () => ctx.toggleAccount?.());
}
