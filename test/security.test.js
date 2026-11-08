// Security checks over real HTTP (final QA, C-78). Made-up people only, an
// in-memory database, a fixed clock and a recording logger. Nothing here reads
// the real home folder, real data or any credential file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp } from './helpers/app.js';
import { addPerson } from './helpers/seed.js';
import { createClient, cookieFrom, fillPath, MUTATING, tokenFromLink } from './helpers/client.js';
import { fixedClock } from '../src/infra/clock.js';
import { createLogger } from '../src/infra/logger.js';
import { fastHasher } from '../src/infra/hasher.js';
import { tokenHash } from '../src/services/auth-service.js';
import { loadConfig } from '../src/config.js';
import { BODY_LIMIT } from '../src/http.js';
import { createApi } from '../web/api.js';
import { fakeRoot as screenRoot } from './helpers/fakeui.js';
import { fakeRoot as hostRoot } from './helpers/fakeroot.js';

const WEB_VIEWS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'views');
const NOW = '2025-01-05T12:00:00.000Z'; // a Sunday
const PUBLIC = new Set(['POST /api/login', 'GET /api/health', 'POST /api/welcome/check', 'POST /api/welcome',
  'GET /api/auth/options', 'GET /api/auth/google', 'GET /api/auth/google/callback']);
const key = (r) => `${r.method} ${r.pattern}`;

async function boot(extra = {}) {
  const clock = fixedClock(NOW);
  const lines = [];
  const logger = createLogger({ level: 'debug', clock, write: (l) => lines.push(l) });
  const app = await startTestApp({ container: { clock, logger, ...extra } });
  const client = createClient(app);
  return { app, clock, lines, client, routes: app.app.router.routes() };
}

async function withApp(fn, extra) {
  const ctx = await boot(extra);
  try { await fn(ctx); } finally { await ctx.app.close(); }
}

async function adminAndMember(ctx) {
  const adminId = await addPerson(ctx.app, { name: 'Ada Admin', username: 'ada', role: 'admin' });
  const memberId = await addPerson(ctx.app, { name: 'Max Member', username: 'max' });
  const admin = ctx.client.browser();
  const member = ctx.client.browser();
  assert.equal((await admin.login('ada', 'test-pass-1')).status, 200);
  assert.equal((await member.login('max', 'test-pass-1')).status, 200);
  return { adminId, memberId, admin, member };
}

// ---------- authorization matrix ----------

test('matrix: only login, health and invite welcome routes are public', () => withApp(async ({ routes }) => {
  assert.ok(routes.length >= 39, `only ${routes.length} routes`);
  for (const r of routes) {
    assert.ok(r.pattern.startsWith('/api/'), `${key(r)} is outside /api`);
    assert.ok(['none', 'login', 'admin'].includes(r.auth));
    assert.equal(r.auth === 'none', PUBLIC.has(key(r)), `${key(r)} has auth ${r.auth}`);
  }
  assert.equal(new Set(routes.map(key)).size, routes.length, 'duplicate routes');
}));

test('matrix: every protected /api route is 401 when logged out', () => withApp(async ({ client, routes }) => {
  const anon = client.browser();
  for (const r of routes) {
    if (PUBLIC.has(key(r))) continue;
    for (const id of ['1', '999']) {
      const res = await anon.call(r.method, fillPath(r.pattern, id), MUTATING.has(r.method) ? {} : undefined);
      assert.equal(res.status, 401, `${key(r)} with id ${id} gave ${res.status}`);
      assert.deepEqual(res.json, { error: 'Please log in' });
    }
    // A made-up or expired session cookie is the same as none.
    const fake = client.browser('flock_session=not-a-real-token');
    assert.equal((await fake.call(r.method, fillPath(r.pattern), MUTATING.has(r.method) ? {} : undefined)).status, 401, key(r));
  }
  assert.equal((await anon.get('/api/health')).status, 200);
  assert.equal((await anon.post('/api/login', { username: 'nobody', password: 'nothing-here' })).status, 401);
}));

