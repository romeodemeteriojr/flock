// Blockouts: dates a volunteer cannot serve.
// Application service: all business rules for this area live here. It never
// sees HTTP objects and never runs SQL; it talks to the data layer through
// `deps.data` and throws AppErrors (src/errors.js). Built once by
// src/container.js.
import { ValidationError, NotFoundError, ConflictError } from '../errors.js';
import { isValidDate, daysBetween, todayStr } from '../dates.js';

export const MAX_BLOCKOUT_DAYS = 366;
export const MAX_REASON = 200;

/** The JSON shape of a blockout (the same as before the refactor; no createdAt). */
export const blockoutView = (b) => ({ id: b.id, personId: b.personId, startDate: b.startDate, endDate: b.endDate, reason: b.reason });

// The JSON shape of a conflicting slot (the same as before the refactor).
const conflictView = (c) => ({
  slotId: c.slotId,
  date: c.date,
  time: c.time,
  serviceTitle: c.serviceTitle,
  positionName: c.positionName,
  teamName: c.teamName,
  status: c.status,
});

const isInt = (v) => Number.isSafeInteger(v);

/**
 * @param {object} deps  Injected by src/container.js (nothing is imported or global).
 * @param {import("../data/index.js").Data} deps.data  The data layer.
 * @param {{now: () => Date}} deps.clock
 * @returns {object}
 */
export function createBlockoutsService(deps) {
  const { data, clock } = deps;
  const today = () => todayStr(clock.now());

  /** The person's pending/accepted slots on services in the inclusive range. */
  async function conflictsFor(personId, startDate, endDate) {
    return (await data.blockouts.conflictingSlots(personId, startDate, endDate)).map(conflictView);
  }

  return {
    conflictsFor,

    /** True when one of the person's blockouts covers the date. */
    isBlocked(personId, date) {
      return data.blockouts.coversDate(personId, date);
    },

    /** Set of ids of people with a blockout covering the date. */
    blockedPersonIds(date) {
      return data.blockouts.blockedPersonIds(date);
    },

    /** The person's blockouts that end today or later. */
    async listMine(personId) {
      return (await data.blockouts.listForPerson(personId, today())).map(blockoutView);
    },

    /**
     * Add a blockout for the person. endDate defaults to startDate. It may not
     * end before today, may be at most 366 days, the reason at most 200 characters.
     * @returns {Promise<{blockout: object, conflicts: object[]}>}
     */
    async add(personId, input = {}) {
      const b = input && typeof input === 'object' ? input : {};
      const { startDate } = b;
      const endDate = b.endDate === undefined || b.endDate === null || b.endDate === '' ? startDate : b.endDate;
      if (!isValidDate(startDate)) throw new ValidationError('Start date must be a real date like 2025-11-08.');
      if (!isValidDate(endDate)) throw new ValidationError('End date must be a real date like 2025-11-08.');
      if (endDate < startDate) throw new ValidationError('End date cannot be before the start date.');
      if (endDate < today()) throw new ValidationError('That time is already past.');
      if (daysBetween(startDate, endDate) + 1 > MAX_BLOCKOUT_DAYS) throw new ValidationError('A blockout can be at most 366 days.');
      let reason = b.reason ?? '';
      if (typeof reason !== 'string') throw new ValidationError('Reason must be text.');
      reason = reason.trim();
      if (reason.length > MAX_REASON) throw new ValidationError('Reason can be at most 200 characters.');
      return data.tx(async (d) => {
        // The same days sent twice (two devices at once, a double tap): keep one.
        const same = (await d.blockouts.listForPerson(personId, null)).some((x) => x.startDate === startDate && x.endDate === endDate && x.reason === reason);
        if (same) throw new ConflictError('You already have those days off.');
        const created = await d.blockouts.create({ personId, startDate, endDate, reason, createdAt: clock.now().toISOString() });
        const conflicts = (await d.blockouts.conflictingSlots(personId, startDate, endDate)).map(conflictView);
        return { blockout: blockoutView(created), conflicts };
      });
    },

    /** Remove one of the person's own blockouts. */
    async removeOwn(personId, blockoutId) {
      const ok = isInt(blockoutId) && await data.blockouts.remove(blockoutId, personId);
      if (!ok) throw new NotFoundError('Blockout not found.');
      return { ok: true };
    },

    /** Admin: every blockout of one person, with their name. */
    async listForPerson(personId) {
      const person = isInt(personId) ? await data.people.findById(personId) : null;
      if (!person) throw new NotFoundError('Person not found.');
      const list = await data.blockouts.listForPerson(person.id);
      return list.map((b) => ({ ...blockoutView(b), personName: person.name }));
    },

    /** Admin: blockouts overlapping an optional inclusive range, with names. */
    async listRange(from, to) {
      if (from !== undefined && !isValidDate(from)) throw new ValidationError('From must be a real date like 2025-11-08.');
      if (to !== undefined && !isValidDate(to)) throw new ValidationError('To must be a real date like 2025-11-08.');
      const list = await data.blockouts.listRange(from ?? null, to ?? null);
      return list.map((b) => ({ ...blockoutView(b), personName: b.personName }));
    },
  };
}
