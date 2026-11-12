// Hand-drawn 24px line icons and a few small empty-state pictures, as SVG
// strings. Every one is aria-hidden and uses currentColor, so it takes the
// colour of the text around it. Nothing here is fetched: no files, no fonts.
//
// Views do not put SVG into their HTML themselves. They print a placeholder,
//   iconSlot('calendar')  ->  <span class="icon" data-icon="calendar" aria-hidden="true"></span>
// and the app fills every empty [data-icon] with the matching SVG
// (hydrateIcons / watchIcons). Unknown names stay empty. This keeps view
// output free of markup tags that the security tests look for, and keeps the
// SVG in one trusted place.
import { html } from './html.js';

// Drawn on a 24px grid with a 1.75 stroke and round ends. A part that must
// stay open when the icon is tinted (the current tab) carries fill="none".
const PATHS = {
  calendar: '<rect x="3.5" y="4.75" width="17" height="15.75" rx="3.5"/><path d="M3.5 9.75h17M8 2.75v3.5M16 2.75v3.5"/>',
  check: '<path d="M4.75 12.75l4.75 4.75 9.75-10.75"/>',
  x: '<path d="M6.25 6.25l11.5 11.5M17.75 6.25l-11.5 11.5"/>',
  clock: '<circle cx="12" cy="12" r="8.75"/><path d="M12 7.25V12l3.25 2" fill="none"/>',
  user: '<circle cx="12" cy="8" r="3.75"/><path d="M4.75 20.25c.9-3.9 3.7-6 7.25-6s6.35 2.1 7.25 6"/>',
  users: '<circle cx="9" cy="8.25" r="3.5"/><path d="M2.75 19.75c.7-3.5 3.1-5.5 6.25-5.5s5.55 2 6.25 5.5"/><path d="M15.6 4.95a3.5 3.5 0 0 1 0 6.6M17.75 14.6c1.85.8 3.05 2.5 3.5 5.15" fill="none"/>',
  plus: '<path d="M12 5.25v13.5M5.25 12h13.5"/>',
  search: '<circle cx="11" cy="11" r="6.75"/><path d="M16 16l4.25 4.25"/>',
  copy: '<rect x="8.75" y="8.75" width="11.75" height="11.75" rx="3"/><path d="M15.25 8.75V6.5a3 3 0 0 0-3-3H6.5a3 3 0 0 0-3 3v5.75a3 3 0 0 0 3 3h2.25" fill="none"/>',
  lock: '<rect x="4.75" y="10.25" width="14.5" height="10.25" rx="3"/><path d="M8.25 10.25V7.5a3.75 3.75 0 0 1 7.5 0v2.75" fill="none"/><path d="M12 14.4v2"/>',
  warning: '<path d="M10.45 4.4a1.8 1.8 0 0 1 3.1 0l7.2 12.6a1.8 1.8 0 0 1-1.55 2.7H4.8a1.8 1.8 0 0 1-1.55-2.7z"/><path d="M12 9.5v4.25M12 16.75v.01"/>',
  bell: '<path d="M12 3.5v1.25"/><path d="M6.75 10.9a5.25 5.25 0 0 1 10.5 0v2.6c0 1.9.5 3.4 1.5 4.75H5.25c1-1.35 1.5-2.85 1.5-4.75z"/><path d="M10 20.5a2.1 2.1 0 0 0 4 0" fill="none"/>',
  logout: '<path d="M9.75 19.5h-2.5a2.75 2.75 0 0 1-2.75-2.75v-9.5A2.75 2.75 0 0 1 7.25 4.5h2.5" fill="none"/><path d="M14.5 16.25L18.75 12 14.5 7.75M18.75 12H9.5" fill="none"/>',
  home: '<path d="M4 10.4l8-6.65 8 6.65v8.35a1.75 1.75 0 0 1-1.75 1.75H5.75A1.75 1.75 0 0 1 4 18.75z"/><path d="M9.75 20.5v-5A1.25 1.25 0 0 1 11 14.25h2a1.25 1.25 0 0 1 1.25 1.25v5" fill="none"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  mail: '<rect x="3.25" y="5.25" width="17.5" height="13.5" rx="3"/><path d="M4 7.75l6.8 5a2 2 0 0 0 2.4 0l6.8-5" fill="none"/>',
  trash: '<path d="M4.25 6.75h15.5M9.5 6.75V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5v1.25" fill="none"/><path d="M6.25 6.75l.8 11.4a2.5 2.5 0 0 0 2.5 2.35h4.9a2.5 2.5 0 0 0 2.5-2.35l.8-11.4"/><path d="M10 11v5.25M14 11v5.25"/>',
  edit: '<path d="M4.5 19.5l.9-4.1L15.9 4.9a2.05 2.05 0 0 1 2.9 0l.3.3a2.05 2.05 0 0 1 0 2.9L8.6 18.6z"/><path d="M13.75 7.05l3.2 3.2"/>',
  chevron: '<path d="M9.25 5.75L15.5 12l-6.25 6.25"/>',
  sparkle: '<path d="M11 3.75c.5 3.9 2.35 5.75 6.25 6.25-3.9.5-5.75 2.35-6.25 6.25-.5-3.9-2.35-5.75-6.25-6.25 3.9-.5 5.75-2.35 6.25-6.25z"/><path d="M18 15.5c.25 1.6.9 2.25 2.5 2.5-1.6.25-2.25.9-2.5 2.5-.25-1.6-.9-2.25-2.5-2.5 1.6-.25 2.25-.9 2.5-2.5z"/>',
  more: '<g fill="currentColor" fill-opacity="1" stroke="none"><circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/></g>',
  info: '<circle cx="12" cy="12" r="8.75"/><path d="M12 11.25v5M12 7.75v.01"/>',
  key: '<circle cx="8.25" cy="15.75" r="4.5"/><path d="M11.5 12.5l8.25-8.25M16.75 7.25l2.75 2.75M14 10l2 2" fill="none"/>',
  shield: '<path d="M12 3.25l7.25 2.6v5.4c0 4.5-2.9 7.9-7.25 9.5-4.35-1.6-7.25-5-7.25-9.5v-5.4z"/><path d="M8.75 12.1l2.3 2.3 4.2-4.4" fill="none"/>',
  'user-off': '<circle cx="9.5" cy="8" r="3.75"/><path d="M2.75 20.25c.9-3.7 3.4-5.75 6.75-5.75s5.85 2.05 6.75 5.75"/><path d="M17 8.5l4 4M21 8.5l-4 4"/>',
  'user-check': '<circle cx="9.5" cy="8" r="3.75"/><path d="M2.75 20.25c.9-3.7 3.4-5.75 6.75-5.75s5.85 2.05 6.75 5.75"/><path d="M16.25 10.6l1.9 1.9 3.35-3.75" fill="none"/>',
  'list-check': '<path d="M11 6.25h9.5M11 12h9.5M11 17.75h9.5"/><path d="M3.5 6.25l1.6 1.6 2.65-2.9M3.5 12l1.6 1.6 2.65-2.9M3.5 17.75l1.6 1.6 2.65-2.9" fill="none"/>',
  send: '<path d="M20.5 3.5L3.75 9.6l7 2.65 2.65 7z"/><path d="M20.5 3.5l-9.75 8.75" fill="none"/>',
  refresh: '<path d="M19.75 12a7.75 7.75 0 1 1-2.3-5.5" fill="none"/><path d="M19.75 4.25v4h-4" fill="none"/>',
  filter: '<path d="M4 5.25h16l-6.25 7.5v5.5l-3.5 1.75v-7.25z"/>',
  dot: '<circle cx="12" cy="12" r="4.5" fill="currentColor" fill-opacity="1" stroke="none"/>',
  // Main menu pictures.
  'calendar-off': '<rect x="3.5" y="4.75" width="17" height="15.75" rx="3.5"/><path d="M3.5 9.75h17M8 2.75v3.5M16 2.75v3.5M9.75 12.9l4.5 4.5M14.25 12.9l-4.5 4.5"/>',
  team: '<circle cx="12" cy="8" r="3.25"/><path d="M6.5 19.75c.55-3.3 2.6-5.25 5.5-5.25s4.95 1.95 5.5 5.25"/><circle cx="4.9" cy="9.6" r="2.15" fill="none"/><circle cx="19.1" cy="9.6" r="2.15" fill="none"/><path d="M1.6 17.9c.3-1.9 1.3-3.1 3-3.5M22.4 17.9c-.3-1.9-1.3-3.1-3-3.5" fill="none"/>',
  church: '<path d="M12 2.75v4M10.4 4.35h3.2"/><path d="M7.25 20.5v-9.1L12 6.9l4.75 4.5v9.1"/><path d="M7.25 14.25L3.5 16.4v4.1h17v-4.1l-3.75-2.15" fill="none"/><path d="M10.25 20.5v-3a1.75 1.75 0 0 1 3.5 0v3" fill="none"/>',
  puzzle: '<path d="M6.15 8.1H8.6a2.3 2.3 0 1 1 2.6 0h2.45a2.25 2.25 0 0 1 2.25 2.25v2.45a2.3 2.3 0 1 1 0 2.6v2.45a2.25 2.25 0 0 1-2.25 2.25H6.15a2.25 2.25 0 0 1-2.25-2.25V15.4a2.3 2.3 0 1 0 0-2.6v-2.45A2.25 2.25 0 0 1 6.15 8.1z"/>',
  // The Flock mark: one bird, wings up. The same shape as the app icon.
  flock: '<path d="M12 19C9.8 13.8 6.4 9.8 1.8 7.2c5.3-1.5 8.8.7 10.2 4.3 1.4-3.6 4.9-5.8 10.2-4.3C17.6 9.8 14.2 13.8 12 19z" fill="currentColor" fill-opacity="1" stroke="none"/>',
  // Sign-in provider marks, named by provider id (src/infra/oidc.js). Brand colours, not currentColor.
  google: '<g stroke="none"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.31v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.43.34-2.1V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.93z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A10.6 10.6 0 0 0 12 1 11 11 0 0 0 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/></g>',
};

