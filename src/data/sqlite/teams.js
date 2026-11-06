import { DuplicateError } from '../errors.js';
import { translate, id as newId, changed, num } from './util.js';

const TEAM_DUP = 'A team with that name already exists';
const TEAM_IN_USE = 'Remove or reassign its positions first';
const POS_DUP = 'That team already has a position with that name';
const POS_IN_USE = 'This position is used by a service slot, so it cannot be deleted';

export const toPosition = (r) => ({ id: r.id, teamId: r.team_id, name: r.name, sort: r.sort });

function positionsOf(db, teamIds) {
  const by = new Map(teamIds.map((t) => [t, []]));
  if (!teamIds.length) return by;
  const rows = db.prepare(
    `SELECT id, team_id, name, sort FROM positions WHERE team_id IN (${teamIds.map(() => '?').join(',')})
     ORDER BY sort, name COLLATE NOCASE, id`,
  ).all(...teamIds);
  for (const r of rows) by.get(r.team_id).push(toPosition(r));
  return by;
}

function findTeam(db, teamId) {
  const t = db.prepare('SELECT id, name, sort FROM teams WHERE id = ?').get(teamId);
  if (!t) return null;
  return { id: t.id, name: t.name, sort: t.sort, positions: positionsOf(db, [t.id]).get(t.id) };
}

function findPosition(db, positionId) {
  const r = db.prepare('SELECT id, team_id, name, sort FROM positions WHERE id = ?').get(positionId);
  return r ? toPosition(r) : null;
}

export function teamsRepo({ db, run }) {
  return {
    list: () => run(() => {
      const teams = db.prepare('SELECT id, name, sort FROM teams ORDER BY sort, name COLLATE NOCASE, id').all();
      const by = positionsOf(db, teams.map((t) => t.id));
      return teams.map((t) => ({ id: t.id, name: t.name, sort: t.sort, positions: by.get(t.id) }));
    }),

    findById: (teamId) => run(() => findTeam(db, teamId)),

    create: ({ name, sort }) => run(() => {
      const s = sort ?? num(db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM teams').get().m) + 1;
      let r;
      try {
        r = db.prepare('INSERT INTO teams (name, sort) VALUES (?, ?)').run(name, s);
      } catch (e) {
        throw translate(e, { unique: TEAM_DUP });
      }
      return findTeam(db, newId(r));
    }),

    update: (teamId, patch = {}) => run(() => {
      const sets = [];
      const args = [];
      if (patch.name !== undefined) { sets.push('name = ?'); args.push(patch.name); }
      if (patch.sort !== undefined) { sets.push('sort = ?'); args.push(patch.sort); }
      if (sets.length) {
        try {
          db.prepare(`UPDATE teams SET ${sets.join(', ')} WHERE id = ?`).run(...args, teamId);
        } catch (e) {
          throw translate(e, { unique: TEAM_DUP });
        }
      }
      return findTeam(db, teamId);
    }),

    remove: (teamId) => run(() => {
      try {
        return changed(db.prepare('DELETE FROM teams WHERE id = ?').run(teamId));
      } catch (e) {
        throw translate(e, { inUse: TEAM_IN_USE });
      }
    }),
  };
}

export function positionsRepo({ db, run }) {
  const nameTaken = (teamId, name, exceptId = 0) => !!db.prepare(
    'SELECT 1 FROM positions WHERE team_id = ? AND name = ? COLLATE NOCASE AND id <> ?',
  ).get(teamId, name, exceptId);

  return {
    findById: (positionId) => run(() => findPosition(db, positionId)),

    create: (teamId, { name, sort }) => run(() => {
      if (!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) throw new Error('That team does not exist');
      if (nameTaken(teamId, name)) throw new DuplicateError(POS_DUP);
      const s = sort ?? num(db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM positions WHERE team_id = ?').get(teamId).m) + 1;
      let r;
      try {
        r = db.prepare('INSERT INTO positions (team_id, name, sort) VALUES (?, ?, ?)').run(teamId, name, s);
      } catch (e) {
        throw translate(e, { unique: POS_DUP, missing: 'That team does not exist' });
      }
      return findPosition(db, newId(r));
    }),

    update: (positionId, patch = {}) => run(() => {
      const cur = findPosition(db, positionId);
      if (!cur) return null;
      const name = patch.name ?? cur.name;
      const sort = patch.sort ?? cur.sort;
      const teamId = patch.teamId ?? cur.teamId;
      if (teamId !== cur.teamId && !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) {
        throw new Error('That team does not exist');
      }
      if (nameTaken(teamId, name, positionId)) throw new DuplicateError(POS_DUP);
      try {
        db.prepare('UPDATE positions SET name = ?, sort = ?, team_id = ? WHERE id = ?').run(name, sort, teamId, positionId);
      } catch (e) {
        throw translate(e, { unique: POS_DUP, missing: 'That team does not exist' });
      }
      return findPosition(db, positionId);
    }),

    remove: (positionId) => run(() => {
      try {
        return changed(db.prepare('DELETE FROM positions WHERE id = ?').run(positionId));
      } catch (e) {
        throw translate(e, { inUse: POS_IN_USE });
      }
    }),

    countSlots: (positionId) => run(() => num(
      db.prepare('SELECT COUNT(*) AS n FROM slots WHERE position_id = ?').get(positionId).n,
    )),
  };
}
