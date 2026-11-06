// A made-up church for load, fuzz and backup tests: schedulers, members,
// teams with positions, qualifications and a month of Sunday services.
// Everything goes through the app's own services (and addPerson for
// passwords), so the rows are exactly what the app would write. Fake people only.
import { addPerson } from './seed.js';

export const PASSWORD = 'test-pass-1';

export const TEAMS = {
  Band: ['Vocals', 'Guitar', 'Keys', 'Drums'],
  Sound: ['Sound desk', 'Slides'],
  Kids: ['Teacher', 'Helper'],
  Welcome: ['Door', 'Coffee'],
};

/**
 * @param {{data: object, hasher: object, services: object}} container
 * @param {{members?: number, schedulers?: number, sundays?: string[]}} opts
 */
export async function buildChurch(container, { members = 70, schedulers = 5, sundays = [] } = {}) {
  const { services } = container;
  const schedulerIds = [];
  for (let i = 1; i <= schedulers; i++) {
    schedulerIds.push(await addPerson(container, { name: `Scheduler ${i}`, username: `sched${i}`, role: 'admin', password: PASSWORD }));
  }
  const actor = { id: schedulerIds[0] };
  const memberIds = [];
  for (let i = 1; i <= members; i++) {
    memberIds.push(await addPerson(container, { name: `Member ${i}`, username: `member${i}`, password: PASSWORD }));
  }

  const positionIds = [];
  for (const [teamName, positions] of Object.entries(TEAMS)) {
    const team = await services.teams.createTeam(actor, { name: teamName });
    for (const name of positions) positionIds.push((await services.teams.createPosition(actor, team.id, { name })).id);
  }
  // Every member is qualified for every position, so the tests below are about
  // concurrency rules (double booking, races), not about qualifications.
  for (const id of memberIds) await services.teams.setQualifications(actor, id, positionIds);

  const serviceList = [];
  for (const date of sundays) {
    serviceList.push(await services.calendar.createService(actor, {
      date, time: '10:00', title: 'Sunday service', slots: positionIds.map((positionId) => ({ positionId })),
    }));
  }
  return { schedulerIds, memberIds, positionIds, services: serviceList, actor };
}

/** Row counts of every table in the database (sqlite_master order). */
export function tableCounts(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, Number(db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n)]));
}
