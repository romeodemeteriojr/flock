// Files and links on a service (decision 0011): who can add and see them, the
// 5 MB limit, links, the week-after expiry and the manual clean-up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/app.js';
import { addPerson } from './helpers/seed.js';
import { createClient } from './helpers/client.js';
import { run } from '../src/cli/commands.js';
import {
  MAX_FILE_BYTES, MAX_ADDS_PER_HOUR, MAX_LIVE_BYTES, cleanName, cleanUrl, typeFor, expiresOn,
} from '../src/services/attachments-service.js';
import { downloadHeaders } from '../src/routes/attachments.js';

const SERVICE_DAY = '2025-01-12';

async function boot() {
  let now = new Date('2025-01-10T12:00:00');
  const app = await startTestApp({ now: () => now });
  const client = createClient(app);
  const { services } = app.container;
  const adminId = await addPerson(app, { name: 'Ada Admin', email: 'ada@example.com', role: 'admin' });
  const onId = await addPerson(app, { name: 'Max Member', email: 'max@example.com' });
  const offId = await addPerson(app, { name: 'Olive Other', email: 'olive@example.com' });
  const noId = await addPerson(app, { name: 'Nia No', email: 'nia@example.com' });
  const actor = { id: adminId };
  const team = await services.teams.createTeam(actor, { name: 'Band' });
  const pos = await services.teams.createPosition(actor, team.id, { name: 'Vocals' });
  for (const id of [onId, noId]) await services.teams.setQualifications(actor, id, [pos.id]);
  const svc = await services.calendar.createService(actor, { date: SERVICE_DAY, slots: [{ positionId: pos.id, count: 2 }] });
  await services.assignments.assign(actor, svc.slots[0].id, { personId: onId });
  await services.assignments.assign(actor, svc.slots[1].id, { personId: noId });
  await services.assignments.respond(noId, svc.slots[1].id, 'decline');
  const who = {};
  for (const [k, email] of [['admin', 'ada@example.com'], ['on', 'max@example.com'], ['off', 'olive@example.com'], ['no', 'nia@example.com']]) {
    who[k] = client.browser();
    assert.equal((await who[k].login(email, 'test-pass-1')).status, 200);
  }
  const upload = (b, bytes, { name = 'Setlist.pdf', type = 'application/pdf', serviceId = svc.id } = {}) => (
    b.call('POST', `/api/services/${serviceId}/files?name=${encodeURIComponent(name)}`, bytes, { headers: { 'Content-Type': type } })
  );
  const setNow = (iso) => { now = new Date(iso); };
  return { app, svc, who, upload, setNow, ids: { adminId, onId, offId } };
}

async function withBoot(fn) {
  const ctx = await boot();
  try { await fn(ctx); } finally { await ctx.app.close(); }
}

test('files: the person serving adds one and opens it; the phone gets it to show itself', () => withBoot(async ({ svc, who, upload }) => {
  const add = await upload(who.on, '%PDF-1.4 setlist');
  assert.equal(add.status, 201, add.text);
  assert.deepEqual(Object.keys(add.json).sort(), ['addedByName', 'canRemove', 'createdAt', 'href', 'id', 'kind', 'mime', 'name', 'size']);
  assert.equal(add.json.href, `/api/attachments/${add.json.id}`);
  assert.equal(add.json.canRemove, true);

  const list = await who.on.get(`/api/services/${svc.id}/files`);
  assert.equal(list.status, 200);
  assert.equal(list.json.expiresOn, '2025-01-19');
  assert.equal(list.json.expired, false);
  assert.equal(list.json.maxBytes, MAX_FILE_BYTES);
  assert.deepEqual(list.json.files.map((f) => [f.name, f.kind, f.addedByName]), [['Setlist.pdf', 'file', 'Max Member']]);

  const open = await who.on.get(add.json.href);
  assert.equal(open.status, 200);
  assert.equal(open.text, '%PDF-1.4 setlist');
  assert.equal(open.headers['content-type'], 'application/pdf');
  assert.match(open.headers['content-disposition'], /^inline; filename="Setlist.pdf"/);
  assert.equal(open.headers['x-content-type-options'], 'nosniff');

  // The schedule and the services list say how many there are.
  const mine = (await who.on.get('/api/me/schedule')).json.items[0];
  assert.equal(mine.serviceId, svc.id);
  assert.equal(mine.files, 1);
  const admin = (await who.admin.get('/api/services?from=2025-01-01&to=2025-01-31')).json;
  assert.equal(admin.find((s) => s.id === svc.id).files, 1);
}));

