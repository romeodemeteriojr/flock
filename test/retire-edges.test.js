// Edge cases of deleting (retiring) positions, through the whole container.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeContainer } from './helpers/container.js';
import { addPerson } from './helpers/seed.js';
import { fixedClock } from '../src/infra/clock.js';

const code = async (p) => {
  try { await p; return 'ok'; } catch (e) { return e.code ?? e.name; }
};
const why = async (p) => {
  try { await p; return 'ok'; } catch (e) { return `${e.code}: ${e.message}`; }
};

// Sunday 2025-01-05 at noon; Keys (to be deleted) and Bass (kept) in Band.
async function church() {
  const c = makeContainer({ clock: fixedClock('2025-01-05T12:00:00Z') });
  const adminId = await addPerson(c, { name: 'Ada Admin', email: 'ada@example.com', role: 'admin' });
  const memberId = await addPerson(c, { name: 'Max Member', email: 'max@example.com' });
  const actor = { id: adminId, role: 'admin' };
  const s = c.services;
  const team = await s.teams.createTeam(actor, { name: 'Band' });
  const keys = await s.teams.createPosition(actor, team.id, { name: 'Keys' });
  const bass = await s.teams.createPosition(actor, team.id, { name: 'Bass' });
  await s.teams.setQualifications(actor, memberId, [keys.id, bass.id]);
  return { c, s, actor, adminId, memberId, team, keys, bass };
}

test('retire: a deleted position is gone from every list and picker', async () => {
  const { c, s, actor, memberId, team, keys, bass } = await church();
  try {
    await s.calendar.createService(actor, { date: '2025-01-12', slots: [{ positionId: bass.id }, { positionId: keys.id }] });
    await s.teams.deletePosition(actor, keys.id);
    const names = (teams) => teams.flatMap((t) => t.positions.map((p) => p.name));
    assert.deepEqual(names(await s.teams.list(actor)), ['Bass'], 'Teams page and every position picker');
    assert.deepEqual(names(await s.teams.list({ id: memberId, role: 'member' })), ['Bass'], 'what a volunteer sees');
    assert.deepEqual((await s.teams.myPositions(memberId)).map((p) => p.name ?? p.positionName), ['Bass'], 'my positions');
    assert.equal(await code(s.teams.listPeopleForPosition(keys.id)), 'not_found');
    const svc = (await s.calendar.listServices()).find((x) => x.date === '2025-01-12');
    assert.deepEqual(svc.slots.map((x) => x.positionName), ['Bass'], 'schedule and gaps');
    assert.equal(team.id, (await s.teams.list(actor))[0].id);
  } finally { c.close(); }
});

test('retire: an out-of-date screen sending a deleted position is refused everywhere', async () => {
  const { c, s, actor, memberId, keys, bass } = await church();
  try {
    const svc = await s.calendar.createService(actor, { date: '2025-01-12', slots: [{ positionId: bass.id }] });
    await s.teams.deletePosition(actor, keys.id);
    const refused = (r) => /^validation_error: .*positions? do(es)? not exist$/.test(r) || /^not_found/.test(r);
    const tries = {
      'add a service': s.calendar.createService(actor, { date: '2025-01-19', slots: [{ positionId: keys.id }] }),
      'edit a service': s.calendar.updateService(actor, svc.id, { slots: [{ positionId: keys.id, count: 1 }] }),
      'add spots': s.calendar.addSlots(actor, svc.id, { positionId: keys.id, count: 1 }),
      'save positions': s.teams.setQualifications(actor, memberId, [bass.id, keys.id]),
      'rename it': s.teams.updatePosition(actor, keys.id, { name: 'Piano' }),
      'delete it again': s.teams.deletePosition(actor, keys.id),
    };
    for (const [what, p] of Object.entries(tries)) {
      const r = await why(p);
      assert.ok(refused(r), `${what}: ${r}`);
    }
    assert.deepEqual((await s.calendar.getService(svc.id)).slots.map((x) => x.positionName), ['Bass'], 'nothing added');
  } finally { c.close(); }
});

test('retire: Fill open positions never plans a deleted position', async () => {
  const { c, s, actor, keys, bass } = await church();
  try {
    await s.calendar.createService(actor, { date: '2025-01-12', slots: [{ positionId: keys.id }, { positionId: bass.id }] });
    await s.teams.deletePosition(actor, keys.id);
    const plan = JSON.stringify(await s.autofill.run(actor, { weekOf: '2025-01-06', weeks: 2 }));
    assert.doesNotMatch(plan, /Keys/);
    assert.match(plan, /Bass/);
  } finally { c.close(); }
});

test('retire: a volunteer answering a spot that was taken away gets a plain not found', async () => {
  const { c, s, actor, memberId, keys } = await church();
  try {
    const svc = await s.calendar.createService(actor, { date: '2025-01-12', slots: [{ positionId: keys.id }] });
    await s.assignments.assign(actor, svc.slots[0].id, { personId: memberId });
    await s.teams.deletePosition(actor, keys.id, { confirm: true });
    // An old notification still points at the slot.
    assert.equal(await code(s.assignments.respond(memberId, svc.slots[0].id, 'accept')), 'not_found');
    assert.deepEqual((await s.assignments.mySchedule(memberId)).items, []);
  } finally { c.close(); }
});

test('retire: someone accepts while the edit form is open; the save sees it', async () => {
  const { c, s, actor, memberId, keys } = await church();
  try {
    const svc = await s.calendar.createService(actor, { date: '2025-01-12', slots: [{ positionId: keys.id, count: 2 }] });
    // The scheduler opens Edit while both spots are open and plans to drop Keys...
    await s.assignments.assign(actor, svc.slots[0].id, { personId: memberId });
    await s.assignments.respond(memberId, svc.slots[0].id, 'accept');
    // ...lowering to 1 still works (an empty spot goes), dropping Keys now names Max.
    await s.calendar.updateService(actor, svc.id, { slots: [{ positionId: keys.id, count: 1 }] });
    assert.deepEqual((await s.calendar.getService(svc.id)).slots.map((x) => x.personId), [memberId]);
    await assert.rejects(s.calendar.updateService(actor, svc.id, { slots: [] }),
      (e) => e.code === 'has_people' && e.details.people[0].name === 'Max Member');
    assert.equal((await s.calendar.getService(svc.id)).slots.length, 1, 'nothing changed');
  } finally { c.close(); }
});
