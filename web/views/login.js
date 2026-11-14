import { html } from '../lib/html.js';
import { iconSlot } from '../lib/icons.js';

// Branded and centred: the mark large on a soft glow, the form, then "or" and
// a button per sign-in provider (when the church set one up).

export const title = 'Log in';

const SIGNIN_FAILED = 'That sign-in did not work. If you are new, ask your scheduler to add your email.';

// opts: { error, email, providers } so the form can be shown again after a failed try.
// providers: [{id, label}] from /api/auth/options, one "Sign in with" button each.
export function render(state, opts = {}) {
  const error = opts.error ?? '';
  return String(html`
    <section class="auth-page">
        <div class="auth-hero">${iconSlot('flock', 'auth-mark-lg')}<h1 tabindex="-1">Log in to Flock</h1><p class="page-lead">Your church serving schedule.</p></div>
        <form class="form" data-form="login" novalidate>
          ${error ? html`<p class="form-error" role="alert" id="login-error">${error}</p>` : ''}
          <div class="field">
            <label for="login-email">Email</label>
            <input id="login-email" name="email" type="email" autocomplete="username"
              autocapitalize="none" spellcheck="false" required value="${opts.email ?? ''}">
          </div>
          <div class="field">
            <label for="login-password">Password</label>
            <input id="login-password" name="password" type="password" autocomplete="current-password" required>
          </div>
          <button type="submit" class="btn btn-primary btn-block btn-lg">Log in</button>
        </form>
        ${opts.providers?.length ? html`<p class="auth-or">or</p><div class="auth-providers">
          ${opts.providers.map((p) => html`<a class="btn btn-block btn-lg" href="/api/auth/${encodeURIComponent(p.id)}" data-provider="${p.id}">${iconSlot(p.id)} Sign in with ${p.label}</a>`)}
        </div>` : ''}
      <p class="hint auth-foot">${iconSlot('lock', 'icon-sm')} Forgot your password? Ask the scheduler to reset your login.</p>
      <p class="hint auth-foot"><a href="/privacy.html">Privacy</a></p>
    </section>
  `);
}

export function mount(root, ctx, providers = null) {
  const form = root.querySelector('form[data-form="login"]');
  if (!form) return;
  let replaced = false;
  const again = (error, email, list = providers ?? []) => {
    replaced = true;
    root.innerHTML = render(ctx.state, { error, email, providers: list });
    mount(root, ctx, list);
    const pw = root.querySelector('#login-password');
    if (email && pw) pw.focus();
  };
  if (providers === null) {
    // First mount: show a failed sign-in from a provider, and a button per set-up provider.
    const hash = (ctx.win?.location ?? globalThis.location)?.hash ?? '';
    const err = new URLSearchParams(hash.split('?')[1] ?? '').get('signin') === 'failed' ? SIGNIN_FAILED : '';
    Promise.resolve(ctx.api?.get?.('/api/auth/options'))
      .then((o) => (Array.isArray(o?.providers) ? o.providers : []), () => [])
      .then((list) => { if (!replaced && (list.length || err)) again(err, '', list); });
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = form.elements.email.value.trim();
    const password = form.elements.password.value;
    if (!email || !password) {
      again('Please type your email and password.', email);
      return;
    }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Logging in…';
    try {
      const r = await ctx.api.post('/api/login', { email, password });
      ctx.setUser(r.person);
      ctx.navigate(ctx.afterLogin?.() ?? '#/'); // back to the page they were on
    } catch (err) {
      again(err.message, email);
    }
  });
}