test('matrix: every admin route is 403 for a member, and nothing changes', () => withApp(async (ctx) => {
  const { member, admin } = await adminAndMember(ctx);
  const team = (await admin.post('/api/teams', { name: 'Band' })).json;
  const before = JSON.stringify((await admin.get('/api/teams')).json);
  const adminRoutes = ctx.routes.filter((r) => r.auth === 'admin');
  assert.ok(adminRoutes.length >= 25);
  for (const r of adminRoutes) {
    const res = await member.call(r.method, fillPath(r.pattern, String(team.id)), MUTATING.has(r.method) ? { name: 'Hijack', personId: 1, positionIds: [] } : undefined);
    assert.equal(res.status, 403, `${key(r)} gave ${res.status} to a member`);
    assert.deepEqual(res.json, { error: 'Only the scheduler can do that' });
  }
  assert.equal(JSON.stringify((await admin.get('/api/teams')).json), before);
  // And every login-level route really is open to the member.
  for (const r of ctx.routes.filter((x) => x.auth === 'login' && x.method === 'GET')) {
    assert.equal((await member.get(fillPath(r.pattern))).status, 200, key(r));
  }
}));

test('matrix: CSRF: every mutating route needs X-Flock (only login is exempt), checked before anything runs', () => withApp(async (ctx) => {
  const { admin, member } = await adminAndMember(ctx);
  const mutating = ctx.routes.filter((r) => MUTATING.has(r.method));
  assert.deepEqual(mutating.filter((r) => r.auth === 'none').map(key), ['POST /api/login', 'POST /api/welcome/check', 'POST /api/welcome']);
  const teamsBefore = JSON.stringify((await admin.get('/api/teams')).json);
  for (const r of mutating) {
    if (key(r) === 'POST /api/login') continue;
    for (const who of [admin, member, ctx.client.browser()]) {
      const res = await who.call(r.method, fillPath(r.pattern), { name: 'Sneaky' }, { csrf: false });
      assert.equal(res.status, 403, `${key(r)} without X-Flock gave ${res.status}`);
      assert.deepEqual(res.json, { error: 'Request not allowed' });
      // A wrong value is refused too.
      const wrong = await who.call(r.method, fillPath(r.pattern), { name: 'Sneaky' }, { csrf: false, headers: { 'X-Flock': 'yes' } });
      assert.equal(wrong.status, 403, key(r));
    }
  }
  assert.equal(JSON.stringify((await admin.get('/api/teams')).json), teamsBefore, 'nothing was created');
  // Logout without the header does not log out.
  assert.equal((await admin.get('/api/me')).status, 200);
  // Reads need no header.
  assert.equal((await admin.get('/api/me', { csrf: false })).status, 200);
}));

// ---------- one volunteer cannot see another ----------

async function twoVolunteers(ctx) {
  const { admin } = await adminAndMember(ctx);
  const annId = await addPerson(ctx.app, { name: 'Ann Volunteer', username: 'ann.secret' });
  const beaId = await addPerson(ctx.app, { name: 'Bea Volunteer', username: 'bea.secret' });
  const calId = await addPerson(ctx.app, { name: 'Cal Elsewhere', username: 'cal.secret' });
  const team = (await admin.post('/api/teams', { name: 'Band' })).json;
  const drums = (await admin.post(`/api/teams/${team.id}/positions`, { name: 'Drums' })).json;
  const keys = (await admin.post(`/api/teams/${team.id}/positions`, { name: 'Keys' })).json;
  for (const id of [annId, beaId, calId]) {
    assert.equal((await admin.put(`/api/people/${id}/positions`, { positionIds: [drums.id, keys.id] })).status, 200);
  }
  const shared = (await admin.post('/api/services', { date: '2025-01-12', title: 'Morning', slots: [{ positionId: drums.id }, { positionId: keys.id }] })).json;
  const beaOnly = (await admin.post('/api/services', { date: '2025-01-19', title: 'Bea Only Evening', slots: [{ positionId: drums.id }] })).json;
  const calOnly = (await admin.post('/api/services', { date: '2025-01-26', title: 'Cal Only Night', slots: [{ positionId: keys.id }] })).json;
  const assign = async (slotId, personId) => assert.equal((await admin.put(`/api/slots/${slotId}/assign`, { personId })).status, 200);
  await assign(shared.slots[0].id, annId);
  await assign(shared.slots[1].id, beaId);
  await assign(beaOnly.slots[0].id, beaId);
  await assign(calOnly.slots[0].id, calId);
  const ann = ctx.client.browser();
  const bea = ctx.client.browser();
  await ann.login('ann.secret', 'test-pass-1');
  await bea.login('bea.secret', 'test-pass-1');
  const blk = (await bea.post('/api/me/blockouts', { startDate: '2025-02-02', reason: 'Bea private reason' })).json.blockout;
  return { admin, ann, bea, annId, beaId, calId, shared, beaOnly, calOnly, blk, drums, keys };
}

