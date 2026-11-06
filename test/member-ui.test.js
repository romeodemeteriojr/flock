import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeRoot, fakeApi } from './helpers/fakeroot.js';
import { formatDate, formatRange, formatTime, daysUntil, relativeDay } from '../web/lib/dates.js';
import * as sched from '../web/views/my-schedule.js';
import * as off from '../web/views/my-blockouts.js';

const TODAY = '2026-11-04'; // a Wednesday
const item = (o = {}) => ({
  slotId: 1, date: '2026-11-08', time: '09:00', serviceTitle: 'Sunday service', positionName: 'Sound',
  teamName: 'Tech', status: 'pending', coVolunteers: [], ...o,
});
const data = (items, next = items[0] ?? null) => ({ nextServing: next, items });
const setup = async (view, routes, extra = {}) => {
  const root = fakeRoot();
  const api = fakeApi(routes);
  await view.mount(root, { api, state: {}, today: TODAY, ...extra });
  return { root, api };
};

test('date helpers', () => {
  assert.equal(formatDate('2026-11-08'), 'Sun 8 Nov');
  assert.equal(formatDate('2024-02-29'), 'Thu 29 Feb');
  assert.equal(formatDate('nope'), 'nope');
  assert.equal(formatRange('2026-11-08', '2026-11-08'), 'Sun 8 Nov');
  assert.equal(formatRange('2026-11-08', '2026-11-10'), 'Sun 8 Nov to Tue 10 Nov');
  assert.equal(formatTime('09:00'), '9:00 am');
  assert.equal(formatTime('00:30'), '12:30 am');
  assert.equal(formatTime('12:00'), '12:00 pm');
  assert.equal(formatTime('18:15'), '6:15 pm');
  assert.equal(daysUntil('2026-12-01', '2026-11-30'), 1);
  assert.equal(daysUntil('2026-03-01', '2026-02-28'), 1); // month end, non-leap
  assert.equal(daysUntil('2024-03-01', '2024-02-28'), 2); // leap year
  assert.equal(daysUntil('2024-02-29', '2024-02-28'), 1);
  assert.equal(daysUntil('2027-01-01', '2026-12-31'), 1); // year end
  assert.equal(daysUntil('2026-11-01', '2026-11-04'), -3);
  assert.equal(relativeDay('2026-11-04', TODAY), 'Today');
  assert.equal(relativeDay('2026-11-05', TODAY), 'Tomorrow');
  assert.equal(relativeDay('2026-11-08', TODAY), 'This Sunday');
  assert.equal(relativeDay('2026-11-22', TODAY), 'Sun 22 Nov');
});

test('banner text cases', () => {
  assert.equal(sched.bannerText(item(), TODAY), "You're serving this Sunday as Sound at 9:00 am");
  assert.equal(sched.bannerText(item({ date: TODAY }), TODAY), "You're serving today as Sound at 9:00 am");
  assert.equal(sched.bannerText(item({ date: '2026-11-05' }), TODAY), "You're serving tomorrow as Sound at 9:00 am");
  assert.equal(sched.bannerText(item({ date: '2026-11-22' }), TODAY), 'Next time you serve: Sun 22 Nov, Sound');
  assert.equal(sched.bannerText(null, TODAY), "You're not scheduled yet. Your scheduler will let you know.");
});

