// The composition root. This is the ONLY place that reads the environment
// (through loadConfig) and wires the app together: infrastructure first, then
// the data layer, then every application service, built exactly once, in
// dependency order, by explicit constructor injection.
//
//   const c = createContainer();                    // real defaults
//   const c = createContainer({ clock, db, ... });  // tests replace any part
//
// Nothing below the container knows it exists: services get a plain object
// holding exactly the dependencies they declare in SERVICE_SPECS.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, validateConfig, pushEnabled } from './config.js';
import { openDb } from './db.js';
import { createData } from './data/index.js';
import { systemClock } from './infra/clock.js';
import { secureRandom } from './infra/random.js';
import { scryptHasher } from './infra/hasher.js';
import { createLogger } from './infra/logger.js';
import { ssoProviders } from './infra/oidc.js';
import { createWebPush, disabledPush } from './infra/webpush.js';
import { createAuthService } from './services/auth-service.js';
import { createPeopleService } from './services/people-service.js';
import { createTeamsService } from './services/teams-service.js';
import { createCalendarService } from './services/calendar-service.js';
import { createBlockoutsService } from './services/blockouts-service.js';
import { createAssignmentsService } from './services/assignments-service.js';
import { createGapsService } from './services/gaps-service.js';
import { createAvailabilityService } from './services/availability-service.js';
import { createAutofillService } from './services/autofill-service.js';
import { createNotificationsService } from './services/notifications-service.js';

/** Infrastructure every service may ask for. */
export const CORE_DEPS = Object.freeze(['data', 'clock', 'random', 'hasher', 'logger', 'config']);
const CORE = CORE_DEPS;

/**
 * Every service: its factory and the names of what it needs (core parts or
 * other services). The order here does not matter; the container sorts them.
 */
export const SERVICE_SPECS = Object.freeze({
  auth: { factory: createAuthService, needs: [...CORE, 'sso'] },
  people: { factory: createPeopleService, needs: [...CORE, 'auth'] },
  teams: { factory: createTeamsService, needs: [...CORE, 'notifications'] },
  calendar: { factory: createCalendarService, needs: [...CORE, 'teams', 'notifications'] },
  blockouts: { factory: createBlockoutsService, needs: [...CORE] },
  assignments: { factory: createAssignmentsService, needs: [...CORE, 'people', 'teams', 'calendar', 'blockouts', 'notifications'] },
  gaps: { factory: createGapsService, needs: [...CORE, 'teams', 'calendar', 'blockouts', 'assignments', 'notifications'] },
  availability: { factory: createAvailabilityService, needs: [...CORE] },
  autofill: { factory: createAutofillService, needs: [...CORE, 'assignments', 'notifications'] },
  notifications: { factory: createNotificationsService, needs: [...CORE, 'push'] },
});

export class ContainerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContainerError';
  }
}

// Minimal shape checks so a wrong override fails at startup, not mid-request.
const SHAPES = {
  clock: ['now'],
  random: ['bytes', 'int', 'token'],
  hasher: ['hash', 'verify'],
  logger: ['debug', 'info', 'warn', 'error'],
  data: ['tx'],
  push: ['send'],
};

function checkShape(name, value) {
  if (value === null || value === undefined) throw new ContainerError(`Missing dependency: ${name}`);
  for (const m of SHAPES[name] ?? []) {
    if (typeof value[m] !== 'function') throw new ContainerError(`Dependency ${name} is missing its ${m}() method`);
  }
  return value;
}

function stderrLogger() {
  return createLogger({ level: 'info', write: (line) => process.stderr.write(`${line}\n`) });
}

// Push notifications (decision 0008): a real sender once the keys are set.
function defaultPush(config, clock) {
  if (!pushEnabled(config)) return disabledPush();
  return createWebPush({ ...config.push, subject: config.publicUrl, clock });
}

function defaultDb(config, clock) {
  if (config.dbPath !== ':memory:') mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });
  return openDb(config.dbPath, { clock });
}

