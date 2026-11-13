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

test('hero: carries the earliest ask, else the next time serving; says who else serves', () => {
  const ask = item({ slotId: 3, date: '2026-11-15' });
  const yes = item({ slotId: 2, status: 'accepted' });
  assert.equal(sched.heroItem({ nextServing: yes, items: [yes, ask] }), ask, 'an ask comes first');
  assert.equal(sched.heroItem({ nextServing: yes, items: [yes] }), yes);
  assert.equal(sched.heroItem({ nextServing: yes, items: [yes, ask] }, 2), yes, 'the one just confirmed, for its thank-you');
  assert.equal(sched.heroItem({ nextServing: null, items: [] }), null);
  const co = (...names) => names.map((name) => ({ name, positionName: 'X' }));
  assert.equal(sched.withWords([]), '');
  assert.equal(sched.withWords(co('Ana Lee')), 'With Ana');
  assert.equal(sched.withWords(co('Ana Lee', 'Bo Kim')), 'With Ana and Bo');
  assert.equal(sched.withWords(co('Ana', 'Bo', 'Cy')), 'With Ana, Bo and Cy');
  assert.equal(sched.withWords(co('Ana', 'Bo', 'Cy', 'Di', 'Ed')), 'With Ana, Bo and 3 others');
  assert.equal(sched.withWords(co('Ana Lee', 'Ana Kim')), 'With Ana Lee and Ana Kim', 'full names when first names repeat');
});

test('schedule: the hero asks with Yes / I can\'t; others follow as compact cards', async () => {
  const { root } = await setup(sched, {
    'GET /api/me/schedule': data([item(), item({ slotId: 2, status: 'accepted', date: '2026-11-15' }), item({ slotId: 4, date: '2026-11-22' })]),
  });
  const h = root.innerHTML;
  const heroHtml = h.slice(h.indexOf('<section class="hero hero-next'), h.indexOf('</section>', h.indexOf('hero-next')));
  assert.match(heroHtml, /data-slot="1"/);
  assert.match(heroHtml, /data-icon="clock"[^>]*><\/span> Please answer · This Sunday/);
  assert.match(heroHtml, /data-banner>Sun 8 Nov at <span class="num">9:00 am<\/span>/);
  assert.match(heroHtml, /<p class="hero-role"><strong>Sound<\/strong> · Tech<\/p>/);
  assert.match(heroHtml, /<p class="hero-ask" id="hero-ask">Can you serve\?<\/p>/);
  assert.match(heroHtml, /role="group" aria-labelledby="hero-ask"><button type="button" class="btn btn-lg btn-hero" data-action="accept" data-id="1"/);
  assert.match(heroHtml, /class="btn btn-lg btn-hero-quiet" data-action="decline" data-id="1"/);
  assert.match(h, /<h2 class="section-title">Also needs your answer<\/h2>[\s\S]*data-slot="4"[\s\S]*data-action="accept" data-id="4"/);
  assert.match(h, /<h2 class="section-title">Coming up<\/h2>[\s\S]*data-slot="2"/);
  assert.equal((h.match(/data-slot="1"/g) || []).length, 1, 'the hero item is not repeated');
  const confirmed = h.slice(h.indexOf('data-slot="2"'));
  assert.match(confirmed, /chip-ok[^>]*>.*Confirmed/s);
  assert.doesNotMatch(confirmed.slice(0, confirmed.indexOf('</li>')), /Yes, I can/);
});

test('schedule: a confirmed hero says so, with the way out; details of a compact card open on tap', async () => {
  const { root } = await setup(sched, {
    'GET /api/me/schedule': data([item({ status: 'accepted' }), item({ slotId: 2, status: 'accepted', date: '2026-11-15', coVolunteers: [{ name: 'Ana', positionName: 'Keys' }] })]),
  });
  assert.match(root.innerHTML, /data-icon="sparkle"[^>]*><\/span> Next up · This Sunday/);
  assert.match(root.innerHTML, /<span class="chip hero-chip">.*Confirmed<\/span><button type="button" class="hero-link" data-action="decline-ask" data-id="1"/);
  assert.match(root.innerHTML, /data-action="card" data-id="2" aria-expanded="false"/);
  assert.doesNotMatch(root.innerHTML, /Serving with/);
  await root.click('card', 2);
  assert.match(root.innerHTML, /data-action="card" data-id="2" aria-expanded="true"/);
  assert.match(root.innerHTML, /Serving with: Ana \(Keys\)/);
  assert.match(root.innerHTML, /data-action="decline-ask" data-id="2"/);
  await root.click('card', 2);
  assert.doesNotMatch(root.innerHTML, /Serving with/);
});

