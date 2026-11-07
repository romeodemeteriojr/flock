import { html } from '../lib/html.js';
import { iconSlot } from '../lib/icons.js';

export const title = 'Welcome';

export function render(state, { info = null, error = '' } = {}) {
  return String(html`
    <section class="auth">
      <div class="auth-card">
        <span class="auth-mark">${iconSlot('sparkle', 'icon-lg')}</span>
        <h1 tabindex="-1">Welcome to Flock</h1>
        ${info ? html`
          <p class="lead" id="welcome-person">Hi ${info.name}. Your username is <strong>${info.username}</strong>. Remember it for next time.</p>
          <form class="form" data-form="welcome" novalidate>
            ${error ? html`<p class="form-error" role="alert">${error}</p>` : ''}
            <input type="hidden" name="username" autocomplete="username" value="${info.username}">
            <div class="field">
              <label for="welcome-password">Choose your password</label>
              <input id="welcome-password" name="password" type="password" autocomplete="new-password"
                minlength="8" required aria-describedby="welcome-person welcome-rule">
              <p class="hint" id="welcome-rule">At least 8 characters. A few everyday words together work well.</p>
            </div>
            <div class="field">
              <label for="welcome-confirm">Type it again</label>
              <input id="welcome-confirm" name="confirm" type="password" autocomplete="new-password" required>
            </div>
            <button type="submit" class="btn btn-primary btn-block btn-lg">Choose password</button>
          </form>` : error ? html`
          <p class="form-error" role="alert">${error}</p>
          <p><a href="#/login">Go to log in</a></p>` : html`
          <p class="loading" role="status">Checking your link…</p>`}
      </div>
    </section>`);
}

export async function mount(root, ctx) {
  const location = ctx.win?.location ?? globalThis.location;
  const hash = location?.hash ?? '';
  const token = new URLSearchParams(hash.split('?')[1] ?? '').get('token');
  const current = () => !location || location.hash === hash;
  let info;
  try {
    info = await ctx.api.post('/api/welcome/check', { token });
  } catch (err) {
    if (current()) root.innerHTML = render(ctx.state, { error: err.message });
    return;
  }

  const paint = (error = '') => {
    if (!current()) return; // A slow check must not overwrite the next page or invite.
    root.innerHTML = render(ctx.state, { info, error });
    const form = root.querySelector('form[data-form="welcome"]');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = form.elements.password.value;
      if (password !== form.elements.confirm.value) {
        paint('The two passwords are not the same.');
        return;
      }
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = 'Saving…';
      try {
        const r = await ctx.api.post('/api/welcome', { token, password });
        ctx.setUser(r.person);
        ctx.navigate('#/');
      } catch (err) {
        paint(err.message);
      }
    });
  };
  paint();
}
