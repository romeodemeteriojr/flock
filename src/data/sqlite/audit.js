import { logAudit } from '../../db.js';

export function auditRepo({ db, run }) {
  return {
    log: ({ at, actorId = null, action, detail = '' }) => run(() => {
      logAudit(db, at, actorId, action, detail ?? '');
    }),

    countSince: ({ actorId, actions, since }) => run(() => {
      if (!actions.length) return 0;
      const at = since instanceof Date ? since.toISOString() : String(since);
      return Number(db.prepare(
        `SELECT COUNT(*) AS n FROM audit WHERE at >= ? AND actor_id = ? AND action IN (${actions.map(() => '?').join(',')})`,
      ).get(at, actorId, ...actions).n);
    }),

    list: (limit = 100) => run(() => {
      const n = Number.isSafeInteger(limit) && limit > 0 ? limit : 100;
      return db.prepare('SELECT id, at, actor_id, action, detail FROM audit ORDER BY id DESC LIMIT ?').all(n)
        .map((r) => ({ id: r.id, at: r.at, actorId: r.actor_id ?? null, action: r.action, detail: r.detail }));
    }),
  };
}
