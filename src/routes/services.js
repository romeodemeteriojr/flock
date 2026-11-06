import { tx, logAudit } from '../db.js';
import { isValidDate, isValidTime, addDays, daysBetween, todayStr } from '../dates.js';

const bad = (error, status = 400) => ({ status, json: { error } });
const ok = (json, status = 200) => ({ status, json });
const isInt = (v) => Number.isSafeInteger(v);
const toId = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);
const DATE_ERR = 'Date must be a real date like 2026-03-01';
const TIME_ERR = 'Time must look like 09:00';
const TITLE_ERR = 'Title must be 1 to 100 characters';
const COUNT_ERR = 'Count must be a whole number from 1 to 20';

function cleanTitle(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length >= 1 && s.length <= 100 ? s : null;
}

export function register(router, ctx) {
  const db = ctx.db;
  const audit = (user, action, detail) => logAudit(db, ctx.now(), user.id, action, detail);
  const getService = (id) => (id === null ? undefined : db.prepare('SELECT id, date, time, title FROM services WHERE id = ?').get(id));
  // Prepared lazily: some tests build the app on a database with no tables.
  const posExists = { get: (id) => db.prepare('SELECT 1 FROM positions WHERE id = ?').get(id) };
  const insSlot = { run: (...a) => db.prepare('INSERT INTO slots (service_id, position_id) VALUES (?, ?)').run(...a) };
  const findAt = { get: (...a) => db.prepare('SELECT id FROM services WHERE date = ? AND time = ?').get(...a) };
  const insService = { run: (...a) => db.prepare('INSERT INTO services (date, time, title) VALUES (?, ?, ?)').run(...a) };

  const slotRows = (where, ...args) => db.prepare(
    `SELECT s.id, s.service_id, s.position_id, s.status, s.person_id, p.name AS position_name,
            t.id AS team_id, t.name AS team_name, pe.name AS person_name
     FROM slots s JOIN positions p ON p.id = s.position_id JOIN teams t ON t.id = p.team_id
     LEFT JOIN people pe ON pe.id = s.person_id
     WHERE ${where}
     ORDER BY t.sort, p.sort, s.id`,
  ).all(...args);
  const slotJson = (r) => ({
    id: r.id, positionId: r.position_id, positionName: r.position_name, teamId: r.team_id,
    teamName: r.team_name, status: r.status, personId: r.person_id, personName: r.person_name,
  });
  const serviceJson = (s) => ({
    id: s.id, date: s.date, time: s.time, title: s.title,
    slots: slotRows('s.service_id = ?', s.id).map(slotJson),
  });

  // Returns {error} or {list: [{positionId, count}]}
  function parseSlots(v) {
    if (v === undefined) return { list: [] };
    if (!Array.isArray(v)) return { error: 'Slots must be a list' };
    const list = [];
    for (const item of v) {
      if (!item || typeof item !== 'object') return { error: 'Each slot needs a positionId' };
      const count = item.count === undefined ? 1 : item.count;
      if (!isInt(count) || count < 1 || count > 20) return { error: COUNT_ERR };
      if (!isInt(item.positionId) || !posExists.get(item.positionId)) return { error: 'One or more positions do not exist' };
      list.push({ positionId: item.positionId, count });
    }
    return { list };
  }

  router.add('POST', '/api/services', ({ body, user }) => {
    const date = body?.date;
    if (!isValidDate(date)) return bad(DATE_ERR);
    const time = body?.time === undefined ? '09:00' : body.time;
    if (!isValidTime(time)) return bad(TIME_ERR);
    const title = body?.title === undefined ? 'Sunday service' : cleanTitle(body.title);
    if (!title) return bad(TITLE_ERR);
    const parsed = parseSlots(body?.slots);
    if (parsed.error) return bad(parsed.error);
    if (findAt.get(date, time)) return bad('A service already exists at that date and time', 409);
    const id = tx(db, () => {
      const sid = Number(insService.run(date, time, title).lastInsertRowid);
      for (const { positionId, count } of parsed.list) for (let i = 0; i < count; i++) insSlot.run(sid, positionId);
      audit(user, 'service.create', `service ${sid} ${date} ${time} "${title}"`);
      return sid;
    });
    return ok(serviceJson(getService(id)), 201);
  }, { auth: 'admin' });

  router.add('POST', '/api/services/repeat', ({ body, user }) => {
    const src = getService(isInt(body?.fromServiceId) ? body.fromServiceId : null);
    if (!src) return bad('Service not found', 404);
    const weeks = body?.weeks;
    if (!isInt(weeks) || weeks < 1 || weeks > 26) return bad('Weeks must be a whole number from 1 to 26');
    const positions = db.prepare('SELECT position_id FROM slots WHERE service_id = ? ORDER BY id').all(src.id).map((r) => r.position_id);
    const created = [];
    const skipped = [];
    tx(db, () => {
      for (let w = 1; w <= weeks; w++) {
        const date = addDays(src.date, 7 * w);
        if (findAt.get(date, src.time)) { skipped.push(date); continue; }
        const sid = Number(insService.run(date, src.time, src.title).lastInsertRowid);
        for (const p of positions) insSlot.run(sid, p);
        created.push(sid);
      }
      audit(user, 'service.repeat', `service ${src.id} for ${weeks} weeks: ${created.length} created, ${skipped.length} skipped`);
    });
    return ok({ created: created.map((id) => serviceJson(getService(id))), skipped }, 201);
  }, { auth: 'admin' });

  router.add('GET', '/api/services', ({ query }) => {
    const today = todayStr(ctx.now());
    const from = query.from === undefined ? today : query.from;
    if (!isValidDate(from)) return bad(DATE_ERR);
    const to = query.to === undefined ? addDays(from, 56) : query.to;
    if (!isValidDate(to)) return bad(DATE_ERR);
    if (to < from) return bad('The end date must not be before the start date');
    if (daysBetween(from, to) > 366) return bad('The date range can be at most 366 days');
    const services = db.prepare(
      'SELECT id, date, time, title FROM services WHERE date >= ? AND date <= ? ORDER BY date, time, id',
    ).all(from, to);
    const slots = slotRows('s.service_id IN (SELECT id FROM services WHERE date >= ? AND date <= ?)', from, to);
    const by = new Map();
    for (const r of slots) {
      if (!by.has(r.service_id)) by.set(r.service_id, []);
      by.get(r.service_id).push(slotJson(r));
    }
    return ok(services.map((s) => ({ id: s.id, date: s.date, time: s.time, title: s.title, slots: by.get(s.id) ?? [] })));
  }, { auth: 'admin' });

  router.add('PATCH', '/api/services/:id', ({ params, body, user }) => {
    const svc = getService(toId(params.id));
    if (!svc) return bad('Service not found', 404);
    let { date, time, title } = svc;
    if (body?.date !== undefined) { if (!isValidDate(body.date)) return bad(DATE_ERR); date = body.date; }
    if (body?.time !== undefined) { if (!isValidTime(body.time)) return bad(TIME_ERR); time = body.time; }
    if (body?.title !== undefined) { title = cleanTitle(body.title); if (!title) return bad(TITLE_ERR); }
    const clash = findAt.get(date, time);
    if (clash && clash.id !== svc.id) return bad('A service already exists at that date and time', 409);
    db.prepare('UPDATE services SET date = ?, time = ?, title = ? WHERE id = ?').run(date, time, title, svc.id);
    audit(user, 'service.update', `service ${svc.id} ${date} ${time} "${title}"`);
    return ok(serviceJson(getService(svc.id)));
  }, { auth: 'admin' });

  router.add('DELETE', '/api/services/:id', ({ params, query, user }) => {
    const svc = getService(toId(params.id));
    if (!svc) return bad('Service not found', 404);
    const count = db.prepare('SELECT COUNT(*) AS n FROM slots WHERE service_id = ? AND person_id IS NOT NULL').get(svc.id).n;
    if (count > 0 && query.confirm !== '1') {
      return { status: 409, json: { error: `${count} people are scheduled on this date`, code: 'has_people', count } };
    }
    tx(db, () => {
      db.prepare('DELETE FROM slots WHERE service_id = ?').run(svc.id);
      db.prepare('DELETE FROM services WHERE id = ?').run(svc.id);
      audit(user, 'service.delete', `service ${svc.id} ${svc.date} ${svc.time} "${svc.title}" (${count} people scheduled)`);
    });
    return ok({ ok: true });
  }, { auth: 'admin' });

  router.add('POST', '/api/services/:id/slots', ({ params, body, user }) => {
    const svc = getService(toId(params.id));
    if (!svc) return bad('Service not found', 404);
    const count = body?.count === undefined ? 1 : body.count;
    if (!isInt(count) || count < 1 || count > 20) return bad(COUNT_ERR);
    if (!isInt(body?.positionId) || !posExists.get(body.positionId)) return bad('That position does not exist');
    const ids = tx(db, () => {
      const out = [];
      for (let i = 0; i < count; i++) out.push(Number(insSlot.run(svc.id, body.positionId).lastInsertRowid));
      audit(user, 'slot.create', `service ${svc.id} position ${body.positionId} x${count}`);
      return out;
    });
    const rows = slotRows(`s.id IN (${ids.map(() => '?').join(',')})`, ...ids);
    return ok(rows.map(slotJson), 201);
  }, { auth: 'admin' });

  router.add('DELETE', '/api/slots/:id', ({ params, query, user }) => {
    const id = toId(params.id);
    const slot = id === null ? undefined : db.prepare('SELECT id, service_id, position_id, person_id FROM slots WHERE id = ?').get(id);
    if (!slot) return bad('Slot not found', 404);
    if (slot.person_id !== null && query.confirm !== '1') {
      return { status: 409, json: { error: 'Someone is scheduled in this slot', code: 'has_person' } };
    }
    db.prepare('DELETE FROM slots WHERE id = ?').run(slot.id);
    audit(user, 'slot.delete', `slot ${slot.id} service ${slot.service_id} position ${slot.position_id} person ${slot.person_id ?? 'none'}`);
    return ok({ ok: true });
  }, { auth: 'admin' });
}
