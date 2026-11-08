// The CLI is run as a child process against a temp database. Fake people only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContainer } from '../src/container.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { silentLogger } from '../src/infra/logger.js';
import { csvCell } from '../src/cli/csv.js';
import { tokenFromLink } from './helpers/client.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'flock.js');

function tmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'flock-cli-'));
  return { dir, db: path.join(dir, 'test.db'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

function flock(dir, args, { db, publicUrl } = {}) {
  const env = { PATH: process.env.PATH, HOME: dir };
  if (db) env.FLOCK_DB = db;
  if (publicUrl) env.FLOCK_PUBLIC_URL = publicUrl;
  const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', cwd: dir });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function openContainer(db) {
  return createContainer({ config: { ...loadConfig({}), dbPath: db }, logger: silentLogger() });
}

async function withContainer(db, fn) {
  const c = openContainer(db);
  try { return await fn(c); } finally { c.close(); }
}

const inviteLinkOf = (out) => out.match(/Invite link \([^\n]+\): (\S+)/)[1];

test('create-admin prints an invite once and the account can join', async () => {
  const t = tmp();
  try {
    const r = flock(t.dir, ['create-admin', 'pastor.test@example.com', 'Pat Test', '--db', t.db]);
    assert.equal(r.code, 0, r.err);
    const link = inviteLinkOf(r.out);
    const token = tokenFromLink(link);
    assert.equal(r.out.split(link).length - 1, 1, 'invite printed exactly once');
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.match(r.out, /works once, for 7 days/);
    assert.ok(!r.err.includes(token));
    await withContainer(t.db, async (c) => {
      const app = createApp({ container: c });
      const port = await app.listen(0);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/welcome`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Flock': '1' },
          body: JSON.stringify({ token, password: 'my own password 1' }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.person?.role ?? body.role, 'admin');
        assert.equal(body.person.hasPassword, true);
      } finally {
        await app.close();
      }
    });
  } finally { t.done(); }
});

test('create-admin refuses an existing email, a bad email, and never takes a password', () => {
  const t = tmp();
  try {
    assert.equal(flock(t.dir, ['create-admin', 'pat.test@example.com', 'Pat Test'], { db: t.db }).code, 0);
    const dup = flock(t.dir, ['create-admin', 'PAT.test@example.com', 'Other Person'], { db: t.db });
    assert.notEqual(dup.code, 0);
    assert.match(dup.err, /already exists/);
    assert.ok(!/Invite link/.test(dup.out));
    const withPw = flock(t.dir, ['create-admin', 'x.user@example.com', 'X User', 'secret123'], { db: t.db });
    assert.notEqual(withPw.code, 0);
    const bad = flock(t.dir, ['create-admin', 'x.user@example.com', 'X User', '--password', 'secret123'], { db: t.db });
    assert.notEqual(bad.code, 0);
    const notEmail = flock(t.dir, ['create-admin', 'pat', 'Pat'], { db: t.db });
    assert.notEqual(notEmail.code, 0);
    assert.match(notEmail.err, /valid email/);
  } finally { t.done(); }
});

test('demo seeds valid fake data and refuses a non-empty database', async () => {
  const t = tmp();
  try {
    const r = flock(t.dir, ['demo'], { db: t.db });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /demo-admin/);
    assert.match(tokenFromLink(inviteLinkOf(r.out)), /^[A-Za-z0-9_-]{43}$/);
    await withContainer(t.db, async ({ data, services }) => {
      const people = await data.people.list();
      assert.equal(people.length, 13);
      assert.equal(people.filter((p) => p.name.startsWith('Demo ')).length, 13);
      assert.ok(people.some((p) => p.email === 'demo-admin@example.com' && p.role === 'admin' && !p.hasPassword));
      const teams = await data.teams.list();
      assert.deepEqual(teams.map((x) => x.name).sort(), ['Band', 'Greeters', 'Kids', 'Sound']);
      const positionIds = new Set(teams.flatMap((x) => x.positions.map((p) => p.id)));
      const slots = await data.slots.listForServices('0001-01-01', '9999-12-31');
      assert.ok(slots.length > 0);
      const svcs = await data.services.listRange('0001-01-01', '9999-12-31');
      assert.equal(svcs.length, 8);
      for (const s of svcs) assert.equal(new Date(`${s.date}T00:00:00Z`).getUTCDay(), 0);
      const statuses = new Set();
      for (const s of slots) {
        assert.ok(positionIds.has(s.positionId));
        assert.ok(['open', 'pending', 'accepted', 'declined'].includes(s.status));
        assert.equal(s.personId === null, s.status === 'open');
        statuses.add(s.status);
      }
      assert.equal(statuses.size, 4, 'a mix of all statuses');
      assert.ok((await services.blockouts.listRange()).length >= 3);
    });
    const again = flock(t.dir, ['demo'], { db: t.db });
    assert.notEqual(again.code, 0);
    assert.match(again.err, /already has people/);
  } finally { t.done(); }
});

test('CLI invite links honor FLOCK_PUBLIC_URL', () => {
  const t = tmp();
  try {
    const r = flock(t.dir, ['create-admin', 'pat.test@example.com', 'Pat Test'], { db: t.db, publicUrl: 'https://flock.example.org/' });
    assert.equal(r.code, 0, r.err);
    assert.ok(inviteLinkOf(r.out).startsWith('https://flock.example.org/#/welcome?token='));
  } finally { t.done(); }
});

test('demo refuses a database that already has an admin', () => {
  const t = tmp();
  try {
    assert.equal(flock(t.dir, ['create-admin', 'pat.test@example.com', 'Pat Test'], { db: t.db }).code, 0);
    assert.notEqual(flock(t.dir, ['demo'], { db: t.db }).code, 0);
  } finally { t.done(); }
});

test('backup makes a database that opens with the same rows and refuses to overwrite', async () => {
  const t = tmp();
  try {
    assert.equal(flock(t.dir, ['demo'], { db: t.db }).code, 0);
    const file = path.join(t.dir, 'copy.db');
    const r = flock(t.dir, ['backup', file], { db: t.db });
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes(file));
    const snap = async (c) => ({
      people: await c.data.people.list(),
      slots: await c.data.slots.listForServices('0001-01-01', '9999-12-31'),
    });
    const a = await withContainer(t.db, snap);
    const b = await withContainer(file, snap);
    assert.deepEqual(b, a);
    const before = readFileSync(file);
    const again = flock(t.dir, ['backup', file], { db: t.db });
    assert.notEqual(again.code, 0);
    assert.match(again.err, /already exists/);
    assert.deepEqual(readFileSync(file), before);
  } finally { t.done(); }
});

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  return rows;
}

test('export writes the header and rows, and refuses to overwrite', async () => {
  const t = tmp();
  try {
    assert.equal(flock(t.dir, ['demo'], { db: t.db }).code, 0);
    const file = path.join(t.dir, 'out.csv');
    const r = flock(t.dir, ['export', file], { db: t.db });
    assert.equal(r.code, 0, r.err);
    const rows = parseCsv(readFileSync(file, 'utf8'));
    assert.deepEqual(rows[0], ['date', 'time', 'service', 'team', 'position', 'person', 'status']);
    const slots = await withContainer(t.db, (c) => c.data.slots.listForServices('0001-01-01', '9999-12-31'));
    assert.equal(rows.length - 1, slots.length);
    assert.ok(rows.slice(1).every((x) => x.length === 7));
    assert.ok(rows.some((x) => x[5].startsWith('Demo ') && x[6] === 'accepted'));
    assert.ok(rows.some((x) => x[5] === '' && x[6] === 'open'));
    const before = readFileSync(file);
    const again = flock(t.dir, ['export', file], { db: t.db });
    assert.notEqual(again.code, 0);
    assert.deepEqual(readFileSync(file), before);
  } finally { t.done(); }
});

test('export quotes cells and guards against CSV injection', async () => {
  const t = tmp();
  try {
    await withContainer(t.db, async ({ services }) => {
      const { person } = await services.people.create(null, { name: '=cmd|"x"', email: 'evil.one@example.com', role: 'admin' });
      const team = await services.teams.createTeam(person, { name: 'Team, "A"' });
      const pos = await services.teams.createPosition(person, team.id, { name: '@lead' });
      await services.teams.setQualifications(person, person.id, [pos.id]);
      const svc = await services.calendar.createService(person, {
        date: '2999-01-07', title: '+Special\nservice', slots: [{ positionId: pos.id }],
      });
      await services.assignments.assign(person, svc.slots[0].id, { personId: person.id });
    });
    const file = path.join(t.dir, 'x.csv');
    assert.equal(flock(t.dir, ['export', file], { db: t.db }).code, 0);
    const text = readFileSync(file, 'utf8');
    assert.ok(text.includes('"Team, ""A"""'));
    const rows = parseCsv(text);
    assert.deepEqual(rows[1], ['2999-01-07', '09:00', "'+Special\nservice", 'Team, "A"', "'@lead", `'=cmd|"x"`, 'pending']);
  } finally { t.done(); }
});

test('csvCell protects every dangerous first character', () => {
  for (const c of ['=', '+', '-', '@', '\t']) assert.equal(csvCell(`${c}1`), `'${c}1`);
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell(null), '');
});

test('export date filter keeps only the range and validates dates', async () => {
  const t = tmp();
  try {
    await withContainer(t.db, async ({ services }) => {
      const { person } = await services.people.create(null, { name: 'Demo Admin', email: 'demo-admin@example.com', role: 'admin' });
      const team = await services.teams.createTeam(person, { name: 'Band' });
      const pos = await services.teams.createPosition(person, team.id, { name: 'Drums' });
      for (const date of ['2999-01-07', '2999-01-14', '2999-01-21']) {
        await services.calendar.createService(person, { date, slots: [{ positionId: pos.id }] });
      }
    });
    const file = path.join(t.dir, 'r.csv');
    const r = flock(t.dir, ['export', file, '--from', '2999-01-10', '--to', '2999-01-20'], { db: t.db });
    assert.equal(r.code, 0, r.err);
    const rows = parseCsv(readFileSync(file, 'utf8'));
    assert.deepEqual(rows.slice(1).map((x) => x[0]), ['2999-01-14']);
    const bad = flock(t.dir, ['export', path.join(t.dir, 'bad.csv'), '--from', 'nope'], { db: t.db });
    assert.notEqual(bad.code, 0);
    assert.ok(!existsSync(path.join(t.dir, 'bad.csv')));
    const rev = flock(t.dir, ['export', path.join(t.dir, 'bad.csv'), '--from', '2999-02-01', '--to', '2999-01-01'], { db: t.db });
    assert.notEqual(rev.code, 0);
  } finally { t.done(); }
});

test('--db wins over FLOCK_DB', async () => {
  const t = tmp();
  try {
    const other = path.join(t.dir, 'other.db');
    assert.equal(flock(t.dir, ['create-admin', 'pat.test@example.com', 'Pat Test', '--db', other], { db: t.db }).code, 0);
    assert.ok(existsSync(other));
    assert.ok(!existsSync(t.db));
  } finally { t.done(); }
});

test('help, version and unknown commands', () => {
  const t = tmp();
  try {
    const h = flock(t.dir, ['help']);
    assert.equal(h.code, 0);
    for (const w of ['create-admin', 'demo', 'backup', 'export', 'serve', 'version']) assert.ok(h.out.includes(w), w);
    assert.equal(flock(t.dir, ['version']).out.trim(), 'flock 0.3.0');
    const u = flock(t.dir, ['frobnicate']);
    assert.notEqual(u.code, 0);
    assert.match(u.err, /Unknown command: frobnicate/);
    assert.match(u.err, /Usage: flock/);
    assert.notEqual(flock(t.dir, []).code, 0);
    writeFileSync(path.join(t.dir, 'keep'), 'x');
  } finally { t.done(); }
});
