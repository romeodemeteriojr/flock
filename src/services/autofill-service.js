// Auto-fill: put volunteers into the open slots of one or more weeks, fairly.
// Application service: all business rules for this area live here. It never
// sees HTTP objects and never runs SQL; it talks to the data layer through
// `deps.data` and throws AppErrors (src/errors.js). Built once by
// src/container.js. The plan itself is the pure function planAutofill.
import { ValidationError } from '../errors.js';
import { isValidDate, addDays, daysBetween, todayStr, mondayOf } from '../dates.js';
import { DEFAULT_EVERY_WEEKS } from './availability-service.js';

/** The most weeks one run may fill. */
export const MAX_AUTOFILL_WEEKS = 8;
/** Fairness looks back this many days before the first week. */
export const FAIRNESS_LOOKBACK_DAYS = 56;
/** Spacing looks this far after the last week (the longest choice, 8 weeks, minus one). */
const SPACING_AHEAD_DAYS = 49;
const HOLDING = ['pending', 'accepted'];

const isInt = (v) => Number.isSafeInteger(v);

/** Whole weeks between the Monday-to-Sunday weeks of two dates (0 = same week). */
export function weeksApart(a, b) {
  return Math.abs(daysBetween(mondayOf(a), mondayOf(b))) / 7;
}

/** FNV-1a: a stable 32-bit number for a text. Used only to break ties without favouring names. */
export function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const slotOrder = (a, b) => cmp(a.serviceDate, b.serviceDate) || cmp(a.serviceTime, b.serviceTime)
  || a.teamSort - b.teamSort || a.positionSort - b.positionSort || a.id - b.id;

const slotInfo = (s) => ({
  slotId: s.id,
  serviceId: s.serviceId,
  date: s.serviceDate,
  time: s.serviceTime,
  serviceTitle: s.serviceTitle,
  teamName: s.teamName,
  positionName: s.positionName,
});

/**
 * Pure: decide who goes where. Nothing is read or written here.
 * It never puts anyone on a service they are already on, or said no to: holding
 * several positions on one service is the scheduler's own choice (decision 0010).
 * @param {object} input
 * @param {string} input.today  YYYY-MM-DD; slots before it are left alone
 * @param {string} input.start  the Monday of the first week
 * @param {number} input.weeks  1 to 8
 * @param {object[]} input.slots  data.slots.listForServices(start, end)
 * @param {object[]} input.history  data.slots.assignedBetween(start - 56 days, end + 49 days)
 * @param {object[]} input.people  data.people.list()
 * @param {Map<number, number>} input.availability  data.availability.mapAll()
 * @param {object[]} input.blockouts  data.blockouts.listRange(start, end)
 * @returns {{assigned: object[], unfilled: object[]}}  both in slot order
 */
export function planAutofill({ today, start, weeks, slots, history, people, availability, blockouts }) {
  const end = addDays(start, 7 * weeks - 1);
  const countFrom = addDays(start, -FAIRNESS_LOOKBACK_DAYS);
  const everyOf = (id) => (availability.has(id) ? availability.get(id) : DEFAULT_EVERY_WEEKS);
  const isBlocked = (id, date) => blockouts.some((b) => b.personId === id && b.startDate <= date && date <= b.endDate);

  const held = new Map(); // personId -> dates of pending/accepted slots (existing and planned)
  const onService = new Set(); // `${serviceId}:${personId}`: already on it, or said no to it
  const counted = new Set(); // one held date per service, however many positions (decision 0010)
  for (const s of history) {
    onService.add(`${s.serviceId}:${s.personId}`);
    if (!HOLDING.includes(s.status)) continue;
    if (counted.has(`${s.serviceId}:${s.personId}`)) continue;
    counted.add(`${s.serviceId}:${s.personId}`);
    if (!held.has(s.personId)) held.set(s.personId, []);
    held.get(s.personId).push(s.serviceDate);
  }
  const active = people.filter((p) => p.active);

  function candidates(slot) {
    const qualified = active.filter((p) => p.positionIds.includes(slot.positionId));
    const free = qualified.filter((p) => {
      const n = everyOf(p.id);
      if (n === 0) return false;
      if (isBlocked(p.id, slot.serviceDate)) return false;
      if (onService.has(`${slot.serviceId}:${p.id}`)) return false;
      return (held.get(p.id) ?? []).every((d) => weeksApart(d, slot.serviceDate) >= n);
    });
    return { qualified, free };
  }

  function rank(p, slot) {
    const dates = held.get(p.id) ?? [];
    const count = dates.filter((d) => d >= countFrom && d <= end).length;
    const before = dates.filter((d) => d < slot.serviceDate).sort();
    return {
      load: count * everyOf(p.id),
      last: before.length ? before[before.length - 1] : null,
      tie: hash32(`${mondayOf(slot.serviceDate)}|${p.id}`),
      id: p.id,
    };
  }
  const better = (a, b) => a.load - b.load
    || (a.last === b.last ? 0 : a.last === null ? -1 : b.last === null ? 1 : cmp(a.last, b.last))
    || a.tie - b.tie
    || a.id - b.id;

  const todo = slots.filter((s) => s.personId === null && s.status === 'open' && s.serviceDate >= today);
  const byWeek = new Map();
  for (const s of todo) {
    const w = mondayOf(s.serviceDate);
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(s);
  }

  const assigned = [];
  const unfilled = [];
  for (const week of [...byWeek.keys()].sort()) {
    const remaining = byWeek.get(week);
    while (remaining.length) {
      // Most constrained slot first, so scarce people go where only they fit.
      let pick = null;
      for (const s of remaining) {
        const c = candidates(s);
        if (!pick || c.free.length < pick.c.free.length || (c.free.length === pick.c.free.length && slotOrder(s, pick.s) < 0)) {
          pick = { s, c };
        }
      }
      remaining.splice(remaining.indexOf(pick.s), 1);
      const { s, c } = pick;
      if (!c.free.length) {
        unfilled.push(c.qualified.length
          ? { ...slotInfo(s), reason: 'nobody_free', message: `Everyone set up for ${s.positionName} is away, paused, already serving that week or served too recently` }
          : { ...slotInfo(s), reason: 'nobody_qualified', message: `Nobody is set up for ${s.positionName}` });
        continue;
      }
      const best = c.free.map((p) => ({ p, r: rank(p, s) })).sort((a, b) => better(a.r, b.r))[0].p;
      assigned.push({ ...slotInfo(s), personId: best.id, personName: best.name, everyWeeks: everyOf(best.id) });
      if (!held.has(best.id)) held.set(best.id, []);
      held.get(best.id).push(s.serviceDate);
      onService.add(`${s.serviceId}:${best.id}`);
    }
  }
  const order = new Map(todo.map((s) => [s.id, s]));
  const bySlot = (a, b) => slotOrder(order.get(a.slotId), order.get(b.slotId));
  return { assigned: assigned.sort(bySlot), unfilled: unfilled.sort(bySlot) };
}

