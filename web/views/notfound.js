import { html } from '../lib/html.js';

export const title = 'Page not found';

export function render(state) { // eslint-disable-line no-unused-vars
  return String(html`
    <h1 tabindex="-1">We couldn't find that page</h1>
    <p>The link may be old or mistyped.</p>
    <p><a class="btn btn-primary" href="#/">Go to my schedule</a></p>
  `);
}

export function mount(root, ctx) {} // eslint-disable-line no-unused-vars
