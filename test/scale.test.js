// A big church: 1,000 people, 12 teams of 5 positions, 3 services on one
// Sunday plus weekly ones up to the 10-upcoming limit, blockouts and
// availability for many. Checks that the heavy reads give right answers and
// stay well under a second each (on a laptop they take a few milliseconds;
// the bound is loose so a slow CI machine does not fail it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeContainer } from './helpers/container.js';
import { addDays } from '../src/dates.js';
import { MAX_UPCOMING } from '../src/services/calendar-service.js';

const PEOPLE = 1000;
const LIMIT_MS = 1000;

async function timed(label, fn) {
  const start = performance.now();
  const out = await fn();
  const ms = performance.now() - start;
  assert.ok(ms < LIMIT_MS, `${label} took ${Math.round(ms)} ms`);
  return out;
}

test('scale: a church of 1,000 people', async () => {
  const c = makeContainer();
  const s = c.services;
  try {
    const { person: admin } = await s.people.create(null, { name: 'Ada Admin', email: 'admin@example.com', role: 'admin' });
    const actor = { id: admin.id, role: 'admin' };
    const ids = [];
    for (let i = 0; i < PEOPLE - 1; i++) ids.push((await s.people.create(actor, { name: `Person ${i}`, email: `p${i}@example.com` })).person.id);
    const positions = [];
    for (let t = 0; t < 12; t++) {
      const team = await s.teams.createTeam(actor, { name: `Team ${t}` });
      for (let p = 0; p < 5; p++) positions.push((await s.teams.createPosition(actor, team.id, { name: `Pos ${t}-${p}` })).id);
    }
    for (const [i, id] of ids.entries()) {
      await s.teams.setQualifications(actor, id, [...new Set([positions[i % 60], positions[(i * 7) % 60], positions[(i * 13) % 60]])]);
      if (i % 3 === 0) await s.blockouts.add(id, { startDate: addDays('2025-01-12', i % 20), endDate: addDays('2025-01-12', (i % 20) + 6), reason: 'Away' });
      if (i % 2 === 0) await s.availability.setMine(id, { everyWeeks: [1, 2, 4][i % 3] });
    }
    // Every position, at 3 services on the first Sunday, then weekly up to the limit.
    const slots = positions.map((positionId) => ({ positionId, count: 1 }));
    for (const time of ['08:00', '10:00', '12:00']) await s.calendar.createService(actor, { date: '2025-01-12', time, title: 'Sunday', slots });
    for (let w = 1; w <= MAX_UPCOMING - 3; w++) await s.calendar.createService(actor, { date: addDays('2025-01-12', 7 * w), title: 'Sunday', slots });

    const fill = await timed('Fill open positions', () => s.autofill.run(actor, { weekOf: '2025-01-12', weeks: 8, apply: true }));
    assert.ok(fill, 'Fill ran');
    const filled = (await s.calendar.listServices('2025-01-01', '2025-03-31')).flatMap((x) => x.slots).filter((x) => x.personId);
    assert.ok(filled.length > 300, `only ${filled.length} filled`);

    const someone = filled[0].personId;
    const mine = await timed('My schedule', () => s.assignments.mySchedule(someone));
    assert.ok(mine.items.length >= 1);
    await timed('Services list', () => s.calendar.listServices('2025-01-01', '2025-03-31'));
    const gaps = await timed('Gaps', () => s.gaps.gaps({ from: '2025-01-01', to: '2025-03-31' }));
    assert.ok(gaps);
    const open = (await s.calendar.listServices('2025-01-12', '2025-01-12'))[0].slots[0];
    const trained = await timed('Suggest (trained)', () => s.gaps.suggest({ slotId: open.id }));
    const everyone = await timed('Suggest (everyone)', () => s.gaps.suggest({ slotId: open.id, includeUnqualified: true }));
    assert.ok(JSON.stringify(everyone).length >= JSON.stringify(trained).length);
    const people = await timed('People list', () => s.people.list());
    assert.equal(people.length, PEOPLE);
    await timed('Blockouts list', () => s.blockouts.listRange('2025-01-01', '2025-03-31'));
    await timed('Reminders', () => s.gaps.reminders({ weekOf: '2025-01-12' }));
  } finally {
    c.close();
  }
});
