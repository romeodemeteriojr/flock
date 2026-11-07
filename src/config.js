export function loadConfig(env = process.env) {
  const port = Number.parseInt(env.FLOCK_PORT, 10);
  return validateConfig({
    port: Number.isInteger(port) && port >= 0 && port < 65536 ? port : 8080,
    dbPath: env.FLOCK_DB || './data/flock.db',
    secureCookies: env.FLOCK_SECURE_COOKIES === '1',
    trustProxy: env.FLOCK_TRUST_PROXY === '1',
    publicUrl: env.FLOCK_PUBLIC_URL ? env.FLOCK_PUBLIC_URL.trim().replace(/\/+$/, '') : undefined,
    unansweredDays: 3,
    sessionDays: 14,
  });
}

export class ConfigError extends Error {
  constructor(problems) {
    super(`flock cannot start because the settings have ${problems.length === 1 ? 'a problem' : `${problems.length} problems`}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function intIn(x, lo, hi) {
  return Number.isInteger(x) && x >= lo && x <= hi;
}

// Fails fast with one message that lists every problem. Returns the config.
export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new ConfigError(['The settings must be an object']);
  }
  const problems = [];
  if (!intIn(config.port, 0, 65535)) problems.push('port must be a whole number from 0 to 65535 (FLOCK_PORT)');
  if (typeof config.dbPath !== 'string' || !config.dbPath.trim()) problems.push('dbPath must be set to a database file (FLOCK_DB)');
  if (!intIn(config.sessionDays, 1, 90)) problems.push('sessionDays must be a whole number from 1 to 90');
  if (!intIn(config.unansweredDays, 0, 30)) problems.push('unansweredDays must be a whole number from 0 to 30');
  if (typeof config.secureCookies !== 'boolean') problems.push('secureCookies must be true or false (FLOCK_SECURE_COOKIES)');
  if (config.trustProxy !== undefined && typeof config.trustProxy !== 'boolean') problems.push('trustProxy must be true or false (FLOCK_TRUST_PROXY)');
  if (config.publicUrl !== undefined) {
    let ok = false;
    try {
      const u = new URL(config.publicUrl);
      ok = typeof config.publicUrl === 'string' && (u.protocol === 'https:' || u.protocol === 'http:')
        && !u.username && !u.password && !u.search && !u.hash;
    } catch { /* reported with the other settings below */ }
    if (!ok) problems.push('publicUrl must be a full http:// or https:// address without credentials, a query or a fragment (FLOCK_PUBLIC_URL)');
  }
  if (problems.length) throw new ConfigError(problems);
  return config;
}

import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
