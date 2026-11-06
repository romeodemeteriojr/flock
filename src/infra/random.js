// Randomness. secureRandom() for real use; seededRandom(seed) gives the same
// sequence every time and is for tests only.
import crypto from 'node:crypto';

const MAX_INT = 2 ** 48;

function checkMax(maxExclusive) {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > MAX_INT) {
    throw new RangeError('int needs a whole number from 1 to 2^48');
  }
}

function checkBytes(n) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 65536) throw new RangeError('bytes needs a whole number from 0 to 65536');
}

export function secureRandom() {
  return {
    bytes(n) { checkBytes(n); return crypto.randomBytes(n); },
    int(maxExclusive) { checkMax(maxExclusive); return crypto.randomInt(maxExclusive); },
    token(nBytes = 32) { checkBytes(nBytes); return crypto.randomBytes(nBytes).toString('base64url'); },
  };
}

function seedToState(seed) {
  // FNV-1a over the seed text, spread into four 32-bit words.
  const text = String(seed);
  let h = 0x811c9dc5;
  const words = [];
  for (let w = 0; w < 4; w++) {
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= w + 1;
    h = Math.imul(h, 0x01000193) >>> 0;
    words.push(h);
  }
  return words;
}

export function seededRandom(seed = 1) {
  let [a, b, c, d] = seedToState(seed);
  // sfc32
  function next32() {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t >>> 0;
  }
  for (let i = 0; i < 12; i++) next32();

  function bytes(n) {
    checkBytes(n);
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i += 4) {
      const x = next32();
      for (let j = 0; j < 4 && i + j < n; j++) buf[i + j] = (x >>> (j * 8)) & 0xff;
    }
    return buf;
  }

  function int(maxExclusive) {
    checkMax(maxExclusive);
    // 48 random bits with rejection sampling to avoid bias.
    const limit = MAX_INT - (MAX_INT % maxExclusive);
    for (;;) {
      const x = (next32() & 0xffff) * 2 ** 32 + next32();
      if (x < limit) return x % maxExclusive;
    }
  }

  return {
    testOnly: true,
    bytes,
    int,
    token(nBytes = 32) { return bytes(nBytes).toString('base64url'); },
  };
}
