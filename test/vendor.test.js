// Libraries Flock ships in web/vendor (no npm packages: they are copied in).
// Each file is pinned by hash, so it changes only on purpose, and none of them
// is saved with the app on the phone (src/static.js): they load when needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellOf } from '../src/static.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'web', 'vendor');

// PDF.js 6.4.299, legacy build (older iPhones), from the npm package pdfjs-dist
// (checked against the registry's sha512). .mjs renamed to .js.
const PINNED = {
  'pdfjs/pdf.min.js': 'bccc24ea711db8e44503629519904a5292d73b9daaa214bbe7cdcc282b0f4259',
  'pdfjs/pdf.worker.min.js': '145d2dd3ab0c86151011dba95acfa2d5336e2accd59388ea43dbee0efddaaec6',
};

test('vendor: only the pinned files, byte for byte, each with its licence', () => {
  const found = readdirSync(VENDOR, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(VENDOR, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
  assert.deepEqual(found, Object.keys(PINNED).sort());
  for (const [name, hash] of Object.entries(PINNED)) {
    assert.equal(createHash('sha256').update(readFileSync(path.join(VENDOR, name))).digest('hex'), hash, name);
  }
  assert.ok(existsSync(path.join(ROOT, 'licenses', 'pdfjs-Apache-2.0.txt')));
});

test('vendor: not saved with the app on the phone', async () => {
  const shell = await shellOf(path.join(ROOT, 'web'));
  assert.ok(Object.keys(shell.files).includes('/lib/viewer.js'));
  assert.deepEqual(Object.keys(shell.files).filter((f) => f.startsWith('/vendor/')), []);
});
