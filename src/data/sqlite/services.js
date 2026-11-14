import { translate, id as newId, changed, num } from './util.js';

const DUP = 'A service already exists at that date and time.';
const toService = (r) => ({ id: r.id, date: r.date, time: r.time, title: r.title });

export function servicesRepo({ db, run }) {
  const findById = (serviceId) => {
    const r = db.prepare('SELECT id, date, time, title FROM services WHERE id = ?').get(serviceId);
    return r ? toService(r) : null;
  };

  return {
    create: ({ date, time = '09:00', title }) => run(() => {
      let r;
      try {
        r = db.prepare('INSERT INTO services (date, time, title) VALUES (?, ?, ?)').run(date, time, title);
      } catch (e) {
        throw translate(e, { unique: DUP });
      }
      return findById(newId(r));
    }),

    findById: (serviceId) => run(() => findById(serviceId)),

    findByDateTime: (date, time) => run(() => {
      const r = db.prepare('SELECT id, date, time, title FROM services WHERE date = ? AND time = ?').get(date, time);
      return r ? toService(r) : null;
    }),

    listRange: (fromDate, toDate) => run(() => db.prepare(
      'SELECT id, date, time, title FROM services WHERE date >= ? AND date <= ? ORDER BY date, time, id',
    ).all(fromDate, toDate).map(toService)),

    update: (serviceId, patch = {}) => run(() => {
      const sets = [];
      const args = [];
      for (const k of ['date', 'time', 'title']) {
        if (patch[k] !== undefined) { sets.push(`${k} = ?`); args.push(patch[k]); }
      }
      if (sets.length) {
        try {
          db.prepare(`UPDATE services SET ${sets.join(', ')} WHERE id = ?`).run(...args, serviceId);
        } catch (e) {
          throw translate(e, { unique: DUP });
        }
      }
      return findById(serviceId);
    }),

    remove: (serviceId) => run(() => changed(db.prepare('DELETE FROM services WHERE id = ?').run(serviceId))),

    assignedCount: (serviceId) => run(() => num(db.prepare(
      'SELECT COUNT(DISTINCT person_id) AS n FROM slots WHERE service_id = ? AND person_id IS NOT NULL',
    ).get(serviceId).n)),
  };
}
