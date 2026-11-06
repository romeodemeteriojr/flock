import { tx, logAudit } from '../db.js';

const bad = (error, status = 400) => ({ status, json: { error } });
const ok = (json, status = 200) => ({ status, json });

function cleanName(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length >= 1 && s.length <= 60 ? s : null;
}
const NAME_ERR = 'Name must be 1 to 60 characters';
const isInt = (v) => Number.isSafeInteger(v);
const toId = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);

export function register(router, ctx) {
  const db = ctx.db;
  const audit = (user, action, detail) => logAudit(db, ctx.now(), user.id, action, detail);
  const getTeam = (id) => (id === null ? undefined : db.prepare('SELECT id, name, sort FROM teams WHERE id = ?').get(id));
  const getPosition = (id) => (id === null ? undefined : db.prepare('SELECT id, team_id, name, sort FROM positions WHERE id = ?').get(id));
  const teamUsed = (id) => !!db.prepare('SELECT 1 FROM slots s JOIN positions p ON p.id = s.position_id WHERE p.team_id = ? LIMIT 1').get(id);
  const positionUsed = (id) => !!db.prepare('SELECT 1 FROM slots WHERE position_id = ? LIMIT 1').get(id);
  const teamJson = (t) => ({ id: t.id, name: t.name, sort: t.sort });
  const posJson = (p) => ({ id: p.id, teamId: p.team_id, name: p.name, sort: p.sort });
  const teamNameTaken = (name, exceptId = 0) =>
    !!db.prepare('SELECT 1 FROM teams WHERE name = ? COLLATE NOCASE AND id != ?').get(name, exceptId);
  const posNameTaken = (teamId, name, exceptId = 0) =>
    !!db.prepare('SELECT 1 FROM positions WHERE team_id = ? AND name = ? COLLATE NOCASE AND id != ?').get(teamId, name, exceptId);


  router.add('GET', '/api/teams', ({ user }) => {
    const admin = user.role === 'admin';
    const teams = db.prepare('SELECT id, name FROM teams ORDER BY sort, name COLLATE NOCASE, id').all();
    const positions = db.prepare('SELECT id, team_id, name FROM positions ORDER BY sort, name COLLATE NOCASE, id').all();
    const quals = new Map();
    if (admin) {
      const rows = db.prepare(
        'SELECT pp.position_id, pp.person_id FROM person_positions pp JOIN people pe ON pe.id = pp.person_id WHERE pe.active = 1 ORDER BY pp.person_id',
      ).all();
      for (const r of rows) {
        if (!quals.has(r.position_id)) quals.set(r.position_id, []);
        quals.get(r.position_id).push(r.person_id);
      }
    }
    const out = teams.map((t) => ({
      id: t.id,
      name: t.name,
      positions: positions.filter((p) => p.team_id === t.id).map((p) => {
        const o = { id: p.id, name: p.name };
        if (admin) o.qualifiedPersonIds = quals.get(p.id) ?? [];
        return o;
      }),
    }));
    return ok(out);
  }, { auth: 'login' });

  router.add('POST', '/api/teams', ({ body, user }) => {
    const name = cleanName(body?.name);
    if (!name) return bad(NAME_ERR);
    if (teamNameTaken(name)) return bad('A team with that name already exists', 409);
    const max = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM teams').get().m;
    const r = db.prepare('INSERT INTO teams (name, sort) VALUES (?, ?)').run(name, max + 1);
    const id = Number(r.lastInsertRowid);
    audit(user, 'team.create', `team ${id} "${name}"`);
    return ok(teamJson(getTeam(id)), 201);
  }, { auth: 'admin' });

  router.add('PATCH', '/api/teams/:id', ({ params, body, user }) => {
    const team = getTeam(toId(params.id));
    if (!team) return bad('Team not found', 404);
    let name = team.name;
    let sort = team.sort;
    if (body?.name !== undefined) {
      name = cleanName(body.name);
      if (!name) return bad(NAME_ERR);
      if (teamNameTaken(name, team.id)) return bad('A team with that name already exists', 409);
    }
    if (body?.sort !== undefined) {
      if (!isInt(body.sort)) return bad('Sort must be a whole number');
      sort = body.sort;
    }
    db.prepare('UPDATE teams SET name = ?, sort = ? WHERE id = ?').run(name, sort, team.id);
    audit(user, 'team.update', `team ${team.id} "${name}" sort ${sort}`);
    return ok(teamJson(getTeam(team.id)));
  }, { auth: 'admin' });

  router.add('DELETE', '/api/teams/:id', ({ params, user }) => {
    const team = getTeam(toId(params.id));
    if (!team) return bad('Team not found', 404);
    if (teamUsed(team.id)) return bad('Remove or reassign its positions first', 409);
    tx(db, () => {
      db.prepare('DELETE FROM positions WHERE team_id = ?').run(team.id);
      db.prepare('DELETE FROM teams WHERE id = ?').run(team.id);
      audit(user, 'team.delete', `team ${team.id} "${team.name}"`);
    });
    return ok({ ok: true });
  }, { auth: 'admin' });

  router.add('POST', '/api/teams/:id/positions', ({ params, body, user }) => {
    const team = getTeam(toId(params.id));
    if (!team) return bad('Team not found', 404);
    const name = cleanName(body?.name);
    if (!name) return bad(NAME_ERR);
    if (posNameTaken(team.id, name)) return bad('That team already has a position with that name', 409);
    const max = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM positions WHERE team_id = ?').get(team.id).m;
    const r = db.prepare('INSERT INTO positions (team_id, name, sort) VALUES (?, ?, ?)').run(team.id, name, max + 1);
    const id = Number(r.lastInsertRowid);
    audit(user, 'position.create', `position ${id} "${name}" in team ${team.id}`);
    return ok(posJson(getPosition(id)), 201);
  }, { auth: 'admin' });

  router.add('PATCH', '/api/positions/:id', ({ params, body, user }) => {
    const pos = getPosition(toId(params.id));
    if (!pos) return bad('Position not found', 404);
    let { name, sort, team_id: teamId } = pos;
    if (body?.name !== undefined) {
      name = cleanName(body.name);
      if (!name) return bad(NAME_ERR);
    }
    if (body?.sort !== undefined) {
      if (!isInt(body.sort)) return bad('Sort must be a whole number');
      sort = body.sort;
    }
    if (body?.teamId !== undefined) {
      if (!isInt(body.teamId) || !getTeam(body.teamId)) return bad('That team does not exist');
      teamId = body.teamId;
    }
    if (posNameTaken(teamId, name, pos.id)) return bad('That team already has a position with that name', 409);
    db.prepare('UPDATE positions SET name = ?, sort = ?, team_id = ? WHERE id = ?').run(name, sort, teamId, pos.id);
    audit(user, 'position.update', `position ${pos.id} "${name}" team ${teamId} sort ${sort}`);
    return ok(posJson(getPosition(pos.id)));
  }, { auth: 'admin' });

  router.add('DELETE', '/api/positions/:id', ({ params, user }) => {
    const pos = getPosition(toId(params.id));
    if (!pos) return bad('Position not found', 404);
    if (positionUsed(pos.id)) return bad('This position is used by a service slot, so it cannot be deleted', 409);
    db.prepare('DELETE FROM positions WHERE id = ?').run(pos.id);
    audit(user, 'position.delete', `position ${pos.id} "${pos.name}"`);
    return ok({ ok: true });
  }, { auth: 'admin' });

  router.add('PUT', '/api/people/:id/positions', ({ params, body, user }) => {
    const personId = toId(params.id);
    const person = personId === null ? undefined : db.prepare('SELECT id, name FROM people WHERE id = ?').get(personId);
    if (!person) return bad('Person not found', 404);
    const ids = body?.positionIds;
    if (!Array.isArray(ids) || !ids.every(isInt)) return bad('positionIds must be a list of position ids');
    const unique = [...new Set(ids)];
    const find = db.prepare('SELECT 1 FROM positions WHERE id = ?');
    if (unique.some((id) => !find.get(id))) return bad('One or more positions do not exist');
    tx(db, () => {
      db.prepare('DELETE FROM person_positions WHERE person_id = ?').run(person.id);
      const ins = db.prepare('INSERT INTO person_positions (person_id, position_id) VALUES (?, ?)');
      for (const id of unique) ins.run(person.id, id);
      audit(user, 'person.positions', `person ${person.id} positions [${unique.join(',')}]`);
    });
    return ok({ positionIds: unique.sort((a, b) => a - b) });
  }, { auth: 'admin' });

  router.add('GET', '/api/positions/:id/people', ({ params }) => {
    const pos = getPosition(toId(params.id));
    if (!pos) return bad('Position not found', 404);
    const rows = db.prepare(
      `SELECT pe.id, pe.name FROM person_positions pp JOIN people pe ON pe.id = pp.person_id
       WHERE pp.position_id = ? AND pe.active = 1 ORDER BY pe.name COLLATE NOCASE, pe.id`,
    ).all(pos.id);
    return ok(rows.map((r) => ({ id: r.id, name: r.name })));
  }, { auth: 'admin' });

  router.add('GET', '/api/me/positions', ({ user }) => {
    const rows = db.prepare(
      `SELECT p.id, p.name, t.id AS team_id, t.name AS team_name FROM person_positions pp
       JOIN positions p ON p.id = pp.position_id JOIN teams t ON t.id = p.team_id
       WHERE pp.person_id = ? ORDER BY t.sort, t.name COLLATE NOCASE, p.sort, p.name COLLATE NOCASE`,
    ).all(user.id);
    return ok(rows.map((r) => ({ id: r.id, name: r.name, teamId: r.team_id, teamName: r.team_name })));
  }, { auth: 'login' });
}
