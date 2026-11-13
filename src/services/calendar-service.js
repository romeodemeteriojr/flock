// Calendar: service dates and their open positions (slots).
// Application service: all business rules for this area live here. It never
// sees HTTP objects and never runs SQL; it talks to the data layer through
// `deps.data` and throws AppErrors (src/errors.js). Built once by
// src/container.js.
import { ValidationError, ConflictError, NotFoundError } from '../errors.js';
import { isValidDate, isValidTime, addDays, daysBetween, todayStr } from '../dates.js';
import { takenOff } from './taken-off.js';

export const DATE_ERR = 'Date must be a real date like 2026-03-01';
export const TIME_ERR = 'Time must look like 09:00';
export const TITLE_ERR = 'Title must be 1 to 100 characters';
export const COUNT_ERR = 'Count must be a whole number from 1 to 20';
export const WEEKS_ERR = 'Weeks must be a whole number from 1 to 26';
const CLASH = 'A service already exists at that date and time';
export const PAST_LOCKED = "Past services can't be changed";
export const PAST_DATE = "A service can't be set in the past";
export const DEFAULT_TIME = '09:00';
export const DEFAULT_TITLE = 'Sunday service';
export const MAX_COUNT = 20;
export const MAX_WEEKS = 26;
export const DEFAULT_RANGE_DAYS = 56;
export const MAX_RANGE_DAYS = 366;

