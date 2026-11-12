// Turning push on (decision 0008): settings, the container and `flock push-keys`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig, ConfigError, pushEnabled } from '../src/config.js';
import { createContainer } from '../src/container.js';
import { generateVapidKeys, vapidKeysProblem } from '../src/infra/webpush.js';
import { silentLogger } from '../src/infra/logger.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'flock.js');
const keys = generateVapidKeys();
const env = (extra = {}) => ({
  FLOCK_DB: ':memory:', FLOCK_PUBLIC_URL: 'https://flock.example.org',
  FLOCK_VAPID_PUBLIC_KEY: ` ${keys.publicKey} `, FLOCK_VAPID_PRIVATE_KEY: keys.privateKey, ...extra,
});
const problems = (e) => {
  try { loadConfig(e); } catch (err) { assert.ok(err instanceof ConfigError); return err.problems.join('\n'); }
  return '';
};

test('push settings: off by default, on with both keys and an https address', () => {
  assert.equal(pushEnabled(loadConfig({})), false);
  const c = loadConfig(env());
  assert.deepEqual(c.push, keys);
  assert.equal(pushEnabled(c), true);
});

test('push settings: one key alone, wrong keys, or no https address stop Flock starting', () => {
  assert.match(problems(env({ FLOCK_VAPID_PRIVATE_KEY: '' })), /both FLOCK_VAPID_PUBLIC_KEY and FLOCK_VAPID_PRIVATE_KEY/);
  assert.match(problems(env({ FLOCK_VAPID_PUBLIC_KEY: '' })), /both/);
  assert.match(problems(env({ FLOCK_VAPID_PRIVATE_KEY: generateVapidKeys().privateKey })), /do not belong together/);
  assert.match(problems(env({ FLOCK_VAPID_PUBLIC_KEY: 'nope' })), /public key is not valid/);
  assert.match(problems(env({ FLOCK_PUBLIC_URL: 'http://flock.example.org' })), /FLOCK_PUBLIC_URL to be the https/);
  assert.match(problems(env({ FLOCK_PUBLIC_URL: '' })), /FLOCK_PUBLIC_URL to be the https/);
  assert.throws(() => validateConfig({ ...loadConfig({}), push: { publicKey: keys.publicKey } }), ConfigError);
  // The message names the setting, never the secret itself.
  const text = problems(env({ FLOCK_VAPID_PRIVATE_KEY: generateVapidKeys().privateKey }));
  assert.ok(!text.includes(keys.privateKey));
});

test('container: push is off without keys, a real sender with them, and replaceable in tests', async () => {
  const off = createContainer({ env: { FLOCK_DB: ':memory:' }, logger: silentLogger() });
  try {
    assert.equal(off.push.enabled, false);
    assert.equal(off.push.publicKey, null);
  } finally { off.close(); }
  const on = createContainer({ env: env(), logger: silentLogger() });
  try {
    assert.equal(on.push.enabled, true);
    assert.equal(on.push.publicKey, keys.publicKey);
  } finally { on.close(); }
  const fake = { enabled: true, publicKey: 'k', send: async () => ({ ok: true }) };
  const c = createContainer({ env: { FLOCK_DB: ':memory:' }, logger: silentLogger(), push: fake });
  try { assert.equal(c.push, fake); } finally { c.close(); }
  assert.throws(() => createContainer({ env: { FLOCK_DB: ':memory:' }, push: {} }), /push is missing its send/);
});

test('flock push-keys prints a fresh matching pair and how to keep it', () => {
  const run = () => spawnSync(process.execPath, [BIN, 'push-keys'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const pub = r.stdout.match(/^FLOCK_VAPID_PUBLIC_KEY=(\S+)$/m)[1];
  const priv = r.stdout.match(/^FLOCK_VAPID_PRIVATE_KEY=(\S+)$/m)[1];
  assert.equal(vapidKeysProblem(pub, priv), null);
  assert.match(r.stdout, /password manager/);
  assert.match(r.stdout, /fly secrets set/);
  assert.equal(r.stdout.split(priv).length - 1, 1, 'the private key is printed once');
  assert.notEqual(run().stdout.match(/^FLOCK_VAPID_PRIVATE_KEY=(\S+)$/m)[1], priv, 'new keys every time');
  const extra = spawnSync(process.execPath, [BIN, 'push-keys', 'x'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(extra.status, 1);
  const help = spawnSync(process.execPath, [BIN, 'help'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.match(help.stdout, /push-keys/);
});
