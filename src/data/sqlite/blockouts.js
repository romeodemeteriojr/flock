import { translate, id as newId, changed } from './util.js';

const toBlockout = (r) => ({
  id: r.id,
  personId: r.person_id,
  startDate: r.start_date,
  endDate: r.end_date,
  reason: r.reason,
  createdAt: r.created_at,
});

export function blockoutsRepo({ db, run }) {
  return {
    create: ({ personId, startDate, endDate, reason = '', createdAt }) => run(() => {
      let r;
      try {
        r = db.prepare('INSERT INTO blockouts (person_id, start_date, end_date, reason, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(personId, startDate, endDate ?? startDate, reason, createdAt);
      } catch (e) {
        if (/CHECK constraint failed/i.test(String(e?.message))) throw new Error('The end date cannot be before the start date');
        throw translate(e, { missing: 'That person does not exist' });
      }
      return toBlockout(db.prepare('SELECT * FROM blockouts WHERE id = ?').get(newId(r)));
    }),

    listForPerson: (personId, fromDate) => run(() => {
      const rows = fromDate == null
        ? db.prepare('SELECT * FROM blockouts WHERE person_id = ? ORDER BY start_date, end_date, id').all(personId)
        : db.prepare('SELECT * FROM blockouts WHERE person_id = ? AND end_date >= ? ORDER BY start_date, end_date, id')
          .all(personId, fromDate);
      return rows.map(toBlockout);
    }),

    remove: (blockoutId, personId) => run(() => changed(
      db.prepare('DELETE FROM blockouts WHERE id = ? AND person_id = ?').run(blockoutId, personId),
    )),

    coversDate: (personId, date) => run(() => !!db.prepare(
      'SELECT 1 FROM blockouts WHERE person_id = ? AND start_date <= ? AND end_date >= ? LIMIT 1',
    ).get(personId, date, date)),

    blockedPersonIds: (date) => run(() => new Set(db.prepare(
      'SELECT DISTINCT person_id FROM blockouts WHERE start_date <= ? AND end_date >= ?',
    ).all(date, date).map((r) => r.person_id))),

    listRange: (fromDate, toDate) => run(() => {
      const where = [];
      const args = [];
      if (fromDate != null) { where.push('b.end_date >= ?'); args.push(fromDate); }
      if (toDate != null) { where.push('b.start_date <= ?'); args.push(toDate); }
      return db.prepare(
        `SELECT b.*, p.name AS person_name FROM blockouts b JOIN people p ON p.id = b.person_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY b.start_date, b.end_date, b.id`,
      ).all(...args).map((r) => ({ ...toBlockout(r), personName: r.person_name }));
    }),

    conflictingSlots: (personId, startDate, endDate) => run(() => db.prepare(
      `SELECT s.id AS slot_id, sv.id AS service_id, sv.date, sv.time, sv.title,
              p.name AS position_name, t.name AS team_name, s.status
         FROM slots s
         JOIN services sv ON sv.id = s.service_id
         JOIN positions p ON p.id = s.position_id
         JOIN teams t ON t.id = p.team_id
        WHERE s.person_id = ? AND s.status IN ('pending','accepted')
          AND sv.date >= ? AND sv.date <= ?
        ORDER BY sv.date, sv.time, s.id`,
    ).all(personId, startDate, endDate).map((r) => ({
      slotId: r.slot_id,
      serviceId: r.service_id,
      date: r.date,
      time: r.time,
      serviceTitle: r.title,
      positionName: r.position_name,
      teamName: r.team_name,
      status: r.status,
    }))),
  };
}
