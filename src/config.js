export function loadConfig(env = process.env) {
  const port = Number.parseInt(env.FLOCK_PORT, 10);
  return {
    port: Number.isInteger(port) && port >= 0 && port < 65536 ? port : 8080,
    dbPath: env.FLOCK_DB || './data/flock.db',
    secureCookies: env.FLOCK_SECURE_COOKIES === '1',
    unansweredDays: 3,
    sessionDays: 14,
  };
}

import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
