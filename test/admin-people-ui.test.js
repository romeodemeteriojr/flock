import test from 'node:test';
import assert from 'node:assert/strict';
import * as people from '../web/views/admin-people.js';
import * as teamsView from '../web/views/admin-teams.js';
import { ApiError } from '../web/api.js';
import { fakeRoot, fakeApi } from './helpers/fakeui.js';
import { inviteMessage } from '../web/lib/invite.js';

const apiErr = (status, message) => new ApiError({ status, message });
const P = (id, name, email, extra = {}) => ({ id, name, email, role: 'member', active: true, joined: true, positionIds: [], ...extra });
const INVITE = { link: 'https://flock.example.org/#/welcome?token=' + 'i'.repeat(43), localOnly: false };
const TEAMS = [
  { id: 1, name: 'Band', positions: [{ id: 10, name: 'Drums', qualifiedPersonIds: [2] }, { id: 11, name: 'Keys', qualifiedPersonIds: [] }] },
  { id: 2, name: 'Sound', positions: [{ id: 20, name: 'Mixer', qualifiedPersonIds: [2, 3] }] },
];
const PEOPLE = [P(1, 'Ann Admin', 'ann@example.com', { role: 'admin' }), P(2, 'Sam Ortiz', 'sam.ortiz@example.com', { positionIds: [10] }), P(3, 'Old Joe', 'joe@example.com', { active: false })];

async function setup(extra = {}) {
  const api = fakeApi({ 'GET /api/people': PEOPLE, 'GET /api/teams': TEAMS, ...extra });
  const root = fakeRoot();
  const s = people.createScreen({ api, root });
  await s.ready;
  api.calls.length = 0;
  return { api, root, s };
}
const flush = () => new Promise((r) => setImmediate(r));

// The open person sheet (everything after the list).
const sheetOf = (root) => { const h = root.innerHTML; const i = h.indexOf('data-person-sheet'); return i < 0 ? '' : h.slice(i); };
const sheetActions = (root) => [...sheetOf(root).matchAll(/data-action="(edit|positions|reset-ask|active-ask|role-ask|invite)" data-id="(\d+)"/g)].map((x) => `${x[1]} ${x[2]}`);

