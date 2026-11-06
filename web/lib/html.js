// Safe HTML building. Every value put into an html`...` template is escaped,
// unless it is already safe (made by html`...`, raw() or attr()).
//
//   html`<p>${person.name}</p>`            -> name is escaped
//   html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`   -> lists work
//   html`<input value="${text}">`          -> quotes are escaped too
//
// Views return String(html`...`) so they hand back a plain string.
// Only use raw() for HTML you built yourself with html`...`.

const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

// Escape text for HTML (works for text and for quoted attribute values).
export function esc(value) {
  if (value === null || value === undefined || value === false) return '';
  return String(value).replace(/[&<>"'`]/g, (c) => MAP[c]);
}

export class SafeHtml {
  constructor(value) { this.value = String(value); }
  toString() { return this.value; }
}

// Mark a string as already-safe HTML. It will not be escaped again.
export function raw(value) {
  if (value instanceof SafeHtml) return value;
  return new SafeHtml(value ?? '');
}

// Escape a value for use inside a quoted attribute: <a title="${attr(x)}">.
// Returns safe HTML so html`...` does not escape it a second time.
export function attr(value) {
  return new SafeHtml(esc(value));
}

function piece(value) {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(piece).join('');
  return esc(value);
}

// Tagged template: html`<p>${text}</p>`.
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += piece(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}
