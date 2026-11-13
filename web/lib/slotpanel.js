// Shared pieces for the scheduler pages (Services, Schedule, Gaps):
// the status chip and the slot panel (suggestions, assign, remove person).
//
// The panel is a small controller that lives inside a screen:
//   const panel = createSlotPanel({ api, paint, changed });
//   html`${panel.render()} ...`            -> inside the screen's paint
//   if (panel.handle(action, id)) return;   -> inside the screen's click handler
//   panel.open(slot)                        -> show it for a slot
// `changed(notice)` runs after an assign or remove worked, so the screen can reload.
import { html, attr } from './html.js';
import { formatDate, formatTime } from './dates.js';
import { iconSlot } from './icons.js';
import { avatar } from './avatar.js';
import { skeleton, emptyState } from './ui.js';

// ---------- status chip ----------

export const STATUS = Object.freeze({
  open: { label: 'Open', cls: 'chip-plain chip-open', icon: 'plus' },
  pending: { label: 'Waiting for answer', cls: 'chip-wait', icon: 'clock' },
  accepted: { label: 'Confirmed', cls: 'chip-ok', icon: 'check' },
  declined: { label: 'Declined', cls: 'chip-bad', icon: 'x' },
});

export function statusOf(slot) {
  if (!slot || slot.personId === null || slot.personId === undefined) {
    return slot && slot.status && slot.status !== 'open' && STATUS[slot.status] ? slot.status : 'open';
  }
  return STATUS[slot.status] ? slot.status : 'pending';
}

// The chip shows an icon and words, never colour alone. With { compact: true }
// it shows the icon only; the word stays as aria-label and visually hidden
// text, so the chip keeps an accessible name.
export function statusChip(status, { compact = false } = {}) {
  const s = STATUS[status] ?? STATUS.open;
  if (compact) {
    return html`<span class="chip ${s.cls} chip-compact" data-status="${status in STATUS ? status : 'open'}" aria-label="${attr(s.label)}">${iconSlot(s.icon, 'chip-icon')}<span class="visually-hidden">${s.label}</span></span>`;
  }
  return html`<span class="chip ${s.cls}" data-status="${status in STATUS ? status : 'open'}">${iconSlot(s.icon, 'chip-icon')}${s.label}</span>`;
}

// ---------- 409 explanations ----------

// Codes the scheduler may override after confirming. inactive and past never are.
export const OVERRIDABLE = Object.freeze(['blocked', 'not_qualified', 'double_booked', 'accepted']);

export function conflictMessage(code, name, positionName) {
  const who = name || 'This person';
  switch (code) {
    case 'blocked': return `${who} is away on that date. Assign anyway?`;
    case 'not_qualified': return positionName
      ? `${who} is not trained for ${positionName}. Assign anyway?`
      : `${who} is not trained for this. Assign anyway?`;
    case 'double_booked': return `${who} is already serving at this service. Assign anyway?`;
    case 'accepted': return `Someone else has already said yes to this. Put ${who} in instead?`;
    case 'inactive': return `${who} is no longer active, so they can't be scheduled.`;
    case 'past': return "That service has already happened, so it can't be changed.";
    default: return '';
  }
}

export const canForce = (code) => OVERRIDABLE.includes(code);

export function slotWhere(slot) {
  const when = [formatDate(slot.date), slot.time ? formatTime(slot.time) : ''].filter(Boolean).join(' at ');
  return [slot.positionName, when].filter(Boolean).join(', ');
}

const errText = (err) => String(err?.message || 'Something went wrong. Please try again.');

// ---------- the panel ----------

