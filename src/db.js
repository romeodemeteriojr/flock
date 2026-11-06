import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(path.join(migrationsDir, f), 'utf8');
    tx(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
    });
  }
  return db;
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
