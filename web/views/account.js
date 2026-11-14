// The account sheet: opened by the avatar in the top bar. Who you are, and the
// things about your account that used to crowd the top bar: notifications,
// your password, installing Flock, logging out.
//
// Rendered by web/app.js into #layer (a sibling of the page), so it covers the
// page and the tab bar. On a phone it is a bottom sheet; release 4 shows it as
// a small menu above the account button on wide screens.
import { html } from '../lib/html.js';
import { iconSlot } from '../lib/icons.js';
import { avatar } from '../lib/avatar.js';
import { isAdmin } from '../routes.js';
import { forLogout } from '../lib/push.js';

const chevron = () => iconSlot('chevron', 'icon-sm');

function row({ icon, label, sub = '', end = '', href = '', action = '', danger = false }) {
  const inner = html`${iconSlot(icon, 'menu-icon')}<span class="menu-text">${label}${sub ? html`<span class="menu-sub">${sub}</span>` : ''}</span>${danger ? '' : html`<span class="menu-end">${end}${chevron()}</span>`}`;
  return href
    ? html`<li><a class="menu-row" href="${href}">${inner}</a></li>`
    : html`<li><button type="button" class="menu-row${danger ? ' is-danger' : ''}" data-action="${action}">${inner}</button></li>`;
}

/**
 * The sheet's markup, or '' when it is closed. canInstall: show "Install
 * Flock". pop: wide screens, where it is a small menu above the account button.
 */
export function render(state, { canInstall = false, pop = false } = {}) {
  const user = state?.user;
  if (!user || !state.accountOpen) return '';
  const role = isAdmin(user) ? 'Scheduler' : 'Volunteer';
  const push = state.push;
  return String(html`<div class="sheet-layer is-entering${pop ? ' account-pop' : ''}" data-account-sheet>
  <div class="sheet-backdrop" data-action="account-close"></div>
  <section class="sheet account-sheet" data-account-panel role="dialog" aria-modal="true" aria-labelledby="account-name">
    <div class="sheet-grab" aria-hidden="true"></div>
    <div class="account-head">${avatar(user.name, 'lg')}
      <div class="account-text"><h2 class="account-name" id="account-name" tabindex="-1">${user.name}</h2><p class="account-sub">${role}${user.email ? html` · ${user.email}` : ''}</p></div>
      <button type="button" class="icon-btn" data-action="account-close" aria-label="Close">${iconSlot('x')}</button>
    </div>
    <ul class="menu sheet-menu">
      ${push?.enabled ? row({ icon: 'bell', label: 'Notifications', href: '#/notifications', end: push.status === 'on' ? 'On for this device' : 'Off' }) : ''}
      ${user.hasPassword === false ? '' : row({ icon: 'key', label: 'Change my password', href: '#/password' })}
      ${canInstall ? row({ icon: 'install', label: 'Install Flock', sub: 'Put it on your Home Screen', action: 'install' }) : ''}
      <li class="menu-sep" role="separator"></li>
      ${row({ icon: 'logout', label: 'Log out', action: 'logout', danger: true })}
    </ul>
  </section></div>`);
}

/** Log out on this device: stop its notifications, end the session, go to the login page. */
export async function logout(ctx, btn) {
  if (btn) btn.disabled = true;
  try {
    // This device stops getting notifications for whoever logs in next.
    const pushEndpoint = await forLogout(ctx.win);
    await ctx.api.post('/api/logout', pushEndpoint ? { pushEndpoint } : {});
  } catch (err) {
    // Already logged out is fine; anything else is shown.
    if (err.status !== 401) { if (btn) btn.disabled = false; ctx.showError(err.message); return; }
  }
  ctx.closeAccount?.({ focus: false });
  ctx.setUser(null);
  ctx.navigate('#/login');
}

/**
 * Wires the layer once (the sheet inside is painted again on each open).
 * A link row closes the sheet, then goes to its page (closing first takes the
 * sheet's Back step off, which would undo a link the browser followed itself).
 */
export function mount(layer, ctx) {
  layer.addEventListener('click', (e) => {
    const el = e.target?.closest?.('[data-action], a[href]');
    if (!el || !layer.querySelector?.('[data-account-sheet]')) return;
    const action = el.dataset?.action ?? el.getAttribute?.('data-action');
    if (action === 'account-close') ctx.closeAccount();
    else if (action === 'logout') return logout(ctx, el);
    else if (action === 'install') { ctx.closeAccount({ focus: false }); return ctx.install?.(); }
    else if (el.getAttribute?.('href')) { e.preventDefault?.(); ctx.closeAccount({ focus: false, to: el.getAttribute('href') }); }
    return undefined;
  });
}
