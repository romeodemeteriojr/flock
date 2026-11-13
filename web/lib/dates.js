// Pure date helpers for screens. Dates are 'YYYY-MM-DD', times 'HH:MM'.
// Parsed by parts and counted in UTC day numbers, so time zones never shift a day.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function parts(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = new Date(Date.UTC(2000, mo - 1, d));
  t.setUTCFullYear(y);
  if (mo < 1 || mo > 12 || t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return { y, mo, d, ms: t.getTime(), dow: t.getUTCDay() };
}

export function isDate(date) { return parts(date) !== null; }

// '2026-11-08' -> 'Sun 8 Nov'. Anything unreadable comes back unchanged.
export function formatDate(date) {
  const p = parts(date);
  return p ? `${DAYS[p.dow]} ${p.d} ${MONTHS[p.mo - 1]}` : String(date ?? '');
}

export function weekday(date) {
  const p = parts(date);
  return p ? LONG_DAYS[p.dow] : '';
}

// Same day -> one date; otherwise 'Sun 8 Nov to Tue 10 Nov'.
export function formatRange(a, b) {
  if (!b || a === b) return formatDate(a);
  return `${formatDate(a)} to ${formatDate(b)}`;
}

// '09:00' -> '9:00 am', '00:30' -> '12:30 am', '12:00' -> '12:00 pm', '13:05' -> '1:05 pm'.
export function formatTime(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? ''));
  if (!m) return String(time ?? '');
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'am' : 'pm'}`;
}

// Whole days from today to date (negative if past). NaN if unreadable.
export function daysUntil(date, today) {
  const a = parts(date), b = parts(today);
  if (!a || !b) return NaN;
  return Math.round((a.ms - b.ms) / 86400000);
}

// 'Today', 'Tomorrow', 'This Sunday' (2-6 days), 'Next Sunday' (7), else 'Sun 22 Nov'.
export function relativeDay(date, today) {
  const n = daysUntil(date, today);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n >= 2 && n <= 6) return `This ${weekday(date)}`;
  if (n === 7) return `Next ${weekday(date)}`;
  return formatDate(date);
}

// ---------- the days-off calendar: months, weeks starting Monday ----------

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (y, mo, d) => `${String(y).padStart(4, '0')}-${pad2(mo)}-${pad2(d)}`;

/** { year, month } (month 1..12) n months after the given one (n may be negative). */
export function addMonths(year, month, n) {
  const i = year * 12 + (month - 1) + n;
  return { year: Math.floor(i / 12), month: (i % 12 + 12) % 12 + 1 };
}

/** 'November 2026'. */
export function monthLabel(year, month) {
  return `${LONG_MONTHS[month - 1] ?? ''} ${year}`;
}

/**
 * One month as a calendar page whose weeks start on Monday: how many empty
 * cells come before the 1st, and every day of the month as 'YYYY-MM-DD'.
 */
export function monthGrid(year, month) {
  const first = parts(ymd(year, month, 1));
  if (!first) return { blanks: 0, days: [] };
  const next = addMonths(year, month, 1);
  const length = Math.round((parts(ymd(next.year, next.month, 1)).ms - first.ms) / 86400000);
  return {
    blanks: (first.dow + 6) % 7,
    days: Array.from({ length }, (_, i) => ymd(year, month, i + 1)),
  };
}

/** Days from `from` to `to`, both counted: the same day is 1. */
export function daysBetween(from, to) {
  return daysUntil(to, from) + 1;
}

/** The date n days after `date` (n may be negative), or '' if unreadable. */
export function shiftDate(date, n) {
  const p = parts(date);
  if (!p) return '';
  const t = new Date(p.ms + n * 86400000);
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** 'Saturday 21 November', for screen readers. */
export function longDate(date) {
  const p = parts(date);
  return p ? `${LONG_DAYS[p.dow]} ${p.d} ${LONG_MONTHS[p.mo - 1]}` : String(date ?? '');
}

// Today's date in the browser's own calendar, as 'YYYY-MM-DD'.
export function todayString(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(now.getFullYear(), 4)}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
