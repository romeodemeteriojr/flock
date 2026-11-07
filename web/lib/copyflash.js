// "Copied" confirmation for copy buttons: the button shows a check for 1.5s,
// then goes back to the copy icon. The icons are inline SVG (icon()), so we
// swap the button's innerHTML, not a data-icon attribute.
import { icon } from './icons.js';
import { esc } from './html.js';

export const COPY_FLASH_MS = 1500;

/** Inner HTML of a copy button: the check (done) or copy icon, then the label. */
export function copyInner(label, done) {
  return `${icon(done ? 'check' : 'copy')} ${esc(label)}`;
}

/**
 * Show the check on the clicked button, and put the copy icon back after 1.5s.
 * `hold` is per-screen state: { timer, key }. Each click restarts the timer.
 * Notices repaint the screen and replace the clicked node, so the
 * timer also repaints whatever live button carries the same data-copy-key.
 */
export function flashCopied(win, root, target, label, hold, key) {
  const btn = target?.closest?.('button') ?? target;
  const clear = win?.clearTimeout ?? globalThis.clearTimeout;
  const set = win?.setTimeout ?? globalThis.setTimeout;
  if (hold.timer) clear(hold.timer);
  hold.key = key;
  const live = () => {
    const el = typeof root?.querySelector === 'function' ? root.querySelector(`[data-copy-key="${key}"]`) : null;
    return el && el !== btn ? el : null;
  };
  const paint = (done) => {
    if (btn) btn.innerHTML = copyInner(label, done);
    const l = live();
    if (l && typeof l.innerHTML === 'string' && l.dataset !== undefined) l.innerHTML = copyInner(label, done);
  };
  paint(true);
  hold.timer = set(() => {
    hold.timer = null;
    hold.key = null;
    paint(false);
  }, COPY_FLASH_MS);
}
