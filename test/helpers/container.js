// A container for tests: fixed clock, seeded random, fast hasher, silent logger
// and a fresh in-memory database. Never touches real files or the environment.
import { createContainer } from '../../src/container.js';
import { loadConfig } from '../../src/config.js';
import { openDb } from '../../src/db.js';
import { fixedClock } from '../../src/infra/clock.js';
import { seededRandom } from '../../src/infra/random.js';
import { fastHasher } from '../../src/infra/hasher.js';
import { silentLogger } from '../../src/infra/logger.js';

export const TEST_NOW = '2025-01-05T12:00:00';

export function makeContainer(overrides = {}) {
  const base = {
    config: { ...loadConfig({}), dbPath: ':memory:' },
    clock: fixedClock(new Date(TEST_NOW)),
    random: seededRandom(1),
    hasher: fastHasher({ env: {} }),
    logger: silentLogger(),
  };
  if (!Object.hasOwn(overrides, 'db') && !Object.hasOwn(overrides, 'data')) base.db = openDb(':memory:');
  return createContainer({ ...base, ...overrides });
}
