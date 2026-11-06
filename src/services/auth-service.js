// Auth: login, sessions, lockout, password changes.
// Application service: all business rules for this area live here. It never
// sees HTTP objects and never runs SQL; it talks to the data layer through
// `deps.data` and throws AppErrors (src/errors.js). Built once by
// src/container.js.
//
// Secrets: password hashes never leave this service except from
// newTempCredentials() (for the people service to store). The raw session
// token is only returned by login() (for the cookie); only its SHA-256 is
// stored. Neither is ever logged.
import crypto from 'node:crypto';
import { NotFoundError, TooManyRequestsError, UnauthenticatedError, ValidationError } from '../errors.js';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 5 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;
export const MAX_PASSWORD_INPUT = 1024;
export const DEFAULT_SESSION_DAYS = 14;

export const INVALID_LOGIN_MESSAGE = 'Wrong username or password';
export const LOCKED_MESSAGE = 'Too many tries. Please wait a few minutes.';

// Short everyday words that are easy to say and spell over the phone.
export const TEMP_WORDS = Object.freeze([
  'apple', 'bread', 'brick', 'cabin', 'candle', 'cedar', 'chair', 'cloud',
  'coral', 'daisy', 'dove', 'eagle', 'field', 'flame', 'forest', 'garden',
  'grape', 'green', 'harbor', 'hill', 'honey', 'island', 'jacket', 'lake',
  'lemon', 'light', 'maple', 'meadow', 'melon', 'moon', 'morning', 'olive',
  'orange', 'otter', 'panda', 'paper', 'peach', 'pencil', 'piano', 'pine',
  'pocket', 'pond', 'rabbit', 'rain', 'river', 'robin', 'rock', 'rose',
  'sand', 'silver', 'snow', 'spring', 'star', 'stone', 'summer', 'sun',
  'table', 'tiger', 'tulip', 'valley', 'violet', 'water', 'willow', 'window',
  'winter', 'yellow', 'basket', 'button', 'carrot', 'copper', 'garden', 'kettle',
  'ladder', 'mitten', 'muffin', 'nickel', 'orchard', 'pepper', 'pillow', 'puppy',
].filter((w, i, a) => a.indexOf(w) === i));

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** SHA-256 of a session token (hex). Only this is stored. */
export function tokenHash(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Password rules. Returns a plain-English message, or null when the password is fine.
 * @param {unknown} pw
 * @param {{username?: string}} [opts]
 * @returns {string|null}
 */
export function validatePassword(pw, { username } = {}) {
  if (typeof pw !== 'string') return 'Please enter a password.';
  const len = [...pw].length;
  if (len < MIN_PASSWORD_LENGTH) return `Your password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  if (len > MAX_PASSWORD_LENGTH) return `Your password can be at most ${MAX_PASSWORD_LENGTH} characters long.`;
  if (pw.trim() === '') return 'Your password cannot be only spaces.';
  if (typeof username === 'string' && username !== '' && pw.trim().toLowerCase() === username.trim().toLowerCase()) {
    return 'Your password cannot be the same as your username.';
  }
  return null;
}

/**
 * The public view of a person: never contains the hash, lockout state or tokens.
 * @param {object|null|undefined} person  A Person or AuthPerson from the data layer.
 * @returns {{id: number, name: string, username: string, role: string, mustChangePassword: boolean, active: boolean}|null}
 */
export function publicPerson(person) {
  if (!person) return null;
  return {
    id: person.id,
    name: person.name,
    username: person.username,
    role: person.role,
    mustChangePassword: !!person.mustChangePassword,
    active: !!person.active,
  };
}

function lockedFor(person, nowMs) {
  if (!person.lockedUntil) return 0;
  const until = Date.parse(person.lockedUntil);
  if (!(until > nowMs)) return 0;
  return Math.max(1, Math.ceil((until - nowMs) / 1000));
}

/**
 * @param {object} deps  Injected by src/container.js (nothing is imported or global).
 * @param {import("../data/index.js").Data} deps.data  The data layer.
 * @param {{now: () => Date}} deps.clock
 * @param {{bytes: Function, int: Function, token: Function}} deps.random
 * @param {{hash: Function, verify: Function}} deps.hasher
 * @param {object} deps.logger  Structured logger (never log secrets).
 * @param {object} deps.config  Validated settings (src/config.js).
 * @returns {object}
 */
export function createAuthService(deps) {
  const { data, clock, random, hasher, logger, config } = deps;

  const nowDate = () => {
    const n = clock.now();
    const d = n instanceof Date ? new Date(n.getTime()) : new Date(n);
    if (Number.isNaN(d.getTime())) throw new Error('clock.now() returned an invalid time');
    return d;
  };

  const sessionDays = () => {
    const days = Number(config?.sessionDays);
    return Number.isFinite(days) && days > 0 ? days : DEFAULT_SESSION_DAYS;
  };

  // A hash of a random password, checked for unknown usernames so timing does
  // not reveal which usernames exist. Made once per service, lazily.
  let dummy = null;
  const dummyHash = () => (dummy ??= hasher.hash(random.token(16)));
  const burn = async (pw) => { await hasher.verify(pw, await dummyHash()); };

  function generateTempPassword() {
    const w1 = TEMP_WORDS[random.int(TEMP_WORDS.length)];
    const w2 = TEMP_WORDS[random.int(TEMP_WORDS.length)];
    const digits = String(random.int(100)).padStart(2, '0');
    return `${w1}-${w2}-${digits}`;
  }

  async function createSession(personId) {
    const token = random.token(32);
    const now = nowDate();
    const expires = new Date(now.getTime() + sessionDays() * 24 * 60 * 60 * 1000);
    await data.sessions.create({
      tokenHash: tokenHash(token), personId, expiresAt: expires.toISOString(), createdAt: now.toISOString(),
    });
    return token;
  }

  const service = {
    validatePassword,
    publicPerson,

    /**
     * A temporary password like "maple-river-07" (from the injected random source).
     * @returns {string}
     */
    generateTempPassword,

    /**
     * A new temporary password and its hash, for a new person or a reset.
     * The hash is returned only here, so the people service can store it.
     * @returns {Promise<{tempPassword: string, passwordHash: string}>}
     */
    async newTempCredentials() {
      const tempPassword = generateTempPassword();
      const passwordHash = await hasher.hash(tempPassword);
      return { tempPassword, passwordHash };
    },

    /**
     * Check a username and password and start a session.
     * @returns {Promise<{person: object, token: string}>}  The public person and the raw session token (for the cookie only).
     * @throws {UnauthenticatedError} wrong password, unknown or inactive person (same message for all)
     * @throws {TooManyRequestsError} the person is locked out (retryAfterSec set)
     */
    async login(username, password) {
      const invalid = (reason) => new UnauthenticatedError(INVALID_LOGIN_MESSAGE, { details: { reason } });
      const pwOk = typeof password === 'string' && password.length <= MAX_PASSWORD_INPUT;
      const found = typeof username === 'string' && username !== ''
        ? await data.people.findAuthByUsername(username)
        : null;

      if (!found) {
        await burn(pwOk ? password : 'x');
        throw invalid('invalid');
      }

      const wait = lockedFor(found, nowDate().getTime());
      if (wait) {
        logger.warn('login refused: account locked', { personId: found.id });
        throw new TooManyRequestsError(LOCKED_MESSAGE, wait, { details: { reason: 'locked' } });
      }

      let good = false;
      if (pwOk) good = await hasher.verify(password, found.passwordHash);
      else await burn('x');

      // Re-read and update in one transaction, so concurrent attempts are all counted.
      const outcome = await data.tx(async (d) => {
        const cur = await d.people.findAuthById(found.id);
        if (!cur) return { reason: 'invalid' };
        const nowMs = nowDate().getTime();
        const w = lockedFor(cur, nowMs);
        if (w) return { reason: 'locked', retryAfterSec: w };
        // Password changed while we were checking: fail without counting it.
        if (cur.passwordHash !== found.passwordHash) return { reason: 'invalid' };
        if (!good) {
          // An expired lock starts a fresh count.
          const failed = (cur.lockedUntil ? 0 : cur.failedLogins) + 1;
          const lockedUntil = failed >= MAX_FAILED_LOGINS ? new Date(nowMs + LOCKOUT_MS).toISOString() : null;
          await d.people.setLoginFailures(cur.id, { failedLogins: failed, lockedUntil });
          return { reason: 'invalid', lockedNow: !!lockedUntil };
        }
        if (!cur.active) return { reason: 'inactive' };
        await d.people.setLoginFailures(cur.id, { failedLogins: 0, lockedUntil: null });
        return { person: publicPerson(cur) };
      });

      if (!outcome.person) {
        if (outcome.reason === 'locked') {
          throw new TooManyRequestsError(LOCKED_MESSAGE, outcome.retryAfterSec, { details: { reason: 'locked' } });
        }
        if (outcome.lockedNow) logger.warn('account locked after failed logins', { personId: found.id });
        else logger.info('login failed', { personId: found.id, reason: outcome.reason });
        throw invalid(outcome.reason);
      }
      const token = await createSession(outcome.person.id);
      logger.info('login', { personId: outcome.person.id });
      return { person: outcome.person, token };
    },

    /**
     * The active person a session token belongs to, or null. Expired sessions are deleted.
     * @returns {Promise<object|null>}  The public person.
     */
    async authenticate(token) {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
      const th = tokenHash(token);
      const s = await data.sessions.findByTokenHash(th);
      if (!s) return null;
      if (!(Date.parse(s.expiresAt) > nowDate().getTime())) {
        await data.sessions.deleteByTokenHash(th);
        return null;
      }
      const person = await data.people.findById(s.personId);
      return person && person.active ? publicPerson(person) : null;
    },

    /** End one session. Unknown or empty tokens are ignored. */
    async logout(token) {
      if (typeof token !== 'string' || token === '') return;
      await data.sessions.deleteByTokenHash(tokenHash(token));
    },

    /**
     * Destroy every session of a person (for example after deactivating them).
     * @param {number} personId
     * @returns {Promise<number>} how many sessions were ended
     */
    async endSessions(personId) {
      return data.sessions.deleteForPerson(personId);
    },

    /**
     * Change a person's own password. Ends their other sessions (keeps currentToken's).
     * @throws {ValidationError} with a plain-English message for every refusal
     */
    async changePassword(personId, oldPassword, newPassword, { currentToken } = {}) {
      const person = await data.people.findAuthById(personId);
      if (!person || !person.active) throw new ValidationError('This account cannot be changed.');
      if (typeof oldPassword !== 'string' || oldPassword.length > MAX_PASSWORD_INPUT
          || !(await hasher.verify(oldPassword, person.passwordHash))) {
        throw new ValidationError('Your current password is not correct.');
      }
      const err = validatePassword(newPassword, { username: person.username });
      if (err) throw new ValidationError(err);
      if (newPassword === oldPassword) throw new ValidationError('Your new password must be different from your current one.');
      const hash = await hasher.hash(newPassword);
      await data.tx(async (d) => {
        const cur = await d.people.findAuthById(personId);
        if (!cur || cur.passwordHash !== person.passwordHash) {
          throw new ValidationError('Your password was changed somewhere else. Please try again.');
        }
        await d.people.setPassword(personId, hash, false);
        const keep = typeof currentToken === 'string' && currentToken !== '' ? tokenHash(currentToken) : undefined;
        await d.sessions.deleteForPerson(personId, keep);
      });
      logger.info('password changed', { personId });
    },

    /**
     * Give a person a new temporary password: they must change it at next login,
     * any lockout is cleared and all their sessions end.
     * @returns {Promise<string>} the temporary password (to tell the person)
     * @throws {NotFoundError} unknown person
     */
    async issueTempPassword(personId) {
      const { tempPassword, passwordHash } = await service.newTempCredentials();
      await data.tx(async (d) => {
        if (!(await d.people.setPassword(personId, passwordHash, true))) {
          throw new NotFoundError('That person was not found');
        }
        await d.sessions.deleteForPerson(personId);
      });
      logger.info('temporary password issued', { personId });
      return tempPassword;
    },
  };
  return service;
}
