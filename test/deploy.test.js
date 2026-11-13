import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkConfig } from '../scripts/check-config.js';
import { loadConfig } from '../src/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f) => readFileSync(`${root}${f}`, 'utf8');
const dockerfile = read('Dockerfile');

test('check-config passes on the Dockerfile and the script runs as a command', () => {
  assert.deepEqual(checkConfig({ dockerfile }), []);
  assert.equal(spawnSync(process.execPath, [`${root}scripts/check-config.js`], { encoding: 'utf8' }).status, 0);
});

test('check-config fails on bad variants', () => {
  const bad = (d) => checkConfig({ dockerfile: d });
  assert.ok(bad(`${dockerfile}\nENV SESSION_SECRET=hunter2\n`).some((p) => /secret/.test(p)));
  assert.ok(bad('FROM node\n').some((p) => /FLOCK_DB/.test(p)));
  assert.ok(bad('FROM node\nENV FLOCK_DB=/data/x.db\n').some((p) => /FLOCK_PORT/.test(p)));
  assert.ok(bad(`${dockerfile}\nENV X=ghp_abcdefghijklmnopqrstuvwxyz0123\n`).some((p) => /secret/.test(p)));
});

test('Dockerfile is minimal and safe', () => {
  assert.match(dockerfile, /^ARG NODE_VERSION=(\d+)/m);
  assert.ok(Number(dockerfile.match(/^ARG NODE_VERSION=(\d+)/m)[1]) >= 22);
  assert.match(dockerfile, /^FROM node:\$\{NODE_VERSION\}-slim/m);
  assert.match(dockerfile, /^USER (?!root)\S+/m);
  assert.match(dockerfile, /^CMD \["node", "bin\/flock\.js", "serve"\]$/m);
  assert.match(dockerfile, /^HEALTHCHECK .*\n?.*127\.0\.0\.1:8080\/api\/health/m);
  assert.match(dockerfile, /^VOLUME \/data/m);
  assert.match(dockerfile, /^EXPOSE 8080/m);
  assert.match(dockerfile, /chown \S+ \/data/);
  assert.doesNotMatch(dockerfile, /npm (install|ci)/);
  for (const line of dockerfile.split('\n').filter((l) => /^(COPY|ADD)\b/.test(l))) {
    assert.doesNotMatch(line, /\b(test|docs|\.git|data|node_modules)\b/, line);
    assert.doesNotMatch(line, /COPY \.\s/, line);
  }
  const env = dockerfile.split('\n').filter((l) => /^ENV\b/.test(l)).join(' ');
  assert.doesNotMatch(env, /secret|token|password|key/i);
  for (const v of ['NODE_ENV=production', 'FLOCK_PORT=8080', 'FLOCK_DB=/data/flock.db', 'FLOCK_SECURE_COOKIES=1']) assert.ok(env.includes(v), v);
});

test('.dockerignore lists the required entries', () => {
  const lines = read('.dockerignore').split('\n').map((l) => l.trim());
  for (const e of ['.git', 'node_modules', 'data', '*.db', '*.db-wal', '*.db-shm', 'test', 'docs', '.github', '*.md', '!CHANGELOG.md']) {
    assert.ok(lines.includes(e), e);
  }
});

test('the repo holds no host-specific deploy files', () => {
  assert.equal(existsSync(`${root}fly.toml`), false);
});

test('the server config still binds as before (all interfaces, port from FLOCK_PORT)', () => {
  const c = loadConfig({});
  assert.equal(c.port, 8080);
  assert.equal(c.dbPath, './data/flock.db');
  assert.equal(c.secureCookies, false);
  assert.equal(loadConfig({ FLOCK_PORT: '9000', FLOCK_DB: '/data/flock.db', FLOCK_SECURE_COOKIES: '1' }).port, 9000);
  // server.listen(port) is called without a host, so it already accepts outside connections.
  assert.match(read('src/server.js'), /server\.listen\(port, \(\)/);
});

test('DEPLOY.md lists what any host needs and has no token-like string', () => {
  const d = read('DEPLOY.md');
  for (const c of [
    'one running copy', 'persistent volume', 'HTTPS', 'FLOCK_DB', 'FLOCK_PORT', 'FLOCK_SECURE_COOKIES', 'FLOCK_TRUST_PROXY',
    'FLOCK_PUBLIC_URL', 'create-admin', 'node bin/flock.js backup', '/api/health', 'exactly one instance',
  ]) assert.ok(d.toLowerCase().includes(c.toLowerCase()), c);
  assert.doesNotMatch(d, /\bfly(ctl)?\b|fly\.dev|fly\.toml/i, 'no hosting provider is named');
  assert.doesNotMatch(d, /\bgh[pousr]_|\bsk-[A-Za-z0-9]{20,}|[A-Za-z0-9+/_-]{40,}={0,2}/);
});

const hasDocker = spawnSync('docker', ['--version']).status === 0;
test('docker build works (optional, needs docker)', { skip: !hasDocker && 'docker is not installed' }, () => {
  const r = spawnSync('docker', ['build', '-q', root], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
