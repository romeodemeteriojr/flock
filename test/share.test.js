// The phone's share sheet for invites and reminders (web/lib/share.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { canShare, share } from '../web/lib/share.js';
import * as people from '../web/views/admin-people.js';
import * as gaps from '../web/views/admin-gaps.js';
import { fakeRoot, fakeApi } from './helpers/fakeui.js';
import { inviteMessage } from '../web/lib/invite.js';

const flush = () => new Promise((r) => setImmediate(r));
const abort = () => Object.assign(new Error('closed'), { name: 'AbortError' });

test('share: true when shared, false when the person closes the sheet, throws otherwise', async () => {
  assert.equal(canShare({ navigator: { share: async () => {} } }), true);
  assert.equal(canShare({ navigator: {} }), false);
  assert.equal(canShare(undefined), false);
  const got = [];
  assert.equal(await share({ navigator: { share: async (d) => { got.push(d); } } }, { title: 'T', text: 'hello' }), true);
  assert.deepEqual(got, [{ title: 'T', text: 'hello' }]);
  assert.equal(await share({ navigator: { share: async () => { throw abort(); } } }, { text: 'x' }), false);
  await assert.rejects(share({ navigator: { share: async () => { throw new Error('NotAllowedError'); } } }, { text: 'x' }), /NotAllowed/);
});

const P = (id, name, email, extra = {}) => ({ id, name, email, role: 'member', active: true, joined: true, positionIds: [], ...extra });
const INVITE = { link: 'https://flock.example.org/#/welcome?token=' + 'i'.repeat(43), localOnly: false };

async function invited(win) {
  const api = fakeApi({
    'GET /api/people': [P(1, 'Ann Admin', 'ann@example.com', { role: 'admin' }), P(2, 'Sam Ortiz', 'sam.ortiz@example.com')],
    'GET /api/teams': [],
    'POST /api/people/2/reset-login': { person: P(2, 'Sam Ortiz', 'sam.ortiz@example.com', { joined: false }), invite: INVITE },
  });
  const root = fakeRoot();
  const s = people.createScreen({ api, root, win });
  await s.ready;
  root.click('reset-ask', 2); root.click('reset-yes', 2); await flush();
  return root;
}

test('invite box: Share comes first where the phone has a share sheet, and shares exactly what Copy copies', async () => {
  const shared = [];
  const root = await invited({ navigator: { share: async (d) => { shared.push(d); } } });
  const box = root.innerHTML.slice(root.innerHTML.indexOf('id="invite-box"'));
  assert.ok(box.indexOf('data-action="share"') < box.indexOf('data-action="copy"'), 'Share before Copy');
  assert.match(box, /class="btn btn-primary" data-action="share"/);
  assert.match(box, /class="btn" data-action="copy"/, 'Copy is no longer the main button');
  root.click('share'); await flush();
  const message = inviteMessage({ name: 'Sam Ortiz', email: 'sam.ortiz@example.com', ...INVITE });
  assert.deepEqual(shared, [{ title: 'Invite for Sam Ortiz', text: message }]);
  assert.doesNotMatch(root.innerHTML, /Copied|Could not/, 'nothing to say after sharing');

  const without = await invited({ navigator: {} });
  assert.doesNotMatch(without.innerHTML, /data-action="share"/);
  assert.match(without.innerHTML, /class="btn btn-primary" data-action="copy"/, 'Copy stays the main button');
});

test('invite box: closing the share sheet says nothing; a failing share sheet copies instead', async () => {
  const closed = await invited({ navigator: { share: async () => { throw abort(); }, clipboard: { writeText: async () => { throw new Error('should not copy'); } } } });
  closed.click('share'); await flush();
  assert.doesNotMatch(closed.innerHTML, /Copied|Could not/);

  const written = [];
  const failing = await invited({
    navigator: { share: async () => { throw new Error('NotAllowedError'); }, clipboard: { writeText: async (t) => { written.push(t); } } },
    setTimeout: () => 1, clearTimeout() {},
  });
  failing.click('share'); await flush(); await flush();
  assert.equal(written.length, 1);
  assert.match(failing.innerHTML, /Copied/);
});

test('reminders: Share all and Share on each, only where the phone can share', async () => {
  const list = [
    { personId: 5, name: 'Bo', message: 'Hi Bo, you are on Sound on Sunday.', hasPush: false },
    { personId: 6, name: 'Cy', message: 'Hi Cy, you are on Door on Sunday.', hasPush: false },
  ];
  const m = { loading: false, error: '', notice: '', summary: {}, items: [], canShare: true,
    reminders: { weekOf: '2026-11-15', list, loading: false, error: '', notice: '', push: false, sent: new Set(), sending: false } };
  const s = gaps.renderScreen(m);
  assert.match(s, /class="btn btn-primary" data-action="share-all"/);
  assert.match(s, /class="btn" data-action="copy-all"/);
  assert.match(s, /data-action="share-one" data-id="5" aria-label="Share the reminder for Bo"/);
  const plain = gaps.renderScreen({ ...m, canShare: false });
  assert.doesNotMatch(plain, /share-all|share-one/);
  assert.match(plain, /class="btn btn-primary" data-action="copy-all"/);
  // With Send reminders on offer, that stays the main button.
  const pushy = gaps.renderScreen({ ...m, reminders: { ...m.reminders, push: true, list: list.map((x) => ({ ...x, hasPush: true })) } });
  assert.match(pushy, /class="btn btn-primary" data-action="send-reminders"/);
  assert.match(pushy, /class="btn" data-action="share-all"/);
});
