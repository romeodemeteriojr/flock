import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { startTestApp } from './helpers/app.js';
import { addPerson, seedAdminAndMember } from './helpers/seed.js';

const X = { 'X-Flock': '1' };

async function boot() {
  const db = openDb();
  const app = await startTestApp({ db });
  const s = await seedAdminAndMember(app, db);
  const call = (method, path, who, body) => app.request(method, path, {
    body, headers: X, cookie: who === 'admin' ? s.adminCookie : who === 'member' ? s.memberCookie : undefined,
  });
  return { app, db, s, call };
}

test('authorization matrix', async () => {
  const { app, call } = await boot();
  try {
    const routes = [
      ['POST', '/api/teams', { name: 'X' }],
      ['PATCH', '/api/teams/1', { name: 'Y' }],
      ['DELETE', '/api/teams/1'],
      ['POST', '/api/teams/1/positions', { name: 'P' }],
      ['PATCH', '/api/positions/1', { name: 'P' }],
      ['DELETE', '/api/positions/1'],
      ['PUT', '/api/people/1/positions', { positionIds: [] }],
      ['GET', '/api/positions/1/people'],
    ];
    for (const [m, p, b] of routes) {
      assert.equal((await call(m, p, 'member', b)).status, 403, `${m} ${p} member`);
      assert.equal((await call(m, p, null, b)).status, 401, `${m} ${p} out`);
    }
    for (const p of ['/api/teams', '/api/me/positions']) {
      assert.equal((await call('GET', p, null)).status, 401);
      assert.equal((await call('GET', p, 'member')).status, 200);
    }
  } finally { await app.close(); }
});

test('create, rename, delete team; duplicates', async () => {
  const { app, db, call } = await boot();
  try {
    let r = await call('POST', '/api/teams', 'admin', { name: 'Band' });
    assert.equal(r.status, 201);
    const id = r.json.id;
    assert.equal((await call('POST', '/api/teams', 'admin', { name: 'band' })).status, 409);
    assert.equal((await call('POST', '/api/teams', 'admin', { name: '  ' })).status, 400);
    assert.equal((await call('POST', '/api/teams', 'admin', { name: 'x'.repeat(61) })).status, 400);
    assert.equal((await call('POST', '/api/teams', 'admin', {})).status, 400);
    const other = (await call('POST', '/api/teams', 'admin', { name: 'Sound' })).json.id;
    assert.equal((await call('PATCH', `/api/teams/${id}`, 'admin', { name: 'SOUND' })).status, 409);
    r = await call('PATCH', `/api/teams/${id}`, 'admin', { name: 'Worship Band' });
    assert.equal(r.status, 200);
    assert.equal(r.json.name, 'Worship Band');
    assert.equal((await call('PATCH', '/api/teams/999', 'admin', { name: 'Z' })).status, 404);
    await call('POST', `/api/teams/${other}/positions`, 'admin', { name: 'Mixer' });
    assert.equal((await call('DELETE', `/api/teams/${other}`, 'admin')).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM positions').get().n, 0);
    assert.equal((await call('DELETE', `/api/teams/${other}`, 'admin')).status, 404);
    const actions = db.prepare('SELECT action FROM audit').all().map((a) => a.action);
    assert.ok(actions.includes('team.create') && actions.includes('team.update') && actions.includes('team.delete'));
  } finally { await app.close(); }
});

test('positions CRUD and deletion refused when used by a slot', async () => {
  const { app, db, call } = await boot();
  try {
    const t1 = (await call('POST', '/api/teams', 'admin', { name: 'Band' })).json.id;
    const t2 = (await call('POST', '/api/teams', 'admin', { name: 'Sound' })).json.id;
    let r = await call('POST', `/api/teams/${t1}/positions`, 'admin', { name: 'Drums' });
    assert.equal(r.status, 201);
    const p = r.json.id;
    assert.equal((await call('POST', `/api/teams/${t1}/positions`, 'admin', { name: 'drums' })).status, 409);
    assert.equal((await call('POST', '/api/teams/999/positions', 'admin', { name: 'A' })).status, 404);
    assert.equal((await call('POST', `/api/teams/${t1}/positions`, 'admin', { name: '' })).status, 400);
    r = await call('PATCH', `/api/positions/${p}`, 'admin', { name: 'Keys', sort: 5, teamId: t2 });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.name, r.json.sort, r.json.teamId], ['Keys', 5, t2]);
    assert.equal((await call('PATCH', `/api/positions/${p}`, 'admin', { teamId: 999 })).status, 400);
    assert.equal((await call('PATCH', '/api/positions/999', 'admin', { name: 'A' })).status, 404);

    db.prepare("INSERT INTO services (date, time, title) VALUES ('2025-02-02','09:00','Sunday')").run();
    db.prepare('INSERT INTO slots (service_id, position_id) VALUES (1, ?)').run(p);
    r = await call('DELETE', `/api/positions/${p}`, 'admin');
    assert.equal(r.status, 409);
    assert.equal(typeof r.json.error, 'string');
    r = await call('DELETE', `/api/teams/${t2}`, 'admin');
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'Remove or reassign its positions first');
    db.prepare('DELETE FROM slots').run();
    assert.equal((await call('DELETE', `/api/positions/${p}`, 'admin')).status, 200);
    assert.equal((await call('DELETE', `/api/teams/${t2}`, 'admin')).status, 200);
  } finally { await app.close(); }
});

