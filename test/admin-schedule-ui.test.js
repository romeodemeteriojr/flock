import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as services from '../web/views/admin-services.js';
import * as schedule from '../web/views/admin-schedule.js';
import * as gaps from '../web/views/admin-gaps.js';
import { statusChip, conflictMessage, OVERRIDABLE } from '../web/lib/slotpanel.js';
import { ApiError } from '../web/api.js';
import { html } from '../web/lib/html.js';
import { fakeRoot, fakeApi } from './helpers/fakeui.js';

const TODAY = '2026-11-04';
const flush = () => new Promise((r) => setImmediate(r));
const conflict = (code, message = 'server text') => new ApiError({ status: 409, code, message });

const TEAMS = [
  { id: 1, name: 'Band', positions: [{ id: 10, name: 'Drums' }, { id: 11, name: 'Keys' }] },
  { id: 2, name: 'Sound', positions: [{ id: 20, name: 'Mixer' }] },
];
const slot = (id, positionId, extra = {}) => {
  const team = TEAMS.find((t) => t.positions.some((p) => p.id === positionId));
  const pos = team.positions.find((p) => p.id === positionId);
  return { id, positionId, positionName: pos.name, teamId: team.id, teamName: team.name, status: 'open', personId: null, personName: null, ...extra };
};
const SERVICES = [
  // given out of order on purpose
  { id: 2, date: '2026-11-15', time: '09:00', title: 'Sunday service', slots: [slot(5, 20)] },
  { id: 1, date: '2026-11-08', time: '09:00', title: 'Sunday service', slots: [
    slot(1, 20, { status: 'accepted', personId: 7, personName: 'Ann Lee' }),
    slot(2, 10, { status: 'pending', personId: 8, personName: 'Bo Diaz' }),
    slot(3, 10, { status: 'declined', personId: 9, personName: 'Cy Fox' }),
    slot(4, 11),
  ] },
];
const SVC_PATH = `GET /api/services?from=${TODAY}&to=2027-05-05`;
const SCHED_PATH = `GET /api/services?from=${TODAY}&to=2026-12-29`;

async function svcSetup(extra = {}) {
  const api = fakeApi({ 'GET /api/teams': TEAMS, [SVC_PATH]: SERVICES, ...extra });
  const root = fakeRoot();
  const s = services.createScreen({ api, root, today: TODAY });
  await s.ready;
  api.calls.length = 0;
  return { api, root, s };
}
async function schedSetup(extra = {}) {
  const api = fakeApi({ 'GET /api/teams': TEAMS, [SCHED_PATH]: SERVICES, ...extra });
  const root = fakeRoot();
  const s = schedule.createScreen({ api, root, today: TODAY });
  await s.ready;
  api.calls.length = 0;
  return { api, root, s };
}
const CANDS = { candidates: [
  { personId: 30, name: 'Sam Ortiz', qualified: true, reasons: ['Has not served in 8 weeks', 'Has never served'] },
  { personId: 31, name: 'Old Joe', qualified: true, reasons: ['Served 2 times in the last 8 weeks'] },
] };

// ---------- shared pieces ----------

test('status chip shows words for every status (symbol comes from CSS class)', () => {
  const want = { open: ['Open', 'chip-open'], pending: ['Waiting for answer', 'chip-wait'], accepted: ['Confirmed', 'chip-ok'], declined: ['Declined', 'chip-bad'] };
  for (const [st, [word, cls]] of Object.entries(want)) {
    const s = String(statusChip(st));
    assert.ok(s.includes(`>${word}<`), st);
    assert.ok(s.includes(cls), st);
  }
  const css = readFileSync(fileURLToPath(new URL('../web/style.css', import.meta.url)), 'utf8');
  for (const sel of ['.chip-open::before', '.chip-wait::before', '.chip-ok::before', '.chip-bad::before']) assert.ok(css.includes(sel), sel);
});

test('status chip: the four statuses have four distinct icons', () => {
  const iconOf = (s) => [...String(statusChip(s)).matchAll(/data-icon="([^"]+)"/g)].map((m) => m[1]);
  const icons = ['open', 'pending', 'accepted', 'declined'].map(iconOf);
  for (const st of ['open', 'pending', 'accepted', 'declined']) assert.equal(iconOf(st).length, 1, st);
  const want = { open: 'plus', pending: 'clock', accepted: 'check', declined: 'x' };
  for (const [st, name] of Object.entries(want)) assert.equal(iconOf(st)[0], name, st);
  const seen = new Set(icons.flat());
  assert.equal(seen.size, 4, `expected 4 distinct icons, got ${[...seen].join(', ')}`);
});

test('status chip compact: icon only, with the word as accessible name', () => {
  for (const [st, [word]] of Object.entries({ open: ['Open'], pending: ['Waiting for answer'], accepted: ['Confirmed'], declined: ['Declined'] })) {
    const s = String(statusChip(st, { compact: true }));
    assert.match(s, /chip-compact/, st);
    assert.match(s, new RegExp(`aria-label="${word}"`), st);
    assert.ok(s.includes('visually-hidden'), st);
    assert.match(s, new RegExp(`>\s*${word}<\/span>`), st);
    assert.ok(!/chip-compact[^>]*>\s*<span/.test(s.replace(/<span class="visually-hidden"[^>]*>[^<]*<\/span>/, '').replace(/<span class="icon[^"]*"[^>]*>[^<]*<\/span>/, '')), st);
  }
  // the full chip is not compact and has no aria-label (the word is visible)
  const full = String(statusChip('accepted'));
  assert.doesNotMatch(full, /chip-compact/);
  assert.doesNotMatch(full, /aria-label/);
  assert.match(full, />Confirmed</);
});

test('conflict messages are plain, and inactive/past are never overridable', () => {
  assert.equal(conflictMessage('blocked', 'Sam'), 'Sam is away on that date. Assign anyway?');
  assert.equal(conflictMessage('not_qualified', 'Sam', 'Drums'), 'Sam is not trained for Drums. Assign anyway?');
  assert.equal(conflictMessage('double_booked', 'Sam'), 'Sam is already serving at this service. Assign anyway?');
  assert.match(conflictMessage('inactive', 'Sam'), /Sam is no longer active, so they can't be scheduled\./);
  assert.match(conflictMessage('past', 'Sam'), /already happened/);
  assert.ok(!OVERRIDABLE.includes('inactive'));
  assert.ok(!OVERRIDABLE.includes('past'));
});

// ---------- services page ----------

test('services: list sorted by date, grouped positions, people count; empty state', async () => {
  const { root } = await svcSetup();
  const h = root.innerHTML;
  assert.ok(h.indexOf('data-service="1"') < h.indexOf('data-service="2"'));
  assert.match(h, /Sun 8 Nov at 9:00 am/);
  assert.match(h, /Band: Drums x2, Keys\. Sound: Mixer/);
  assert.match(h, /3 people are scheduled on this date/); // like the server: anyone in a slot
  assert.match(h, /value="Sunday service"/);
  assert.match(h, /value="09:00"/);
  assert.ok(h.indexOf('Drums') < h.indexOf('Mixer'));
  const empty = await svcSetup({ [SVC_PATH]: [] });
  assert.match(empty.root.innerHTML, /No upcoming services yet/);
});

test('services: form builds the right POST body', async () => {
  const els = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'boolean' ? { checked: v } : { value: v }]));
  assert.deepEqual(services.serviceBody(els({ date: '2026-11-08', time: '', title: '', 'pos-10': true, 'count-10': '2', 'pos-11': false, 'pos-20': true, 'count-20': '' }), TEAMS).body,
    { date: '2026-11-08', time: '09:00', title: 'Sunday service', slots: [{ positionId: 10, count: 2 }, { positionId: 20, count: 1 }] });
  assert.match(services.serviceBody(els({ date: '' }), TEAMS).error, /pick a date/);
  assert.match(services.serviceBody(els({ date: '2026-11-08', 'pos-10': true, 'count-10': '99' }), TEAMS).error, /1 to 20/);

  const { api, root } = await svcSetup({ 'POST /api/services': {} });
  root.submit('create', { date: '2026-11-22', time: '10:30', title: ' Easter ', 'pos-11': true, 'count-11': '3' });
  await flush();
  assert.equal(api.calls[0], 'POST /api/services {"date":"2026-11-22","time":"10:30","title":"Easter","slots":[{"positionId":11,"count":3}]}');
  assert.match(root.innerHTML, /Service added for Sun 22 Nov at 10:30 am/);
});

