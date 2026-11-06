import test from 'node:test';
import assert from 'node:assert/strict';
import * as people from '../web/views/admin-people.js';
import * as teamsView from '../web/views/admin-teams.js';
import { ApiError } from '../web/api.js';
import { fakeRoot, fakeApi } from './helpers/fakeui.js';

const apiErr = (status, message) => new ApiError({ status, message });
const P = (id, name, username, extra = {}) => ({ id, name, username, role: 'member', active: true, mustChangePassword: false, positionIds: [], ...extra });
const TEAMS = [
  { id: 1, name: 'Band', positions: [{ id: 10, name: 'Drums', qualifiedPersonIds: [2] }, { id: 11, name: 'Keys', qualifiedPersonIds: [] }] },
  { id: 2, name: 'Sound', positions: [{ id: 20, name: 'Mixer', qualifiedPersonIds: [2, 3] }] },
];
const PEOPLE = [P(1, 'Ann Admin', 'ann', { role: 'admin' }), P(2, 'Sam Ortiz', 'sam.ortiz', { positionIds: [10] }), P(3, 'Old Joe', 'joe', { active: false })];

async function setup(extra = {}) {
  const api = fakeApi({ 'GET /api/people': PEOPLE, 'GET /api/teams': TEAMS, ...extra });
  const root = fakeRoot();
  const s = people.createScreen({ api, root });
  await s.ready;
  api.calls.length = 0;
  return { api, root, s };
}
const flush = () => new Promise((r) => setImmediate(r));

test('list shows name, username, role and Deactivated marker', async () => {
  const { root } = await setup();
  assert.match(root.innerHTML, /Sam Ortiz/);
  assert.match(root.innerHTML, /sam\.ortiz/);
  assert.match(root.innerHTML, /Scheduler/);
  assert.equal(root.innerHTML.match(/Deactivated<\/span>/g).length, 1);
  assert.match(root.innerHTML, /Reactivate/);
  assert.match(root.innerHTML, /Add person/);
});

test('filterPeople matches name or username, any case, all words', () => {
  assert.deepEqual(people.filterPeople(PEOPLE, 'SAM').map((p) => p.id), [2]);
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

test('suggestUsername', () => {
  assert.equal(people.suggestUsername('Sam Ortiz'), 'sam.ortiz');
  assert.equal(people.suggestUsername('José  Núñez'), 'jose.nunez');
  assert.equal(people.suggestUsername('<>'), '');
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

test('adding a person posts, then shows the one-time password box', async () => {
  const { api, root } = await setup({
    'POST /api/people': { person: P(9, 'Sam <b>', 'sam'), tempPassword: 'maple-river-42' },
  });
  root.click('add-open');
  assert.match(root.innerHTML, /Make this person a scheduler/);
  root.submit('add-person', { name: ' Sam <b> ', username: '', scheduler: true });
  await flush();
  assert.equal(api.calls[0], 'POST /api/people {"name":"Sam <b>","role":"admin"}');
  assert.match(root.innerHTML, /Give this to Sam &lt;b&gt;: <strong data-secret>maple-river-42<\/strong>\. It is only shown once, and Sam &lt;b&gt; will choose their own password at first login\./);
  assert.match(root.innerHTML, /data-action="copy"/);
  root.click('done');
  assert.ok(!root.innerHTML.includes('maple-river-42'));
});

test('add person sends username when given and nothing when name is empty', async () => {
  const { api, root } = await setup({ 'POST /api/people': { person: P(9, 'Al', 'al.x'), tempPassword: 'a-b-1' } });
  root.click('add-open');
  root.submit('add-person', { name: '  ', username: '', scheduler: false });
  await flush();
  assert.equal(api.calls.length, 0);
  assert.match(root.innerHTML, /Please type a name/);
  root.submit('add-person', { name: 'Al', username: 'al.x', scheduler: false });
  await flush();
  assert.equal(api.calls[0], 'POST /api/people {"name":"Al","username":"al.x"}');
});

test('username taken 409 is friendly', async () => {
  const { root } = await setup({ 'POST /api/people': apiErr(409, 'That username is already taken') });
  root.click('add-open');
  root.submit('add-person', { name: 'Al', username: 'ann', scheduler: false });
  await flush();
  assert.match(root.innerHTML, /That username is already taken\. Please pick a different one/);
});

test('reset needs confirmation: asking sends nothing, yes sends', async () => {
  const { api, root } = await setup({ 'POST /api/people/2/reset-password': { tempPassword: 'oak-lake-77' } });
  root.click('reset-yes', 2); // no confirm step yet
  await flush();
  assert.equal(api.calls.length, 0);
  root.click('reset-ask', 2);
  assert.equal(api.calls.length, 0);
  assert.match(root.innerHTML, /Yes, reset it/);
  root.click('cancel');
  root.click('reset-yes', 2);
  await flush();
  assert.equal(api.calls.length, 0);
  root.click('reset-ask', 2);
  root.click('reset-yes', 2);
  await flush();
  assert.deepEqual(api.calls, ['POST /api/people/2/reset-password {}']);
  assert.match(root.innerHTML, /Give this to Sam Ortiz: <strong data-secret>oak-lake-77/);
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
  const api = fakeApi({ 'GET /api/people': PEOPLE, 'GET /api/teams': TEAMS, 'POST /api/people/2/reset-password': { tempPassword: 'a-b-1' } });
  const written = [];
  const root = fakeRoot();
  const s = people.createScreen({ api, root, win: { navigator: { clipboard: { writeText: async (t) => { written.push(t); } } } } });
  await s.ready;
  root.click('reset-ask', 2); root.click('reset-yes', 2); await flush();
  root.click('copy'); await flush();
  assert.deepEqual(written, ['a-b-1']);
  assert.match(root.innerHTML, /Copied/);
  const root2 = fakeRoot();
  const s2 = people.createScreen({ api, root: root2, win: {} });
  await s2.ready;
  root2.click('reset-ask', 2); root2.click('reset-yes', 2); await flush();
  root2.click('copy'); await flush();
  assert.match(root2.innerHTML, /Could not copy/);
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
  assert.match(root.innerHTML, /<h2>Band<\/h2>/);
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

test('teams: delete needs confirmation and shows the API 409', async () => {
  const { api, root } = await teamSetup({ 'DELETE /api/teams/1': apiErr(409, 'Remove or reassign its positions first') });
  root.click('delete-team-yes', 1);
  await flush();
  assert.equal(api.calls.length, 0);
  root.click('delete-team', 1);
  assert.match(root.innerHTML, /Yes, delete it/);
  assert.equal(api.calls.length, 0);
  root.click('delete-team-yes', 1);
  await flush();
  assert.deepEqual(api.calls, ['DELETE /api/teams/1']);
  assert.match(root.innerHTML, /Remove or reassign its positions first\./);
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
