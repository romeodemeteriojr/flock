// A full text box says so instead of silently refusing letters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onLimitInput, limitText } from '../web/lib/limit.js';

function box(value, maxLength) {
  const parent = {};
  const doc = { createElement: () => ({ classList: { contains: (c) => c === 'limit-hint' }, setAttribute(k, v) { this[k] = v; }, remove() { b.nextElementSibling = null; } }) };
  const b = { value, maxLength, parentNode: parent, ownerDocument: doc, nextElementSibling: null, after(p) { this.nextElementSibling = p; } };
  return b;
}

test('a box filled to its limit shows a hint; going under takes it away', () => {
  const b = box('x'.repeat(60), 60);
  onLimitInput({ target: b });
  assert.equal(b.nextElementSibling.textContent, limitText(60));
  assert.equal(b.nextElementSibling.className, 'hint limit-hint');
  const first = b.nextElementSibling;
  onLimitInput({ target: b });
  assert.equal(b.nextElementSibling, first, 'not added twice');
  b.value = 'x'.repeat(59);
  onLimitInput({ target: b });
  assert.equal(b.nextElementSibling, null);
});

test('boxes with no limit, or under it, get no hint', () => {
  const free = box('abc', -1);
  onLimitInput({ target: free });
  assert.equal(free.nextElementSibling, null);
  const under = box('abc', 60);
  onLimitInput({ target: under });
  assert.equal(under.nextElementSibling, null);
  onLimitInput({ target: null });
});

test('the app watches every text box for its limit', () => {
  const src = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(src, /watchLimits\(doc\)/);
  assert.equal(limitText(80), 'That is the most it can hold (80 letters).');
});
