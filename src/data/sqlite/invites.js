import { translate, num } from './util.js';

export function invitesRepo({ db, run }) {
  return {
    replace: ({ personId, tokenHash, expiresAt, createdAt }) => run(() => {
      try {
        db.prepare(`INSERT INTO invites (person_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(person_id) DO UPDATE SET token_hash=excluded.token_hash,
          expires_at=excluded.expires_at, created_at=excluded.created_at`)
          .run(personId, tokenHash, expiresAt, createdAt);
      } catch (e) {
        throw translate(e, { unique: 'That invite already exists', missing: 'That person does not exist' });
      }
    }),

    findByTokenHash: (tokenHash) => run(() => {
      const r = db.prepare('SELECT person_id, token_hash, expires_at, created_at FROM invites WHERE token_hash = ?').get(tokenHash);
      return r ? { personId: r.person_id, tokenHash: r.token_hash, expiresAt: r.expires_at, createdAt: r.created_at } : null;
    }),

    deleteForPerson: (personId) => run(() => num(
      db.prepare('DELETE FROM invites WHERE person_id = ?').run(personId).changes,
    )),
  };
}