test('qualifications are replaced; unknown ids rejected; visibility', async () => {
  const { app, db, s, call } = await boot();
  try {
    const t = (await call('POST', '/api/teams', 'admin', { name: 'Band' })).json.id;
    const a = (await call('POST', `/api/teams/${t}/positions`, 'admin', { name: 'Drums' })).json.id;
    const b = (await call('POST', `/api/teams/${t}/positions`, 'admin', { name: 'Bass' })).json.id;
    const gone = await addPerson(db, { name: 'Old Timer', username: 'old', active: false });

    let r = await call('PUT', `/api/people/${s.memberId}/positions`, 'admin', { positionIds: [a, b] });
    assert.equal(r.status, 200);
    await call('PUT', `/api/people/${gone}/positions`, 'admin', { positionIds: [a] });
    r = await call('PUT', `/api/people/${s.memberId}/positions`, 'admin', { positionIds: [b] });
    assert.deepEqual(r.json.positionIds, [b]);
    assert.deepEqual(
      db.prepare('SELECT position_id FROM person_positions WHERE person_id = ?').all(s.memberId).map((x) => x.position_id),
      [b],
    );
    r = await call('PUT', `/api/people/${s.memberId}/positions`, 'admin', { positionIds: [b, 9999] });
    assert.equal(r.status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM person_positions WHERE person_id = ?').get(s.memberId).n, 1);
    assert.equal((await call('PUT', `/api/people/${s.memberId}/positions`, 'admin', { positionIds: 'x' })).status, 400);
    assert.equal((await call('PUT', '/api/people/999/positions', 'admin', { positionIds: [] })).status, 404);

    r = await call('GET', `/api/positions/${b}/people`, 'admin');
    assert.deepEqual(r.json, [{ id: s.memberId, name: 'Max Member' }]);
    assert.deepEqual((await call('GET', `/api/positions/${a}/people`, 'admin')).json, []);

    r = await call('GET', '/api/teams', 'admin');
    assert.deepEqual(r.json[0].positions.find((x) => x.id === b).qualifiedPersonIds, [s.memberId]);
    r = await call('GET', '/api/teams', 'member');
    assert.ok(!JSON.stringify(r.json).includes('qualified'));
    assert.deepEqual(r.json[0].positions[0], { id: a, name: 'Drums' });

    r = await call('GET', '/api/me/positions', 'member');
    assert.deepEqual(r.json.map((x) => x.id), [b]);
    assert.deepEqual((await call('GET', '/api/me/positions', 'admin')).json, []);
  } finally { await app.close(); }
});

test('sorting by sort then name', async () => {
  const { app, call } = await boot();
  try {
    const z = (await call('POST', '/api/teams', 'admin', { name: 'Zeta' })).json.id;
    const a = (await call('POST', '/api/teams', 'admin', { name: 'Alpha' })).json.id;
    const m = (await call('POST', '/api/teams', 'admin', { name: 'Mid' })).json.id;
    await call('PATCH', `/api/teams/${z}`, 'admin', { sort: 0 });
    await call('PATCH', `/api/teams/${a}`, 'admin', { sort: 0 });
    await call('PATCH', `/api/teams/${m}`, 'admin', { sort: 1 });
    let r = await call('GET', '/api/teams', 'member');
    assert.deepEqual(r.json.map((t) => t.name), ['Alpha', 'Zeta', 'Mid']);
    const p1 = (await call('POST', `/api/teams/${m}/positions`, 'admin', { name: 'B' })).json.id;
    const p2 = (await call('POST', `/api/teams/${m}/positions`, 'admin', { name: 'A' })).json.id;
    await call('PATCH', `/api/positions/${p1}`, 'admin', { sort: 0 });
    await call('PATCH', `/api/positions/${p2}`, 'admin', { sort: 0 });
    r = await call('GET', '/api/teams', 'member');
    assert.deepEqual(r.json[2].positions.map((p) => p.name), ['A', 'B']);
    await call('PATCH', `/api/positions/${p2}`, 'admin', { sort: 9 });
    r = await call('GET', '/api/teams', 'member');
    assert.deepEqual(r.json[2].positions.map((p) => p.name), ['B', 'A']);
  } finally { await app.close(); }
});

test('order of checks: not found before bad input; duplicate name before bad sort', async () => {
  const { app, call } = await boot();
  try {
    const band = (await call('POST', '/api/teams', 'admin', { name: 'Band' })).json.id;
    await call('POST', '/api/teams', 'admin', { name: 'Sound' });
    const pos = (await call('POST', `/api/teams/${band}/positions`, 'admin', { name: 'Drums' })).json.id;
    const cases = [
      ['PATCH', '/api/teams/999', { name: '' }, 404, 'Team not found'],
      ['PATCH', '/api/teams/999', { sort: 'x' }, 404, 'Team not found'],
      ['POST', '/api/teams/999/positions', { name: '' }, 404, 'Team not found'],
      ['PATCH', '/api/positions/999', { name: '', sort: 'x', teamId: 'x' }, 404, 'Position not found'],
      ['PUT', '/api/people/999/positions', { positionIds: 'x' }, 404, 'Person not found'],
      ['PATCH', `/api/teams/${band}`, { name: 'sound', sort: 'x' }, 409, 'A team with that name already exists'],
      ['PATCH', `/api/teams/${band}`, { name: '', sort: 'x' }, 400, 'Name must be 1 to 60 characters'],
      ['PATCH', `/api/teams/${band}`, { name: 'Worship', sort: 'x' }, 400, 'Sort must be a whole number'],
      ['PATCH', `/api/positions/${pos}`, { sort: 'x', teamId: 999 }, 400, 'Sort must be a whole number'],
    ];
    for (const [m, p, b, status, error] of cases) {
      const r = await call(m, p, 'admin', b);
      assert.equal(r.status, status, `${m} ${p} ${JSON.stringify(b)}`);
      assert.equal(r.json.error, error, `${m} ${p} ${JSON.stringify(b)}`);
    }
    // The refused rename with a bad sort changed nothing.
    const teams = (await call('GET', '/api/teams', 'admin')).json;
    assert.deepEqual(teams.map((t) => t.name), ['Band', 'Sound']);
  } finally { await app.close(); }
});
