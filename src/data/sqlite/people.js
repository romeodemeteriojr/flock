import { translate, id as newId, changed, num } from './util.js';

const PUBLIC = 'id, name, username, role, password_hash IS NOT NULL AS has_password, active, created_at';
const DUP = 'That username is already taken';

const toPerson = (r) => ({
  id: r.id,
  name: r.name,
  username: r.username,
  role: r.role,
  hasPassword: !!r.has_password,
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
    create: ({ name, username, role = 'member', createdAt }) => run(() => {
      let r;
      try {
        r = db.prepare(
          'INSERT INTO people (name, username, role, active, created_at) VALUES (?, ?, ?, 1, ?)',
        ).run(name, username, role, createdAt);
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

    findAuthByUsername: (username) => run(() => {
      if (typeof username !== 'string' || username === '') return null;
      const r = db.prepare(`SELECT ${PUBLIC}, password_hash, failed_logins, locked_until FROM people WHERE username = ?`).get(username);
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
      if (sets.length) db.prepare(`UPDATE people SET ${sets.join(', ')} WHERE id = ?`).run(...args, personId);
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
      db.prepare("SELECT COUNT(*) AS n FROM people WHERE role = 'admin' AND active = 1 AND password_hash IS NOT NULL").get().n,
    )),
  };
}
