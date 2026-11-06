// Clocks. Code that needs "now" takes a clock so tests can control time.

function toDate(x) {
  const d = x instanceof Date ? new Date(x.getTime()) : new Date(x);
  if (Number.isNaN(d.getTime())) throw new TypeError(`Not a valid time: ${String(x)}`);
  return d;
}

export function systemClock() {
  return { now: () => new Date() };
}

export function fixedClock(isoOrDate = '2026-01-01T12:00:00.000Z') {
  let ms = toDate(isoOrDate).getTime();
  const clock = {
    now: () => new Date(ms),
    advance(byMs) {
      const n = Number(byMs);
      if (!Number.isFinite(n)) throw new TypeError('advance needs a number of milliseconds');
      ms += n;
      return clock;
    },
    set(to) {
      ms = toDate(to).getTime();
      return clock;
    },
  };
  return clock;
}
