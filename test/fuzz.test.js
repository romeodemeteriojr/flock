// Fuzzing every route (C-83). A seeded random generator throws malformed and
// hostile input at EVERY route the router has registered (read from the
// router itself, never a hand-written list), as an anonymous visitor, a member
// and a scheduler. It checks that nothing is ever a 500, that no response
// shows a stack trace or a file path, and that the guard answers 401 / 403 as
// it should. The run is the same every time (seeded random, fixed clock).
// Made-up people, an in-memory database; nothing real is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp } from './helpers/app.js';
import { addPerson } from './helpers/seed.js';
import { loadConfig } from '../src/config.js';
import { BODY_LIMIT } from '../src/http.js';
import { COOKIE_NAME } from '../src/guard.js';
import { fixedClock } from '../src/infra/clock.js';
import { seededRandom } from '../src/infra/random.js';

const NOW = '2025-01-05T12:00:00'; // a Sunday
const PASSWORD = 'test-pass-1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES = 14; // random cases per route and role, on top of the fixed hostile cases
const ALLOWED = new Set([200, 201, 204, 400, 401, 403, 404, 405, 409, 413, 429]);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// ---------------------------------------------------------------- generator

function generator(seed) {
  const rnd = seededRandom(seed);
  const pick = (list) => list[rnd.int(list.length)];
  const chance = (n) => rnd.int(n) === 0;

  const STRINGS = [
    '', ' ', '\t\n', 'a', 'Sunday', 'x'.repeat(5000), '😀'.repeat(2000), 'é'.repeat(300), 'a\u0000b', '\u0000',
    '\ud800', '\udfff\ud800', '\u202eevil', 'ﷺ﷽', 'Z̴̡̛͓a̷l̶g̵o̴', '<script>alert(1)</script>', '"><img src=x onerror=alert(1)>',
    "'; DROP TABLE people;--", '../../etc/passwd', '..\\..\\windows', '%00', '%ZZ', '${7*7}', '{{7*7}}',
    '__proto__', 'constructor', 'prototype', 'null', 'undefined', 'NaN', 'true', '-1', '0', '1', '1e400', ' 1 ',
    '=cmd|calc', 'admin', 'member', 'accept', '09:00', '25:61', '10:00', 'flock_session=x',
  ];
  const NUMBERS = [-1, 0, 1, 2, 3, 1.5, -0.5, 1e308, -1e308, 2 ** 31, 2 ** 53 + 2, -(2 ** 53), 99999999999, 26, 27, 20, 21];
  const DATES = [
    '2025-02-29', '2024-02-29', '2028-02-29', '2025-13-01', '2025-00-10', '2025-01-32', '0000-00-00', '0001-01-01',
    '9999-12-31', '2025-1-1', '2025-01-05T00:00:00Z', '-001-01-01', '+02025-01-01', '2025/01/05', '2025-01-05',
    '2025-01-12', '2024-12-29', '2026-01-04', '1970-01-01', ' 2025-01-12', '2025-01-12\u0000',
  ];
  const KEYS = [
    'name', 'username', 'password', 'role', 'active', 'date', 'time', 'title', 'slots', 'positionId', 'count',
    'fromServiceId', 'weeks', 'personId', 'force', 'startDate', 'endDate', 'reason', 'positionIds', 'sort', 'teamId',
    'oldPassword', 'newPassword', 'id', '__proto__', 'constructor', 'x'.repeat(200), '',
  ];

  function value(depth = 0) {
    switch (rnd.int(depth > 2 ? 6 : 9)) {
      case 0: return pick(STRINGS);
      case 1: return pick(NUMBERS);
      case 2: return pick(DATES);
      case 3: return pick([null, true, false]);
      case 4: return rnd.int(1000);
      case 5: return pick(STRINGS).repeat(1 + rnd.int(3));
      case 6: return Array.from({ length: rnd.int(4) }, () => value(depth + 1));
      case 7: return object(depth + 1);
      default: return [{ positionId: value(depth + 1), count: value(depth + 1) }];
    }
  }

  function object(depth = 0) {
    const o = {};
    for (let i = 0, n = rnd.int(6); i < n; i++) o[pick(KEYS)] = value(depth);
    return o;
  }

  const SEGMENTS = [
    '1', '2', '3', '0', '-1', '1.5', '1e3', 'abc', '99999999999999999999', '9007199254740993', '%00', '%ZZ',
    '%F0%9F%98%80', '%ED%A0%80', '1%2F2', '%2E%2E', '%20', 'a'.repeat(3000), 'NaN', '0x10', '01', '1;DROP',
  ];
  const QUERY_KEYS = ['from', 'to', 'slotId', 'includeUnqualified', 'weekOf', 'confirm', 'x', ''];

  // Lone surrogates cannot be encoded as UTF-8: send the raw (invalid) bytes instead.
  const encode = (v) => { try { return encodeURIComponent(v); } catch { return '%ED%A0%80'; } };

  function query() {
    if (chance(3)) return '';
    const parts = [];
    for (let i = 0, n = 1 + rnd.int(4); i < n; i++) {
      const v = chance(2) ? pick(DATES) : chance(2) ? pick(STRINGS) : String(pick(NUMBERS));
      parts.push(`${encodeURIComponent(pick(QUERY_KEYS))}=${chance(8) ? '%ZZ' : encode(v.slice(0, 300))}`);
    }
    return `?${parts.join('&')}`;
  }

  // A raw body and its content type.
  function body() {
    switch (rnd.int(10)) {
      case 0: return { raw: JSON.stringify(pick([[], 'text', 123, null, true, [object()]])), type: 'application/json' };
      case 1: return { raw: pick(['{', '{"a":', "{'a':1}", 'undefined', '\u0000', '{"a":1}}', '[1,]', 'NaN', '{"a":01}']), type: 'application/json' };
      case 2: return { raw: 'name=Hacker&role=admin&personId=1', type: 'application/x-www-form-urlencoded' };
      case 3: return { raw: JSON.stringify(object()), type: pick(['text/plain', 'application/xml', 'multipart/form-data; boundary=x', '']) };
      case 4: return { raw: `{"name":"First","name":{"nested":true},"personId":1,"personId":"2","role":"member","role":"admin"}`, type: 'application/json' };
      case 5: return { raw: '{"__proto__":{"role":"admin","isAdmin":true},"constructor":{"prototype":{"polluted":1}}}', type: 'application/json' };
      default: return { raw: JSON.stringify(object()), type: 'application/json' };
    }
  }

  // A valid body for the route with one field made hostile, removed or added,
  // so the input gets past the first checks and reaches the service.
  function mutated(pattern) {
    const base = structuredClone(VALID[pattern] ?? {});
    const keys = Object.keys(base);
    const o = { ...base };
    const k = keys.length && !chance(4) ? pick(keys) : pick(KEYS);
    if (chance(5)) delete o[k]; else o[k] = value();
    return { raw: JSON.stringify(o), type: 'application/json' };
  }

  const ip = () => `10.${rnd.int(256)}.${rnd.int(256)}.${rnd.int(256)}`;
  return { pick, chance, query, body, mutated, segment: () => pick(SEGMENTS), ip };
}

