// A square icon-only button. The label is required: it becomes the accessible
// name (aria-label) and the hover hint (title), so a person with a screen
// reader or a mouse always knows what the button does. The icon itself stays
// aria-hidden (see icons.js).
//
//   iconButton('trash', 'Delete service', { dataAction: 'delete-service', dataId: 3 })
//   -> <button type="button" class="icon-btn" aria-label="Delete service"
//        title="Delete service" data-action="delete-service" data-id="3">…</button>
//
// Returns SafeHtml, like iconSlot and the other html helpers.

import { html, attr, raw } from './html.js';
import { iconSlot } from './icons.js';

const q = (v) => `"${String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;

/**
 * @param {string} name an icon name from icons.js (e.g. 'trash').
 * @param {string} label what the button does, in words. Required; throws if missing or empty.
 * @param {{dataAction?: string, dataId?: number|string, disabled?: boolean, danger?: boolean}} [attrs]
 *   dataAction/dataId become data-action / data-id; disabled adds the disabled
 *   attribute; danger adds the icon-btn-danger class.
 */
export function iconButton(name, label, attrs = {}) {
  if (typeof label !== 'string' || label.trim() === '') {
    throw new Error(`iconButton: every icon button needs a non-empty label (got ${JSON.stringify(label)})`);
  }
  const cls = ['icon-btn', attrs.danger ? 'icon-btn-danger' : null].filter(Boolean).join(' ');
  const data = [
    attrs.dataAction !== undefined ? `data-action=${q(attrs.dataAction)}` : '',
    attrs.dataId !== undefined ? `data-id=${q(attrs.dataId)}` : '',
  ].filter(Boolean).join(' ');
  const extra = [data, attrs.disabled ? 'disabled' : null].filter(Boolean).join(' ');
  const tail = extra ? ` ${extra}` : '';
  return html`<button type="button" class="${attr(cls)}" aria-label="${attr(label)}" title="${attr(label)}"${raw(tail)}>${iconSlot(name)}</button>`;
}
