// Small shared pieces of page markup: loading skeletons and friendly empty states.
import { html } from './html.js';
import { iconSlot } from './icons.js';

/**
 * Shimmering grey placeholders while a page loads. The words stay in the page
 * for screen readers (and for anyone with images and motion turned off).
 * shape: 'cards' (default), 'list' or 'rows'.
 */
export function skeleton(label = 'Loading…', shape = 'cards', count = 3) {
  const n = Math.max(1, Math.min(6, Number(count) || 3));
  const one = shape === 'list'
    ? html`<span class="skeleton-row"><span class="skeleton-dot"></span><span class="skeleton-lines"><span class="skeleton-bar"></span><span class="skeleton-bar skeleton-bar-short"></span></span></span>`
    : shape === 'rows'
      ? html`<span class="skeleton-bar"></span>`
      : html`<span class="skeleton-card"><span class="skeleton-bar skeleton-bar-title"></span><span class="skeleton-bar"></span><span class="skeleton-bar skeleton-bar-short"></span></span>`;
  return html`<div class="skeleton skeleton-${shape === 'list' || shape === 'rows' ? shape : 'cards'}" role="status">
    <span class="loading visually-hidden">${label}</span>${Array.from({ length: n }, () => one)}
  </div>`;
}

/** A friendly empty state: a small picture, the words, and optional extra HTML. */
export function emptyState(text, art = 'art-calendar', extra = '') {
  return html`<div class="empty-state">${iconSlot(art, 'empty-art')}<p class="empty">${text}</p>${extra}</div>`;
}

/**
 * A show/hide button (the WAI-ARIA disclosure pattern): a collapsible part of a
 * page, or a list row that shows its actions when tapped. The view remembers
 * what is open (so it stays open when the view repaints) and draws the part
 * only while it is open. label may be html`...`.
 */
export function disclosure({ action, id, open, label, cls = '' }) {
  return html`<button type="button" class="disclosure${cls ? ` ${cls}` : ''}" data-action="${action}" data-id="${id}" aria-expanded="${open ? 'true' : 'false'}"><span class="disclosure-text">${label}</span>${iconSlot('chevron', 'disclosure-icon')}</button>`;
}

/** After a repaint, put focus back on the show/hide button just used, so a keyboard user keeps their place. */
export function refocus(root, action, id) {
  root?.querySelector?.(`[data-action="${action}"][data-id="${id}"]`)?.focus?.();
}

/** A page heading block: the h1 (focused on navigation) and an optional line under it. */
export function pageHead(title, lead = '') {
  return html`<div class="page-head"><h1 tabindex="-1">${title}</h1>${lead ? html`<p class="page-lead">${lead}</p>` : ''}</div>`;
}