// Well-formed bodies by route pattern, the starting point for mutated()
// (routes without one start from {}). The routes themselves come from the router.
const VALID = {
  '/api/login': { username: 'member', password: PASSWORD },
  '/api/password': { oldPassword: PASSWORD, newPassword: 'a-new-password-9' },
  '/api/people': { name: 'New Person', username: 'new.person', role: 'member' },
  '/api/people/:id': { name: 'Renamed', role: 'member', active: true },
  '/api/teams': { name: 'Greeters' },
  '/api/teams/:id': { name: 'Band 2', sort: 1 },
  '/api/teams/:id/positions': { name: 'Bass' },
  '/api/positions/:id': { name: 'Lead vocals', sort: 2, teamId: 1 },
  '/api/people/:id/positions': { positionIds: [1] },
  '/api/services': { date: '2025-01-19', time: '10:00', title: 'Evening', slots: [{ positionId: 1, count: 2 }] },
  '/api/services/repeat': { fromServiceId: 1, weeks: 2 },
  '/api/services/:id': { date: '2025-01-26', time: '11:00', title: 'Moved' },
  '/api/services/:id/slots': { positionId: 1, count: 1 },
  '/api/slots/:id/assign': { personId: 2, force: false },
  '/api/me/blockouts': { startDate: '2025-02-01', endDate: '2025-02-03', reason: 'Trip' },
};

