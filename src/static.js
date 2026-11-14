// Sends the files in web/: the app itself. No build step, so the same names
// are served release after release. Three things keep that fast and correct:
//
//  - Every file has an ETag (a hash of its bytes). Code is sent with
//    "Cache-Control: no-cache": the browser asks each time and gets a short
//    304 when nothing changed. Pictures and the font may be kept for a day.
//  - Text is sent as brotli or gzip when the browser takes it. The packed
//    bytes are made once and kept in memory until the file changes.
//  - /sw.js is sent with one line added in front: the list of files that make
//    up the app and a hash of each (decision 0009). So the worker's bytes
//    change whenever any file of the app changes, which is how a phone learns
//    there is a new version.
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import zlib from 'node:zlib';

export const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
});

// Text shrinks to about a third; the font and the pictures are already packed.
const SHRINKS = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest']);
// Seconds a browser may keep a file without asking. Everything else asks every time.
const KEEP_SECONDS = Object.freeze({ '.woff2': 86400, '.png': 86400, '.svg': 86400, '.ico': 86400 });

/** The service worker; the only file that is not sent exactly as it is on disk. */
export const WORKER = '/sw.js';
// Not part of the app people use, so not saved on their phones (decision 0009).
const NOT_SHELL = new Set([WORKER, '/gallery.html', '/gallery.js', '/privacy.html']);
// Big libraries loaded only when needed (PDF.js, about 1.8 MB): fetched when a
// PDF opens, never saved with the app.
const NOT_SHELL_DIR = '/vendor/';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const PACK = {
  // Quality 6 is within a tenth of the best brotli can do, at a fortieth of the time.
  br: (data) => brotli(data, { params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 6,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
  } }),
  gzip: (data) => gzip(data, { level: 9 }),
};

/** A short hash of some bytes: 16 bytes of SHA-256 as base64url (22 characters). */
export function hashOf(data) {
  return createHash('sha256').update(data).digest().subarray(0, 16).toString('base64url');
}

const body = (data) => ({ data, hash: hashOf(data), packed: {} });

// file path -> { mtimeMs, size, data, hash, packed }. A file is read again
// only when its size or its time of change is different.
const files = new Map();

async function load(file) {
  let info;
  try { info = await stat(file); } catch { return null; }
  if (!info.isFile()) return null;
  const hit = files.get(file);
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit;
  let data;
  try { data = await readFile(file); } catch { return null; }
  const entry = { mtimeMs: info.mtimeMs, size: info.size, ...body(data) };
  files.set(file, entry);
  return entry;
}

/**
 * The files that make up the app, with a hash of each, and one hash of them
 * all ("build"). Paths are as the browser asks for them ("/views/nav.js").
 */
export async function shellOf(root) {
  const base = path.resolve(root);
  const found = {};
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  await Promise.all(entries.map(async (e) => {
    if (!e.isFile() || !TYPES[path.extname(e.name).toLowerCase()]) return;
    const file = path.join(e.parentPath, e.name);
    const name = '/' + path.relative(base, file).split(path.sep).join('/');
    if (NOT_SHELL.has(name) || name.startsWith(NOT_SHELL_DIR)) return;
    const entry = await load(file);
    if (entry) found[name] = entry.hash;
  }));
  const names = Object.keys(found).sort();
  const sum = createHash('sha256');
  for (const name of names) sum.update(`${name}\n${found[name]}\n`);
  return {
    build: sum.digest().subarray(0, 9).toString('base64url'),
    files: Object.fromEntries(names.map((name) => [name, found[name]])),
  };
}

// The worker with the list in front. Made again only when the list or the worker changes.
async function workerBody(entry, root) {
  const shell = await shellOf(root);
  if (entry.stamped?.build !== shell.build) {
    const line = Buffer.from(`self.FLOCK_SHELL=${JSON.stringify(shell)};\n`);
    entry.stamped = { build: shell.build, ...body(Buffer.concat([line, entry.data])) };
  }
  return entry.stamped;
}

/** 'br', 'gzip' or null: the best packing this request accepts (RFC 9110, 12.5.3). */
export function encodingFor(header) {
  const q = {};
  for (const part of String(header ?? '').toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map((s) => s.trim());
    if (!name) continue;
    const weight = params.find((p) => p.startsWith('q='));
    const n = weight ? Number(weight.slice(2)) : 1;
    q[name] = Number.isFinite(n) ? n : 0;
  }
  const ok = (name) => (q[name] ?? q['*'] ?? 0) > 0;
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return null;
}

// True when one of the tags in If-None-Match is this file's (weak comparison).
function sameTag(header, tag) {
  const bare = (t) => t.trim().replace(/^W\//, '');
  return String(header ?? '').split(',').some((t) => t.trim() === '*' || bare(t) === bare(tag));
}

function packed(entry, encoding) {
  // The promise is kept, so two requests at once pack the file only once.
  entry.packed[encoding] ??= PACK[encoding](entry.data).catch(() => null);
  return entry.packed[encoding];
}

/**
 * Answers a GET or HEAD for a file under root. notFound() sends the 404.
 * Only files of a known type inside root are ever read.
 */
export async function sendFile(req, res, rawUrl, root, notFound) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname);
  } catch { return notFound(); }
  if (pathname.includes('\0') || pathname.includes('\\')) return notFound();
  if (pathname.endsWith('/')) pathname += 'index.html';
  const base = path.resolve(root);
  const file = path.resolve(base, '.' + pathname);
  if (file !== base && !file.startsWith(base + path.sep)) return notFound();
  const ext = path.extname(file).toLowerCase();
  const type = TYPES[ext];
  if (!type) return notFound();
  let entry = await load(file);
  if (!entry) return notFound();
  if (file === path.join(base, WORKER)) entry = await workerBody(entry, base);

  const headers = {
    'Content-Type': type,
    ETag: `W/"${entry.hash}"`,
    'Cache-Control': KEEP_SECONDS[ext] ? `max-age=${KEEP_SECONDS[ext]}` : 'no-cache',
  };
  const shrinks = SHRINKS.has(ext);
  if (shrinks) headers.Vary = 'Accept-Encoding';
  if (sameTag(req.headers['if-none-match'], headers.ETag)) {
    res.writeHead(304, headers);
    return res.end();
  }
  let data = entry.data;
  const encoding = shrinks ? encodingFor(req.headers['accept-encoding']) : null;
  if (encoding) {
    const small = await packed(entry, encoding);
    if (small && small.length < data.length) {
      data = small;
      headers['Content-Encoding'] = encoding;
    }
  }
  headers['Content-Length'] = data.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : data);
}
