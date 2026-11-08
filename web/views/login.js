import { html } from '../lib/html.js';
import { iconSlot } from '../lib/icons.js';

export const title = 'Log in';

const GOOGLE_ERRORS = {
  unknown: 'That Google account is not in Flock. Ask your scheduler to add your email.',
  failed: 'Google sign-in did not work. Please try again.',
};

// opts: { error, username, google } so the form can be shown again after a failed try.
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
            <label for="login-username">Username or email</label>
            <input id="login-username" name="username" type="text" autocomplete="username"
              autocapitalize="none" spellcheck="false" required value="${opts.username ?? ''}">
          </div>
          <div class="field">
            <label for="login-password">Password</label>
            <input id="login-password" name="password" type="password" autocomplete="current-password" required>
          </div>
          <button type="submit" class="btn btn-primary btn-block btn-lg">Log in</button>
        </form>
        ${opts.google ? html`<a class="btn btn-block btn-lg" href="/api/auth/google" data-google>Sign in with Google</a>` : ''}
      </div>
      <p class="hint auth-foot">${iconSlot('lock', 'icon-sm')} Forgot your password? Ask the scheduler to reset it for you.</p>
    </section>
  `);
}

export function mount(root, ctx, google = null) {
  const form = root.querySelector('form[data-form="login"]');
  if (!form) return;
  let replaced = false;
  const again = (error, username, g = google ?? false) => {
    replaced = true;
    root.innerHTML = render(ctx.state, { error, username, google: g });
    mount(root, ctx, g);
    const pw = root.querySelector('#login-password');
    if (username && pw) pw.focus();
  };
  if (google === null) {
    // First mount: show a Google error from the callback, and the button when it is set up.
    const hash = (ctx.win?.location ?? globalThis.location)?.hash ?? '';
    const err = GOOGLE_ERRORS[new URLSearchParams(hash.split('?')[1] ?? '').get('google')] ?? '';
    Promise.resolve(ctx.api?.get?.('/api/auth/options'))
      .then((o) => !!o?.google, () => false)
      .then((g) => { if (!replaced && (g || err)) again(err, '', g); });
  }
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
      ctx.navigate('#/');
    } catch (err) {
      again(err.message, username);
    }
  });
}