// Empty-state pictures: 120 x 96, soft shapes in theme colours (classes in style.css).
const ART = {
  'art-calendar': '<ellipse class="art-bg" cx="60" cy="50" rx="52" ry="40"/><rect class="art-card" x="31" y="23" width="58" height="54" rx="11"/><path class="art-line" d="M31 39.5h58M46 16.5v11M74 16.5v11"/><circle class="art-soft" cx="46" cy="52" r="3.5"/><circle class="art-soft" cx="60" cy="52" r="3.5"/><circle class="art-soft" cx="74" cy="52" r="3.5"/><circle class="art-soft" cx="46" cy="64.5" r="3.5"/><circle class="art-soft" cx="60" cy="64.5" r="3.5"/><circle class="art-pop" cx="87" cy="73" r="13"/><path class="art-check" d="M81.2 73.3l4 4 7.6-8.2"/>',
  'art-people': '<ellipse class="art-bg" cx="60" cy="50" rx="52" ry="40"/><circle class="art-card" cx="36" cy="50" r="15"/><circle class="art-card" cx="84" cy="50" r="15"/><circle class="art-pop" cx="60" cy="47" r="19"/><circle class="art-check" cx="60" cy="42" r="5.5"/><path class="art-check" d="M49.5 57.5c1.8-4.8 5.4-7.2 10.5-7.2s8.7 2.4 10.5 7.2"/><circle class="art-soft" cx="36" cy="46.5" r="4.5"/><path class="art-soft" d="M27.5 57.5c1.5-3.6 4.3-5.4 8.5-5.4 2 0 3.7.4 5 1.2-1.6 3.8-1.7 6.7-.4 8.7-1.5 1-3 1.5-4.6 1.5-3.7 0-6.7-2.4-8.5-6z"/><circle class="art-soft" cx="84" cy="46.5" r="4.5"/><path class="art-soft" d="M92.5 57.5c-1.5-3.6-4.3-5.4-8.5-5.4-2 0-3.7.4-5 1.2 1.6 3.8 1.7 6.7.4 8.7 1.5 1 3 1.5 4.6 1.5 3.7 0 6.7-2.4 8.5-6z"/>',
  'art-done': '<ellipse class="art-bg" cx="60" cy="50" rx="52" ry="40"/><circle class="art-pop" cx="60" cy="48" r="23"/><path class="art-check" d="M49.5 48.8l7 7 13.5-14.6"/><circle class="art-soft" cx="22" cy="30" r="4"/><circle class="art-soft" cx="99" cy="68" r="5"/><path class="art-line" d="M95 22v8M91 26h8M24 66v6M21 69h6"/>',
  'art-lost': '<ellipse class="art-bg" cx="60" cy="50" rx="52" ry="40"/><circle class="art-card" cx="55" cy="45" r="20"/><path class="art-line" d="M69.5 59.5l15 15"/><path class="art-line" d="M49.5 40c1-3.3 3.2-5 6-5 3.3 0 6 2.2 6 5.5 0 4.4-6 5-6 9M55.5 55v.01"/><circle class="art-soft" cx="96" cy="28" r="4.5"/><circle class="art-soft" cx="22" cy="66" r="3.5"/>',
};

