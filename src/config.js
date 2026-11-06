export function loadConfig(env = process.env) {
  const port = Number.parseInt(env.FLOCK_PORT, 10);
  return validateConfig({
    port: Number.isInteger(port) && port >= 0 && port < 65536 ? port : 8080,
    dbPath: env.FLOCK_DB || './data/flock.db',
    secureCookies: env.FLOCK_SECURE_COOKIES === '1',
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
  if (problems.length) throw new ConfigError(problems);
  return config;
}

import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
