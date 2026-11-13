// Polite toast messages for "done" and "problem" news.
//
// Two ways to show one:
//  - Inside a view's HTML: toasts([[text, 'ok', 'data-note'], [error, 'error']]).
//    The stack floats above the tab bar. CSS fades a success toast out on its
//    own after 5 seconds (even with reduced motion); a problem toast inside a
//    view stays until the page changes, so nobody loses an error mid-form.
//  - From the app shell: createToaster(region).show(text, kind). The region is
//    an aria-live="polite" element that stays on the page, so screen readers
//    hear every new message; each toast removes itself after a timeout and has
//    a close button.
// Errors use role="alert" so they are read out straight away.
import { html, raw } from './html.js';
import { iconSlot } from './icons.js';

export const OK_MS = 5000;
export const ERROR_MS = 9000;

const KINDS = {
  ok: { cls: 'toast-ok', icon: 'check', role: 'status', word: 'Done' },
  error: { cls: 'toast-error', icon: 'warning', role: 'alert', word: 'Problem' },
};
const kindOf = (k) => KINDS[k] ?? KINDS.ok;

// Only simple data-* marks are allowed as the extra attribute.
const markOf = (mark) => (/^data-[a-z-]+$/.test(String(mark ?? '')) ? ` ${mark}` : '');

function body(text, k) {
  return html`${iconSlot(k.icon, 'toast-icon')}<p class="toast-text"><span class="visually-hidden">${k.word}: </span>${text}</p>`;
}

/** One toast as HTML. kind: 'ok' | 'error'. mark: an optional data-* attribute name. */
export function toast(text, kind = 'ok', mark = '') {
  const k = kindOf(kind);
  const live = k.role === 'status' ? ' aria-live="polite"' : '';
  return html`<div class="toast ${k.cls}" role="${k.role}"${raw(live)}${raw(markOf(mark))}>${body(text, k)}</div>`;
}

/** A floating stack of toasts. Entries: [text, kind, mark]; empty texts are skipped. */
export function toasts(entries) {
  const list = (entries ?? []).filter((e) => e && e[0]);
  if (!list.length) return '';
  return html`<div class="toast-stack">${list.map(([text, kind, mark]) => toast(text, kind, mark))}</div>`;
}

/** The region the app shell puts on the page once. */
export const TOAST_REGION = '<div class="toast-region" id="message" aria-live="polite" aria-relevant="additions"></div>';

/**
 * Show toasts in a live region (a real DOM element). Returns { show, clear, items }.
 * win supplies setTimeout/clearTimeout (a fake one in tests).
 */
export function createToaster(region, { win = globalThis, okMs = OK_MS, errorMs = ERROR_MS } = {}) {
  const doc = region.ownerDocument;
  const items = [];

  function remove(item) {
    const i = items.indexOf(item);
    if (i < 0) return;
    items.splice(i, 1);
    if (item.timer) win.clearTimeout(item.timer);
    item.el.remove?.();
  }

  function show(text, kind = 'ok') {
    const k = kindOf(kind);
    const same = items.find((x) => x.text === text && x.kind === kind);
    if (same) { // the same message twice is shown once, for the full time again
      win.clearTimeout(same.timer);
      same.timer = win.setTimeout(() => remove(same), kind === 'error' ? errorMs : okMs);
      return same;
    }
    const el = doc.createElement('div');
    el.className = `toast ${k.cls}`;
    el.setAttribute('role', k.role);
    el.innerHTML = String(html`${body(text, k)}<button type="button" class="toast-close" data-action="toast-close" aria-label="Close message">${iconSlot('x')}</button>`);
    const item = { el, text, kind, timer: null };
    el.addEventListener?.('click', (e) => {
      if (e.target?.closest?.('[data-action="toast-close"]')) remove(item);
    });
    region.appendChild(el);
    items.push(item);
    item.timer = win.setTimeout(() => remove(item), kind === 'error' ? errorMs : okMs);
    return item;
  }

  function clear() { for (const item of [...items]) remove(item); }

  return { show, clear, items };
}

/**
 * Keeps a view's success toast from coming back on every repaint. A view sets
 * its notice once, then repaints often (innerHTML), which would restart the CSS
 * fade each time. Before rendering, keep(notice) gives the notice to show, or ''
 * once it has faded; after rendering, resume(root) carries the fade on from
 * where it was instead of starting it again.
 */
export function createNoticeClock({ now = () => Date.now(), okMs = OK_MS } = {}) {
  let text = '';
  let at = 0;
  return {
    keep(notice) {
      if (!notice) { text = ''; return ''; }
      if (notice !== text) { text = notice; at = now(); }
      return now() - at >= okMs + 500 ? '' : notice;
    },
    resume(root) {
      if (!text) return;
      const age = now() - at;
      if (age < 50) return;
      for (const el of root.querySelectorAll?.('.toast-stack .toast-ok') ?? []) {
        if (el.style) el.style.animationDelay = `-${age}ms, ${okMs - age}ms`;
      }
    },
  };
}

/** Takes a view's problem toast away (the person is fixing it). */
export function dropProblem(root) {
  for (const el of root.querySelectorAll?.('.toast-stack .toast-error') ?? []) {
    const stack = el.parentNode;
    el.remove?.();
    if (stack && !stack.children?.length) stack.remove?.();
  }
}
