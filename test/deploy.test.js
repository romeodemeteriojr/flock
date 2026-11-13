import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkConfig } from '../scripts/check-config.js';
import { loadConfig } from '../src/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f) => readFileSync(`${root}${f}`, 'utf8');
const fly = read('fly.toml');
const dockerfile = read('Dockerfile');
const ok = (over = {}) => checkConfig({ fly, dockerfile, ...over });
const bad = (over) => checkConfig({ fly, dockerfile, ...over });

test('check-config passes on the repo files (also for production), and a placeholder only fails in production', () => {
  // The repo's fly.toml is a template; the real one lives with whoever deploys.
  const filled = fly.replace(/^app = '.*'$/m, "app = 'flock-example'").replace(/^primary_region = '.*'$/m, "primary_region = 'abc'");
  assert.deepEqual(ok(), []);
  assert.deepEqual(ok({ fly: filled, production: true }), []);
  const problems = ok({ production: true });
  assert.ok(problems.some((p) => /app name is still the placeholder/.test(p)));
  assert.ok(problems.some((p) => /primary_region is still the placeholder/.test(p)));
});

test('check-config script runs as a command', () => {
  const run = (...a) => spawnSync(process.execPath, [`${root}scripts/check-config.js`, ...a], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  assert.equal(run('--production').status, 1, 'the template still has placeholders');
});

test('check-config fails on bad variants', () => {
  assert.ok(bad({ fly: fly.replace("destination = '/data'", "destination = '/other'") }).some((p) => /mount/.test(p)));
  assert.ok(bad({ fly: fly.replace('internal_port = 8080', 'internal_port = 3000') }).some((p) => /internal_port/.test(p)));
  assert.ok(bad({ fly: `${fly}\n[[vm]]\n  memory = '256mb'\n` }).some((p) => /one machine/i.test(p)));
  assert.ok(bad({ fly: fly.replace('min_machines_running = 0', 'min_machines_running = 2') }).some((p) => /one machine/i.test(p)));
  assert.ok(bad({ fly: fly.replace('force_https = true', '') }).some((p) => /force_https/.test(p)));
  assert.ok(bad({ fly: fly.replace("NODE_ENV = 'production'", "API_TOKEN = 'abc123'") }).some((p) => /secret/.test(p)));
  assert.ok(bad({ dockerfile: `${dockerfile}\nENV SESSION_SECRET=hunter2\n` }).some((p) => /secret/.test(p)));
  assert.ok(bad({ fly: `${fly}\n# x\nfoo = 'FlyV1 fm2_abcdefghijklmnop'\n` }).some((p) => /secret/.test(p)));
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

test('fly.toml has the required sections', () => {
  assert.match(fly, /^app = 'flock-CHANGE-ME'$/m);
  assert.match(fly, /^primary_region = 'CHANGE-ME'$/m);
  assert.doesNotMatch(fly, /^\s*FLOCK_PUBLIC_URL/m, 'the live address belongs to the deployer, not the repo');
  assert.match(fly, /GLOBALLY UNIQUE/);
  assert.match(fly, /^primary_region = /m);
  assert.match(fly, /\[build\]\s+dockerfile = 'Dockerfile'/);
  assert.match(fly, /source = 'flock_data'/);
  assert.match(fly, /auto_stop_machines = 'suspend'/);
  assert.match(fly, /min_machines_running = 0/);
  assert.match(fly, /path = '\/api\/health'/);
  assert.match(fly, /shared-cpu-1x/);
  assert.match(fly, /memory = '256mb'/);
  assert.match(fly, /exactly ONE machine/i);
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

test('DEPLOY.md mentions every command and has no token-like string', () => {
  const d = read('DEPLOY.md');
  for (const c of [
    'fly auth login', 'fly launch --no-deploy --copy-config', 'fly volumes create flock_data --size 1 --region <region>',
    'fly deploy', `fly ssh console -C "node bin/flock.js create-admin <email> 'Full Name'"`,
    'https://<app>.fly.dev', 'fly certs add', 'fly logs', 'fly releases',
    `fly ssh console -C 'node bin/flock.js backup /data/backup-YYYYMMDD.db'`, 'fly ssh sftp get /data/backup-YYYYMMDD.db',
    '$2.34', 'own computer', 'one machine', 'RESTORE'.toLowerCase(),
  ]) assert.ok(d.toLowerCase().includes(c.toLowerCase()), c);
  assert.doesNotMatch(d, /FlyV1|\bfo1_|\bgh[pousr]_|\bsk-[A-Za-z0-9]{20,}|[A-Za-z0-9+/_-]{40,}={0,2}/);
});

const hasDocker = spawnSync('docker', ['--version']).status === 0;
test('docker build works (optional, needs docker)', { skip: !hasDocker && 'docker is not installed' }, () => {
  const r = spawnSync('docker', ['build', '-q', root], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
