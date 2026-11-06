// Passwords, sessions and login lockout.
// Never log password hashes, session tokens or temporary passwords.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { tx } from './db.js';

const scryptAsync = promisify(crypto.scrypt);

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
// Upper bounds accepted when verifying a stored hash, so a tampered value
// cannot make us burn huge amounts of memory or CPU.
const MAX_N = 1 << 20;
const MAX_R = 32;
const MAX_P = 16;
const MAX_PASSWORD_INPUT = 1024;

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 5 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

function nowDate(ctx) {
  const n = ctx.now();
  const d = n instanceof Date ? new Date(n.getTime()) : new Date(n);
  if (Number.isNaN(d.getTime())) throw new Error('ctx.now() returned an invalid time');
  return d;
}

function maxmemFor(N, r, p) {
  return 128 * N * r * (p + 2) + 1024 * 1024;
}

// ---------- password hashing ----------

export async function hashPassword(pw) {
  if (typeof pw !== 'string') throw new TypeError('password must be a string');
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scryptAsync(pw.normalize('NFC'), salt, KEY_BYTES, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: maxmemFor(SCRYPT_N, SCRYPT_R, SCRYPT_P),
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const INT = /^[1-9][0-9]{0,7}$/;

function parseStored(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, nS, rS, pS, saltS, hashS] = parts;
  if (!INT.test(nS) || !INT.test(rS) || !INT.test(pS)) return null;
  const N = Number(nS), r = Number(rS), p = Number(pS);
  if (N < 2 || N > MAX_N || (N & (N - 1)) !== 0) return null;
  if (r > MAX_R || p > MAX_P) return null;
  if (!B64.test(saltS) || !B64.test(hashS)) return null;
  const salt = Buffer.from(saltS, 'base64');
  const hash = Buffer.from(hashS, 'base64');
  if (salt.length < 8 || hash.length < 16 || hash.length > 128) return null;
  return { N, r, p, salt, hash };
}

export async function verifyPassword(pw, stored) {
  try {
    if (typeof pw !== 'string') return false;
    const s = parseStored(stored);
    if (!s) return false;
    const key = await scryptAsync(pw.normalize('NFC'), s.salt, s.hash.length, {
      N: s.N, r: s.r, p: s.p, maxmem: maxmemFor(s.N, s.r, s.p),
    });
    return key.length === s.hash.length && crypto.timingSafeEqual(key, s.hash);
  } catch {
    return false;
  }
}

let dummyHashPromise = null;
function dummyHash() {
  dummyHashPromise ??= hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHashPromise;
}

// ---------- password rules ----------

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

export function generateTempPassword() {
  const w1 = TEMP_WORDS[crypto.randomInt(TEMP_WORDS.length)];
  const w2 = TEMP_WORDS[crypto.randomInt(TEMP_WORDS.length)];
  const digits = String(crypto.randomInt(100)).padStart(2, '0');
  return `${w1}-${w2}-${digits}`;
}

// ---------- people ----------

export function publicPerson(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
    mustChangePassword: !!row.must_change_password,
    active: !!row.active,
  };
}

function stripHash(row) {
  if (!row) return row;
  const { password_hash, ...rest } = row; // eslint-disable-line no-unused-vars
  return rest;
}

