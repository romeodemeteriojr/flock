// Fake demo data, written through the application services. Nothing real.
import { addDays, todayStr, weekdayName } from '../dates.js';

const PEOPLE = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy', 'Mallory', 'Niaj'];

// team -> positions -> indexes of the (fake) people who are qualified
const TEAMS = {
  Band: { Vocals: [0, 1, 2], Guitar: [3, 4], Keys: [2, 5], Drums: [6, 3] },
  Sound: { 'Sound desk': [7, 8, 9], Slides: [10, 11, 8] },
  Kids: { Teacher: [0, 4, 9, 10], Helper: [1, 5, 11, 6] },
  Greeters: { 'Door greeter': [2, 7, 8, 11, 1], Welcome: [4, 6, 10, 0] },
};

const WEEKS = 8;
// Repeating pattern of what each slot looks like.
const PATTERN = ['open', 'pending', 'accepted', 'declined', 'accepted', 'pending', 'open', 'accepted'];

function nextSunday(today) {
  let d = addDays(today, 1);
  while (weekdayName(d) !== 'Sunday') d = addDays(d, 1);
  return d;
}

/** Fill an empty database. Returns { invite, counts }. */
export async function seedDemo({ services, clock }) {
  const { people, teams, calendar, assignments, blockouts } = services;
  const admin = await people.create(null, { name: 'Demo Admin', email: 'demo-admin@example.com', role: 'admin' });
  const actor = admin.person;

  const folks = [];
  for (const first of PEOPLE) {
    const { person } = await people.create(actor, { name: `Demo ${first}`, email: `demo.${first.toLowerCase()}@example.com` });
    folks.push(person);
  }

  const qualified = new Map(); // position id -> person ids
  const positionIds = []; // in order, with team
  const personPositions = folks.map(() => []);
  for (const name of Object.keys(TEAMS)) {
    const team = await teams.createTeam(actor, { name });
    for (const [posName, who] of Object.entries(TEAMS[name])) {
      const pos = await teams.createPosition(actor, team.id, { name: posName });
      positionIds.push(pos.id);
      qualified.set(pos.id, who.map((i) => folks[i].id));
      who.forEach((i) => personPositions[i].push(pos.id));
    }
  }
  for (let i = 0; i < folks.length; i++) await teams.setQualifications(actor, folks[i].id, personPositions[i]);

  const today = todayStr(clock.now());
  const first = nextSunday(today);
  const dates = Array.from({ length: WEEKS }, (_, w) => addDays(first, 7 * w));

  // A few blockouts first, so the schedule below avoids those people.
  const blocks = [[2, 1, 'Demo holiday'], [5, 3, 'Demo trip'], [8, 4, 'Demo family visit'], [0, 6, 'Demo conference']];
  for (const [p, w, reason] of blocks) {
    await blockouts.add(folks[p].id, { startDate: dates[w], endDate: dates[w], reason });
  }

  let k = 0;
  for (let w = 0; w < WEEKS; w++) {
    const svc = await calendar.createService(actor, {
      date: dates[w],
      time: '10:00',
      title: 'Sunday service',
      slots: positionIds.map((positionId) => ({ positionId })),
    });
    const holding = new Set();
    for (const slot of svc.slots) {
      const want = PATTERN[(k++ + w) % PATTERN.length];
      if (want === 'open') continue;
      const pool = qualified.get(slot.positionId);
      let who = null;
      for (let t = 0; t < pool.length; t++) {
        const id = pool[(w + t) % pool.length];
        if (holding.has(id) || await blockouts.isBlocked(id, dates[w])) continue;
        who = id;
        break;
      }
      if (who === null) continue; // stays open
      holding.add(who);
      await assignments.assign(actor, slot.id, { personId: who });
      if (want === 'accepted') await assignments.respond(who, slot.id, 'accept');
      if (want === 'declined') {
        await assignments.respond(who, slot.id, 'decline');
        holding.delete(who);
      }
    }
  }

  return {
    invite: admin.invite,
    counts: { people: folks.length + 1, teams: Object.keys(TEAMS).length, services: WEEKS, blockouts: blocks.length },
  };
}
