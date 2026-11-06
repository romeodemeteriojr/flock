import { tx } from '../../db.js';

export function qualificationsRepo({ db, run }) {
  return {
    setForPerson: (personId, positionIds) => run(() => {
      if (!Array.isArray(positionIds)) throw new TypeError('positionIds must be a list');
      const unique = [...new Set(positionIds)].sort((a, b) => a - b);
      return tx(db, () => {
        if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(personId)) throw new Error('That person does not exist');
        const find = db.prepare('SELECT 1 FROM positions WHERE id = ?');
        const missing = unique.filter((p) => !find.get(p));
        if (missing.length) throw new Error(`Unknown position id: ${missing.join(', ')}`);
        db.prepare('DELETE FROM person_positions WHERE person_id = ?').run(personId);
        const ins = db.prepare('INSERT INTO person_positions (person_id, position_id) VALUES (?, ?)');
        for (const p of unique) ins.run(personId, p);
        return unique;
      });
    }),

    listPositionIds: (personId) => run(() => db.prepare(
      'SELECT position_id FROM person_positions WHERE person_id = ? ORDER BY position_id',
    ).all(personId).map((r) => r.position_id)),

    listPeople: (positionId) => run(() => db.prepare(
      `SELECT pe.id, pe.name FROM person_positions pp JOIN people pe ON pe.id = pp.person_id
       WHERE pp.position_id = ? AND pe.active = 1 ORDER BY pe.name COLLATE NOCASE, pe.id`,
    ).all(positionId).map((r) => ({ id: r.id, name: r.name }))),

    mapByPosition: () => run(() => {
      const out = new Map();
      const rows = db.prepare(
        `SELECT pp.position_id, pp.person_id FROM person_positions pp JOIN people pe ON pe.id = pp.person_id
         WHERE pe.active = 1 ORDER BY pp.position_id, pp.person_id`,
      ).all();
      for (const r of rows) {
        if (!out.has(r.position_id)) out.set(r.position_id, []);
        out.get(r.position_id).push(r.person_id);
      }
      return out;
    }),
  };
}
