// Assignments: putting people in slots, accept / decline.
// Application service: all business rules for this area live here. It never
// sees HTTP objects and never runs SQL; it talks to the data layer through
// `deps.data` and throws AppErrors (src/errors.js). Built once by
// src/container.js.
import { ValidationError, ConflictError, NotFoundError } from '../errors.js';
import { isValidDate, addDays, todayStr } from '../dates.js';

/** How far ahead "my schedule" looks, in days (12 weeks). */
export const SCHEDULE_DAYS = 84;
/** Statuses that mean "this person holds the slot". */
const HOLDING = ['pending', 'accepted'];

const isInt = (v) => Number.isSafeInteger(v);

/** The JSON shape of a slot after an assignment change (admin view). */
export function assignmentView(s) {
  return {
    id: s.id,
    serviceId: s.serviceId,
    date: s.serviceDate,
    time: s.serviceTime,
    serviceTitle: s.serviceTitle,
    positionId: s.positionId,
    positionName: s.positionName,
    teamId: s.teamId,
    teamName: s.teamName,
    status: s.status,
    personId: s.personId,
    personName: s.personName,
    assignedAt: s.assignedAt,
    respondedAt: s.respondedAt,
  };
}

/** The JSON shape of a slot as its own volunteer sees it after responding. */
const mySlotView = (s) => ({
  slotId: s.id,
  date: s.serviceDate,
  time: s.serviceTime,
  serviceTitle: s.serviceTitle,
  positionName: s.positionName,
  teamName: s.teamName,
  status: s.status,
  respondedAt: s.respondedAt,
});

/**
 * @param {object} deps  Injected by src/container.js (nothing is imported or global).
 * @param {import("../data/index.js").Data} deps.data  The data layer.
 * @param {{now: () => Date}} deps.clock
 * @param {{isBlocked: (personId: number, date: string) => Promise<boolean>}} deps.blockouts  The blockouts service.
 * @param {object} [deps.logger]  Structured logger (never log secrets).
 * @returns {object}
 */
