import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** A database file flock must not use: damaged, not a flock database, or from a newer flock. */
export class DatabaseFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DatabaseFileError';
  }
}

const unusable = (file) => new DatabaseFileError(
  `The database file ${file} cannot be used: it is damaged or is not a flock database. `
  + 'If it is a restored backup, try another backup copy.',
);

// A file that exists but is empty would silently become a new, empty database
// (for example a backup copy that was cut short); refuse it instead.
function refuseEmptyFile(file) {
  let size;
  try { size = statSync(file).size; } catch { return; } // does not exist yet: a new install
  if (size === 0) {
    throw new DatabaseFileError(`The database file ${file} is empty. If it is a restored backup, the copy is incomplete; try another backup copy.`);
  }
}

// SQLITE_CORRUPT (11) and SQLITE_NOTADB (26), with or without extended codes.
const isCorrupt = (e) => Number.isInteger(e?.errcode) && [11, 26].includes(e.errcode & 0xff);

// Reading the schema and a quick check of every page catch a truncated or
// damaged file before any request sees it.
function checkReadable(db, file) {
  let rows;
  try {
    db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get();
    rows = db.prepare('PRAGMA quick_check').all();
  } catch (e) {
    throw isCorrupt(e) ? unusable(file) : e; // a lock or permission problem is not damage
  }
  if (rows.length !== 1 || rows[0].quick_check !== 'ok') throw unusable(file);
}

// The migration time comes from the injected clock when there is one (the
// container passes it); otherwise SQLite's own clock records it.
export function openDb(file = ':memory:', options = {}) {
  const clock = options?.clock;
  const onDisk = file !== ':memory:';
  if (onDisk) refuseEmptyFile(file);
  const db = new DatabaseSync(file);
  try {
    if (onDisk) checkReadable(db, file);
    migrate(db, clock, onDisk);
  } catch (e) {
    db.close();
    throw onDisk && isCorrupt(e) ? unusable(file) : e;
  }
  return db;
}

function migrate(db, clock, onDisk) {
  db.exec('PRAGMA foreign_keys=ON');
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (hasTable) {
    // Migrations this version does not know mean a newer flock made the file:
    // using it here could lose or damage data, so stop before changing anything.
    const unknown = db.prepare('SELECT name FROM schema_migrations ORDER BY name').all()
      .map((r) => r.name).filter((name) => !files.includes(name));
    if (unknown.length) {
      throw new DatabaseFileError(
        `This database was made by a newer version of flock (it has ${unknown.join(', ')}, which this version does not know). `
        + 'Update flock to the newest version before using it.',
      );
    }
  }
  if (onDisk) db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(path.join(migrationsDir, f), 'utf8');
    tx(db, () => {
      db.exec(sql);
      if (clock) {
        db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, isoOf(clock.now()));
      } else {
        db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))").run(f);
      }
    });
  }
}

// Clocks return a Date; an ISO string or epoch milliseconds is accepted too.
function isoOf(value) {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

let spCounter = 0;
export function tx(db, fn) {
  if (db.isTransaction) {
    const sp = `sp_${++spCounter}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const r = fn();
      db.exec(`RELEASE ${sp}`);
      return r;
    } catch (e) {
      db.exec(`ROLLBACK TO ${sp}`);
      db.exec(`RELEASE ${sp}`);
      throw e;
    }
  }
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}

export function logAudit(db, now, actorId, action, detail = '') {
  const at = now instanceof Date ? now.toISOString() : String(now);
  db.prepare('INSERT INTO audit (at, actor_id, action, detail) VALUES (?, ?, ?, ?)')
    .run(at, actorId ?? null, action, String(detail).slice(0, 500));
}
