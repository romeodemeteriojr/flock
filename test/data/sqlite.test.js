import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { runContract } from './contract.js';
import { makeData } from '../helpers/data.js';
import { createData } from '../../src/data/index.js';
import { createQueue } from '../../src/data/sqlite/queue.js';

runContract('sqlite', makeData);

test('sqlite: tx runs inside BEGIN IMMEDIATE and commits', async () => {
  const { db, data } = makeData();
  assert.equal(db.isTransaction, false);
  await data.tx(async (d) => {
    assert.equal(db.isTransaction, true);
    await d.teams.create({ name: 'Band' });
  });
  assert.equal(db.isTransaction, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM teams').get().n, 1);
});

test('sqlite: two concurrent transactions never interleave', async () => {
  const { data } = makeData();
  const events = [];
  const job = (tag, delay) => data.tx(async (d) => {
    events.push(`${tag}:start`);
    await d.teams.create({ name: `${tag}-1` });
    await sleep(delay);
    events.push(`${tag}:middle`);
    await d.teams.create({ name: `${tag}-2` });
    await sleep(delay);
    events.push(`${tag}:end`);
    return tag;
  });
  const results = await Promise.all([job('A', 20), job('B', 1), job('C', 5)]);
  assert.deepEqual(results, ['A', 'B', 'C']);
  assert.deepEqual(events, [
    'A:start', 'A:middle', 'A:end', 'B:start', 'B:middle', 'B:end', 'C:start', 'C:middle', 'C:end',
  ]);
  assert.equal((await data.teams.list()).length, 6);
});

test('sqlite: two createData instances on one db share the queue', async () => {
  const { db, data } = makeData();
  const other = createData(db);
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const txDone = data.tx(async (d) => {
    await d.teams.create({ name: 'Band' });
    await gate;
    order.push('tx:end');
    throw new Error('rollback');
  });
  await sleep(5);
  const write = other.teams.create({ name: 'Tech' }).then(() => order.push('other:write'));
  await sleep(10);
  assert.deepEqual(order, []);
  release();
  await assert.rejects(txDone, /rollback/);
  await write;
  assert.deepEqual(order, ['tx:end', 'other:write']);
  assert.deepEqual((await data.teams.list()).map((t) => t.name), ['Tech'], 'other write was not swallowed by the rollback');
});

test('sqlite: a plain call from another request runs between two awaits only after the tx', async () => {
  const { data } = makeData();
  const seen = [];
  const txDone = data.tx(async (d) => {
    await d.teams.create({ name: 'A' });
    await sleep(10);
    seen.push(['in-tx', (await d.teams.list()).length]);
  });
  // A different "request": not inside the tx's async context.
  const outside = (async () => { await sleep(2); await data.teams.create({ name: 'B' }); seen.push(['outside']); })();
  await Promise.all([txDone, outside]);
  assert.deepEqual(seen, [['in-tx', 1], ['outside']]);
});

test('sqlite: a failing tx rolls back everything and the next tx still works', async () => {
  const { db, data } = makeData();
  const bad = data.tx(async (d) => {
    const t = await d.teams.create({ name: 'Band' });
    await d.positions.create(t.id, { name: 'Drums' });
    await d.people.create({ name: 'A', username: 'a', passwordHash: 'h', role: 'member', mustChangePassword: false, createdAt: 'x' });
    await sleep(5);
    throw new Error('fail');
  });
  const good = data.tx(async (d) => d.services.create({ date: '2025-01-05', time: '09:00', title: 'Sun' }));
  await assert.rejects(bad, /fail/);
  assert.equal((await good).title, 'Sun');
  for (const t of ['teams', 'positions', 'people']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
  }
  assert.equal(db.isTransaction, false);
});

test('sqlite: a plain call made during an open tx waits for it', async () => {
  const { data } = makeData();
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const txDone = data.tx(async (d) => {
    await d.teams.create({ name: 'Band' });
    order.push('tx:created');
    await gate;
    await d.teams.create({ name: 'Tech' });
    order.push('tx:end');
  });
  await sleep(5);
  const listed = data.teams.list().then((l) => { order.push('plain:list'); return l; });
  await sleep(10);
  assert.deepEqual(order, ['tx:created'], 'plain call has not run yet');
  release();
  const list = await listed;
  await txDone;
  assert.deepEqual(order, ['tx:created', 'tx:end', 'plain:list']);
  assert.deepEqual(list.map((t) => t.name), ['Band', 'Tech'], 'plain call sees the committed data');
});

test('sqlite: plain calls waiting behind a rolled-back tx do not see its changes', async () => {
  const { data } = makeData();
  const txDone = data.tx(async (d) => {
    await d.teams.create({ name: 'Band' });
    await sleep(5);
    throw new Error('nope');
  });
  const listed = data.teams.list();
  await assert.rejects(txDone, /nope/);
  assert.deepEqual(await listed, []);
});

test('sqlite: queue runs jobs one at a time in order and survives failures', async () => {
  const q = createQueue();
  const seen = [];
  const a = q.run(async () => { seen.push('a1'); await sleep(5); seen.push('a2'); return 1; });
  const b = q.run(() => { throw new Error('b'); });
  const c = q.run(async () => { seen.push('c'); return 3; });
  assert.equal(await a, 1);
  await assert.rejects(b, /b/);
  assert.equal(await c, 3);
  assert.deepEqual(seen, ['a1', 'a2', 'c']);
  assert.equal(q.size, 0);
});

test('sqlite: createData needs a database', () => {
  assert.throws(() => createData(null), TypeError);
});

test('sqlite: repository results are plain objects, not driver rows', async () => {
  const { data } = makeData();
  const t = await data.teams.create({ name: 'Band' });
  assert.equal(Object.getPrototypeOf(t), Object.prototype);
  const p = await data.people.create({ name: 'A', username: 'a', passwordHash: 'h', role: 'member', mustChangePassword: false, createdAt: 'x' });
  assert.equal(Object.getPrototypeOf(p), Object.prototype);
  assert.equal(Object.getPrototypeOf(await data.people.findAuthById(p.id)), Object.prototype);
});
