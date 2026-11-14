import { DuplicateError } from '../errors.js';
import { tx } from '../../db.js';
import { translate, id as newId, changed, num } from './util.js';

const TEAM_DUP = 'A team with that name already exists.';
const TEAM_IN_USE = 'Remove or reassign its positions first';
const POS_DUP = 'That team already has a position with that name.';
const POS_IN_USE = 'This position is used by a service slot, so it cannot be deleted';
export const TEAM_RETIRED_DUP = 'A deleted team has that name. Add it as a new team to bring it back.';
export const POS_RETIRED_DUP = 'A deleted position has that name. Add it as a new position to bring it back.';

export const toPosition = (r) => ({ id: r.id, teamId: r.team_id, name: r.name, sort: r.sort });

function positionsOf(db, teamIds) {
  const by = new Map(teamIds.map((t) => [t, []]));
  if (!teamIds.length) return by;
  const rows = db.prepare(
    `SELECT id, team_id, name, sort FROM positions WHERE team_id IN (${teamIds.map(() => '?').join(',')}) AND retired_at IS NULL
     ORDER BY sort, name COLLATE NOCASE, id`,
  ).all(...teamIds);
  for (const r of rows) by.get(r.team_id).push(toPosition(r));
  return by;
}

function findTeam(db, teamId) {
  const t = db.prepare('SELECT id, name, sort FROM teams WHERE id = ? AND retired_at IS NULL').get(teamId);
  if (!t) return null;
  return { id: t.id, name: t.name, sort: t.sort, positions: positionsOf(db, [t.id]).get(t.id) };
}

function findPosition(db, positionId) {
  const r = db.prepare('SELECT id, team_id, name, sort FROM positions WHERE id = ? AND retired_at IS NULL').get(positionId);
  return r ? toPosition(r) : null;
}

// A name clash with another team: 'active', 'retired' or null.
function teamNameClash(db, name, exceptId = 0) {
  const r = db.prepare('SELECT retired_at FROM teams WHERE name = ? COLLATE NOCASE AND id <> ?').get(name, exceptId);
  if (!r) return null;
  return r.retired_at === null ? 'active' : 'retired';
}

