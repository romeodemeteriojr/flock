// STUB: a later card replaces this view.
import { html } from '../lib/html.js';

export const title = "Teams";

export function render(state) { // eslint-disable-line no-unused-vars
  return String(html`
    <h1 tabindex="-1">${title}</h1>
    <p class="coming-soon">Coming soon.</p>
  `);
}

export function mount(root, ctx) {} // eslint-disable-line no-unused-vars
