import { translate, id as newId, changed, num } from './util.js';

// Joined = has a way to log in: a password or a linked provider account.
const JOINED = '(password_hash IS NOT NULL OR EXISTS (SELECT 1 FROM identities i WHERE i.person_id = people.id))';
const PUBLIC = `id, name, email, role, password_hash IS NOT NULL AS has_password, ${JOINED} AS joined, active, created_at`;
const DUP = 'That email is already used by someone else.';

const toPerson = (r) => ({
  id: r.id,
  name: r.name,
  email: r.email ?? null,
  role: r.role,
  hasPassword: !!r.has_password,
  joined: !!r.joined,
  active: !!r.active,
  createdAt: r.created_at,
});

const toAuth = (r) => ({
  ...toPerson(r),
  passwordHash: r.password_hash,
  failedLogins: num(r.failed_logins),
  lockedUntil: r.locked_until ?? null,
});

export function peopleRepo({ db, run }) {
  const positionIds = (personId) => db.prepare(
    'SELECT position_id FROM person_positions WHERE person_id = ? ORDER BY position_id',
  ).all(personId).map((r) => r.position_id);

  const findById = (personId) => {
    const r = db.prepare(`SELECT ${PUBLIC} FROM people WHERE id = ?`).get(personId);
    return r ? { ...toPerson(r), positionIds: positionIds(personId) } : null;
  };

  return {
    create: ({ name, email = null, role = 'member', createdAt }) => run(() => {
      let r;
      try {
        r = db.prepare(
          'INSERT INTO people (name, email, role, active, created_at) VALUES (?, ?, ?, 1, ?)',
        ).run(name, email ?? null, role, createdAt);
      } catch (e) {
        throw translate(e, { unique: DUP });
      }
      return findById(newId(r));
    }),

    findById: (personId) => run(() => findById(personId)),

    findAuthById: (personId) => run(() => {
      const r = db.prepare(`SELECT ${PUBLIC}, password_hash, failed_logins, locked_until FROM people WHERE id = ?`).get(personId);
      return r ? toAuth(r) : null;
    }),

    findAuthByEmail: (email) => run(() => {
      if (typeof email !== 'string' || email === '') return null;
      const r = db.prepare(`SELECT ${PUBLIC}, password_hash, failed_logins, locked_until FROM people WHERE email = ?`).get(email.trim());
      return r ? toAuth(r) : null;
    }),

    list: () => run(() => {
      const rows = db.prepare(`SELECT ${PUBLIC} FROM people ORDER BY name COLLATE NOCASE, id`).all();
      const byPerson = new Map();
      for (const q of db.prepare('SELECT person_id, position_id FROM person_positions ORDER BY position_id').all()) {
        if (!byPerson.has(q.person_id)) byPerson.set(q.person_id, []);
        byPerson.get(q.person_id).push(q.position_id);
      }
      return rows.map((r) => ({ ...toPerson(r), positionIds: byPerson.get(r.id) ?? [] }));
    }),

    update: (personId, patch = {}) => run(() => {
      const sets = [];
      const args = [];
      if (patch.name !== undefined) { sets.push('name = ?'); args.push(patch.name); }
      if (patch.role !== undefined) { sets.push('role = ?'); args.push(patch.role); }
      if (patch.active !== undefined) { sets.push('active = ?'); args.push(patch.active ? 1 : 0); }
      if (patch.email !== undefined) { sets.push('email = ?'); args.push(patch.email); }
      if (sets.length) {
        try {
          db.prepare(`UPDATE people SET ${sets.join(', ')} WHERE id = ?`).run(...args, personId);
        } catch (e) {
          throw translate(e, { unique: DUP });
        }
      }
      return findById(personId);
    }),

    setPassword: (personId, passwordHash) => run(() => changed(db.prepare(
      'UPDATE people SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?',
    ).run(passwordHash, personId))),

    setLoginFailures: (personId, { failedLogins = 0, lockedUntil = null } = {}) => run(() => changed(db.prepare(
      'UPDATE people SET failed_logins = ?, locked_until = ? WHERE id = ?',
    ).run(failedLogins, lockedUntil ?? null, personId))),

    countActiveAdmins: () => run(() => num(
      // An unclaimed invite cannot rescue a locked-out church.
      db.prepare(`SELECT COUNT(*) AS n FROM people WHERE role = 'admin' AND active = 1 AND ${JOINED}`).get().n,
    )),
  };
}
