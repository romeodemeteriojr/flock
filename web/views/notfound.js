import { html } from '../lib/html.js';
import { emptyState } from '../lib/ui.js';

export const title = 'Page not found';

export function render(state) { // eslint-disable-line no-unused-vars
  return String(html`
    <div class="page-head"><h1 tabindex="-1">We couldn't find that page</h1></div>
    ${emptyState('The link may be old or mistyped.', 'art-lost', html`<p><a class="btn btn-primary" href="#/">Go to my schedule</a></p>`)}
  `);
}

export function mount(root, ctx) {} // eslint-disable-line no-unused-vars
