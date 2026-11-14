// Page-wide errors: only Flock's own get the "Something went wrong" toast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { errorFromEvent, reasonFromEvent } from '../web/lib/stray-error.js';

test('a window error with no error attached is not shown (iPhone Add to Home Screen)', () => {
  assert.equal(errorFromEvent({ message: 'Script error.', error: null }), null);
  assert.equal(errorFromEvent({ message: 'ResizeObserver loop completed', error: undefined }), null);
  assert.equal(errorFromEvent({}), null);
  assert.equal(errorFromEvent(null), null);
  assert.equal(errorFromEvent({ error: 'a string' }), null);
});

test('a real error thrown in Flock is still shown', () => {
  const err = new TypeError('x is undefined');
  assert.equal(errorFromEvent({ error: err }), err);
});

test('an empty or cancelled rejection is not shown; a real one is', () => {
  assert.equal(reasonFromEvent({ reason: undefined }), null);
  assert.equal(reasonFromEvent({ reason: null }), null);
  assert.equal(reasonFromEvent({ reason: 'nope' }), null);
  const abort = new Error('The operation was aborted.'); abort.name = 'AbortError';
  assert.equal(reasonFromEvent({ reason: abort }), null);
  const api = new Error('Please log in again.'); api.name = 'ApiError';
  assert.equal(reasonFromEvent({ reason: api }), api);
  const bug = new RangeError('bad');
  assert.equal(reasonFromEvent({ reason: bug }), bug);
});

test('app.js filters both page-wide handlers through stray-error.js', () => {
  const src = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(src, /'unhandledrejection'[\s\S]{0,120}reasonFromEvent\(e\)/);
  assert.match(src, /'error', \(e\) => \{\s*const err = errorFromEvent\(e\)/);
});