// Bodies everyone must handle, for every route.
const DEEP = `${'{"a":'.repeat(5000)}1${'}'.repeat(5000)}`;
const DEEP_ARRAY = `${'['.repeat(20000)}${']'.repeat(20000)}`;
const FIXED = [
  { label: 'over the size limit', raw: JSON.stringify({ name: 'x'.repeat(BODY_LIMIT + 10) }), type: 'application/json', expect: 413 },
  { label: 'invalid JSON', raw: '{"name": "unterminated', type: 'application/json', expect: 400 },
  { label: 'deeply nested object', raw: DEEP, type: 'application/json' },
  { label: 'deeply nested array', raw: DEEP_ARRAY, type: 'application/json' },
  { label: 'form encoded', raw: 'a=1&b=2', type: 'application/x-www-form-urlencoded', expect: 400 },
  { label: 'binary', raw: Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80]).toString('latin1'), type: 'application/octet-stream', expect: 400 },
  { label: 'empty', raw: '', type: 'application/json' },
];

// ---------------------------------------------------------------- the app

async function boot() {
  const app = await startTestApp({
    config: { ...loadConfig({}), trustProxy: true }, // each request gets its own IP, so the login throttle never hides a result
    container: { clock: fixedClock(NOW), random: seededRandom('fuzz-app') },
  });
  const { services } = app.container;
  const schedId = await addPerson(app, { name: 'Sam Scheduler', username: 'sched', role: 'admin' });
  const memberId = await addPerson(app, { name: 'Mia Member', username: 'member' });
  await addPerson(app, { name: 'Otto Other', username: 'other' });
  const actor = { id: schedId };
  const team = await services.teams.createTeam(actor, { name: 'Band' });
  const pos = await services.teams.createPosition(actor, team.id, { name: 'Vocals' });
  await services.teams.setQualifications(actor, memberId, [pos.id]);
  const svc = await services.calendar.createService(actor, { date: '2025-01-12', slots: [{ positionId: pos.id, count: 3 }] });
  await services.assignments.assign(actor, svc.slots[0].id, { personId: memberId });
  await services.blockouts.add(memberId, { startDate: '2025-01-19', reason: 'Away' });
  const people = { sched: { id: schedId, role: 'admin', name: 'Sam Scheduler' }, member: { id: memberId, role: 'member', name: 'Mia Member' } };

  // A working session for a role, whatever earlier fuzz requests did to the
  // account (reset its password, demoted it, logged it out, locked it).
  async function session(username) {
    const p = people[username];
    const { data, hasher } = app.container;
    await data.people.setPassword(p.id, await hasher.hash(PASSWORD), false);
    await data.people.update(p.id, { name: p.name, role: p.role, active: true });
    await data.people.setLoginFailures(p.id, { failedLogins: 0, lockedUntil: null });
    const { token } = await services.auth.login(username, PASSWORD);
    return `${COOKIE_NAME}=${token}`;
  }
  return { app, session };
}

// ---------------------------------------------------------------- checks

