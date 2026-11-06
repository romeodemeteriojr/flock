// Upgrades (C-83): a database made at the oldest schema version the
// migrations support, holding data, is brought up to date by openDb; the data
// survives; opening it again changes nothing; and a database made by a NEWER
// flock (a migration this version does not know) is refused with a plain
// message instead of being used. Temporary folders and made-up people only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readdirSync, readFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DatabaseFileError } from '../src/db.js';
import { createContainer } from '../src/container.js';
import { loadConfig } from '../src/config.js';
import { fixedClock } from '../src/infra/clock.js';
import { fastHasher } from '../src/infra/hasher.js';
import { silentLogger } from '../src/infra/logger.js';
import { seededRandom } from '../src/infra/random.js';
import { run } from '../src/cli/commands.js';
import { tableCounts } from './helpers/church.js';
import { tokenHash } from '../src/services/auth-service.js';

const OLD_TOKEN = 'OldSessionToken'.padEnd(43, 'x'); // a session cookie value from before the upgrade

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'migrations');
const FILES = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
const OLDEST = 1; // the first migration made the first real schema; there is nothing older to upgrade from

function tmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'flock-upgrade-'));
  return { dir, file: (n) => path.join(dir, n), done: () => rmSync(dir, { recursive: true, force: true }) };
}

// A database exactly as an older flock would have left it: only the first
// `upto` migrations, recorded in schema_migrations, plus data written with
// plain SQL that fits that schema.
function buildAt(file, upto) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const f of FILES.slice(0, upto)) {
    db.exec(readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, '2024-06-01T00:00:00.000Z');
  }
  return db;
}