// ---------- sessions ----------

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function tokenHash(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSession(db, ctx, personId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = nowDate(ctx);
  const days = Number(ctx.config?.sessionDays);
  const sessionDays = Number.isFinite(days) && days > 0 ? days : 14;
  const expires = new Date(now.getTime() + sessionDays * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO sessions (token_hash, person_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(tokenHash(token), personId, expires.toISOString(), now.toISOString());
  return token;
}

export function getSession(db, ctx, token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const th = tokenHash(token);
  const s = db.prepare('SELECT id, person_id, expires_at FROM sessions WHERE token_hash = ?').get(th);
  if (!s) return null;
  const exp = Date.parse(s.expires_at);
  if (!(exp > nowDate(ctx).getTime())) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
    return null;
  }
  const person = db.prepare('SELECT * FROM people WHERE id = ? AND active = 1').get(s.person_id);
  return person ? stripHash(person) : null;
}

export function destroySession(db, token) {
  if (typeof token !== 'string' || token === '') return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

export function destroyAllSessions(db, personId, exceptToken) {
  if (typeof exceptToken === 'string' && exceptToken !== '') {
    db.prepare('DELETE FROM sessions WHERE person_id = ? AND token_hash <> ?').run(personId, tokenHash(exceptToken));
  } else {
    db.prepare('DELETE FROM sessions WHERE person_id = ?').run(personId);
  }
}

// ---------- login ----------

function lockedFor(row, nowMs) {
  if (!row.locked_until) return 0;
  const until = Date.parse(row.locked_until);
  if (!(until > nowMs)) return 0;
  return Math.max(1, Math.ceil((until - nowMs) / 1000));
}

export async function login(db, ctx, username, password) {
  const pwOk = typeof password === 'string' && password.length <= MAX_PASSWORD_INPUT;
  const row = typeof username === 'string' && username !== ''
    ? db.prepare('SELECT * FROM people WHERE username = ?').get(username)
    : undefined;

  if (!row) {
    // Same amount of work as a real check so timing does not reveal unknown usernames.
    await verifyPassword(pwOk ? password : 'x', await dummyHash());
    return { ok: false, reason: 'invalid' };
  }

  const startMs = nowDate(ctx).getTime();
  const wait = lockedFor(row, startMs);
  if (wait) return { ok: false, reason: 'locked', retryAfterSec: wait };

  const good = pwOk ? await verifyPassword(password, row.password_hash) : (await verifyPassword('x', await dummyHash()), false);

  // Re-read and update synchronously, so concurrent attempts are counted correctly.
  return tx(db, () => {
    const cur = db.prepare('SELECT * FROM people WHERE id = ?').get(row.id);
    if (!cur) return { ok: false, reason: 'invalid' };
    const now = nowDate(ctx);
    const nowMs = now.getTime();
    const w = lockedFor(cur, nowMs);
    if (w) return { ok: false, reason: 'locked', retryAfterSec: w };
    if (cur.password_hash !== row.password_hash) {
      // Password changed while we were checking; treat as a failed attempt without counting it.
      return { ok: false, reason: 'invalid' };
    }
    if (!good) {
      // An expired lock starts a fresh count.
      const prev = cur.locked_until ? 0 : cur.failed_logins;
      const failed = prev + 1;
      if (failed >= MAX_FAILED_LOGINS) {
        const until = new Date(nowMs + LOCKOUT_MS).toISOString();
        db.prepare('UPDATE people SET failed_logins = ?, locked_until = ? WHERE id = ?').run(failed, until, cur.id);
      } else {
        db.prepare('UPDATE people SET failed_logins = ?, locked_until = NULL WHERE id = ?').run(failed, cur.id);
      }
      return { ok: false, reason: 'invalid' };
    }
    if (!cur.active) return { ok: false, reason: 'inactive' };
    db.prepare('UPDATE people SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(cur.id);
    const fresh = db.prepare('SELECT * FROM people WHERE id = ?').get(cur.id);
    return { ok: true, person: stripHash(fresh) };
  });
}

// ---------- password changes ----------

export async function changePassword(db, ctx, personId, oldPassword, newPassword, { exceptToken } = {}) {
  const row = db.prepare('SELECT * FROM people WHERE id = ?').get(personId);
  if (!row || !row.active) return { ok: false, error: 'This account cannot be changed.' };
  if (typeof oldPassword !== 'string' || oldPassword.length > MAX_PASSWORD_INPUT
      || !(await verifyPassword(oldPassword, row.password_hash))) {
    return { ok: false, error: 'Your current password is not correct.' };
  }
  const err = validatePassword(newPassword, { username: row.username });
  if (err) return { ok: false, error: err };
  if (newPassword === oldPassword) return { ok: false, error: 'Your new password must be different from your current one.' };
  const hash = await hashPassword(newPassword);
  return tx(db, () => {
    const cur = db.prepare('SELECT password_hash FROM people WHERE id = ?').get(personId);
    if (!cur || cur.password_hash !== row.password_hash) {
      return { ok: false, error: 'Your password was changed somewhere else. Please try again.' };
    }
    db.prepare('UPDATE people SET password_hash = ?, must_change_password = 0, failed_logins = 0, locked_until = NULL WHERE id = ?')
      .run(hash, personId);
    destroyAllSessions(db, personId, exceptToken);
    return { ok: true };
  });
}

export async function setTempPassword(db, ctx, personId) {
  const temp = generateTempPassword();
  const hash = await hashPassword(temp);
  tx(db, () => {
    const r = db.prepare('UPDATE people SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL WHERE id = ?')
      .run(hash, personId);
    if (Number(r.changes) !== 1) throw new Error('person not found');
    destroyAllSessions(db, personId);
  });
  return temp;
}
