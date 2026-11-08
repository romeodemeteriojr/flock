import test from 'node:test';
import assert from 'node:assert/strict';
import { firstName, inviteMessage } from '../web/lib/invite.js';

test('invite message: one friendly sentence with the login email and seven-day limit', () => {
  const link = 'https://flock.example.org/#/welcome?token=example';
  assert.equal(inviteMessage({ name: 'Pat Smith', email: 'pat.smith@example.com', link }),
    `Hi Pat, you've been added to Flock. Tap this link to choose your password: ${link} You will log in with pat.smith@example.com. The link works for 7 days.`);
});

test('invite message: first names tolerate surrounding space and single names', () => {
  assert.equal(firstName('  Pat  '), 'Pat');
  assert.equal(firstName('Pat'), 'Pat');
  assert.equal(firstName('Élodie Example'), 'Élodie');
});