// Data in the shape of the 0001 schema: the oldest one any later migration must keep working.
function fillV1(db) {
  const at = '2024-06-01T00:00:00.000Z';
  const person = db.prepare('INSERT INTO people (name, username, password_hash, role, must_change_password, created_at) VALUES (?, ?, ?, ?, 0, ?)');
  const admin = Number(person.run('Old Admin', 'old.admin', 'fast$s1$' + 'a'.repeat(64), 'admin', at).lastInsertRowid);
  const ids = [];
  for (let i = 1; i <= 6; i++) ids.push(Number(person.run(`Old Member ${i}`, `old.member${i}`, 'fast$s1$' + 'b'.repeat(64), 'member', at).lastInsertRowid));
  db.prepare('INSERT INTO sessions (token_hash, person_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(tokenHash(OLD_TOKEN), admin, '2030-01-01T00:00:00.000Z', at);
  const team = Number(db.prepare('INSERT INTO teams (name, sort) VALUES (?, 1)').run('Band').lastInsertRowid);
  const pos = Number(db.prepare('INSERT INTO positions (team_id, name) VALUES (?, ?)').run(team, 'Keys').lastInsertRowid);
  for (const id of ids) db.prepare('INSERT INTO person_positions (person_id, position_id) VALUES (?, ?)').run(id, pos);
  const svc = Number(db.prepare('INSERT INTO services (date, time, title) VALUES (?, ?, ?)').run('2024-06-02', '10:00', 'Sunday service').lastInsertRowid);
  db.prepare("INSERT INTO slots (service_id, position_id, person_id, status, assigned_at, responded_at) VALUES (?, ?, ?, 'accepted', ?, ?)").run(svc, pos, ids[0], at, at);
  db.prepare('INSERT INTO slots (service_id, position_id) VALUES (?, ?)').run(svc, pos);
  db.prepare('INSERT INTO blockouts (person_id, start_date, end_date, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(ids[1], '2024-07-01', '2024-07-14', 'Summer', at);
  db.prepare('INSERT INTO audit (at, actor_id, action, detail) VALUES (?, ?, ?, ?)').run(at, admin, 'slot.assign', 'old entry');
  return { admin, ids, svc, pos };
}

const schemaOf = (db) => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
  .map((r) => ({ ...r }));
const dump = (db, table) => db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all().map((r) => ({ ...r }));

test('upgrade: every schema version from the oldest is brought up to date, with its data intact', () => {
  for (let upto = OLDEST; upto <= FILES.length; upto++) {
    const t = tmp();
    try {
      const f = t.file(`at-${upto}.db`);
      const old = buildAt(f, upto);
      const ids = fillV1(old);
      const tables = Object.keys(tableCounts(old)).filter((n) => n !== 'schema_migrations');
      const before = Object.fromEntries(tables.map((n) => [n, dump(old, n)]));
      old.close();

      const db = openDb(f, { clock: fixedClock('2025-01-05T12:00:00.000Z') });
      // Every migration is now recorded once, and the schema equals a fresh database's.
      assert.deepEqual(db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((r) => r.name), FILES);
      const fresh = openDb(':memory:');
      assert.deepEqual(schemaOf(db), schemaOf(fresh), `schema after upgrading from version ${upto}`);
      fresh.close();
      // Old rows are all still there, unchanged in every column they had.
      for (const n of tables) {
        const after = dump(db, n);
        assert.equal(after.length, before[n].length, `${n} rows`);
        before[n].forEach((row, i) => {
          for (const [k, v] of Object.entries(row)) assert.deepEqual(after[i][k], v, `${n}.${k}`);
        });
      }
      assert.equal(db.prepare('SELECT person_id FROM slots WHERE service_id = ? AND status = ?').get(ids.svc, 'accepted').person_id, ids.ids[0]);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      db.close();
    } finally { t.done(); }
  }
});

test('upgrade: a new database file gets the whole schema (version 0, a new install)', () => {
  const t = tmp();
  try {
    const db = openDb(t.file('new.db'));
    assert.deepEqual(db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((r) => r.name), FILES);
    db.close();
  } finally { t.done(); }
});

test('upgrade: running the migrations twice (or five times) is a no-op', () => {
  const t = tmp();
  try {
    const f = t.file('twice.db');
    const old = buildAt(f, OLDEST);
    fillV1(old);
    old.close();
    let db = openDb(f, { clock: fixedClock('2025-01-05T12:00:00.000Z') });
    const schema = schemaOf(db);
    const counts = tableCounts(db);
    const applied = dump(db, 'schema_migrations');
    db.close();
    for (let i = 0; i < 5; i++) {
      db = openDb(f, { clock: fixedClock('2031-01-01T00:00:00.000Z') });
      assert.deepEqual(schemaOf(db), schema);
      assert.deepEqual(tableCounts(db), counts);
      assert.deepEqual(dump(db, 'schema_migrations'), applied, 'no migration re-applied or re-dated');
      db.close();
    }
  } finally { t.done(); }
});

test('upgrade: the upgraded data works through the app (login with an old session, old slots in the schedule)', async () => {
  const t = tmp();
  try {
    const f = t.file('app.db');
    const old = buildAt(f, OLDEST);
    const hasher = fastHasher({ env: {} });
    const ids = fillV1(old);
    old.prepare('UPDATE people SET password_hash = ? WHERE id = ?').run(await hasher.hash('old-pass-123'), ids.ids[0]);
    old.close();
    const c = createContainer({
      config: { ...loadConfig({}), dbPath: f }, clock: fixedClock('2024-06-01T09:00:00'),
      random: seededRandom(3), hasher, logger: silentLogger(),
    });
    try {
      assert.equal((await c.services.auth.authenticate(OLD_TOKEN)).username, 'old.admin', 'a session from before the upgrade still works');
      const { token } = await c.services.auth.login('old.member1', 'old-pass-123');
      assert.equal((await c.services.auth.authenticate(token)).username, 'old.member1');
      const schedule = await c.services.assignments.mySchedule(ids.ids[0]);
      assert.deepEqual(schedule.items.map((i) => [i.date, i.status]), [['2024-06-02', 'accepted']]);
    } finally { c.close(); }
  } finally { t.done(); }
});

function newerDb(t, name = 'newer.db') {
  const f = t.file(name);
  const db = buildAt(f, FILES.length);
  fillV1(db);
  db.exec('CREATE TABLE future_things (id INTEGER PRIMARY KEY)');
  db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run('9999_from_the_future.sql', '2030-01-01T00:00:00.000Z');
  db.close();
  return f;
}

test('upgrade: a database from a NEWER flock is refused with a plain message and left untouched', () => {
  const t = tmp();
  try {
    const f = newerDb(t);
    const bytes = readFileSync(f);
    assert.throws(() => openDb(f), (e) => {
      assert.ok(e instanceof DatabaseFileError);
      assert.match(e.message, /newer version of flock/);
      assert.match(e.message, /9999_from_the_future\.sql/);
      assert.doesNotMatch(e.message, /SQLITE|sqlite|\n\s+at /);
      return true;
    });
    assert.deepEqual(readFileSync(f), bytes, 'the file was not changed');
    // The connection was closed again: the file can be renamed/copied and reopened by sqlite.
    copyFileSync(f, t.file('copy.db'));
    const raw = new DatabaseSync(f);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, FILES.length + 1);
    raw.close();
  } finally { t.done(); }
});

test('upgrade: the CLI and the app container refuse a newer database too', async () => {
  const t = tmp();
  const errors = [];
  const origError = console.error;
  const origLog = console.log;
  console.error = (m) => errors.push(String(m));
  console.log = () => {};
  try {
    const f = newerDb(t);
    assert.equal(await run(['export', t.file('out.csv'), '--db', f], {}), 1);
    assert.equal(await run(['backup', t.file('b.db'), '--db', f], {}), 1);
    assert.equal(errors.length, 2);
    for (const e of errors) {
      assert.match(e, /^This database was made by a newer version of flock/);
      assert.doesNotMatch(e, /failed:|\n\s+at /);
    }
    assert.throws(() => createContainer({ config: { ...loadConfig({}), dbPath: f }, logger: silentLogger() }), DatabaseFileError);
  } finally {
    console.error = origError;
    console.log = origLog;
    t.done();
  }
});
