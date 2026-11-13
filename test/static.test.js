// Static files (src/static.js): ETags and 304s, cache headers, brotli/gzip,
// HEAD, and the file list stamped in front of /sw.js (decision 0009).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '../src/http.js';
import { encodingFor, hashOf, shellOf, WORKER } from '../src/static.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

// Serves `root` the way the app does and answers with raw bytes (no decoding).
async function withServer(root, fn) {
  const server = http.createServer((req, res) => { serveStatic(req, res, req.url, root); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const get = (urlPath, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  try { await fn(get); } finally { await new Promise((resolve) => server.close(resolve)); }
}

// A small web/ of our own, so files can be changed.
async function withTempWeb(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flock-static-'));
  const web = path.join(dir, 'web');
  await mkdir(path.join(web, 'lib'), { recursive: true });
  await writeFile(path.join(web, 'index.html'), '<!doctype html><title>t</title>\n');
  await writeFile(path.join(web, 'app.js'), 'export const v = 1;\n');
  await writeFile(path.join(web, 'lib', 'a.js'), 'export const a = 1;\n');
  await writeFile(path.join(web, 'sw.js'), "self.addEventListener('push', () => {});\n");
  await writeFile(path.join(web, 'gallery.html'), '<p>gallery</p>\n');
  try { await fn({ dir, web }); } finally { await rm(dir, { recursive: true, force: true }); }
}

const stamp = (body) => {
  const text = body.toString('utf8');
  const first = text.slice(0, text.indexOf('\n'));
  const m = /^self\.FLOCK_SHELL=(.*);$/.exec(first);
  assert.ok(m, `first line is the stamp: ${first.slice(0, 60)}`);
  return { shell: JSON.parse(m[1]), rest: text.slice(first.length + 1) };
};

test('every file has a weak ETag that stays the same while the file does', () => withServer(WEB, async (get) => {
  for (const p of ['/index.html', '/app.js', '/style.css', '/icon-192.png', '/sw.js']) {
    const a = await get(p);
    const b = await get(p);
    assert.equal(a.status, 200, p);
    assert.match(a.headers.etag, /^W\/"[A-Za-z0-9_-]{22}"$/, p);
    assert.equal(a.headers.etag, b.headers.etag, p);
  }
  const index = await get('/index.html');
  assert.equal(index.headers.etag, `W/"${hashOf(await readFile(path.join(WEB, 'index.html')))}"`);
}));

test('If-None-Match with the current tag gives 304 and no body', () => withServer(WEB, async (get) => {
  for (const p of ['/app.js', '/style.css', '/icon-192.png', '/sw.js']) {
    const { headers: { etag } } = await get(p);
    for (const tag of [etag, etag.replace(/^W\//, ''), `"other", ${etag}`, '*']) {
      const r = await get(p, { headers: { 'If-None-Match': tag, 'Accept-Encoding': 'br' } });
      assert.equal(r.status, 304, `${p} ${tag}`);
      assert.equal(r.body.length, 0, p);
      assert.equal(r.headers.etag, etag, p);
      assert.equal(r.headers['content-encoding'], undefined, p);
    }
    const stale = await get(p, { headers: { 'If-None-Match': 'W/"stale"' } });
    assert.equal(stale.status, 200, p);
    assert.ok(stale.body.length > 0, p);
  }
}));

test('code is checked every time; pictures and the font are kept for a day', () => withServer(WEB, async (get) => {
  for (const p of ['/', '/index.html', '/app.js', '/views/nav.js', '/style.css', '/manifest.webmanifest', '/sw.js']) {
    assert.equal((await get(p)).headers['cache-control'], 'no-cache', p);
  }
  for (const p of ['/icon-192.png', '/favicon.svg', '/fonts/inter.woff2']) {
    assert.equal((await get(p)).headers['cache-control'], 'max-age=86400', p);
  }
}));

test('text is sent as brotli or gzip when asked, and unpacks to the same bytes', () => withServer(WEB, async (get) => {
  for (const p of ['/style.css', '/app.js', '/index.html', '/manifest.webmanifest']) {
    const original = await readFile(path.join(WEB, p));
    const plain = await get(p);
    assert.equal(plain.headers['content-encoding'], undefined, p);
    assert.equal(plain.headers.vary, 'Accept-Encoding', p);
    assert.deepEqual(plain.body, original, p);

    const br = await get(p, { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
    assert.equal(br.headers['content-encoding'], 'br', p);
    assert.equal(br.headers.vary, 'Accept-Encoding', p);
    assert.equal(Number(br.headers['content-length']), br.body.length, p);
    assert.ok(br.body.length < original.length, p);
    assert.deepEqual(zlib.brotliDecompressSync(br.body), original, p);

    const gz = await get(p, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(gz.headers['content-encoding'], 'gzip', p);
    assert.deepEqual(zlib.gunzipSync(gz.body), original, p);

    // Packing never changes the tag: it names the file, not the bytes on the wire.
    assert.equal(br.headers.etag, plain.headers.etag, p);
    assert.equal(gz.headers.etag, plain.headers.etag, p);
  }
}));

test('the font and the pictures are never packed', () => withServer(WEB, async (get) => {
  for (const p of ['/fonts/inter.woff2', '/icon-192.png', '/icon-512.png']) {
    const r = await get(p, { headers: { 'Accept-Encoding': 'br, gzip' } });
    assert.equal(r.status, 200, p);
    assert.equal(r.headers['content-encoding'], undefined, p);
    assert.equal(r.headers.vary, undefined, p);
    assert.deepEqual(r.body, await readFile(path.join(WEB, p)), p);
  }
}));

test('a file too small to gain from packing is sent as it is', () => withTempWeb(({ web }) => withServer(web, async (get) => {
  await writeFile(path.join(web, 'tiny.js'), 'x');
  const r = await get('/tiny.js', { headers: { 'Accept-Encoding': 'br' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-encoding'], undefined);
  assert.equal(r.body.toString(), 'x');
})));

test('HEAD gives the same headers as GET and no body', () => withServer(WEB, async (get) => {
  for (const [p, enc] of [['/style.css', 'br'], ['/style.css', ''], ['/icon-192.png', 'br'], ['/sw.js', 'gzip']]) {
    const headers = enc ? { 'Accept-Encoding': enc } : {};
    const full = await get(p, { headers });
    const head = await get(p, { method: 'HEAD', headers });
    assert.equal(head.status, 200, p);
    assert.equal(head.body.length, 0, p);
    for (const h of ['content-type', 'content-length', 'content-encoding', 'etag', 'cache-control', 'vary']) {
      assert.equal(head.headers[h], full.headers[h], `${p} ${enc} ${h}`);
    }
  }
}));

test('only files of a known type inside the root are sent', () => withTempWeb(({ dir, web }) => withServer(web, async (get) => {
  // A sibling folder whose name starts like the root's must not be reachable.
  await mkdir(path.join(dir, 'web-secret'));
  await writeFile(path.join(dir, 'web-secret', 'a.js'), 'secret');
  await writeFile(path.join(web, 'notes.txt'), 'not served');
  for (const p of ['/../web-secret/a.js', '/..%2fweb-secret%2fa.js', '/lib', '/notes.txt', '/missing.js',
    '/lib%00.js', '/lib%5ca.js', '/%E0%A4%A']) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.body.toString().includes('secret'), p);
  }
  assert.equal((await get('/lib/a.js')).status, 200);
  assert.equal((await get('/')).status, 200);
})));

test('the shell list leaves out the worker, the gallery and the privacy page, and is sorted', async () => {
  const shell = await shellOf(WEB);
  const names = Object.keys(shell.files);
  for (const left of [WORKER, '/gallery.html', '/gallery.js', '/privacy.html']) {
    assert.ok(!names.includes(left), `${left} is not in the shell`);
  }
  for (const kept of ['/index.html', '/app.js', '/style.css', '/manifest.webmanifest', '/views/nav.js',
    '/lib/icons.js', '/fonts/inter.woff2', '/icon-192.png', '/favicon.svg']) {
    assert.ok(names.includes(kept), `${kept} is in the shell`);
  }
  assert.deepEqual(names, [...names].sort());
  assert.ok(names.every((n) => n.startsWith('/') && !n.includes('\\')));
  for (const n of names) assert.equal(shell.files[n], hashOf(await readFile(path.join(WEB, n))), n);
  assert.match(shell.build, /^[A-Za-z0-9_-]{12}$/);
  assert.deepEqual(await shellOf(WEB), shell, 'the same files give the same list');
});

test('the build changes when any file of the app changes, and not for files outside the shell', () => withTempWeb(async ({ web }) => {
  const first = await shellOf(web);
  assert.deepEqual(Object.keys(first.files), ['/app.js', '/index.html', '/lib/a.js']);

  await writeFile(path.join(web, 'gallery.html'), '<p>gallery, changed</p>\n');
  await writeFile(path.join(web, 'sw.js'), "self.addEventListener('push', () => { /* changed */ });\n");
  assert.equal((await shellOf(web)).build, first.build, 'gallery and worker are not part of the build');

  await writeFile(path.join(web, 'lib', 'a.js'), 'export const a = 22;\n');
  const second = await shellOf(web);
  assert.notEqual(second.build, first.build);
  assert.notEqual(second.files['/lib/a.js'], first.files['/lib/a.js']);
  assert.equal(second.files['/app.js'], first.files['/app.js']);

  await writeFile(path.join(web, 'new.css'), 'p{}\n');
  assert.notEqual((await shellOf(web)).build, second.build, 'a new file changes the build');
}));

test('/sw.js carries the shell list, and its hashes are the ETags the server sends', () => withServer(WEB, async (get) => {
  const r = await get(WORKER);
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/javascript/);
  const { shell, rest } = stamp(r.body);
  assert.equal(rest, await readFile(path.join(WEB, 'sw.js'), 'utf8'));
  assert.deepEqual(shell, await shellOf(WEB));
  for (const [name, hash] of Object.entries(shell.files)) {
    const file = await get(name, { method: 'HEAD' });
    assert.equal(file.status, 200, name);
    assert.equal(file.headers.etag, `W/"${hash}"`, name);
  }
  // The worker's own tag is the hash of the bytes sent, stamp included.
  assert.equal(r.headers.etag, `W/"${hashOf(r.body)}"`);
}));

test('a change to any app file changes the bytes of /sw.js, so phones see a new version', () => withTempWeb(({ web }) => withServer(web, async (get) => {
  const before = await get(WORKER);
  const again = await get(WORKER, { headers: { 'If-None-Match': before.headers.etag } });
  assert.equal(again.status, 304, 'nothing changed');

  await writeFile(path.join(web, 'app.js'), 'export const v = 22;\n');
  const after = await get(WORKER, { headers: { 'If-None-Match': before.headers.etag } });
  assert.equal(after.status, 200);
  assert.notEqual(after.headers.etag, before.headers.etag);
  const a = stamp(before.body).shell;
  const b = stamp(after.body).shell;
  assert.notEqual(b.build, a.build);
  assert.notEqual(b.files['/app.js'], a.files['/app.js']);
  assert.equal(stamp(after.body).rest, "self.addEventListener('push', () => {});\n");

  const packed = await get(WORKER, { headers: { 'Accept-Encoding': 'br' } });
  if (packed.headers['content-encoding'] === 'br') {
    assert.deepEqual(zlib.brotliDecompressSync(packed.body), after.body);
  } else {
    assert.deepEqual(packed.body, after.body);
  }
})));

test('encodingFor picks brotli, then gzip, and honours q=0', () => {
  const cases = [
    ['br', 'br'],
    ['gzip', 'gzip'],
    ['gzip, deflate, br', 'br'],
    ['GZIP, BR', 'br'],
    ['br;q=0, gzip', 'gzip'],
    ['br;q=0', null],
    ['br; q=0.0, gzip;q=0', null],
    ['gzip;q=0.5, br;q=0.1', 'br'],
    ['*', 'br'],
    ['*;q=0', null],
    ['*, br;q=0', 'gzip'],
    ['identity', null],
    ['deflate', null],
    ['br;q=nope', null],
    ['', null],
    [undefined, null],
    [' , ,', null],
  ];
  for (const [header, want] of cases) assert.equal(encodingFor(header), want, String(header));
});
