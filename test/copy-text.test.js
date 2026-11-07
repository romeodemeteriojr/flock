import test from 'node:test';
import assert from 'node:assert/strict';
import { copyText } from '../web/lib/slotpanel.js';

function legacyClipboard(command = () => true) {
  const events = [];
  const field = {
    value: '',
    setAttribute(name, value) { this[name] = value; },
    focus() { events.push('focus'); },
    select() { events.push('select'); },
    setSelectionRange(start, end) { assert.deepEqual([start, end], [0, this.value.length]); events.push('range'); },
    remove() { events.push('remove'); },
  };
  const copied = [];
  const win = { document: {
    activeElement: { focus() { events.push('restore focus'); } },
    createElement(tag) { assert.equal(tag, 'textarea'); return field; },
    body: { appendChild(el) { assert.equal(el, field); events.push('append'); } },
    execCommand(name) {
      assert.equal(name, 'copy');
      assert.deepEqual(events, ['append', 'focus', 'select', 'range']);
      copied.push(field.value);
      return command();
    },
  } };
  return { win, field, events, copied };
}

test('copyText prefers the Clipboard API without touching the DOM', async () => {
  const copied = [];
  const win = { navigator: { clipboard: { writeText: async (text) => copied.push(text) } } };
  assert.equal(await copyText(win, 'Hello'), true);
  assert.deepEqual(copied, ['Hello']);
});

test('copyText copies synchronously on HTTP without the Clipboard API', async () => {
  const { win, field, events, copied } = legacyClipboard();
  const text = 'Hi Zoë 👋\nSunday at 09:00\n\nPlease confirm.';
  const pending = copyText(win, text);
  assert.deepEqual(copied, [text], 'copy stays in the click gesture, before any await');
  assert.equal(await pending, true);
  assert.equal(field.className, 'visually-hidden');
  assert.equal(field.readonly, '');
  assert.deepEqual(events.slice(-2), ['remove', 'restore focus']);
});

test('copyText falls back when the Clipboard API rejects', async () => {
  const { win, copied, events } = legacyClipboard();
  win.navigator = { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } };
  assert.equal(await copyText(win, 'Reminder'), true);
  assert.deepEqual(copied, ['Reminder']);
  assert.deepEqual(events.slice(-2), ['remove', 'restore focus']);
});

for (const [name, command] of [
  ['returns false', () => false],
  ['throws', () => { throw new Error('Copy blocked'); }],
]) {
  test(`copyText reports failure and cleans up when legacy copy ${name}`, async () => {
    const { win, events } = legacyClipboard(command);
    assert.equal(await copyText(win, 'Reminder'), false);
    assert.deepEqual(events.slice(-2), ['remove', 'restore focus']);
  });
}

test('copyText reports failure when neither clipboard mechanism is available', async () => {
  assert.equal(await copyText({}, 'Reminder'), false);
  assert.equal(await copyText(undefined, 'Reminder'), false);
});
