// Blockout helpers (pure db functions) and small date validation.

export function isRealDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function todayStr(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export function isBlocked(db, personId, dateStr) {
  return !!db.prepare(
    'SELECT 1 FROM blockouts WHERE person_id = ? AND start_date <= ? AND end_date >= ? LIMIT 1',
  ).get(personId, dateStr, dateStr);
}

export function blockedPersonIds(db, dateStr) {
  const rows = db.prepare('SELECT DISTINCT person_id FROM blockouts WHERE start_date <= ? AND end_date >= ?')
    .all(dateStr, dateStr);
  return new Set(rows.map((r) => r.person_id));
}

export function conflictsFor(db, personId, startDate, endDate) {
  return db.prepare(
    `SELECT s.id AS slotId, sv.date AS date, sv.time AS time, sv.title AS serviceTitle,
            p.name AS positionName, t.name AS teamName, s.status AS status
       FROM slots s
       JOIN services sv ON sv.id = s.service_id
       JOIN positions p ON p.id = s.position_id
       JOIN teams t ON t.id = p.team_id
      WHERE s.person_id = ? AND s.status IN ('pending','accepted')
        AND sv.date >= ? AND sv.date <= ?
      ORDER BY sv.date, sv.time, s.id`,
  ).all(personId, startDate, endDate).map((r) => ({ ...r }));
}