export function teamsRepo({ db, run }) {
  return {
    list: () => run(() => {
      const teams = db.prepare('SELECT id, name, sort FROM teams WHERE retired_at IS NULL ORDER BY sort, name COLLATE NOCASE, id').all();
      const by = positionsOf(db, teams.map((t) => t.id));
      return teams.map((t) => ({ id: t.id, name: t.name, sort: t.sort, positions: by.get(t.id) }));
    }),

    findById: (teamId) => run(() => findTeam(db, teamId)),

    /** A retired team with this name (case-insensitive), or null. */
    findRetiredByName: (name) => run(() => {
      const r = db.prepare('SELECT id, name, sort FROM teams WHERE name = ? COLLATE NOCASE AND retired_at IS NOT NULL').get(name);
      return r ? { id: r.id, name: r.name, sort: r.sort } : null;
    }),

    /** Bring a retired team back under `name`, last in order. Its positions stay retired. */
    revive: (teamId, { name }) => run(() => {
      const s = num(db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM teams WHERE retired_at IS NULL').get().m) + 1;
      db.prepare('UPDATE teams SET retired_at = NULL, name = ?, sort = ? WHERE id = ?').run(name, s, teamId);
      return findTeam(db, teamId);
    }),

    /** Retire the team and every active position in it. */
    retire: (teamId, at) => run(() => tx(db, () => {
      db.prepare('UPDATE positions SET retired_at = ? WHERE team_id = ? AND retired_at IS NULL').run(at, teamId);
      return changed(db.prepare('UPDATE teams SET retired_at = ? WHERE id = ? AND retired_at IS NULL').run(at, teamId));
    })),

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
      if (patch.name !== undefined) {
        const clash = teamNameClash(db, patch.name, teamId);
        if (clash) throw new DuplicateError(clash === 'active' ? TEAM_DUP : TEAM_RETIRED_DUP);
        sets.push('name = ?'); args.push(patch.name);
      }
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
  // A name clash in the team: 'active', 'retired' or null.
  const nameClash = (teamId, name, exceptId = 0) => {
    const r = db.prepare(
      'SELECT retired_at FROM positions WHERE team_id = ? AND name = ? COLLATE NOCASE AND id <> ?',
    ).get(teamId, name, exceptId);
    if (!r) return null;
    return r.retired_at === null ? 'active' : 'retired';
  };
  const clashError = (clash) => new DuplicateError(clash === 'active' ? POS_DUP : POS_RETIRED_DUP);
  const activeTeam = (teamId) => !!db.prepare('SELECT 1 FROM teams WHERE id = ? AND retired_at IS NULL').get(teamId);

  return {
    findById: (positionId) => run(() => findPosition(db, positionId)),

    create: (teamId, { name, sort }) => run(() => {
      if (!activeTeam(teamId)) throw new Error('That team does not exist.');
      const clash = nameClash(teamId, name);
      if (clash) throw clashError(clash);
      const s = sort ?? num(db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM positions WHERE team_id = ?').get(teamId).m) + 1;
      let r;
      try {
        r = db.prepare('INSERT INTO positions (team_id, name, sort) VALUES (?, ?, ?)').run(teamId, name, s);
      } catch (e) {
        throw translate(e, { unique: POS_DUP, missing: 'That team does not exist.' });
      }
      return findPosition(db, newId(r));
    }),

    update: (positionId, patch = {}) => run(() => {
      const cur = findPosition(db, positionId);
      if (!cur) return null;
      const name = patch.name ?? cur.name;
      const sort = patch.sort ?? cur.sort;
      const teamId = patch.teamId ?? cur.teamId;
      if (teamId !== cur.teamId && !activeTeam(teamId)) {
        throw new Error('That team does not exist.');
      }
      const clash = nameClash(teamId, name, positionId);
      if (clash) throw clashError(clash);
      try {
        db.prepare('UPDATE positions SET name = ?, sort = ?, team_id = ? WHERE id = ?').run(name, sort, teamId, positionId);
      } catch (e) {
        throw translate(e, { unique: POS_DUP, missing: 'That team does not exist.' });
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

    /** A retired position in the team with this name (case-insensitive), or null. */
    findRetiredByName: (teamId, name) => run(() => {
      const r = db.prepare(
        'SELECT id, team_id, name, sort FROM positions WHERE team_id = ? AND name = ? COLLATE NOCASE AND retired_at IS NOT NULL',
      ).get(teamId, name);
      return r ? toPosition(r) : null;
    }),

    /** Bring a retired position back under `name`, last in its team. Keeps its id and qualifications. */
    revive: (positionId, { name }) => run(() => {
      const r = db.prepare('SELECT team_id FROM positions WHERE id = ?').get(positionId);
      if (!r) return null;
      const s = num(db.prepare(
        'SELECT COALESCE(MAX(sort), 0) AS m FROM positions WHERE team_id = ? AND retired_at IS NULL',
      ).get(r.team_id).m) + 1;
      db.prepare('UPDATE positions SET retired_at = NULL, name = ?, sort = ? WHERE id = ?').run(name, s, positionId);
      return findPosition(db, positionId);
    }),

    /** Hide a position from every list and picker; past slots keep pointing at it. */
    retire: (positionId, at) => run(() => changed(
      db.prepare('UPDATE positions SET retired_at = ? WHERE id = ? AND retired_at IS NULL').run(at, positionId),
    )),

    countSlots: (positionId) => run(() => num(
      db.prepare('SELECT COUNT(*) AS n FROM slots WHERE position_id = ?').get(positionId).n,
    )),
  };
}
