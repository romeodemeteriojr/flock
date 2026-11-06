import { html } from '../lib/html.js';

export const title = 'Your password';
export const MIN_LENGTH = 8;

// Checks done before sending. Returns an error message, or '' when fine.
export function checkPasswords(oldPassword, newPassword, confirm) {
  if (!oldPassword) return 'Please type your current password.';
  if (!newPassword) return 'Please type a new password.';
  if (newPassword.length < MIN_LENGTH) return `Your new password must be at least ${MIN_LENGTH} characters long.`;
  if (newPassword !== confirm) return "The two new passwords don't match. Please type them again.";
  if (newPassword === oldPassword) return 'Your new password must be different from your current one.';
  return '';
}

export function render(state, opts = {}) {
  const must = !!state?.user?.mustChangePassword;
  const error = opts.error ?? '';
  return String(html`
    <h1 tabindex="-1">${must ? 'Please choose your own password' : 'Change your password'}</h1>
    ${must ? html`<p class="lead">You logged in with a password someone gave you. Please choose your own password before you go on.</p>` : ''}
    <form class="form" data-form="password" novalidate>
      ${error ? html`<p class="form-error" role="alert">${error}</p>` : ''}
      <div class="field">
        <label for="pw-old">${must ? 'The password you were given' : 'Current password'}</label>
        <input id="pw-old" name="oldPassword" type="password" autocomplete="current-password" required>
      </div>
      <div class="field">
        <label for="pw-new">New password</label>
        <input id="pw-new" name="newPassword" type="password" autocomplete="new-password"
          minlength="${MIN_LENGTH}" required aria-describedby="pw-rule">
        <p class="hint" id="pw-rule">At least ${MIN_LENGTH} characters. A few everyday words together work well.</p>
      </div>
      <div class="field">
        <label for="pw-confirm">Type the new password again</label>
        <input id="pw-confirm" name="confirm" type="password" autocomplete="new-password" required>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Save my new password</button>
    </form>
  `);
}

export function mount(root, ctx) {
  const form = root.querySelector('form[data-form="password"]');
  if (!form) return;
  const again = (error) => {
    root.innerHTML = render(ctx.state, { error });
    mount(root, ctx);
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const oldPassword = form.elements.oldPassword.value;
    const newPassword = form.elements.newPassword.value;
    const confirm = form.elements.confirm.value;
    const problem = checkPasswords(oldPassword, newPassword, confirm);
    if (problem) { again(problem); return; }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await ctx.api.post('/api/password', { oldPassword, newPassword });
      if (ctx.state.user) ctx.setUser({ ...ctx.state.user, mustChangePassword: false });
      ctx.navigate('#/');
      ctx.showMessage('Your new password is saved.');
    } catch (err) {
      if (err.status === 401) return; // the app sends them to log in
      again(err.message);
    }
  });
}
