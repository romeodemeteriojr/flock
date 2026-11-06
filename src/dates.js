// Pure date helpers. Dates are 'YYYY-MM-DD', times 'HH:MM'; no timezones.
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 86400000;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parse(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return null;
  const t = new Date(Date.UTC(2000, mo - 1, d));
  t.setUTCFullYear(y);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return t.getTime();
}

function fmt(ms) {
  const t = new Date(ms);
  const p = (n, w) => String(n).padStart(w, '0');
  return `${p(t.getUTCFullYear(), 4)}-${p(t.getUTCMonth() + 1, 2)}-${p(t.getUTCDate(), 2)}`;
}

function need(s) {
  const ms = parse(s);
  if (ms === null) throw new Error(`Invalid date: ${s}`);
  return ms;
}

export function isValidDate(s) { return parse(s) !== null; }
export function isValidTime(s) { return typeof s === 'string' && TIME_RE.test(s); }

export function addDays(dateStr, n) {
  if (!Number.isInteger(n)) throw new Error('n must be a whole number');
  return fmt(need(dateStr) + n * DAY_MS);
}

// Whole days from a to b (positive when b is later).
export function daysBetween(a, b) { return Math.round((need(b) - need(a)) / DAY_MS); }

// Local calendar date of a Date.
export function todayStr(now) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(now.getFullYear(), 4)}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function weekdayName(dateStr) { return DAYS[new Date(need(dateStr)).getUTCDay()]; }

export function compareDates(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