export function createAssignmentsService(deps) {
  const { data, clock, blockouts } = deps;
  const today = () => todayStr(clock.now());
  const audit = (d, actorId, action, detail) => d.audit.log({ at: clock.now(), actorId: actorId ?? null, action, detail });
  const where = (s) => `slot ${s.id} (${s.serviceDate} ${s.serviceTime} "${s.serviceTitle}", ${s.teamName} / ${s.positionName})`;

  async function loadSlot(d, slotId) {
    const slot = isInt(slotId) ? await d.slots.findById(slotId) : null;
    if (!slot) throw new NotFoundError('Slot not found');
    return slot;
  }

  function notPast(slot, message = 'That service is in the past and cannot be changed') {
    if (slot.serviceDate < today()) throw new ConflictError(message, { code: 'past' });
  }

  return {
    /**
     * Put a person in a slot (status pending). Rules, each a ConflictError with a code:
     * past (never overridable), inactive (never overridable), and, unless `force`
     * is true, accepted (someone else already accepted this slot), not_qualified,
     * blocked, double_booked.
     * @param {{id: number}} actor
     * @param {number} slotId
     * @param {{personId: number, force?: boolean}} input
     */
    async assign(actor, slotId, { personId, force = false } = {}) {
      if (!isInt(personId)) throw new ValidationError('Person id must be a whole number');
      if (typeof force !== 'boolean') throw new ValidationError('Force must be true or false');
      return data.tx(async (d) => {
        const slot = await loadSlot(d, slotId);
        notPast(slot);
        const person = await d.people.findById(personId);
        if (!person) throw new NotFoundError('Person not found');
        if (!person.active) {
          throw new ConflictError(`${person.name} is no longer active`, { code: 'inactive' });
        }
        const overridden = [];
        const check = (failed, code, message) => {
          if (!failed) return;
          if (!force) throw new ConflictError(message, { code });
          overridden.push(code);
        };
        check(slot.status === 'accepted' && slot.personId !== person.id, 'accepted',
          `${slot.personName} has already accepted this slot`);
        check(!person.positionIds.includes(slot.positionId), 'not_qualified',
          `${person.name} is not set up for ${slot.positionName}`);
        check(await blockouts.isBlocked(person.id, slot.serviceDate), 'blocked',
          `${person.name} is blocked out on ${slot.serviceDate}`);
        const others = (await d.slots.listForService(slot.serviceId))
          .filter((s) => s.id !== slot.id && s.personId === person.id && HOLDING.includes(s.status));
        check(others.length > 0, 'double_booked',
          `${person.name} is already scheduled on this service`);
        const updated = await d.slots.assign(slot.id, { personId: person.id, status: 'pending', assignedAt: clock.now().toISOString() });
        const previous = slot.personName ? `, replacing ${slot.personName} (${slot.status})` : '';
        const forced = overridden.length ? ` [forced: ${overridden.join(', ')}]` : '';
        await audit(d, actor?.id, 'slot.assign', `${where(slot)}: ${person.name}${previous}${forced}`);
        return assignmentView(updated);
      });
    },

    /** Take the person out of a slot: back to open. */
    async unassign(actor, slotId) {
      return data.tx(async (d) => {
        const slot = await loadSlot(d, slotId);
        notPast(slot);
        if (slot.personId === null && slot.status === 'open') return assignmentView(slot);
        const updated = await d.slots.clear(slot.id);
        await audit(d, actor?.id, 'slot.unassign', `${where(slot)}: ${slot.personName ?? 'nobody'} (${slot.status})`);
        return assignmentView(updated);
      });
    },

    /**
     * The person's pending and accepted slots from `from` (default today) for
     * 12 weeks, each with the other people serving on the same service (names
     * and positions only). nextServing is the first item on or after today.
     */
    async mySchedule(personId, { from } = {}) {
      const start = from === undefined || from === null || from === '' ? today() : from;
      if (!isValidDate(start)) throw new ValidationError('From must be a real date like 2025-11-08');
      const end = addDays(start, SCHEDULE_DAYS);
      return data.tx(async (d) => {
        const mine = await d.slots.listForPerson(personId, start, end, HOLDING);
        const byService = new Map();
        if (mine.length) {
          const wanted = new Set(mine.map((s) => s.serviceId));
          for (const s of await d.slots.listForServices(start, end)) {
            if (!wanted.has(s.serviceId)) continue;
            if (!byService.has(s.serviceId)) byService.set(s.serviceId, []);
            byService.get(s.serviceId).push(s);
          }
        }
        const items = mine.map((s) => ({
          slotId: s.id,
          date: s.serviceDate,
          time: s.serviceTime,
          serviceTitle: s.serviceTitle,
          positionName: s.positionName,
          teamName: s.teamName,
          status: s.status,
          coVolunteers: (byService.get(s.serviceId) ?? [])
            .filter((o) => o.personId !== null && o.personId !== personId && HOLDING.includes(o.status))
            .map((o) => ({ name: o.personName, positionName: o.positionName })),
        }));
        const now = today();
        const nextServing = items.find((i) => i.date >= now) ?? null;
        return { nextServing, items };
      });
    },

    /**
     * The slot's own person accepts or declines. pending -> accepted/declined,
     * accepted -> declined, declined -> accepted (only while the slot is still
     * theirs). Answering with the current status changes nothing.
     */
    async respond(personId, slotId, action) {
      if (action !== 'accept' && action !== 'decline') throw new ValidationError('Answer must be accept or decline');
      const status = action === 'accept' ? 'accepted' : 'declined';
      return data.tx(async (d) => {
        const slot = isInt(slotId) ? await d.slots.findById(slotId) : null;
        if (!slot || slot.personId === null || slot.personId !== personId) throw new NotFoundError('Slot not found');
        notPast(slot, 'That service is in the past');
        if (slot.status === status) return mySlotView(slot);
        if (!['pending', 'accepted', 'declined'].includes(slot.status)) throw new NotFoundError('Slot not found');
        const updated = await d.slots.respond(slot.id, { status, respondedAt: clock.now().toISOString() });
        await audit(d, personId, `slot.${action}`, `${where(slot)}: ${slot.personName} ${slot.status} -> ${status}`);
        return mySlotView(updated);
      });
    },
  };
}