test('isolation: a volunteer sees only names and positions of co-volunteers on the same service', () => withApp(async (ctx) => {
  const s = await twoVolunteers(ctx);
  const mine = (await s.ann.get('/api/me/schedule')).json;
  assert.equal(mine.items.length, 1);
  assert.equal(mine.items[0].slotId, s.shared.slots[0].id);
  assert.deepEqual(mine.items[0].coVolunteers, [{ name: 'Bea Volunteer', positionName: 'Keys' }]);
  for (const c of mine.items[0].coVolunteers) assert.deepEqual(Object.keys(c).sort(), ['name', 'positionName']);
  // A date window cannot be used to reach someone else's slots.
  const wide = (await s.ann.get('/api/me/schedule?from=2025-01-01')).json;
  assert.deepEqual(wide.items.map((i) => i.slotId), [s.shared.slots[0].id]);
}));

test('isolation: nothing a volunteer can read leaks another volunteer\'s schedule, blockouts, username or ids', () => withApp(async (ctx) => {
  const s = await twoVolunteers(ctx);
  const before = ctx.client.responses.length;
  // Every GET a member may call (none of them takes an id: a member only ever
  // reads their own things), plus date windows over the other people's dates.
  const memberGets = ctx.routes.filter((x) => x.auth === 'login' && x.method === 'GET');
  assert.ok(memberGets.length >= 5);
  assert.deepEqual(memberGets.filter((r) => r.pattern.includes(':')).map(key), []);
  for (const r of memberGets) await s.ann.get(r.pattern);
  for (const from of ['2025-01-19', '2025-01-26', '2025-02-02']) await s.ann.get(`/api/me/schedule?from=${from}`);
  const seen = ctx.client.responses.slice(before).map((r) => r.text).join('\n');
  for (const secret of ['bea.secret', 'cal.secret', 'Bea Only Evening', 'Cal Only Night', 'Bea private reason', '2025-02-02', 'Cal Elsewhere', '"personId"', 'qualifiedPersonIds', 'passwordHash']) {
    assert.ok(!seen.includes(secret), `a volunteer could read ${secret}`);
  }
  // Admin-only data stays admin-only.
  assert.equal((await s.ann.get(`/api/people/${s.beaId}/blockouts`)).status, 403);
  assert.equal((await s.ann.get('/api/blockouts')).status, 403);
  assert.equal((await s.ann.get('/api/people')).status, 403);
}));

test('isolation: a volunteer cannot answer, see or delete another volunteer\'s slot or blockout', () => withApp(async (ctx) => {
  const s = await twoVolunteers(ctx);
  for (const action of ['accept', 'decline']) {
    const res = await s.ann.post(`/api/me/slots/${s.shared.slots[1].id}/${action}`);
    assert.equal(res.status, 404, action);
    assert.ok(!res.text.includes('Bea'));
  }
  const del = await s.ann.del(`/api/me/blockouts/${s.blk.id}`);
  assert.equal(del.status, 404);
  const beas = (await s.bea.get('/api/me/blockouts')).json.blockouts;
  assert.deepEqual(beas.map((b) => b.id), [s.blk.id], 'Bea still has her blockout');
  const beaSchedule = (await s.bea.get('/api/me/schedule')).json.items;
  assert.ok(beaSchedule.every((i) => i.status === 'pending'), 'Bea\'s answers did not change');
}));

// ---------- sessions and cookies ----------

test('cookies: HttpOnly, SameSite=Lax, Path=/, Secure only when configured or behind HTTPS', async () => {
  const flags = (res) => String(res.headers['set-cookie']).split(';').map((x) => x.trim());
  await withApp(async (ctx) => {
    await addPerson(ctx.app, { name: 'Max Member', username: 'max' });
    const b = ctx.client.browser();
    const plain = flags(await b.post('/api/login', { username: 'max', password: 'test-pass-1' }));
    for (const f of ['HttpOnly', 'SameSite=Lax', 'Path=/']) assert.ok(plain.includes(f), f);
    assert.ok(!plain.includes('Secure'));
    const proxied = flags(await b.post('/api/login', { username: 'max', password: 'test-pass-1' }, { headers: { 'X-Forwarded-Proto': 'https' } }));
    assert.ok(proxied.includes('Secure'));
    b.cookie = cookieFrom(await b.post('/api/login', { username: 'max', password: 'test-pass-1' }));
    const out = flags(await b.post('/api/logout'));
    assert.ok(out.includes('Max-Age=0') && out.includes('HttpOnly') && out.includes('SameSite=Lax'));
  });
  await withApp(async (ctx) => {
    await addPerson(ctx.app, { name: 'Max Member', username: 'max' });
    const secure = flags(await ctx.client.browser().post('/api/login', { username: 'max', password: 'test-pass-1' }));
    for (const f of ['HttpOnly', 'SameSite=Lax', 'Secure']) assert.ok(secure.includes(f), f);
  }, { config: { ...loadConfig({ FLOCK_SECURE_COOKIES: '1' }), dbPath: ':memory:' } });
});

