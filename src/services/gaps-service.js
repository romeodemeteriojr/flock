// Gaps: open and unanswered positions that still need someone, suggestions of
// who could fill a slot, and draft reminder messages (nothing is ever sent).
// Application service: all business rules for this area live here. It never
// sees HTTP objects and never runs SQL; it talks to the data layer through
// `deps.data` and throws AppErrors (src/errors.js). Built once by
// src/container.js.
import { ValidationError, NotFoundError, ConflictError } from '../errors.js';
import { isValidDate, addDays, daysBetween, todayStr } from '../dates.js';
import { MAX_POSITIONS_PER_SERVICE } from './assignments-service.js';

/** How far ahead the gaps list looks by default, in days (4 weeks). */
export const DEFAULT_GAP_DAYS = 28;
/** The longest gaps range, in days. */
export const MAX_GAP_DAYS = 366;
/** A pending slot on a service this many days away (or fewer) counts as unanswered. */
export const SOON_DAYS = 7;
/** Default for config.unansweredDays. */
export const DEFAULT_UNANSWERED_DAYS = 3;
/** Suggestions look back this many days ("the last 8 weeks") ... */
export const LOOKBACK_DAYS = 56;
/** ... and ahead this many days ("the next 4 weeks"). */
export const LOOKAHEAD_DAYS = 28;
/** Reminders cover this many days starting at weekOf. */
export const REMINDER_DAYS = 7;