const isInt = (v) => Number.isSafeInteger(v);
const holds = (s) => s.personId !== null && (s.status === 'pending' || s.status === 'accepted');
// Which slots go first when a count is lowered: open, then declined; newest first.
const emptyFirst = (a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || b.id - a.id;

function cleanTitle(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length >= 1 && s.length <= 100 ? s : null;
}

/** The JSON shape of a slot (the same as before the refactor). */
export function slotView(s) {
  return {
    id: s.id,
    positionId: s.positionId,
    positionName: s.positionName,
    teamId: s.teamId,
    teamName: s.teamName,
    status: s.status,
    personId: s.personId,
    personName: s.personName,
  };
}

const serviceView = (svc, slots) => ({ id: svc.id, date: svc.date, time: svc.time, title: svc.title, slots: slots.map(slotView) });

/**
 * @param {object} deps  Injected by src/container.js (nothing is imported or global).
 * @param {import("../data/index.js").Data} deps.data  The data layer.
 * @param {{now: () => Date}} deps.clock
 * @param {object} [deps.logger]
 * @returns {object}
 */
export function createCalendarService(deps) {
  const { data, clock, notifications } = deps;
  const audit = (d, actor, action, detail) => d.audit.log({ at: clock.now(), actorId: actor?.id ?? null, action, detail });
  const today = () => todayStr(clock.now());

  // Past services (dated before today) are history: nothing on them changes.
  function mustBeUpcoming(svc) {
    if (svc.date < today()) throw new ConflictError(PAST_LOCKED, { code: 'past' });
  }
  function notPastDate(date) {
    if (date < today()) throw new ValidationError(PAST_DATE);
  }

  async function loadService(d, id) {
    const svc = isInt(id) ? await d.services.findById(id) : null;
    if (!svc) throw new NotFoundError('Service not found');
    return svc;
  }

  async function view(d, svc) {
    return serviceView(svc, await d.slots.listForService(svc.id));
  }

  // Checks a list of {positionId, count?}; returns [{positionId, count}].
  async function checkSlotList(d, list) {
    if (list === undefined) return [];
    if (!Array.isArray(list)) throw new ValidationError('Slots must be a list');
    const out = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') throw new ValidationError('Each slot needs a positionId');
      const count = item.count === undefined ? 1 : item.count;
      if (!isInt(count) || count < 1 || count > MAX_COUNT) throw new ValidationError(COUNT_ERR);
      if (!isInt(item.positionId) || !(await d.positions.findById(item.positionId))) {
        throw new ValidationError('One or more positions do not exist');
      }
      if (out.some((o) => o.positionId === item.positionId)) throw new ValidationError('Each position can be listed only once');
      out.push({ positionId: item.positionId, count });
    }
    return out;
  }

  // Make a service's slots match `list` (the full wanted state). Raising a count
  // adds open slots. Lowering one removes open, then declined slots; when
  // people hold all the rest it stops (code spots_filled): the admin picks who
  // comes off on the Schedule page. A position left out loses every slot; when
  // someone holds one, `confirm` is needed (code has_people).
  // Returns {added, removed, held} (held: removed slots someone held).
  async function reshape(d, svc, list, confirm) {
    const want = new Map(list.map((x) => [x.positionId, x.count]));
    const have = new Map();
    for (const s of await d.slots.listForService(svc.id)) {
      if (!have.has(s.positionId)) have.set(s.positionId, []);
      have.get(s.positionId).push(s);
    }
    const drop = [];
    for (const [positionId, slots] of have) {
      const n = want.get(positionId) ?? 0;
      if (slots.length <= n) continue;
      if (n === 0) { drop.push(...slots); continue; }
      const empty = slots.filter((s) => !holds(s)).sort(emptyFirst);
      const excess = slots.length - n;
      if (empty.length < excess) {
        const taken = slots.length - empty.length;
        throw new ConflictError(
          `${taken} ${taken === 1 ? 'person is' : 'people are'} on ${slots[0].positionName}. `
          + `Take someone off on the Schedule page first to go down to ${n}.`,
          { code: 'spots_filled' },
        );
      }
      drop.push(...empty.slice(0, excess));
    }
    const held = drop.filter(holds);
    if (held.length && !confirm) {
      const { count: n, people } = takenOff(held);
      throw new ConflictError(`${n} ${n === 1 ? 'person' : 'people'} will be taken off`, {
        code: 'has_people', details: { count: n, people },
      });
    }
    for (const s of drop) await d.slots.remove(s.id);
    const add = [];
    for (const { positionId, count } of list) {
      const extra = count - (have.get(positionId)?.length ?? 0);
      for (let i = 0; i < extra; i++) add.push(positionId);
    }
    if (add.length) await d.slots.createMany(svc.id, add);
    return { added: add.length, removed: drop.length, held };
  }

  const expand = (list) => list.flatMap(({ positionId, count }) => Array(count).fill(positionId));

  return {
    /**
     * Create a service date with its slots.
     * @param {{id: number}} actor
     * @param {{date: string, time?: string, title?: string, slots?: {positionId: number, count?: number}[]}} input
     */
    async createService(actor, input = {}) {
      const b = input && typeof input === 'object' ? input : {};
      const { date } = b;
      if (!isValidDate(date)) throw new ValidationError(DATE_ERR);
      const time = b.time === undefined ? DEFAULT_TIME : b.time;
      if (!isValidTime(time)) throw new ValidationError(TIME_ERR);
      const title = b.title === undefined ? DEFAULT_TITLE : cleanTitle(b.title);
      if (!title) throw new ValidationError(TITLE_ERR);
      notPastDate(date);
      return data.tx(async (d) => {
        const list = await checkSlotList(d, b.slots);
        if (await d.services.findByDateTime(date, time)) throw new ConflictError(CLASH);
        const svc = await d.services.create({ date, time, title });
        const positions = expand(list);
        if (positions.length) await d.slots.createMany(svc.id, positions);
        await audit(d, actor, 'service.create', `service ${svc.id} ${date} ${time} "${title}"`);
        return view(d, svc);
      });
    },

    /**
     * Copy a service (date + 7 days each week, same time, title and positions) for N weeks.
     * Dates that already have a service at that time, or are in the past, are
     * skipped. Deleted positions are not copied (skippedPositions: their names).
     * @returns {Promise<{created: object[], skipped: string[], skippedPositions: string[]}>}
     */
    async repeat(actor, { fromServiceId, weeks } = {}) {
      return data.tx(async (d) => {
        const src = await loadService(d, fromServiceId);
        if (!isInt(weeks) || weeks < 1 || weeks > MAX_WEEKS) throw new ValidationError(WEEKS_ERR);
        const srcSlots = (await d.slots.listForService(src.id)).sort((a, b) => a.id - b.id);
        const active = new Map();
        for (const s of srcSlots) {
          if (!active.has(s.positionId)) active.set(s.positionId, !!(await d.positions.findById(s.positionId)));
        }
        const positions = srcSlots.filter((s) => active.get(s.positionId)).map((s) => s.positionId);
        const skippedPositions = [...new Set(srcSlots.filter((s) => !active.get(s.positionId)).map((s) => s.positionName))];
        const created = [];
        const skipped = [];
        for (let w = 1; w <= weeks; w++) {
          const date = addDays(src.date, 7 * w);
          if (date < today() || await d.services.findByDateTime(date, src.time)) { skipped.push(date); continue; }
          const svc = await d.services.create({ date, time: src.time, title: src.title });
          if (positions.length) await d.slots.createMany(svc.id, positions);
          created.push(svc);
        }
        await audit(d, actor, 'service.repeat',
          `service ${src.id} for ${weeks} weeks: ${created.length} created, ${skipped.length} skipped`);
        const out = [];
        for (const svc of created) out.push(await view(d, svc));
        return { created: out, skipped, skippedPositions };
      });
    },

    /**
     * Services in an inclusive date range with their slots. `from` defaults to
     * today (from the clock), `to` to 56 days after `from`; at most 366 days.
     */
    async listServices(from, to) {
      const start = from === undefined ? todayStr(clock.now()) : from;
      if (!isValidDate(start)) throw new ValidationError(DATE_ERR);
      const end = to === undefined ? addDays(start, DEFAULT_RANGE_DAYS) : to;
      if (!isValidDate(end)) throw new ValidationError(DATE_ERR);
      if (end < start) throw new ValidationError('The end date must not be before the start date');
      if (daysBetween(start, end) > MAX_RANGE_DAYS) throw new ValidationError('The date range can be at most 366 days');
      return data.tx(async (d) => {
        const services = await d.services.listRange(start, end);
        const slots = await d.slots.listForServices(start, end);
        const by = new Map();
        for (const s of slots) {
          if (!by.has(s.serviceId)) by.set(s.serviceId, []);
          by.get(s.serviceId).push(s);
        }
        return services.map((svc) => serviceView(svc, by.get(svc.id) ?? []));
      });
    },

    /** One service with its slots. */
    async getService(id) {
      return view(data, await loadService(data, id));
    },

    /**
     * Change date, time, title and/or positions. `slots` ([{positionId, count}])
     * is the full wanted list; left out, positions stay as they are. Past
     * services cannot change (code past) and none can move into the past.
     * People taken off need `confirm` (code has_people) and are told; people
     * who stay are told when the date or time moved.
     */
    async updateService(actor, id, patch = {}, { confirm = false } = {}) {
      const p = patch && typeof patch === 'object' ? patch : {};
      let change;
      const result = await data.tx(async (d) => {
        const svc = await loadService(d, id);
        mustBeUpcoming(svc);
        let { date, time, title } = svc;
        if (p.date !== undefined) { if (!isValidDate(p.date)) throw new ValidationError(DATE_ERR); date = p.date; }
        if (p.time !== undefined) { if (!isValidTime(p.time)) throw new ValidationError(TIME_ERR); time = p.time; }
        if (p.title !== undefined) { title = cleanTitle(p.title); if (!title) throw new ValidationError(TITLE_ERR); }
        notPastDate(date);
        const list = p.slots === undefined ? null : await checkSlotList(d, p.slots);
        const clash = await d.services.findByDateTime(date, time);
        if (clash && clash.id !== svc.id) throw new ConflictError(CLASH);
        const shaped = list ? await reshape(d, svc, list, confirm) : { added: 0, removed: 0, held: [] };
        const updated = await d.services.update(svc.id, { date, time, title });
        const slotNote = list ? ` slots +${shaped.added} -${shaped.removed} (${takenOff(shaped.held).count} people taken off)` : '';
        await audit(d, actor, 'service.update', `service ${svc.id} ${date} ${time} "${title}"${slotNote}`);
        change = { before: svc, after: updated, slots: await d.slots.listForService(svc.id), held: shaped.held };
        return view(d, updated);
      });
      if (change.held.length) notifications.removed(actor, change.held);
      notifications.moved(actor, change.before, change.after, change.slots);
      return result;
    },

    /**
     * Delete a service and its slots. When people are scheduled, `confirm`
     * must be true, otherwise ConflictError code has_people (details.count).
     */
    async deleteService(actor, id, { confirm = false } = {}) {
      let gone;
      const result = await data.tx(async (d) => {
        const svc = await loadService(d, id);
        mustBeUpcoming(svc);
        const count = await d.services.assignedCount(svc.id);
        if (count > 0 && !confirm) {
          throw new ConflictError(`${count === 1 ? '1 person is' : `${count} people are`} scheduled on this date`, { code: 'has_people', details: { count } });
        }
        gone = { svc, slots: await d.slots.listForService(svc.id) };
        await d.services.remove(svc.id);
        await audit(d, actor, 'service.delete',
          `service ${svc.id} ${svc.date} ${svc.time} "${svc.title}" (${count} people scheduled)`);
        return { ok: true };
      });
      notifications.cancelled(actor, gone.svc, gone.slots);
      return result;
    },

    /** Add `count` (1-20, default 1) open slots for a position. Returns the new slots. */
    async addSlots(actor, serviceId, { positionId, count: rawCount } = {}) {
      return data.tx(async (d) => {
        const svc = await loadService(d, serviceId);
        mustBeUpcoming(svc);
        const count = rawCount === undefined ? 1 : rawCount;
        if (!isInt(count) || count < 1 || count > MAX_COUNT) throw new ValidationError(COUNT_ERR);
        if (!isInt(positionId) || !(await d.positions.findById(positionId))) {
          throw new ValidationError('That position does not exist');
        }
        const slots = await d.slots.createMany(svc.id, Array(count).fill(positionId));
        await audit(d, actor, 'slot.create', `service ${svc.id} position ${positionId} x${count}`);
        return slots.map(slotView);
      });
    },

    /**
     * Remove a slot. When someone is in it, `confirm` must be true, otherwise
     * ConflictError code has_person.
     */
    async removeSlot(actor, slotId, { confirm = false } = {}) {
      let removed;
      const result = await data.tx(async (d) => {
        const slot = isInt(slotId) ? await d.slots.findById(slotId) : null;
        if (!slot) throw new NotFoundError('Slot not found');
        mustBeUpcoming({ date: slot.serviceDate });
        if (holds(slot) && !confirm) {
          throw new ConflictError('Someone is scheduled in this slot', { code: 'has_person' });
        }
        removed = slot;
        await d.slots.remove(slot.id);
        await audit(d, actor, 'slot.delete',
          `slot ${slot.id} service ${slot.serviceId} position ${slot.positionId} person ${slot.personId ?? 'none'}`);
        return { ok: true };
      });
      notifications.removed(actor, removed);
      return result;
    },
  };
}
