// "Can't reach the server": shown at start-up when Flock cannot reach the
// church's server (no signal, or the server is waking up). The app's own files
// come from the phone (decision 0009), so this page shows even with no
// connection, in place of the browser's error page. Never data: just the way
// back in. web/app.js tries again on "Try again", when the phone comes back
// online, and when Flock comes back to the screen.
import { html } from '../lib/html.js';
import { iconSlot } from '../lib/icons.js';

export const title = "Can't reach the server";

/** busy: a try is under way (the button waits). */
export function render({ busy = false } = {}) {
  return String(html`<section class="offline" data-offline>
  <span class="brand offline-brand">${iconSlot('flock', 'brand-mark')}<span class="brand-name">Flock</span></span>
  ${iconSlot('offline', 'offline-icon')}
  <h1 tabindex="-1">Can't reach the server</h1>
  <p>Check your internet, then try again. Flock opens as soon as it can connect.</p>
  <button type="button" class="btn btn-primary btn-lg" data-action="retry-start" ${busy ? html`disabled aria-busy="true"` : ''}>${iconSlot('refresh')} ${busy ? 'Trying…' : 'Try again'}</button>
</section>`);
}
