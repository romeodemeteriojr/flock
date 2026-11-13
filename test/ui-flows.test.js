// UI flows, end to end without a browser (C-84). The REAL web/app.js and the real
// view modules run on a tiny fake page (test/helpers/fakepage.js) and talk, through
// the real web/api.js, over real HTTP to a started test app that holds the same
// made-up demo data `node bin/flock.js demo` creates. Each test follows a numbered
// scenario in UAT.md. Made-up people only; nothing touches real files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/app.js';
import { openPage } from './helpers/fakepage.js';
import { seedDemo } from '../src/cli/demo.js';
import { addDays, todayStr } from '../src/dates.js';
import { esc } from '../web/lib/html.js';
import { routes } from '../web/routes.js';
import { readFileSync } from 'node:fs';
import { tokenFromLink } from './helpers/client.js';

const NEW_PASSWORD = 'my own password 1';

// ---------- helpers ----------

// A started app with the demo data, plus a clock the test can move forward.
async function world(t, { demo = true } = {}) {
  const clock = { offset: 0, advance(ms) { clock.offset += ms; } };
  const app = await startTestApp({ now: () => Date.now() + clock.offset });
  t.after(() => app.close());
  const demoData = demo ? await seedDemo(app.container) : null;
  const w = { app, clock, demo: demoData, pages: [] };
  w.open = async (jar) => {
    const page = openPage({ url: app.url, jar });
    w.pages.push(page);
    await page.start();
    return page;
  };
  return w;
}

// Say what is on screen when a check fails.
const said = (page, re, note = '') => assert.match(page.text(), re, `${note}\nON SCREEN: ${page.text()}`);
const notSaid = (page, re, note = '') => assert.doesNotMatch(page.text(), re, `${note}\nON SCREEN: ${page.text()}`);

// Every page a person sees must have named buttons, links and inputs, and no
// markup made from typed text.
function wellBuilt(page, where = page.hash()) {
  assert.deepEqual(page.accessibilityProblems(), [], `accessibility problems on ${where}`);
  assert.deepEqual(page.injectionProblems(), [], `typed text became markup on ${where}`);
}

async function logIn(page, email, password) {
  await page.submit('login', { email, password });
}

// Join through the one-time link, then use an ordinary login afterwards.
async function joinInvite(w, email, token, next = NEW_PASSWORD) {
  const page = await w.open();
  await page.goto(`#/welcome?token=${token}`);
  assert.ok(page.text().includes(email), page.text());
  await page.submit('welcome', { password: next, confirm: next });
  assert.equal(page.hash(), '#/', page.text());
  return page;
}

const countCalls = (page, method, re) => page.fetchLog.filter((c) => c.method === method && re.test(c.path)).length;
const rx = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The id of the person whose row on the People page shows this name.
function personId(page, name) {
  const html = page.html();
  const re = /<li data-person="(\d+)">[\s\S]*?<\/li>\s*(?=<li data-person|<\/ul>)/g;
  for (const m of html.matchAll(re)) if (m[0].includes(`<strong>${esc(name)}</strong>`)) return Number(m[1]);
  throw new Error(`no row for ${name}`);
}

// ---------- UAT 1: invite joining and voluntary password change ----------

