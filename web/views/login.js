import { html } from '../lib/html.js';
import { iconSlot } from '../lib/icons.js';

export const title = 'Log in';

// opts: { error, username } so the form can be shown again after a failed try.
export function render(state, opts = {}) {
  const error = opts.error ?? '';
  return String(html`
    <section class="auth">
      <div class="auth-card">
        <span class="auth-mark">${iconSlot('sparkle', 'icon-lg')}</span>
        <h1 tabindex="-1">Log in to Flock</h1>
        <p class="page-lead">Your church serving schedule.</p>
        <form class="form" data-form="login" novalidate>
          ${error ? html`<p class="form-error" role="alert" id="login-error">${error}</p>` : ''}
          <div class="field">
            <label for="login-username">Username</label>
            <input id="login-username" name="username" type="text" autocomplete="username"
              autocapitalize="none" spellcheck="false" required value="${opts.username ?? ''}">
          </div>
          <div class="field">
            <label for="login-password">Password</label>
            <input id="login-password" name="password" type="password" autocomplete="current-password" required>
          </div>
          <button type="submit" class="btn btn-primary btn-block btn-lg">Log in</button>
        </form>
      </div>
      <p class="hint auth-foot">${iconSlot('lock', 'icon-sm')} Forgot your password? Ask the scheduler to reset it for you.</p>
    </section>
  `);
}

export function mount(root, ctx) {
  const form = root.querySelector('form[data-form="login"]');
  if (!form) return;
  const again = (error, username) => {
    root.innerHTML = render(ctx.state, { error, username });
    mount(root, ctx);
    const pw = root.querySelector('#login-password');
    if (username && pw) pw.focus();
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = form.elements.username.value.trim();
    const password = form.elements.password.value;
    if (!username || !password) {
      again('Please type your username and password.', username);
      return;
    }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Logging in…';
    try {
      const r = await ctx.api.post('/api/login', { username, password });
      ctx.setUser(r.person);
      ctx.navigate(r.person.mustChangePassword ? '#/password' : '#/');
    } catch (err) {
      again(err.message, username);
    }
  });
}
