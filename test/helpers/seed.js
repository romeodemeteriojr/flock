// Test people, built through the data layer and the app's hasher.
// The first argument of addPerson / seedAdminAndMember can be:
//   - a container or anything with { data, hasher } (e.g. makeContainer()),
//   - a test app from startTestApp() (uses its container),
//   - a raw database from openDb() (uses the container startTestApp built on
//     it, or else the data layer on that db with a fast test hasher).
import { createData } from '../../src/data/index.js';
import { fastHasher } from '../../src/infra/hasher.js';

const containersByDb = new WeakMap();
let fallbackHasher = null;

/** Remember which container runs on a database, so addPerson(db, ...) uses its hasher. */
export function registerContainer(db, container) {
  if (db && typeof db === 'object') containersByDb.set(db, container);
}

function resolve(target) {
  if (!target || typeof target !== 'object') throw new TypeError('addPerson needs a container, test app or database');
  if (target.data && target.hasher) return { data: target.data, hasher: target.hasher };
  if (target.container?.data && target.container?.hasher) return resolve(target.container);
  const known = containersByDb.get(target);
  if (known) return resolve(known);
  if (typeof target.prepare === 'function') {
    fallbackHasher ??= fastHasher({ env: {} });
    return { data: createData(target), hasher: fallbackHasher };
  }
  throw new TypeError('addPerson needs a container, test app or database');
}

export async function addPerson(target, { name, username, role = 'member', password = 'test-pass-1', mustChange = false, active = true }) {
  const { data, hasher } = resolve(target);
  const person = await data.people.create({
    name, username, role, mustChangePassword: mustChange,
    passwordHash: await hasher.hash(password),
    createdAt: '2025-01-01T00:00:00.000Z',
  });
  if (!active) await data.people.update(person.id, { active: false });
  return person.id;
}

export async function loginAs(app, username, password = 'test-pass-1') {
  const res = await app.request('POST', '/api/login', { body: { username, password } });
  if (res.status !== 200) throw new Error(`loginAs failed for ${username}: ${res.status}`);
  const set = res.headers['set-cookie'];
  return String(Array.isArray(set) ? set[0] : set).split(';')[0];
}

export async function seedAdminAndMember(app, db = app) {
  const adminId = await addPerson(db, { name: 'Ada Admin', username: 'ada', role: 'admin' });
  const memberId = await addPerson(db, { name: 'Max Member', username: 'max', role: 'member' });
  const adminCookie = await loginAs(app, 'ada');
  const memberCookie = await loginAs(app, 'max');
  return { adminId, memberId, adminCookie, memberCookie };
}