test('UAT 1: join with the printed invite, then change a password voluntarily', async (t) => {
  const w = await world(t);
  const page = await w.open();
  assert.equal(page.hash(), '#/login');
  assert.equal(page.title(), 'Log in – Flock');
  said(page, /Log in to Flock/);
  assert.equal(page.has('nav'), false);
  wellBuilt(page);
  await page.goto('#/people');
  assert.equal(page.hash(), '#/login');

  const before = page.fetchLog.length;
  await page.submit('login', { email: '', password: '' });
  said(page, /Please type your email and password\./);
  assert.equal(page.fetchLog.length, before);
  await logIn(page, 'demo-admin@example.com', 'not the password');
  said(page, /Wrong email or password/);
  assert.match(page.html(), /value="demo-admin@example\.com"/);
  assert.equal(page.focused?.attrs.get('id'), 'login-password');

  const token = w.demo.invite.token;
  await page.goto(`#/welcome?token=${token}`);
  said(page, /You will log in with demo-admin@example\.com/);
  wellBuilt(page, 'welcome');
  await page.submit('welcome', { password: NEW_PASSWORD, confirm: 'not the same' });
  said(page, /The two passwords are not the same/);
  assert.equal(countCalls(page, 'POST', /^\/api\/welcome$/), 0);
  await page.submit('welcome', { password: 'short', confirm: 'short' });
  said(page, /at least 8 characters/);
  await page.submit('welcome', { password: 'demo-admin@example.com', confirm: 'demo-admin@example.com' });
  said(page, /same as your email/);
  const results = await Promise.all([
    page.submit('welcome', { password: NEW_PASSWORD, confirm: NEW_PASSWORD }),
    page.submit('welcome', { password: NEW_PASSWORD, confirm: NEW_PASSWORD }),
  ]);
  assert.deepEqual(results, [true, false], 'the second click is ignored');
  assert.equal(page.fetchLog.filter((c) => c.path === '/api/welcome' && c.status === 200).length, 1);
  assert.equal(page.hash(), '#/');
  said(page, /Logged in as Demo Admin/);
  assert.equal(page.has('nav'), true);
  wellBuilt(page);

  const other = await w.open();
  await other.goto(`#/welcome?token=${token}`);
  said(other, /This link has expired or was already used/);
  await other.goto('#/login');
  await logIn(other, 'demo-admin@example.com', NEW_PASSWORD);
  assert.equal(other.hash(), '#/');

  await page.goto('#/password');
  said(page, /Change my password/);
  const changed = 'my changed password 2';
  const tries = [
    [{ oldPassword: '', newPassword: changed, confirm: changed }, /type your current password/],
    [{ oldPassword: NEW_PASSWORD, newPassword: 'short', confirm: 'short' }, /at least 8 characters/],
    [{ oldPassword: NEW_PASSWORD, newPassword: changed, confirm: 'something else 22' }, /don't match/],
    [{ oldPassword: NEW_PASSWORD, newPassword: NEW_PASSWORD, confirm: NEW_PASSWORD }, /must be different/],
    [{ oldPassword: 'wrong wrong wrong', newPassword: changed, confirm: changed }, /current password is not correct/],
  ];
  for (const [fields, re] of tries) {
    await page.submit('password', fields);
    said(page, re);
    wellBuilt(page, 'password form with an error');
  }
  assert.equal(countCalls(page, 'POST', /^\/api\/password$/), 1);
  await page.submit('password', { oldPassword: NEW_PASSWORD, newPassword: changed, confirm: changed });
  assert.equal(page.hash(), '#/');
  assert.ok(page.toasts().some((x) => /Your new password is saved/.test(x)));
  await other.clickButton('Log out');
  await logIn(other, 'demo-admin@example.com', NEW_PASSWORD);
  said(other, /Wrong email or password/);
  await logIn(other, 'demo-admin@example.com', changed);
  assert.equal(other.hash(), '#/');
});

// ---------- UAT 2: wrong password and lockout ----------

test('UAT 2: five wrong passwords lock the account for a few minutes', async (t) => {
  const w = await world(t);
  const page = await joinInvite(w, 'demo-admin@example.com', w.demo.invite.token);
  await page.clickButton('Log out');
  assert.equal(page.hash(), '#/login');

  for (let i = 0; i < 5; i++) await logIn(page, 'demo-admin@example.com', `wrong try number ${i}`);
  // Even the right password is refused while locked.
  await logIn(page, 'demo-admin@example.com', NEW_PASSWORD);
  said(page, /Too many tries\. Please wait a few minutes\./);
  assert.equal(page.hash(), '#/login');
  wellBuilt(page);

  w.clock.advance(6 * 60 * 1000);
  await logIn(page, 'demo-admin@example.com', NEW_PASSWORD);
  assert.equal(page.hash(), '#/', page.text());
});

// ---------- UAT 3 to 8: the scheduler's story ----------

const SERVICE_DATE = addDays(todayStr(new Date()), 2); // inside the "next 4 weeks"
const inviteFrom = (page, name) => {
  assert.ok(page.text().includes(`Invite for ${name}`), page.text());
  const m = /Tap this link to choose your password: (\S+) You will log in/.exec(page.text());
  assert.ok(m, `no invite box for ${name}. ON SCREEN: ${page.text()}`);
  return m[1];
};
const gapCount = (page, type) => Number(new RegExp(`data-count="${type}">(\\d+)<`).exec(page.html())?.[1]);
// Tap a show/hide button (a People or Services row, a team) unless it is already open.
const tapOpen = async (page, action, id) => {
  if (!page.html().includes(`data-action="${action}" data-id="${id}" aria-expanded="true"`)) await page.click(action, id);
};
const positionId = async (page, team, name) => {
  const teams = await page.api.get('/api/teams');
  return teams.find((x) => x.name === team).positions.find((p) => p.name === name).id;
};

test('UAT 3 to 8: scheduler adds people, a team, positions, a service, assigns, sees gaps and reminders', async (t) => {
  const w = await world(t);
  const page = await joinInvite(w, 'demo-admin@example.com', w.demo.invite.token);
  const mutations = () => page.fetchLog.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);

  // --- People: add two people ---
  await page.goto('#/people');
  said(page, /Demo Alice/);
  wellBuilt(page);
  await page.clickButton('Add person');
  await page.type('new-name', 'Pat Example');
  await page.submit('add-person', { name: '' });
  said(page, /Please type a name\./);
  wellBuilt(page, 'add person with an error');
  // A double click adds one person, not two.
  const pat = { name: 'Pat Example', email: 'pat.example@example.com' };
  await Promise.all([page.submit('add-person', pat), page.submit('add-person', pat)]);
  assert.equal(countCalls(page, 'POST', /^\/api\/people$/), 1);
  const patLink = inviteFrom(page, 'Pat Example');
  assert.match(tokenFromLink(patLink), /^[A-Za-z0-9_-]{43}$/);
  wellBuilt(page, 'the invite box');
  assert.equal(page.has('#invite-box'), true);
  await page.clickButton('Done');
  assert.equal(page.has('#invite-box'), false, 'the invite is gone once Done is pressed');
  notSaid(page, new RegExp(rx(patLink)));
  await page.clickButton('Add person');
  await page.submit('add-person', { name: 'Quinn Example', email: 'quinn.example@example.com' });
  inviteFrom(page, 'Quinn Example');
  await page.clickButton('Done');
  said(page, /Pat Example \(pat\.example@example\.com\)/);
  said(page, /Quinn Example \(quinn\.example@example\.com\)/);

  // The same email twice is refused in plain words.
  await page.clickButton('Add person');
  await page.submit('add-person', { name: 'Someone Else', email: 'pat.example@example.com' });
  said(page, /That email is already used by someone else/);
  await page.clickButton('Cancel');

  // --- Teams: a team and a position ---
  await page.goto('#/teams');
  await page.submit('add-team', { name: '' });
  said(page, /Please type a name\./);
  await page.submit('add-team', { name: 'Ushers' });
  assert.ok(page.text().includes('Team added.'), page.text());
  const ushers = (await page.api.get('/api/teams')).find((x) => x.name === 'Ushers');
  await page.click('add-position', ushers.id);
  await page.submit('add-position', { name: 'Door' });
  said(page, /Position added\./);
  said(page, /Nobody is qualified yet/);
  wellBuilt(page, 'teams');
  const door = await positionId(page, 'Ushers', 'Door');

  // --- People: say who can do the new position ---
  await page.goto('#/people');
  const patId = personId(page, 'Pat Example');
  const quinnId = personId(page, 'Quinn Example');
  for (const id of [patId, quinnId]) {
    await tapOpen(page, 'select', id);
    await page.click('positions', id);
    said(page, /What can (Pat|Quinn) Example do\?/);
    wellBuilt(page, 'the positions checklist');
    await page.tick('toggle-position', { position: door });
    await page.click('positions-save', id);
  }
  said(page, /Saved what Quinn Example can do\./);
  await page.goto('#/teams');
  notSaid(page, /can do this/, 'teams start closed');
  await tapOpen(page, 'toggle-team', ushers.id);
  said(page, /2 people can do this/);
  assert.deepEqual([page.focused?.attrs.get('data-action'), page.focused?.attrs.get('aria-expanded')], ['toggle-team', 'true'], 'focus stays on the team that was opened');

  // --- Services: a date with two Door positions ---
  await page.goto('#/services');
  wellBuilt(page);
  await page.submit('create', { date: '', time: '19:00', title: 'Midweek prayer' });
  said(page, /Please pick a date\./);
  await page.submit('create', { date: SERVICE_DATE, time: '19:00', title: 'Midweek prayer', [`pos-${door}`]: true, [`count-${door}`]: '0' });
  said(page, /How many Door\? Please type a number from 1 to 20\./);
  assert.match(page.html(), /value="Midweek prayer"/, 'what was typed is kept after a mistake');
  await Promise.all([
    page.submit('create', { date: SERVICE_DATE, time: '19:00', title: 'Midweek prayer', [`pos-${door}`]: true, [`count-${door}`]: '2' }),
    page.submit('create', { date: SERVICE_DATE, time: '19:00', title: 'Midweek prayer', [`pos-${door}`]: true, [`count-${door}`]: '2' }),
  ]);
  assert.equal(countCalls(page, 'POST', /^\/api\/services$/), 1, 'the mistakes never left the page, and the double click sent one');
  said(page, /Service added for/);
  said(page, /Midweek prayer/);
  said(page, /Ushers: Door x2\./);
  wellBuilt(page, 'services');
  const service = (await page.api.get(`/api/services?from=${SERVICE_DATE}&to=${SERVICE_DATE}`)).find((x) => x.title === 'Midweek prayer');
  assert.equal(service.slots.length, 2);
  const [slotA, slotB] = service.slots.map((s) => s.id);

  // --- Schedule: assign Pat ---
  await page.goto('#/schedule');
  said(page, /Midweek prayer|Door/);
  // On a phone each date is a closed card that says how it stands; tapping it lists its positions.
  assert.match(page.html(), new RegExp(`data-action="toggle-service" data-id="${service.id}" aria-expanded="false"[\\s\\S]*?2 open`));
  await tapOpen(page, 'toggle-service', service.id);
  assert.match(page.html(), new RegExp(`data-card="${service.id}"[\\s\\S]*?<h3 class="team-title">Ushers</h3>`));
  assert.equal(page.focused?.attrs.get('data-action'), 'toggle-service', 'focus stays on the card that was opened');
  wellBuilt(page, 'an open schedule card');
  await page.click('slot-open', slotA);
  said(page, /Who could do this/);
  said(page, /Pat Example/);
  said(page, /Quinn Example/);
  assert.match(page.focusedText(), /Door/, 'focus moves to the panel heading');
  wellBuilt(page, 'the slot panel');
  await Promise.all([page.click('slot-assign', patId), page.click('slot-assign', patId)]);
  assert.equal(countCalls(page, 'PUT', /assign/), 1, 'a double click assigns once');
  said(page, /Pat Example is now on Door/);
  said(page, /Waiting for their answer/);
  assert.equal(page.has('[data-slot-panel]'), false, 'the panel closes after assigning');

  // Pat is already serving at this service, so the second Door does not offer Pat.
  await page.click('slot-open', slotB);
  said(page, /Quinn Example/);
  assert.equal(page.has(`[data-action="slot-assign"][data-id="${patId}"]`), false, 'someone already serving here is not suggested again');
  await page.click('slot-close');
  assert.equal(page.has('[data-slot-panel]'), false);

  // --- Gaps: the second Door is open; fill it from here ---
  await page.goto('#/gaps');
  const openBefore = gapCount(page, 'open');
  assert.ok(openBefore >= 1, page.text());
  said(page, /Nobody yet/);
  said(page, /Door \(Ushers\)/);
  wellBuilt(page, 'gaps');
  await page.click('slot-open', slotB);
  said(page, /Quinn Example/);
  await page.click('slot-assign', quinnId);
  said(page, /Quinn Example is now on Door/);
  assert.equal(gapCount(page, 'open'), openBefore - 1, 'one gap fewer');

  // --- Reminders: drafted to copy, never sent ---
  said(page, /Flock never sends messages/);
  await page.submit('reminders', { weekOf: SERVICE_DATE });
  said(page, /Pat Example/);
  assert.equal(page.count('[data-reminder]') >= 2, true, 'a message each for Pat and Quinn');
  wellBuilt(page, 'reminders');
  assert.ok(page.fetchLog.filter((c) => /reminders/.test(c.path)).every((c) => c.method === 'GET'), 'drafting a reminder only reads');
  assert.deepEqual(mutations().filter((m) => /remind|send|mail|sms/i.test(m)), [], 'nothing was ever sent');

  // Everything the scheduler did changed only the expected things.
  assert.ok(mutations().every((m) => /\/api\/(people|teams|positions|services|slots|password|login|welcome)/.test(m)), mutations().join('\n'));

});

