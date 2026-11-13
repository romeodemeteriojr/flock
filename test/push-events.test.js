// What sends a notification, and what it says (decision 0008), through the real
// routes with a fake push sender. Made-up people only; nothing touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/app.js';
import { addPerson } from './helpers/seed.js';
import { createClient } from './helpers/client.js';
import { loadConfig } from '../src/config.js';
import { fixedClock } from '../src/infra/clock.js';
import { fakePush, subscription } from './helpers/push.js';

const NOW = '2026-11-12T09:00:00.000Z'; // a Thursday

async function church({ push = fakePush() } = {}) {
  const clock = fixedClock(new Date(NOW));
  const t = await startTestApp({ config: loadConfig({ FLOCK_PUBLIC_URL: 'https://flock.example.org' }), container: { clock, push } });
  const { data, services } = t.container;
  const ids = {
    ada: await addPerson(t, { name: 'Ada Admin', email: 'ada@example.com', role: 'admin' }),
    bea: await addPerson(t, { name: 'Bea Boss', email: 'bea@example.com', role: 'admin' }),
    sam: await addPerson(t, { name: 'Sam Smith', email: 'sam@example.com' }),
    kim: await addPerson(t, { name: 'Kim Kay', email: 'kim@example.com' }),
    old: await addPerson(t, { name: 'Ola Old', email: 'ola@example.com', role: 'admin' }),
  };
  const tech = await data.teams.create({ name: 'Tech' });
  const sound = await data.positions.create(tech.id, { name: 'Sound' });
  const slides = await data.positions.create(tech.id, { name: 'Slides' });
  for (const id of [ids.sam, ids.kim]) await data.qualifications.setForPerson(id, [sound.id, slides.id]);
  const svc = async (date, time = '09:00', title = 'Morning service') => {
    const s = await data.services.create({ date, time, title });
    return { ...s, slots: await data.slots.createMany(s.id, [sound.id, slides.id]) };
  };
  const s15 = await svc('2026-11-15');
  const s22 = await svc('2026-11-22', '10:30');
  const s29 = await svc('2026-11-29');
  const s06 = await svc('2026-12-06');
  const client = createClient(t);
  const as = async (email) => { const b = client.browser(); await b.login(email, 'test-pass-1'); return b; };
  const browsers = { ada: await as('ada@example.com'), bea: await as('bea@example.com'), sam: await as('sam@example.com'), kim: await as('kim@example.com'), old: await as('ola@example.com') };
  // Everyone turns notifications on, on one device each.
  const devices = {};
  for (const [name, b] of Object.entries(browsers)) {
    devices[name] = subscription(name);
    assert.equal((await b.post('/api/me/push/on', devices[name])).status, 200);
  }
  // A former scheduler, deactivated the normal way: never notified.
  assert.equal((await browsers.ada.patch(`/api/people/${ids.old}`, { active: false })).status, 200);
  const settle = () => services.notifications.idle();
  // What each person received since the last call: { name: [body, ...] }.
  const inbox = async () => {
    await settle();
    const out = {};
    for (const { endpoint, message } of push.sent.splice(0)) {
      const who = Object.keys(devices).find((n) => devices[n].endpoint === endpoint);
      (out[who] ??= []).push(message.notification.body);
    }
    return out;
  };
  return { t, push, ids, s15, s22, s29, s06, sound, browsers, devices, inbox, settle };
}

