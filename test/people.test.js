import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { startTestApp } from './helpers/app.js';
import { addPerson, loginAs, seedAdminAndMember } from './helpers/seed.js';
import { tokenFromLink, cookieFrom } from './helpers/client.js';

const X = { 'X-Flock': '1' };

async function boot() {
  const db = openDb();
  const app = await startTestApp({ db, now: () => new Date('2025-01-05T12:00:00Z') });
  const s = await seedAdminAndMember(app, db);
  const call = (method, path, body, cookie = s.adminCookie) =>
    app.request(method, path, { body, cookie: cookie || undefined, headers: X });
  return { app, db, s, call };
}

test('members get 403 and logged-out users 401 on every route', async () => {
  const { app, s, call } = await boot();
  try {
    const routes = [['GET', '/api/people'], ['POST', '/api/people', { name: 'X Y' }],
      ['PATCH', `/api/people/${s.memberId}`, { name: 'Z' }], ['POST', `/api/people/${s.memberId}/reset-password`, {}],
      ['POST', `/api/people/${s.memberId}/invite`, {}]];
    for (const [m, p, b] of routes) {
      assert.equal((await call(m, p, b, s.memberCookie)).status, 403, `${m} ${p}`);
      assert.equal((await call(m, p, b, null)).status, 401, `${m} ${p}`);
    }
  } finally { await app.close(); }
});

test('create returns an invite once; claiming it chooses a password and logs in', async () => {
  const { app, call } = await boot();
  try {
    const r = await call('POST', '/api/people', { name: '  Sam Jones ', username: 'Sam_J' });
    assert.equal(r.status, 201);
    assert.equal(r.json.person.username, 'sam_j');
    assert.equal(r.json.person.name, 'Sam Jones');
    assert.equal(r.json.person.role, 'member');
    assert.equal(r.json.person.joined, false);
    const token = tokenFromLink(r.json.invite.link);
    const accepted = await call('POST', '/api/welcome', { token, password: 'sam own password' });
    assert.equal(accepted.status, 200);
    const me = await call('GET', '/api/people', undefined, cookieFrom(accepted));
    assert.equal(me.status, 403);
    assert.equal(me.json.error, 'Only the scheduler can do that');
    const list = await call('GET', '/api/people');
    assert.ok(!list.text.includes(token));
  } finally { await app.close(); }
});

test('username generation and duplicates', async () => {
  const { app, call } = await boot();
  try {
    const a = await call('POST', '/api/people', { name: 'Sam Jones' });
    assert.equal(a.json.person.username, 'sam.jones');
    const b = await call('POST', '/api/people', { name: 'Sam  Jones' });
    assert.equal(b.json.person.username, 'sam.jones2');
    const c = await call('POST', '/api/people', { name: 'Zoë' });
    assert.match(c.json.person.username, /^[a-z0-9._-]{3,30}$/);
    const d = await call('POST', '/api/people', { name: 'Dup', username: 'SAM.JONES' });
    assert.equal(d.status, 409);
    assert.equal(d.json.error, 'That username is already taken');
  } finally { await app.close(); }
});

test('listing has no secrets, sorted by name, with positionIds', async () => {
  const { app, db, s, call } = await boot();
  try {
    db.prepare("INSERT INTO teams (name) VALUES ('Band')").run();
    db.prepare("INSERT INTO positions (team_id, name) VALUES (1, 'Drums')").run();
    db.prepare('INSERT INTO person_positions (person_id, position_id) VALUES (?, 1)').run(s.memberId);
    const r = await call('GET', '/api/people');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((p) => p.name), ['Ada Admin', 'Max Member']);
    assert.deepEqual(r.json[1].positionIds, [1]);
    assert.deepEqual(Object.keys(r.json[0]).sort(),
      ['active', 'id', 'joined', 'name', 'positionIds', 'role', 'username']);
    assert.doesNotMatch(r.text, /scrypt|password_hash/);
  } finally { await app.close(); }
});

test('patch rules and last-admin guards', async () => {
  const { app, db, s, call } = await boot();
  try {
    let r = await call('PATCH', `/api/people/${s.memberId}`, { name: 'Max Q', role: 'admin' });
    assert.equal(r.status, 200);
    assert.equal(r.json.person.role, 'admin');
    assert.equal(r.json.person.name, 'Max Q');
    // admin cannot deactivate self
    r = await call('PATCH', `/api/people/${s.adminId}`, { active: false });
    assert.equal(r.status, 409);
    // can demote self while another admin exists
    r = await call('PATCH', `/api/people/${s.adminId}`, { role: 'member' });
    assert.equal(r.status, 200);
    // Max is now last admin: cannot be demoted or deactivated (by himself or others)
    const maxCookie = s.memberCookie;
    r = await call('PATCH', `/api/people/${s.memberId}`, { role: 'member' }, maxCookie);
    assert.equal(r.status, 409);
    r = await call('PATCH', `/api/people/${s.memberId}`, { active: false }, maxCookie);
    assert.equal(r.status, 409);
    assert.equal(db.prepare('SELECT role, active FROM people WHERE id = ?').get(s.memberId).role, 'admin');
    r = await call('PATCH', '/api/people/9999', { name: 'Nope' }, maxCookie);
    assert.equal(r.status, 404);
  } finally { await app.close(); }
});