const ICON_ATTRS = 'viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const ART_ATTRS = 'viewBox="0 0 120 96" width="120" height="96" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

export const ICON_NAMES = Object.freeze(Object.keys(PATHS));
export const ART_NAMES = Object.freeze(Object.keys(ART));

/** The SVG string for an icon or picture, or '' for an unknown name. */
export function icon(name) {
  if (Object.hasOwn(PATHS, name)) return `<svg class="icon-svg" ${ICON_ATTRS}>${PATHS[name]}</svg>`;
  if (Object.hasOwn(ART, name)) return `<svg class="art-svg" ${ART_ATTRS}>${ART[name]}</svg>`;
  return '';
}

/** A placeholder the app fills with the icon. `cls` adds classes (e.g. 'icon-lg'). */
export function iconSlot(name, cls = '') {
  return html`<span class="icon${cls ? ` ${cls}` : ''}" data-icon="${name}" aria-hidden="true"></span>`;
}

/** Fill every empty [data-icon] inside root (needs a real DOM; does nothing otherwise). */
export function hydrateIcons(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  let n = 0;
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.firstChild) continue;
    const svg = icon(el.getAttribute('data-icon'));
    if (svg) { el.innerHTML = svg; n++; }
  }
  return n;
}

/** Keep icons filled in as views repaint. Returns a stop() function. */
export function watchIcons(root, win = globalThis) {
  hydrateIcons(root);
  const MO = win && win.MutationObserver;
  if (!MO || !root) return () => {};
  const mo = new MO(() => hydrateIcons(root));
  mo.observe(root, { childList: true, subtree: true });
  return () => mo.disconnect();
}
