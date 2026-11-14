// A big church: 1,000 people, 12 teams of 5 positions, 3 services on one
// Sunday plus weekly ones up to the 10-upcoming limit, blockouts and
// availability for many, and a typical set of files on every service
// (about 7 MB each: setlist, chord charts, run sheet, stage photo, slides). Checks that the heavy reads give right answers and
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
  let now = new Date('2025-01-05T12:00:00');
  const c = makeContainer({ clock: { now: () => now } });
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

    // Typical files on every service, plus two links.
    const FILES = [['setlist.pdf', 300], ['chords-1.pdf', 150], ['chords-2.pdf', 150], ['chords-3.pdf', 150],
      ['chords-4.pdf', 150], ['run-sheet.pdf', 80], ['stage.jpg', 2500], ['slides.pdf', 4000]];
    const services = await s.calendar.listServices('2025-01-01', '2025-03-31');
    assert.equal(services.length, MAX_UPCOMING);
    let bytes = 0;
    for (const sv of services) {
      for (const [name, kb] of FILES) {
        await s.attachments.addFile(actor, sv.id, { name, mime: 'application/pdf', bytes: Buffer.alloc(kb * 1024, 1) });
        bytes += kb * 1024;
      }
      for (const n of [1, 2]) await s.attachments.addLink(actor, sv.id, { url: `https://drive.example.com/${n}` });
    }

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
    assert.equal(mine.items[0].files, 10);
    const list = await timed('A service\'s files', () => s.attachments.list(actor, services[0].id));
    assert.equal(list.files.length, 10);
    const slides = list.files.find((f) => f.name === 'slides.pdf');
    const opened = await timed('Open a 4 MB file', () => s.attachments.open(actor, slides.id));
    assert.equal(opened.content.length, 4000 * 1024);

    // Six weeks on, the first 3 weeks' services (5 of them) have expired.
    now = new Date('2025-02-03T12:00:00');
    const purged = await timed('Clear expired files', () => s.attachments.purge(actor));
    assert.equal(purged.removed, 5 * 10);
    assert.equal(purged.bytes, (bytes / MAX_UPCOMING) * 5);
    assert.equal((await s.attachments.list(actor, services.at(-1).id)).files.length, 10, 'later services keep theirs');
  } finally {
    c.close();
  }
});
