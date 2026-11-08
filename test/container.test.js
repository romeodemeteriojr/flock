import test from 'node:test';
import assert from 'node:assert/strict';
import { createContainer, buildServices, SERVICE_SPECS, CORE_DEPS, ContainerError } from '../src/container.js';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { fixedClock } from '../src/infra/clock.js';
import { seededRandom } from '../src/infra/random.js';
import { fastHasher } from '../src/infra/hasher.js';
import { silentLogger } from '../src/infra/logger.js';
import { makeContainer } from './helpers/container.js';
import { startTestApp } from './helpers/app.js';
import { listJs, analyse } from './helpers/source.js';

const SERVICE_NAMES = ['auth', 'people', 'teams', 'calendar', 'blockouts', 'assignments', 'gaps', 'availability', 'autofill'];
const memConfig = () => ({ ...loadConfig({}), dbPath: ':memory:' });

test('container: defaults are the real system parts', () => {
  const c = createContainer({ config: memConfig(), logger: silentLogger() });
  try {
    assert.deepEqual(Object.keys(c.services).sort(), [...SERVICE_NAMES].sort());
    assert.ok(c.clock.now() instanceof Date);
    assert.ok(Math.abs(c.clock.now().getTime() - new Date().getTime()) < 5000);
    assert.equal(c.random.testOnly, undefined, 'default random is the secure one');
    assert.equal(c.hasher.testOnly, undefined, 'default hasher is scrypt');
    assert.equal(typeof c.random.token(), 'string');
    assert.equal(typeof c.data.people.list, 'function');
    assert.equal(typeof c.db.prepare, 'function');
    assert.equal(c.config.dbPath, ':memory:');
  } finally { c.close(); }
});

test('container: the default logger writes JSON lines to stderr, not stdout', (t) => {
  const err = [];
  const out = [];
  t.mock.method(process.stderr, 'write', (s) => { err.push(String(s)); return true; });
  t.mock.method(process.stdout, 'write', (s) => { out.push(String(s)); return true; });
  const c = createContainer({ config: memConfig() });
  c.logger.info('hello from the container', { password: 'hunter2' });
  t.mock.restoreAll();
  c.close();
  const line = err.find((l) => l.includes('hello from the container'));
  assert.ok(line, 'logged to stderr');
  assert.ok(!out.some((l) => l.includes('hello from the container')));
  assert.equal(JSON.parse(line).password, '[REDACTED]');
});

test('container: config comes from loadConfig (env is passed in, never read here in tests)', () => {
  const c = createContainer({ env: { FLOCK_DB: ':memory:', FLOCK_PORT: '9123' }, logger: silentLogger() });
  try {
    assert.equal(c.config.port, 9123);
    assert.equal(c.config.dbPath, ':memory:');
  } finally { c.close(); }
  assert.throws(() => createContainer({ config: { ...memConfig(), port: 'x' }, logger: silentLogger() }), /port/);
});

test('container: every part can be overridden', () => {
  const clock = fixedClock('2030-02-03T04:05:06.000Z');
  const random = seededRandom(7);
  const hasher = fastHasher({ env: {} });
  const logger = silentLogger();
  const db = openDb(':memory:');
  const config = memConfig();
  const c = createContainer({ config, clock, random, hasher, logger, db });
  assert.equal(c.clock, clock);
  assert.equal(c.random, random);
  assert.equal(c.hasher, hasher);
  assert.equal(c.logger, logger);
  assert.equal(c.db, db);
  assert.equal(c.config, config);
  c.close(); // does not close a db it did not open
  assert.doesNotThrow(() => db.prepare('SELECT 1').get());
  db.close();

  const data = { tx: async (fn) => fn(data), people: {} };
  const c2 = createContainer({ config, logger, data });
  assert.equal(c2.data, data);
  assert.equal(c2.db, undefined);

  const auth = { probe: true };
  const c3 = makeContainer({ services: { auth } });
  assert.equal(c3.services.auth, auth);
});

test('container: services are built exactly once, in dependency order, with only what they declare', () => {
  const calls = [];
  const factories = {};
  for (const name of SERVICE_NAMES) {
    factories[name] = (deps) => {
      calls.push({ name, deps: Object.keys(deps).sort() });
      for (const need of SERVICE_SPECS[name].needs) {
        if (!CORE_DEPS.includes(need) && need !== 'sso') assert.ok(calls.some((x) => x.name === need), `${need} built before ${name}`);
      }
      assert.ok(Object.isFrozen(deps));
      return { name, deps };
    };
  }
  const c = makeContainer({ factories });
  assert.deepEqual(calls.map((x) => x.name).sort(), [...SERVICE_NAMES].sort());
  for (const { name, deps } of calls) assert.deepEqual(deps, [...SERVICE_SPECS[name].needs].sort());
  // Services that depend on other services get the very same instance.
  assert.equal(c.services.gaps.deps.assignments, c.services.assignments);
  assert.equal(c.services.assignments.deps.calendar, c.services.calendar);
  assert.equal(c.services.people.deps.auth, c.services.auth);
  assert.ok(Object.isFrozen(c.services));
  // Building an app from the container does not build anything again.
  const app = createApp({ container: c });
  assert.equal(calls.length, SERVICE_NAMES.length);
  assert.equal(app.ctx.services, c.services);
});