test('list shows name, email, role and Deactivated marker', async () => {
  const { root } = await setup();
  assert.match(root.innerHTML, /Sam Ortiz/);
  assert.match(root.innerHTML, /sam\.ortiz@example\.com/);
  assert.match(root.innerHTML, /chip-info"><span class="icon chip-icon" data-icon="shield" aria-hidden="true"><\/span>Scheduler</);
  assert.equal(root.innerHTML.match(/Deactivated<\/span>/g).length, 1);
  assert.match(root.innerHTML, /<button type="button" class="menu-row person-row is-inactive" data-action="select" data-id="3" aria-haspopup="dialog">/);
  assert.doesNotMatch(root.innerHTML, /data-action="active-ask"/, 'no actions until a person is opened');
  assert.match(root.innerHTML, /data-action="add-open" aria-label="Add a person" aria-haspopup="dialog"/);
  root.click('select', 3);
  assert.match(sheetOf(root), /Reactivate/);
});

test('tapping a person opens their sheet with what you can do; Back and close; nothing is sent', async () => {
  const { api, root } = await setup();
  assert.deepEqual(sheetActions(root), []);
  root.click('select', 2);
  assert.match(sheetOf(root), /role="dialog" aria-modal="true" aria-labelledby="person-name"/);
  assert.match(sheetOf(root), /<h2 class="account-name" id="person-name" tabindex="-1">Sam Ortiz<\/h2><p class="account-sub">Volunteer · sam\.ortiz@example\.com<\/p>/);
  assert.deepEqual(sheetActions(root), ['positions 2', 'edit 2', 'role-ask 2', 'reset-ask 2', 'active-ask 2']);
  assert.match(sheetOf(root), /Positions<\/span><span class="menu-end">Drums/, 'the positions they can do, in words');
  root.click('select', 1);
  assert.deepEqual(sheetActions(root), ['positions 1', 'edit 1', 'role-ask 1', 'reset-ask 1', 'active-ask 1']);
  // A step takes the rows' place; its Back / Cancel shows the rows again.
  root.click('edit', 1);
  assert.match(sheetOf(root), /data-form="edit-name" data-id="1"/);
  assert.deepEqual(sheetActions(root), []);
  root.click('cancel');
  assert.deepEqual(sheetActions(root).map((b) => b.split(' ')[1]), ['1', '1', '1', '1', '1']);
  root.click('person-close');
  assert.equal(sheetOf(root), '');
  assert.equal(api.calls.length, 0, 'opening people sends nothing');
});

test('filters: All, Schedulers, Not joined, Deactivated, each with a count; they combine with search', async () => {
  const { root } = await setup({ 'GET /api/people': [...PEOPLE, P(4, 'New Nia', 'nia@example.com', { joined: false })] });
  const h = root.innerHTML;
  assert.match(h, /data-filter="all" aria-pressed="true">All <span class="filter-count num" data-count="all">4</);
  assert.match(h, /data-filter="admins" aria-pressed="false">Schedulers <span class="filter-count num" data-count="admins">1</);
  assert.match(h, /data-filter="invited" aria-pressed="false">Not joined <span class="filter-count num" data-count="invited">1</);
  assert.match(h, /data-filter="inactive" aria-pressed="false">Deactivated <span class="filter-count num" data-count="inactive">1</);
  root.click('filter', undefined, { dataset: { action: 'filter', filter: 'inactive' } });
  assert.deepEqual([...root.innerHTML.matchAll(/<li data-person="(\d+)">/g)].map((x) => Number(x[1])), [3]);
  root.click('filter', undefined, { dataset: { action: 'filter', filter: 'all' } });
  assert.equal(people.filterKind(PEOPLE, 'admins').length, 1);
  assert.equal(people.filterKind(PEOPLE, 'nonsense').length, PEOPLE.length);
  const none = await setup({ 'GET /api/people': [P(1, 'Ann', 'a@example.com')] });
  assert.doesNotMatch(none.root.innerHTML, /data-filter="inactive"|data-filter="admins"/, 'empty filters are not shown');
});

test('filterPeople matches name or email, any case, all words', () => {
  assert.deepEqual(people.filterPeople(PEOPLE, 'SAM').map((p) => p.id), [2]);
  assert.deepEqual(people.filterPeople(PEOPLE, 'ortiz@example').map((p) => p.id), [2]);
  assert.deepEqual(people.filterPeople([P(7, 'No Mail', null)], 'mail').map((p) => p.id), [7]);
  assert.deepEqual(people.filterPeople(PEOPLE, 'joe').map((p) => p.id), [3]);
  assert.deepEqual(people.filterPeople(PEOPLE, 'ann admin').map((p) => p.id), [1]);
  assert.deepEqual(people.filterPeople(PEOPLE, 'zzz'), []);
  assert.equal(people.filterPeople(PEOPLE, '  '), PEOPLE);
});

test('typing in the search box filters the list', async () => {
  const { root } = await setup();
  root.fire('input', { dataset: { action: 'search' }, value: 'joe', closest() { return this; } });
  const list = root.parts.get('[data-list]').innerHTML;
  assert.match(list, /Old Joe/);
  assert.ok(!list.includes('Sam Ortiz'));
});

test('hostile names stay text', async () => {
  const bad = '<script>alert(1)</script>';
  const { root } = await setup({ 'GET /api/people': [P(5, bad, 'x"onclick="y')] });
  assert.ok(!root.innerHTML.includes('<script>'));
  assert.match(root.innerHTML, /&lt;script&gt;/);
  assert.ok(!root.innerHTML.includes('x"onclick'));
  root.click('reset-ask', 5);
  assert.ok(!root.innerHTML.includes('<script>'));
});

test('adding a person posts, then shows the one-time invite box', async () => {
  const { api, root } = await setup({
    'POST /api/people': { person: P(9, 'Sam <b>', 'sam@example.com', { joined: false }), invite: INVITE },
  });
  root.click('add-open');
  assert.match(root.innerHTML, /Make this person a scheduler/);
  root.submit('add-person', { name: ' Sam <b> ', email: '', scheduler: true });
  await flush();
  assert.equal(api.calls[0], 'POST /api/people {"name":"Sam <b>","role":"admin"}');
  assert.match(root.innerHTML, /Invite for Sam &lt;b&gt;/);
  assert.match(root.innerHTML, /You will log in with sam@example\.com\. The link works for 7 days/);
  assert.match(root.innerHTML, /data-action="copy"/);
  root.click('done');
  assert.ok(!root.innerHTML.includes(INVITE.link));
});

test('add person sends the email when given and nothing when name is empty', async () => {
  const { api, root } = await setup({ 'POST /api/people': { person: P(9, 'Al', 'al.x@example.com', { joined: false }), invite: INVITE } });
  root.click('add-open');
  root.submit('add-person', { name: '  ', email: '', scheduler: false });
  await flush();
  assert.equal(api.calls.length, 0);
  assert.match(root.innerHTML, /Please type a name/);
  root.submit('add-person', { name: 'Al', email: 'al.x@example.com', scheduler: false });
  await flush();
  assert.equal(api.calls[0], 'POST /api/people {"name":"Al","email":"al.x@example.com"}');
});

test('adding someone without an email: no invite, a plain notice instead', async () => {
  const { root } = await setup({ 'POST /api/people': { person: P(9, 'Gran', null, { joined: false }), invite: null } });
  root.click('add-open');
  root.submit('add-person', { name: 'Gran', email: '', scheduler: false });
  await flush();
  assert.ok(!root.innerHTML.includes('Invite for'));
  assert.match(root.innerHTML, /Without an email they cannot log in/);
});

test('email taken 409 is shown as is', async () => {
  const { root } = await setup({ 'POST /api/people': apiErr(409, 'That email is already used by someone else') });
  root.click('add-open');
  root.submit('add-person', { name: 'Al', email: 'ann@example.com', scheduler: false });
  await flush();
  assert.match(root.innerHTML, /That email is already used by someone else/);
});

test('reset needs confirmation: asking sends nothing, yes sends', async () => {
  const { api, root } = await setup({ 'POST /api/people/2/reset-login': { person: P(2, 'Sam Ortiz', 'sam.ortiz@example.com', { joined: false }), invite: INVITE } });
  root.click('reset-yes', 2); // no confirm step yet
  await flush();
  assert.equal(api.calls.length, 0);
  root.click('reset-ask', 2);
  assert.equal(api.calls.length, 0);
  assert.match(root.innerHTML, /Yes, reset login/);
  assert.match(root.innerHTML, /logged out everywhere/);
  root.click('cancel');
  root.click('reset-yes', 2);
  await flush();
  assert.equal(api.calls.length, 0);
  root.click('reset-ask', 2);
  root.click('reset-yes', 2);
  await flush();
  assert.deepEqual(api.calls, ['POST /api/people/2/reset-login {}']);
  assert.match(root.innerHTML, /Invite for Sam Ortiz/);
  assert.match(root.innerHTML, /Copy message/);
});

test('deactivate and reactivate need confirmation and explain history is kept', async () => {
  const { api, root } = await setup();
  root.click('deactivate-yes', 2);
  await flush();
  assert.equal(api.calls.length, 0);
  root.click('active-ask', 2);
  assert.match(root.innerHTML, /history is kept/);
  assert.equal(api.calls.length, 0);
  root.click('deactivate-yes', 2);
  await flush();
  assert.equal(api.calls[0], 'PATCH /api/people/2 {"active":false}');
  root.click('active-ask', 3);
  root.click('reactivate-yes', 3);
  await flush();
  assert.ok(api.calls.includes('PATCH /api/people/3 {"active":true}'));
});

test('a confirm for one person cannot be used for another', async () => {
  const { api, root } = await setup();
  root.click('active-ask', 2);
  root.click('deactivate-yes', 1);
  await flush();
  assert.equal(api.calls.length, 0);
});

test('last scheduler 409 is friendly', async () => {
  const { root } = await setup({ 'PATCH /api/people/1': apiErr(409, 'There must always be at least one active admin') });
  root.click('active-ask', 1);
  root.click('deactivate-yes', 1);
  await flush();
  assert.match(root.innerHTML, /at least one active scheduler/);
});

test('edit name patches the name', async () => {
  const { api, root } = await setup();
  root.click('edit', 2);
  assert.match(root.innerHTML, /data-form="edit-name"/);
  root.submit('edit-name', { name: ' Samuel ' }, 2);
  await flush();
  assert.equal(api.calls[0], 'PATCH /api/people/2 {"name":"Samuel"}');
});

test('checklist is grouped by team, preticked, and saves with PUT', async () => {
  const { api, root } = await setup({ 'PUT /api/people/2/positions': { positionIds: [11, 20] } });
  root.click('positions', 2);
  const h = root.innerHTML;
  assert.match(h, /What can Sam Ortiz do\?/);
  assert.match(h, /<legend>Band<\/legend>/);
  assert.match(h, /<legend>Sound<\/legend>/);
  assert.match(h, /data-position="10"\s+checked/);
  assert.ok(!/data-position="11"\s+checked/.test(h));
  root.fire('change', { dataset: { action: 'toggle-position', position: '10' }, checked: false, closest() { return this; } });
  root.fire('change', { dataset: { action: 'toggle-position', position: '11' }, checked: true, closest() { return this; } });
  root.fire('change', { dataset: { action: 'toggle-position', position: '20' }, checked: true, closest() { return this; } });
  assert.equal(api.calls.length, 0);
  root.click('positions-save', 2);
  await flush();
  assert.equal(api.calls[0], 'PUT /api/people/2/positions {"positionIds":[11,20]}');
});

test('copy button guards a missing clipboard and uses it when present', async () => {
  const api = fakeApi({ 'GET /api/people': PEOPLE, 'GET /api/teams': TEAMS, 'POST /api/people/2/reset-login': { person: P(2, 'Sam Ortiz', 'sam.ortiz@example.com', { joined: false }), invite: INVITE } });
  const written = [];
  const root = fakeRoot();
  const s = people.createScreen({ api, root, win: { navigator: { clipboard: { writeText: async (t) => { written.push(t); } } } } });
  await s.ready;
  root.click('reset-ask', 2); root.click('reset-yes', 2); await flush();
  root.click('copy'); await flush();
  assert.deepEqual(written, [inviteMessage({ name: 'Sam Ortiz', email: 'sam.ortiz@example.com', ...INVITE })]);
  assert.match(root.innerHTML, /Copied/);
  const root2 = fakeRoot();
  const s2 = people.createScreen({ api, root: root2, win: {} });
  await s2.ready;
  root2.click('reset-ask', 2); root2.click('reset-yes', 2); await flush();
  root2.click('copy'); await flush();
  assert.match(root2.innerHTML, /Could not copy/);
});

test('invite copy button shows a check SVG, then the copy SVG after 1.5s', async () => {
  const api = fakeApi({ 'GET /api/people': PEOPLE, 'GET /api/teams': TEAMS, 'POST /api/people/2/reset-login': { person: P(2, 'Sam Ortiz', 'sam.ortiz@example.com', { joined: false }), invite: INVITE } });
  const timers = [];
  const win = { navigator: { clipboard: { writeText: async () => {} } }, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {} };
  const root = fakeRoot();
  const s = people.createScreen({ api, root, win });
  await s.ready;
  root.click('reset-ask', 2); root.click('reset-yes', 2); await flush();
  const CHECK = 'M4.75 12.75l4.75 4.75 9.75-10.75';
  const btn = { innerHTML: '', dataset: { action: 'copy' } };
  btn.closest = () => btn;
  root.fire('click', btn); await flush();
  assert.match(btn.innerHTML, /^<span class="icon" aria-hidden="true"><svg[^>]*>.*M4\.75 12\.75l4\.75 4\.75 9\.75-10\.75.*<\/svg><\/span> Copy message$/);
  assert.equal(timers[0].ms, 1500);
  timers[0].fn();
  assert.ok(!btn.innerHTML.includes(CHECK));
  assert.match(btn.innerHTML, /<svg[^>]*>.*rect.*<\/svg><\/span> Copy message$/);
});

test('invite copying uses the shared HTTP clipboard fallback when the API is absent', async () => {
  const copied = [];
  const field = { setAttribute() {}, focus() {}, select() {}, setSelectionRange() {}, remove() {} };
  const win = { document: { createElement: () => field, body: { appendChild() {} }, execCommand: () => { copied.push(field.value); return true; } } };
  const api = fakeApi({ 'GET /api/people': PEOPLE, 'GET /api/teams': TEAMS, 'POST /api/people/2/reset-login': { person: P(2, 'Sam Ortiz', 'sam.ortiz@example.com', { joined: false }), invite: INVITE } });
  const root = fakeRoot();
  const s = people.createScreen({ api, root, win });
  await s.ready;
  root.click('reset-ask', 2); root.click('reset-yes', 2); await flush();
  root.click('copy');
  assert.deepEqual(copied, [inviteMessage({ name: 'Sam Ortiz', email: 'sam.ortiz@example.com', ...INVITE })]);
  await flush();
  assert.match(root.innerHTML, /Copied\./);
});

test('unjoined rows offer a new invite and local-only links explain the limitation', async () => {
  const pending = P(2, 'Sam Ortiz', 'sam.ortiz@example.com', { joined: false });
  const { api, root } = await setup({
    'GET /api/people': [pending],
    'POST /api/people/2/invite': { person: pending, invite: { ...INVITE, localOnly: true } },
  });
  assert.match(root.innerHTML, /chip-wait"><span class="icon chip-icon" data-icon="clock" aria-hidden="true"><\/span>Not joined yet/);
  root.click('select', 2);
  assert.match(sheetOf(root), /data-action="invite" data-id="2">[^]*?Copy new invite<\/span>/);
  root.click('invite', 2);
  await flush();
  assert.deepEqual(api.calls, ['POST /api/people/2/invite {}']);
  assert.match(root.innerHTML, /This link uses localhost/);
  assert.match(root.innerHTML, /FLOCK_PUBLIC_URL/);
  assert.equal(sheetOf(root), '', 'the sheet makes way for the invite box');
});

test('joined rows offer neither the pending label nor an invite action', async () => {
  const { api, root } = await setup();
  root.click('select', 2);
  assert.doesNotMatch(root.innerHTML, /Not joined yet|Copy new invite/);
  root.click('invite', 2);
  await flush();
  assert.equal(api.calls.length, 0);
});

test('view render/mount shape', () => {
  assert.match(people.render({}), /<h1 tabindex="-1">People<\/h1>/);
  assert.equal(people.mount({ querySelector: () => null }, {}), undefined);
});

// ---------- teams ----------

async function teamSetup(extra = {}) {
  const api = fakeApi({ 'GET /api/teams': TEAMS, ...extra });
  const root = fakeRoot();
  const s = teamsView.createScreen({ api, root });
  await s.ready;
  api.calls.length = 0;
  return { api, root };
}

test('teams page lists teams, positions and qualified counts', async () => {
  const { root } = await teamSetup();
  assert.match(root.innerHTML, /<h2 class="team-head"><button type="button" class="disclosure" data-action="toggle-team" data-id="1" aria-expanded="false"><span class="disclosure-text">Band<span class="disclosure-sub">2 positions<\/span>/);
  assert.match(root.innerHTML, /Sound<span class="disclosure-sub">1 position<\/span>/);
  assert.doesNotMatch(root.innerHTML, /can do this|qualified yet/, 'teams start closed');
  root.click('toggle-team', 1);
  root.click('toggle-team', 2);
  assert.match(root.innerHTML, /1 person can do this/);
  assert.match(root.innerHTML, /2 people can do this/);
  assert.match(root.innerHTML, /Nobody is qualified yet/);
});

test('teams: hostile names are escaped', async () => {
  const { root } = await teamSetup({ 'GET /api/teams': [{ id: 1, name: '<script>x</script>', positions: [{ id: 2, name: '<img onerror=x>', qualifiedPersonIds: [] }] }] });
  assert.ok(!root.innerHTML.includes('<script>'));
  assert.ok(!root.innerHTML.includes('<img'));
});

test('teams: add team, add position, rename call the right paths', async () => {
  const { api, root } = await teamSetup();
  root.submit('add-team', { name: ' Kids ' });
  await flush();
  root.click('add-position', 1);
  root.submit('add-position', { name: 'Bass' }, 1);
  await flush();
  root.click('rename-team', 1);
  root.submit('rename-team', { name: 'Music' }, 1);
  await flush();
  root.click('rename-position', 10);
  root.submit('rename-position', { name: 'Drum kit' }, 10);
  await flush();
  const writes = api.calls.filter((c) => !c.startsWith('GET'));
  assert.deepEqual(writes, [
    'POST /api/teams {"name":"Kids"}',
    'POST /api/teams/1/positions {"name":"Bass"}',
    'PATCH /api/teams/1 {"name":"Music"}',
    'PATCH /api/positions/10 {"name":"Drum kit"}',
  ]);
});

test('teams: a team opens on tap; a position shows Edit name and Delete once tapped, one at a time', async () => {
  let teams = TEAMS;
  const { api, root } = await teamSetup({
    'GET /api/teams': () => teams,
    'POST /api/teams': (b) => { const t = { id: 7, name: b.name, sort: 3, positions: [] }; teams = [...TEAMS, t]; return t; },
  });
  const shown = () => [...root.innerHTML.matchAll(/data-action="(add-position|rename-team|delete-team|rename-position|delete-position)" data-id="(\d+)"/g)].map((x) => `${x[1]} ${x[2]}`);
  const TEAM_1 = ['add-position 1', 'rename-team 1', 'delete-team 1'];
  assert.deepEqual(shown(), []);
  root.click('toggle-team', 1);
  assert.match(root.innerHTML, /data-action="toggle-team" data-id="1" aria-expanded="true"/);
  assert.deepEqual(shown(), TEAM_1);
  assert.match(root.innerHTML, /data-action="select" data-id="10" aria-expanded="false"/);
  root.click('select', 10);
  assert.deepEqual(shown(), [...TEAM_1, 'rename-position 10', 'delete-position 10']);
  // Rename is an edit button, Delete a real (danger) button, each with an icon; the name is there for screen readers.
  assert.match(root.innerHTML, /class="btn btn-sm" data-action="rename-position" data-id="10"><span class="icon" data-icon="edit" aria-hidden="true"><\/span> Edit name<span class="visually-hidden"> of Drums<\/span><\/button>/);
  assert.match(root.innerHTML, /class="btn btn-sm btn-danger" data-action="delete-position" data-id="10"><span class="icon" data-icon="trash" aria-hidden="true"><\/span> Delete<span class="visually-hidden"> Drums<\/span><\/button>/);
  assert.match(root.innerHTML, /class="btn btn-sm btn-danger" data-action="delete-team" data-id="1"><span class="icon" data-icon="trash"/);
  assert.doesNotMatch(root.innerHTML, /btn-quiet/);
  root.click('select', 11);
  assert.deepEqual(shown(), [...TEAM_1, 'rename-position 11', 'delete-position 11']);
  root.click('select', 11);
  assert.deepEqual(shown(), TEAM_1);
  root.click('toggle-team', 1);
  assert.deepEqual(shown(), []);
  assert.equal(api.calls.length, 0, 'opening and tapping send nothing');
  // A new team opens by itself, ready for its first position.
  root.submit('add-team', { name: 'Kids' });
  await flush();
  assert.equal(api.calls[0], 'POST /api/teams {"name":"Kids"}');
  assert.match(root.innerHTML, /data-action="toggle-team" data-id="7" aria-expanded="true"/);
  assert.deepEqual(shown(), ['add-position 7', 'rename-team 7', 'delete-team 7']);
});

test('teams: delete needs confirmation, then names who will be taken off and confirms', async () => {
  let n = 0;
  const people = [{ name: 'Sam Ortiz', positionName: 'Drums', date: '2026-02-01' }, { name: 'Lee <b>', positionName: 'Keys', date: '2026-02-08' }];
  const { api, root } = await teamSetup({
    'DELETE /api/teams/1': () => (n++ ? {} : new ApiError({ status: 409, code: 'has_people', message: '2 people are scheduled in it on upcoming services', data: { count: 2, people } })),
    'DELETE /api/teams/1?confirm=1': { ok: true },
  });
  root.click('delete-team-yes', 1);
  await flush();
  assert.equal(api.calls.length, 0);
  root.click('delete-team', 1);
  assert.match(root.innerHTML, /Delete the team <strong>Band<\/strong>\? It is taken off upcoming services\. Past services still show it\./);
  assert.equal(api.calls.length, 0);
  root.click('delete-team-yes', 1);
  await flush();
  assert.deepEqual(api.calls, ['DELETE /api/teams/1']);
  assert.match(root.innerHTML, /<strong>Sam Ortiz \(Drums, Sun 1 Feb\) and Lee &lt;b&gt; \(Keys, Sun 8 Feb\)<\/strong> are scheduled on upcoming services\. They will be taken off and told\./);
  root.click('delete-team-yes', 1);
  await flush();
  assert.deepEqual(api.calls, ['DELETE /api/teams/1', 'DELETE /api/teams/1?confirm=1', 'GET /api/teams']);
  assert.match(root.innerHTML, /Team deleted\./);
});

test('teams: other delete errors are shown as they are', async () => {
  const { root } = await teamSetup({ 'DELETE /api/teams/1': apiErr(409, 'Something else') });
  root.click('delete-team', 1);
  root.click('delete-team-yes', 1);
  await flush();
  assert.match(root.innerHTML, /Something else\./);
});

test('teams: adding a deleted name says it was brought back', async () => {
  const { root } = await teamSetup({
    'POST /api/teams': { id: 9, name: 'Choir', revived: true },
    'POST /api/teams/1/positions': { id: 12, name: 'Bass', revived: true, qualifiedCount: 2 },
  });
  root.submit('add-team', { name: 'Choir' });
  await flush();
  assert.match(root.innerHTML, /Brought back Choir\. Its old positions are not back; add them again to bring them back\./);
  root.click('toggle-team', 1);
  root.click('add-position', 1);
  root.submit('add-position', { name: 'Bass' }, 1);
  await flush();
  assert.match(root.innerHTML, /Brought back Bass \(2 people can do this\)\./);
});

test('teams: position delete also needs confirmation', async () => {
  const { api, root } = await teamSetup();
  root.click('delete-position-yes', 11);
  await flush();
  assert.equal(api.calls.length, 0);
  root.click('delete-position', 11);
  root.click('delete-position-yes', 11);
  await flush();
  assert.equal(api.calls[0], 'DELETE /api/positions/11');
});

// ---------- access levels (make scheduler / make volunteer) ----------

async function setupAs(me, extra = {}) {
  const api = fakeApi({ 'GET /api/people': PEOPLE, 'GET /api/teams': TEAMS, ...extra });
  const root = fakeRoot();
  const s = people.createScreen({ api, root, ctx: { state: { user: { id: me } } } });
  await s.ready;
  api.calls.length = 0;
  return { api, root, s };
}
const rowOf = (root, id) => {
  const h = root.innerHTML;
  const start = h.indexOf(`<li data-person="${id}">`);
  const end = h.indexOf('</li>', start);
  return h.slice(start, end);
};

test('people page explains the two access levels in plain words, where the role is chosen', async () => {
  const { root } = await setupAs(9);
  root.click('add-open');
  const add = root.innerHTML.slice(root.innerHTML.indexOf('data-add-sheet'));
  assert.match(add, /Make this person a scheduler<\/label>\s*<div class="hint" id="new-role-hint"><p>Scheduler: can manage people, teams, services and the schedule\.<\/p><p>Volunteer: can see their own schedule and mark days they cannot serve\.<\/p><\/div>/);
  assert.match(add, /aria-describedby="new-role-hint"/);
  root.click('add-cancel');
  assert.doesNotMatch(root.innerHTML, /data-add-sheet/);
});

test('each person shows their level in words, and the sheet offers the other one', async () => {
  const { root } = await setupAs(9);
  assert.match(rowOf(root, 1), /Scheduler</);
  assert.doesNotMatch(rowOf(root, 2), /Scheduler</, 'volunteers carry no tag');
  root.click('select', 1);
  assert.match(sheetOf(root), /<p class="account-sub">Scheduler · /);
  assert.match(sheetOf(root), /data-action="role-ask" data-id="1">[^]*?Make a volunteer<span class="menu-sub">Sees only their own schedule</);
  root.click('select', 2);
  assert.match(sheetOf(root), /data-action="role-ask" data-id="2">[^]*?Make a scheduler<span class="menu-sub">Can change the schedule and people</);
});

test('own row says That\'s you; your own sheet has no role or deactivate', async () => {
  const { root } = await setupAs(1);
  assert.match(rowOf(root, 1), /chip-plain"><span class="icon chip-icon" data-icon="user" aria-hidden="true"><\/span>That's you</);
  root.click('select', 1);
  assert.match(sheetOf(root), /data-action="edit" data-id="1"/);
  assert.doesNotMatch(sheetOf(root), /role-ask|active-ask|Make a volunteer/);
  root.click('select', 2);
  assert.match(sheetOf(root), /role-ask/);
  root.click('role-ask', 1);
  assert.ok(!root.innerHTML.includes('Make Ann Admin a volunteer?'));
});

test('a deactivated person shows their level but no role change', async () => {
  const { root } = await setupAs(9);
  root.click('select', 3);
  const joe = sheetOf(root);
  assert.match(joe, /data-action="edit" data-id="3"/);
  assert.match(joe, /<p class="account-sub">Volunteer · joe@example\.com<\/p>/);
  assert.match(joe, /Deactivated/);
  assert.ok(!joe.includes('role-ask'));
});

test('sheet rows: each one has an icon and words, and each action opens its step', async () => {
  const { root } = await setupAs(9);
  root.click('select', 1);
  const rows = [...sheetOf(root).matchAll(/<button type="button" class="menu-row[^"]*" data-action="[\w-]+" data-id="1">[\s\S]*?<\/button>/g)].map((m) => m[0]);
  assert.equal(rows.length, 5);
  for (const b of rows) {
    assert.match(b, /class="icon menu-icon" data-icon="[\w-]+"/, `a row has no icon: ${b}`);
    assert.ok(b.replace(/<[^>]+>/g, '').trim(), `a row has no words: ${b}`);
  }
  for (const [action, name] of [['positions', 'Positions'], ['edit', 'Change name'], ['role-ask', 'Make a volunteer'], ['reset-ask', 'Reset login'], ['active-ask', 'Deactivate']]) {
    const hit = rows.filter((b) => b.includes(`data-action="${action}"`));
    assert.equal(hit.length, 1, action);
    assert.match(hit[0], new RegExp(`<span class="menu-text">${name}`), action);
  }
  assert.match(sheetOf(root), /class="menu-row is-danger" data-action="active-ask" data-id="1"/);
  root.click('edit', 1);
  assert.match(root.innerHTML, /data-form="edit-name" data-id="1"/);
  root.click('cancel');
  root.click('positions', 1);
  assert.match(root.innerHTML, /What can Ann Admin do\?/);
  root.click('cancel');
  root.click('reset-ask', 1);
  assert.match(root.innerHTML, /Yes, reset login/);
  root.click('cancel');
  root.click('role-ask', 1);
  assert.match(root.innerHTML, /Make Ann Admin a volunteer\?/);
  root.click('cancel');
  root.click('active-ask', 1);
  assert.match(root.innerHTML, /Deactivate <strong>Ann Admin<\/strong>\?/);
});

test('a deactivated person: Reactivate (not a danger row), and their steps still open', async () => {
  const { root } = await setupAs(9);
  root.click('select', 3);
  assert.match(sheetOf(root), /class="menu-row" data-action="active-ask" data-id="3">[^]*?Reactivate/);
  root.click('select', 2);
  assert.match(sheetOf(root), /class="menu-row is-danger" data-action="active-ask" data-id="2">[^]*?Deactivate/);
  root.click('select', 3);
  root.click('edit', 3);
  assert.match(root.innerHTML, /data-form="edit-name" data-id="3"/);
  root.click('cancel');
  root.click('positions', 3);
  assert.match(root.innerHTML, /What can Old Joe do\?/);
  root.click('cancel');
  root.click('reset-ask', 3);
  assert.match(root.innerHTML, /Yes, reset login/);
  root.click('cancel');
  root.click('active-ask', 3);
  assert.match(root.innerHTML, /Reactivate <strong>Old Joe<\/strong>\?/);
});

test('role confirm panel names the person and the right level', async () => {
  const { root } = await setupAs(9);
  root.click('role-ask', 2);
  assert.match(root.innerHTML, /Make Sam Ortiz a scheduler\? Sam Ortiz will be able to change the whole schedule and see every volunteer's name and email\./);
  root.click('cancel');
  root.click('role-ask', 1);
  assert.match(root.innerHTML, /Make Ann Admin a volunteer\? Ann Admin will only see their own schedule\./);
});

test('role button without confirming sends nothing', async () => {
  const { api, root } = await setupAs(9);
  root.click('role-ask', 2);
  await flush();
  assert.equal(api.calls.length, 0);
});

test('confirming a role change sends the PATCH body, refreshes and shows success', async () => {
  const { api, root } = await setupAs(9, { 'PATCH /api/people/2': { id: 2 } });
  root.click('role-ask', 2);
  root.click('role-yes', 2);
  await flush();
  assert.equal(api.calls[0], 'PATCH /api/people/2 {"role":"admin"}');
  assert.ok(api.calls.includes('GET /api/people'));
  assert.match(root.innerHTML, /Sam Ortiz is now a scheduler\./);
  assert.equal(root.innerHTML.includes('Make Sam Ortiz a scheduler?'), false);
});

test('confirm action is ignored unless its panel is open for that person', async () => {
  const { api, root } = await setupAs(9, { 'PATCH /api/people/2': { id: 2 } });
  root.click('role-yes', 2);
  await flush();
  assert.equal(api.calls.length, 0);
  root.click('role-ask', 2);
  root.click('role-yes', 3);
  await flush();
  assert.equal(api.calls.length, 0);
});

test('a role change refused with 409 shows the message instead of failing silently', async () => {
  const { root } = await setupAs(9, { 'PATCH /api/people/1': apiErr(409, 'There must always be at least one active admin') });
  root.click('role-ask', 1);
  root.click('role-yes', 1);
  await flush();
  assert.match(root.innerHTML, /at least one active scheduler/);
});

test('hostile names stay escaped in the role confirm panel', async () => {
  const bad = '<script>alert(1)</script>';
  const { root } = await setupAs(9, { 'GET /api/people': [P(5, bad, 'x.y')] });
  root.click('role-ask', 5);
  assert.ok(!root.innerHTML.includes('<script>'));
  assert.match(root.innerHTML, /Make &lt;script&gt;alert\(1\)&lt;\/script&gt; a scheduler\?/);
});
