// Backup and restore (C-83). A populated church database (made-up people) is
// backed up with the real CLI command, the backup is restored the way the
// README says (copy it, point FLOCK_DB at the copy, start flock) into a fresh
// app, and every table and relationship is compared. Sessions and password
// hashes must still work. A damaged, truncated, empty or foreign backup must be
// refused with a plain message. The CSV export must never contain a password
// hash, session token or invite token. Temporary folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createContainer } from '../src/container.js';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { DatabaseFileError } from '../src/db.js';
import { COOKIE_NAME } from '../src/guard.js';
import { tokenHash } from '../src/services/auth-service.js';
import { fixedClock } from '../src/infra/clock.js';
import { fastHasher } from '../src/infra/hasher.js';
import { seededRandom } from '../src/infra/random.js';
import { silentLogger } from '../src/infra/logger.js';
import { run } from '../src/cli/commands.js';
import { buildChurch, tableCounts, PASSWORD } from './helpers/church.js';

const NOW = '2025-01-05T12:00:00'; // a Sunday
const SUNDAYS = ['2025-01-12', '2025-01-19', '2025-01-26', '2025-02-02'];

function tmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'flock-backup-'));
  return { dir, file: (n) => path.join(dir, n), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const hasher = fastHasher({ env: {} });
const open = (dbPath, seed = 'backup') => createContainer({
  config: { ...loadConfig({}), dbPath }, clock: fixedClock(NOW), random: seededRandom(seed), hasher, logger: silentLogger(),
});

// Runs the CLI in this process and returns its exit code and output.
async function cli(argv) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    const code = await run(argv, {});
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

// A church with assignments, answers, blockouts, sessions, an invite and audit entries.
async function populate(c) {
  const church = await buildChurch(c, { members: 70, schedulers: 5, sundays: SUNDAYS });
  const { services } = c;
  const slots = church.services.flatMap((s) => s.slots);
  for (let i = 0; i < 24; i++) await services.assignments.assign(church.actor, slots[i].id, { personId: church.memberIds[i] });
  for (let i = 0; i < 16; i++) await services.assignments.respond(church.memberIds[i], slots[i].id, i % 4 ? 'accept' : 'decline');
  for (let i = 30; i < 40; i++) await services.blockouts.add(church.memberIds[i], { startDate: '2025-01-19', endDate: '2025-01-26', reason: `Holiday ${i}` });
  const tokens = [];
  for (let i = 1; i <= 10; i++) tokens.push((await services.auth.login(`member${i}@example.com`, PASSWORD)).token);
  tokens.push((await services.auth.login('sched1@example.com', PASSWORD)).token);
  const reset = await services.people.resetLogin(church.actor, church.memberIds[69]);
  return { church, tokens, invite: reset.invite };
}

// Key relationships, in terms that do not depend on row ids.
function relationships(db) {
  const q = (sql) => db.prepare(sql).all().map((r) => ({ ...r }));
  return {
    slots: q(`SELECT sv.date, sv.time, sv.title, t.name AS team, p.name AS position, pe.email, s.status, s.assigned_at, s.responded_at
      FROM slots s JOIN services sv ON sv.id = s.service_id JOIN positions p ON p.id = s.position_id
      JOIN teams t ON t.id = p.team_id LEFT JOIN people pe ON pe.id = s.person_id ORDER BY s.id`),
    qualifications: q(`SELECT pe.email, t.name AS team, p.name AS position FROM person_positions pp
      JOIN people pe ON pe.id = pp.person_id JOIN positions p ON p.id = pp.position_id JOIN teams t ON t.id = p.team_id
      ORDER BY pe.email, t.name, p.name`),
    blockouts: q(`SELECT pe.email, b.start_date, b.end_date, b.reason FROM blockouts b JOIN people pe ON pe.id = b.person_id ORDER BY b.id`),
    sessions: q(`SELECT pe.email, s.token_hash, s.expires_at FROM sessions s JOIN people pe ON pe.id = s.person_id ORDER BY s.id`),
    people: q('SELECT id, name, email, password_hash, role, active, failed_logins, locked_until, created_at FROM people ORDER BY id'),
    invites: q('SELECT person_id, token_hash, expires_at, created_at FROM invites ORDER BY person_id'),
    audit: q('SELECT * FROM audit ORDER BY id'),
    migrations: q('SELECT name FROM schema_migrations ORDER BY name'),
  };
}

// One populated database and its backup, shared by the tests below.
const t = tmp();
const SOURCE = t.file('church.db');
const BACKUP = t.file('backup-2025-01-05.db');
const source = open(SOURCE);
const state = await populate(source);
test.after(() => { try { source.close(); } finally { t.done(); } });

test('backup: the CLI writes a backup while the app is open, and refuses to overwrite it', async () => {
  const r = await cli(['backup', BACKUP, '--db', SOURCE]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Backup written to/);
  assert.ok(existsSync(BACKUP));
  const again = await cli(['backup', BACKUP, '--db', SOURCE]);
  assert.equal(again.code, 1);
  assert.match(again.err, /already exists/);
});

test('restore: a copy of the backup opens in a fresh app with every row and relationship the same', async () => {
  const restoredFile = t.file('restored.db');
  copyFileSync(BACKUP, restoredFile); // as the README says: restore from a copy
  const restored = open(restoredFile, 'restored');
  try {
    assert.deepEqual(tableCounts(restored.db), tableCounts(source.db), 'every table has the same number of rows');
    const counts = tableCounts(restored.db);
    assert.equal(counts.people, 75);
    assert.equal(counts.services, 4);
    assert.ok(counts.audit > 0 && counts.sessions === 11 && counts.blockouts === 10);
    assert.deepEqual(relationships(restored.db), relationships(source.db));
    assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(restored.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { restored.close(); }
});

test('restore: sessions and password hashes still work in the restored app, over HTTP', async () => {
  const restoredFile = t.file('restored-http.db');
  copyFileSync(BACKUP, restoredFile);
  const restored = open(restoredFile, 'restored-http');
  const app = createApp({ container: restored });
  const port = await app.listen(0);
  const call = async (method, p, { body, cookie } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Flock': '1', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    // Sessions made before the backup still log the person in.
    for (const [i, token] of state.tokens.entries()) {
      const me = await call('GET', '/api/me', { cookie: `${COOKIE_NAME}=${token}` });
      assert.equal(me.status, 200);
      assert.equal(me.json.person.email, i < 10 ? `member${i + 1}@example.com` : 'sched1@example.com');
    }
    // Stored password hashes still verify, for everyone.
    for (const handle of ['sched1', 'sched5', 'member1', 'member42', 'member69']) {
      assert.equal((await call('POST', '/api/login', { body: { email: `${handle}@example.com`, password: PASSWORD } })).status, 200, handle);
    }
    const joined = await call('POST', '/api/welcome', { body: { token: state.invite.token, password: 'member70 own password' } });
    assert.equal(joined.status, 200, 'an unused invite from before the backup works');
    assert.equal(joined.json.person.hasPassword, true);
    assert.equal((await call('POST', '/api/login', { body: { email: 'member1@example.com', password: 'not-the-password' } })).status, 401);
    // The schedule is there: member1 declined (i=0), member2 accepted.
    const sched = await call('GET', '/api/me/schedule', { cookie: `${COOKIE_NAME}=${state.tokens[1]}` });
    assert.deepEqual(sched.json.items.map((i) => [i.date, i.status]), [['2025-01-12', 'accepted']]);
  } finally {
    await app.close();
    restored.close();
  }
});

// ---------------------------------------------------------------- bad backups

function damaged(name, mutate) {
  const f = t.file(name);
  writeFileSync(f, mutate(readFileSync(BACKUP)));
  return f;
}

// Overwrites the first page of the people table with garbage.
function corruptPeoplePage(bytes) {
  const raw = new DatabaseSync(BACKUP, { readOnly: true });
  const pageSize = raw.prepare('PRAGMA page_size').get().page_size;
  const root = raw.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'people'").get().rootpage;
  raw.close();
  const b = Buffer.from(bytes);
  b.fill(0xa5, (root - 1) * pageSize, root * pageSize);
  return b;
}

const BAD = [
  ['a page overwritten with garbage', () => damaged('garbage-page.db', corruptPeoplePage)],
  ['cut off at half its size', () => damaged('half.db', (b) => b.subarray(0, Math.floor(b.length / 2)))],
  ['cut off after one page', () => damaged('one-page.db', (b) => b.subarray(0, 4096))],
  ['cut off inside the header', () => damaged('header.db', (b) => b.subarray(0, 50))],
  ['empty (0 bytes)', () => damaged('empty.db', () => Buffer.alloc(0))],
  ['not a database at all', () => damaged('text.db', () => Buffer.from('These are the minutes of the church meeting.\n'.repeat(200)))],
];

for (const [label, make] of BAD) {
  test(`restore: a backup that is ${label} is refused with a plain message`, async () => {
    const f = make();
    const before = readFileSync(f);
    // The container (what `serve` builds) refuses it.
    assert.throws(() => open(f), (e) => {
      assert.ok(e instanceof DatabaseFileError, `${e.name}: ${e.message}`);
      assert.match(e.message, /cannot be used|is empty/);
      assert.match(e.message, /backup/);
      return true;
    });
    // So does every CLI command, with one plain line and no SQLite jargon or stack.
    for (const argv of [
      ['serve', '--db', f],
      ['export', t.file(`${path.basename(f)}.csv`), '--db', f],
      ['backup', t.file(`${path.basename(f)}.bak`), '--db', f],
    ]) {
      const r = await cli(argv);
      assert.equal(r.code, 1, `${argv[0]} refuses it`);
      assert.match(r.err, new RegExp(`^The database file .*${path.basename(f)}`));
      assert.doesNotMatch(r.err, /SQLITE|malformed|failed:|\n\s+at /);
      assert.equal(r.err.split('\n').length, 1);
      assert.ok(!existsSync(argv[1]) || argv[0] === 'serve', 'nothing was written');
    }
    assert.deepEqual(readFileSync(f), before, 'the refused file is left exactly as it was');
  });
}

test('restore: a missing database file is still a new, empty install (unchanged)', () => {
  const c = open(t.file('brand-new.db'), 'new');
  try {
    assert.equal(tableCounts(c.db).people, 0);
  } finally { c.close(); }
});

// ---------------------------------------------------------------- export

test('export: the CSV holds the schedule and no password hash, session token or invite token', async () => {
  const csvFile = t.file('schedule.csv');
  const r = await cli(['export', csvFile, '--db', SOURCE]);
  assert.equal(r.code, 0, r.err);
  const csv = readFileSync(csvFile, 'utf8');
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'date,time,service,team,position,person,status');
  assert.equal(lines.length - 1, tableCounts(source.db).slots);
  assert.ok(csv.includes('Member 2'), 'names are exported');

  const secrets = [
    ...source.db.prepare('SELECT password_hash FROM people').all().map((x) => x.password_hash).filter(Boolean),
    ...source.db.prepare('SELECT token_hash FROM sessions').all().map((x) => x.token_hash),
    ...state.tokens,
    ...state.tokens.map(tokenHash),
    state.invite.token,
    tokenHash(state.invite.token),
  ];
  assert.ok(secrets.length > 80);
  for (const s of secrets) assert.ok(!csv.includes(s), 'a secret is in the export');
  for (const s of secrets) assert.ok(!r.out.includes(s) && !r.err.includes(s), 'a secret is in the CLI output');
  assert.doesNotMatch(csv, /fast\$|scrypt\$|password|token|@example\.com/i, 'no secrets or emails are exported');
});