test('files: only the people serving (asked or confirmed) and schedulers can see them', () => withBoot(async ({ svc, who, upload }) => {
  const f = (await upload(who.on, 'hello', { name: 'notes.txt', type: 'text/plain' })).json;
  assert.equal((await who.admin.get(`/api/services/${svc.id}/files`)).status, 200);
  assert.equal((await who.admin.get(f.href)).status, 200);
  for (const b of [who.off, who.no]) {
    const list = await b.get(`/api/services/${svc.id}/files`);
    assert.equal(list.status, 403);
    assert.ok(!list.text.includes('notes.txt'));
    const open = await b.get(f.href);
    assert.equal(open.status, 404, 'a file you cannot see looks like one that does not exist');
    assert.ok(!open.text.includes('hello'));
  }
  assert.equal((await who.on.get('/api/services/9999/files')).status, 404);
  assert.equal((await who.on.get('/api/attachments/9999')).status, 404);
}));

test('files: anyone signed in can add one; only who added it or a scheduler can remove it', () => withBoot(async ({ svc, who, upload }) => {
  const byOther = await upload(who.off, 'from olive', { name: 'olive.txt', type: 'text/plain' });
  assert.equal(byOther.status, 201, 'someone not serving may still add a file');
  const byOn = (await upload(who.on, 'from max', { name: 'max.txt', type: 'text/plain' })).json;
  const seen = (await who.on.get(`/api/services/${svc.id}/files`)).json.files;
  assert.deepEqual(seen.map((f) => [f.name, f.canRemove]), [['olive.txt', false], ['max.txt', true]]);

  assert.equal((await who.on.del(`/api/attachments/${byOther.json.id}`)).status, 403);
  assert.equal((await who.off.del(`/api/attachments/${byOther.json.id}`)).status, 200, 'who added it can take it back');
  assert.equal((await who.admin.del(`/api/attachments/${byOn.id}`)).status, 200, 'a scheduler can remove anyone\'s');
  assert.equal((await who.admin.del(`/api/attachments/${byOn.id}`)).status, 404);
  assert.deepEqual((await who.on.get(`/api/services/${svc.id}/files`)).json.files, []);
}));

test('files: at most 5 MB; bigger is refused with a pointer to links', () => withBoot(async ({ svc, who, upload }) => {
  const exact = await upload(who.on, Buffer.alloc(MAX_FILE_BYTES, 1), { name: 'big.mp4', type: 'application/octet-stream' });
  assert.equal(exact.status, 201, 'exactly 5 MB is fine');
  const over = await upload(who.on, Buffer.alloc(MAX_FILE_BYTES + 1, 1), { name: 'huge.mp4', type: 'application/octet-stream' });
  assert.equal(over.status, 413);
  assert.match(over.json.error, /5 MB.*link/);
  const empty = await upload(who.on, '', { name: 'empty.txt' });
  assert.equal(empty.status, 400);
  const noName = await upload(who.on, 'x', { name: '' });
  assert.equal(noName.status, 400);
  assert.equal((await who.on.get(`/api/services/${svc.id}/files`)).json.files.length, 1);
}));

