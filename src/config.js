import { PRESETS } from './infra/oidc.js';
import { vapidKeysProblem } from './infra/webpush.js';
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
    sso: Object.fromEntries(Object.entries(PRESETS).map(([id, p]) => [id, {
      clientId: env[`${p.env}_CLIENT_ID`]?.trim() || undefined,
      clientSecret: env[`${p.env}_CLIENT_SECRET`]?.trim() || undefined,
    }])),
    // Push notifications (decision 0008): off until both keys are set.
    push: {
      publicKey: env.FLOCK_VAPID_PUBLIC_KEY?.trim() || undefined,
      privateKey: env.FLOCK_VAPID_PRIVATE_KEY?.trim() || undefined,
    },
  });
}

/** True when the settings turn push notifications on. */
export const pushEnabled = (config) => Boolean(config?.push?.publicKey && config.push.privateKey);

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
  for (const [id, s] of Object.entries(config.sso ?? {})) {
    const env = PRESETS[id]?.env;
    if (!env) problems.push(`sso.${id} is not a known sign-in provider`);
    else if (!s?.clientId !== !s?.clientSecret) problems.push(`${PRESETS[id].label} sign-in needs both ${env}_CLIENT_ID and ${env}_CLIENT_SECRET, or neither`);
  }
  const push = config.push ?? {};
  if (!push.publicKey !== !push.privateKey) {
    problems.push('Push notifications need both FLOCK_VAPID_PUBLIC_KEY and FLOCK_VAPID_PRIVATE_KEY, or neither');
  } else if (push.publicKey) {
    const keys = vapidKeysProblem(push.publicKey, push.privateKey);
    if (keys) problems.push(keys);
    if (!/^https:\/\//.test(config.publicUrl ?? '')) {
      problems.push('Push notifications need FLOCK_PUBLIC_URL to be the https:// address of Flock');
    }
  }
  if (problems.length) throw new ConfigError(problems);
  return config;
}

import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
