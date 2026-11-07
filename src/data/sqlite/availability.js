import { translate } from './util.js';

const toAvailability = (r) => ({ personId: r.person_id, everyWeeks: r.every_weeks, updatedAt: r.updated_at });

export function availabilityRepo({ db, run }) {
  const get = (personId) => {
    const r = db.prepare('SELECT person_id, every_weeks, updated_at FROM availability WHERE person_id = ?').get(personId);
    return r ? toAvailability(r) : null;
  };
  return {
    get: (personId) => run(() => get(personId)),

    set: (personId, { everyWeeks, updatedAt }) => run(() => {
      try {
        db.prepare(
          `INSERT INTO availability (person_id, every_weeks, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(person_id) DO UPDATE SET every_weeks = excluded.every_weeks, updated_at = excluded.updated_at`,
        ).run(personId, everyWeeks, updatedAt);
      } catch (e) {
        if (/CHECK constraint failed/i.test(String(e?.message))) throw new Error('every weeks must be 0, 1, 2, 3, 4, 6 or 8');
        throw translate(e, { missing: 'That person does not exist' });
      }
      return get(personId);
    }),

    mapAll: () => run(() => new Map(
      db.prepare('SELECT person_id, every_weeks FROM availability ORDER BY person_id').all()
        .map((r) => [r.person_id, r.every_weeks]),
    )),
  };
}