test('files: only a short list of types; the type comes from the name, not the phone', () => withBoot(async ({ app, svc, who, upload }) => {
  for (const name of ['app.apk', 'app.ipa', 'setup.exe', 'wifi.mobileconfig', 'page.html', 'logo.svg', 'songs.zip', 'old.doc', 'notes']) {
    const r = await upload(who.on, 'x', { name, type: 'application/pdf' });
    assert.equal(r.status, 400, name);
    assert.equal(r.json.code, 'file_type', name);
    assert.match(r.json.error, /link/);
  }
  assert.equal(await app.data.attachments.countForService(svc.id), 0, 'nothing refused was kept');
  // A phone that says text/html for a PDF does not get it sent back as a page.
  const lying = await upload(who.on, '%PDF-1.4', { name: 'plan.pdf', type: 'text/html' });
  assert.equal(lying.status, 201);
  assert.equal(lying.json.mime, 'application/pdf');
  const photo = await upload(who.on, 'jpeg bytes', { name: 'Stage.JPG', type: '' });
  assert.equal(photo.json.mime, 'image/jpeg');
  assert.equal((await who.on.get(photo.json.href)).headers['content-type'], 'image/jpeg');
}));

test('files: each person can add 30 an hour; removing one does not give the try back', () => withBoot(async ({ svc, who, upload, setNow }) => {
  // 20 files and links fit on one service; use a second for the rest.
  const other = (await who.admin.post('/api/services', { date: '2025-01-19' })).json;
  const add = (i) => who.off.post(`/api/services/${i < 15 ? svc.id : other.id}/links`, { url: `https://x.example/${i}` });
  for (let i = 0; i < MAX_ADDS_PER_HOUR - 1; i++) assert.equal((await add(i)).status, 201, `add ${i}`);
  const last = (await add(29)).json;
  assert.equal((await who.off.del(`/api/attachments/${last.id}`)).status, 200);
  const over = await add(30);
  assert.equal(over.status, 429);
  assert.equal(over.json.code, 'too_many_adds');
  assert.ok(Number(over.headers['retry-after']) > 0);
  assert.equal((await upload(who.off, 'x', { name: 'a.txt', serviceId: other.id })).status, 429, 'files count too');
  assert.equal((await upload(who.on, 'x', { name: 'a.txt', serviceId: other.id })).status, 201, 'others are not affected');
  assert.equal((await who.admin.post(`/api/services/${other.id}/links`, { url: 'https://x.example/a' })).status, 201);
  setNow('2025-01-10T13:01:00');
  assert.equal((await add(31)).status, 201, 'an hour later it is fine again');
}));

test('files: each person can keep 50 MB on services not yet expired; schedulers have no cap', () => withBoot(async ({ svc, who, upload, setNow }) => {
  const other = (await who.admin.post('/api/services', { date: '2025-01-19' })).json;
  const five = Buffer.alloc(MAX_FILE_BYTES, 1);
  const n = MAX_LIVE_BYTES / MAX_FILE_BYTES;
  for (let i = 0; i < n; i++) {
    assert.equal((await upload(who.off, five, { name: `${i}.mp4`, serviceId: i < 5 ? svc.id : other.id })).status, 201, `file ${i}`);
  }
  const over = await upload(who.off, 'one more byte', { name: 'x.txt', serviceId: other.id });
  assert.equal(over.status, 409);
  assert.equal(over.json.code, 'quota');
  assert.match(over.json.error, /50 MB/);
  assert.equal((await who.off.post(`/api/services/${other.id}/links`, { url: 'https://x.example/big' })).status, 201, 'links take no room');
  assert.equal((await upload(who.admin, five, { name: 'slides.pdf', serviceId: other.id })).status, 201, 'schedulers have no cap');
  // Once the first service's week is over, its files stop counting.
  setNow('2025-01-20T08:00:00');
  assert.equal((await upload(who.off, five, { name: 'later.mp4', serviceId: other.id })).status, 201);
}));

test('links: an https address, named by the person or by its site; nothing that runs code', () => withBoot(async ({ svc, who }) => {
  const named = await who.on.post(`/api/services/${svc.id}/links`, { name: 'Rehearsal video', url: 'https://drive.example.com/v/123' });
  assert.equal(named.status, 201, named.text);
  assert.equal(named.json.kind, 'link');
  assert.equal(named.json.href, 'https://drive.example.com/v/123');
  const unnamed = await who.on.post(`/api/services/${svc.id}/links`, { url: 'https://cloud.example.org/big.zip' });
  assert.equal(unnamed.json.name, 'cloud.example.org');
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://x.example/f', 'not a url', 'https://user:pw@x.example/', '']) {
    assert.equal((await who.on.post(`/api/services/${svc.id}/links`, { url })).status, 400, url);
  }
  assert.equal((await who.on.get(`/api/services/${svc.id}/files`)).json.files.length, 2);
}));