test('sessions: every login gets a new token; a planted cookie is never adopted', () => withApp(async (ctx) => {
  await addPerson(ctx.app, { name: 'Max Member', username: 'max' });
  const planted = 'flock_session=attacker-chosen-value-1234567890';
  const b = ctx.client.browser(planted);
  const tokens = new Set();
  for (let i = 0; i < 3; i++) {
    const res = await b.call('POST', '/api/login', { username: 'max', password: 'test-pass-1' });
    const c = cookieFrom(res);
    assert.notEqual(c, planted);
    assert.match(c, /^flock_session=[A-Za-z0-9_-]{32,}$/);
    tokens.add(c);
  }
  assert.equal(tokens.size, 3);
  assert.equal((await ctx.client.browser(planted).get('/api/me')).status, 401);
  // After logout the old token is dead.
  const [first] = tokens;
  const old = ctx.client.browser(first);
  assert.equal((await old.post('/api/logout')).status, 200);
  assert.equal((await old.get('/api/me')).status, 401);
}));

// The test hasher, recording every hash it makes (including ones replaced later).
function recordingHasher() {
  const inner = fastHasher({ env: {} });
  const made = [];
  return { made, hash: async (pw) => { const h = await inner.hash(pw); made.push(h); return h; }, verify: (pw, h) => inner.verify(pw, h) };
}
const secretsHasher = recordingHasher();

test('secrets: hashes, credentials and invite tokens stay out of public responses, audit and logs', () => withApp(async (ctx) => {
  const { admin } = await adminAndMember(ctx);
  const created = (await admin.post('/api/people', { name: 'Tess Invite', username: 'tess' })).json;
  const renewed = (await admin.post(`/api/people/${created.person.id}/invite`)).json;
  const invite1 = tokenFromLink(created.invite.link);
  const invite2 = tokenFromLink(renewed.invite.link);
  const tess = ctx.client.browser();
  assert.equal((await tess.login('tess', 'not yet chosen')).status, 401);
  assert.equal((await tess.welcome(invite2, 'tess-own-pass-9')).status, 200);
  assert.equal((await tess.post('/api/password', { oldPassword: 'tess-own-pass-9', newPassword: 'tess-first-change-9' })).status, 200);
  const reset = (await admin.post(`/api/people/${created.person.id}/reset-password`)).json;
  const invite3 = tokenFromLink(reset.invite.link);
  assert.equal((await tess.welcome(invite3, 'tess-second-pass-9')).status, 200);
  assert.equal((await tess.post('/api/password', { oldPassword: 'tess-second-pass-9', newPassword: 'tess-final-pass-9' })).status, 200);
  for (let i = 0; i < 6; i++) await ctx.client.browser().post('/api/login', { username: 'max', password: `wrong-guess-${i}` });
  await admin.get('/api/people');
  await admin.get('/api/me');
  await tess.get('/api/me');
  await tess.post('/api/logout');

  const hashes = [...secretsHasher.made];
  for (const id of [1, 2, created.person.id]) assert.ok(hashes.includes((await ctx.app.data.people.findAuthById(id)).passwordHash));
  const tokens = ctx.client.responses.map(cookieFrom).filter(Boolean).map((c) => c.split('=')[1]).filter((t) => t.length > 10);
  const tokenHashes = tokens.map(tokenHash);
  const invites = [invite1, invite2, invite3];
  const inviteHashes = invites.map(tokenHash);
  assert.ok(hashes.length >= 6 && hashes.every((h) => typeof h === 'string' && h.length > 10));
  assert.ok(tokens.length >= 4);
  for (const live of ctx.app.db.prepare('SELECT token_hash FROM sessions').all()) assert.ok(tokenHashes.includes(live.token_hash));
  const passwords = ['test-pass-1', 'not yet chosen', 'tess-own-pass-9', 'tess-first-change-9', 'tess-second-pass-9', 'tess-final-pass-9', 'wrong-guess-0', 'wrong-guess-5'];

  const audit = JSON.stringify(await ctx.app.data.audit.list(1000));
  const logs = ctx.lines.join('\n');
  assert.ok(ctx.lines.length > 20);
  for (const [where, text] of [['audit', audit], ['log', logs]]) {
    for (const secret of [...hashes, ...tokenHashes, ...tokens, ...passwords, ...invites, ...inviteHashes]) {
      assert.ok(!text.includes(secret), `${where} contains a secret (${secret.slice(0, 6)}…)`);
    }
    assert.ok(!/passwordHash|password_hash|tokenHash/.test(text.replace(/"\[REDACTED\]"/g, '')));
  }
  for (const r of ctx.client.responses) {
    for (const secret of [...hashes, ...tokenHashes, ...tokens, ...passwords, ...inviteHashes]) assert.ok(!r.text.includes(secret), `${r.method} ${r.path} body contains a secret`);
    assert.ok(!/passwordHash|password_hash|tokenHash|failedLogins|lockedUntil/.test(r.text));
    const handsOut = r.method === 'POST' && (r.path === '/api/people' || r.path.endsWith('/reset-password') || r.path.endsWith('/invite'));
    if (!handsOut) for (const invite of invites) assert.ok(!r.text.includes(invite), `${r.method} ${r.path} repeats an invite token`);
    for (const invite of invites) assert.ok(!r.path.includes(invite), 'an invite token reached an HTTP URL');
  }
}, { hasher: secretsHasher }));