test('schedule: pending has both buttons, confirmed does not; chips have words', async () => {
  const { root } = await setup(sched, {
    'GET /api/me/schedule': data([item(), item({ slotId: 2, status: 'accepted', date: '2026-11-15' })]),
  });
  const [a, b] = root.innerHTML.split('<li ').slice(1);
  assert.match(a, />Yes, I can</);
  assert.match(a, />I can't</);
  assert.match(a, /Please answer/);
  assert.doesNotMatch(b, /Yes, I can</);
  assert.match(b, /Confirmed/);
  assert.match(b, /I can't make it after all/);
  assert.match(root.innerHTML, /data-banner>You&#39;re serving this Sunday as Sound at 9:00 am/);
});

test('schedule: co-volunteers listed and escaped', async () => {
  const { root } = await setup(sched, {
    'GET /api/me/schedule': data([item({ coVolunteers: [{ name: '<b>x</b>', positionName: 'Drums' }, { name: 'Ana', positionName: 'Keys' }] })]),
  });
  assert.match(root.innerHTML, /Serving with: &lt;b&gt;x&lt;\/b&gt; \(Drums\), Ana \(Keys\)/);
  assert.doesNotMatch(root.innerHTML, /<b>x<\/b>/);
});

test('schedule: Yes and I can\'t call the API and refresh', async () => {
  const { root, api } = await setup(sched, { 'GET /api/me/schedule': data([item()]) });
  await root.click('accept', 1);
  assert.deepEqual(api.calls, ['GET /api/me/schedule', 'POST /api/me/slots/1/accept {}', 'GET /api/me/schedule']);
  assert.match(root.innerHTML, /You are confirmed/);
  await root.click('decline', 1);
  assert.equal(api.calls[3], 'POST /api/me/slots/1/decline {}');
  assert.equal(api.calls.length, 5);
});

test('schedule: confirmed decline needs a confirm step', async () => {
  const { root, api } = await setup(sched, { 'GET /api/me/schedule': data([item({ status: 'accepted' })]) });
  await root.click('decline-ask', 1);
  assert.equal(api.calls.length, 1);
  assert.match(root.innerHTML, /Are you sure/);
  await root.click('keep', 1);
  assert.doesNotMatch(root.innerHTML, /Are you sure/);
  await root.click('decline-ask', 1);
  await root.click('decline-sure', 1);
  assert.equal(api.calls[1], 'POST /api/me/slots/1/decline {}');
});

test('schedule: empty, error and failed answer states', async () => {
  let { root } = await setup(sched, { 'GET /api/me/schedule': data([]) });
  assert.match(root.innerHTML, /not scheduled yet/);
  assert.match(root.innerHTML, /nothing coming up/);

  ({ root } = await setup(sched, { 'GET /api/me/schedule': new Error('Server is asleep') }));
  assert.match(root.innerHTML, /Server is asleep/);
  assert.match(root.innerHTML, /Try again/);

  assert.match(sched.render({}), /Loading/);

  ({ root } = await setup(sched, { 'GET /api/me/schedule': data([item()]), 'POST /api/me/slots/1/accept': new Error('Someone else took it') }));
  await root.click('accept', 1);
  assert.match(root.innerHTML, /Someone else took it/);
  assert.match(root.innerHTML, /Yes, I can/);
});

test('days off: form is prefilled, validated, and posts', async () => {
  const { root, api } = await setup(off, { 'GET /api/me/blockouts': { blockouts: [] }, 'POST /api/me/blockouts': { blockout: {}, conflicts: [] } });
  assert.match(root.innerHTML, /name="from"[^>]*value="2026-11-04"/);
  assert.match(root.innerHTML, /name="to"[^>]*value="2026-11-04"/);
  assert.match(root.innerHTML, /You have no days off saved/);

  await root.submit('blockout', { from: '', to: '', reason: '' });
  assert.match(root.innerHTML, /Please pick/);
  await root.submit('blockout', { from: '2026-11-10', to: '2026-11-09', reason: '' });
  assert.match(root.innerHTML, /be before the/);
  assert.equal(api.calls.length, 1);

  await root.submit('blockout', { from: '2026-11-10', to: '2026-11-12', reason: 'Trip' });
  assert.equal(api.calls[1], 'POST /api/me/blockouts {"startDate":"2026-11-10","endDate":"2026-11-12","reason":"Trip"}');
  assert.match(root.innerHTML, /Saved/);
  assert.doesNotMatch(root.innerHTML, /data-conflicts/);
});

test('days off: conflict notice, list, remove, errors', async () => {
  const conflict = { slotId: 1, date: '2026-11-08', time: '09:00', positionName: 'Sound', teamName: 'Tech', status: 'pending' };
  const { root, api } = await setup(off, {
    'GET /api/me/blockouts': { blockouts: [{ id: 7, startDate: '2026-11-08', endDate: '2026-11-08', reason: '<i>Trip</i>' }] },
    'POST /api/me/blockouts': { blockout: {}, conflicts: [conflict] },
  });
  assert.match(root.innerHTML, /&lt;i&gt;Trip&lt;\/i&gt;/);
  assert.match(root.innerHTML, />Remove</);
  await root.submit('blockout', { from: '2026-11-08', to: '2026-11-08', reason: '' });
  assert.match(root.innerHTML, /You are already scheduled on Sun 8 Nov as Sound\. Please tell your scheduler\./);
  await root.click('remove', 7);
  assert.equal(api.calls.includes('DELETE /api/me/blockouts/7'), true);
  assert.match(root.innerHTML, /Removed/);

  const bad = await setup(off, { 'GET /api/me/blockouts': { blockouts: [] }, 'POST /api/me/blockouts': new Error('That is too long.') });
  await bad.root.submit('blockout', { from: '2026-11-08', to: '2026-11-08', reason: '' });
  assert.match(bad.root.innerHTML, /That is too long\./);
});

test('mounting twice on the same root leaves one set of handlers', async () => {
  const root = fakeRoot();
  const api = fakeApi({
    'GET /api/me/schedule': data([item()]),
    'GET /api/me/blockouts': { blockouts: [] },
    'POST /api/me/blockouts': { blockout: {}, conflicts: [] },
  });
  const ctx = { api, state: {}, today: TODAY };
  await sched.mount(root, ctx);
  await off.mount(root, ctx);
  await sched.mount(root, ctx);
  api.calls.length = 0;
  await root.click('accept', 1);
  assert.equal(api.calls.filter((c) => c.startsWith('POST')).length, 1);

  await off.mount(root, ctx);
  api.calls.length = 0;
  await root.submit('blockout', { from: '2026-11-08', to: '2026-11-08', reason: '' });
  assert.equal(api.calls.filter((c) => c.startsWith('POST')).length, 1);
});

test('a slow load finishing after navigation does not overwrite the new page', async () => {
  const root = fakeRoot();
  let release;
  const api = {
    get: () => new Promise((r) => { release = () => r(data([item()])); }),
    post: async () => ({}),
  };
  const p = sched.mount(root, { api, state: {}, today: TODAY });
  root.innerHTML = '<p>New page</p>'; // what the app does on navigation
  assert.equal(root.innerHTML, '');
  release();
  await p;
  assert.equal(root.innerHTML, '');
});
