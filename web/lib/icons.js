// Hand-drawn 24px stroke icons and a few small empty-state pictures, as SVG
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

const PATHS = {
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.2-4 4-6 7.5-6s6.3 2 7.5 6"/>',
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20c.9-3.5 3.3-5.5 6.5-5.5s5.6 2 6.5 5.5"/><path d="M15.5 5.2a3.5 3.5 0 0 1 0 6.6M17.5 14.8c2 .7 3.3 2.4 4 5.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  warning: '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.5v.01"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 21h4"/>',
  logout: '<path d="M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14"/><path d="M10 16.5L5.5 12 10 7.5M5.5 12H15"/>',
  home: '<path d="M3.5 11L12 4l8.5 7"/><path d="M6 9.5v10h12v-10"/><path d="M10 19.5v-5h4v5"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3.5 7l8.5 6 8.5-6"/>',
  trash: '<path d="M4 6.5h16M9.5 6.5V4.5h5v2"/><path d="M6.5 6.5l1 13.5h9l1-13.5"/><path d="M10 10.5v6M14 10.5v6"/>',
  edit: '<path d="M4 20l1-4.5L15.5 5a2.1 2.1 0 0 1 3 3L8 18.5z"/><path d="M13.5 7l3 3"/>',
  chevron: '<path d="M9 5.5l6.5 6.5L9 18.5"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.5v.01"/>',
  key: '<circle cx="8" cy="16" r="4.5"/><path d="M11 13L20 4M17 7l3 3M14.5 9.5l2 2"/>',
  shield: '<path d="M12 3.5l7.5 2.8v5.4c0 4.6-3 8-7.5 9.3-4.5-1.3-7.5-4.7-7.5-9.3V6.3z"/><path d="M8.5 12l2.5 2.5 4.5-4.5"/>',
  'user-off': '<circle cx="10" cy="8" r="4"/><path d="M3.5 20.5c1.1-3.6 3.4-5.5 6.5-5.5M12 20.5c-.3-1.6-1-2.9-2-3.9"/><path d="M5 5l14 14"/>',
  'user-check': '<circle cx="9.5" cy="8" r="4"/><path d="M3 20.5c1.1-3.6 3.4-5.5 6.5-5.5 1.2 0 2.3.3 3.2.8"/><path d="M14.5 17l2.3 2.3 4.7-4.8"/>',
  'list-check': '<path d="M10.5 6h10M10.5 12h10M10.5 18h10"/><path d="M3.5 6l1.7 1.7L8 4.9M3.5 12l1.7 1.7L8 10.9M3.5 18l1.7 1.7L8 16.9"/>',
  send: '<path d="M20.5 3.5L11 13"/><path d="M20.5 3.5L14 20.5l-3-7.5-7.5-3z"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/>',
  filter: '<path d="M3.5 5h17l-6.5 8v6l-4 2v-8z"/>',
  dot: '<circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none"/>',
  // The Flock mark: a flock of birds flying in a V, which is also the roof line of a church.
  flock: '<path d="M9.7 8.6L12 7l2.3 1.6M5.7 13.1L8 11.5l2.3 1.6M13.7 13.1L16 11.5l2.3 1.6M1.7 17.6L4 16l2.3 1.6M17.7 17.6L20 16l2.3 1.6"/>',
  // Sign-in provider marks, named by provider id (src/infra/oidc.js). Brand colours, not currentColor.
  google: '<g stroke="none"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.31v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.43.34-2.1V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.93z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A10.6 10.6 0 0 0 12 1 11 11 0 0 0 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/></g>',
};

// Empty-state pictures: 120 x 96, soft shapes in theme colours (classes in style.css).
const ART = {
  'art-calendar': '<rect class="art-bg" x="18" y="14" width="84" height="72" rx="14"/><rect class="art-card" x="26" y="26" width="68" height="52" rx="9"/><path class="art-line" d="M26 40h68M44 18v14M76 18v14"/><circle class="art-accent" cx="60" cy="59" r="9"/><path class="art-check" d="M55.5 59l3.2 3.2 6-6.4"/>',
  'art-people': '<circle class="art-bg" cx="60" cy="50" r="40"/><circle class="art-card" cx="46" cy="44" r="11"/><circle class="art-card" cx="76" cy="46" r="9"/><path class="art-card" d="M26 78c3-12 11-18 20-18s17 6 20 18z"/><path class="art-card" d="M62 78c2.5-10 8-15 14-15s12 5 14 15z"/><circle class="art-accent" cx="92" cy="24" r="6"/>',
  'art-done': '<circle class="art-bg" cx="60" cy="48" r="40"/><circle class="art-accent" cx="60" cy="48" r="20"/><path class="art-check" d="M50.5 48.5l6.5 6.5 12.5-13"/><circle class="art-card" cx="24" cy="22" r="5"/><circle class="art-card" cx="98" cy="74" r="6"/>',
  'art-lost': '<circle class="art-bg" cx="60" cy="48" r="40"/><circle class="art-card" cx="54" cy="44" r="18"/><path class="art-line" d="M67 57l16 16"/><path class="art-line" d="M49 39.5c1-3 3-4.5 5.5-4.5 3 0 5.5 2 5.5 5 0 4-5.5 4.5-5.5 8M54.5 53v.01"/>',
};

const ICON_ATTRS = 'viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
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