test('services: a form error keeps what the scheduler typed', async () => {
  const { api, root } = await svcSetup();
  root.submit('create', { date: '2026-11-22', time: '10:30', title: 'Easter', 'pos-10': true, 'count-10': '99', 'pos-20': true, 'count-20': '2' });
  await flush();
  assert.equal(api.calls.length, 0);
  const h = root.innerHTML;
  assert.match(h, /How many Drums\? Please type a number from 1 to 20/);
  assert.match(h, /name="date" type="date" required value="2026-11-22"/);
  assert.match(h, /value="Easter"/);
  assert.match(h, /name="pos-10" type="checkbox" checked>/);
  assert.match(h, /name="count-10" type="number" min="1" max="20" value="99"/);
  assert.match(h, /name="pos-11" type="checkbox">/);
  assert.match(h, /name="count-20" type="number" min="1" max="20" value="2"/);
});

test('services: repeat asks for weeks, posts, and reports skipped dates', async () => {
  const { api, root } = await svcSetup({ 'POST /api/services/repeat': { created: [{}, {}], skipped: ['2026-11-22'] } });
  root.click('repeat', 1);
  assert.match(root.innerHTML, /Repeat for how many more weeks/);
  root.submit('repeat', { weeks: '0' }, 1);
  await flush();
  assert.equal(api.calls.length, 0);
  assert.match(root.innerHTML, /from 1 to 26/);
  root.click('repeat', 1);
  root.submit('repeat', { weeks: '3' }, 1);
  await flush();
  assert.equal(api.calls[0], 'POST /api/services/repeat {"fromServiceId":1,"weeks":3}');
  assert.match(root.innerHTML, /Added 2 more services\. Skipped Sun 22 Nov/);
});

test('services: edit starts from the service, with its positions and counts', async () => {
  assert.deepEqual(services.draftOf(SERVICES[1]), { date: '2026-11-08', time: '09:00', title: 'Sunday service',
    pos: { 20: { on: true, count: '1' }, 10: { on: true, count: '2' }, 11: { on: true, count: '1' } } });
  const { root } = await svcSetup();
  root.click('edit', 1);
  const form = root.innerHTML.split('data-form="edit"')[1];
  assert.match(form, /id="edit-1-pos-10" name="pos-10" type="checkbox" checked>/);
  assert.match(form, /id="edit-1-count-10" name="count-10" type="number" min="1" max="20" value="2"/);
  assert.match(form, /id="edit-1-pos-20" name="pos-20" type="checkbox" checked>/);
});

test('services: edit patches the fields and the positions', async () => {
  const { api, root } = await svcSetup();
  root.click('edit', 2);
  assert.match(root.innerHTML, /data-form="edit"/);
  root.submit('edit', { date: '2026-11-16', time: '18:00', title: 'Evening', 'pos-20': true, 'count-20': '1', 'pos-10': true, 'count-10': '2' }, 2);
  await flush();
  assert.equal(api.calls[0], 'PATCH /api/services/2 {"date":"2026-11-16","time":"18:00","title":"Evening","slots":[{"positionId":10,"count":2},{"positionId":20,"count":1}]}');
  assert.match(root.innerHTML, /Service saved/);
});

test('services: edit that takes people off names them, then sends confirm=1', async () => {
  const people = [{ name: 'Ann Lee', positionName: 'Mixer', date: '2026-11-08' }];
  const { api, root } = await svcSetup({
    'PATCH /api/services/1': new ApiError({ status: 409, code: 'has_people', message: '1 person is scheduled', data: { count: 1, people } }),
    'PATCH /api/services/1?confirm=1': {},
  });
  root.click('edit', 1);
  const fields = { date: '2026-11-08', time: '09:00', title: 'Sunday service', 'pos-10': true, 'count-10': '2', 'pos-11': true, 'count-11': '1' };
  root.submit('edit', fields, 1);
  await flush();
  assert.match(root.innerHTML, /<strong>Ann Lee \(Mixer, Sun 8 Nov\)<\/strong> is on a position you took off\. They will be taken off and told\./);
  assert.ok(!root.innerHTML.includes('Save changes'));
  root.click('edit-back', 1);
  assert.match(root.innerHTML, /Save changes/);
  assert.match(root.innerHTML.split('data-form="edit"')[1], /name="pos-20" type="checkbox">/, 'what they typed stays');
  root.submit('edit', fields, 1);
  await flush();
  root.click('edit-yes', 1);
  await flush();
  assert.equal(api.calls.at(-3), 'PATCH /api/services/1?confirm=1 {"date":"2026-11-08","time":"09:00","title":"Sunday service","slots":[{"positionId":10,"count":2},{"positionId":11,"count":1}]}');
  assert.match(root.innerHTML, /Service saved/);
});

test('services: edit shows why a count cannot go down', async () => {
  const { root } = await svcSetup({ 'PATCH /api/services/1': conflict('spots_filled', '2 people are on Drums. Take someone off on the Schedule page first to go down to 1.') });
  root.click('edit', 1);
  root.submit('edit', { date: '2026-11-08', time: '09:00', title: 'Sunday service', 'pos-10': true, 'count-10': '1' }, 1);
  await flush();
  assert.match(root.innerHTML, /2 people are on Drums\. Take someone off on the Schedule page first to go down to 1\./);
});

test('repeatNotice mentions deleted positions left out', () => {
  assert.equal(services.repeatNotice({ created: [{}], skipped: [], skippedPositions: ['Harp', 'Oboe'] }),
    'Added 1 more service. Left out Harp, Oboe: deleted on the Teams page.');
});

