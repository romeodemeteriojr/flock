// Top bar and main menu. Members see their own pages; admins also see the
// scheduling pages. One menu serves both screen sizes (style.css):
//  - phones: a bottom tab bar with icons (members: My schedule, Days off;
//    admins: Schedule, Gaps, People, More; "More" opens the other pages);
//  - wide screens: a row of tabs under the top bar, every page in a line.
// The current page has aria-current="page" (exactly one link).
import { html } from '../lib/html.js';
import { navRoutes, pathOf, isAdmin } from '../routes.js';
import { iconSlot } from '../lib/icons.js';
import { avatar } from '../lib/avatar.js';
import { forLogout } from '../lib/push.js';

const ICONS = {
  '/': 'home', '/blockouts': 'calendar', '/people': 'users', '/teams': 'sparkle',
  '/services': 'clock', '/schedule': 'grid', '/gaps': 'warning',
};
const SHORT = { '/blockouts': 'Days off' };
// The admin's tabs on a phone, in this order; the rest go under "More".
export const ADMIN_TABS = Object.freeze(['/schedule', '/gaps', '/people']);

function link(r, current) {
  return html`<li class="nav-item"><a href="#${r.path}" ${r.path === current ? html`aria-current="page"` : ''}>${iconSlot(ICONS[r.path] ?? 'chevron', 'nav-icon')}<span class="nav-label">${r.label}</span>${SHORT[r.path] ? html`<span class="nav-label-short">${SHORT[r.path]}</span>` : ''}</a></li>`;
}

// The bell (decision 0008): opens the Notifications page; says whether they are on here.
function bell(push) {
  const label = push.status === 'on' ? 'Notifications (on for this device)' : 'Notifications';
  return html`<a class="icon-btn${push.status === 'on' ? ' is-on' : ''}" href="#/notifications" aria-label="${label}" title="${label}">${iconSlot('bell')}</a>`;
}

export function render(state, hash = '') {
  const user = state?.user;
  if (!user) return '';
  const current = pathOf(hash);
  const all = navRoutes(user);
  const admin = isAdmin(user);
  const main = admin ? ADMIN_TABS.map((p) => all.find((r) => r.path === p)).filter(Boolean) : all;
  const extra = admin ? all.filter((r) => !ADMIN_TABS.includes(r.path)) : [];
  const extraCurrent = extra.some((r) => r.path === current);
  const menu = all.length ? html`
    <nav class="nav${admin ? ' nav-admin' : ''}" aria-label="Main menu">
      <ul class="nav-list">
        ${main.map((r) => link(r, current))}
        ${extra.length ? html`<li class="nav-item nav-more-item">
          <button type="button" class="nav-more${extraCurrent ? ' has-current' : ''}" data-action="nav-more" aria-expanded="false" aria-controls="nav-more-menu">${iconSlot('more', 'nav-icon')}<span class="nav-label-short">More</span>${extraCurrent ? html`<span class="visually-hidden"> (the page you are on is in here)</span>` : ''}</button>
        </li>
        <li class="nav-item nav-sub-wrap"><ul class="nav-sub" id="nav-more-menu">${extra.map((r) => link(r, current))}</ul></li>` : ''}
      </ul>
      ${extra.length ? html`<div class="nav-scrim" data-action="nav-close"></div>` : ''}
    </nav>` : '';
  return String(html`
    <div class="topbar">
      <a class="brand" href="#/">${iconSlot('flock', 'brand-mark')}<span class="brand-name">Flock</span></a>
      <div class="nav-user">
        ${avatar(user.name, 'sm')}
        <p class="nav-who">Logged in as <strong>${user.name}</strong></p>
        ${state.push?.enabled ? bell(state.push) : ''}
        ${user.hasPassword === false ? '' : html`<a class="icon-btn" href="#/password" aria-label="Change my password" title="Change my password">${iconSlot('key')}</a>`}
        <button type="button" class="btn btn-ghost nav-logout" data-action="logout">${iconSlot('logout')}<span class="nav-logout-label">Log out</span></button>
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
    nav.addEventListener('keydown', (e) => {
      if ((e.key === 'Escape' || e.key === 'Esc') && nav.classList.contains('is-open')) {
        setOpen(false);
        more.focus();
      }
    });
  }

  const btn = root.querySelector('[data-action="logout"]');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      // This device stops getting notifications for whoever logs in next.
      const pushEndpoint = await forLogout(ctx.win);
      await ctx.api.post('/api/logout', pushEndpoint ? { pushEndpoint } : {});
    } catch (err) {
      // Already logged out is fine; anything else is shown.
      if (err.status !== 401) { btn.disabled = false; ctx.showError(err.message); return; }
    }
    ctx.setUser(null);
    ctx.navigate('#/login');
  });
}