const LEAKS = [
  [/\n\s+at\s/, 'a stack trace'],
  [/\bat [\w.<>]+ \(/, 'a stack frame'],
  [/node:internal|node_modules/, 'a Node path'],
  [/\.m?js:\d+/, 'a source file and line'],
  [/(?:^|[\s"'(])\/(?:Users|home|root|tmp|var|private|app|data|etc)\//, 'an absolute path'],
  [/[A-Z]:\\/, 'a Windows path'],
  [/SQLITE_|sqlite|SQL logic|constraint failed|no such (table|column)/i, 'a database error'],
  [/TypeError|ReferenceError|RangeError|SyntaxError/, 'a JavaScript error name'],
];

function checkResponse(res, where) {
  assert.ok(res.status < 500, `${where}: got ${res.status} ${res.text.slice(0, 200)}`);
  assert.ok(ALLOWED.has(res.status), `${where}: unexpected status ${res.status}`);
  assert.ok(!res.text.includes(ROOT), `${where}: the response shows the project folder`);
  for (const [re, what] of LEAKS) assert.ok(!re.test(res.text), `${where}: the response shows ${what}: ${res.text.slice(0, 300)}`);
  if (res.status !== 204 && res.text) {
    assert.match(String(res.headers['content-type']), /^application\/json/, `${where}: JSON answer`);
    assert.ok(res.json && typeof res.json === 'object', `${where}: the body is a JSON object`);
    if (res.status >= 400) assert.equal(typeof res.json.error, 'string', `${where}: an error message`);
  }
}

// What the guard must answer, before anything else, given who is asking.
function guardExpectation(route, role, { csrf }) {
  if (MUTATING.has(route.method) && route.pattern !== '/api/login' && !csrf) return 403;
  if (route.auth === 'none') return null;
  if (role === 'anonymous') return 401;
  if (route.auth === 'admin' && role === 'member') return 403;
  return null;
}

async function send(app, method, url, { raw, type, cookie, ip, csrf = true }) {
  const headers = { 'Fly-Client-IP': ip };
  if (csrf) headers['X-Flock'] = '1';
  if (raw !== undefined && type) headers['Content-Type'] = type;
  return app.request(method, url, { body: raw, cookie, headers });
}

// ---------------------------------------------------------------- tests

test('fuzz: the router has routes to fuzz, read from the router itself', async () => {
  const { app } = await boot();
  try {
    const routes = app.app.router.routes();
    assert.ok(routes.length >= 35, `found ${routes.length} routes`);
    for (const r of routes) assert.ok(['none', 'login', 'admin'].includes(r.auth));
  } finally { await app.close(); }
});

// One test per route, so a failure names the route. The list is read from a
// throwaway app's router at load time.
const probe = await startTestApp();
const ROUTES = probe.app.router.routes();
await probe.close();

for (const route of ROUTES) {
  const name = `${route.method} ${route.pattern}`;
  test(`fuzz: ${name} (${route.auth}) never fails, leaks or lets the wrong person in`, async () => {
    const { app, session } = await boot();
    const gen = generator(`fuzz ${name}`);
    let requests = 0;
    try {
      for (const role of ['anonymous', 'member', 'scheduler']) {
        const cases = [
          ...FIXED.map((f) => ({ ...f, fill: '1' })),
          ...Array.from({ length: CASES }, (_, i) => ({ label: `random ${i}`, ...gen.body(), random: true })),
          ...Array.from({ length: CASES }, (_, i) => ({ label: `mutated ${i}`, ...gen.mutated(route.pattern), random: true })),
          { label: 'no CSRF header', raw: '{}', type: 'application/json', csrf: false, fill: '1' },
        ];
        for (const c of cases) {
          const fill = c.fill ?? (gen.chance(3) ? '1' : null);
          const pathname = route.pattern.replace(/:[A-Za-z]+/g, () => fill ?? gen.segment());
          const url = pathname + (c.random ? gen.query() : '');
          const hasBody = MUTATING.has(route.method) || (c.random && gen.chance(4));
          const cookie = role === 'anonymous' ? undefined : await session(role === 'member' ? 'member' : 'sched');
          const csrf = c.csrf ?? true;
          const res = await send(app, route.method, url, {
            raw: hasBody ? c.raw : undefined, type: c.type, cookie, ip: gen.ip(), csrf,
          });
          requests++;
          const where = `${name} as ${role}, ${c.label}, ${route.method} ${url.slice(0, 120)}`;
          checkResponse(res, where);

          // Hostile path segments may stop the path matching this route at all.
          const matched = app.app.router.match(route.method, new URL(url, 'http://x').pathname).route;
          if (!matched) {
            assert.ok([404, 405].includes(res.status), `${where}: unmatched path is ${res.status}`);
            continue;
          }
          const guard = guardExpectation(matched, role, { csrf });
          if (guard !== null) {
            assert.equal(res.status, guard, `${where}: the guard must answer ${guard}`);
            continue;
          }
          if (role !== 'anonymous' && matched.auth !== 'none') assert.notEqual(res.status, 401, `${where}: a logged-in user was treated as logged out`);
          if (role === 'scheduler') assert.notEqual(res.status, 403, `${where}: the scheduler was refused`);
          if (c.expect && hasBody) assert.equal(res.status, c.expect, `${where}: expected ${c.expect}`);
        }
      }
      // The app is still healthy afterwards.
      assert.equal((await app.request('GET', '/api/health')).status, 200);
      assert.equal(app.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.ok(requests > 3 * CASES);
    } finally { await app.close(); }
  });
}

test('fuzz: unknown paths and methods under /api are 404 or 405, never 500', async () => {
  const { app, session } = await boot();
  const gen = generator('fuzz unknown');
  try {
    const cookie = await session('sched');
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'PROPFIND', 'HEAD'];
    const paths = ['/api', '/api/', '/api/nope', '/api/people/1/2/3', '/api/teams/1/positions/1', '/api//people',
      '/api/%00', '/api/%ZZ', `/api/${'a'.repeat(5000)}`, '/api/people/..%2F..%2Fetc', '/api/me/slots/1', '/api/health/x'];
    for (const route of ROUTES) paths.push(route.pattern.replace(/:[A-Za-z]+/g, '1'));
    for (const p of paths) {
      for (const m of methods) {
        const res = await send(app, m, p, { raw: m === 'GET' || m === 'HEAD' ? undefined : '{}', type: 'application/json', cookie, ip: gen.ip() });
        const where = `${m} ${p.slice(0, 80)}`;
        assert.ok(res.status < 500, `${where}: ${res.status}`);
        if (m === 'HEAD') continue; // no body to check
        checkResponse(res, where);
        if (!app.app.router.match(m, new URL(p, 'http://x').pathname).route) {
          assert.ok([404, 405].includes(res.status), `${where}: ${res.status}`);
        }
      }
    }
  } finally { await app.close(); }
});

test('fuzz: hostile input changed nothing it should not: no pollution, the fixture is intact', async () => {
  const { app, session } = await boot();
  try {
    const cookie = await session('member');
    const res = await send(app, 'POST', '/api/me/blockouts', {
      raw: '{"__proto__":{"isAdmin":true},"startDate":"2025-02-01","constructor":{"prototype":{"polluted":true}}}',
      type: 'application/json', cookie, ip: '10.0.0.1',
    });
    assert.equal(res.status, 201);
    assert.equal({}.isAdmin, undefined);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
    // A member still cannot see the people list after sending "role": "admin" anywhere.
    await send(app, 'POST', '/api/password', { raw: '{"role":"admin","oldPassword":"x","newPassword":"y"}', type: 'application/json', cookie, ip: '10.0.0.2' });
    assert.equal((await send(app, 'GET', '/api/people', { cookie, ip: '10.0.0.3' })).status, 403);
  } finally { await app.close(); }
});
