// The icon button: a square, keyboard-focusable, always-labelled button that
// wraps one of the shared 24px icons.
import test from 'node:test';
import assert from 'node:assert/strict';
import { iconButton } from '../web/lib/iconbutton.js';
import { ICON_NAMES, hydrateIcons } from '../web/lib/icons.js';
import { renderGallery } from '../web/gallery.js';

const NEW_ICONS = ['key', 'shield', 'user-off', 'user-check', 'list-check', 'send', 'refresh', 'filter', 'dot'];

test('iconButton: throws when the label is missing or empty', () => {
  assert.throws(() => iconButton('trash'));
  assert.throws(() => iconButton('trash', ''));
  assert.throws(() => iconButton('trash', '   '));
  assert.throws(() => iconButton('trash', null));
});

test('iconButton: renders a real button with the label as its name and hint', () => {
  const out = String(iconButton('trash', 'Delete service'));
  assert.ok(out.includes('<button type="button" class="icon-btn"'), `not a .icon-btn button: ${out}`);
  assert.match(out, /<button\b/, 'a real <button>, not escaped text');
  assert.ok(!out.includes('&lt;button'), `the button was escaped: ${out}`);
  assert.ok(out.includes('type="button"'), out);
  assert.ok(out.includes('aria-label="Delete service"'), `missing aria-label: ${out}`);
  assert.ok(out.includes('title="Delete service"'), `missing title: ${out}`);
  // The icon is inside, and stays hidden from screen readers.
  assert.ok(out.includes('data-icon="trash"'), out);
  assert.match(out, /aria-hidden="true"/, 'the icon must stay aria-hidden');
});

test('iconButton: the label is escaped, so it cannot become markup', () => {
  const out = String(iconButton('trash', '<img src=x onerror=alert(1)>'));
  assert.ok(!out.includes('<img'), `raw tag in output: ${out}`);
  assert.ok(out.includes('&lt;img'), 'label is escaped');
});

test('iconButton: dataAction and dataId pass through as data-action / data-id', () => {
  const out = String(iconButton('trash', 'Delete service', { dataAction: 'delete-service', dataId: 7 }));
  assert.ok(out.includes('data-action="delete-service"'), out);
  assert.ok(out.includes('data-id="7"'), out);
});

test('iconButton: danger adds the danger class; disabled adds the attribute', () => {
  assert.ok(String(iconButton('trash', 'Delete service', { danger: true })).includes('icon-btn-danger'));
  assert.ok(!String(iconButton('trash', 'Delete service')).includes('icon-btn-danger'));
  assert.match(String(iconButton('trash', 'Reload', { disabled: true })), /<button[^>]*\sdisabled/);
  assert.doesNotMatch(String(iconButton('trash', 'Reload')), /disabled/);
});

test('icons: the nine new names exist in icons.js and hydrate', () => {
  for (const n of NEW_ICONS) assert.ok(ICON_NAMES.includes(n), `missing icon: ${n}`);
  const root = { querySelectorAll: () => NEW_ICONS.map((n) => ({ firstChild: null, getAttribute: (a) => a === 'data-icon' ? n : null, innerHTML: '' })) };
  assert.equal(hydrateIcons(root), NEW_ICONS.length, 'every new icon hydrates to a real svg');
});

test('gallery: shows the nine new icons with names and renders real icon buttons', () => {
  const out = String(renderGallery());
  for (const n of NEW_ICONS) assert.ok(out.includes(`data-icon="${n}"`), `gallery missing icon ${n}`);
  assert.ok(out.includes('New icons'), 'new-icons section');
  assert.ok(out.includes('Icon buttons'), 'icon-buttons section');
  const count = (out.match(/<button type="button" class="icon-btn" aria-label=/g) ?? []).length;
  assert.equal(count, 3, `the gallery should show three icon buttons, found ${count}`);
  assert.ok(out.includes('aria-label="Delete service"'), out.slice(0, 0) || 'danger button label');
  assert.ok(out.includes('icon-btn-danger'), 'danger variant in the gallery');
});
