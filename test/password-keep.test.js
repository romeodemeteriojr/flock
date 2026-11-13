// After a problem, the password forms put back what was typed (as .value, never
// into the HTML) and put the cursor on the field to fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as password from '../web/views/password.js';
import * as welcome from '../web/views/welcome.js';

// Every repaint makes a new, empty form, as the browser would.
function formRoot(formName, names) {
  let form;
  const root = {
    focused: null,
    set innerHTML(v) {
      this.html = v;
      const handlers = [];
      const elements = Object.fromEntries(names.map((n) => [n, { name: n, value: '', focus: () => { root.focused = n; } }]));
      form = { elements, handlers, addEventListener: (t, fn) => handlers.push(fn), querySelector: () => ({ disabled: false, textContent: '' }) };
    },
    get innerHTML() { return this.html; },
    querySelector: (sel) => (sel.includes(formName) ? form : null),
    get form() { return form; },
    async submit(values) {
      for (const [k, v] of Object.entries(values)) form.elements[k].value = v;
      await Promise.all(form.handlers.map((fn) => fn({ preventDefault() {} })));
    },
  };
  return root;
}
const values = (root) => Object.fromEntries(Object.entries(root.form.elements).map(([k, v]) => [k, v.value]));

test('change password: a mismatch keeps the old and new password, clears "again" and goes there', async () => {
  const root = formRoot('password', ['oldPassword', 'newPassword', 'confirm']);
  root.innerHTML = password.render({}, {});
  password.mount(root, { state: {}, api: {} });
  await root.submit({ oldPassword: 'old secret 1', newPassword: 'new secret 12', confirm: 'new secret 13' });
  assert.match(root.html, /not the same|match/i);
  assert.deepEqual(values(root), { oldPassword: 'old secret 1', newPassword: 'new secret 12', confirm: '' });
  assert.equal(root.focused, 'confirm');
  assert.doesNotMatch(root.html, /secret/, 'never written into the page');
});

test('change password: a server problem keeps everything typed', async () => {
  const root = formRoot('password', ['oldPassword', 'newPassword', 'confirm']);
  root.innerHTML = password.render({}, {});
  const api = { post: async () => { throw Object.assign(new Error('That is not your current password.'), { status: 400 }); } };
  password.mount(root, { state: {}, api });
  await root.submit({ oldPassword: 'old secret 1', newPassword: 'new secret 12', confirm: 'new secret 12' });
  assert.match(root.html, /not your current password/);
  assert.deepEqual(values(root), { oldPassword: 'old secret 1', newPassword: 'new secret 12', confirm: 'new secret 12' });
  assert.doesNotMatch(root.html, /secret/);
});

test('welcome: a mismatch keeps the password and clears "again"; a server problem keeps both', async () => {
  const root = formRoot('welcome', ['email', 'password', 'confirm']);
  const location = { hash: '#/welcome?token=t1', pathname: '/', search: '' };
  let fail = null;
  const api = { post: async (path) => {
    if (path === '/api/welcome/check') return { name: 'Pat', email: 'pat@example.com' };
    throw fail;
  } };
  await welcome.mount(root, { state: { route: { params: { token: 't1' } } }, win: { location, history: { replaceState() {} } }, api, current: () => true });
  if (!root.form) return assert.fail('no welcome form');
  await root.submit({ password: 'my secret 123', confirm: 'my secret 124' });
  assert.match(root.html, /The two passwords are not the same\./);
  assert.equal(values(root).password, 'my secret 123');
  assert.equal(values(root).confirm, '');
  assert.equal(root.focused, 'confirm');
  fail = new Error('Please use at least 8 characters.');
  await root.submit({ password: 'my secret 123', confirm: 'my secret 123' });
  assert.match(root.html, /at least 8 characters/);
  assert.equal(values(root).password, 'my secret 123');
  assert.equal(values(root).confirm, 'my secret 123');
  assert.doesNotMatch(root.html, /secret/);
});
