import { existsSync } from 'node:fs';
import { num } from './util.js';

export function maintenanceRepo({ db, run }) {
  return {
    backupTo: (file) => run(() => {
      if (typeof file !== 'string' || file === '') throw new TypeError('backup path must be a file name');
      if (db.isTransaction) throw new Error('A backup cannot be made inside a transaction');
      if (existsSync(file)) throw new Error('The backup file already exists');
      db.prepare('VACUUM INTO ?').run(file);
    }),

    personCount: () => run(() => num(db.prepare('SELECT COUNT(*) AS n FROM people').get().n)),
  };
}