test('expiry: a week after the service nobody can open or add them; the clean-up deletes them', () => withBoot(async ({ app, svc, who, upload, setNow }) => {
  const f = (await upload(who.on, 'old setlist', { name: 'old.txt', type: 'text/plain' })).json;
  await who.on.post(`/api/services/${svc.id}/links`, { url: 'https://example.com/x' });

  setNow('2025-01-19T23:00:00'); // the 7th day after: still there
  assert.equal((await who.on.get(f.href)).status, 200);
  const purgeEarly = await who.admin.post('/api/admin/files/purge');
  assert.deepEqual(purgeEarly.json, { removed: 0, bytes: 0 });

  setNow('2025-01-20T08:00:00'); // the day after that: expired
  const list = (await who.on.get(`/api/services/${svc.id}/files`)).json;
  assert.equal(list.expired, true);
  assert.deepEqual(list.files, []);
  assert.equal((await who.on.get(f.href)).status, 404);
  assert.equal((await who.admin.get(f.href)).status, 404, 'expired is gone for schedulers too');
  const late = await upload(who.on, 'too late', { name: 'late.txt', type: 'text/plain' });
  assert.equal(late.status, 409);
  assert.equal(late.json.code, 'expired');
  assert.equal(await app.data.attachments.countForService(svc.id), 2, 'nothing is deleted until someone runs the clean-up');

  assert.equal((await who.on.post('/api/admin/files/purge')).status, 403, 'only schedulers run the clean-up');
  const purge = await who.admin.post('/api/admin/files/purge');
  assert.deepEqual(purge.json, { removed: 2, bytes: 11 });
  assert.equal(await app.data.attachments.countForService(svc.id), 0);
}));

test('my schedule: last week\'s services with files stay in reach until they expire', () => withBoot(async ({ svc, who, upload, setNow }) => {
  const bare = (await who.admin.post('/api/services', { date: '2025-01-11' })).json; // no files: never listed
  assert.ok(bare.id);
  assert.deepEqual((await who.on.get('/api/me/schedule')).json.recent, [], 'nothing before the service');
  await upload(who.on, '%PDF-1.4', { name: 'setlist.pdf' });
  setNow('2025-01-14T09:00:00');
  const mine = (await who.on.get('/api/me/schedule')).json;
  assert.deepEqual(mine.recent, [{
    slotId: mine.recent[0].slotId, serviceId: svc.id, files: 1, date: SERVICE_DAY, time: mine.recent[0].time,
    serviceTitle: mine.recent[0].serviceTitle, positions: ['Vocals'],
  }]);
  assert.ok(!mine.items.some((i) => i.serviceId === svc.id), 'it is no longer in what is coming up');
  for (const b of [who.no, who.off]) assert.deepEqual((await b.get('/api/me/schedule')).json.recent, [], 'not for who said no or never served');
  setNow('2025-01-19T09:00:00');
  assert.equal((await who.on.get('/api/me/schedule')).json.recent.length, 1, 'the 7th day after: still there');
  setNow('2025-01-20T09:00:00');
  assert.deepEqual((await who.on.get('/api/me/schedule')).json.recent, [], 'gone once the files expire');
}));

test('expiry follows the service date when the service moves', () => withBoot(async ({ app, svc, who, upload, setNow }) => {
  const f = (await upload(who.on, 'moving', { name: 'm.txt', type: 'text/plain' })).json;
  await app.container.services.calendar.updateService({ id: 1 }, svc.id, { date: '2025-01-26' });
  setNow('2025-01-21T08:00:00'); // past the old date's week, inside the new one
  assert.equal((await who.on.get(f.href)).status, 200);
  assert.equal((await who.on.get(`/api/services/${svc.id}/files`)).json.expiresOn, '2025-02-02');
}));

