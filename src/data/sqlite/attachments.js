import { id as newId, changed, num } from './util.js';

const COLS = 'a.id, a.service_id, a.kind, a.name, a.mime, a.size, a.url, a.added_by, a.created_at, sv.date AS service_date, p.name AS added_by_name';
const FROM = 'FROM attachments a JOIN services sv ON sv.id = a.service_id LEFT JOIN people p ON p.id = a.added_by';

const toAttachment = (r) => ({
  id: r.id,
  serviceId: r.service_id,
  serviceDate: r.service_date,
  kind: r.kind,
  name: r.name,
  mime: r.mime ?? null,
  size: num(r.size),
  url: r.url ?? null,
  addedBy: r.added_by ?? null,
  addedByName: r.added_by_name ?? null,
  createdAt: r.created_at,
});

export function attachmentsRepo({ db, run }) {
  const findById = (attachmentId) => {
    const r = db.prepare(`SELECT ${COLS} ${FROM} WHERE a.id = ?`).get(attachmentId);
    return r ? toAttachment(r) : null;
  };

  return {
    create: ({ serviceId, kind, name, mime = null, url = null, content = null, addedBy = null, createdAt }) => run(() => {
      const bytes = content ? Buffer.from(content) : null;
      const r = db.prepare(
        'INSERT INTO attachments (service_id, kind, name, mime, size, url, added_by, created_at, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(serviceId, kind, name, mime, bytes ? bytes.length : 0, url, addedBy, createdAt, bytes);
      return findById(newId(r));
    }),

    findById: (attachmentId) => run(() => findById(attachmentId)),

    /** The stored bytes of a file (null for a link or an unknown id). */
    content: (attachmentId) => run(() => {
      const r = db.prepare('SELECT content FROM attachments WHERE id = ?').get(attachmentId);
      return r?.content ? Buffer.from(r.content) : null;
    }),

    listForService: (serviceId) => run(() => db.prepare(
      `SELECT ${COLS} ${FROM} WHERE a.service_id = ? ORDER BY a.id`,
    ).all(serviceId).map(toAttachment)),

    /** { [serviceId]: count } for the given services. */
    countByService: (serviceIds) => run(() => {
      if (!serviceIds.length) return {};
      const rows = db.prepare(
        `SELECT service_id, COUNT(*) AS n FROM attachments WHERE service_id IN (${serviceIds.map(() => '?').join(',')}) GROUP BY service_id`,
      ).all(...serviceIds);
      return Object.fromEntries(rows.map((r) => [r.service_id, num(r.n)]));
    }),

    countForService: (serviceId) => run(() => num(db.prepare(
      'SELECT COUNT(*) AS n FROM attachments WHERE service_id = ?',
    ).get(serviceId).n)),

    /** Bytes of the files personId added to services dated fromDate or later. */
    bytesAddedBy: (personId, fromDate) => run(() => num(db.prepare(
      'SELECT COALESCE(SUM(a.size), 0) AS n FROM attachments a JOIN services sv ON sv.id = a.service_id WHERE a.added_by = ? AND sv.date >= ?',
    ).get(personId, fromDate).n)),

    remove: (attachmentId) => run(() => changed(db.prepare('DELETE FROM attachments WHERE id = ?').run(attachmentId))),

    /** Deletes every attachment on services dated on or before lastDate. */
    removeForServicesUpTo: (lastDate) => run(() => {
      const r = db.prepare(
        'SELECT COUNT(*) AS n, COALESCE(SUM(a.size), 0) AS bytes FROM attachments a JOIN services sv ON sv.id = a.service_id WHERE sv.date <= ?',
      ).get(lastDate);
      db.prepare('DELETE FROM attachments WHERE service_id IN (SELECT id FROM services WHERE date <= ?)').run(lastDate);
      return { removed: num(r.n), bytes: num(r.bytes) };
    }),
  };
}
