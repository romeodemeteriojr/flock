// Top menu. Members see their own pages; admins also see the scheduling pages.
import { html } from '../lib/html.js';
import { navRoutes, pathOf } from '../routes.js';

export function render(state, hash = '') {
  const user = state?.user;
  if (!user) return '';
  const current = pathOf(hash);
  const links = navRoutes(user).map((r) => html`
    <li><a href="#${r.path}" ${r.path === current ? html`aria-current="page"` : ''}>${r.label}</a></li>`);
  return String(html`
    <nav class="nav" aria-label="Main menu">
      <p class="nav-who">Logged in as <strong>${user.name}</strong></p>
      <ul class="nav-list">
        ${links}
        <li><button type="button" class="nav-logout" data-action="logout">Log out</button></li>
      </ul>
    </nav>
  `);
}

export function mount(root, ctx) {
  const btn = root.querySelector('[data-action="logout"]');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await ctx.api.post('/api/logout');
    } catch (err) {
      // Already logged out is fine; anything else is shown.
      if (err.status !== 401) { btn.disabled = false; ctx.showError(err.message); return; }
    }
    ctx.setUser(null);
    ctx.navigate('#/login');
  });
}
