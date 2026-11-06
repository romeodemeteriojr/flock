import { hashPassword } from '../../src/auth.js';

const hashCache = new Map(); // hashing is slow on purpose; reuse per password in tests

async function hashFor(pw) {
  if (!hashCache.has(pw)) hashCache.set(pw, await hashPassword(pw));
  return hashCache.get(pw);
}

export async function addPerson(db, { name, username, role = 'member', password = 'test-pass-1', mustChange = false, active = true }) {
  const hash = await hashFor(password);
  const r = db.prepare(
    'INSERT INTO people (name, username, password_hash, role, must_change_password, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(name, username, hash, role, mustChange ? 1 : 0, active ? 1 : 0, '2025-01-01T00:00:00.000Z');
  return Number(r.lastInsertRowid);
}

export async function loginAs(app, username, password = 'test-pass-1') {
  const res = await app.request('POST', '/api/login', { body: { username, password } });
  if (res.status !== 200) throw new Error(`loginAs failed for ${username}: ${res.status}`);
  const set = res.headers['set-cookie'];
  return String(Array.isArray(set) ? set[0] : set).split(';')[0];
}

export async function seedAdminAndMember(app, db) {
  const adminId = await addPerson(db, { name: 'Ada Admin', username: 'ada', role: 'admin' });
  const memberId = await addPerson(db, { name: 'Max Member', username: 'max', role: 'member' });
  const adminCookie = await loginAs(app, 'ada');
  const memberCookie = await loginAs(app, 'max');
  return { adminId, memberId, adminCookie, memberCookie };
}
