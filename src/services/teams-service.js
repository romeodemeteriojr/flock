// Teams and positions.
// Application service: all business rules for this area live here. It never
// sees HTTP objects and never runs SQL; it talks to the data layer through
// `deps.data` and throws AppErrors (src/errors.js). Built once by
// src/container.js.
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { v, parse } from '../validate.js';

export const TEAM_DUP = 'A team with that name already exists';
export const TEAM_IN_USE = 'Remove or reassign its positions first';
export const POS_DUP = 'That team already has a position with that name';
export const POS_IN_USE = 'This position is used by a service slot, so it cannot be deleted';

const isDup = (e) => e?.name === 'DuplicateError';
const isInUse = (e) => e?.name === 'InUseError';

// Data-layer DuplicateError / InUseError -> ConflictError with the old plain message.
async function translating(fn, { dup, inUse } = {}) {
  try {
    return await fn();
  } catch (e) {
    if (dup && isDup(e)) throw new ConflictError(dup);
    if (inUse && isInUse(e)) throw new ConflictError(inUse);
    throw e;
  }
}

export const NAME_ERR = 'Name must be 1 to 60 characters';
export const SORT_ERR = 'Sort must be a whole number';
export const IDS_ERR = 'positionIds must be a list of position ids';
const TEAM_MISSING = 'That team does not exist';

const nameSchema = v.string({ max: 60, pattern: /^[\s\S]+$/ });
const intSchema = v.integer();
const idList = v.array(v.integer());

// Check one raw value with a schema; any problem becomes one plain message.
// The service checks raw input itself (instead of the route) so the checks run
// in the same order as always: not found (404), then name, duplicate, sort.
function check(schema, value, message) {
  try {
    return parse(schema, value);
  } catch (e) {
    if (e instanceof ValidationError) throw new ValidationError(message);
    throw e;
  }
}

const teamJson = (t) => ({ id: t.id, name: t.name, sort: t.sort });
const posJson = (p) => ({ id: p.id, teamId: p.teamId, name: p.name, sort: p.sort });

/**
 * @param {object} deps  Injected by src/container.js (nothing is imported or global).
 * @param {import("../data/index.js").Data} deps.data  The data layer.
 * @param {{now: () => Date}} deps.clock
 * @param {object} [deps.logger]  Structured logger (never log secrets).
 * @returns {object}
 */