test('asked: the volunteer hears, with every unanswered ask; the scheduler who did it does not', async () => {
  const c = await church();
  try {
    const { ada } = c.browsers;
    assert.equal((await ada.put(`/api/slots/${c.s15.slots[0].id}/assign`, { personId: c.ids.sam })).status, 200);
    assert.deepEqual(await c.inbox(), { sam: ['Asked to serve: Sound, Sun 15 Nov 9:00. Tap to answer.'] });
    const sent = c.push.sent; // already emptied by inbox(); check one message in full
    await ada.put(`/api/slots/${c.s22.slots[1].id}/assign`, { personId: c.ids.sam });
    await c.settle();
    const { message, opts } = sent[0];
    assert.deepEqual(message, { web_push: 8030, notification: {
      title: 'Flock', body: 'Asked to serve: Sound, Sun 15 Nov 9:00; Slides, Sun 22 Nov 10:30. Tap to answer.',
      lang: 'en-GB', dir: 'ltr', navigate: 'https://flock.example.org/#/', tag: 'asked' } });
    assert.equal(opts.topic, 'asked');
    assert.equal(opts.ttl, (Date.parse('2026-11-22T10:30:00') - Date.parse(NOW)) / 1000, 'until the last service asked about');
    // Four or more: the first three by name, then how many more.
    await ada.put(`/api/slots/${c.s29.slots[0].id}/assign`, { personId: c.ids.sam });
    await ada.put(`/api/slots/${c.s06.slots[0].id}/assign`, { personId: c.ids.sam });
    const last = (await c.inbox()).sam.at(-1);
    assert.equal(last, 'Asked to serve: Sound, Sun 15 Nov 9:00; Slides, Sun 22 Nov 10:30; Sound, Sun 29 Nov 9:00 and 1 more. Tap to answer.');
    // Answered asks are no longer listed; accepting sends nothing to anyone.
    await c.browsers.sam.post(`/api/me/slots/${c.s15.slots[0].id}/accept`);
    assert.deepEqual(await c.inbox(), {});
    await ada.put(`/api/slots/${c.s15.slots[1].id}/assign`, { personId: c.ids.kim });
    await ada.put(`/api/slots/${c.s22.slots[0].id}/assign`, { personId: c.ids.ada }); // herself: quiet
    assert.deepEqual(await c.inbox(), { kim: ['Asked to serve: Slides, Sun 15 Nov 9:00. Tap to answer.'] });
  } finally { await c.t.close(); }
});

test('taken off, replaced, or the position removed: the volunteer hears', async () => {
  const c = await church();
  try {
    const { ada } = c.browsers;
    const [sound15, slides15] = c.s15.slots;
    await ada.put(`/api/slots/${sound15.id}/assign`, { personId: c.ids.sam });
    await c.inbox();
    await ada.del(`/api/slots/${sound15.id}/assign`);
    assert.deepEqual(await c.inbox(), { sam: ["You're no longer on Sound, Sun 15 Nov 9:00."] });

    await ada.put(`/api/slots/${sound15.id}/assign`, { personId: c.ids.sam });
    await ada.put(`/api/slots/${sound15.id}/assign`, { personId: c.ids.kim });
    const got = await c.inbox();
    assert.deepEqual(got.sam, ['Asked to serve: Sound, Sun 15 Nov 9:00. Tap to answer.', "You're no longer on Sound, Sun 15 Nov 9:00."]);
    assert.deepEqual(got.kim, ['Asked to serve: Sound, Sun 15 Nov 9:00. Tap to answer.']);

    // Someone who said no is not told they were replaced.
    await ada.put(`/api/slots/${slides15.id}/assign`, { personId: c.ids.sam });
    await c.browsers.sam.post(`/api/me/slots/${slides15.id}/decline`);
    await c.inbox();
    await ada.del(`/api/slots/${slides15.id}/assign`);
    assert.deepEqual(await c.inbox(), {});

    assert.equal((await ada.del(`/api/slots/${sound15.id}?confirm=1`)).status, 200);
    assert.deepEqual(await c.inbox(), { kim: ["You're no longer on Sound, Sun 15 Nov 9:00."] });
  } finally { await c.t.close(); }
});

test('a service moves or is cancelled: everyone on it hears; a title change is quiet', async () => {
  const c = await church();
  try {
    const { ada } = c.browsers;
    await ada.put(`/api/slots/${c.s15.slots[0].id}/assign`, { personId: c.ids.sam });
    await ada.put(`/api/slots/${c.s15.slots[1].id}/assign`, { personId: c.ids.kim });
    await c.browsers.kim.post(`/api/me/slots/${c.s15.slots[1].id}/accept`);
    await c.inbox();
    assert.equal((await ada.patch(`/api/services/${c.s15.id}`, { title: 'Family service' })).status, 200);
    assert.deepEqual(await c.inbox(), {});
    await ada.patch(`/api/services/${c.s15.id}`, { time: '10:30' });
    assert.deepEqual(await c.inbox(), {
      sam: ["Family service moved to Sun 15 Nov 10:30. You're still on Sound."],
      kim: ["Family service moved to Sun 15 Nov 10:30. You're still on Slides."],
    });
    await ada.patch(`/api/services/${c.s15.id}`, { date: '2026-11-16' });
    assert.equal((await c.inbox()).sam[0], "Family service moved to Mon 16 Nov 10:30. You're still on Sound.");
    assert.equal((await ada.del(`/api/services/${c.s15.id}?confirm=1`)).status, 200);
    assert.deepEqual(await c.inbox(), {
      sam: ['Family service on Mon 16 Nov 10:30 is cancelled. You were on Sound.'],
      kim: ['Family service on Mon 16 Nov 10:30 is cancelled. You were on Slides.'],
    });
    assert.equal(c.push.sent.length, 0);
  } finally { await c.t.close(); }
});

