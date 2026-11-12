// Structured logging: one JSON line per event. Fields whose names look like
// secrets (password, token, secret, cookie, authorization, hash) are replaced
// with '[REDACTED]' at any depth.
import { systemClock } from './clock.js';

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /password|passwd|token|secret|cookie|authori[sz]ation|hash|api[-_]?key|endpoint|p256dh|^auth$|private[-_]?key/i;
const CORE = new Set(['time', 'level', 'msg']);
const MAX_DEPTH = 8;

export function isSecretKey(key) {
  return SECRET_KEY.test(String(key));
}

export function redact(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    return value;
  }
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Too deep]';
  seen.add(value);
  try {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (value instanceof Error) {
      const out = { name: value.name, message: value.message, stack: value.stack };
      for (const k of Object.keys(value)) {
        out[k] = isSecretKey(k) ? '[REDACTED]' : redact(value[k], depth + 1, seen);
      }
      return out;
    }
    if (Buffer.isBuffer(value)) return '[Buffer]';
    if (Array.isArray(value)) return value.map((x) => redact(x, depth + 1, seen));
    const out = {};
    for (const k of Object.keys(value)) {
      if (k === '__proto__') continue;
      out[k] = isSecretKey(k) ? '[REDACTED]' : redact(value[k], depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function defaultWrite(line) {
  process.stdout.write(`${line}\n`);
}

export function createLogger({ level = 'info', write = defaultWrite, clock = systemClock(), fields = {} } = {}) {
  if (!Object.hasOwn(LEVELS, level)) throw new Error(`Unknown log level: ${level}`);
  const min = LEVELS[level];
  const base = redact(fields) ?? {};

  function log(lvl, msg, extra) {
    if (LEVELS[lvl] < min) return;
    try {
      const entry = { time: clock.now().toISOString(), level: lvl, msg: String(msg) };
      const clean = { ...base, ...(extra && typeof extra === 'object' ? redact(extra) : {}) };
      for (const [k, v] of Object.entries(clean)) {
        if (!CORE.has(k) && v !== undefined) entry[k] = v;
      }
      write(JSON.stringify(entry));
    } catch {
      // Logging must never break the request.
    }
  }

  const logger = {
    level,
    debug: (msg, f) => log('debug', msg, f),
    info: (msg, f) => log('info', msg, f),
    warn: (msg, f) => log('warn', msg, f),
    error: (msg, f) => log('error', msg, f),
    child: (more = {}) => createLogger({ level, write, clock, fields: { ...fields, ...more } }),
  };
  return logger;
}

export function silentLogger() {
  const noop = () => {};
  const logger = { level: 'silent', debug: noop, info: noop, warn: noop, error: noop, child: () => logger };
  return logger;
}
