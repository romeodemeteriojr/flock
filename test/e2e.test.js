// End to end over real HTTP (final QA, C-78): the whole life of a volunteer,
// from the first scheduler made on the command line to deactivation; that the
// same inputs and a fixed clock give the same API output; that every file the
// web app references exists; and that `npm start` starts and stops cleanly.
// Made-up people only, temporary folders, never the real home folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp } from './helpers/app.js';
import { createClient, tokenFromLink } from './helpers/client.js';
import { loadConfig } from '../src/config.js';
import { importsOf } from './helpers/source.js';
import { openDb } from '../src/db.js';
import { fixedClock } from '../src/infra/clock.js';
import { seededRandom } from '../src/infra/random.js';
import { scryptHasher } from '../src/infra/hasher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'flock.js');
const NOW = '2025-01-05T12:00:00.000Z'; // a Sunday

function tmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'flock-e2e-'));
  return { dir, db: path.join(dir, 'church.db'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

// A child process gets only PATH and a temporary HOME: never the real environment.
const childEnv = (dir, extra = {}) => ({ PATH: process.env.PATH, HOME: dir, ...extra });

/**
 * The scheduling story after the first scheduler exists. Returns a transcript
 * of every API answer (status and JSON) so runs can be compared.
 */
async function story(app, { adminEmail, adminToken }) {
  const client = createClient(app);
  const log = [];
  const note = (label, res) => { log.push({ label, status: res.status, json: res.json ?? null, requestId: res.headers['x-request-id'] }); return res; };
  const admin = client.browser();

  // The first scheduler follows an invite, chooses a password and is logged in.
  const info = note('admin invite', await admin.post('/api/welcome/check', { token: adminToken }));
  assert.equal(info.json.email, adminEmail);
  const first = note('admin joined', await admin.welcome(adminToken, 'pat-own-password-1'));
  assert.equal(first.status, 200);
  assert.equal(first.json.person.hasPassword, true);
  assert.equal(note('admin me', await admin.get('/api/me')).json.person.hasPassword, true);

  // A team with positions.
  const team = note('team', await admin.post('/api/teams', { name: 'Worship' })).json;
  const vocals = note('vocals', await admin.post(`/api/teams/${team.id}/positions`, { name: 'Vocals' })).json;
  const guitar = note('guitar', await admin.post(`/api/teams/${team.id}/positions`, { name: 'Guitar' })).json;
  assert.ok(team.id && vocals.id && guitar.id);

  // A person, added with a one-time invite.
  const added = note('add person', await admin.post('/api/people', { name: 'Rae Example', email: 'rae.example@example.com' }));
  assert.equal(added.status, 201);
  const rae = added.json.person;
  assert.equal(rae.joined, false);
  const raeToken = tokenFromLink(added.json.invite.link);
  assert.match(raeToken, /^[A-Za-z0-9_-]{43}$/);

  // An unclaimed account has no login; the phone joins directly through its invite.
  const phone = client.browser();
  assert.equal(note('rae blocked', await phone.get('/api/me/schedule')).status, 401);
  assert.equal(note('rae short password', await phone.welcome(raeToken, 'short')).status, 400);
  const raeJoined = note('rae joined', await phone.welcome(raeToken, 'rae-own-password-1'));
  assert.equal(raeJoined.status, 200);
  assert.equal(raeJoined.json.person.hasPassword, true);
  assert.deepEqual(note('rae empty schedule', await phone.get('/api/me/schedule')).json, { nextServing: null, items: [] });

  // The scheduler qualifies and schedules them on a new service.
  assert.deepEqual(note('qualify', await admin.put(`/api/people/${rae.id}/positions`, { positionIds: [vocals.id] })).json, { positionIds: [vocals.id] });
  const svc = note('service', await admin.post('/api/services', { date: '2025-01-12', time: '10:30', title: 'Sunday morning', slots: [{ positionId: vocals.id }, { positionId: guitar.id }] })).json;
  assert.equal(svc.slots.length, 2);
  const vocalSlot = svc.slots.find((s) => s.positionId === vocals.id);
  const guitarSlot = svc.slots.find((s) => s.positionId === guitar.id);
  const assigned = note('assign', await admin.put(`/api/slots/${vocalSlot.id}/assign`, { personId: rae.id }));
  assert.equal(assigned.status, 200);
  assert.equal(assigned.json.slot.status, 'pending');

  // The person sees it and accepts.
  const mine = note('rae schedule', await phone.get('/api/me/schedule')).json;
  assert.equal(mine.items.length, 1);
  assert.deepEqual(
    { slotId: mine.nextServing.slotId, date: mine.nextServing.date, time: mine.nextServing.time, positionName: mine.nextServing.positionName, status: mine.nextServing.status },
    { slotId: vocalSlot.id, date: '2025-01-12', time: '10:30', positionName: 'Vocals', status: 'pending' },
  );
  assert.equal(note('accept', await phone.post(`/api/me/slots/${vocalSlot.id}/accept`)).json.slot.status, 'accepted');
  assert.equal(note('rae schedule after', await phone.get('/api/me/schedule')).json.items[0].status, 'accepted');

  // A blockout on another date.
  const blk = note('blockout', await phone.post('/api/me/blockouts', { startDate: '2025-01-19', reason: 'Family visit' }));
  assert.equal(blk.status, 201);
  assert.deepEqual(blk.json.conflicts, []);
  assert.equal(note('my blockouts', await phone.get('/api/me/blockouts')).json.blockouts.length, 1);

  // The scheduler sees gaps, suggestions and the reminder draft.
  const next = note('service 2', await admin.post('/api/services', { date: '2025-01-19', title: 'Sunday morning', slots: [{ positionId: vocals.id }] })).json;
  const gaps = note('gaps', await admin.get('/api/admin/gaps')).json;
  const gapSlots = gaps.items.map((g) => [g.type, g.slotId]);
  assert.deepEqual(gapSlots.filter(([, id]) => id === guitarSlot.id), [['open', guitarSlot.id]]);
  assert.ok(gapSlots.some(([type, id]) => type === 'open' && id === next.slots[0].id));
  assert.ok(!gaps.items.some((g) => g.slotId === vocalSlot.id), 'an accepted slot is not a gap');
  assert.ok(gaps.summary.open >= 2);
  const blockedSuggest = note('suggest blocked', await admin.get(`/api/admin/suggest?slotId=${next.slots[0].id}`)).json;
  assert.ok(!blockedSuggest.candidates.some((c) => c.personId === rae.id), 'a blocked-out person is not suggested');
  const otherSuggest = note('suggest guitar', await admin.get(`/api/admin/suggest?slotId=${guitarSlot.id}&includeUnqualified=true`)).json;
  assert.ok(Array.isArray(otherSuggest.candidates));
  const reminders = note('reminders', await admin.get('/api/admin/reminders?weekOf=2025-01-12')).json.reminders;
  const forRae = reminders.find((r) => r.personId === rae.id);
  assert.ok(forRae, 'Rae has a reminder draft');
  assert.match(forRae.message, /Rae/);
  assert.match(forRae.message, /Vocals/);

  // The scheduler deactivates the person, who is logged out and cannot log in.
  const off = note('deactivate', await admin.patch(`/api/people/${rae.id}`, { active: false }));
  assert.equal(off.json.person.active, false);
  assert.equal(note('rae after deactivation', await phone.get('/api/me/schedule')).status, 401);
  const again = note('rae login again', await client.browser().post('/api/login', { email: 'rae.example@example.com', password: 'rae-own-password-1' }));
  assert.equal(again.status, 401);
  assert.deepEqual(again.json, { error: 'Wrong email or password' });
  const list = note('people', await admin.get('/api/people')).json;
  assert.equal(list.find((p) => p.id === rae.id).active, false);
  return log;
}

test('e2e: first scheduler from the command line, then the whole volunteer story over HTTP', async () => {
  const t = tmp();
  try {
    const made = spawnSync(process.execPath, [BIN, 'create-admin', 'pat.example@example.com', 'Pat Example', '--db', t.db], { env: childEnv(t.dir), encoding: 'utf8', cwd: t.dir });
    assert.equal(made.status, 0, made.stderr);
    const adminToken = tokenFromLink(made.stdout.match(/Invite link \([^\n]+\): (\S+)/)[1]);
    // The command line hashed with the real scrypt hasher, so the app uses it too.
    const app = await startTestApp({ db: openDb(t.db), container: { clock: fixedClock(NOW), hasher: scryptHasher({ random: seededRandom('salt') }) } });
    try {
      const log = await story(app, { adminEmail: 'pat.example@example.com', adminToken });
      assert.ok(log.length > 25, `only ${log.length} steps`);
      // The audit trail recorded the scheduler's changes.
      const actions = (await app.data.audit.list(200)).map((a) => a.action);
      for (const a of ['person.create', 'slot.assign', 'slot.accept']) assert.ok(actions.includes(a), `no ${a} in ${actions.join(', ')}`);
    } finally {
      await app.close();
      app.db.close();
    }
  } finally { t.done(); }
});

test('e2e: determinism: the same inputs and a fixed clock give identical API output', async () => {
  const run = async () => {
    const app = await startTestApp({ config: { ...loadConfig({}), publicUrl: 'https://flock.example.org' }, container: { clock: fixedClock(NOW), random: seededRandom('e2e') } });
    try {
      const created = await app.container.services.people.create(null, { name: 'Pat Example', email: 'pat.example@example.com', role: 'admin' });
      return await story(app, { adminEmail: 'pat.example@example.com', adminToken: created.invite.token });
    } finally { await app.close(); }
  };
  const a = await run();
  const b = await run();
  assert.equal(a.length, b.length);
  assert.deepEqual(a, b);
  // Not trivially equal: there really were ids, times and tokens in there.
  const text = JSON.stringify(a);
  assert.match(text, /"assignedAt":"\d{4}-/);
  assert.match(text, /"link":"https:\/\/flock\.example\.org\/#\/welcome\?token=[A-Za-z0-9_-]{43}"/);
});

test('e2e: every file referenced by web/index.html and imported by web modules exists', () => {
  const webRoot = path.join(ROOT, 'web');
  const html = readFileSync(path.join(webRoot, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.ok(refs.length >= 2, `index.html references ${refs.join(', ')}`);
  const missing = [];
  for (const ref of refs) {
    if (/^(?:[a-z]+:)?\/\//i.test(ref) || ref.startsWith('#') || ref.startsWith('data:')) continue;
    const file = path.join(webRoot, ref.replace(/^\//, '').split(/[?#]/)[0]);
    if (!existsSync(file)) missing.push(`index.html -> ${ref}`);
  }
  const jsFiles = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith('.js')) jsFiles.push(abs);
    }
  };
  walk(webRoot);
  assert.ok(jsFiles.length >= 15);
  let imports = 0;
  for (const file of jsFiles) {
    for (const im of importsOf(readFileSync(file, 'utf8'))) {
      imports++;
      if (!im.spec.startsWith('.')) { missing.push(`${path.relative(ROOT, file)} imports a package: ${im.spec}`); continue; }
      const target = path.resolve(path.dirname(file), im.spec);
      if (!target.startsWith(webRoot + path.sep)) missing.push(`${path.relative(ROOT, file)} reaches outside web/: ${im.spec}`);
      else if (!existsSync(target)) missing.push(`${path.relative(ROOT, file)} -> ${im.spec}`);
    }
  }
  assert.ok(imports >= 20);
  assert.deepEqual(missing, []);
});

test('e2e: npm start serves the app on a temp database and stops cleanly on SIGTERM', { timeout: 30000 }, async (tc) => {
  const t = tmp();
  const child = spawn('npm', ['start'], {
    cwd: ROOT,
    env: childEnv(t.dir, { FLOCK_DB: t.db, FLOCK_PORT: '0' }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // its own process group, so we can check nothing is left
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  // Runs even if the test times out: never leave a server behind.
  tc.after(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    t.done();
  });
  {
    const port = await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const m = out.match(/running at http:\/\/localhost:(\d+)/);
        if (m) { clearInterval(timer); resolve(Number(m[1])); }
      }, 25);
      exited.then(() => { clearInterval(timer); reject(new Error(`npm start exited early:\n${out}\n${err}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /<div id="app"/);
    const asset = await fetch(`${base}/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /text\/javascript/);
    await asset.text();
    assert.ok(existsSync(t.db), 'the database was created at the temp path');

    // SIGTERM goes to the flock server itself (npm and its shell just wait for it).
    const serverPid = JSON.parse(out.split('\n').find((l) => l.includes('"flock started"'))).pid;
    assert.notEqual(serverPid, process.pid);
    process.kill(serverPid, 'SIGTERM');
    const { code, signal } = await exited;
    assert.equal(code, 0, `exit ${code} ${signal}\n${err}`);
    assert.match(out, /"msg":"flock stopping","signal":"SIGTERM"/);
    // stderr may hold runtime or npm notices on some machines, but never an error.
    assert.doesNotMatch(err, /\bError\b|failed|Unhandled/, err);
    // Nothing is left running: not the server, not anything in its group, and the port is closed.
    await new Promise((r) => setTimeout(r, 100));
    assert.throws(() => process.kill(serverPid, 0), { code: 'ESRCH' });
    assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' });
    await assert.rejects(fetch(`${base}/api/health`));
  }
});

test('package.json: version 0.3.0, no dependencies, and the test, coverage and start scripts', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.3.0');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  // node:sqlite without a flag needs 22.13; DatabaseSync#isTransaction (used by tx) needs 22.16.
  assert.deepEqual(pkg.engines, { node: '>=22.16' });
  assert.deepEqual(pkg.scripts, {
    test: 'node --test',
    coverage: 'node --test --experimental-test-coverage',
    start: 'node bin/flock.js serve',
  });
  const version = spawnSync(process.execPath, [BIN, 'version'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(version.stdout.trim(), 'flock 0.3.0');
});