test('someone says no: every active scheduler hears, once, and Gaps opens on tap', async () => {
  const c = await church();
  try {
    const slot = c.s22.slots[0];
    await c.browsers.ada.put(`/api/slots/${slot.id}/assign`, { personId: c.ids.sam });
    await c.inbox();
    await c.browsers.sam.post(`/api/me/slots/${slot.id}/decline`);
    await c.settle();
    const sent = [...c.push.sent];
    assert.deepEqual(await c.inbox(), { ada: ["Sam can't do Sound, Sun 22 Nov 10:30."], bea: ["Sam can't do Sound, Sun 22 Nov 10:30."] });
    assert.equal(sent[0].message.notification.navigate, 'https://flock.example.org/#/gaps');
    assert.equal(sent[0].opts.ttl, 86400);
    // No again changes nothing; yes after no sends nothing; no after yes tells them again.
    await c.browsers.sam.post(`/api/me/slots/${slot.id}/decline`);
    await c.browsers.sam.post(`/api/me/slots/${slot.id}/accept`);
    assert.deepEqual(await c.inbox(), {});
    await c.browsers.sam.post(`/api/me/slots/${slot.id}/decline`);
    assert.deepEqual(Object.keys(await c.inbox()).sort(), ['ada', 'bea']);
    // A scheduler who says no themselves is not told about it.
    await c.browsers.ada.put(`/api/slots/${c.s29.slots[0].id}/assign`, { personId: c.ids.bea, force: true });
    await c.inbox();
    await c.browsers.bea.post(`/api/me/slots/${c.s29.slots[0].id}/decline`);
    assert.deepEqual(await c.inbox(), { ada: ["Bea can't do Sound, Sun 29 Nov 9:00."] });
  } finally { await c.t.close(); }
});

test('Ask these people: one notification per person for the whole batch', async () => {
  const c = await church();
  try {
    const r = await c.browsers.ada.post('/api/admin/autofill', { weekOf: '2026-11-15', weeks: 3, apply: true });
    assert.equal(r.status, 200, r.text);
    const asked = new Set(r.json.assigned.map((a) => a.personId));
    assert.ok(r.json.assigned.length > asked.size, 'someone got more than one slot');
    const got = await c.inbox();
    for (const id of asked) {
      const name = Object.keys(c.ids).find((n) => c.ids[n] === id);
      assert.equal(got[name]?.length, 1, `${name} gets one notification`);
      assert.match(got[name][0], /^Asked to serve: .*Tap to answer\.$/);
    }
    assert.equal(Object.keys(got).length, asked.size);
    // Planning without asking sends nothing.
    await c.browsers.ada.post('/api/admin/autofill', { weekOf: '2026-12-06', weeks: 1, apply: false });
    assert.deepEqual(await c.inbox(), {});
  } finally { await c.t.close(); }
});

test('best effort: a failing push service never fails or slows the click, and gone devices are forgotten', async () => {
  const c = await church();
  try {
    c.push.status.set(c.devices.sam.endpoint, 410);
    const send = c.push.send;
    let release;
    const gate = new Promise((r) => { release = r; });
    c.push.send = async (...args) => { await gate; return send(...args); }; // a very slow push service
    const r = await c.browsers.ada.put(`/api/slots/${c.s15.slots[0].id}/assign`, { personId: c.ids.sam });
    assert.equal(r.status, 200, 'answered before the push service did');
    release();
    await c.settle();
    assert.equal((await c.t.data.pushDevices.listForPerson(c.ids.sam)).length, 0, '410: forgotten');
    // A push service that throws is logged, not fatal.
    c.push.send = async () => { throw new Error('boom'); };
    assert.equal((await c.browsers.ada.put(`/api/slots/${c.s15.slots[1].id}/assign`, { personId: c.ids.kim })).status, 200);
    await c.settle();
  } finally { await c.t.close(); }
});

test('push off: changes work exactly as before and nothing is sent', async () => {
  const c = await church({ push: Object.assign(fakePush(), { enabled: true }) });
  try {
    c.t.container.push.enabled = false; // the church removed its keys
    await c.browsers.ada.put(`/api/slots/${c.s15.slots[0].id}/assign`, { personId: c.ids.sam });
    await c.browsers.sam.post(`/api/me/slots/${c.s15.slots[0].id}/decline`);
    await c.browsers.ada.del(`/api/services/${c.s15.id}?confirm=1`);
    assert.deepEqual(await c.inbox(), {});
  } finally { await c.t.close(); }
});