test('status chip compact: each of the four statuses has an accessible name, and the icons differ', async () => {
  const { root } = await setup(sched, {
    'GET /api/me/schedule': data([item(), item({ slotId: 2, status: 'accepted', date: '2026-11-15' })]),
  });
  // the schedule page says it in words (with an icon), never colour alone
  assert.match(root.innerHTML, /hero-eyebrow">.*Please answer/s);
  assert.match(root.innerHTML, /chip-ok[^>]*>.*Confirmed/s);
  const { statusChip } = await import('../web/lib/slotpanel.js');
  const names = ['open', 'pending', 'accepted', 'declined'].map((s) => String(statusChip(s, { compact: true })));
  for (const [i, st] of ['open', 'pending', 'accepted', 'declined'].entries()) {
    const name = [...names[i].matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(name.length, 1, st);
    assert.ok(name[0].trim() !== '', `${st} has an accessible name`);
  }
  const icons = names.map((s) => [...s.matchAll(/data-icon="([^"]+)"/g)].map((m) => m[1]));
  assert.equal(new Set(icons.flat()).size, 4, 'the four statuses use four distinct icons');
});

test('schedule: co-volunteers listed and escaped', async () => {
  const co = [{ name: '<b>x</b>', positionName: 'Drums' }, { name: 'Ana', positionName: 'Keys' }];
  const { root } = await setup(sched, {
    'GET /api/me/schedule': data([item({ coVolunteers: co }), item({ slotId: 2, status: 'accepted', date: '2026-11-15', coVolunteers: co })]),
  });
  assert.match(root.innerHTML, /<span>With &lt;b&gt;x&lt;\/b&gt; and Ana<\/span>/);
  assert.equal((root.innerHTML.match(/class="avatar /g) || []).length, 2, 'one small picture each');
  await root.click('card', 2);
  assert.match(root.innerHTML, /Serving with: &lt;b&gt;x&lt;\/b&gt; \(Drums\), Ana \(Keys\)/);
  assert.doesNotMatch(root.innerHTML, /<b>x<\/b>/);
});

test('schedule: the full roster of the day opens and closes, says You for me, and keeps names as text', async () => {
  const rosters = { '2026-11-08': [{ time: '09:00', serviceTitle: 'Sunday service', teams: [
    { teamName: 'Band', positions: [
      { positionName: 'Drums', name: '<b>Ana</b>', status: 'accepted', mine: false },
      { positionName: 'Keys', name: null, status: 'open', mine: false },
    ] },
    { teamName: 'Tech', positions: [{ positionName: 'Sound', name: 'Sam Me', status: 'pending', mine: true }] },
  ] }] };
  const { root, api } = await setup(sched, { 'GET /api/me/schedule': { ...data([item()]), rosters } });
  // Closed at first: one named button, none of the roster.
  assert.match(root.innerHTML, /data-action="roster" data-id="1" aria-expanded="false"/);
  assert.match(root.innerHTML, /Full roster<span class="visually-hidden"> for Sun 8 Nov<\/span>/);
  assert.doesNotMatch(root.innerHTML, /data-roster=/);
  await root.click('roster', 1);
  assert.equal(api.calls.length, 1, 'opening the roster needs no request');
  const h = root.innerHTML;
  assert.match(h, /data-action="roster" data-id="1" aria-expanded="true"/);
  assert.match(h, /9:00 am<\/span> · Sunday service/);
  assert.match(h, /<h4 class="team-title">Band<\/h4>[\s\S]*<h4 class="team-title">Tech<\/h4>/);
  assert.match(h, /&lt;b&gt;Ana&lt;\/b&gt;/);
  assert.doesNotMatch(h, /<b>Ana/);
  assert.match(h, /roster-row is-mine">\s*<span class="roster-pos">Sound<\/span>\s*<span class="roster-who"><strong>You<\/strong>/);
  assert.doesNotMatch(h, /Sam Me/, 'my own row says You');
  for (const word of ['Confirmed', 'Open', 'Waiting for answer']) assert.match(h, new RegExp(`>${word}<`));
  // It stays open when the page repaints after an answer, and closes again.
  await root.click('accept', 1);
  assert.match(root.innerHTML, /data-roster="1"/);
  await root.click('roster', 1);
  assert.doesNotMatch(root.innerHTML, /data-roster=/);
  assert.match(root.innerHTML, /aria-expanded="false"/);
});

test('schedule: no roster button when there is no roster for that day', async () => {
  const { root } = await setup(sched, { 'GET /api/me/schedule': data([item()]) });
  assert.doesNotMatch(root.innerHTML, /data-action="roster"/);
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
  assert.deepEqual(api.calls, ['GET /api/me/availability', 'GET /api/me/blockouts']);

  await root.submit('blockout', { from: '2026-11-10', to: '2026-11-12', reason: 'Trip' });
  assert.equal(api.calls[2], 'POST /api/me/blockouts {"startDate":"2026-11-10","endDate":"2026-11-12","reason":"Trip"}');
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

test('how often: shows the default, then saves a choice with PUT', async () => {
  const { root, api } = await setup(off, {
    'GET /api/me/blockouts': { blockouts: [] },
    'GET /api/me/availability': { availability: { everyWeeks: 2, isDefault: true, updatedAt: null } },
    'PUT /api/me/availability': { availability: { everyWeeks: 4, isDefault: false, updatedAt: '2026-11-04T10:00:00.000Z' } },
  });
  assert.match(root.innerHTML, /How often can you serve\?/);
  assert.match(root.innerHTML, /<option value="2" selected>Every 2 weeks<\/option>/);
  assert.match(root.innerHTML, /You have not chosen yet/);
  await root.submit('availability', { everyWeeks: '4' });
  assert.equal(api.calls.at(-1), 'PUT /api/me/availability {"everyWeeks":4}');
  assert.match(root.innerHTML, /<option value="4" selected>Every 4 weeks<\/option>/);
  assert.match(root.innerHTML, /Saved\. Every 4 weeks at most\./);
  assert.doesNotMatch(root.innerHTML, /You have not chosen yet/);
  assert.equal(api.calls.filter((c) => c.startsWith('POST')).length, 0, 'saving how often never adds a day off');
});

test('how often: pause, and a failed save shows the server message', async () => {
  const ok = await setup(off, {
    'GET /api/me/blockouts': { blockouts: [] },
    'PUT /api/me/availability': { availability: { everyWeeks: 0, isDefault: false, updatedAt: 'x' } },
  });
  await ok.root.submit('availability', { everyWeeks: '0' });
  assert.match(ok.root.innerHTML, /Saved\. Flock will not ask you for now\./);
  const bad = await setup(off, { 'GET /api/me/blockouts': { blockouts: [] }, 'PUT /api/me/availability': new Error('How often must be one of 0, 1, 2, 3, 4, 6 or 8 weeks') });
  await bad.root.submit('availability', { everyWeeks: '5' });
  assert.match(bad.root.innerHTML, /How often must be one of/);
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

test('schedule: after Yes, I can the hero stays on that time until the page loads again', async () => {
  const items = [item(), item({ slotId: 2, date: '2026-11-15' })];
  const routes = { 'GET /api/me/schedule': data(items) };
  const { root } = await setup(sched, routes);
  assert.match(root.innerHTML, /class="hero hero-next" aria-label="Next time you serve" data-slot="1"/);
  routes['GET /api/me/schedule'] = data([item({ status: 'accepted' }), items[1]]);
  await root.click('accept', 1);
  assert.match(root.innerHTML, /hero-next is-celebrating" aria-label="Next time you serve" data-slot="1"/);
  await root.click('card', 2); // any tap repaints
  assert.match(root.innerHTML, /class="hero hero-next" aria-label="Next time you serve" data-slot="1"/, 'still the one just confirmed');
  assert.match(root.innerHTML, /Also needs your answer[\s\S]*data-slot="2"/);
});

test('schedule: the hero is never repeated below, even when nextServing is its own copy (as the API sends it)', async () => {
  const items = [item({ status: 'accepted' }), item({ slotId: 2, status: 'accepted', date: '2026-11-15' })];
  const { root } = await setup(sched, { 'GET /api/me/schedule': { nextServing: { ...items[0] }, items } });
  assert.equal((root.innerHTML.match(/data-slot="1"/g) || []).length, 1);
  assert.match(root.innerHTML, /Coming up[\s\S]*data-slot="2"/);
});
