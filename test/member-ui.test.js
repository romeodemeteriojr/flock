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
  assert.match(heroHtml, /class="btn btn-lg btn-hero-quiet" data-action="decline-ask" data-id="1"/);
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

test('schedule: saying no to an ask also needs a confirm step, in the hero and in a card', async () => {
  const { root, api } = await setup(sched, { 'GET /api/me/schedule': data([item(), item({ slotId: 4, date: '2026-11-22' })]) });
  for (const id of [1, 4]) {
    await root.click('decline-ask', id);
    assert.equal(api.calls.length, 1, 'one tap sends nothing');
    assert.match(root.innerHTML, /Are you sure you can(&#39;|')t serve on/);
    assert.match(root.innerHTML, /data-action="keep" data-id="\d+"[^>]*>No, go back</);
    assert.doesNotMatch(root.innerHTML, new RegExp(`data-action="accept" data-id="${id}"`), 'the confirm takes the buttons\' place');
    await root.click('keep', id);
    assert.doesNotMatch(root.innerHTML, /Are you sure/);
    assert.match(root.innerHTML, new RegExp(`data-action="accept" data-id="${id}"`), 'the ask is back');
  }
  await root.click('decline-ask', 4);
  await root.click('decline-sure', 4);
  assert.equal(api.calls[1], 'POST /api/me/slots/4/decline {}');
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

test('days off: nothing picked at first, validated, and posts', async () => {
  const { root, api } = await setup(off, { 'GET /api/me/blockouts': { blockouts: [] }, 'POST /api/me/blockouts': { blockout: {}, conflicts: [] } });
  assert.match(root.innerHTML, /<input type="hidden" name="from" value=""><input type="hidden" name="to" value="">/);
  assert.match(root.innerHTML, /class="cal-range num cal-range-empty" data-range aria-live="polite">Tap a day to start\.</);
  assert.match(root.innerHTML, /You have no days off saved/);

  await root.submit('blockout', { from: '', to: '', reason: '' });
  assert.match(root.innerHTML, /Please pick the first day you can&#39;t serve: tap it on the calendar\./);
  await root.submit('blockout', { from: '2026-11-10', to: '2026-11-09', reason: '' });
  assert.match(root.innerHTML, /be before the first day/);
  assert.deepEqual(api.calls.sort(), ['GET /api/me/availability', 'GET /api/me/blockouts', 'GET /api/me/schedule']);

  await root.submit('blockout', { from: '2026-11-10', to: '2026-11-12', reason: 'Trip' });
  assert.ok(api.calls.includes('POST /api/me/blockouts {"startDate":"2026-11-10","endDate":"2026-11-12","reason":"Trip"}'));
  assert.match(root.innerHTML, /Saved/);
  assert.doesNotMatch(root.innerHTML, /data-conflicts/);
});

test('days off calendar: tap a day, then a later one; the range is said in words and posted', async () => {
  const { root, api } = await setup(off, {
    'GET /api/me/blockouts': { blockouts: [{ id: 7, startDate: '2026-11-24', endDate: '2026-11-26', reason: '' }] },
    'GET /api/me/schedule': { items: [{ date: '2026-11-15', status: 'pending' }, { date: '2026-11-22', status: 'declined' }] },
    'POST /api/me/blockouts': { blockout: {}, conflicts: [] },
  });
  const h = root.innerHTML;
  assert.match(h, /<h2 class="cal-month" id="cal-month" aria-live="polite">November 2026<\/h2>/);
  assert.match(h, /data-action="month-prev" aria-label="Previous month" disabled/, 'no going back before this month');
  assert.match(h, /class="cal-day" data-action="day" data-date="2026-11-03" aria-pressed="false" aria-label="Tuesday 3 November" disabled>3</, 'past days cannot be picked');
  assert.match(h, /class="cal-day is-today" [^>]*aria-label="Wednesday 4 November, today"/);
  assert.match(h, /class="cal-day is-serving" [^>]*aria-label="Sunday 15 November, you are serving"/);
  assert.doesNotMatch(h, /data-date="2026-11-22"[^>]*you are serving/, 'a declined one is not shown');
  assert.match(h, /class="cal-day is-off is-off-start" [^>]*aria-label="Tuesday 24 November, already off"/);
  assert.match(h, /class="cal-day is-off is-off-end" [^>]*data-date="2026-11-26"/);
  assert.equal((h.match(/class="cal-blank"/g) || []).length, 6, 'November 2026 starts on a Sunday');

  const tap = (date) => root.fire('click', { dataset: { action: 'day', date } });
  await tap('2026-11-21');
  assert.match(root.innerHTML, /class="cal-day is-start is-end" [^>]*aria-pressed="true" aria-label="Saturday 21 November, picked"/);
  assert.match(root.innerHTML, /data-range aria-live="polite">Sat 21 Nov \(1 day\)</);
  await tap('2026-11-23');
  assert.match(root.innerHTML, /class="cal-day is-in" [^>]*data-date="2026-11-22"/);
  assert.match(root.innerHTML, /class="cal-day is-end" [^>]*data-date="2026-11-23"/);
  assert.match(root.innerHTML, /Sat 21 Nov to Mon 23 Nov \(3 days\)/);
  assert.match(root.innerHTML, /name="from" value="2026-11-21"><input type="hidden" name="to" value="2026-11-23">/);

  await root.click('month-next');
  assert.match(root.innerHTML, /December 2026/);
  await root.submit('blockout', { from: '2026-11-21', to: '2026-11-23', reason: '' });
  assert.ok(api.calls.includes('POST /api/me/blockouts {"startDate":"2026-11-21","endDate":"2026-11-23","reason":""}'));
  assert.match(root.innerHTML, /December 2026/, 'the month stays where it was');
  assert.match(root.innerHTML, /Tap a day to start\./, 'the picked days are cleared');
});

test('days off calendar: the tap rules, the words, and twelve months ahead at most', async () => {
  const p0 = { start: '', end: '' };
  const one = off.tapDay(p0, '2026-11-21');
  assert.deepEqual(one, { start: '2026-11-21', end: '2026-11-21' });
  assert.deepEqual(off.tapDay(one, '2026-11-25'), { start: '2026-11-21', end: '2026-11-25' });
  assert.deepEqual(off.tapDay(one, '2026-11-19'), { start: '2026-11-19', end: '2026-11-19' }, 'an earlier day starts again');
  assert.deepEqual(off.tapDay(one, '2026-11-21'), one, 'the same day stays one day');
  assert.deepEqual(off.tapDay({ start: '2026-11-21', end: '2026-11-25' }, '2026-11-30'), { start: '2026-11-30', end: '2026-11-30' }, 'a range starts again');
  assert.equal(off.rangeText(p0), '');
  assert.equal(off.rangeText({ start: '2026-11-21', end: '2026-11-22' }), 'Sat 21 Nov to Sun 22 Nov (2 days)');

  const { root } = await setup(off, { 'GET /api/me/blockouts': { blockouts: [] } });
  for (let i = 0; i < 14; i++) await root.click('month-next');
  assert.match(root.innerHTML, /November 2027/);
  assert.match(root.innerHTML, /data-action="month-next" aria-label="Next month" disabled/);
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
  assert.match(root.innerHTML, /You are already scheduled on Sun 8 Nov as Sound\./);
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
  const bad = await setup(off, { 'GET /api/me/blockouts': { blockouts: [] }, 'PUT /api/me/availability': new Error('How often must be one of 0, 1, 2, 3, 4, 6 or 8 weeks.') });
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

test('calendar date helpers: Monday-first months, month maths, inclusive day counts', async () => {
  const d = await import('../web/lib/dates.js');
  assert.deepEqual([d.monthGrid(2026, 11).blanks, d.monthGrid(2026, 11).days.length], [6, 30]);
  assert.deepEqual([d.monthGrid(2026, 6).blanks, d.monthGrid(2026, 6).days[0]], [0, '2026-06-01'], 'June 2026 starts on a Monday');
  assert.equal(d.monthGrid(2024, 2).days.length, 29);
  assert.equal(d.monthGrid(2025, 2).days.at(-1), '2025-02-28');
  assert.deepEqual(d.addMonths(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepEqual(d.addMonths(2026, 1, -1), { year: 2025, month: 12 });
  assert.deepEqual(d.addMonths(2026, 11, 12), { year: 2027, month: 11 });
  assert.equal(d.monthLabel(2026, 11), 'November 2026');
  assert.equal(d.daysBetween('2026-11-21', '2026-11-21'), 1);
  assert.equal(d.daysBetween('2026-12-30', '2027-01-02'), 4);
  assert.equal(d.shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(d.shiftDate('2024-03-01', -1), '2024-02-29');
  assert.equal(d.shiftDate('nope', 1), '');
  assert.equal(d.longDate('2026-11-21'), 'Saturday 21 November');
});

test('days off calendar: past days and months before this one cannot be picked, even if tapped', async () => {
  const { root } = await setup(off, { 'GET /api/me/blockouts': { blockouts: [] } });
  await root.click('month-prev');
  assert.match(root.innerHTML, /November 2026/);
  await root.fire('click', { dataset: { action: 'day', date: '2026-11-01' } });
  assert.match(root.innerHTML, /Tap a day to start\./);
  await root.fire('click', { dataset: { action: 'day', date: 'nope' } });
  assert.match(root.innerHTML, /Tap a day to start\./);
});

// ---------- several positions on one service (decision 0010) ----------

test('schedule: each position is its own card; alsoOn says the others, escaped', async () => {
  const items = [
    item({ slotId: 1, positionName: 'Sound', alsoOn: ['Vocals <b>'] }),
    item({ slotId: 2, positionName: 'Vocals <b>', teamName: 'Band', alsoOn: ['Sound'] }),
    item({ slotId: 3, date: '2026-11-15', positionName: 'Sound', alsoOn: [] }),
  ];
  const { root } = await setup(sched, { 'GET /api/me/schedule': data(items) });
  const h = root.innerHTML;
  assert.match(h, /<p class="hero-sub" data-also>Also on Vocals &lt;b&gt;<\/p>/);
  assert.match(h, /<p class="serve-meta" data-also>Also on Sound<\/p>/);
  assert.equal((h.match(/data-also/g) ?? []).length, 2, 'nothing for the card with no other position');
  assert.doesNotMatch(h, /<b>/);
  assert.equal(sched.alsoWords({ alsoOn: ['A', 'B'] }), 'Also on A and B');
  assert.equal(sched.alsoWords({ alsoOn: ['A', 'B', 'C'] }), 'Also on A, B and C');
  assert.equal(sched.alsoWords({}), '');
  assert.equal(sched.alsoWords({ alsoOn: [] }), '');
});

test('schedule: with other positions that day, saying no names the position, so the others plainly stay', async () => {
  const items = [item({ slotId: 1, status: 'accepted', positionName: 'Sound', alsoOn: ['Vocals'] })];
  const { root, api } = await setup(sched, { 'GET /api/me/schedule': data(items) });
  const text = (r) => r.innerHTML.replaceAll('&#39;', "'");
  assert.match(text(root), /I can't do Sound after all/);
  assert.doesNotMatch(text(root), /I can't make it after all/);
  await root.click('decline-ask', 1);
  assert.match(text(root), /Are you sure you can't do Sound on Sun 8 Nov\?/);
  assert.match(text(root), /Yes, I can't do Sound</);
  await root.click('decline-sure', 1);
  assert.equal(api.calls[1], 'POST /api/me/slots/1/decline {}');
  // One position only: the words stay as they were.
  const one = await setup(sched, { 'GET /api/me/schedule': data([item({ slotId: 1, status: 'accepted' })]) });
  await one.root.click('decline-ask', 1);
  assert.match(text(one.root), /Are you sure you can't serve on Sun 8 Nov\?/);
  assert.match(text(one.root), /Yes, I can't make it</);
});

test('schedule: taking back a no at the limit shows the server words', async () => {
  const items = [item({ slotId: 1, status: 'pending', alsoOn: ['A', 'B', 'C'] })];
  const err = Object.assign(new Error('You already have 3 positions at this service, the most one person can have'), { status: 409, code: 'too_many_positions' });
  const { root } = await setup(sched, { 'GET /api/me/schedule': data(items), 'POST /api/me/slots/1/accept': err });
  await root.click('accept', 1);
  assert.match(root.innerHTML, /You already have 3 positions at this service, the most one person can have/);
});

test('days off: clashes at one service are one line, "as Sound and Vocals"; other services stay apart', async () => {
  const c = (o) => ({ slotId: 1, date: '2026-11-08', time: '09:00', serviceTitle: 'Sunday service', positionName: 'Sound', teamName: 'Tech', status: 'pending', ...o });
  const conflicts = [
    c({ slotId: 1 }),
    c({ slotId: 2, positionName: 'Vocals', teamName: 'Band' }),
    c({ slotId: 3, time: '18:00', positionName: 'Keys' }),
    c({ slotId: 4, date: '2026-11-15', positionName: 'Sound' }),
  ];
  assert.deepEqual(off.groupConflicts(conflicts).map((g) => [g.date, g.time, g.positionName]), [
    ['2026-11-08', '09:00', 'Sound and Vocals'],
    ['2026-11-08', '18:00', 'Keys'],
    ['2026-11-15', '09:00', 'Sound'],
  ]);
  assert.deepEqual(off.groupConflicts([]), []);
  assert.equal(off.groupConflicts([c({}), c({ positionName: 'B' }), c({ positionName: 'C' })])[0].positionName, 'Sound, B and C');
  const { root } = await setup(off, {
    'GET /api/me/blockouts': { blockouts: [] },
    'POST /api/me/blockouts': { blockout: {}, conflicts },
  });
  await root.submit('blockout', { from: '2026-11-08', to: '2026-11-15', reason: '' });
  assert.match(root.innerHTML, /You are already scheduled on Sun 8 Nov as Sound and Vocals\./);
  assert.match(root.innerHTML, /You are already scheduled on Sun 8 Nov as Keys\./);
  assert.equal((root.innerHTML.match(/You are already scheduled/g) ?? []).length, 3);
});

test('days off: a clash with a day you serve offers "I can\'t serve then", asked twice', async () => {
  const conflicts = [
    { slotId: 1, date: '2026-11-08', time: '09:00', serviceTitle: 'Sunday service', positionName: 'Sound', teamName: 'Tech', status: 'accepted' },
    { slotId: 2, date: '2026-11-08', time: '09:00', serviceTitle: 'Sunday service', positionName: 'Vocals', teamName: 'Band', status: 'pending' },
  ];
  const { root, api } = await setup(off, {
    'GET /api/me/blockouts': { blockouts: [] },
    'POST /api/me/blockouts': { blockout: {}, conflicts },
    'POST /api/me/slots/1/decline': {},
    'POST /api/me/slots/2/decline': {},
  });
  await root.submit('blockout', { from: '2026-11-08', to: '2026-11-08', reason: '' });
  assert.match(root.innerHTML, /data-action="cant-ask" data-ids="1,2"/, 'one button for the service');
  await root.fire('click', { dataset: { action: 'cant-ask', ids: '1,2' } });
  assert.match(root.innerHTML, /Tell your scheduler you can(&#39;|')t serve on Sun 8 Nov\?/);
  assert.ok(!api.calls.some((c) => c.includes('/decline')), 'nothing sent on the first tap');
  await root.fire('click', { dataset: { action: 'cant-no' } });
  assert.doesNotMatch(root.innerHTML, /data-action="cant-sure"/);
  await root.fire('click', { dataset: { action: 'cant-ask', ids: '1,2' } });
  await root.fire('click', { dataset: { action: 'cant-sure', ids: '1,2' } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(api.calls.filter((c) => c.includes('/decline')), ['POST /api/me/slots/1/decline {}', 'POST /api/me/slots/2/decline {}']);
  assert.match(root.innerHTML, /Your scheduler will find someone else\./);
  assert.doesNotMatch(root.innerHTML, /data-conflicts/, 'the clash is gone');
});