export function createTeamsService(deps) {
  const { data, clock } = deps;
  const audit = (d, actor, action, detail) => d.audit.log({ at: clock.now(), actorId: actor?.id ?? null, action, detail });

  async function mustTeam(d, id) {
    const team = Number.isSafeInteger(id) ? await d.teams.findById(id) : null;
    if (!team) throw new NotFoundError('Team not found');
    return team;
  }

  async function mustPosition(d, id) {
    const pos = Number.isSafeInteger(id) ? await d.positions.findById(id) : null;
    if (!pos) throw new NotFoundError('Position not found');
    return pos;
  }

  return {
    /**
     * Every team with its positions. Admins also see who is qualified (active people only).
     * @param {{role: string}} viewer
     */
    async list(viewer) {
      const admin = viewer?.role === 'admin';
      const teams = await data.teams.list();
      const quals = admin ? await data.qualifications.mapByPosition() : null;
      return teams.map((t) => ({
        id: t.id,
        name: t.name,
        positions: t.positions.map((p) => {
          const o = { id: p.id, name: p.name };
          if (admin) o.qualifiedPersonIds = quals.get(p.id) ?? [];
          return o;
        }),
      }));
    },

    /** @param {{name: unknown}} input  Raw input; checked here. */
    async createTeam(actor, input = {}) {
      const name = check(nameSchema, input.name, NAME_ERR);
      return data.tx(async (d) => {
        const team = await translating(() => d.teams.create({ name }), { dup: TEAM_DUP });
        await audit(d, actor, 'team.create', `team ${team.id} "${team.name}"`);
        return teamJson(team);
      });
    },

    /**
     * Rename and/or re-sort. Raw input; the order of checks is: unknown team (404),
     * bad name (400), taken name (409), bad sort (400). Any failure changes nothing.
     * @param {{name?: unknown, sort?: unknown}} input
     */
    async updateTeam(actor, id, input = {}) {
      return data.tx(async (d) => {
        let team = await mustTeam(d, id);
        if (input.name !== undefined) {
          const name = check(nameSchema, input.name, NAME_ERR);
          team = await translating(() => d.teams.update(id, { name }), { dup: TEAM_DUP });
        }
        if (input.sort !== undefined) {
          const sort = check(intSchema, input.sort, SORT_ERR); // throwing here rolls the rename back
          team = await d.teams.update(id, { sort });
        }
        await audit(d, actor, 'team.update', `team ${team.id} "${team.name}" sort ${team.sort}`);
        return teamJson(team);
      });
    },

    async deleteTeam(actor, id) {
      return data.tx(async (d) => {
        const team = await mustTeam(d, id);
        await translating(() => d.teams.remove(id), { inUse: TEAM_IN_USE });
        await audit(d, actor, 'team.delete', `team ${team.id} "${team.name}"`);
        return { ok: true };
      });
    },

    /** Raw input; checks: unknown team (404), bad name (400), taken name (409). */
    async createPosition(actor, teamId, input = {}) {
      return data.tx(async (d) => {
        const team = await mustTeam(d, teamId);
        const name = check(nameSchema, input.name, NAME_ERR);
        const pos = await translating(() => d.positions.create(team.id, { name }), { dup: POS_DUP });
        await audit(d, actor, 'position.create', `position ${pos.id} "${pos.name}" in team ${team.id}`);
        return posJson(pos);
      });
    },

    /**
     * Raw input; checks: unknown position (404), bad name, bad sort, bad or unknown
     * team (400), taken name in the (new) team (409).
     * @param {{name?: unknown, sort?: unknown, teamId?: unknown}} input
     */
    async updatePosition(actor, id, input = {}) {
      return data.tx(async (d) => {
        await mustPosition(d, id);
        const patch = {};
        if (input.name !== undefined) patch.name = check(nameSchema, input.name, NAME_ERR);
        if (input.sort !== undefined) patch.sort = check(intSchema, input.sort, SORT_ERR);
        if (input.teamId !== undefined) {
          patch.teamId = check(intSchema, input.teamId, TEAM_MISSING);
          if (!(await d.teams.findById(patch.teamId))) throw new ValidationError(TEAM_MISSING);
        }
        const pos = await translating(() => d.positions.update(id, patch), { dup: POS_DUP });
        await audit(d, actor, 'position.update', `position ${pos.id} "${pos.name}" team ${pos.teamId} sort ${pos.sort}`);
        return posJson(pos);
      });
    },

    async deletePosition(actor, id) {
      return data.tx(async (d) => {
        const pos = await mustPosition(d, id);
        await translating(() => d.positions.remove(id), { inUse: POS_IN_USE });
        await audit(d, actor, 'position.delete', `position ${pos.id} "${pos.name}"`);
        return { ok: true };
      });
    },

    /**
     * Replace a person's qualifications. Returns the unique ids, ascending.
     * Raw input; checks: unknown person (404), not a list of ids (400), unknown position (400).
     */
    async setQualifications(actor, personId, rawIds) {
      return data.tx(async (d) => {
        const person = Number.isSafeInteger(personId) ? await d.people.findById(personId) : null;
        if (!person) throw new NotFoundError('Person not found');
        const positionIds = check(idList, rawIds, IDS_ERR);
        const unique = [...new Set(positionIds)];
        for (const id of unique) {
          if (!(await d.positions.findById(id))) throw new ValidationError('One or more positions do not exist');
        }
        const saved = await d.qualifications.setForPerson(person.id, unique);
        await audit(d, actor, 'person.positions', `person ${person.id} positions [${unique.join(',')}]`);
        return saved;
      });
    },

    /** Active people qualified for a position: [{id, name}]. */
    async listPeopleForPosition(positionId) {
      const pos = await mustPosition(data, positionId);
      return data.qualifications.listPeople(pos.id);
    },

    /** The positions a person is qualified for, in team order: [{id, name, teamId, teamName}]. */
    async myPositions(personId) {
      const ids = new Set(await data.qualifications.listPositionIds(personId));
      if (!ids.size) return [];
      const out = [];
      for (const t of await data.teams.list()) {
        for (const p of t.positions) {
          if (ids.has(p.id)) out.push({ id: p.id, name: p.name, teamId: t.id, teamName: t.name });
        }
      }
      return out;
    },
  };
}
