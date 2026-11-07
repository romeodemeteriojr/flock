import test from 'node:test';
import assert from 'node:assert/strict';
import { firstName, inviteMessage } from '../web/lib/invite.js';

test('invite message: one friendly sentence with the username and seven-day limit', () => {
  const link = 'https://flock.example.org/#/welcome?token=example';
  assert.equal(inviteMessage({ name: 'Pat Smith', username: 'pat.smith', link }),
    `Hi Pat, you've been added to Flock. Tap this link to choose your password: ${link} Your username is pat.smith. The link works for 7 days.`);
});

test('invite message: first names tolerate surrounding space and single names', () => {
  assert.equal(firstName('  Pat  '), 'Pat');
  assert.equal(firstName('Pat'), 'Pat');
  assert.equal(firstName('Élodie Example'), 'Élodie');
});
