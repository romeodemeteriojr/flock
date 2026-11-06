// People: add, edit, reset password, deactivate, access level, qualifications.
// Application service: all business rules for this area live here. It never
// sees HTTP objects and never runs SQL; it talks to the data layer through
// `deps.data` and throws AppErrors (src/errors.js). Built once by
// src/container.js; a later card fills in the methods.

/**
 * @param {object} deps  Injected by src/container.js (nothing is imported or global).
 * @param {import("../data/index.js").Data} deps.data  The data layer.
 * @param {{now: () => Date}} deps.clock
 * @param {{bytes: Function, int: Function, token: Function}} deps.random
 * @param {{hash: Function, verify: Function}} deps.hasher
 * @param {object} deps.logger  Structured logger (never log secrets).
 * @param {object} deps.config  Validated settings (src/config.js).
 * @param {object} deps.auth  The auth service (passwords, sessions).
 * @returns {object}
 */
export function createPeopleService(deps) {
  return {};
}
