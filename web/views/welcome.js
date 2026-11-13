import { html } from '../lib/html.js';
import { iconSlot } from '../lib/icons.js';
import { avatar } from '../lib/avatar.js';

export const title = 'Welcome';

export function render(state, { info = null, error = '' } = {}) {
  return String(html`
    <section class="auth-page">
        <div class="auth-hero">${iconSlot('flock', 'auth-mark-lg')}<h1 tabindex="-1">Welcome to Flock</h1>${info ? html`<p class="page-lead">Choose a password and you're in.</p>` : ''}</div>
        ${info ? html`
          <div class="auth-who" id="welcome-person">${avatar(info.name)}<p>Hi <strong>${info.name}</strong>. You will log in with <strong>${info.email}</strong>.</p></div>
          <form class="form" data-form="welcome" novalidate>
            ${error ? html`<p class="form-error" role="alert">${error}</p>` : ''}
            <input type="hidden" name="email" autocomplete="username" value="${info.email}">
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

  // keep: what was typed, put back after a problem so nobody types it all again
  // (set as .value, never into the HTML). focus: the field to fix.
  const paint = (error = '', keep = {}, focus = '') => {
    if (!current()) return; // A slow check must not overwrite the next page or invite.
    root.innerHTML = render(ctx.state, { info, error });
    const form = root.querySelector('form[data-form="welcome"]');
    if (!form) return;
    for (const [k, v] of Object.entries(keep)) if (form.elements?.[k]) form.elements[k].value = v;
    if (focus) form.elements?.[focus]?.focus?.();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = form.elements.password.value;
      if (password !== form.elements.confirm.value) {
        paint('The two passwords are not the same.', { password }, 'confirm');
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
        paint(err.message, { password, confirm: form.elements.confirm.value }, 'password');
      }
    });
  };
  paint();
}
