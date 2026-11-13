// Tab badges and the app-icon count (web/lib/counts.js, web/views/nav.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerCount, gapCount, badgeText, loadCounts, setAppBadge } from '../web/lib/counts.js';
import * as nav from '../web/views/nav.js';

const member = { id: 2, name: 'Mary', role: 'member' };
const admin = { id: 1, name: 'Ann', role: 'admin' };

test('counts: asks waiting for an answer, and gaps', () => {
  assert.equal(answerCount({ items: [{ status: 'pending' }, { status: 'confirmed' }, { status: 'pending' }, { status: 'declined' }] }), 2);
  assert.equal(answerCount({ items: [] }), 0);
  assert.equal(answerCount(null), 0);
  assert.equal(answerCount({ items: 'nope' }), 0);
  assert.equal(gapCount({ summary: {}, items: [{}, {}, {}] }), 3);
  assert.equal(gapCount(undefined), 0);
});

test('badge text: nothing at 0, the number up to 9, then 9+', () => {
  assert.deepEqual([0, -1, NaN, 1, 9, 10, 250].map(badgeText), ['', '', '', '1', '9', '9+', '9+']);
});

test('loadCounts: volunteers ask for their schedule only; a failed call counts as 0', async () => {
  const asked = [];
  const api = (replies) => ({ get: async (p) => { asked.push(p); if (replies[p] instanceof Error) throw replies[p]; return replies[p]; } });
  const replies = { '/api/me/schedule': { items: [{ status: 'pending' }] }, '/api/admin/gaps': { items: [{}, {}] } };
  assert.deepEqual(await loadCounts(api(replies), member), { answer: 1, gaps: 0 });
  assert.deepEqual(asked, ['/api/me/schedule']);
  assert.deepEqual(await loadCounts(api(replies), admin), { answer: 1, gaps: 2 });
  assert.deepEqual(await loadCounts(api({ '/api/me/schedule': new Error('offline'), '/api/admin/gaps': { items: [{}] } }), admin), { answer: 0, gaps: 1 });
  assert.deepEqual(await loadCounts(api(replies), null), { answer: 0, gaps: 0 });
});

test('setAppBadge: sets the number, clears at 0, and never throws', () => {
  const log = [];
  const win = { navigator: { setAppBadge: async (n) => log.push(`set ${n}`), clearAppBadge: async () => log.push('clear') } };
  setAppBadge(win, 3);
  setAppBadge(win, 0);
  assert.deepEqual(log, ['set 3', 'clear']);
  setAppBadge({ navigator: {} }, 2);
  setAppBadge(undefined, 2);
  setAppBadge({ navigator: { setAppBadge: () => { throw new Error('not installed'); } } }, 1);
  setAppBadge({ navigator: { setAppBadge: () => Promise.reject(new Error('denied')) } }, 1);
});

test('member: the My schedule tab carries what is left to answer, in words too', () => {
  const s = nav.render({ user: member, counts: { answer: 2, gaps: 5 } }, '#/blockouts');
  assert.match(s, /<a href="#\/" ?>.*<span class="nav-badge" aria-hidden="true">2<\/span><span class="visually-hidden">, 2 to answer<\/span><\/a>/);
  assert.equal((s.match(/nav-badge/g) || []).length, 1, 'volunteers have no gaps badge');
  assert.doesNotMatch(nav.render({ user: member, counts: { answer: 0, gaps: 0 } }, '#/'), /nav-badge|to answer/);
  assert.match(nav.render({ user: member, counts: { answer: 12, gaps: 0 } }, '#/'), /aria-hidden="true">9\+<\/span><span class="visually-hidden">, 12 to answer/);
});

test('admin on a phone: Gaps carries the gaps; More and its My schedule row carry what to answer', () => {
  const s = nav.render({ user: admin, counts: { answer: 1, gaps: 7 } }, '#/schedule');
  assert.match(s, /<a href="#\/gaps" ?>.*?<span class="nav-badge" aria-hidden="true">7<\/span><span class="visually-hidden">, 7 gaps<\/span><\/a>/);
  assert.match(s, /data-action="nav-more"[^>]*>.*?<span class="nav-badge" aria-hidden="true">1<\/span><span class="visually-hidden">, 1 to answer<\/span><\/button>/);
  const sub = s.slice(s.indexOf('id="nav-more-menu"'));
  assert.match(sub, /<a href="#\/" ?>.*?, 1 to answer<\/span><\/a>/);
  const none = nav.render({ user: admin, counts: { answer: 0, gaps: 0 } }, '#/schedule');
  assert.doesNotMatch(none, /nav-badge/);
});

test('More is a sheet: a grab handle and a "More" heading that names the list', () => {
  const s = nav.render({ user: admin }, '#/schedule');
  assert.match(s, /<li class="nav-item nav-sub-wrap"><div class="sheet-grab" aria-hidden="true"><\/div><h2 class="nav-sub-title" id="nav-more-title">More<\/h2><ul class="nav-sub" id="nav-more-menu" aria-labelledby="nav-more-title">/);
  assert.doesNotMatch(nav.render({ user: member }, '#/'), /nav-more-title/, 'volunteers have no More');
});
