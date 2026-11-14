// Availability: how often a volunteer is willing to serve.
// Application service: all business rules for this area live here. It never
// sees HTTP objects and never runs SQL; it talks to the data layer through
// `deps.data` and throws AppErrors (src/errors.js). Built once by
// src/container.js.
import { ValidationError } from '../errors.js';

/** Allowed values: 0 = paused, else "at most once every N weeks". */
export const EVERY_WEEKS_CHOICES = Object.freeze([0, 1, 2, 3, 4, 6, 8]);
/** Used for anyone who has not chosen yet. */
export const DEFAULT_EVERY_WEEKS = 2;
export const EVERY_WEEKS_ERR = 'How often must be one of 0, 1, 2, 3, 4, 6 or 8 weeks.';

/** The JSON shape: { everyWeeks, isDefault, updatedAt }. */
export function availabilityView(row) {
  return row
    ? { everyWeeks: row.everyWeeks, isDefault: false, updatedAt: row.updatedAt }
    : { everyWeeks: DEFAULT_EVERY_WEEKS, isDefault: true, updatedAt: null };
}

/**
 * @param {object} deps  Injected by src/container.js (nothing is imported or global).
 * @param {import("../data/index.js").Data} deps.data  The data layer.
 * @param {{now: () => Date}} deps.clock
 * @returns {object}
 */
export function createAvailabilityService(deps) {
  const { data, clock } = deps;
  return {
    /** The person's own choice, or the default when they never chose. */
    async getMine(personId) {
      return availabilityView(await data.availability.get(personId));
    },

    /** Save the person's own choice. everyWeeks must be one of EVERY_WEEKS_CHOICES. */
    async setMine(personId, { everyWeeks } = {}) {
      if (!EVERY_WEEKS_CHOICES.includes(everyWeeks)) throw new ValidationError(EVERY_WEEKS_ERR);
      return availabilityView(await data.availability.set(personId, { everyWeeks, updatedAt: clock.now().toISOString() }));
    },
  };
}