test('container: injected clock, random and hasher are the ones a service sees (probe service)', async () => {
  const probe = (deps) => ({
    now: () => deps.clock.now().toISOString(),
    token: () => deps.random.token(8),
    hash: (pw) => deps.hasher.hash(pw),
    verify: (pw, h) => deps.hasher.verify(pw, h),
    people: () => deps.data.people.list(),
    days: () => deps.config.sessionDays,
  });
  const clock = fixedClock('2031-05-06T07:08:09.000Z');
  const c = makeContainer({ clock, random: seededRandom('probe'), factories: { probe: { factory: probe, needs: [...CORE_DEPS] } } });
  const p = c.services.probe;
  assert.equal(p.now(), '2031-05-06T07:08:09.000Z');
  clock.advance(1000);
  assert.equal(p.now(), '2031-05-06T07:08:10.000Z');
  assert.equal(p.token(), seededRandom('probe').token(8));
  const h = await p.hash('pw');
  assert.match(h, /^fast\$/);
  assert.equal(await p.verify('pw', h), true);
  assert.deepEqual(await p.people(), []);
  assert.equal(p.days(), 14);
  // The route context carries the same parts.
  const app = await startTestApp({ container: { clock, factories: { probe: { factory: probe, needs: ['clock'] } } } });
  try {
    assert.equal(app.container.clock, clock);
    assert.equal(app.app.ctx.clock.now().toISOString(), '2031-05-06T07:08:10.000Z');
    // The deprecated compat fields are gone from the route dependencies.
    assert.deepEqual(Object.keys(app.app.ctx).sort(), ['clock', 'config', 'logger', 'services']);
    assert.equal(app.container.services.probe, app.app.ctx.services.probe);
    assert.equal((await app.request('GET', '/api/health')).status, 200);
    assert.equal(app.data, app.container.data);
  } finally { await app.close(); }
});

test('container: a missing dependency gives a clear error', () => {
  const needsNope = { factory: () => ({}), needs: ['clock', 'nope'] };
  assert.throws(() => makeContainer({ factories: { extra: needsNope } }),
    (e) => e instanceof ContainerError && /Cannot build service extra: missing dependency nope/.test(e.message));
  assert.throws(() => makeContainer({ clock: null }), /Missing dependency: clock/);
  assert.throws(() => makeContainer({ hasher: { hash() {} } }), /hasher is missing its verify\(\) method/);
  assert.throws(() => makeContainer({ db: undefined }), /Missing dependency: db/);
  assert.throws(() => buildServices({ data: undefined }, { a: { factory: () => ({}), needs: ['data'] } }), /Cannot build service a: missing dependency data/);
  assert.throws(() => buildServices({}, { a: { factory: () => ({}), needs: ['b'] }, b: { factory: () => ({}), needs: ['a'] } }), /cycle: a -> b -> a/);
  assert.throws(() => buildServices({}, { a: { factory: () => null, needs: [] } }), /must return an object/);
});

test('container: the old createApp({db, now, config}) form still works', async () => {
  const db = openDb(':memory:');
  const app = createApp({ db, now: () => new Date('2025-01-05T12:00:00Z'), config: loadConfig({}) });
  assert.equal(app.ctx.db, undefined, 'routes no longer get the raw database');
  assert.equal(app.ctx.now, undefined, 'routes no longer get ctx.now()');
  assert.equal(app.container.db, db);
  assert.equal(app.container.clock.now().toISOString(), '2025-01-05T12:00:00.000Z');
  assert.deepEqual(Object.keys(app.ctx.services).sort(), [...SERVICE_NAMES].sort());
  const port = await app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(r.status, 200);
    await r.text();
  } finally { await app.close(); db.close(); }
});

test('container: process.env is read only by config (static check)', () => {
  const files = analyse(listJs('src'));
  const readers = files.filter((f) => /\bprocess\s*\.\s*env\b/.test(f.code)).map((f) => f.file).sort();
  // src/infra/hasher.js only checks NODE_ENV so the test-only hasher refuses to run in production.
  assert.deepEqual(readers, ['src/config.js', 'src/infra/hasher.js']);
  const container = files.find((f) => f.file === 'src/container.js');
  assert.ok(container.imports.some((im) => im.target === 'src/config.js'), 'the container gets config through loadConfig');
});

test('container: the database it opens records migrations with the injected clock', () => {
  const c = createContainer({
    config: { ...loadConfig({}), dbPath: ':memory:' },
    clock: fixedClock('2032-03-04T05:06:07.000Z'),
    logger: silentLogger(),
  });
  try {
    assert.equal(c.db.prepare('SELECT applied_at FROM schema_migrations').get().applied_at, '2032-03-04T05:06:07.000Z');
  } finally { c.close(); }
});
