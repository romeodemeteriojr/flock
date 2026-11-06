// A round badge with someone's initials. The colour is one of 12 palette
// classes (avatar-0 .. avatar-11 in style.css), picked by a stable hash of the
// name, so the same person always gets the same colour. No inline styles.
// The badge is decoration (the name is always written next to it), so it is
// hidden from screen readers.
import { html } from './html.js';

export const AVATAR_COLOURS = 12;

/** FNV-1a hash of the trimmed, lower-cased name -> 0..11. */
export function avatarIndex(name) {
  const s = String(name ?? '').trim().toLowerCase();
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % AVATAR_COLOURS;
}

/** 'Sam Ortiz' -> 'SO', 'cher' -> 'C', '' -> '?'. Letters and digits only. */
export function initials(name) {
  const words = String(name ?? '').split(/\s+/)
    .map((w) => [...w].find((c) => /[\p{L}\p{N}]/u.test(c)))
    .filter(Boolean);
  if (!words.length) return '?';
  const pick = words.length === 1 ? [words[0]] : [words[0], words[words.length - 1]];
  return pick.join('').toUpperCase();
}

/** The badge. size: '' | 'sm' | 'lg'. */
export function avatar(name, size = '') {
  const cls = `avatar avatar-${avatarIndex(name)}${size ? ` avatar-${size === 'lg' ? 'lg' : 'sm'}` : ''}`;
  return html`<span class="${cls}" aria-hidden="true">${initials(name)}</span>`;
}
