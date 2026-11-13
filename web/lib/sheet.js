// Bottom sheet (phones) / side panel (wide screens) behaviour. Made for the
// slot panel (markup from slotpanel.js) and used by every other sheet (the
// account sheet, ...), which pass their own `panel` and `opener`. It adds the
// keyboard and focus rules:
//  - when it opens, focus moves to its heading;
//  - Escape closes it (so does tapping the backdrop: data-action="slot-close");
//  - Tab and Shift+Tab stay inside it while it is open (it is aria-modal);
//  - when it closes, focus goes back to the button that opened it.
// Works with a real DOM, and degrades quietly with the test fakes.

const SLOT_PANEL = '[data-slot-panel]';

/** Wide screens show a sheet in a pane beside its list; anything narrower, as a layer. */
export const WIDE = '(min-width: 1024px)';
export function host(win) {
  try { return win?.matchMedia?.(WIDE)?.matches ? 'pane' : 'layer'; } catch { return 'layer'; }
}

/**
 * Calls fn when the window crosses the wide-screen width. Returns a function
 * that stops listening (call it when the screen goes away).
 */
export function watchHost(win, fn) {
  let mql = null;
  try { mql = win?.matchMedia?.(WIDE) ?? null; } catch { mql = null; }
  if (typeof mql?.addEventListener !== 'function') return () => {};
  mql.addEventListener('change', fn);
  return () => mql.removeEventListener?.('change', fn);
}
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const canFocus = (el) => !!el && typeof el.focus === 'function';

function visible(el) {
  if (!el) return false;
  if (typeof el.getClientRects !== 'function') return true;
  return el.getClientRects().length > 0;
}

// The first visible match (the schedule has the same button in the grid and in the cards).
function pick(root, selector) {
  if (typeof root?.querySelectorAll === 'function') {
    const all = [...root.querySelectorAll(selector)];
    return all.find(visible) ?? all[0] ?? null;
  }
  return typeof root?.querySelector === 'function' ? root.querySelector(selector) : null;
}

/**
 * root: the element the sheet is painted in. isOpen(): is the panel showing.
 * close(): close it. panel: selector of the dialog section. opener(id): the
 * selector of the button to focus again after closing; openerRoot: where that
 * button lives (if not inside root). Call opened(id) when the sheet opens,
 * before() just before every paint and update() just after it.
 */
export function createSheet({
  root, isOpen, close, panel: PANEL = SLOT_PANEL,
  opener = (id) => `[data-action="slot-open"][data-id="${id}"]`, openerRoot = root,
  modal = () => true, // false while it shows in a pane: then Tab may leave it
}) {
  let openerId = null;
  let wasOpen = false;
  let keep = null; // the control inside the panel that had focus before a repaint

  // Call just before root.innerHTML is replaced.
  function before() {
    keep = null;
    if (!wasOpen) return;
    const panel = pick(root, PANEL);
    const active = panel?.ownerDocument?.activeElement;
    if (!active || typeof panel.contains !== 'function' || !panel.contains(active)) return;
    const action = active.getAttribute?.('data-action');
    const id = active.getAttribute?.('data-id');
    if (action) keep = `${PANEL} [data-action="${action}"]${id ? `[data-id="${id}"]` : ''}`;
    else keep = `${PANEL} h2`;
  }

  function update() {
    const open = !!isOpen();
    if (open && !wasOpen) {
      const h = pick(root, `${PANEL} h2`);
      if (canFocus(h)) h.focus();
    } else if (open && keep) {
      // A repaint replaced the panel: put focus back on the same control (or the heading).
      const el = pick(root, keep) ?? pick(root, `${PANEL} h2`);
      if (canFocus(el)) el.focus();
    } else if (!open && wasOpen && openerId !== null) {
      const back = pick(openerRoot, opener(openerId));
      if (canFocus(back)) back.focus();
      openerId = null;
    }
    wasOpen = open;
    keep = null;
  }

  function trapTab(e) {
    const panel = pick(root, PANEL);
    if (!panel || typeof panel.querySelectorAll !== 'function') return;
    const items = [...panel.querySelectorAll(FOCUSABLE)].filter(visible);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = panel.ownerDocument?.activeElement;
    const inside = typeof panel.contains === 'function' && panel.contains(active);
    if (e.shiftKey && (active === first || !inside)) { e.preventDefault?.(); last.focus(); }
    else if (!e.shiftKey && (active === last || !inside)) { e.preventDefault?.(); first.focus(); }
  }

  root.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault?.();
      close();
    } else if (e.key === 'Tab' && modal()) {
      trapTab(e);
    }
  });

  return {
    opened(id) { openerId = id; },
    before,
    update,
    get openerId() { return openerId; },
  };
}