test('login: lockout after 5 wrong passwords, then throttle per IP, over HTTP', () => withApp(async (ctx) => {
  await addPerson(ctx.app, { name: 'Max Member', username: 'max' });
  const b = ctx.client.browser();
  for (let i = 0; i < 5; i++) assert.equal((await b.post('/api/login', { username: 'max', password: 'nope-nope' })).status, 401);
  const locked = await b.post('/api/login', { username: 'max', password: 'test-pass-1' });
  assert.equal(locked.status, 429, 'even the right password is refused while locked');
  assert.ok(Number(locked.headers['retry-after']) > 0);
  assert.equal(locked.headers['set-cookie'], undefined);
  ctx.clock.advance(16 * 60 * 1000);
  assert.equal((await b.post('/api/login', { username: 'max', password: 'test-pass-1' })).status, 200, 'the lock ends');
  // Per-IP throttle: 20 attempts in 5 minutes, whatever the usernames.
  ctx.clock.advance(6 * 60 * 1000);
  for (let i = 0; i < 20; i++) await b.post('/api/login', { username: `ghost${i}`, password: 'x-x-x-x-x' });
  const throttled = await b.post('/api/login', { username: 'max', password: 'test-pass-1' });
  assert.equal(throttled.status, 429);
  assert.ok(Number(throttled.headers['retry-after']) > 0);
  ctx.clock.advance(5 * 60 * 1000 + 1);
  assert.equal((await b.post('/api/login', { username: 'max', password: 'test-pass-1' })).status, 200);
}));

// ---------- transport-level limits ----------

test('body size limit: over 100 KB is 413 on login and on a logged-in route; nothing is stored', () => withApp(async (ctx) => {
  const { admin } = await adminAndMember(ctx);
  const big = JSON.stringify({ name: 'x'.repeat(BODY_LIMIT + 10) });
  const anon = await ctx.client.browser().call('POST', '/api/login', big);
  assert.equal(anon.status, 413);
  const res = await admin.call('POST', '/api/teams', big);
  assert.equal(res.status, 413);
  assert.deepEqual(res.json, { error: 'That request is too big' });
  assert.deepEqual((await admin.get('/api/teams')).json, []);
  // Just under the limit is read (and then refused by the rules, not the size).
  const near = await admin.call('POST', '/api/teams', JSON.stringify({ name: 'y'.repeat(BODY_LIMIT - 100) }));
  assert.equal(near.status, 400);
}));

