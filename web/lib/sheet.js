// Bottom sheet (phones) / side panel (wide screens) behaviour. Made for the
// slot panel (markup from slotpanel.js) and used by every other sheet (the
// account sheet, ...), which pass their own `panel` and `opener`. It adds the
// keyboard and focus rules:
//  - when it opens, focus moves to its heading;
//  - Escape closes it (so does tapping the backdrop: data-action="slot-close");
//  - Tab and Shift+Tab stay inside it while it is open (it is aria-modal);
//  - when it closes, focus goes back to the button that opened it;
//  - the phone's Back button (or back swipe) closes it instead of leaving the page.
// Works with a real DOM, and degrades quietly with the test fakes.

const SLOT_PANEL = '[data-slot-panel]';

/** closed(HAND_OFF): the next sheet opens straight away and takes over this one's Back step. */
export const HAND_OFF = Symbol('hand off');
let handedOff = null; // the mark of a Back step left for the next sheet

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
  win = root?.ownerDocument?.defaultView,
}) {
  let openerId = null;
  const back = backStep(win, root, isOpen, close);
  let wasOpen = false;
  let keep = null; // the control inside the panel that had focus before a repaint
  let leaveTo = null; // a link tapped in the sheet: where to go once it closes

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
    if (open && !wasOpen) back.opened();
    else if (!open && wasOpen) back.closed(leaveTo);
    leaveTo = null;
    if (open && !wasOpen) {
      const h = pick(root, `${PANEL} h2`);
      if (canFocus(h)) h.focus();
    } else if (open && keep) {
      // A repaint replaced the panel: put focus back on the same control (or the heading).
      const el = pick(root, keep) ?? pick(root, `${PANEL} h2`);
      if (canFocus(el)) el.focus();
    } else if (!open && wasOpen && openerId !== null) {
      const btn = pick(openerRoot, opener(openerId));
      if (canFocus(btn)) btn.focus();
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
    /** A link in the sheet was tapped: once the sheet closes, go there (call before the paint that closes it). */
    goTo(href) { leaveTo = href; },
    /** Another sheet opens in its place: leave it this sheet's Back step (call before the paint that closes it). */
    handOff() { leaveTo = HAND_OFF; },
    before,
    update,
    get openerId() { return openerId; },
  };
}

/**
 * Back closes an open sheet. Opening adds a history step at the same address;
 * Back takes it off again and we close the sheet. Closing the sheet any other
 * way takes our step off, so the next Back leaves the page as usual.
 * closed(HAND_OFF): another sheet opens in its place (Install Flock in the
 * account sheet). Our step is left for it: stepping back here would land after
 * the new sheet opened and close it again.
 * closed(to): closed by a link to another page. Our step becomes that page
 * (location.replace), so Back from there returns to the page under the sheet.
 * Stepping back and then following the link would lose the link: the step
 * back lands after it and undoes it.
 */
export function backStep(win, root, isOpen, close) {
  const h = win?.history;
  const follow = (to) => { if (typeof to === 'string' && win?.location) win.location.hash = to; };
  if (typeof h?.pushState !== 'function' || typeof win.addEventListener !== 'function') return { opened() {}, closed: follow };
  const mark = `sheet-${Math.random().toString(36).slice(2)}`;
  let pushed = false; // our step is in the history
  let skip = false; // the popstate after our own history.back()
  win.addEventListener('popstate', () => {
    if (skip) { skip = false; return; }
    if (!pushed) return;
    pushed = false;
    if (isOpen()) close();
  });
  // A new page: our step (if any) now belongs to the page we left. Forget it,
  // so a later Back never closes a sheet of a page that is gone.
  win.addEventListener('hashchange', () => { pushed = false; skip = false; handedOff = null; });
  return {
    opened() {
      if (pushed) return;
      const mine = handedOff !== null && h.state?.flockSheet === handedOff;
      handedOff = null;
      if (mine) {
        try { h.replaceState({ ...h.state, flockSheet: mark }, '', win.location?.href); pushed = true; return; } catch { /* push one instead */ }
      }
      try { h.pushState({ ...(h.state ?? {}), flockSheet: mark }, '', win.location?.href); pushed = true; } catch { /* no history: Back leaves the page */ }
    },
    closed(to = null) {
      if (to === HAND_OFF) {
        if (pushed && h.state?.flockSheet === mark) handedOff = mark;
        pushed = false;
        return undefined;
      }
      if (!pushed) return follow(to);
      pushed = false;
      // Only touch the history if we are still on our own step (not after a link to another page).
      if (h.state?.flockSheet !== mark) return follow(to);
      if (to) win.location.replace(to);
      else { skip = true; h.back(); }
    },
  };
}
