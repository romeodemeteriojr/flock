import { translate, id as newId, num } from './util.js';

export function sessionsRepo({ db, run }) {
  return {
    create: ({ tokenHash, personId, expiresAt, createdAt }) => run(() => {
      let r;
      try {
        r = db.prepare('INSERT INTO sessions (token_hash, person_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
          .run(tokenHash, personId, expiresAt, createdAt);
      } catch (e) {
        throw translate(e, { unique: 'That session already exists', missing: 'That person does not exist' });
      }
      return { id: newId(r), personId, expiresAt, createdAt };
    }),

    findByTokenHash: (tokenHash) => run(() => {
      const r = db.prepare('SELECT person_id, expires_at FROM sessions WHERE token_hash = ?').get(tokenHash);
      return r ? { personId: r.person_id, expiresAt: r.expires_at } : null;
    }),

    extend: (tokenHash, expiresAt) => run(() => Number(
      db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(expiresAt, tokenHash).changes,
    ) > 0),

    deleteByTokenHash: (tokenHash) => run(() => num(
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash).changes,
    )),

    deleteForPerson: (personId, exceptTokenHash) => run(() => {
      const r = typeof exceptTokenHash === 'string' && exceptTokenHash !== ''
        ? db.prepare('DELETE FROM sessions WHERE person_id = ? AND token_hash <> ?').run(personId, exceptTokenHash)
        : db.prepare('DELETE FROM sessions WHERE person_id = ?').run(personId);
      return num(r.changes);
    }),

    deleteExpired: (nowIso) => run(() => num(
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso).changes,
    )),
  };
}