test('static files: traversal in every encoding is 404 and never shows a file outside web/', () => withApp(async ({ app }) => {
  const probes = [
    '/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/%2e%2e%2fpackage.json', '/..%2f..%2fsrc%2fdb.js',
    '/%2E%2E/%2E%2E/src/db.js', '/..%5cpackage.json', '/%5c..%5cpackage.json', '/views/..%2f..%2fpackage.json',
    '/%252e%252e/package.json', '/..%252fpackage.json', '/index.html%00.js', '/%00', '/..;/package.json',
    '/lib/../../package.json', '/./../src/server.js', '//etc/passwd', '/%2fetc%2fpasswd', '/C:%5cWindows%5cwin.ini',
    '/.git/config', '/.hal/brief.md', '/data/flock.db',
  ];
  for (const p of probes) {
    const res = await app.request('GET', p);
    assert.equal(res.status, 404, `${p} gave ${res.status}`);
    assert.ok(!/"version"|DatabaseSync|root:|\[core\]/.test(res.text), `${p} leaked a file`);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  }
  assert.equal((await app.request('GET', '/')).status, 200);
  assert.equal((await app.request('GET', '/app.js')).status, 200);
}));

test('headers: security headers and an X-Request-Id on every response, whatever the outcome', () => withApp(async (ctx) => {
  const { admin, member } = await adminAndMember(ctx);
  const anon = ctx.client.browser();
  const start = ctx.client.responses.length;
  for (const r of ctx.routes) {
    const body = MUTATING.has(r.method) ? {} : undefined;
    await anon.call(r.method, fillPath(r.pattern), body);
    await member.call(r.method, fillPath(r.pattern), body, { csrf: r.method === 'GET' });
    if (r.method === 'GET') await admin.get(fillPath(r.pattern, '999'));
  }
  for (const p of ['/', '/index.html', '/style.css', '/app.js', '/nope.html', '/api/nope', '/api']) await anon.get(p);
  await anon.call('POST', '/', {});
  await anon.call('DELETE', '/api/me', undefined);
  await anon.call('POST', '/api/login', '{not json');
  await anon.call('POST', '/api/login', JSON.stringify({ x: 'y'.repeat(BODY_LIMIT) }));
  const seenIds = new Set();
  const checked = ctx.client.responses.slice(start);
  assert.ok(checked.length > 80);
  const statuses = new Set();
  for (const r of checked) {
    const h = r.headers;
    statuses.add(r.status);
    const where = `${r.method} ${r.path} (${r.status})`;
    assert.match(h['content-security-policy'] ?? '', /default-src 'self'/, where);
    assert.match(h['content-security-policy'] ?? '', /frame-ancestors 'none'/, where);
    assert.equal(h['x-content-type-options'], 'nosniff', where);
    assert.equal(h['referrer-policy'], 'no-referrer', where);
    assert.equal(h['x-frame-options'], 'DENY', where);
    if (r.path.startsWith('/api')) assert.equal(h['cache-control'], 'no-store', where);
    assert.match(h['x-request-id'] ?? '', /^[A-Za-z0-9._:-]{8,64}$/, where);
    seenIds.add(h['x-request-id']);
  }
  for (const s of [200, 400, 401, 403, 404, 405, 413]) assert.ok(statuses.has(s), `no ${s} response was checked`);
  assert.equal(seenIds.size, checked.length, 'every request id is different');
  // A safe incoming id is echoed; an unsafe one is replaced.
  assert.equal((await anon.get('/api/health', { headers: { 'X-Request-Id': 'req-12345678' } })).headers['x-request-id'], 'req-12345678');
  const bad = (await anon.get('/api/health', { headers: { 'X-Request-Id': '<script>alert(1)</script>' } })).headers['x-request-id'];
  assert.match(bad, /^[A-Za-z0-9._:-]{8,64}$/);
  // The id is in the request log line too.
  const logged = ctx.lines.map((l) => JSON.parse(l)).filter((l) => l.msg === 'request');
  assert.ok(logged.some((l) => l.requestId === 'req-12345678'));
}));

// ---------- stored XSS ----------

const HOSTILE = {
  name: '<script>alert("n")</script>Hal',
  team: '<img src=x onerror=alert(1)>',
  position: '"><svg onload=alert(2)>',
  title: '</title><script>alert(3)</script>',
  reason: '<iframe src="javascript:alert(4)"></iframe>',
};
const RAW_TAG = /<(?:script|img|svg|iframe)\b|javascript:alert\(4\)"/i;

function webApi(app, cookie) {
  return createApi((url, init) => fetch(app.url + url, { ...init, headers: { ...init.headers, Cookie: cookie } }));
}

