// A text box with a length limit stops taking letters (or cuts a paste short)
// without a word. Say so under the box while it is full, so nobody wonders why.
export function limitText(max) {
  return `That is the most it can hold (${max} letters).`;
}

export function onLimitInput(e) {
  const box = e.target;
  const max = box?.maxLength;
  if (!(max > 0) || typeof box.value !== 'string' || !box.parentNode) return;
  const next = box.nextElementSibling;
  const shown = next?.classList?.contains('limit-hint') ? next : null;
  const full = box.value.length >= max;
  if (full && !shown) {
    const p = box.ownerDocument.createElement('p');
    p.className = 'hint limit-hint';
    p.setAttribute('role', 'status');
    p.textContent = limitText(max);
    box.after(p);
  } else if (!full && shown) {
    shown.remove();
  }
}

export function watchLimits(el) {
  el.addEventListener('input', onLimitInput);
}
