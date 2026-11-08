import { translate, num } from './util.js';

export function identitiesRepo({ db, run }) {
  return {
    link: ({ provider, subject, personId, createdAt }) => run(() => {
      try {
        db.prepare('INSERT INTO identities (provider, subject, person_id, created_at) VALUES (?, ?, ?, ?)')
          .run(provider, subject, personId, createdAt);
      } catch (e) {
        throw translate(e, { unique: 'That account is already linked', missing: 'That person does not exist' });
      }
    }),

    findPersonId: (provider, subject) => run(() => {
      const r = db.prepare('SELECT person_id FROM identities WHERE provider = ? AND subject = ?').get(provider, subject);
      return r ? r.person_id : null;
    }),

    deleteForPerson: (personId) => run(() => num(
      db.prepare('DELETE FROM identities WHERE person_id = ?').run(personId).changes,
    )),
  };
}
