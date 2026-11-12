// Calendar: service dates and their open positions (slots).
// Application service: all business rules for this area live here. It never
// sees HTTP objects and never runs SQL; it talks to the data layer through
// `deps.data` and throws AppErrors (src/errors.js). Built once by
// src/container.js.
import { ValidationError, ConflictError, NotFoundError } from '../errors.js';
import { isValidDate, isValidTime, addDays, daysBetween, todayStr } from '../dates.js';

export const DATE_ERR = 'Date must be a real date like 2026-03-01';
export const TIME_ERR = 'Time must look like 09:00';
export const TITLE_ERR = 'Title must be 1 to 100 characters';
export const COUNT_ERR = 'Count must be a whole number from 1 to 20';
export const WEEKS_ERR = 'Weeks must be a whole number from 1 to 26';
const CLASH = 'A service already exists at that date and time';
export const DEFAULT_TIME = '09:00';
export const DEFAULT_TITLE = 'Sunday service';
export const MAX_COUNT = 20;
export const MAX_WEEKS = 26;
export const DEFAULT_RANGE_DAYS = 56;
export const MAX_RANGE_DAYS = 366;

const isInt = (v) => Number.isSafeInteger(v);

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
      out.push({ positionId: item.positionId, count });
    }
    return out;
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
     * Dates that already have a service at that time are skipped.
     * @returns {Promise<{created: object[], skipped: string[]}>}
     */
    async repeat(actor, { fromServiceId, weeks } = {}) {
      return data.tx(async (d) => {
        const src = await loadService(d, fromServiceId);
        if (!isInt(weeks) || weeks < 1 || weeks > MAX_WEEKS) throw new ValidationError(WEEKS_ERR);
        const positions = (await d.slots.listForService(src.id))
          .sort((a, b) => a.id - b.id)
          .map((s) => s.positionId);
        const created = [];
        const skipped = [];
        for (let w = 1; w <= weeks; w++) {
          const date = addDays(src.date, 7 * w);
          if (await d.services.findByDateTime(date, src.time)) { skipped.push(date); continue; }
          const svc = await d.services.create({ date, time: src.time, title: src.title });
          if (positions.length) await d.slots.createMany(svc.id, positions);
          created.push(svc);
        }
        await audit(d, actor, 'service.repeat',
          `service ${src.id} for ${weeks} weeks: ${created.length} created, ${skipped.length} skipped`);
        const out = [];
        for (const svc of created) out.push(await view(d, svc));
        return { created: out, skipped };
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

    /** Change date, time and/or title. */
    async updateService(actor, id, patch = {}) {
      const p = patch && typeof patch === 'object' ? patch : {};
      let change;
      const result = await data.tx(async (d) => {
        const svc = await loadService(d, id);
        let { date, time, title } = svc;
        if (p.date !== undefined) { if (!isValidDate(p.date)) throw new ValidationError(DATE_ERR); date = p.date; }
        if (p.time !== undefined) { if (!isValidTime(p.time)) throw new ValidationError(TIME_ERR); time = p.time; }
        if (p.title !== undefined) { title = cleanTitle(p.title); if (!title) throw new ValidationError(TITLE_ERR); }
        const clash = await d.services.findByDateTime(date, time);
        if (clash && clash.id !== svc.id) throw new ConflictError(CLASH);
        const updated = await d.services.update(svc.id, { date, time, title });
        await audit(d, actor, 'service.update', `service ${svc.id} ${date} ${time} "${title}"`);
        change = { before: svc, after: updated, slots: await d.slots.listForService(svc.id) };
        return view(d, updated);
      });
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
        const count = await d.services.assignedCount(svc.id);
        if (count > 0 && !confirm) {
          throw new ConflictError(`${count} people are scheduled on this date`, { code: 'has_people', details: { count } });
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
        if (slot.personId !== null && !confirm) {
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
