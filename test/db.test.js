import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, tx, logAudit } from '../src/db.js';

const T = '2025-01-01T00:00:00.000Z';
function person(db, username = 'ann', role = 'member') {
  return Number(db.prepare('INSERT INTO people (name,username,password_hash,role,created_at) VALUES (?,?,?,?,?)').run('X ' + username, username, 'h', role, T).lastInsertRowid);
}
function team(db, name = 'Band') {
  const t = Number(db.prepare('INSERT INTO teams (name) VALUES (?)').run(name).lastInsertRowid);
  const p = Number(db.prepare('INSERT INTO positions (team_id,name) VALUES (?,?)').run(t, 'Drums').lastInsertRowid);
  return { t, p };
}
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

test('schema has all tables and columns', () => {
  const db = openDb();
  const want = {
    people: ['id', 'name', 'username', 'password_hash', 'role', 'must_change_password', 'active', 'failed_logins', 'locked_until', 'created_at'],
    sessions: ['id', 'token_hash', 'person_id', 'expires_at', 'created_at'],
    teams: ['id', 'name', 'sort'],
    positions: ['id', 'team_id', 'name', 'sort'],
    person_positions: ['person_id', 'position_id'],
    services: ['id', 'date', 'time', 'title'],
    slots: ['id', 'service_id', 'position_id', 'person_id', 'status', 'assigned_at', 'responded_at'],
    blockouts: ['id', 'person_id', 'start_date', 'end_date', 'reason', 'created_at'],
    audit: ['id', 'at', 'actor_id', 'action', 'detail'],
  };
  for (const [t, c] of Object.entries(want)) assert.deepEqual(cols(db, t).sort(), [...c].sort(), t);
});

test('migrations are idempotent on a file db', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'flock-db-'));
  try {
    const f = path.join(dir, 't.db');
    let db = openDb(f);
    person(db);
    db.close();
    db = openDb(f);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM people').get().n, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('foreign keys enforced', () => {
  const db = openDb();
  assert.throws(() => db.prepare('INSERT INTO sessions (token_hash,person_id,expires_at,created_at) VALUES (?,?,?,?)').run('t', 99, T, T));
});

test('cascades and set null', () => {
  const db = openDb();
  const { t, p } = team(db);
  db.prepare('DELETE FROM teams WHERE id=?').run(t);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM positions').get().n, 0);

  const t2 = team(db, 'Tech');
  const a = person(db);
  db.prepare('INSERT INTO sessions (token_hash,person_id,expires_at,created_at) VALUES (?,?,?,?)').run('t', a, T, T);
  db.prepare('INSERT INTO blockouts (person_id,start_date,end_date,created_at) VALUES (?,?,?,?)').run(a, '2025-01-01', '2025-01-02', T);
  db.prepare('INSERT INTO person_positions VALUES (?,?)').run(a, t2.p);
  const s = Number(db.prepare('INSERT INTO services (date,title) VALUES (?,?)').run('2025-01-05', 'Sun').lastInsertRowid);
  db.prepare("INSERT INTO slots (service_id,position_id,person_id,status) VALUES (?,?,?,'declined')").run(s, t2.p, a);
  db.prepare('DELETE FROM people WHERE id=?').run(a);
  for (const tb of ['sessions', 'blockouts', 'person_positions']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${tb}`).get().n, 0, tb);
  assert.equal(db.prepare('SELECT person_id FROM slots').get().person_id, null);
  assert.ok(p);
});

test('check constraints', () => {
  const db = openDb();
  assert.throws(() => db.prepare('INSERT INTO people (name,username,password_hash,role,created_at) VALUES (?,?,?,?,?)').run('a', 'a', 'h', 'boss', T));
  const { p } = team(db);
  const s = Number(db.prepare('INSERT INTO services (date,title) VALUES (?,?)').run('2025-01-05', 'Sun').lastInsertRowid);
  assert.throws(() => db.prepare("INSERT INTO slots (service_id,position_id,status) VALUES (?,?,'maybe')").run(s, p));
  const a = person(db);
  assert.throws(() => db.prepare('INSERT INTO blockouts (person_id,start_date,end_date,created_at) VALUES (?,?,?,?)').run(a, '2025-01-05', '2025-01-04', T));
});

test('username unique case-insensitively', () => {
  const db = openDb();
  person(db, 'Ann');
  assert.throws(() => person(db, 'ann'));
});

test('used position cannot be deleted', () => {
  const db = openDb();
  const { p } = team(db);
  const s = Number(db.prepare('INSERT INTO services (date,title) VALUES (?,?)').run('2025-01-05', 'Sun').lastInsertRowid);
  db.prepare('INSERT INTO slots (service_id,position_id) VALUES (?,?)').run(s, p);
  assert.throws(() => db.prepare('DELETE FROM positions WHERE id=?').run(p));
});

test('tx commits, rolls back, nests', () => {
  const db = openDb();
  const n = () => db.prepare('SELECT COUNT(*) n FROM teams').get().n;
  assert.equal(tx(db, () => { db.exec("INSERT INTO teams (name) VALUES ('A')"); return 7; }), 7);
  assert.equal(n(), 1);
  assert.throws(() => tx(db, () => { db.exec("INSERT INTO teams (name) VALUES ('B')"); throw new Error('x'); }), /x/);
  assert.equal(n(), 1);
  tx(db, () => {
    db.exec("INSERT INTO teams (name) VALUES ('C')");
    assert.throws(() => tx(db, () => { db.exec("INSERT INTO teams (name) VALUES ('D')"); throw new Error('y'); }));
  });
  assert.equal(n(), 2);
  assert.throws(() => tx(db, () => tx(db, () => { db.exec("INSERT INTO teams (name) VALUES ('E')"); throw new Error('z'); })));
  assert.equal(n(), 2);
});

test('logAudit truncates and stores', () => {
  const db = openDb();
  logAudit(db, T, 1, 'login', 'x'.repeat(600));
  logAudit(db, new Date(T), null, 'boot', 'hi');
  const rows = db.prepare('SELECT * FROM audit ORDER BY id').all();
  assert.equal(rows[0].detail.length, 500);
  assert.equal(rows[0].at, T);
  assert.equal(rows[1].actor_id, null);
  assert.equal(rows[1].at, T);
});
