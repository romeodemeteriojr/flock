import { isRealDate, todayStr, daysBetween, conflictsFor } from '../blockouts.js';

const bad = (error) => ({ status: 400, json: { error } });
const shape = (r) => ({ id: r.id, personId: r.person_id, startDate: r.start_date, endDate: r.end_date, reason: r.reason });

export function register(router, ctx) {
  const { db } = ctx;

  router.add('GET', '/api/me/blockouts', ({ user }) => {
    const today = todayStr(ctx.now());
    const rows = db.prepare(
      'SELECT * FROM blockouts WHERE person_id = ? AND end_date >= ? ORDER BY start_date, end_date, id',
    ).all(user.id, today);
    return { status: 200, json: { blockouts: rows.map(shape) } };
  }, { auth: 'login' });

  router.add('POST', '/api/me/blockouts', ({ user, body }) => {
    const b = body && typeof body === 'object' ? body : {};
    const startDate = b.startDate;
    const endDate = b.endDate === undefined || b.endDate === null || b.endDate === '' ? startDate : b.endDate;
    if (!isRealDate(startDate)) return bad('Start date must be a real date like 2025-11-08');
    if (!isRealDate(endDate)) return bad('End date must be a real date like 2025-11-08');
    if (endDate < startDate) return bad('End date cannot be before the start date');
    if (endDate < todayStr(ctx.now())) return bad('That time is already past');
    if (daysBetween(startDate, endDate) + 1 > 366) return bad('A blockout can be at most 366 days');
    let reason = b.reason ?? '';
    if (typeof reason !== 'string') return bad('Reason must be text');
    reason = reason.trim();
    if (reason.length > 200) return bad('Reason can be at most 200 characters');
    const r = db.prepare(
      'INSERT INTO blockouts (person_id, start_date, end_date, reason, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(user.id, startDate, endDate, reason, new Date(ctx.now()).toISOString());
    const row = db.prepare('SELECT * FROM blockouts WHERE id = ?').get(Number(r.lastInsertRowid));
    return { status: 201, json: { blockout: shape(row), conflicts: conflictsFor(db, user.id, startDate, endDate) } };
  }, { auth: 'login' });

  router.add('DELETE', '/api/me/blockouts/:id', ({ user, params }) => {
    const id = /^\d+$/.test(params.id) ? Number(params.id) : null;
    const r = id === null ? { changes: 0 }
      : db.prepare('DELETE FROM blockouts WHERE id = ? AND person_id = ?').run(id, user.id);
    if (!r.changes) return { status: 404, json: { error: 'Blockout not found' } };
    return { status: 200, json: { ok: true } };
  }, { auth: 'login' });

  router.add('GET', '/api/people/:id/blockouts', ({ params }) => {
    const id = /^\d+$/.test(params.id) ? Number(params.id) : null;
    const person = id === null ? null : db.prepare('SELECT id, name FROM people WHERE id = ?').get(id);
    if (!person) return { status: 404, json: { error: 'Person not found' } };
    const rows = db.prepare('SELECT * FROM blockouts WHERE person_id = ? ORDER BY start_date, end_date, id').all(id);
    return { status: 200, json: { blockouts: rows.map((r) => ({ ...shape(r), personName: person.name })) } };
  }, { auth: 'admin' });

  router.add('GET', '/api/blockouts', ({ query }) => {
    const { from, to } = query;
    if (from !== undefined && !isRealDate(from)) return bad('From must be a real date like 2025-11-08');
    if (to !== undefined && !isRealDate(to)) return bad('To must be a real date like 2025-11-08');
    const where = [];
    const args = [];
    if (from !== undefined) { where.push('b.end_date >= ?'); args.push(from); }
    if (to !== undefined) { where.push('b.start_date <= ?'); args.push(to); }
    const rows = db.prepare(
      `SELECT b.*, p.name AS person_name FROM blockouts b JOIN people p ON p.id = b.person_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY b.start_date, b.end_date, b.id`,
    ).all(...args);
    return { status: 200, json: { blockouts: rows.map((r) => ({ ...shape(r), personName: r.person_name })) } };
  }, { auth: 'admin' });
}
