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

test('services: edit patches date, time and title', async () => {
  const { api, root } = await svcSetup();
  root.click('edit', 2);
  assert.match(root.innerHTML, /data-form="edit"/);
  root.submit('edit', { date: '2026-11-16', time: '18:00', title: 'Evening' }, 2);
  await flush();
  assert.equal(api.calls[0], 'PATCH /api/services/2 {"date":"2026-11-16","time":"18:00","title":"Evening"}');
  assert.match(root.innerHTML, /Service saved/);
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
  for (const w of ['Ann Lee', 'Bo Diaz', 'Cy Fox', 'Nobody yet', '>Open<', '>Waiting for answer<', '>Confirmed<', '>Declined<']) assert.ok(h.includes(w), w);
  assert.match(h, /Not needed/);
  assert.ok(!/style=/.test(h));
  const empty = await schedSetup({ [SCHED_PATH]: [] });
  assert.match(empty.root.innerHTML, /No services in the next 8 weeks/);
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
  assert.ok(!h.includes('Remove person')); // nobody in this slot
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
async function gapsSetup(extra = {}, win) {
  const api = fakeApi({ 'GET /api/admin/gaps': GAPS, ...extra });
  const root = fakeRoot();
  const s = gaps.createScreen({ api, root, today: TODAY, win });
  await s.ready;
  api.calls.length = 0;
  return { api, root, s };
}

test('gaps: summary counts and groups in a fixed order with plain labels', async () => {
  const { root } = await gapsSetup();
  const h = root.innerHTML;
  assert.match(h, /data-count="open">2<\/strong> Nobody yet/);
  assert.match(h, /data-count="inactive">0<\/strong> No longer active/);
  // Group headers: icon + label + count badge, in the correct order
  const labels = ['Nobody yet', 'Said no', "Hasn&#39;t answered", 'Now away'];
  const types = ['open', 'declined', 'unanswered', 'blocked'];
  // Each group must appear in the fixed GAP_ORDER; positions must be strictly ascending.
  const positions = types.map((t) => [h.indexOf(`data-gap-group="${t}"`), h.indexOf(`data-gap-count="${t}"`)]);
  assert.ok(positions.every(([i]) => i > 0), 'all group markers present');
  // Orders: first-group < first-of-next-group < ...
  const firstPositions = positions.map(([i]) => i);
  for (let i = 1; i < firstPositions.length; i++) {
    assert.ok(firstPositions[i] > firstPositions[i - 1], `group order: ${types[i - 1]} before ${types[i]}`);
  }
  // Each count badge has a correct aria-label like "1 declined" (role="img").
  const badgeRegex = /data-gap-count="(\w+)" aria-label="(\d+) (\w+)"/g;
  const badges = [...h.matchAll(badgeRegex)];
  assert.equal(badges.length, 4, 'exactly 4 count badges');
  for (const [_, type, n, label] of badges) {
    assert.equal(n, String(GAPS.summary[type]), `badge count for ${type}`);
    assert.equal(label, type, `badge type for ${type}`);
    assert.ok(n !== '0', `${type} badge is visible (count > 0)`);
  }
  assert.ok(!h.includes('data-gap-group="inactive"'));
  assert.deepEqual(gaps.groupGaps(GAPS.items).map((g) => g.label), ['Nobody yet', 'Said no', "Hasn't answered", 'Now away']);
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
  assert.match(panel, /Remove person/);
});

test('gaps: hostile names stay text', async () => {
  const bad = '<b onmouseover=x>';
  const { root } = await gapsSetup({
    'GET /api/admin/gaps': { summary: {}, items: [{ ...GAPS.items[0], personName: bad, positionName: bad, teamName: bad, serviceTitle: bad }] },
    'GET /api/admin/reminders?weekOf=2026-11-08': { reminders: [{ personId: 1, name: bad, message: bad }] },
  });
  root.submit('reminders', { weekOf: '2026-11-08' });
  await flush();
  assert.ok(!root.innerHTML.includes('<b '));
  assert.match(root.innerHTML, /&lt;b onmouseover=x&gt;/);
});

test('reminders: never-sends note, pick a week, copy one and copy all', async () => {
  const copied = [];
  const win = { navigator: { clipboard: { writeText: async (t) => { copied.push(t); } } } };
  const { api, root } = await gapsSetup({ 'GET /api/admin/reminders?weekOf=2026-11-08': REMINDERS }, win);
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

test('reminders: empty week and no clipboard are explained', async () => {
  const { root } = await gapsSetup({ 'GET /api/admin/reminders?weekOf=2026-11-08': { reminders: [] } }, {});
  root.submit('reminders', { weekOf: '2026-11-08' });
  await flush();
  assert.match(root.innerHTML, /Nobody is scheduled that week/);
  const two = await gapsSetup({ 'GET /api/admin/reminders?weekOf=2026-11-08': REMINDERS }, {});
  two.root.submit('reminders', { weekOf: '2026-11-08' });
  await flush();
  await two.root.click('copy-all');
  await flush();
  assert.match(two.root.innerHTML, /Could not copy/);
});

test('views render a heading and mount safely without a screen element', () => {
  for (const v of [services, schedule, gaps]) {
    assert.match(v.render({}), /<h1 tabindex="-1">/);
    assert.equal(v.mount({}, {}), undefined);
  }
});
