// Password hashers. Both have the same async interface:
//   await hasher.hash(password)          -> stored string
//   await hasher.verify(password, stored) -> true / false (never throws)
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);

const SALT_BYTES = 16;
const KEY_BYTES = 64;
// Upper bounds accepted when verifying, so a tampered stored value cannot
// make us burn huge amounts of memory or CPU.
const MAX_N = 1 << 20;
const MAX_R = 32;
const MAX_P = 16;
const MAX_PASSWORD_INPUT = 1024;
const MAX_MEMORY = 256 * 1024 * 1024; // cap on 128*N*r*p for stored values
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const INT = /^[1-9][0-9]{0,7}$/;

function maxmemFor(N, r, p) {
  return 128 * N * r * (p + 2) + 1024 * 1024;
}

function parseStored(stored) {
  if (typeof stored !== 'string' || stored.length > 1024) return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, nS, rS, pS, saltS, hashS] = parts;
  if (!INT.test(nS) || !INT.test(rS) || !INT.test(pS)) return null;
  const N = Number(nS), r = Number(rS), p = Number(pS);
  if (N < 2 || N > MAX_N || (N & (N - 1)) !== 0) return null;
  if (r > MAX_R || p > MAX_P || 128 * N * r * p > MAX_MEMORY) return null;
  if (!B64.test(saltS) || !B64.test(hashS)) return null;
  const salt = Buffer.from(saltS, 'base64');
  const hash = Buffer.from(hashS, 'base64');
  if (salt.length < 8 || hash.length < 16 || hash.length > 128) return null;
  return { N, r, p, salt, hash };
}

// Format: scrypt$16384$8$1$<salt base64>$<hash base64> (the same as src/auth.js).
export function scryptHasher({ N = 16384, r = 8, p = 1, random } = {}) {
  const saltFor = () => (random ? random.bytes(SALT_BYTES) : crypto.randomBytes(SALT_BYTES));
  return {
    async hash(password) {
      if (typeof password !== 'string') throw new TypeError('password must be a string');
      if (password.length > MAX_PASSWORD_INPUT) throw new RangeError('password is too long');
      const salt = saltFor();
      const key = await scryptAsync(password.normalize('NFC'), salt, KEY_BYTES, { N, r, p, maxmem: maxmemFor(N, r, p) });
      return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
    },
    async verify(password, stored) {
      try {
        if (typeof password !== 'string' || password.length > MAX_PASSWORD_INPUT) return false;
        const s = parseStored(stored);
        if (!s) return false;
        const key = await scryptAsync(password.normalize('NFC'), s.salt, s.hash.length, {
          N: s.N, r: s.r, p: s.p, maxmem: maxmemFor(s.N, s.r, s.p),
        });
        return key.length === s.hash.length && crypto.timingSafeEqual(key, s.hash);
      } catch {
        return false;
      }
    },
  };
}

// TEST ONLY. Cheap so tests run fast; it is NOT safe for real passwords and
// refuses to work when NODE_ENV=production.
export function fastHasher({ env = process.env } = {}) {
  const refuse = () => {
    if (env.NODE_ENV === 'production') throw new Error('fastHasher is for tests only and cannot be used in production');
  };
  refuse();
  let counter = 0;
  const digest = (salt, pw) => crypto.createHash('sha256').update(`${salt}:${pw}`).digest('hex');
  return {
    testOnly: true,
    async hash(password) {
      refuse();
      if (typeof password !== 'string') throw new TypeError('password must be a string');
      const salt = `s${++counter}`;
      return `fast$${salt}$${digest(salt, password.normalize('NFC'))}`;
    },
    async verify(password, stored) {
      refuse();
      if (typeof password !== 'string' || typeof stored !== 'string') return false;
      const parts = stored.split('$');
      if (parts.length !== 3 || parts[0] !== 'fast' || !/^[0-9a-f]{64}$/.test(parts[2])) return false;
      const a = Buffer.from(digest(parts[1], password.normalize('NFC')), 'hex');
      const b = Buffer.from(parts[2], 'hex');
      return crypto.timingSafeEqual(a, b);
    },
  };
}