test('deactivate kills sessions and blocks login; reactivate works', async () => {
  const { app, db, s, call } = await boot();
  try {
    const r = await call('PATCH', `/api/people/${s.memberId}`, { active: false });
    assert.equal(r.status, 200);
    assert.equal(r.json.person.active, false);
    assert.equal((await call('GET', '/api/me', undefined, s.memberCookie)).status, 401);
    assert.equal((await app.request('POST', '/api/login', { body: { username: 'max', password: 'test-pass-1' }, headers: X })).status, 401);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM people WHERE id = ?').get(s.memberId).c, 1);
    assert.equal((await call('PATCH', `/api/people/${s.memberId}`, { active: true })).status, 200);
    await loginAs(app, 'max');
  } finally { await app.close(); }
});

test('reset-password flow', async () => {
  const { app, db, s, call } = await boot();
  try {
    db.prepare('UPDATE people SET failed_logins = 5, locked_until = ? WHERE id = ?').run('2999-01-01T00:00:00.000Z', s.memberId);
    const r = await call('POST', `/api/people/${s.memberId}/reset-password`, {});
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json), ['person', 'invite']);
    assert.equal((await call('GET', '/api/me', undefined, s.memberCookie)).status, 401);
    const accepted = await call('POST', '/api/welcome', { token: tokenFromLink(r.json.invite.link), password: 'new max password' });
    assert.equal(accepted.status, 200);
    const me = await call('GET', '/api/me', undefined, cookieFrom(accepted));
    assert.equal(me.json.person.hasPassword, true);
    assert.equal((await call('POST', '/api/people/9999/reset-password', {})).status, 404);
  } finally { await app.close(); }
});

test('validation errors', async () => {
  const { app, s, call } = await boot();
  try {
    const bads = [
      ['POST', '/api/people', {}], ['POST', '/api/people', { name: '   ' }],
      ['POST', '/api/people', { name: 'x'.repeat(81) }], ['POST', '/api/people', { name: 5 }],
      ['POST', '/api/people', { name: 'A B', username: 'ab' }], ['POST', '/api/people', { name: 'A B', username: 'a b c' }],
      ['POST', '/api/people', { name: 'A B', username: 'x'.repeat(31) }],
      ['POST', '/api/people', { name: 'A B', role: 'boss' }], ['POST', '/api/people', { name: 'A B', extra: 1 }],
      ['POST', '/api/people', []],
      ['PATCH', `/api/people/${s.memberId}`, {}], ['PATCH', `/api/people/${s.memberId}`, { active: 'no' }],
      ['PATCH', `/api/people/${s.memberId}`, { role: 'x' }], ['PATCH', `/api/people/${s.memberId}`, { name: '' }],
      ['PATCH', '/api/people/abc', { name: 'Q' }], ['PATCH', '/api/people/0', { name: 'Q' }],
      ['PATCH', '/api/people/1.5', { name: 'Q' }], ['POST', '/api/people/abc/reset-password', {}],
    ];
    for (const [m, p, b] of bads) {
      const r = await call(m, p, b);
      assert.equal(r.status, 400, `${m} ${p} ${JSON.stringify(b)}`);
      assert.equal(typeof r.json.error, 'string');
    }
  } finally { await app.close(); }
});

test('audit rows are written without secrets', async () => {
  const { app, db, s, call } = await boot();
  try {
    const c = await call('POST', '/api/people', { name: 'Sam Jones' });
    await call('PATCH', `/api/people/${s.memberId}`, { active: false });
    const rs = await call('POST', `/api/people/${s.memberId}/reset-password`, {});
    const rows = db.prepare('SELECT * FROM audit ORDER BY id').all();
    assert.deepEqual(rows.map((r) => r.action), ['person.create', 'person.update', 'person.reset_password']);
    for (const r of rows) {
      assert.equal(r.actor_id, s.adminId);
      assert.ok(!r.detail.includes(tokenFromLink(c.json.invite.link)) && !r.detail.includes(tokenFromLink(rs.json.invite.link)));
      assert.doesNotMatch(r.detail, /scrypt/);
    }
  } finally { await app.close(); }
});
