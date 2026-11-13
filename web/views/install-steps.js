// "Add Flock to your Home Screen": the three steps on an iPhone or iPad,
// where Safari has no install prompt. A sheet in #layer, opened from the
// install card on My schedule or the account sheet's "Install Flock" row.
import { html } from '../lib/html.js';
import { iconSlot } from '../lib/icons.js';

export const title = 'Add Flock to your Home Screen';

/** The sheet's markup, or '' when it is closed (state.installSteps). */
export function render(state) {
  if (!state?.installSteps) return '';
  return String(html`<div class="sheet-layer is-entering" data-install-sheet>
  <div class="sheet-backdrop" data-action="install-close"></div>
  <section class="sheet" data-install-panel role="dialog" aria-modal="true" aria-labelledby="install-title">
    <div class="sheet-grab" aria-hidden="true"></div>
    <div class="sheet-head"><h2 id="install-title" tabindex="-1">${title}</h2><button type="button" class="icon-btn" data-action="install-close" aria-label="Close">${iconSlot('x')}</button></div>
    <div class="sheet-body"><ol class="howto">
      <li><span class="howto-num">1</span><span class="howto-text">Tap <strong>Share</strong> in Safari's toolbar.</span>${iconSlot('share', 'howto-icon')}</li>
      <li><span class="howto-num">2</span><span class="howto-text">Scroll down and choose <strong>Add to Home Screen</strong>.</span>${iconSlot('add-square', 'howto-icon')}</li>
      <li><span class="howto-num">3</span><span class="howto-text">Tap <strong>Add</strong>. Then open Flock from your Home Screen.</span>${iconSlot('check', 'howto-icon')}</li>
    </ol></div>
  </section></div>`);
}