function allHtml(root) {
  const parts = root.parts ? [...root.parts.values()].map((p) => p.innerHTML) : [];
  return [root.innerHTML, ...parts].join('\n');
}

function assertSafe(html, where) {
  assert.ok(!RAW_TAG.test(html), `${where} renders raw markup: ${html.match(RAW_TAG)?.[0]}`);
}

async function hostileWorld(ctx) {
  const { admin, adminId } = await adminAndMember(ctx);
  const created = await admin.post('/api/people', { name: HOSTILE.name, username: 'hal.test' });
  assert.equal(created.status, 201, created.text);
  const halId = created.json.person.id;
  const team = (await admin.post('/api/teams', { name: HOSTILE.team })).json;
  const pos = (await admin.post(`/api/teams/${team.id}/positions`, { name: HOSTILE.position })).json;
  assert.ok(team.id && pos.id);
  const annId = await addPerson(ctx.app, { name: 'Ann Volunteer', username: 'ann' });
  for (const id of [halId, annId]) assert.equal((await admin.put(`/api/people/${id}/positions`, { positionIds: [pos.id] })).status, 200);
  const s1 = (await admin.post('/api/services', { date: '2025-01-12', title: HOSTILE.title, slots: [{ positionId: pos.id, count: 2 }] })).json;
  const s2 = (await admin.post('/api/services', { date: '2025-01-19', title: HOSTILE.title, slots: [{ positionId: pos.id }] })).json;
  assert.equal((await admin.put(`/api/slots/${s1.slots[0].id}/assign`, { personId: annId })).status, 200);
  assert.equal((await admin.put(`/api/slots/${s1.slots[1].id}/assign`, { personId: halId })).status, 200);
  const hal = ctx.client.browser();
  assert.equal((await hal.welcome(tokenFromLink(created.json.invite.link), 'hal-new-pass-1')).status, 200);
  const blk = await hal.post('/api/me/blockouts', { startDate: '2025-01-19', reason: HOSTILE.reason });
  assert.equal(blk.status, 201, blk.text);
  const ann = ctx.client.browser();
  await ann.login('ann', 'test-pass-1');
  return { admin, adminId, hal, ann, halId, annId, team, pos, s1, s2 };
}

test('stored XSS: hostile names, titles and reasons come back exactly, as JSON data', () => withApp(async (ctx) => {
  const w = await hostileWorld(ctx);
  const checks = [
    [await w.admin.get('/api/people'), (j) => j.find((p) => p.id === w.halId).name, HOSTILE.name],
    [await w.admin.get('/api/teams'), (j) => j[0].name, HOSTILE.team],
    [await w.admin.get('/api/teams'), (j) => j[0].positions[0].name, HOSTILE.position],
    [await w.admin.get('/api/services?from=2025-01-01&to=2025-02-01'), (j) => j[0].title, HOSTILE.title],
    [await w.hal.get('/api/me/blockouts'), (j) => j.blockouts[0].reason, HOSTILE.reason],
    [await w.admin.get('/api/blockouts'), (j) => j.blockouts[0].personName, HOSTILE.name],
    [await w.ann.get('/api/me/schedule'), (j) => j.items[0].coVolunteers[0].name, HOSTILE.name],
    [await w.admin.get('/api/admin/reminders?weekOf=2025-01-12'), (j) => j.reminders.find((r) => r.personId === w.halId).name, HOSTILE.name],
    [await w.hal.get('/api/me'), (j) => j.person.name, HOSTILE.name],
  ];
  for (const [res, pick, want] of checks) {
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(pick(res.json), want);
  }
}));