export function createSlotPanel({ api, paint, changed = () => {} }) {
  let p = null; // { slot, loading, candidates, showAll, conflict, removeAsk, error, busy, seq }

  async function loadSuggestions() {
    if (!p) return;
    const mine = p;
    const seq = ++mine.seq; // only the newest request may fill the list
    mine.loading = true;
    mine.error = '';
    try {
      const q = `/api/admin/suggest?slotId=${Number(mine.slot.id)}${mine.showAll ? '&includeUnqualified=true' : ''}`;
      const r = await api.get(q);
      if (p !== mine || seq !== mine.seq) return;
      mine.candidates = Array.isArray(r?.candidates) ? r.candidates : [];
    } catch (err) {
      if (p !== mine || seq !== mine.seq) return;
      mine.candidates = [];
      mine.error = errText(err);
    }
    mine.loading = false;
    paint();
  }

  function open(slot) {
    p = { slot, loading: true, candidates: [], showAll: false, conflict: null, removeAsk: false, error: '', busy: false, seq: 0 };
    paint();
    return loadSuggestions();
  }

  function close() { p = null; paint(); }

  const nameOf = (personId) => p?.candidates.find((c) => c.personId === personId)?.name ?? '';

  async function assign(personId, force) {
    if (!p || p.busy) return;
    const mine = p;
    const name = nameOf(personId);
    mine.busy = true;
    mine.error = '';
    mine.conflict = null;
    try {
      await api.put(`/api/slots/${Number(mine.slot.id)}/assign`, { personId, force: !!force });
      mine.busy = false;
      if (p === mine) p = null;
      await changed(`${name || 'That person'} is now on ${slotWhere(mine.slot)}. Waiting for their answer.`);
      paint();
      return;
    } catch (err) {
      if (err?.status === 409 && err.code) {
        const message = conflictMessage(err.code, name, mine.slot.positionName) || errText(err);
        // A forced retry is only offered for overridable codes, and never twice.
        mine.conflict = { code: err.code, personId, message, force: !force && canForce(err.code) };
      } else if (err?.status !== 401) {
        mine.error = errText(err);
      }
    }
    mine.busy = false;
    paint();
  }

  async function remove() {
    if (!p || p.busy || !p.removeAsk) return;
    const mine = p;
    mine.busy = true;
    try {
      await api.del(`/api/slots/${Number(mine.slot.id)}/assign`);
      mine.busy = false;
      if (p === mine) p = null;
      await changed(`${mine.slot.personName || 'The person'} was taken off ${slotWhere(mine.slot)}. It is open again.`);
      paint();
      return;
    } catch (err) {
      mine.removeAsk = false;
      if (err?.status === 409 && err.code === 'past') mine.error = conflictMessage('past');
      else if (err?.status !== 401) mine.error = errText(err);
    }
    mine.busy = false;
    paint();
  }

  const actions = {
    'slot-close': () => close(),
    'slot-assign': (id) => assign(id, false),
    'slot-force': () => {
      const c = p?.conflict;
      if (!c || !c.force || p.busy) return; // never for inactive or past
      return assign(c.personId, true);
    },
    'slot-conflict-back': () => { if (p) { p.conflict = null; paint(); } },
    'slot-toggle': () => {
      if (!p) return;
      p.showAll = !p.showAll;
      p.conflict = null;
      paint();
      return loadSuggestions();
    },
    'slot-remove-ask': () => { if (p) { p.removeAsk = true; p.conflict = null; paint(); } },
    'slot-remove-no': () => { if (p) { p.removeAsk = false; paint(); } },
    'slot-remove-yes': () => remove(),
  };

  // Returns true (or a promise) when the action belongs to the panel.
  function handle(action, id) {
    const fn = actions[action];
    if (!fn) return false;
    return fn(Number(id)) ?? true;
  }

  function render() {
    if (!p) return '';
    const { slot } = p;
    const status = statusOf(slot);
    const hasPerson = slot.personId !== null && slot.personId !== undefined;
    let conflict = '';
    if (p.conflict) {
      conflict = html`<div class="notice notice-warn" role="alertdialog" aria-label="Please check" data-conflict="${p.conflict.code}">
        ${iconSlot('warning', 'notice-icon')}<div class="notice-body"><p>${p.conflict.message}</p>
        <div class="btn-row">
          ${p.conflict.force ? html`<button type="button" class="btn btn-primary" data-action="slot-force">Yes, assign anyway</button>
          <button type="button" class="btn" data-action="slot-conflict-back">No, go back</button>`
    : html`<button type="button" class="btn" data-action="slot-conflict-back">OK</button>`}
        </div></div></div>`;
    }
    // Who is in it now (or nobody yet), with Remove; its are-you-sure takes the button's place.
    const chip = slot.statusLabel ? html`<span class="chip chip-plain">${slot.statusLabel}</span>` : statusChip(status);
    const current = hasPerson
      ? html`<div class="slot-current">${avatar(slot.personName)}<div class="slot-current-text"><p class="sheet-who"><strong>${slot.personName}</strong> ${chip}</p></div>
          ${p.removeAsk ? '' : html`<button type="button" class="btn btn-danger btn-sm" data-action="slot-remove-ask" aria-label="Remove ${slot.personName}">Remove</button>`}</div>
        ${p.removeAsk ? html`<div class="confirm confirm-danger" role="alertdialog" aria-label="Confirm">
            <p>Take ${slot.personName} off ${slotWhere(slot)}?</p>
            <div class="btn-row">
              <button type="button" class="btn btn-danger" data-action="slot-remove-yes">Yes, remove ${slot.personName}</button>
              <button type="button" class="btn" data-action="slot-remove-no">No, go back</button>
            </div></div>` : ''}`
      : html`<div class="slot-current is-empty"><p class="sheet-who"><span class="chip chip-plain chip-open">${iconSlot('plus', 'chip-icon')}Nobody yet</span></p></div>`;
    let list;
    if (p.loading) list = html`<p class="hint">Looking for people…</p>${skeleton('Loading…', 'list', 3)}`;
    else if (!p.candidates.length) {
      list = emptyState(p.showAll ? 'Nobody is free for this.' : 'Nobody trained for this is free. Try showing people not trained for this.', 'art-people');
    } else {
      // The list comes sorted by who has served least; the first one trained for it is the best match.
      const best = p.candidates.find((c) => c.qualified !== false)?.personId;
      list = html`<ol class="list candidates" data-candidates>${p.candidates.map((c) => html`<li class="candidate" data-candidate="${c.personId}">
        <div class="candidate-main">${avatar(c.name)}<div class="candidate-text">
        <p class="candidate-name"><strong>${c.name}</strong>${c.personId === best ? html` <span class="chip chip-info">${iconSlot('sparkle', 'chip-icon')}Best match</span>` : ''}${c.qualified === false ? html` <span class="chip chip-plain">Not trained</span>` : ''}</p>
        <ul class="hint reasons">${(c.reasons ?? []).map((r) => html`<li>${r}</li>`)}</ul></div></div>
        <div class="btn-row candidate-actions"><button type="button" class="btn${c.personId === best ? ' btn-primary' : ''}" data-action="slot-assign" data-id="${c.personId}">Assign</button></div>
      </li>`)}</ol>`;
    }
    // Short words on the buttons; the full sentence is the name a screen reader says.
    const seg = (pressed, label, full) => (pressed
      ? html`<button type="button" class="segment" aria-pressed="true" aria-label="${full}">${label}</button>`
      : html`<button type="button" class="segment" data-action="slot-toggle" aria-pressed="false" aria-label="${full}">${label}</button>`);
    const entering = !p.entered; // slide in once, not on every repaint
    p.entered = true;
    return html`<div class="sheet-layer${entering ? ' is-entering' : ''}" data-sheet>
    <div class="sheet-backdrop" data-action="slot-close"></div>
    <section class="sheet slot-panel" data-slot-panel="${slot.id}" role="dialog" aria-modal="true" aria-labelledby="slot-panel-title" aria-describedby="slot-panel-when">
      <div class="sheet-grab" aria-hidden="true"></div>
      <div class="sheet-head">
        <div class="sheet-titles"><h2 id="slot-panel-title" tabindex="-1">${slot.positionName}</h2><p class="sheet-sub" id="slot-panel-when">${slot.teamName ? html`${slot.teamName} · ` : ''}${formatDate(slot.date)}${slot.time ? html` at <span class="num">${formatTime(slot.time)}</span>` : ''}</p></div>
        <button type="button" class="icon-btn" data-action="slot-close" aria-label="Close">${iconSlot('x')}</button>
      </div>
      <div class="sheet-body">
      ${current}
      ${p.error ? html`<p class="form-error" role="alert">${p.error}</p>` : ''}
      ${conflict}
      <h3>Who could do this</h3>
      <div class="segmented" role="group" aria-label="Who to show">
        ${seg(!p.showAll, 'Trained', 'Only people trained for this')}
        ${seg(p.showAll, 'Everyone', 'Show people not trained for this')}
      </div>
      ${list}
      </div>
      <div class="sheet-foot"><button type="button" class="btn btn-block" data-action="slot-close">Close</button></div>
    </section></div>`;
  }

  return { open, close, handle, render, get state() { return p; } };
}

// Copy text with the browser clipboard. Returns true when it worked.
export async function copyText(win, text) {
  try {
    if (win?.navigator?.clipboard?.writeText) {
      await win.navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* Try the legacy clipboard below. */ }

  // shortcut: HTTP needs browser-dependent legacy copy; use HTTPS if it is blocked.
  const doc = win?.document;
  const focused = doc?.activeElement;
  let field;
  try {
    if (!doc?.body || !doc.execCommand) return false;
    field = doc.createElement('textarea');
    field.value = text;
    field.className = 'visually-hidden';
    field.setAttribute('readonly', '');
    field.setAttribute('aria-label', 'Text to copy');
    field.tabIndex = -1;
    doc.body.appendChild(field);
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, field.value.length);
    return doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    field?.remove();
    if (field) focused?.focus?.({ preventScroll: true });
  }
}

// Move keyboard focus to the panel heading, when there is a real DOM.
export function focusPanel(root) {
  const h = typeof root?.querySelector === 'function' ? root.querySelector('[data-slot-panel] h2') : null;
  if (h && typeof h.focus === 'function') h.focus();
}
