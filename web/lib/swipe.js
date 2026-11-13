// Swipe a bottom sheet down to close it, as on a phone's own sheets. Only on
// phones (under 720px, where sheets come up from the bottom), and only when
// the drag starts on the handle or the sheet's heading, so lists inside still
// scroll and buttons still tap. While a finger is down the sheet follows it
// (--sheet-drag, a custom property; style.css moves the sheet). Let go past
// 30% of its height, or with a quick flick, and it closes; otherwise it
// settles back. Every browser part comes from `win`; nothing runs at import.

const HANDLE = '.sheet-grab, .sheet-head, .account-head, .nav-sub-title';
const TAPPABLE = 'button, a, input, select, textarea';
const BODY = '.sheet-body, .sheet-menu, .nav-sub';
export const DISMISS_SHARE = 0.3; // of the sheet's height
export const FLICK_PX_PER_MS = 0.5;

const drag = (sheet, px) => sheet.style?.setProperty?.('--sheet-drag', `${px}px`);

/** Wires swiping on `sheet`. Returns a function that removes it again. */
export function swipeToDismiss(sheet, { onDismiss, win, handle = HANDLE } = {}) {
  if (typeof sheet?.addEventListener !== 'function') return () => {};
  const phone = () => !!win?.matchMedia?.('(max-width: 719px)')?.matches;
  let held = null; // { id, y, t, dy, lastY, lastT, speed }

  function down(e) {
    if (held || !phone() || (e.button ?? 0) > 0) return;
    const on = e.target?.closest?.(handle);
    if (!on || e.target?.closest?.(TAPPABLE)) return;
    if ((sheet.querySelector?.(BODY)?.scrollTop ?? 0) > 0) return; // reading down the list: not a swipe
    held = { id: e.pointerId, y: e.clientY, t: e.timeStamp, dy: 0, lastY: e.clientY, lastT: e.timeStamp, speed: 0 };
    sheet.setPointerCapture?.(e.pointerId);
    sheet.classList?.remove('is-settling');
    sheet.classList?.add('is-dragging');
  }

  function move(e) {
    if (!held || e.pointerId !== held.id) return;
    const dt = e.timeStamp - held.lastT;
    if (dt > 0) held.speed = (e.clientY - held.lastY) / dt;
    held.lastY = e.clientY;
    held.lastT = e.timeStamp;
    held.dy = Math.max(0, e.clientY - held.y); // never up past where it rests
    drag(sheet, held.dy);
  }

  function up(e) {
    if (!held || e.pointerId !== held.id) return;
    const { dy, speed } = held;
    held = null;
    sheet.classList?.remove('is-dragging');
    const height = sheet.getBoundingClientRect?.().height || sheet.offsetHeight || 0;
    if (dy > 0 && ((height && dy > height * DISMISS_SHARE) || speed > FLICK_PX_PER_MS)) {
      onDismiss?.();
      sheet.style?.removeProperty?.('--sheet-drag');
      return;
    }
    sheet.classList?.add('is-settling');
    drag(sheet, 0);
  }

  function cancel(e) {
    if (!held || e.pointerId !== held.id) return;
    held = null;
    sheet.classList?.remove('is-dragging');
    sheet.classList?.add('is-settling');
    drag(sheet, 0);
  }

  sheet.addEventListener('pointerdown', down);
  sheet.addEventListener('pointermove', move);
  sheet.addEventListener('pointerup', up);
  sheet.addEventListener('pointercancel', cancel);
  return () => {
    sheet.removeEventListener?.('pointerdown', down);
    sheet.removeEventListener?.('pointermove', move);
    sheet.removeEventListener?.('pointerup', up);
    sheet.removeEventListener?.('pointercancel', cancel);
  };
}
