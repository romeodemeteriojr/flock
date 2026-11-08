import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/app.js';
import { openPage } from './helpers/fakepage.js';
import { resolve } from '../web/routes.js';
import * as welcome from '../web/views/welcome.js';
import { INVITE_GONE_MESSAGE } from '../src/services/auth-service.js';

async function setup(t) {
  const app = await startTestApp();
  t.after(() => app.close());
  const created = await app.container.services.people.create(null, { name: 'Pat Example', email: 'pat.example@example.com' });
  const page = openPage({ url: app.url });
  await page.start();
  await page.goto(`#/welcome?token=${created.invite.token}`);
  return { app, page, created };
}

test('welcome UI: an invite in the fragment is checked and the login email is shown', async (t) => {
  const { page, created } = await setup(t);
  const check = page.fetchLog.find((r) => r.path === '/api/welcome/check');
  assert.deepEqual(check.body, { token: created.invite.token });
  assert.match(page.text(), /Hi Pat Example\. You will log in with pat\.example@example\.com/);
  assert.match(page.html(), /type="hidden" name="email" autocomplete="username" value="pat\.example@example\.com"/);
  assert.equal(page.count('input[type="password"]'), 2);
  assert.deepEqual(page.accessibilityProblems(), []);
});

test('welcome UI: mismatches stay inline and send no acceptance request', async (t) => {
  const { page } = await setup(t);
  await page.submit('welcome', { password: 'my password 1', confirm: 'not the same' });
  assert.match(page.text(), /The two passwords are not the same\./);
  assert.equal(page.fetchLog.filter((r) => r.path === '/api/welcome').length, 0);
});

test('welcome UI: password rules remain retryable; success logs in and removes the token from the address', async (t) => {
  const { page, created } = await setup(t);
  await page.submit('welcome', { password: 'short', confirm: 'short' });
  assert.match(page.text(), /at least 8 characters/);
  await page.submit('welcome', { password: 'my password 1', confirm: 'my password 1' });
  assert.equal(page.hash(), '#/');
  assert.equal(page.app.state.user.id, created.person.id);
  assert.equal(page.app.state.user.hasPassword, true);
  assert.match(page.text(), /Logged in as Pat Example/);
  assert.deepEqual(page.errors, []);
});

test('welcome UI: gone links have a plain error and a login link', async (t) => {
  const { page } = await setup(t);
  await page.goto('#/welcome?token=gone');
  assert.ok(page.text().includes(INVITE_GONE_MESSAGE));
  assert.equal(page.has('form[data-form="welcome"]'), false);
  assert.equal(page.has('a[href="#/login"]'), true);
});

test('welcome UI: open routes work logged in or out, and error/greeting text is escaped', () => {
  for (const user of [null, { id: 1, role: 'admin' }, { id: 2, role: 'member' }]) {
    assert.equal(resolve('#/welcome?token=example', user).route.view, welcome);
  }
  assert.match(welcome.render({}), /Checking your link…/);
  const out = welcome.render({}, { info: { name: '<img src=x>', email: '\"><script>' }, error: '<b>bad</b>' });
  assert.doesNotMatch(out, /<img|<script|<b>/);
  assert.match(out, /&lt;img/);
});

test('welcome UI: a stale check cannot overwrite the next page', async () => {
  let finish;
  const location = { hash: '#/welcome?token=one' };
  const root = { innerHTML: 'Checking', querySelector: () => assert.fail('stale form mounted') };
  const mounting = welcome.mount(root, { state: {}, win: { location }, api: { post: () => new Promise((r) => { finish = r; }) } });
  location.hash = '#/login';
  root.innerHTML = 'Login';
  finish({ name: 'Pat', email: 'pat.example@example.com' });
  await mounting;
  assert.equal(root.innerHTML, 'Login');
});