export const GAP_TYPES = Object.freeze(['open', 'declined', 'unanswered', 'blocked', 'inactive']);
const HOLDING = ['pending', 'accepted'];
const DATE_ERR = 'must be a real date like 2026-03-01.';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const isInt = (v) => Number.isSafeInteger(v);
const absent = (v) => v === undefined || v === null || v === '';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const byName = (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' });

/** 'Sun 8 Nov' for '2026-11-08'. */
export function shortDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[wd]} ${d} ${MONTHS[m - 1]}`;
}

/** 'a', 'a and b', 'a, b and c'. */
function joinList(parts) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const firstName = (name) => String(name).trim().split(/\s+/)[0] || String(name);

function blockoutIndex(blockouts) {
  const by = new Map();
  for (const b of blockouts) {
    if (!by.has(b.personId)) by.set(b.personId, []);
    by.get(b.personId).push(b);
  }
  return (personId, date) => (by.get(personId) ?? []).some((b) => b.startDate <= date && date <= b.endDate);
}

function lastServedReason(lastServed, today) {
  if (!lastServed) return 'Has never served';
  const days = daysBetween(lastServed, today);
  if (days < 7) return days === 1 ? 'Last served yesterday' : `Last served ${plural(days, 'day')} ago`;
  return `Last served ${plural(Math.floor(days / 7), 'week')} ago`;
}

/**
 * @param {object} deps  Injected by src/container.js (nothing is imported or global).
 * @param {import("../data/index.js").Data} deps.data  The data layer.
 * @param {{now: () => Date}} deps.clock
 * @param {{unansweredDays?: number}} [deps.config]  Validated settings (src/config.js).
 * @param {object} deps.notifications  The notifications service (Send reminders, decision 0008).
 * @returns {object}
 */
export function createGapsService(deps) {
  const { data, clock, notifications } = deps;
  const today = () => todayStr(clock.now());
  const unansweredDays = () => {
    const n = deps.config?.unansweredDays;
    return isInt(n) && n >= 0 ? n : DEFAULT_UNANSWERED_DAYS;
  };

  function dateOr(value, fallback, label) {
    const s = absent(value) ? fallback : value;
    if (!isValidDate(s)) throw new ValidationError(`${label} ${DATE_ERR}`);
    return s;
  }

  // The type of gap a slot is, or null when it is fine.
  function gapType(slot, { now, people, isBlocked, limit }) {
    if (slot.personId === null || slot.status === 'open') return 'open';
    if (slot.status === 'declined') return 'declined';
    if (!HOLDING.includes(slot.status)) return null;
    const person = people.get(slot.personId);
    if (person && !person.active) return 'inactive';
    if (isBlocked(slot.personId, slot.serviceDate)) return 'blocked';
    if (slot.status === 'pending') {
      const soon = daysBetween(now, slot.serviceDate) <= SOON_DAYS;
      const assignedDay = slot.assignedAt ? todayStr(new Date(slot.assignedAt)) : null;
      const old = assignedDay !== null && isValidDate(assignedDay) && daysBetween(assignedDay, now) > limit;
      if (soon || old) return 'unanswered';
    }
    return null;
  }

  return {
    /**
     * Slots that still need attention in an inclusive date range (default:
     * today to 4 weeks ahead, at most 366 days). Each slot appears once, as
     * the first type that applies: open, declined, inactive, blocked, unanswered.
     * Sorted per service (date, then time), then team and position, so the
     * page can group them by service.
     */
    async gaps({ from, to } = {}) {
      const now = today();
      const start = dateOr(from, now, 'From');
      const end = dateOr(to, addDays(start, DEFAULT_GAP_DAYS), 'To');
      if (end < start) throw new ValidationError('The end date must not be before the start date.');
      if (daysBetween(start, end) > MAX_GAP_DAYS) throw new ValidationError(`The date range can be at most ${MAX_GAP_DAYS} days`);
      return data.tx(async (d) => {
        const slots = await d.slots.listForServices(start, end);
        const people = new Map((await d.people.list()).map((p) => [p.id, p]));
        const isBlocked = blockoutIndex(await d.blockouts.listRange(start, end));
        const ctx = { now, people, isBlocked, limit: unansweredDays() };
        const summary = Object.fromEntries(GAP_TYPES.map((t) => [t, 0]));
        const found = [];
        for (const s of slots) {
          const type = gapType(s, ctx);
          if (!type) continue;
          summary[type] += 1;
          const item = {
            type,
            slotId: s.id,
            serviceId: s.serviceId,
            date: s.serviceDate,
            time: s.serviceTime,
            serviceTitle: s.serviceTitle,
            positionName: s.positionName,
            teamName: s.teamName,
          };
          if (type !== 'open') {
            item.personId = s.personId;
            item.personName = s.personName;
          }
          found.push({ item, s });
        }
        found.sort((a, b) => (a.s.serviceDate < b.s.serviceDate ? -1 : a.s.serviceDate > b.s.serviceDate ? 1 : 0)
          || (a.s.serviceTime < b.s.serviceTime ? -1 : a.s.serviceTime > b.s.serviceTime ? 1 : 0)
          || a.s.teamSort - b.s.teamSort
          || byName(a.s.teamName, b.s.teamName)
          || a.s.positionSort - b.s.positionSort
          || a.s.id - b.s.id);
        return { summary, items: found.map((f) => f.item) };
      });
    },

    /**
     * Who could fill a slot: active people qualified for its position (or
     * everyone active with includeUnqualified, marked qualified:false), not
     * blocked out that date, not the person in this slot or who declined it,
     * and not someone who already holds this position or the most positions
     * (MAX_POSITIONS_PER_SERVICE) on that service. Someone already serving
     * there in another position is listed with alsoOn (their positions) and a
     * reason. Ranked by not serving there first, then fewest services (not
     * slots) in the last 8 weeks plus the next 4 weeks, then longest since last
     * served (never first), then name.
     */
    async suggest({ slotId, includeUnqualified = false } = {}) {
      if (!isInt(slotId)) throw new ValidationError('Slot id must be a whole number.');
      if (typeof includeUnqualified !== 'boolean') throw new ValidationError('Include unqualified must be true or false.');
      const now = today();
      const backFrom = addDays(now, -LOOKBACK_DAYS);
      const aheadTo = addDays(now, LOOKAHEAD_DAYS);
      return data.tx(async (d) => {
        const slot = await d.slots.findById(slotId);
        if (!slot) throw new NotFoundError('Slot not found.');
        // Who already holds other slots of this service (decision 0010): they may
        // take this one too, up to the limit, but never a second slot of the same position.
        const onService = new Map(); // personId -> their other slots here
        for (const s of await d.slots.listForService(slot.serviceId)) {
          if (s.id === slot.id || s.personId === null || !HOLDING.includes(s.status)) continue;
          onService.set(s.personId, [...(onService.get(s.personId) ?? []), s]);
        }
        const leaveOut = new Set();
        if (slot.personId !== null) leaveOut.add(slot.personId); // in it now, or said no to it
        for (const [id, mine] of onService) {
          if (mine.length >= MAX_POSITIONS_PER_SERVICE || mine.some((s) => s.positionId === slot.positionId)) leaveOut.add(id);
        }
        const blocked = await d.blockouts.blockedPersonIds(slot.serviceDate);

        // Counted per service, not per slot: two positions on one morning is serving once.
        const history = new Map();
        const counted = new Set();
        for (const s of await d.slots.assignedBetween('0001-01-01', aheadTo)) {
          if (!HOLDING.includes(s.status)) continue;
          if (counted.has(`${s.serviceId}:${s.personId}`)) continue;
          counted.add(`${s.serviceId}:${s.personId}`);
          if (!history.has(s.personId)) history.set(s.personId, { load: 0, past8: 0, lastServed: null });
          const h = history.get(s.personId);
          if (s.serviceDate >= backFrom && s.serviceDate <= aheadTo) h.load += 1;
          if (s.serviceDate < now) {
            if (s.serviceDate >= backFrom) h.past8 += 1;
            if (h.lastServed === null || s.serviceDate > h.lastServed) h.lastServed = s.serviceDate;
          }
        }

        const candidates = [];
        for (const p of await d.people.list()) {
          if (!p.active || blocked.has(p.id) || leaveOut.has(p.id)) continue;
          const qualified = p.positionIds.includes(slot.positionId);
          if (!qualified && !includeUnqualified) continue;
          const h = history.get(p.id) ?? { load: 0, past8: 0, lastServed: null };
          const upcoming = h.load - h.past8;
          const alsoOn = (onService.get(p.id) ?? []).map((s) => s.positionName);
          const reasons = [];
          if (alsoOn.length) reasons.push(`Already serving as ${joinList(alsoOn)} at this service`);
          if (!qualified) reasons.push(`Not set up for ${slot.positionName}`);
          // "Has never served" says it all; "not in 8 weeks" as well would repeat it.
          if (h.lastServed || h.past8) reasons.push(h.past8 === 0 ? 'Has not served in 8 weeks' : `Served ${plural(h.past8, 'time')} in the last 8 weeks`);
          reasons.push(lastServedReason(h.lastServed, now));
          reasons.push(upcoming === 0 ? 'Nothing scheduled in the next 4 weeks' : `Scheduled ${plural(upcoming, 'time')} in the next 4 weeks`);
          candidates.push({
            personId: p.id,
            name: p.name,
            reasons,
            servedLast8Weeks: h.past8,
            lastServed: h.lastServed,
            qualified,
            alsoOn,
            _load: h.load,
          });
        }
        // People not yet serving at this service come first, so a fresh pair of hands is the best match.
        candidates.sort((a, b) => a.alsoOn.length - b.alsoOn.length
          || a._load - b._load
          || (a.lastServed === b.lastServed ? 0 : a.lastServed === null ? -1 : b.lastServed === null ? 1 : a.lastServed < b.lastServed ? -1 : 1)
          || byName(a.name, b.name)
          || a.personId - b.personId);
        return { candidates: candidates.map(({ _load, ...c }) => c) };
      });
    },

    /**
     * Draft reminders: one plain-text message per active person with pending or
     * accepted slots in the 7 days starting weekOf (default today). Sorted by
     * name. hasPush: they have notifications on, so Send reminders reaches them.
     */
    reminders: (input) => drafts(input),

    /**
     * Send the week's reminders as notifications to everyone who has them on
     * (not the scheduler sending them). Waits for the push services.
     * @returns {Promise<{weekOf: string, sent: number[], copy: number[]}>}  copy: everyone not reached
     */
    async sendReminders(actor, { weekOf } = {}) {
      if (!notifications.settings().enabled) {
        throw new ConflictError('Notifications are not set up on this Flock yet.', { code: 'push_off' });
      }
      const start = dateOr(weekOf, today(), 'Week of');
      const list = await drafts({ weekOf: start });
      const byId = new Map(list.map((r) => [r.personId, r]));
      const targets = list.filter((r) => r.hasPush && r.personId !== actor?.id).map((r) => r.personId);
      const endOfWeek = Date.parse(`${addDays(start, REMINDER_DAYS)}T00:00:00`);
      const ttl = Math.max(3600, Math.floor((endOfWeek - clock.now().getTime()) / 1000));
      const reached = await notifications.sendTo('reminder', targets,
        (id) => notifications.message(byId.get(id).message), { ttl });
      const sent = list.map((r) => r.personId).filter((id) => reached.get(id) === true);
      const copy = list.map((r) => r.personId).filter((id) => !sent.includes(id));
      await data.audit.log({ at: clock.now(), actorId: actor?.id ?? null, action: 'reminders.send',
        detail: `week of ${start}: sent ${sent.length}, ${copy.length} to copy` });
      return { weekOf: start, sent, copy };
    },
  };

  // The reminder drafts (see reminders above).
  async function drafts({ weekOf } = {}) {
    const start = dateOr(weekOf, today(), 'Week of');
    const end = addDays(start, REMINDER_DAYS - 1);
    const pushOn = notifications.settings().enabled;
    return data.tx(async (d) => {
      const withDevices = pushOn ? await d.pushDevices.personIds() : new Set();
      const people = new Map((await d.people.list()).map((p) => [p.id, p]));
      const byPerson = new Map();
      for (const s of await d.slots.listForServices(start, end)) {
        if (s.personId === null || !HOLDING.includes(s.status)) continue;
        const person = people.get(s.personId);
        if (!person || !person.active) continue;
        if (!byPerson.has(person.id)) byPerson.set(person.id, { person, slots: [] });
        byPerson.get(person.id).slots.push(s);
      }
      const out = [];
      for (const { person, slots } of byPerson.values()) {
        // One part per service: "Sound and Vocals on Sun 8 Nov at 10:00" (decision 0010).
        const byService = new Map();
        for (const s of slots) byService.set(s.serviceId, [...(byService.get(s.serviceId) ?? []), s]);
        const parts = [...byService.values()].map((g) => `${joinList(g.map((s) => s.positionName))} on ${shortDate(g[0].serviceDate)} at ${g[0].serviceTime}`);
        const pending = slots.filter((s) => s.status === 'pending').length;
        let ask;
        if (pending === 0) ask = 'We are glad you can make it.';
        else if (pending === slots.length) ask = 'Please open Flock and accept or decline.';
        else ask = 'Please open Flock and accept or decline the ones you have not answered yet.';
        const message = `Hi ${firstName(person.name)}, a reminder that you are serving as ${joinList(parts)}. ${ask} Thank you!`;
        out.push({
          personId: person.id,
          name: person.name,
          message,
          hasPush: withDevices.has(person.id),
          items: slots.map((s) => ({
            slotId: s.id,
            serviceId: s.serviceId,
            date: s.serviceDate,
            time: s.serviceTime,
            serviceTitle: s.serviceTitle,
            positionName: s.positionName,
            teamName: s.teamName,
            status: s.status,
          })),
        });
      }
      out.sort((a, b) => byName(a.name, b.name) || a.personId - b.personId);
      return out;
    });
  }
}
