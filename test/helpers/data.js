// A fresh in-memory database with the data layer on top. Never touches real files.
import { openDb } from '../../src/db.js';
import { createData } from '../../src/data/index.js';

export function makeData() {
  const db = openDb(':memory:');
  return { db, data: createData(db) };
}