// Normalise overrides.factories entries: a function keeps the default needs
// of that name (or just the core parts for a new name).
function specsWith(factories = {}) {
  const specs = { ...SERVICE_SPECS };
  for (const [name, f] of Object.entries(factories)) {
    if (typeof f === 'function') {
      specs[name] = { factory: f, needs: [...(SERVICE_SPECS[name]?.needs ?? CORE)] };
    } else if (f && typeof f.factory === 'function') {
      specs[name] = { factory: f.factory, needs: [...(f.needs ?? SERVICE_SPECS[name]?.needs ?? CORE)] };
    } else {
      throw new ContainerError(`Service factory override for ${name} must be a function or {factory, needs}`);
    }
  }
  return specs;
}

/**
 * Build every service once, in dependency order.
 * @param {Record<string, unknown>} core  The core parts (data, clock, ...).
 * @param {Record<string, {factory: Function, needs: string[]}>} specs
 * @param {Record<string, object>} [ready]  Service instances supplied from outside (skip their factories).
 * @returns {Record<string, object>}
 */
export function buildServices(core, specs, ready = {}) {
  const built = { ...ready };
  const visiting = new Set();

  function build(name, chain) {
    if (Object.hasOwn(built, name)) return built[name];
    const spec = specs[name];
    if (!spec) throw new ContainerError(`Unknown service: ${name}`);
    if (visiting.has(name)) throw new ContainerError(`Service dependency cycle: ${[...chain, name].join(' -> ')}`);
    visiting.add(name);
    const deps = {};
    for (const need of spec.needs) {
      if (Object.hasOwn(core, need)) {
        if (core[need] === null || core[need] === undefined) {
          throw new ContainerError(`Cannot build service ${name}: missing dependency ${need}`);
        }
        deps[need] = core[need];
      } else if (Object.hasOwn(specs, need) || Object.hasOwn(built, need)) {
        deps[need] = build(need, [...chain, name]);
      } else {
        throw new ContainerError(`Cannot build service ${name}: missing dependency ${need}`);
      }
    }
    const service = spec.factory(Object.freeze(deps));
    if (!service || typeof service !== 'object') {
      throw new ContainerError(`Service factory for ${name} must return an object`);
    }
    visiting.delete(name);
    built[name] = service;
    return service;
  }

  for (const name of Object.keys(specs)) build(name, []);
  return built;
}

/**
 * @param {object} [overrides]  Any part may be replaced:
 *   config, env (passed to loadConfig), clock, random, hasher, logger, db, data, sso, push,
 *   services (ready-made instances by name), factories (service factories by name,
 *   a function or {factory, needs}).
 */
export function createContainer(overrides = {}) {
  const has = (k) => Object.hasOwn(overrides, k);
  const need = (k) => checkShape(k, overrides[k]);

  const config = has('config') ? validateConfig(overrides.config) : loadConfig(overrides.env);
  const clock = has('clock') ? need('clock') : systemClock();
  const random = has('random') ? need('random') : secureRandom();
  const hasher = has('hasher') ? need('hasher') : scryptHasher({ random });
  const logger = has('logger') ? need('logger') : stderrLogger();

  let ownsDb = false;
  let db;
  if (has('db')) {
    db = overrides.db;
    if (!db) throw new ContainerError('Missing dependency: db');
  } else if (!has('data')) {
    db = defaultDb(config, clock);
    ownsDb = true;
  }
  const data = has('data') ? need('data') : createData(db);

  const sso = has('sso') ? overrides.sso : ssoProviders(config.sso);
  const push = has('push') ? need('push') : defaultPush(config, clock);
  const core = { data, clock, random, hasher, logger, config, sso, push };
  const services = Object.freeze(buildServices(core, specsWith(overrides.factories), overrides.services ?? {}));

  return {
    config,
    clock,
    random,
    hasher,
    logger,
    data,
    sso,
    push,
    services,
    db,
    /** Close the database, but only if the container opened it. */
    close() {
      if (!ownsDb) return;
      ownsDb = false;
      db.close();
    },
  };
}