// ---------- shared: the scheduler makes a replacement invite (UAT 12) ----------

async function resetByScheduler(admin, name) {
  await admin.goto('#/people');
  const id = personId(admin, name);
  await tapOpen(admin, 'select', id);
  await admin.click('reset-ask', id);
  said(admin, new RegExp(`Reset the login of ${rx(name)}\\? Their password and any linked sign-in`));
  const resets = countCalls(admin, 'POST', /reset-login/);
  await Promise.all([admin.click('reset-yes', id), admin.click('reset-yes', id)]);
  assert.equal(countCalls(admin, 'POST', /reset-login/), resets + 1, 'a double click resets once');
  const token = tokenFromLink(inviteFrom(admin, name));
  await admin.clickButton('Done');
  return { id, token };
}

async function volunteerOnPhone(w, admin, name, email) {
  const { id, token } = await resetByScheduler(admin, name);
  const phone = await joinInvite(w, email, token);
  return { phone, id, jar: phone.jar, token };
}

// ---------- UAT 9 to 11: a volunteer on a phone ----------

test('UAT 9 to 11: volunteer sees My schedule, says yes and no, adds and removes a day off', async (t) => {
  const w = await world(t);
  const admin = await joinInvite(w, 'demo-admin@example.com', w.demo.invite.token);

  // Give Alice two waiting requests and a confirmed one, so each button has something to act on.
  const services = await admin.api.get(`/api/services?from=${todayStr(new Date())}&to=${addDays(todayStr(new Date()), 60)}`);
  const { id: aliceId, token } = await resetByScheduler(admin, 'Demo Alice');
  const free = services.filter((s) => !s.slots.some((x) => x.personId === aliceId) && s.slots.some((x) => x.personId === null));
  const picks = free.slice(0, 3).map((s) => s.slots.find((x) => x.personId === null).id);
  assert.equal(picks.length, 3);
  for (const slot of picks) await admin.api.put(`/api/slots/${slot}/assign`, { personId: aliceId, force: true });
  await w.app.container.services.assignments.respond(aliceId, picks[2], 'accept');

  // First login on the phone.
  const phone = await joinInvite(w, 'demo.alice', token);
  said(phone, /Logged in as Demo Alice/);
  said(phone, /Coming up/);
  said(phone, /Please answer/);
  assert.match(phone.html(), /data-banner>You&#39;re serving|data-banner>Next time you serve/, 'the banner tells the next time');
  wellBuilt(phone, 'My schedule');

  // A volunteer sees no scheduler pages, and cannot reach them by typing the address.
  for (const [href] of [['#/people'], ['#/teams'], ['#/services'], ['#/schedule'], ['#/gaps']]) {
    assert.equal(phone.has(`a[href="${href}"]`), false, `${href} is not in the menu`);
    await phone.goto(href);
    assert.equal(phone.hash(), '#/', `${href} sends a volunteer home`);
  }
  assert.equal(phone.has('a[href="#/blockouts"]'), true);
  assert.equal(phone.count('[aria-current="page"]'), 1, 'exactly one menu item says "you are here"');
  assert.deepEqual(await phone.api.get('/api/people').catch((e) => e.status), 403, 'and the server agrees');

  // Yes, I can: one request even on a double click.
  const waiting = () => [...phone.html().matchAll(/<li class="card serve-card is-pending" data-slot="(\d+)">/g)].map((m) => Number(m[1]));
  const [first, second] = waiting();
  assert.ok(first && second, 'two waiting requests');
  const buttonsBefore = phone.buttons().map((b) => b.label);
  assert.ok(buttonsBefore.includes('Yes, I can') && buttonsBefore.includes("I can't"));
  const results = await Promise.all([phone.click('accept', first), phone.click('accept', first)]);
  assert.deepEqual(results, [true, false], 'the second tap lands on a disabled button');
  assert.equal(countCalls(phone, 'POST', new RegExp(`/api/me/slots/${first}/accept`)), 1);
  assert.ok(phone.toasts().some((x) => /Thank you! You are confirmed\./.test(x)), phone.text());
  assert.equal(waiting().includes(first), false, 'it no longer asks for an answer');
  wellBuilt(phone, 'after saying yes');

  // The confirmed card stays, and opens the full roster of that day: every team and position, me included.
  assert.equal(phone.has(`[data-slot="${first}"]`), true, 'the confirmed card stays in Coming up');
  assert.equal(phone.has(`[data-roster="${first}"]`), false, 'the roster starts closed');
  await phone.click('roster', first);
  assert.equal(phone.has(`[data-roster="${first}"]`), true);
  const roster = phone.html().slice(phone.html().indexOf(`data-roster="${first}"`));
  assert.match(roster, /<strong>You<\/strong>/);
  assert.match(roster, /Demo [A-Z][a-z]+/, 'other people serving that day are named');
  assert.match(roster, /class="team-title"/);
  wellBuilt(phone, 'the full roster');
  await phone.click('roster', first);
  assert.equal(phone.has(`[data-roster="${first}"]`), false);

  // I can't: asks nothing more, tells the scheduler will find someone.
  await phone.click('decline', second);
  assert.ok(phone.toasts().some((x) => /Your scheduler will find someone else/.test(x)), phone.text());
  assert.equal(phone.has(`[data-slot="${second}"]`), false, 'a declined request leaves my list');

  // Changing my mind about a confirmed one asks "Are you sure?" first.
  await phone.click('decline-ask', first);
  said(phone, /Are you sure you can't serve on/);
  wellBuilt(phone, 'the are-you-sure box');
  const sends = phone.fetchLog.length;
  await phone.click('keep', first);
  notSaid(phone, /Are you sure/);
  assert.equal(phone.fetchLog.length, sends, 'No, keep me on sends nothing');
  await phone.click('decline-ask', first);
  await phone.click('decline-sure', first);
  assert.equal(phone.has(`[data-slot="${first}"]`), false);

  // The scheduler sees the answers.
  await admin.goto('#/gaps');
  assert.ok(gapCount(admin, 'declined') >= 2, `Said no: ${gapCount(admin, 'declined')}`);

  // Days I can't serve.
  await phone.clickLink(/Days I can't serve/);
  assert.equal(phone.hash(), '#/blockouts');
  assert.match(phone.focusedText(), /Days I can't serve/);
  wellBuilt(phone, 'days off');
  said(phone, /Demo conference/, 'the demo gives Alice one day off already');
  const removeIds = () => [...phone.html().matchAll(/data-action="remove" data-id="(\d+)"/g)].map((m) => Number(m[1]));
  const already = removeIds();
  assert.equal(already.length, 1);
  await phone.submit('blockout', { from: '', to: '', reason: '' });
  said(phone, /Please pick/);
  await phone.submit('blockout', { from: '2099-05-10', to: '2099-05-09' });
  said(phone, /be before the/);
  const post = countCalls(phone, 'POST', /blockouts/);
  assert.equal(post, 0, 'mistakes are caught before anything is sent');

  // A day off on a day I am scheduled warns me to tell the scheduler.
  const mine = await phone.api.get('/api/me/schedule');
  const busyDay = mine.items.find((i) => i.slotId === picks[2]).date;
  const futureDay = addDays(todayStr(new Date()), 200);
  await Promise.all([
    phone.submit('blockout', { from: futureDay, to: futureDay, reason: 'Family trip' }),
    phone.submit('blockout', { from: futureDay, to: futureDay, reason: 'Family trip' }),
  ]);
  assert.equal(countCalls(phone, 'POST', /blockouts/), 1, 'a double click adds one day off');
  said(phone, /Saved\. You are off/);
  said(phone, /Family trip/);
  await phone.submit('blockout', { from: busyDay, to: busyDay, reason: '' });
  said(phone, /You are already scheduled on .* Please tell your scheduler\./);
  wellBuilt(phone, 'days off with a warning');

  // Remove them again.
  const added = removeIds().filter((id) => !already.includes(id));
  assert.equal(added.length, 2);
  for (const id of added) await phone.click('remove', id);
  said(phone, /Removed\. You can be scheduled on those days again\./);
  notSaid(phone, /Family trip/);
  assert.deepEqual(removeIds(), already, 'only the two I added are gone');

  // Log out.
  await phone.clickButton('Log out');
  assert.equal(phone.hash(), '#/login');
  assert.equal(phone.jar.cookie, '', 'the login cookie is gone');
  assert.equal(phone.has('nav'), false);
});

// ---------- UAT 12 to 15: access level, deactivate, reset, logout, expiry ----------

test('UAT 12 to 15: change access level, deactivate, reset password, log out, session expiry', async (t) => {
  const w = await world(t);
  const admin = await joinInvite(w, 'demo-admin@example.com', w.demo.invite.token);
  const bob = await volunteerOnPhone(w, admin, 'Demo Bob', 'demo.bob@example.com');
  const bobLogin = async () => {
    const p = await w.open();
    await logIn(p, 'demo.bob@example.com', NEW_PASSWORD);
    return p;
  };
  await admin.goto('#/people');

  // The scheduler cannot change or deactivate their own access by accident.
  const me = personId(admin, 'Demo Admin');
  await tapOpen(admin, 'select', me);
  assert.deepEqual([admin.focused?.attrs.get('data-action'), admin.focused?.attrs.get('data-id')], ['select', String(me)], 'focus stays on the row that was opened');
  assert.equal(admin.has(`[data-action="edit"][data-id="${me}"]`), true, 'my own row is open');
  assert.equal(admin.has(`[data-action="role-ask"][data-id="${me}"]`), false, 'no role button on my own row');
  said(admin, /That's you/);
  await admin.click('active-ask', me);
  await admin.click('deactivate-yes', me);
  said(admin, /can't deactivate your own account/);
  wellBuilt(admin, 'a refused change');

  // Volunteer -> scheduler. "No, go back" sends nothing.
  await tapOpen(admin, 'select', bob.id);
  await admin.click('role-ask', bob.id);
  said(admin, /Make Demo Bob a scheduler\? Demo Bob will be able to change the whole schedule/);
  wellBuilt(admin, 'the role question');
  const sent = admin.fetchLog.length;
  await admin.clickButton('No, go back');
  assert.equal(admin.fetchLog.length, sent);
  await admin.click('role-ask', bob.id);
  const patches = countCalls(admin, 'PATCH', /\/api\/people\//);
  await Promise.all([admin.clickButton('Yes, make a scheduler'), admin.clickButton('Yes, make a scheduler')]);
  assert.equal(countCalls(admin, 'PATCH', /\/api\/people\//), patches + 1, 'a double click changes it once');
  said(admin, /Demo Bob is now a scheduler\./);
  assert.match(admin.html(), new RegExp(`data-person="${bob.id}"[\\s\\S]*?Scheduler`));

  // Bob opens Flock again and now sees the scheduler pages.
  const bobAdmin = await w.open(bob.jar);
  assert.equal(bobAdmin.has('a[href="#/people"]'), true);
  await bobAdmin.goto('#/people');
  assert.equal(bobAdmin.hash(), '#/people');
  said(bobAdmin, /Demo Alice/);

  // Scheduler -> volunteer again: the scheduler pages are gone and the server refuses them.
  await tapOpen(admin, 'select', bob.id);
  await admin.click('role-ask', bob.id);
  await admin.clickButton('Yes, make a volunteer');
  said(admin, /Demo Bob is now a volunteer\./);
  const bobBack = await w.open(bob.jar);
  assert.equal(bobBack.has('a[href="#/people"]'), false);
  await bobBack.goto('#/people');
  assert.equal(bobBack.hash(), '#/');
  // The old tab still looks like a scheduler's, but the server no longer allows it.
  await bobAdmin.goto('#/gaps');
  said(bobAdmin, /Only the scheduler can do that/);
  await bobAdmin.goto('#/teams');
  await bobAdmin.submit('add-team', { name: 'Sneaky team' });
  said(bobAdmin, /Only the scheduler can do that/);
  assert.equal((await admin.api.get('/api/teams')).some((x) => x.name === 'Sneaky team'), false);

  // Deactivate: asks first; the open tab is told to log in again; login is refused.
  await tapOpen(admin, 'select', bob.id);
  await admin.click('active-ask', bob.id);
  said(admin, /Deactivate Demo Bob\? They will not be able to log in/);
  await admin.clickButton('No, go back');
  notSaid(admin, /Yes, deactivate/);
  await admin.click('active-ask', bob.id);
  await admin.click('deactivate-yes', bob.id);
  said(admin, /Demo Bob is deactivated\. Their history is kept\./);
  assert.match(admin.html(), />Deactivated<\/span>/);
  await bob.phone.goto('#/blockouts');
  assert.equal(bob.phone.hash(), '#/login');
  said(bob.phone, /Please log in again\./);
  await logIn(bob.phone, 'demo.bob@example.com', NEW_PASSWORD);
  said(bob.phone, /Wrong email or password/);
  assert.equal(bob.phone.hash(), '#/login');

  // Reactivate: the same password works again.
  await tapOpen(admin, 'select', bob.id);
  await admin.click('active-ask', bob.id);
  said(admin, /Reactivate Demo Bob\?/);
  await admin.click('reactivate-yes', bob.id);
  said(admin, /Demo Bob is active again\./);
  const again = await bobLogin();
  assert.equal(again.hash(), '#/');

  // Reset password: the old password stops working; the new invite chooses its replacement.
  const reset = await resetByScheduler(admin, 'Demo Bob');
  await again.goto('#/blockouts');
  assert.equal(again.hash(), '#/login', 'a reset ends the old logins');
  const stale = await w.open();
  await logIn(stale, 'demo.bob@example.com', NEW_PASSWORD);
  said(stale, /Wrong email or password/);
  await stale.goto(`#/welcome?token=${reset.token}`);
  await stale.submit('welcome', { password: 'bobs newest password', confirm: 'bobs newest password' });
  assert.equal(stale.hash(), '#/');

  // Log out; the back button and typing an address do not get back in.
  await stale.clickButton('Log out');
  assert.equal(stale.hash(), '#/login');
  assert.equal(stale.has('nav'), false);
  for (const to of ['#/', '#/blockouts', '#/people']) {
    await stale.goto(to);
    assert.equal(stale.hash(), '#/login', `${to} after logging out`);
  }
  const reloaded = await w.open(stale.jar);
  assert.equal(reloaded.hash(), '#/login');

  // Session expiry: 15 days later the next click says "Please log in again."
  await admin.goto('#/people');
  w.clock.advance(15 * 24 * 60 * 60 * 1000);
  await admin.goto('#/gaps');
  assert.equal(admin.hash(), '#/login');
  said(admin, /Please log in again\./);
  assert.equal(admin.has('nav'), false);
  await logIn(admin, 'demo-admin@example.com', NEW_PASSWORD);
  assert.equal(admin.hash(), '#/', admin.text());
});

// ---------- UAT 20 (part): typed text is always shown as text ----------

const HOSTILE = {
  team: '<img src=x onerror=alert(1)>Team',
  position: '"><script>alert(2)</script>',
  person: '<b onmouseover=alert(3)>Eve</b>',
  title: "<svg onload=alert(4)>Party' & more",
  reason: '<script>alert(5)</script>',
};

test('UAT 20 (odd text): hostile and odd text is shown as plain text on every page', async (t) => {
  const w = await world(t);
  const admin = await joinInvite(w, 'demo-admin@example.com', w.demo.invite.token);

  // Typed in through the forms, like a real (mischievous) scheduler would.
  await admin.goto('#/teams');
  await admin.submit('add-team', { name: HOSTILE.team });
  const team = (await admin.api.get('/api/teams')).find((x) => x.name === HOSTILE.team);
  assert.ok(team, 'the team was saved with its text unchanged');
  await admin.click('add-position', team.id);
  await admin.submit('add-position', { name: HOSTILE.position });
  said(admin, /"><script>alert\(2\)<\/script>/);
  const pos = (await positionId(admin, HOSTILE.team, HOSTILE.position));
  wellBuilt(admin, 'teams');

  await admin.goto('#/people');
  await admin.clickButton('Add person');
  await admin.submit('add-person', { name: HOSTILE.person, email: 'eve@example.com' });
  const eveLink = inviteFrom(admin, HOSTILE.person);
  await admin.clickButton('Done');
  said(admin, /<b onmouseover=alert\(3\)>Eve<\/b>/);
  const eve = personId(admin, HOSTILE.person);
  await tapOpen(admin, 'select', eve);
  await admin.click('positions', eve);
  await admin.tick('toggle-position', { position: pos });
  await admin.click('positions-save', eve);
  wellBuilt(admin, 'people');

  await admin.goto('#/services');
  await admin.submit('create', { date: SERVICE_DATE, time: '20:00', title: HOSTILE.title, [`pos-${pos}`]: true, [`count-${pos}`]: '2' });
  said(admin, /<svg onload=alert\(4\)>Party' & more/);
  wellBuilt(admin, 'services');
  const svc = (await admin.api.get(`/api/services?from=${SERVICE_DATE}&to=${SERVICE_DATE}`)).find((x) => x.title === HOSTILE.title);
  const [slotA, slotB] = svc.slots.map((s) => s.id);
  await tapOpen(admin, 'select', svc.id);
  await admin.click('delete', svc.id);
  said(admin, /<svg onload=alert\(4\)>Party' & more on/);
  wellBuilt(admin, 'delete question');
  await admin.click('cancel');

  await admin.goto('#/schedule');
  await admin.click('slot-open', slotA);
  said(admin, /<b onmouseover=alert\(3\)>Eve<\/b>/);
  wellBuilt(admin, 'slot panel with hostile names');
  await admin.click('slot-assign', eve);
  said(admin, /<b onmouseover=alert\(3\)>Eve<\/b> is now on/);
  wellBuilt(admin, 'schedule');

  await admin.goto('#/gaps');
  said(admin, /"><script>alert\(2\)<\/script> \(<img src=x onerror=alert\(1\)>Team\)/);
  wellBuilt(admin, 'gaps');
  await admin.click('slot-open', slotB);
  wellBuilt(admin, 'gap panel');
  await admin.click('slot-close');
  await admin.submit('reminders', { weekOf: SERVICE_DATE });
  said(admin, /<b onmouseover=alert\(3\)>Eve<\/b>/);
  wellBuilt(admin, 'reminders');

  // The same person's own view: menu, schedule, days off.
  const email = (await admin.api.get('/api/people')).find((p) => p.name === HOSTILE.person).email;
  const phone = await w.open();
  await phone.goto(`#/welcome?token=${tokenFromLink(eveLink)}`);
  said(phone, new RegExp(rx(email)));
  wellBuilt(phone, 'welcome with a hostile name');
  await phone.submit('welcome', { password: NEW_PASSWORD, confirm: NEW_PASSWORD });
  said(phone, /Logged in as <b onmouseover=alert\(3\)>Eve<\/b>/);
  said(phone, /"><script>alert\(2\)<\/script>/);
  said(phone, /<svg onload=alert\(4\)>Party' & more/);
  wellBuilt(phone, 'my schedule');
  await phone.goto('#/blockouts');
  const day = addDays(todayStr(new Date()), 120);
  await phone.submit('blockout', { from: day, to: day, reason: HOSTILE.reason });
  said(phone, /<script>alert\(5\)<\/script>/);
  wellBuilt(phone, 'days off');
  // And the form shows what was typed with quotes kept safe.
  await phone.submit('blockout', { from: '', to: '', reason: '"><img src=x onerror=alert(6)>' });
  wellBuilt(phone, 'days off form with a mistake');
  assert.ok(!phone.html().includes('<img'), 'no image tag was made');

  // Every page, once more, for any leftover markup.
  for (const h of ['#/', '#/blockouts']) { await phone.goto(h); wellBuilt(phone); }
  for (const h of ['#/', '#/blockouts', '#/people', '#/teams', '#/services', '#/schedule', '#/gaps']) { await admin.goto(h); wellBuilt(admin); }
});

// ---------- UAT 20: things to try to break it ----------

test('UAT 20: double clicks, odd names, stale tabs, rapid page changes and the back button', async (t) => {
  const w = await world(t);
  const admin = await joinInvite(w, 'demo-admin@example.com', w.demo.invite.token);
  const tab2 = await w.open(admin.jar); // the same login in a second tab

  // Very long and odd names.
  await admin.goto('#/people');
  await admin.clickButton('Add person');
  assert.match(admin.html(), /id="new-name"[^>]*maxlength="80"/, 'the name box stops at 80 letters');
  const longName = 'L'.repeat(81);
  await admin.submit('add-person', { name: longName });
  assert.equal(admin.has('#invite-box'), false, 'a too-long name was refused');
  assert.match(admin.text(), /\S/);
  assert.equal(admin.has('[role="alert"]'), true, 'and a message says so');
  said(admin, /The name must be 1 to 80 characters long\./);
  wellBuilt(admin, 'too-long name');
  const exact = 'M'.repeat(80);
  await admin.submit('add-person', { name: exact, email: 'm80@example.com' });
  said(admin, new RegExp(`Invite for ${exact}`));
  await admin.clickButton('Done');
  said(admin, new RegExp(exact), 'an 80-letter name is shown whole');
  await admin.clickButton('Add person');
  await admin.submit('add-person', { name: '   ' });
  said(admin, /Please type a name\./);
  await admin.submit('add-person', { name: 'Zoë 🎺 Trumpet', email: 'zoe@example.com' });
  said(admin, /Invite for Zoë 🎺 Trumpet/);
  await admin.clickButton('Done');
  said(admin, /Zoë 🎺 Trumpet \(zoe@example\.com\)/);
  await admin.clickButton('Add person');
  await admin.submit('add-person', { name: '🎺🎺🎺' });
  said(admin, /🎺🎺🎺 is added\. Without an email they cannot log in/, 'someone without an email can still be added');
  wellBuilt(admin, 'emoji names');
  said(admin, /No email, cannot log in/);

  // A team name that already exists, and deleting a team that is in use: told in words, page still works.
  await admin.goto('#/teams');
  await admin.submit('add-team', { name: 'Band' });
  assert.equal(admin.has('[role="alert"]'), true, admin.text());
  wellBuilt(admin, 'duplicate team');
  const band = (await admin.api.get('/api/teams')).find((x) => x.name === 'Band');
  await tapOpen(admin, 'toggle-team', band.id);
  await admin.click('delete-team', band.id);
  said(admin, /Delete the team Band\?/);
  await Promise.all([admin.click('delete-team-yes', band.id), admin.click('delete-team-yes', band.id)]);
  assert.equal(countCalls(admin, 'DELETE', /\/api\/teams\//), 1, 'a double click on delete sends once');
  assert.ok((await admin.api.get('/api/teams')).some((x) => x.name === 'Band'), 'the team in use is still there');
  said(admin, /Band/);
  wellBuilt(admin, 'refused delete');

  // Two tabs: one deletes a service, the other (stale) tries to delete it too.
  await admin.goto('#/services');
  await tab2.goto('#/services');
  const upcoming = await admin.api.get(`/api/services?from=${todayStr(new Date())}&to=${addDays(todayStr(new Date()), 60)}`);
  const victim = upcoming[0]; // a demo service with people on it

  // Repeat for more weeks: from the last service, two new weeks are added; from a service whose next weeks exist, they are skipped.
  await tapOpen(admin, 'select', upcoming[upcoming.length - 1].id);
  await admin.click('repeat', upcoming[upcoming.length - 1].id);
  await admin.submit('repeat', { weeks: '0' });
  said(admin, /Please type a number of weeks from 1 to 26\./);
  await admin.submit('repeat', { weeks: '2' });
  said(admin, /Added 2 more services\./);
  await tapOpen(admin, 'select', victim.id);
  await admin.click('repeat', victim.id);
  await admin.submit('repeat', { weeks: '1' });
  said(admin, /Added 0 more services\. Skipped .*there is already a service then\./);
  wellBuilt(admin, 'repeat');
  await tapOpen(admin, 'select', victim.id);
  await admin.click('delete', victim.id);
  said(admin, /people are scheduled on this date\.|person is scheduled on this date\./);
  await Promise.all([admin.click('delete-yes', victim.id), admin.click('delete-yes', victim.id)]);
  assert.equal(countCalls(admin, 'DELETE', /\/api\/services\//), 1);
  said(admin, /Service deleted\./);
  await tapOpen(tab2, 'select', victim.id);
  await tab2.click('delete', victim.id);
  await tab2.click('delete-yes', victim.id);
  assert.equal(tab2.has('[role="alert"]'), true, `the stale tab is told: ${tab2.text()}`);
  assert.equal(tab2.has('nav'), true, 'and the page still works');
  wellBuilt(tab2, 'stale tab');

  // Rapid page changes: the last page asked for wins, nothing flashes an error.
  for (const h of ['#/people', '#/teams', '#/services', '#/schedule', '#/gaps', '#/people']) tab2.win.location.hash = h;
  await tab2.settle();
  assert.equal(tab2.hash(), '#/people');
  said(tab2, /Everyone in the church you schedule\./);
  assert.equal(tab2.has('.toast-error'), false);
  notSaid(tab2, /What still needs someone|The next 8 weeks/);
  wellBuilt(tab2, 'after rapid changes');

  // The back button: go back through pages already visited.
  for (const h of ['#/teams', '#/people', '#/gaps']) {
    await tab2.goto(h);
    wellBuilt(tab2);
  }
  assert.equal(tab2.count('.toast'), 0, 'old messages do not pile up');

  // Two tabs, one logs out: the other asks to log in again.
  await admin.clickButton('Log out');
  assert.equal(admin.hash(), '#/login');
  await tab2.goto('#/schedule');
  assert.equal(tab2.hash(), '#/login');
  said(tab2, /Please log in again\./);
  wellBuilt(tab2, 'logged out in another tab');

  // A volunteer's days-off form: a very long reason is cut off or refused, never crashes.
  const alice = await volunteerOnPhone(w, await (async () => {
    const a = await w.open();
    await logIn(a, 'demo-admin@example.com', NEW_PASSWORD);
    return a;
  })(), 'Demo Alice', 'demo.alice@example.com');
  await alice.phone.goto('#/blockouts');
  assert.match(alice.phone.html(), /id="bo-reason"[^>]*maxlength="200"/);
  const day = addDays(todayStr(new Date()), 150);
  await alice.phone.submit('blockout', { from: day, to: day, reason: 'x'.repeat(201) });
  assert.ok(alice.phone.has('[role="alert"]') || alice.phone.has('.toast-error'), alice.phone.text());
  wellBuilt(alice.phone, 'a reason that is too long');
});

// ---------- UAT 16 to 19 (the parts a computer can check) ----------

test('UAT 16 to 19 (what a computer can check): every page has named controls, one heading, one "you are here" and sensible focus', async (t) => {
  const w = await world(t);
  const admin = await joinInvite(w, 'demo-admin@example.com', w.demo.invite.token);
  const alice = await volunteerOnPhone(w, admin, 'Demo Alice', 'demo.alice@example.com');

  for (const [who, page] of [['scheduler', admin], ['volunteer', alice.phone]]) {
    const allowed = routes.filter((r) => r.label && (who === 'scheduler' || r.role !== 'admin'));
    assert.ok(allowed.length >= (who === 'scheduler' ? 7 : 2));
    for (const r of allowed) {
      const hash = `#${r.path}`;
      await page.goto(hash === '#/' ? '#/blockouts' : '#/');
      await page.goto(hash);
      const where = `${who} on ${hash}`;
      wellBuilt(page, where);
      assert.equal(page.count('main h1, h1'), 1, `one heading on ${where}`);
      assert.equal(page.count('[aria-current="page"]'), 1, `one current menu item on ${where}`);
      assert.equal(page.focused?.name, 'h1', `focus moves to the heading on ${where}`);
      assert.match(page.title(), / – Flock$/);
      assert.ok(page.buttons().every((b) => b.label), `every button has a name on ${where}`);
      assert.ok(page.has('nav[aria-label="Main menu"]'), `the menu has a name on ${where}`);
    }
  }
  // An address that does not exist gets a friendly page, not a blank one.
  await alice.phone.goto('#/no-such-page');
  assert.equal(alice.phone.has('h1'), true);
  wellBuilt(alice.phone, 'not found');
  // The login and password pages have labelled fields too.
  const out = await w.open();
  wellBuilt(out, 'login');
  assert.match(out.html(), /<label for="login-email">Email<\/label>/);
  assert.match(out.html(), /<label for="login-password">Password<\/label>/);
});

test('UAT 16 to 19 (what a computer can check): the style sheet and page shell carry what dark mode, keyboard and phone checks need', () => {
  const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  const shell = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(css, /prefers-color-scheme:\s*dark/, 'a dark colour scheme exists');
  assert.match(css, /:focus-visible/, 'a visible keyboard focus outline exists');
  assert.match(css, /@media \(max-width:\s*\d+px\)/, 'phone-width rules exist');
  assert.match(shell, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
  assert.match(shell, /<html lang="en">/);
  assert.match(shell, /<meta name="color-scheme" content="light dark">/);
});
