import { translate, changed, num } from './util.js';

const COLS = 'id, person_id, endpoint, p256dh, auth, created_at';
const toDevice = (r) => ({ id: r.id, personId: r.person_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, createdAt: r.created_at });

export function pushDevicesRepo({ db, run }) {
  const find = (endpoint) => {
    const r = db.prepare(`SELECT ${COLS} FROM push_devices WHERE endpoint = ?`).get(endpoint);
    return r ? toDevice(r) : null;
  };
  return {
    save: ({ personId, endpoint, p256dh, auth, createdAt }) => run(() => {
      try {
        db.prepare(
          `INSERT INTO push_devices (person_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET person_id = excluded.person_id, p256dh = excluded.p256dh,
             auth = excluded.auth, created_at = excluded.created_at`,
        ).run(personId, endpoint, p256dh, auth, createdAt);
      } catch (e) {
        throw translate(e, { missing: 'That person does not exist' });
      }
      return find(endpoint);
    }),

    findByEndpoint: (endpoint) => run(() => find(endpoint)),

    listForPerson: (personId) => run(() => db.prepare(
      `SELECT ${COLS} FROM push_devices WHERE person_id = ? ORDER BY created_at, id`,
    ).all(personId).map(toDevice)),

    personIds: () => run(() => new Set(
      db.prepare('SELECT DISTINCT person_id FROM push_devices ORDER BY person_id').all().map((r) => r.person_id),
    )),

    trimForPerson: (personId, keep) => run(() => num(db.prepare(
      `DELETE FROM push_devices WHERE person_id = ? AND id NOT IN (
         SELECT id FROM push_devices WHERE person_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
    ).run(personId, personId, keep).changes)),

    remove: (endpoint) => run(() => changed(db.prepare('DELETE FROM push_devices WHERE endpoint = ?').run(endpoint))),

    removeOwn: (personId, endpoint) => run(() => changed(
      db.prepare('DELETE FROM push_devices WHERE endpoint = ? AND person_id = ?').run(endpoint, personId),
    )),

    deleteForPerson: (personId) => run(() => num(db.prepare('DELETE FROM push_devices WHERE person_id = ?').run(personId).changes)),
  };
}