/**
 * @param {object} deps  Injected by src/container.js (nothing is imported or global).
 * @param {import("../data/index.js").Data} deps.data  The data layer.
 * @param {{now: () => Date}} deps.clock
 * @param {{assign: Function}} deps.assignments  The assignments service (re-checks every rule on apply).
 * @returns {object}
 */
export function createAutofillService(deps) {
  const { data, clock, assignments, notifications } = deps;
  const today = () => todayStr(clock.now());

  return {
    /**
     * Plan (and with apply: true, make) assignments for the open slots of
     * `weeks` weeks (1-8, default 1) starting the Monday of `weekOf` (default:
     * next week). Planning and applying run in one transaction, so the
     * preview and the result match when nothing changed in between.
     * @param {{id: number}} actor
     * @param {{weekOf?: string, weeks?: number, apply?: boolean}} input
     */
    async run(actor, { weekOf, weeks = 1, apply = false } = {}) {
      const now = today();
      const day = weekOf === undefined ? addDays(now, 7) : weekOf;
      if (!isValidDate(day)) throw new ValidationError('Week of must be a real date like 2026-03-02');
      if (!isInt(weeks) || weeks < 1 || weeks > MAX_AUTOFILL_WEEKS) {
        throw new ValidationError(`Weeks must be a whole number from 1 to ${MAX_AUTOFILL_WEEKS}`);
      }
      if (typeof apply !== 'boolean') throw new ValidationError('Apply must be true or false');
      const start = mondayOf(day);
      const end = addDays(start, 7 * weeks - 1);
      if (end < now) throw new ValidationError('Those weeks are already over');
      const result = await data.tx(async (d) => {
        const plan = planAutofill({
          today: now,
          start,
          weeks,
          slots: await d.slots.listForServices(start, end),
          history: await d.slots.assignedBetween(addDays(start, -FAIRNESS_LOOKBACK_DAYS), addDays(end, SPACING_AHEAD_DAYS)),
          people: await d.people.list(),
          availability: await d.availability.mapAll(),
          blockouts: await d.blockouts.listRange(start, end),
        });
        if (apply && plan.assigned.length) {
          for (const a of plan.assigned) await assignments.assign(actor, a.slotId, { personId: a.personId }, { notify: false });
          await d.audit.log({
            at: clock.now(),
            actorId: actor?.id ?? null,
            action: 'schedule.autofill',
            detail: `${start} for ${weeks} week(s): ${plan.assigned.length} assigned, ${plan.unfilled.length} left open`,
          });
        }
        return { applied: apply, weekOf: start, weeks, ...plan };
      });
      // "Ask these people": one notification per person for the whole batch (decision 0008).
      if (apply && result.assigned.length) notifications.asked(actor, result.assigned.map((a) => a.personId));
      return result;
    },
  };
}