test('stored XSS: every web/views/*.js render path escapes hostile data from the real API', () => withApp(async (ctx) => {
  const w = await hostileWorld(ctx);
  const adminApi = webApi(ctx.app, w.admin.cookie);
  const covered = new Set();
  const today = '2025-01-05';
  const screen = async (name, opts = {}) => {
    const view = await import(`../web/views/${name}.js`);
    const root = screenRoot();
    const s = view.createScreen({ api: adminApi, root, today, ...opts });
    await s.ready;
    covered.add(name);
    return { root, s };
  };
  const flush = () => new Promise((r) => setImmediate(r));

  // People: list, then the positions and reset panels for the hostile person.
  {
    const { root } = await screen('admin-people', { win: {} });
    const out = allHtml(root);
    assert.ok(out.includes('&lt;script&gt;alert(&quot;n&quot;)&lt;/script&gt;Hal') || out.includes('&lt;script&gt;'), 'the hostile name is shown, escaped');
    assertSafe(out, 'admin-people list');
    for (const action of ['positions', 'reset-ask', 'active-ask', 'role-ask', 'edit']) {
      root.click(action, w.halId);
      await flush();
      assertSafe(allHtml(root), `admin-people ${action}`);
    }
  }
  // Teams.
  {
    const { root } = await screen('admin-teams');
    assert.ok(allHtml(root).includes('&lt;img'), 'team name shown');
    assertSafe(allHtml(root), 'admin-teams');
    for (const action of ['rename-team', 'delete-team']) { root.click(action, w.team.id); await flush(); assertSafe(allHtml(root), `admin-teams ${action}`); }
    for (const action of ['rename-position', 'delete-position']) { root.click(action, w.pos.id); await flush(); assertSafe(allHtml(root), `admin-teams ${action}`); }
  }
  // Services.
  {
    const { root } = await screen('admin-services');
    assert.ok(allHtml(root).includes('&lt;/title&gt;'), 'title shown');
    assertSafe(allHtml(root), 'admin-services');
    for (const action of ['delete', 'repeat']) { root.click(action, w.s1.id); await flush(); assertSafe(allHtml(root), `admin-services ${action}`); }
  }
  // Schedule grid, the slot panel with suggestions, and a conflict naming the person.
  {
    const { root } = await screen('admin-schedule');
    assertSafe(allHtml(root), 'admin-schedule');
    await root.click('slot-open', w.s2.slots[0].id);
    await flush();
    assertSafe(allHtml(root), 'admin-schedule panel');
    await root.click('slot-toggle');
    await flush();
    const panel = allHtml(root);
    assert.ok(panel.includes('&lt;script&gt;'), 'the hostile candidate is listed');
    assertSafe(panel, 'admin-schedule suggestions');
    await root.click('slot-assign', w.halId); // blocked on that date: a conflict message with the name
    await flush();
    assertSafe(allHtml(root), 'admin-schedule conflict');
    await root.click('slot-open', w.s1.slots[1].id);
    await flush();
    await root.click('slot-remove-ask');
    await flush();
    assertSafe(allHtml(root), 'admin-schedule remove confirm');
  }
  // Gaps, suggestions and reminder drafts.
  {
    const { root } = await screen('admin-gaps', { win: {} });
    assertSafe(allHtml(root), 'admin-gaps');
    await root.click('slot-open', w.s2.slots[0].id);
    await flush();
    assertSafe(allHtml(root), 'admin-gaps panel');
    await root.submit('reminders', { weekOf: '2025-01-12' });
    await flush();
    const out = allHtml(root);
    assert.ok(out.includes('&lt;script&gt;'), 'the reminder for the hostile person is shown');
    assertSafe(out, 'admin-gaps reminders');
  }
  // Member pages, through mount() like the app does.
  for (const [name, who] of [['my-schedule', w.ann], ['my-blockouts', w.hal]]) {
    const view = await import(`../web/views/${name}.js`);
    const root = hostRoot();
    await view.mount(root, { api: webApi(ctx.app, who.cookie), state: { user: { name: HOSTILE.name, role: 'member' } }, today });
    const out = allHtml(root);
    assert.ok(out.includes('&lt;'), `${name} shows the hostile text`);
    assertSafe(out, name);
    covered.add(name);
  }
  // Pages that render straight from state or messages.
  const state = { user: { id: w.halId, name: HOSTILE.name, role: 'admin' } };
  const direct = {
    nav: (v) => v.render(state, '#/'),
    login: (v) => v.render({}, { error: HOSTILE.reason, username: HOSTILE.position }),
    welcome: (v) => v.render({}, { info: { name: HOSTILE.name, username: HOSTILE.position }, error: HOSTILE.reason }),
    password: (v) => v.render(state, { error: HOSTILE.title }),
    notfound: (v) => v.render(state),
  };
  for (const [name, run] of Object.entries(direct)) {
    const out = run(await import(`../web/views/${name}.js`));
    assertSafe(out, name);
    covered.add(name);
  }
  // Every view file is covered by this test (a new view must be added here).
  const files = readdirSync(WEB_VIEWS).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, '')).sort();
  assert.deepEqual([...covered].sort(), files);
}));
