import { logAudit } from '../../db.js';

export function auditRepo({ db, run }) {
  return {
    log: ({ at, actorId = null, action, detail = '' }) => run(() => {
      logAudit(db, at, actorId, action, detail ?? '');
    }),

    list: (limit = 100) => run(() => {
      const n = Number.isSafeInteger(limit) && limit > 0 ? limit : 100;
      return db.prepare('SELECT id, at, actor_id, action, detail FROM audit ORDER BY id DESC LIMIT ?').all(n)
        .map((r) => ({ id: r.id, at: r.at, actorId: r.actor_id ?? null, action: r.action, detail: r.detail }));
    }),
  };
}
