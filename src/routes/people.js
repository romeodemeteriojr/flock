import { tx, logAudit } from '../db.js';

const USERNAME_RE = /^[A-Za-z0-9._-]{3,30}$/;
const ROLES = ['admin', 'member'];

const bad = (error) => ({ status: 400, json: { error } });
const conflict = (error) => ({ status: 409, json: { error } });
const isObj = (b) => b !== null && typeof b === 'object' && !Array.isArray(b);

function parseId(raw) {
  return /^[1-9][0-9]{0,9}$/.test(String(raw)) ? Number(raw) : null;
}

function checkKeys(body, allowed) {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) return `Unknown field: ${k.slice(0, 40)}`;
  return null;
}

function cleanName(v) {
  if (typeof v !== 'string') return { error: 'Please enter a name.' };
  const name = v.trim();
  if (name.length < 1 || name.length > 80) return { error: 'The name must be 1 to 80 characters long.' };
  if (/[\u0000-\u001f\u007f]/.test(name)) return { error: 'The name cannot contain control characters.' };
  return { name };
}

function baseUsername(name) {
  let base = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean).join('.');
  base = base.slice(0, 24).replace(/\.+$/, '');
  if (base.length < 3) base = (base + '.user').slice(0, 24);
  return base;
}

function freeUsername(db, name) {
  const base = baseUsername(name);
  const taken = db.prepare('SELECT 1 FROM people WHERE username = ?');
  if (!taken.get(base)) return base;
  for (let n = 2; n < 10000; n++) {
    const u = `${base}${n}`;
    if (!taken.get(u)) return u;
  }
  throw new Error('no free username');
}

export function register(router, ctx) {
  const { db } = ctx;
  const opts = { auth: 'admin' };

  function view(row, positionIds) {
    return {
      id: row.id,
      name: row.name,
      username: row.username,
      role: row.role,
      active: !!row.active,
      mustChangePassword: !!row.must_change_password,
      positionIds,
    };
  }

  function loadOne(id) {
    const row = db.prepare('SELECT id, name, username, role, active, must_change_password FROM people WHERE id = ?').get(id);
    if (!row) return null;
    const ids = db.prepare('SELECT position_id FROM person_positions WHERE person_id = ? ORDER BY position_id').all(id)
      .map((r) => r.position_id);
    return view(row, ids);
  }

  router.add('GET', '/api/people', () => {
    const rows = db.prepare('SELECT id, name, username, role, active, must_change_password FROM people ORDER BY name COLLATE NOCASE, id').all();
    const byPerson = new Map();
    for (const r of db.prepare('SELECT person_id, position_id FROM person_positions ORDER BY position_id').all()) {
      if (!byPerson.has(r.person_id)) byPerson.set(r.person_id, []);
      byPerson.get(r.person_id).push(r.position_id);
    }
    return { status: 200, json: rows.map((r) => view(r, byPerson.get(r.id) ?? [])) };
  }, opts);

  router.add('POST', '/api/people', async ({ body, user }) => {
    if (!isObj(body)) return bad('Please send the person details.');
    const k = checkKeys(body, ['name', 'username', 'role']);
    if (k) return bad(k);
    const n = cleanName(body.name);
    if (n.error) return bad(n.error);
    let role = 'member';
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) return bad('The role must be admin or member.');
      role = body.role;
    }
    let username = null;
    if (body.username !== undefined && body.username !== null && body.username !== '') {
      if (typeof body.username !== 'string' || !USERNAME_RE.test(body.username.trim())) {
        return bad('The username must be 3 to 30 letters, digits, dots, underscores or dashes.');
      }
      username = body.username.trim().toLowerCase();
    }
    const { tempPassword, passwordHash: hash } = await ctx.services.auth.newTempCredentials();
    try {
      const id = tx(db, () => {
        const uname = username ?? freeUsername(db, n.name);
        if (db.prepare('SELECT 1 FROM people WHERE username = ?').get(uname)) throw Object.assign(new Error('dup'), { dup: true });
        const r = db.prepare(
          'INSERT INTO people (name, username, password_hash, role, must_change_password, active, created_at) VALUES (?, ?, ?, ?, 1, 1, ?)',
        ).run(n.name, uname, hash, role, new Date(ctx.now()).toISOString());
        const newId = Number(r.lastInsertRowid);
        logAudit(db, new Date(ctx.now()), user.id, 'person.create', `person ${newId} (${uname}) role ${role}`);
        return newId;
      });
      return { status: 201, json: { person: loadOne(id), tempPassword } };
    } catch (e) {
      if (e.dup || /UNIQUE/i.test(String(e.message))) return conflict('That username is already taken');
      throw e;
    }
  }, opts);

  router.add('PATCH', '/api/people/:id', ({ params, body, user }) => {
    const id = parseId(params.id);
    if (!id) return bad('That person id is not valid.');
    if (!isObj(body)) return bad('Please send the changes.');
    const k = checkKeys(body, ['name', 'role', 'active']);
    if (k) return bad(k);
    if (body.name === undefined && body.role === undefined && body.active === undefined) return bad('There is nothing to change.');
    let name;
    if (body.name !== undefined) {
      const n = cleanName(body.name);
      if (n.error) return bad(n.error);
      name = n.name;
    }
    if (body.role !== undefined && !ROLES.includes(body.role)) return bad('The role must be admin or member.');
    if (body.active !== undefined && typeof body.active !== 'boolean') return bad('Active must be true or false.');

    return tx(db, () => {
      const cur = db.prepare('SELECT * FROM people WHERE id = ?').get(id);
      if (!cur) return { status: 404, json: { error: 'That person was not found' } };
      const newRole = body.role ?? cur.role;
      const newActive = body.active === undefined ? cur.active : (body.active ? 1 : 0);
      if (id === user.id && newActive === 0 && cur.active) {
        return conflict('You cannot deactivate your own account');
      }
      const wasActiveAdmin = cur.role === 'admin' && cur.active === 1;
      const stillActiveAdmin = newRole === 'admin' && newActive === 1;
      if (wasActiveAdmin && !stillActiveAdmin) {
        const others = db.prepare("SELECT COUNT(*) AS c FROM people WHERE role = 'admin' AND active = 1 AND id <> ?").get(id).c;
        if (Number(others) === 0) return conflict('There must always be at least one active admin');
      }
      const changes = [];
      if (name !== undefined && name !== cur.name) changes.push('name');
      if (newRole !== cur.role) changes.push(`role ${cur.role} -> ${newRole}`);
      if (newActive !== cur.active) changes.push(newActive ? 'reactivated' : 'deactivated');
      db.prepare('UPDATE people SET name = ?, role = ?, active = ? WHERE id = ?').run(name ?? cur.name, newRole, newActive, id);
      if (newActive === 0) db.prepare('DELETE FROM sessions WHERE person_id = ?').run(id);
      if (changes.length) logAudit(db, new Date(ctx.now()), user.id, 'person.update', `person ${id}: ${changes.join(', ')}`);
      return { status: 200, json: { person: loadOne(id) } };
    });
  }, opts);

  router.add('POST', '/api/people/:id/reset-password', async ({ params, user }) => {
    const id = parseId(params.id);
    if (!id) return bad('That person id is not valid.');
    if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(id)) return { status: 404, json: { error: 'That person was not found' } };
    const tempPassword = await ctx.services.auth.issueTempPassword(id);
    logAudit(db, new Date(ctx.now()), user.id, 'person.reset_password', `person ${id}`);
    return { status: 200, json: { tempPassword } };
  }, opts);
}