test('services: delete warns how many people, needs confirm, and sends confirm=1', async () => {
  const { api, root } = await svcSetup();
  root.click('delete-yes', 1); // not asked yet
  await flush();
  assert.equal(api.calls.length, 0);
  root.click('delete', 1);
  assert.match(root.innerHTML, /3 people are scheduled on this date\./);
  assert.match(root.innerHTML, /Yes, delete it/);
  root.click('cancel');
  assert.ok(!root.innerHTML.includes('Yes, delete it'));
  root.click('delete', 1);
  root.click('delete-yes', 1);
  await flush();
  assert.equal(api.calls[0], 'DELETE /api/services/1?confirm=1');
  assert.match(root.innerHTML, /Service deleted/);
});

test('services: delete with nobody sends no confirm; a 409 has_people asks again', async () => {
  let n = 0;
  const { api, root } = await svcSetup({
    'DELETE /api/services/2': () => { n++; return conflict('has_people', '3 people are scheduled on this date'); },
  });
  root.click('delete', 2);
  const box = () => root.innerHTML.split('role="alertdialog"')[1] ?? '';
  assert.match(box(), /Delete Sunday service on Sun 15 Nov\?/);
  assert.ok(!box().includes('people are scheduled'));
  root.click('delete-yes', 2);
  await flush();
  assert.equal(n, 1);
  assert.match(box(), /3 people are scheduled on this date\./);
  assert.match(box(), /Yes, delete it/);
  root.click('delete-yes', 2);
  await flush();
  assert.equal(api.calls[1], 'DELETE /api/services/2?confirm=1');
  assert.match(root.innerHTML, /Service deleted/);
});

test('services: hostile titles and team names stay text', async () => {
  const bad = '<img src=x onerror=alert(1)>';
  const { root } = await svcSetup({
    'GET /api/teams': [{ id: 1, name: bad, positions: [{ id: 10, name: bad }] }],
    [SVC_PATH]: [{ id: 1, date: '2026-11-08', time: '09:00', title: bad, slots: [] }],
  });
  root.click('delete', 1);
  root.click('edit', 1);
  assert.ok(!root.innerHTML.includes('<img'));
  assert.match(root.innerHTML, /&lt;img/);
});

// ---------- schedule page ----------

test('buildSchedule groups positions by team order and sorts dates', () => {
  const s = schedule.buildSchedule(SERVICES, TEAMS);
  assert.deepEqual(s.columns.map((c) => [c.teamName, c.positions.map((p) => p.name)]), [['Band', ['Drums', 'Keys']], ['Sound', ['Mixer']]]);
  assert.deepEqual(s.rows.map((r) => r.service.id), [1, 2]);
  assert.deepEqual(s.rows[0].cells.get(10).map((x) => x.id), [2, 3]);
  // a position missing from the team list still shows
  const extra = schedule.buildSchedule([{ id: 1, date: '2026-11-08', time: '09:00', title: 'x', slots: [{ id: 1, positionId: 99, positionName: 'Usher', teamId: 9, teamName: 'Welcome', status: 'open', personId: null }] }], TEAMS);
  assert.deepEqual(extra.columns.map((c) => c.teamName), ['Welcome']);
});

test('schedule: grid and cards, each slot shows person and status words', async () => {
  const { root } = await schedSetup();
  const h = root.innerHTML;
  assert.match(h, /class="table-wrap sched-grid"/);
  assert.match(h, /class="cards sched-cards"/);
  assert.match(h, /colspan="2" class="sched-team">Band</);
  for (const w of ['Ann Lee', 'Bo Diaz', 'Cy Fox', 'Nobody yet', '>Waiting for answer<', '>Confirmed<', '>Declined<']) assert.ok(h.includes(w), w);
  // empty slot: icon with accessible name (Open text moved to aria-label)
  assert.ok(h.includes('aria-label="Nobody yet, choose someone"'), 'empty slot aria-label');
  assert.match(h, /Not needed/);
  assert.ok(!/style=/.test(h));
  const empty = await schedSetup({ [SCHED_PATH]: [] });
  assert.match(empty.root.innerHTML, /No services in the next 8 weeks/);
});

test('schedule: phone cards start closed with a count per status, open on tap, and stay open after filling a slot', async () => {
  const { api, root } = await schedSetup({ 'GET /api/admin/suggest?slotId=4': CANDS, 'PUT /api/slots/4/assign': { slot: {} } });
  const card = (id, next) => { const h = root.innerHTML; return h.slice(h.indexOf(`data-card="${id}"`), next ? h.indexOf(`data-card="${next}"`) : undefined); };
  assert.match(root.innerHTML, /data-action="toggle-service" data-id="1" aria-expanded="false"/);
  assert.match(root.innerHTML, /data-action="toggle-service" data-id="2" aria-expanded="false"/);
  const counts = (h) => [...h.matchAll(/aria-hidden="true"><\/span>(\d+ [a-z ]+)<\/span>/g)].map((x) => x[1]);
  // Problems only, in the order waiting, said no, open; confirmed is the line, with pips.
  assert.deepEqual(counts(card(1, 2)), ['1 waiting', '1 said no', '1 open']);
  assert.match(card(1, 2), /<span class="fill-pips" role="img" aria-label="1 of 4 confirmed, 1 waiting, 1 said no, 1 open"><span class="fill-pip is-ok"><\/span><span class="fill-pip is-wait"><\/span><span class="fill-pip is-bad"><\/span><span class="fill-pip is-open"><\/span><\/span><span class="fill-line">1 of 4 confirmed<\/span>/);
  assert.deepEqual(counts(card(2)), ['1 open']);
  assert.doesNotMatch(card(1, 2), /slot-list/, 'closed: no positions listed');
  assert.match(root.innerHTML, /sched-grid[\s\S]*data-action="slot-open" data-id="4"/, 'the wide-screen grid still shows every slot');
  root.click('toggle-service', 1);
  assert.match(card(1, 2), /aria-expanded="true"/);
  assert.match(card(1, 2), /<h3 class="team-title">Band<\/h3>[\s\S]*data-action="slot-open" data-id="4"/);
  assert.doesNotMatch(card(2), /slot-list/, 'only the tapped card opens');
  await root.click('slot-open', 4);
  await flush();
  await root.click('slot-assign', 30);
  await flush();
  assert.equal(api.calls.filter((c) => c.startsWith('PUT')).length, 1);
  assert.match(card(1, 2), /aria-expanded="true"/, 'still open after the page reloads');
  root.click('toggle-service', 1);
  assert.match(card(1, 2), /aria-expanded="false"/);
  assert.deepEqual(schedule.statusCounts(SERVICES[1]), { open: 1, pending: 1, accepted: 1, declined: 1 });
  assert.deepEqual(schedule.statusCounts({ slots: [] }), { open: 0, pending: 0, accepted: 0, declined: 0 });
});

test('schedule: empty slot shows plus icon with accessible name', async () => {
  const { root } = await schedSetup();
  const h = root.innerHTML;
  // Empty slots have the plus icon and aria-label, not visible text
  assert.ok(h.includes('aria-label="Nobody yet, choose someone"'), 'aria-label present');
  assert.ok(h.includes('data-icon="plus"'), 'plus icon data-icon');
  assert.ok(h.includes('class="slot-btn is-open"'), 'is-open class for empty slots');
});