test('purge-files: the command-line clean-up', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'flock-purge-'));
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    assert.equal(await run(['purge-files', '--db', path.join(dir, 'f.db')], {}), 0);
    assert.match(logs.join('\n'), /Nothing to delete/);
    assert.notEqual(await run(['purge-files', 'extra', '--db', path.join(dir, 'f.db')], {}), 0);
  } finally {
    console.log = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('attachments: names, types and addresses are cleaned', () => {
  assert.equal(cleanName('  ../../etc/passwd '), '..-..-etc-passwd');
  assert.equal(cleanName('a\u0000b\nc.pdf'), 'abc.pdf');
  assert.equal(cleanName('invoice\u202Efdp.exe'), 'invoicefdp.exe', 'no hidden right-to-left trick');
  assert.equal(cleanName('a\u2066b\u2069\u200F.pdf'), 'ab.pdf');
  const long = cleanName(`${'x'.repeat(300)}.pdf`);
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('….pdf'));
  assert.equal(typeFor('Setlist.PDF'), 'application/pdf');
  assert.equal(typeFor('stage.jpeg'), 'image/jpeg');
  assert.equal(typeFor('song.chopro'), 'text/plain');
  for (const bad of ['app.apk', 'app.ipa', 'setup.exe', 'wifi.mobileconfig', 'page.html', 'pic.svg', 'run.sh', 'x.js',
    'songs.zip', 'old.doc', 'macro.docm', 'sheet.xlsm', 'pdf', 'noext', '.pdf.exe', 'a.pdf ', undefined, 'constructor', 'x.__proto__']) {
    assert.equal(typeFor(bad), null, String(bad));
  }
  assert.equal(cleanUrl(' https://x.example/a b '), 'https://x.example/a%20b');
  assert.equal(cleanUrl('javascript:alert(1)'), null);
  assert.equal(expiresOn('2025-12-28'), '2026-01-04');
});

test('downloads: page-like types are never sent as themselves; others are sandboxed', () => {
  const base = { name: 'x', size: 1 };
  const html = downloadHeaders({ ...base, mime: 'text/html' }, 1);
  assert.equal(html['Content-Type'], 'application/octet-stream');
  assert.match(html['Content-Disposition'], /^attachment;/);
  assert.match(html['Content-Security-Policy'], /sandbox/);
  assert.equal(downloadHeaders({ ...base, mime: 'image/svg+xml' }, 1)['Content-Type'], 'application/octet-stream');
  const img = downloadHeaders({ ...base, mime: 'image/jpeg' }, 1);
  assert.match(img['Content-Disposition'], /^inline;/);
  assert.match(img['Content-Security-Policy'], /sandbox/);
  const docx = downloadHeaders({ ...base, name: 'Plan ü "1".docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, 1);
  assert.match(docx['Content-Disposition'], /^attachment; filename="Plan _ _1_.docx"; filename\*=UTF-8''Plan%20%C3%BC%20%221%22.docx$/);
});

test('downloads: only PDF and text may be framed, and only by Flock (its viewer)', () => {
  const base = { name: 'x', size: 1 };
  for (const mime of ['application/pdf', 'text/plain']) {
    const h = downloadHeaders({ ...base, mime }, 1);
    assert.match(h['Content-Security-Policy'], /frame-ancestors 'self'/, mime);
    assert.equal(h['X-Frame-Options'], 'SAMEORIGIN', mime);
  }
  assert.match(downloadHeaders({ ...base, mime: 'text/plain' }, 1)['Content-Security-Policy'], /^sandbox;/);
  for (const mime of ['image/jpeg', 'video/mp4', 'text/html', 'application/vnd.ms-excel', undefined]) {
    const h = downloadHeaders({ ...base, mime }, 1);
    assert.match(h['Content-Security-Policy'], /frame-ancestors 'none'/, String(mime));
    assert.equal(h['X-Frame-Options'], 'DENY', String(mime));
  }
});
