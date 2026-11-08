// People: add, edit, reset login, deactivate, access level.
// Application service: all business rules for this area live here. It never
// sees HTTP objects and never runs SQL; it talks to the data layer through
// `deps.data` and throws AppErrors (src/errors.js). Built once by
// src/container.js. Invites and session ending use the injected auth service;
// no secret is ever written to the audit log or the logger.
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';

export const ROLES = Object.freeze(['admin', 'member']);
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;
export const EMAIL_ERR = 'Please enter a valid email address.';
const NOT_FOUND = 'That person was not found';

/** '' or null -> null (no email); otherwise a lowercase email, or ValidationError. */
export function cleanEmail(email) {
  if (email === undefined) return undefined;
  if (email === null || (typeof email === 'string' && email.trim() === '')) return null;
  const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new ValidationError(EMAIL_ERR);
  return e;
}

/** The public view used by the API (no secrets, no createdAt). */
export function personView(p) {
  return {
    id: p.id,
    name: p.name,
    email: p.email ?? null,
    role: p.role,
    active: !!p.active,
    joined: !!p.joined,
    positionIds: p.positionIds ?? [],
  };
}

/**
 * @param {object} deps  Injected by src/container.js (nothing is imported or global).
 * @param {import("../data/index.js").Data} deps.data  The data layer.
 * @param {{now: () => Date}} deps.clock
 * @param {object} [deps.logger]  Structured logger (never log secrets).
 * @param {{newInvite: () => {token: string, tokenHash: string, expiresAt: string, createdAt: string},
 *          endSessions: (personId: number) => Promise<unknown>}} deps.auth  The auth service.
 * @returns {object}
 */
export function createPeopleService(deps) {
  const { data, clock, auth } = deps;
  const audit = (d, actor, action, detail) => d.audit.log({ at: clock.now(), actorId: actor?.id ?? null, action, detail });

  return {
    /** Everyone (active or not), sorted by name. */
    async list() {
      return (await data.people.list()).map(personView);
    },

    /**
     * Add a person. With an email they also get a one-time invite (only its
     * hash is stored); without one they can be scheduled but cannot log in.
     * @param {{id: number}} actor
     * @param {{name: string, email?: string|null, role?: 'admin'|'member'}} input
     * @returns {Promise<{person: object, invite: {token: string, expiresAt: string}|null}>}
     */
    async create(actor, { name, email, role = 'member' }) {
      const mail = cleanEmail(email) ?? null;
      if (!ROLES.includes(role)) throw new ValidationError('The role must be admin or member.');
      const inv = mail ? auth.newInvite() : null;
      const person = await data.tx(async (d) => {
        let created;
        try {
          created = await d.people.create({ name, email: mail, role, createdAt: clock.now().toISOString() });
        } catch (e) {
          if (e?.name === 'DuplicateError') throw new ConflictError(e.message);
          throw e;
        }
        if (inv) await d.invites.replace({ personId: created.id, tokenHash: inv.tokenHash, expiresAt: inv.expiresAt, createdAt: inv.createdAt });
        await audit(d, actor, 'person.create', `person ${created.id} role ${role}`);
        return created;
      });
      return { person: personView(person), invite: inv && { token: inv.token, expiresAt: inv.expiresAt } };
    },

    /**
     * Change name, role, active and/or email. Keeps at least one active admin, stops an
     * admin deactivating themselves, ends every session of a deactivated person, and
     * only lets the email change before the person joined.
     */
    async update(actor, id, { name, role, active, email } = {}) {
      const mail = cleanEmail(email);
      if (role !== undefined && !ROLES.includes(role)) throw new ValidationError('The role must be admin or member.');
      const person = await data.tx(async (d) => {
        const cur = await d.people.findById(id);
        if (!cur) throw new NotFoundError(NOT_FOUND);
        const newRole = role ?? cur.role;
        const newActive = active === undefined ? cur.active : !!active;
        if (id === actor?.id && !newActive && cur.active) {
          throw new ConflictError('You cannot deactivate your own account');
        }
        const wasActiveAdmin = cur.role === 'admin' && cur.active && cur.joined;
        const stillActiveAdmin = newRole === 'admin' && newActive;
        if (wasActiveAdmin && !stillActiveAdmin && (await d.people.countActiveAdmins()) <= 1) {
          throw new ConflictError('There must always be at least one active admin');
        }
        const changes = [];
        if (name !== undefined && name !== cur.name) changes.push('name');
        if (newRole !== cur.role) changes.push(`role ${cur.role} -> ${newRole}`);
        if (newActive !== cur.active) changes.push(newActive ? 'reactivated' : 'deactivated');
        const emailChanged = mail !== undefined && mail !== cur.email;
        if (emailChanged) changes.push('email');
        // The login belongs to the person once they joined: an admin changing it is how
        // "profile takeover" scams work. Reset login first; then they join again.
        if (emailChanged && cur.joined) {
          throw new ConflictError(`${cur.name} has joined, so their email cannot be changed here. Use Reset login first.`);
        }
        let updated;
        try {
          updated = await d.people.update(id, { name: name ?? cur.name, role: newRole, active: newActive, email: mail });
        } catch (e) {
          if (e?.name === 'DuplicateError') throw new ConflictError(e.message);
          throw e;
        }
        if (!newActive) await auth.endSessions(id);
        if (mail === null && emailChanged) await d.invites.deleteForPerson(id); // no email, no way to use it
        if (changes.length) await audit(d, actor, 'person.update', `person ${id}: ${changes.join(', ')}`);
        return updated;
      });
      return personView(person);
    },

    /** Replace an unjoined person's invite; the old link stops working. */
    async invite(actor, id) {
      return data.tx(async (d) => {
        const p = await d.people.findById(id);
        if (!p) throw new NotFoundError(NOT_FOUND);
        if (!p.active) throw new ValidationError(`${p.name} is deactivated. Reactivate them first.`);
        if (p.joined) throw new ValidationError(`${p.name} has already joined. Use Reset login instead.`);
        if (!p.email) throw new ValidationError(`Add an email for ${p.name} first. It is how they log in.`);
        const inv = auth.newInvite();
        await d.invites.replace({ personId: id, tokenHash: inv.tokenHash, expiresAt: inv.expiresAt, createdAt: inv.createdAt });
        await audit(d, actor, 'person.invite', `person ${id}`);
        return { person: personView(p), invite: { token: inv.token, expiresAt: inv.expiresAt } };
      });
    },

    /**
     * Reset login: clear the password, linked sign-in accounts and every session,
     * so the person has to join again; returns a new one-time invite.
     */
    async resetLogin(actor, id) {
      return data.tx(async (d) => {
        const p = await d.people.findById(id);
        if (!p) throw new NotFoundError(NOT_FOUND);
        if (!p.email) throw new ValidationError(`Add an email for ${p.name} first. It is how they log in.`);
        await d.people.setPassword(id, null);
        await d.sessions.deleteForPerson(id);
        await d.identities.deleteForPerson(id);
        const inv = auth.newInvite();
        await d.invites.replace({ personId: id, tokenHash: inv.tokenHash, expiresAt: inv.expiresAt, createdAt: inv.createdAt });
        await audit(d, actor, 'person.reset_login', `person ${id}`);
        return { person: personView(await d.people.findById(id)), invite: { token: inv.token, expiresAt: inv.expiresAt } };
      });
    },
  };
}