test('schedule: today row has dot icon and visually hidden Today', async () => {
  const { root: rootToday } = await schedSetup({ [SCHED_PATH]: [
    { id: 10, date: TODAY, time: '10:00', title: 'Today service', slots: [{ id: 100, positionId: 10, positionName: 'Drums', teamId: 1, teamName: 'Band', status: 'open', personId: null, personName: null }] },
  ] });
  const hToday = rootToday.innerHTML;
  // Dot icon beside the date
  assert.ok(hToday.includes('data-icon="dot"'), 'dot icon present');
  // Today as visually hidden text
  assert.ok(hToday.includes('<span class="visually-hidden">Today</span>'), 'visually-hidden Today');
});

test('every class the schedule page emits is defined in style.css', async () => {
  const { root } = await schedSetup({ 'GET /api/admin/suggest?slotId=1': CANDS });
  await root.click('slot-open', 1);
  await flush();
  root.click('slot-remove-ask');
  const css = readFileSync(fileURLToPath(new URL('../web/style.css', import.meta.url)), 'utf8');
  const classes = new Set([...root.innerHTML.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
  assert.ok(classes.has('slot-btn') && classes.has('sched-grid') && classes.has('slot-panel'));
  for (const c of classes) assert.ok(new RegExp(`\\.${c}(?![\\w-])`).test(css), `.${c} missing in style.css`);
});

test('schedule: hostile names and titles stay text', async () => {
  const bad = '<script>x</script>';
  const svc = [{ id: 1, date: '2026-11-08', time: '09:00', title: bad, slots: [{ ...slot(1, 10), status: 'pending', personId: 3, personName: bad, teamName: bad, positionName: bad }] }];
  const { root } = await schedSetup({
    [SCHED_PATH]: svc, 'GET /api/teams': [],
    'GET /api/admin/suggest?slotId=1': { candidates: [{ personId: 4, name: bad, reasons: [bad] }] },
  });
  await root.click('slot-open', 1);
  await flush();
  assert.match(root.innerHTML, /data-slot-panel/);
  assert.ok(!root.innerHTML.includes('<script>'));
  assert.match(root.innerHTML, /&lt;script&gt;/);
});

test('slot panel: ranked suggestions with reasons, toggle shows untrained people', async () => {
  const { api, root, s } = await schedSetup({
    'GET /api/admin/suggest?slotId=4': CANDS,
    'GET /api/admin/suggest?slotId=4&includeUnqualified=true': { candidates: [...CANDS.candidates, { personId: 40, name: 'New Nia', qualified: false, reasons: ['Not set up for Keys'] }] },
  });
  await root.click('slot-open', 4);
  await flush();
  const h = root.innerHTML;
  assert.equal(api.calls[0], 'GET /api/admin/suggest?slotId=4');
  assert.ok(h.indexOf('Sam Ortiz') < h.indexOf('Old Joe'));
  assert.match(h, /Has not served in 8 weeks/);
  assert.match(h, /data-action="slot-assign" data-id="30">Assign</);
  assert.match(h, /Show people not trained for this/);
  assert.ok(!h.includes('slot-remove-ask')); // nobody in this slot
  assert.match(h, /<div class="slot-current is-empty">.*Nobody yet/s);
  root.click('slot-toggle');
  await flush();
  assert.equal(api.calls[1], 'GET /api/admin/suggest?slotId=4&includeUnqualified=true');
  assert.match(root.innerHTML, /New Nia/);
  assert.match(root.innerHTML, /Not trained/);
  assert.match(root.innerHTML, /aria-pressed="true"/);
  root.click('slot-close');
  assert.equal(s.panel.state, null);
  assert.ok(!root.innerHTML.includes('data-slot-panel'));
});

test('slot panel: assign works, reloads and closes', async () => {
  const { api, root } = await schedSetup({ 'GET /api/admin/suggest?slotId=4': CANDS, 'PUT /api/slots/4/assign': { slot: {} } });
  await root.click('slot-open', 4);
  await flush();
  await root.click('slot-assign', 30);
  await flush();
  assert.equal(api.calls[1], 'PUT /api/slots/4/assign {"personId":30,"force":false}');
  assert.ok(api.calls.includes(SCHED_PATH));
  assert.match(root.innerHTML, /Sam Ortiz is now on Keys, Sun 8 Nov at 9:00 am\. Waiting for their answer\./);
  assert.ok(!root.innerHTML.includes('data-slot-panel'));
});

for (const [code, text] of [
  ['blocked', 'Sam Ortiz is away on that date. Assign anyway?'],
  ['not_qualified', 'Sam Ortiz is not trained for Keys. Assign anyway?'],
  ['double_booked', 'Sam Ortiz is already serving at this service. Assign anyway?'],
  ['accepted', 'Someone else has already said yes to this. Put Sam Ortiz in instead?'],
]) {
  test(`slot panel: 409 ${code} explains, and retries with force only after confirming`, async () => {
    const bodies = [];
    const { api, root } = await schedSetup({
      'GET /api/admin/suggest?slotId=4': CANDS,
      'PUT /api/slots/4/assign': (b) => { bodies.push(b); return b.force ? { slot: {} } : conflict(code); },
    });
    await root.click('slot-open', 4);
    await flush();
    await root.click('slot-assign', 30);
    await flush();
    assert.deepEqual(bodies, [{ personId: 30, force: false }]);
    assert.ok(root.innerHTML.includes(text), root.innerHTML);
    assert.match(root.innerHTML, /Yes, assign anyway/);
    // going back sends nothing
    root.click('slot-conflict-back');
    assert.ok(!root.innerHTML.includes('Yes, assign anyway'));
    await root.click('slot-force');
    await flush();
    assert.equal(bodies.length, 1);
    // ask again, then confirm
    await root.click('slot-assign', 30);
    await flush();
    await root.click('slot-force');
    await flush();
    assert.deepEqual(bodies.at(-1), { personId: 30, force: true });
    assert.equal(api.calls.filter((c) => c.startsWith('PUT')).length, 3);
    assert.match(root.innerHTML, /is now on Keys/);
  });
}

for (const code of ['inactive', 'past']) {
  test(`slot panel: 409 ${code} explains and never offers or sends a forced retry`, async () => {
    const bodies = [];
    const { root } = await schedSetup({
      'GET /api/admin/suggest?slotId=4': CANDS,
      'PUT /api/slots/4/assign': (b) => { bodies.push(b); return conflict(code); },
    });
    await root.click('slot-open', 4);
    await flush();
    await root.click('slot-assign', 30);
    await flush();
    assert.ok(root.innerHTML.includes(String(html`${conflictMessage(code, 'Sam Ortiz')}`)));
    assert.ok(!root.innerHTML.includes('Yes, assign anyway'));
    assert.ok(!root.innerHTML.includes('data-action="slot-force"'));
    await root.click('slot-force');
    await flush();
    assert.equal(bodies.length, 1);
    assert.ok(bodies.every((b) => b.force === false));
  });
}

test('slot panel: a 409 without a known code shows the server words; other errors too', async () => {
  const { root } = await schedSetup({
    'GET /api/admin/suggest?slotId=4': CANDS,
    'PUT /api/slots/4/assign': new ApiError({ status: 404, message: 'Person not found' }),
  });
  await root.click('slot-open', 4);
  await flush();
  await root.click('slot-assign', 30);
  await flush();
  assert.match(root.innerHTML, /Person not found/);
});

test('slot panel: remove person asks first, then deletes', async () => {
  const { api, root } = await schedSetup({ 'GET /api/admin/suggest?slotId=2': CANDS, 'DELETE /api/slots/2/assign': { slot: {} } });
  await root.click('slot-open', 2);
  await flush();
  assert.match(root.innerHTML, /Bo Diaz/);
  await root.click('slot-remove-yes'); // not asked yet
  await flush();
  assert.equal(api.calls.length, 1);
  root.click('slot-remove-ask');
  assert.match(root.innerHTML, /Take Bo Diaz off Drums, Sun 8 Nov at 9:00 am\?/);
  root.click('slot-remove-no');
  assert.ok(!root.innerHTML.includes('Take Bo Diaz off'));
  root.click('slot-remove-ask');
  await root.click('slot-remove-yes');
  await flush();
  assert.equal(api.calls[1], 'DELETE /api/slots/2/assign');
  assert.match(root.innerHTML, /Bo Diaz was taken off Drums/);
});

// ---------- gaps page ----------

const GAPS = {
  summary: { open: 2, declined: 1, unanswered: 1, blocked: 1, inactive: 0 },
  items: [
    { type: 'declined', slotId: 3, serviceId: 1, date: '2026-11-08', time: '09:00', serviceTitle: 'Sunday service', positionName: 'Drums', teamName: 'Band', personId: 9, personName: 'Cy Fox' },
    { type: 'open', slotId: 4, serviceId: 1, date: '2026-11-08', time: '09:00', serviceTitle: 'Sunday service', positionName: 'Keys', teamName: 'Band' },
    { type: 'blocked', slotId: 6, serviceId: 1, date: '2026-11-08', time: '09:00', serviceTitle: 'Sunday service', positionName: 'Mixer', teamName: 'Sound', personId: 7, personName: 'Ann Lee' },
    { type: 'unanswered', slotId: 2, serviceId: 1, date: '2026-11-08', time: '09:00', serviceTitle: 'Sunday service', positionName: 'Drums', teamName: 'Band', personId: 8, personName: 'Bo Diaz' },
    { type: 'open', slotId: 5, serviceId: 2, date: '2026-11-15', time: '09:00', serviceTitle: 'Sunday service', positionName: 'Mixer', teamName: 'Sound' },
  ],
};
const REMINDERS = { reminders: [
  { personId: 7, name: 'Ann Lee', message: 'Hi Ann, a reminder that you are serving as Mixer on Sun 8 Nov at 09:00. We are glad you can make it. Thank you!' },
  { personId: 8, name: 'Bo Diaz', message: 'Hi Bo, a reminder. Please open Flock and accept or decline. Thank you!' },
] };
// The Reminders tab of the Gaps page.
async function remindersSetup(extra = {}, win) {
  const r = await gapsSetup(extra, win);
  await r.root.click('tab', undefined, { dataset: { action: 'tab', tab: 'reminders' } });
  return r;
}

async function gapsSetup(extra = {}, win) {
  const api = fakeApi({ 'GET /api/admin/gaps': GAPS, ...extra });
  const root = fakeRoot();
  const s = gaps.createScreen({ api, root, today: TODAY, win });
  await s.ready;
  api.calls.length = 0;
  return { api, root, s };
}

test('gaps: summary counts by kind, then one group per service (roster day) in date order, each item with its kind', async () => {
  const { root } = await gapsSetup();
  const h = root.innerHTML;
  // "5 gaps in the next 4 weeks", then a filter chip per kind present (none for kinds with zero).
  assert.match(h, /<p class="gap-summary" data-summary><span class="fill-num num">5<\/span><span class="fill-words">gaps in the next 4 weeks<\/span><\/p>/);
  assert.match(h, /data-filter="all" aria-pressed="true">All <span class="filter-count num" data-count="all">5<\/span>/);
  assert.match(h, /data-filter="open" aria-pressed="false">Nobody yet <span class="filter-count num" data-count="open">2<\/span>/);
  assert.doesNotMatch(h, /data-filter="inactive"/, 'no chip for a kind with none');
  assert.match(h, /data-tab="gaps" aria-pressed="true">Gaps<\/button><button type="button" class="segment" data-action="tab" data-tab="reminders" aria-pressed="false">Reminders</);
  assert.doesNotMatch(h, /data-reminders-panel/, 'reminders are on their own tab');
  // One group per service (its date and time), in date order, with a count badge (role="img").
  assert.deepEqual([...h.matchAll(/data-gap-service="([^"]+)"/g)].map((x) => x[1]), ['2026-11-08T09:00', '2026-11-15T09:00']);
  const badges = [...h.matchAll(/role="img" data-gap-count="([^"]+)" aria-label="([^"]+)">(\d+)</g)].map((x) => x.slice(1));
  assert.deepEqual(badges, [['2026-11-08T09:00', '4 gaps', '4'], ['2026-11-15T09:00', '1 gap', '1']]);
  assert.match(h, /<span class="gap-label num">Sun 8 Nov at 9:00 am<\/span>/);
  // Inside a group, each item still says what kind of gap it is, in words, with the person when there is one.
  const first = h.slice(h.indexOf('data-gap-service="2026-11-08T09:00"'), h.indexOf('data-gap-service="2026-11-15T09:00"'));
  assert.deepEqual([...first.matchAll(/data-gap-type="(\w+)"/g)].map((x) => x[1]), ['declined', 'open', 'blocked', 'unanswered']);
  assert.match(first, /<strong>Drums<\/strong> \(Band\)/);
  assert.match(first, /Said no<\/span> <span class="hint">Cy Fox<\/span>/);
  assert.match(first, /Hasn&#39;t answered<\/span> <span class="hint">Bo Diaz/);
  assert.match(first, /Nobody yet<\/span><\/span>/, 'an open position has no name');
  assert.deepEqual(gaps.groupGaps(GAPS.items).map((g) => [g.key, g.items.map((i) => i.slotId)]), [['2026-11-08T09:00', [3, 4, 6, 2]], ['2026-11-15T09:00', [5]]]);
  // Any order in, date order out; kinds the page does not know are left out.
  assert.deepEqual(gaps.groupGaps([GAPS.items[4], { ...GAPS.items[0], type: 'mystery' }, GAPS.items[1]]).map((g) => [g.key, g.items.length]), [['2026-11-08T09:00', 1], ['2026-11-15T09:00', 1]]);
  const empty = await gapsSetup({ 'GET /api/admin/gaps': { summary: {}, items: [] } });
  assert.match(empty.root.innerHTML, /No gaps/);
});

test('gaps: tapping an item opens the same slot panel', async () => {
  const { api, root } = await gapsSetup({ 'GET /api/admin/suggest?slotId=3': CANDS, 'PUT /api/slots/3/assign': { slot: {} } });
  await root.click('slot-open', 3);
  await flush();
  assert.equal(api.calls[0], 'GET /api/admin/suggest?slotId=3');
  assert.match(root.innerHTML, /data-slot-panel="3"/);
  assert.match(root.innerHTML, /Cy Fox/);
  assert.match(root.innerHTML, />Declined</);
  await root.click('slot-assign', 31);
  await flush();
  assert.equal(api.calls[1], 'PUT /api/slots/3/assign {"personId":31,"force":false}');
  assert.equal(api.calls[2], 'GET /api/admin/gaps');
  assert.match(root.innerHTML, /Old Joe is now on Drums/);
});

test('gaps: a now-away item shows the gap label, not a guessed status', async () => {
  const { root } = await gapsSetup({ 'GET /api/admin/suggest?slotId=6': CANDS });
  await root.click('slot-open', 6);
  await flush();
  const panel = root.innerHTML.split('data-slot-panel')[1];
  assert.match(panel, /Ann Lee<\/strong> <span class="chip chip-plain">Now away</);
  assert.ok(!panel.includes('Waiting for answer'));
  assert.match(panel, /<button type="button" class="btn btn-danger btn-sm" data-action="slot-remove-ask" aria-label="Remove Ann Lee">Remove<\/button>/);
});

test('gaps: hostile names stay text', async () => {
  const bad = '<b onmouseover=x>';
  const { root } = await gapsSetup({
    'GET /api/admin/gaps': { summary: {}, items: [{ ...GAPS.items[0], personName: bad, positionName: bad, teamName: bad, serviceTitle: bad }] },
    'GET /api/admin/reminders?weekOf=2026-11-08': { reminders: [{ personId: 1, name: bad, message: bad }] },
  });
  assert.ok(!root.innerHTML.includes('<b '));
  assert.match(root.innerHTML, /&lt;b onmouseover=x&gt;/);
  await root.click('tab', undefined, { dataset: { action: 'tab', tab: 'reminders' } });
  root.submit('reminders', { weekOf: '2026-11-08' });
  await flush();
  assert.ok(!root.innerHTML.includes('<b '));
  assert.match(root.innerHTML, /&lt;b onmouseover=x&gt;/);
});

test('reminders: never-sends note, pick a week, copy one and copy all', async () => {
  const copied = [];
  const win = { navigator: { clipboard: { writeText: async (t) => { copied.push(t); } } } };
  const { api, root } = await remindersSetup({ 'GET /api/admin/reminders?weekOf=2026-11-08': REMINDERS }, win);
  assert.match(root.innerHTML, /Flock never sends messages\. Copy these into your usual messages app\./);
  assert.match(root.innerHTML, /name="weekOf" type="date" required value="2026-11-04"/);
  root.submit('reminders', { weekOf: '2026-11-08' });
  await flush();
  assert.equal(api.calls[0], 'GET /api/admin/reminders?weekOf=2026-11-08');
  assert.match(root.innerHTML, /Hi Ann, a reminder/);
  assert.match(root.innerHTML, /Copy all/);
  await root.click('copy-one', 8);
  await flush();
  assert.deepEqual(copied, [REMINDERS.reminders[1].message]);
  assert.match(root.innerHTML, /Copied/);
  await root.click('copy-all');
  await flush();
  assert.equal(copied[1], `Ann Lee\n${REMINDERS.reminders[0].message}\n\nBo Diaz\n${REMINDERS.reminders[1].message}`);
  assert.equal(gaps.allRemindersText(REMINDERS.reminders), copied[1]);
});

test('reminders: Send reminders reaches those with notifications on; the rest keep Copy', async () => {
  const copied = [];
  const win = { navigator: { clipboard: { writeText: async (t) => { copied.push(t); } } } };
  const list = { push: true, reminders: [
    { ...REMINDERS.reminders[0], hasPush: true },
    { ...REMINDERS.reminders[1], hasPush: false },
  ] };
  const { api, root } = await remindersSetup({
    'GET /api/admin/reminders?weekOf=2026-11-08': list,
    'POST /api/admin/reminders/send': { weekOf: '2026-11-08', sent: [list.reminders[0].personId], copy: [list.reminders[1].personId] },
  }, win);
  root.submit('reminders', { weekOf: '2026-11-08' });
  await flush();
  assert.match(root.innerHTML, /People with notifications on can get theirs from Flock/);
  assert.match(root.innerHTML, /Send reminders \(1\)/);
  assert.match(root.innerHTML, /Notifications on/);
  await root.click('send-reminders');
  await flush();
  assert.equal(api.calls.at(-1), 'POST /api/admin/reminders/send {"weekOf":"2026-11-08"}');
  assert.match(root.innerHTML, /Sent to 1; 1 to copy\./);
  assert.doesNotMatch(root.innerHTML, /data-action="send-reminders"/, 'nobody left to send to');
  assert.doesNotMatch(root.innerHTML, new RegExp(`data-action="copy-one" data-id="${list.reminders[0].personId}"`));
  await root.click('copy-all');
  await flush();
  assert.deepEqual(copied, [`Bo Diaz\n${list.reminders[1].message}`], 'Copy all copies only the ones not sent');
  assert.equal(gaps.sentWords(0, 3), 'Nothing could be sent as a notification. Copy the messages instead.');
  assert.equal(gaps.sentWords(4, 0), 'Sent to 4.');
});

test('reminders: without push there is no Send button and a failed send is explained', async () => {
  const off = await remindersSetup({ 'GET /api/admin/reminders?weekOf=2026-11-08': { push: false, reminders: REMINDERS.reminders.map((x) => ({ ...x, hasPush: false })) } }, {});
  off.root.submit('reminders', { weekOf: '2026-11-08' });
  await flush();
  assert.doesNotMatch(off.root.innerHTML, /send-reminders/);
  const fail = Object.assign(new Error('Notifications are not set up on this Flock yet'), { status: 409 });
  const on = await remindersSetup({
    'GET /api/admin/reminders?weekOf=2026-11-08': { push: true, reminders: REMINDERS.reminders.map((x) => ({ ...x, hasPush: true })) },
    'POST /api/admin/reminders/send': fail,
  }, {});
  on.root.submit('reminders', { weekOf: '2026-11-08' });
  await flush();
  await on.root.click('send-reminders');
  await flush();
  assert.match(on.root.innerHTML, /not set up on this Flock yet/);
  assert.match(on.root.innerHTML, /data-action="copy-one"/, 'Copy is still there');
});

test('reminders: empty week and no clipboard are explained', async () => {
  const { root } = await remindersSetup({ 'GET /api/admin/reminders?weekOf=2026-11-08': { reminders: [] } }, {});
  root.submit('reminders', { weekOf: '2026-11-08' });
  await flush();
  assert.match(root.innerHTML, /Nobody is scheduled that week/);
  const two = await remindersSetup({ 'GET /api/admin/reminders?weekOf=2026-11-08': REMINDERS }, {});
  two.root.submit('reminders', { weekOf: '2026-11-08' });
  await flush();
  await two.root.click('copy-all');
  await flush();
  assert.match(two.root.innerHTML, /Could not copy/);
  const toast = two.root.innerHTML.match(/<div class="toast toast-error"[^>]*>[\s\S]*?<\/div>/)?.[0];
  assert.ok(toast, 'failed copy is an error toast, not a success toast');
  assert.match(toast, /role="alert"/);
  assert.match(toast, /data-icon="warning"/);
  assert.doesNotMatch(toast, /data-icon="check"/);
});

for (const action of ['copy-one', 'copy-all']) {
  test(`reminders: ${action} clears stale feedback on failure and retry`, async () => {
    let fail = true;
    const timers = [];
    const win = {
      navigator: { clipboard: { writeText: async () => { if (fail) throw new Error('NotAllowedError'); } } },
      setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
      clearTimeout() {},
    };
    const { root } = await remindersSetup({ 'GET /api/admin/reminders?weekOf=2026-11-08': REMINDERS }, win);
    root.submit('reminders', { weekOf: '2026-11-08' });
    await flush();
    root.click(action, 8);
    await flush();
    assert.match(root.innerHTML, /toast-error/);
    assert.doesNotMatch(root.innerHTML, /toast-ok/);
    assert.equal(timers.length, 0, 'a failed copy must not flash a check');

    fail = false;
    root.click(action, 8);
    await flush();
    assert.match(root.innerHTML, /toast-ok/);
    assert.doesNotMatch(root.innerHTML, /Could not copy|toast-error/);
    assert.equal(timers.length, 1);

    fail = true;
    root.click(action, 8);
    await flush();
    assert.match(root.innerHTML, /toast-error/);
    assert.doesNotMatch(root.innerHTML, /Copied\.|toast-ok/);
  });
}

test('views render a heading and mount safely without a screen element', () => {
  for (const v of [services, schedule, gaps]) {
    assert.match(v.render({}), /<h1 tabindex="-1">/);
    assert.equal(v.mount({}, {}), undefined);
  }
});

test('reminders: copy button shows a check SVG, then the copy SVG after 1.5s', async () => {
  const timers = [];
  const cleared = [];
  const win = {
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => cleared.push(id),
  };
  const { root } = await remindersSetup({ 'GET /api/admin/reminders?weekOf=2026-11-08': REMINDERS }, win);
  root.submit('reminders', { weekOf: '2026-11-08' });
  await flush();
  const CHECK = '<path d="M4.75 12.75l4.75 4.75 9.75-10.75"/>';
  const btn = { innerHTML: '', dataset: { action: 'copy-one', id: '8' } };
  btn.closest = (sel) => (sel === 'button' || sel === '[data-action]' ? btn : null);
  await root.fire('click', btn);
  await flush();
  assert.match(btn.innerHTML, /^<span class="icon" aria-hidden="true"><svg[^>]*>.*M4\.75 12\.75l4\.75 4\.75 9\.75-10\.75.*<\/svg><\/span> Copy$/);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1500);
  await root.fire('click', btn);
  await flush();
  assert.deepEqual(cleared, [1]);
  assert.equal(timers.length, 2);
  timers[1].fn();
  assert.ok(!btn.innerHTML.includes(CHECK));
  assert.match(btn.innerHTML, /<svg[^>]*>.*rect.*<\/svg><\/span> Copy$/);
});

// ---------- fill open positions (auto-fill) ----------

test('nextMonday: the Monday after today, never today', () => {
  assert.equal(schedule.nextMonday('2026-11-04'), '2026-11-09'); // Wednesday
  assert.equal(schedule.nextMonday('2026-11-08'), '2026-11-09'); // Sunday
  assert.equal(schedule.nextMonday('2026-11-09'), '2026-11-16'); // Monday
  assert.equal(schedule.nextMonday('2026-12-31'), '2027-01-04'); // across the year
});

const PLAN = {
  applied: false, weekOf: '2026-11-09', weeks: 2,
  assigned: [{ slotId: 4, serviceId: 1, date: '2026-11-15', time: '09:00', serviceTitle: 'Sunday service', teamName: 'Band', positionName: 'Keys', personId: 30, personName: '<b>Sam</b> Ortiz', everyWeeks: 2 }],
  unfilled: [{ slotId: 5, serviceId: 2, date: '2026-11-15', time: '09:00', serviceTitle: 'Sunday service', teamName: 'Sound', positionName: 'Mixer', reason: 'nobody_qualified', message: 'Nobody is set up for Mixer' }],
};

test('schedule: fill open positions previews, then asks, then reloads', async () => {
  const { api, root } = await schedSetup({
    'POST /api/admin/autofill': (body) => (body.apply ? { ...PLAN, applied: true } : PLAN),
  });
  assert.match(root.innerHTML, /data-action="autofill-open" aria-haspopup="dialog">.*Fill open positions/);
  assert.doesNotMatch(root.innerHTML, /data-form="autofill"/, 'the form is in a sheet, closed');
  await root.click('autofill-open');
  assert.match(root.innerHTML, /<section class="sheet" data-autofill role="dialog" aria-modal="true" aria-labelledby="autofill-title">/);
  assert.match(root.innerHTML, /name="weekOf" type="date" required value="2026-11-09"/);
  assert.match(root.innerHTML, /<option value="1" selected>1<\/option>/);

  await root.submit('autofill', { weekOf: '2026-11-09', weeks: '2' });
  await flush();
  assert.deepEqual(api.calls, ['POST /api/admin/autofill {"weekOf":"2026-11-09","weeks":2,"apply":false}']);
  const h = root.innerHTML;
  assert.match(h, /Who Flock would ask \(1\)/);
  assert.match(h, /&lt;b&gt;Sam&lt;\/b&gt; Ortiz/);
  assert.match(h, /Still open \(1\)/);
  assert.match(h, /Nobody is set up for Mixer/);
  assert.match(h, /<option value="2" selected>2<\/option>/);

  api.calls.length = 0;
  await root.click('autofill-apply');
  await flush();
  assert.equal(api.calls[0], 'POST /api/admin/autofill {"weekOf":"2026-11-09","weeks":2,"apply":true}');
  assert.ok(api.calls.includes('GET /api/teams') && api.calls.includes(SCHED_PATH), 'the schedule reloads');
  assert.match(root.innerHTML, /Asked 1 person\. They will see it in My schedule\./);
  assert.doesNotMatch(root.innerHTML, /data-autofill-result/);
  assert.doesNotMatch(root.innerHTML, /data-autofill-sheet/, 'the sheet closes after asking');
});

test('schedule: fill open positions: bad date, cancel and a server error', async () => {
  const { api, root } = await schedSetup({ 'POST /api/admin/autofill': PLAN });
  await root.click('autofill-open');
  await root.submit('autofill', { weekOf: '', weeks: '1' });
  assert.match(root.innerHTML, /Please pick a date\./);
  assert.equal(api.calls.length, 0);

  await root.submit('autofill', { weekOf: '2026-11-09', weeks: '1' });
  await flush();
  assert.match(root.innerHTML, /data-autofill-result/);
  assert.match(root.innerHTML, /<div class="sheet-foot"><div class="btn-row btn-row-split">\s*<button type="button" class="btn btn-primary" data-action="autofill-apply"/);
  await root.click('autofill-cancel');
  assert.doesNotMatch(root.innerHTML, /data-autofill-result/);
  assert.doesNotMatch(root.innerHTML, /data-autofill-sheet/, 'Cancel also closes the sheet');
  assert.equal(api.calls.filter((c) => c.includes('"apply":true')).length, 0, 'cancel asks nobody');

  const bad = await schedSetup({ 'POST /api/admin/autofill': new ApiError({ status: 400, message: 'Those weeks are already over' }) });
  await bad.root.click('autofill-open');
  await bad.root.submit('autofill', { weekOf: '2026-11-02', weeks: '1' });
  await flush();
  assert.match(bad.root.innerHTML, /Those weeks are already over/);
});

test('schedule: the fill card counts every position, and a full service says so', () => {
  const t = schedule.fillTotals(SERVICES);
  assert.equal(t.total, t.open + t.pending + t.accepted + t.declined);
  const m = { services: SERVICES, teams: TEAMS, loading: false, error: '', notice: '', today: '2026-11-08', from: '2026-11-08', to: '2027-01-02', open: new Set(), autofill: { weekOf: '2026-11-09', weeks: 1 } };
  const h = schedule.renderScreen(m);
  assert.match(h, new RegExp(`<p class="fill-head"><span class="fill-num num">${t.accepted}</span><span class="fill-words">of ${t.total} positions confirmed</span></p>`));
  assert.match(h, new RegExp(`<progress class="fill-total" max="${t.total}" value="${t.accepted}">`));
  assert.doesNotMatch(schedule.renderScreen({ ...m, services: [] }), /data-fill/, 'nothing to count: no card');
  const full = [{ id: 9, date: '2026-11-22', time: '09:00', title: 'Sunday service', slots: [
    { id: 90, positionId: 10, positionName: 'Drums', teamId: 1, teamName: 'Band', personId: 1, personName: 'Ann', status: 'accepted' },
    { id: 91, positionId: 11, positionName: 'Keys', teamId: 1, teamName: 'Band', personId: 2, personName: 'Bo', status: 'accepted' }] }];
  const fh = schedule.renderScreen({ ...m, services: full });
  assert.match(fh, /class="card sched-card is-full" data-card="9"/);
  assert.match(fh, /<span class="fill-line"><span class="icon icon-sm" data-icon="check" aria-hidden="true"><\/span> All 2 confirmed<\/span>/);
  assert.equal(schedule.fillWords({ open: 1, pending: 2, accepted: 5, declined: 1 }), '5 of 9 confirmed, 2 waiting, 1 said no, 1 open');
  const many = [{ ...full[0], slots: Array.from({ length: 25 }, (_, i) => ({ ...full[0].slots[0], id: 100 + i })) }];
  assert.doesNotMatch(schedule.renderScreen({ ...m, services: many }), /fill-pips/, 'over 24 positions: the line alone');
});

test('gaps: a filter shows one kind and hides services left empty; the tabs swap gaps and reminders', async () => {
  const { root } = await gapsSetup();
  const filter = (f) => root.click('filter', undefined, { dataset: { action: 'filter', filter: f } });
  await filter('declined');
  let h = root.innerHTML;
  assert.match(h, /data-filter="declined" aria-pressed="true"/);
  assert.match(h, /data-filter="all" aria-pressed="false"/);
  assert.deepEqual([...h.matchAll(/data-gap-type="(\w+)"/g)].map((x) => x[1]), ['declined']);
  assert.deepEqual([...h.matchAll(/data-gap-service="([^"]+)"/g)].map((x) => x[1]), ['2026-11-08T09:00'], 'the other service has no "Said no": hidden');
  assert.match(h, /data-count="all">5</, 'the counts still say the whole picture');
  await filter('nonsense');
  assert.match(root.innerHTML, /data-filter="all" aria-pressed="true"/);
  await root.click('tab', undefined, { dataset: { action: 'tab', tab: 'reminders' } });
  h = root.innerHTML;
  assert.match(h, /data-tab="reminders" aria-pressed="true"/);
  assert.match(h, /data-reminders-panel/);
  assert.doesNotMatch(h, /data-gap-service|data-summary/);
  await root.click('tab', undefined, { dataset: { action: 'tab', tab: 'gaps' } });
  assert.match(root.innerHTML, /data-summary/);
});

test('slot sheet: the position and when in the head, who is in it, short toggle words, and the best match', async () => {
  const { root } = await schedSetup({ 'GET /api/admin/suggest?slotId=4': CANDS });
  await root.click('slot-open', 4);
  await flush();
  const h = root.innerHTML.slice(root.innerHTML.indexOf('data-slot-panel'));
  assert.match(h, /<div class="sheet-titles"><h2 id="slot-panel-title" tabindex="-1">Keys<\/h2><p class="sheet-sub" id="slot-panel-when">Band · Sun 8 Nov at <span class="num">9:00 am<\/span><\/p><\/div>/);
  assert.match(h, /aria-describedby="slot-panel-when"|slot-panel-when/);
  assert.match(h, /class="segment" aria-pressed="true" aria-label="Only people trained for this">Trained</);
  assert.match(h, /class="segment" data-action="slot-toggle" aria-pressed="false" aria-label="Show people not trained for this">Everyone</);
  const cands = [...h.matchAll(/data-candidate="(\d+)">[\s\S]*?<\/li>\s*(?=<li class="candidate"|<\/ol>)/g)].map((m) => m[0]);
  assert.match(cands[0], /<span class="chip chip-info"><span class="icon chip-icon" data-icon="sparkle" aria-hidden="true"><\/span>Best match<\/span>/);
  assert.match(cands[0], /class="btn btn-primary" data-action="slot-assign"/);
  for (const c of cands.slice(1)) {
    assert.doesNotMatch(c, /Best match/);
    assert.match(c, /class="btn" data-action="slot-assign"/);
  }
  // A filled slot: the person and their status, with Remove; its are-you-sure takes the button's place.
  await root.click('slot-close');
  await root.click('slot-open', 2);
  await flush();
  const f = root.innerHTML.slice(root.innerHTML.indexOf('data-slot-panel'));
  assert.match(f, /<div class="slot-current"><span class="avatar[^>]*>[A-Z]+<\/span><div class="slot-current-text"><p class="sheet-who"><strong>/);
  root.click('slot-remove-ask');
  const r = root.innerHTML.slice(root.innerHTML.indexOf('data-slot-panel'));
  assert.doesNotMatch(r, /data-action="slot-remove-ask"/);
  assert.match(r, /data-action="slot-remove-yes"/);
});
