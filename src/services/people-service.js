// People: add, edit, reset password, deactivate, access level.
// Application service: all business rules for this area live here. It never
// sees HTTP objects and never runs SQL; it talks to the data layer through
// `deps.data` and throws AppErrors (src/errors.js). Built once by
// src/container.js. Invites and session ending use the injected auth service;
// no secret is ever written to the audit log or the logger.
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';

export const USERNAME_RE = /^[A-Za-z0-9._-]{3,30}$/;
export const USERNAME_ERR = 'The username must be 3 to 30 letters, digits, dots, underscores or dashes.';
export const ROLES = Object.freeze(['admin', 'member']);
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;
export const EMAIL_ERR = 'Please enter a valid email address, or leave it empty.';
const USERNAME_TAKEN = 'That username is already taken';
const NOT_FOUND = 'That person was not found';

/** '' or null -> null (no email); otherwise a lowercase email, or ValidationError. */
export function cleanEmail(email) {
  if (email === undefined) return undefined;
  if (email === null || (typeof email === 'string' && email.trim() === '')) return null;
  const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new ValidationError(EMAIL_ERR);
  return e;
}

/** A username made from a name: "Zoë van Dijk" -> "zoe.van.dijk" (3 to 24 characters). */
export function baseUsername(name) {
  let base = String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean).join('.');
  base = base.slice(0, 24).replace(/\.+$/, '');
  if (base.length < 3) base = (base + '.user').slice(0, 24);
  return base;
}

/** The public view used by the API (no secrets, no createdAt). */
export function personView(p) {
  return {
    id: p.id,
    name: p.name,
    username: p.username,
    email: p.email ?? null,
    role: p.role,
    active: !!p.active,
    joined: !!p.hasPassword,
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

  async function freeUsername(d, name) {
    const base = baseUsername(name);
    if (!(await d.people.findAuthByUsername(base))) return base;
    for (let n = 2; n < 10000; n++) {
      const u = `${base}${n}`;
      if (!(await d.people.findAuthByUsername(u))) return u;
    }
    throw new Error('no free username');
  }

  return {
    /** Everyone (active or not), sorted by name. */
    async list() {
      return (await data.people.list()).map(personView);
    },

    /**
     * Add a person with a one-time invite. Only the token hash is stored.
     * @param {{id: number}} actor
     * @param {{name: string, username?: string|null, email?: string|null, role?: 'admin'|'member'}} input
     */
    async create(actor, { name, username, email, role = 'member' }) {
      const mail = cleanEmail(email) ?? null;
      if (!ROLES.includes(role)) throw new ValidationError('The role must be admin or member.');
      let wanted = null;
      if (username !== undefined && username !== null && username !== '') {
        if (typeof username !== 'string' || !USERNAME_RE.test(username.trim())) throw new ValidationError(USERNAME_ERR);
        wanted = username.trim().toLowerCase();
      }
      const inv = auth.newInvite();
      const person = await data.tx(async (d) => {
        const uname = wanted ?? (await freeUsername(d, name));
        if (await d.people.findAuthByUsername(uname)) throw new ConflictError(USERNAME_TAKEN);
        let created;
        try {
          created = await d.people.create({
            name, username: uname, email: mail, role, createdAt: clock.now().toISOString(),
          });
        } catch (e) {
          if (e?.name === 'DuplicateError') throw new ConflictError(/email/.test(e.message) ? e.message : USERNAME_TAKEN);
          throw e;
        }
        await d.invites.replace({ personId: created.id, tokenHash: inv.tokenHash, expiresAt: inv.expiresAt, createdAt: inv.createdAt });
        await audit(d, actor, 'person.create', `person ${created.id} (${uname}) role ${role}`);
        return created;
      });
      return { person: personView(person), invite: { token: inv.token, expiresAt: inv.expiresAt } };
    },

    /**
     * Change name, role and/or active. Keeps at least one active admin, stops an
     * admin deactivating themselves, and ends every session of a deactivated person.
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
        const wasActiveAdmin = cur.role === 'admin' && cur.active && cur.hasPassword;
        const stillActiveAdmin = newRole === 'admin' && newActive;
        if (wasActiveAdmin && !stillActiveAdmin && (await d.people.countActiveAdmins()) <= 1) {
          throw new ConflictError('There must always be at least one active admin');
        }
        const changes = [];
        if (name !== undefined && name !== cur.name) changes.push('name');
        if (newRole !== cur.role) changes.push(`role ${cur.role} -> ${newRole}`);
        if (newActive !== cur.active) changes.push(newActive ? 'reactivated' : 'deactivated');
        if (mail !== undefined && mail !== cur.email) changes.push('email');
        let updated;
        try {
          updated = await d.people.update(id, { name: name ?? cur.name, role: newRole, active: newActive, email: mail });
        } catch (e) {
          if (e?.name === 'DuplicateError') throw new ConflictError(e.message);
          throw e;
        }
        if (!newActive) await auth.endSessions(id);
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
        if (p.hasPassword) throw new ValidationError(`${p.name} has already joined. Use Reset password instead.`);
        const inv = auth.newInvite();
        await d.invites.replace({ personId: id, tokenHash: inv.tokenHash, expiresAt: inv.expiresAt, createdAt: inv.createdAt });
        await audit(d, actor, 'person.invite', `person ${id}`);
        return { person: personView(p), invite: { token: inv.token, expiresAt: inv.expiresAt } };
      });
    },

    /** Clear the password and every session, and return a one-time invite. */
    async resetPassword(actor, id) {
      return data.tx(async (d) => {
        if (!(await d.people.setPassword(id, null))) throw new NotFoundError(NOT_FOUND);
        const inv = auth.newInvite();
        await d.sessions.deleteForPerson(id);
        await d.invites.replace({ personId: id, tokenHash: inv.tokenHash, expiresAt: inv.expiresAt, createdAt: inv.createdAt });
        await audit(d, actor, 'person.reset_password', `person ${id}`);
        return { person: personView(await d.people.findById(id)), invite: { token: inv.token, expiresAt: inv.expiresAt } };
      });
    },
  };
}