test('Send reminders: sent to those with notifications on, the rest to copy; failures fall back to Copy', async () => {
  const c = await church();
  try {
    const { ada } = c.browsers;
    await ada.put(`/api/slots/${c.s15.slots[0].id}/assign`, { personId: c.ids.sam });
    await ada.put(`/api/slots/${c.s15.slots[1].id}/assign`, { personId: c.ids.kim });
    const [extra1, extra2] = await c.t.data.slots.createMany(c.s15.id, [c.sound.id, c.sound.id]);
    await ada.put(`/api/slots/${extra1.id}/assign`, { personId: c.ids.ada, force: true }); // the sender herself
    const lee = await addPerson(c.t, { name: 'Lee Nophone', email: 'lee@example.com' });
    await c.t.data.qualifications.setForPerson(lee, [c.sound.id]);
    await ada.put(`/api/slots/${extra2.id}/assign`, { personId: lee });
    await c.inbox();

    const drafts = await ada.get('/api/admin/reminders?weekOf=2026-11-15');
    assert.equal(drafts.json.push, true);
    assert.deepEqual(drafts.json.reminders.map((r) => [r.name, r.hasPush]),
      [['Ada Admin', true], ['Kim Kay', true], ['Lee Nophone', false], ['Sam Smith', true]]);

    c.push.status.set(c.devices.kim.endpoint, 500); // Kim's push service is down
    const r = await ada.post('/api/admin/reminders/send', { weekOf: '2026-11-15' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { weekOf: '2026-11-15', sent: [c.ids.sam], copy: [c.ids.ada, c.ids.kim, lee] });
    const got = await c.inbox();
    assert.deepEqual(Object.keys(got).sort(), ['kim', 'sam'], 'Kim was tried; Ada (the sender) and Lee were not');
    assert.equal(got.sam[0], drafts.json.reminders.find((x) => x.name === 'Sam Smith').message);
    assert.equal((await c.t.data.audit.list(1))[0].detail, 'week of 2026-11-15: sent 1, 3 to copy');

    assert.equal((await c.browsers.sam.post('/api/admin/reminders/send', {})).status, 403, 'schedulers only');
    assert.equal((await ada.post('/api/admin/reminders/send', { weekOf: 'soon' })).status, 400);
    c.t.container.push.enabled = false;
    const off = await ada.post('/api/admin/reminders/send', { weekOf: '2026-11-15' });
    assert.equal(off.json.code, 'push_off');
    assert.equal((await ada.get('/api/admin/reminders?weekOf=2026-11-15')).json.push, false);
  } finally { await c.t.close(); }
});

test('People shows who has notifications on', async () => {
  const c = await church();
  try {
    const people = (await c.browsers.ada.get('/api/people')).json;
    const on = Object.fromEntries(people.map((p) => [p.name, p.notifications]));
    assert.deepEqual(on, { 'Ada Admin': true, 'Bea Boss': true, 'Kim Kay': true, 'Ola Old': false, 'Sam Smith': true });
    await c.browsers.kim.post('/api/me/push/off', { endpoint: c.devices.kim.endpoint });
    assert.equal((await c.browsers.ada.get('/api/people')).json.find((p) => p.name === 'Kim Kay').notifications, false);
  } finally { await c.t.close(); }
});

test('asked: positions at the same service share one part; "more" still counts asks', async () => {
  const c = await church();
  try {
    const { ada } = c.browsers;
    // Sam: two positions on 15 Nov (same service), then one on 22 Nov.
    assert.equal((await ada.put(`/api/slots/${c.s15.slots[0].id}/assign`, { personId: c.ids.sam })).status, 200);
    assert.equal((await ada.put(`/api/slots/${c.s15.slots[1].id}/assign`, { personId: c.ids.sam })).status, 200);
    await ada.put(`/api/slots/${c.s22.slots[1].id}/assign`, { personId: c.ids.sam });
    const got = (await c.inbox()).sam;
    assert.equal(got.at(-1), `Asked to serve: ${c.s15.slots[0].positionName} and ${c.s15.slots[1].positionName}, Sun 15 Nov 9:00; Slides, Sun 22 Nov 10:30. Tap to answer.`);
  } finally { await c.t.close(); }
});
