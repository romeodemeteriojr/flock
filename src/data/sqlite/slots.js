import { tx } from '../../db.js';
import { translate, id as newId, changed, num } from './util.js';

export const SLOT_SELECT = `
  SELECT s.id, s.service_id, s.position_id, s.person_id, s.status, s.assigned_at, s.responded_at,
         sv.date AS service_date, sv.time AS service_time, sv.title AS service_title,
         p.name AS position_name, p.sort AS position_sort,
         t.id AS team_id, t.name AS team_name, t.sort AS team_sort,
         pe.name AS person_name
    FROM slots s
    JOIN services sv ON sv.id = s.service_id
    JOIN positions p ON p.id = s.position_id
    JOIN teams t ON t.id = p.team_id
    LEFT JOIN people pe ON pe.id = s.person_id`;

const BY_DATE = 'ORDER BY sv.date, sv.time, t.sort, p.sort, s.id';

export const toSlot = (r) => ({
  id: r.id,
  serviceId: r.service_id,
  positionId: r.position_id,
  personId: r.person_id ?? null,
  status: r.status,
  assignedAt: r.assigned_at ?? null,
  respondedAt: r.responded_at ?? null,
  serviceDate: r.service_date,
  serviceTime: r.service_time,
  serviceTitle: r.service_title,
  positionName: r.position_name,
  positionSort: r.position_sort,
  teamId: r.team_id,
  teamName: r.team_name,
  teamSort: r.team_sort,
  personName: r.person_name ?? null,
});

export function slotsRepo({ db, run }) {
  const findById = (slotId) => {
    const r = db.prepare(`${SLOT_SELECT} WHERE s.id = ?`).get(slotId);
    return r ? toSlot(r) : null;
  };

  return {
    createMany: (serviceId, positionIds) => run(() => {
      if (!Array.isArray(positionIds)) throw new TypeError('positionIds must be a list');
      const ids = tx(db, () => {
        const ins = db.prepare('INSERT INTO slots (service_id, position_id) VALUES (?, ?)');
        try {
          return positionIds.map((p) => newId(ins.run(serviceId, p)));
        } catch (e) {
          throw translate(e, { missing: 'That service or position does not exist' });
        }
      });
      return ids.map(findById);
    }),

    findById: (slotId) => run(() => findById(slotId)),

    listForServices: (fromDate, toDate) => run(() => db.prepare(
      `${SLOT_SELECT} WHERE sv.date >= ? AND sv.date <= ? ${BY_DATE}`,
    ).all(fromDate, toDate).map(toSlot)),

    listForService: (serviceId) => run(() => db.prepare(
      `${SLOT_SELECT} WHERE s.service_id = ? ORDER BY t.sort, p.sort, s.id`,
    ).all(serviceId).map(toSlot)),

    listForPerson: (personId, fromDate, toDate, statuses) => run(() => {
      const where = ['s.person_id = ?'];
      const args = [personId];
      if (fromDate != null) { where.push('sv.date >= ?'); args.push(fromDate); }
      if (toDate != null) { where.push('sv.date <= ?'); args.push(toDate); }
      if (Array.isArray(statuses)) {
        if (!statuses.length) return [];
        where.push(`s.status IN (${statuses.map(() => '?').join(',')})`);
        args.push(...statuses);
      }
      return db.prepare(`${SLOT_SELECT} WHERE ${where.join(' AND ')} ${BY_DATE}`).all(...args).map(toSlot);
    }),

    assign: (slotId, { personId, status = 'pending', assignedAt }) => run(() => {
      try {
        db.prepare('UPDATE slots SET person_id = ?, status = ?, assigned_at = ?, responded_at = NULL WHERE id = ?')
          .run(personId, status, assignedAt ?? null, slotId);
      } catch (e) {
        throw translate(e, { missing: 'That person does not exist' });
      }
      return findById(slotId);
    }),

    clear: (slotId) => run(() => {
      db.prepare("UPDATE slots SET person_id = NULL, status = 'open', assigned_at = NULL, responded_at = NULL WHERE id = ?")
        .run(slotId);
      return findById(slotId);
    }),

    respond: (slotId, { status, respondedAt }) => run(() => {
      db.prepare('UPDATE slots SET status = ?, responded_at = ? WHERE id = ?').run(status, respondedAt ?? null, slotId);
      return findById(slotId);
    }),

    remove: (slotId) => run(() => changed(db.prepare('DELETE FROM slots WHERE id = ?').run(slotId))),

    /** Slots of these positions on services dated `from` or later, by date. */
    listForPositionsFrom: (positionIds, from) => run(() => {
      if (!positionIds.length) return [];
      return db.prepare(
        `${SLOT_SELECT} WHERE s.position_id IN (${positionIds.map(() => '?').join(',')}) AND sv.date >= ? ${BY_DATE}`,
      ).all(...positionIds, from).map(toSlot);
    }),

    countForPersonOnService: (personId, serviceId) => run(() => num(db.prepare(
      'SELECT COUNT(*) AS n FROM slots WHERE person_id = ? AND service_id = ?',
    ).get(personId, serviceId).n)),

    assignedBetween: (fromDate, toDate) => run(() => db.prepare(
      `${SLOT_SELECT} WHERE s.person_id IS NOT NULL AND sv.date >= ? AND sv.date <= ? ${BY_DATE}`,
    ).all(fromDate, toDate).map(toSlot)),
  };
}
