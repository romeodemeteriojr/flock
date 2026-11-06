import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { checkVersion } from '../scripts/check-version.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const FILES = ['.github/workflows/ci.yml', '.github/workflows/deploy.yml'];
const ci = () => read(FILES[0]);
const deploy = () => read(FILES[1]);
const code = (t) => t.split('\n').map((l) => l.replace(/^(\s*)#.*$/, '$1'));

// Returns {line, text} for each line inside a `run:` block (inline or multi-line).
function runLines(text) {
  const lines = code(text);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length + (lines[i].includes('- run:') ? 2 : 0);
    if (m[2] && !/^[|>][+-]?$/.test(m[2])) { out.push({ line: i + 1, text: m[2] }); continue; }
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && lines[j].match(/^\s*/)[0].length <= indent) break;
      out.push({ line: j + 1, text: lines[j] });
    }
  }
  return out;
}

test('workflow files exist', () => {
  for (const f of [...FILES, '.github/dependabot.yml']) assert.ok(existsSync(join(root, f)), f);
});

test('ci.yml triggers, permissions, matrix and test command', () => {
  const t = ci();
  assert.match(t, /^on:\s*$/m);
  assert.match(t, /^ {2}push:/m);
  assert.match(t, /^ {2}pull_request:/m);
  assert.match(t, /^permissions:\s*\n {2}contents: read\s*$/m);
  assert.match(t, /^concurrency:[\s\S]*cancel-in-progress: true/m);
  assert.match(t, /matrix:[\s\S]*node-version:.*22[\s\S]*24/);
  assert.match(t, /run: node --test$/m);
  assert.match(t, /--experimental-test-coverage/);
  assert.match(t, /GITHUB_STEP_SUMMARY/);
  assert.match(t, /node scripts\/check-config\.js/);
  assert.match(t, /node scripts\/check-version\.js/);
  assert.match(t, /node --version/);
  assert.match(t, /actions\/checkout@v\d+/);
  assert.match(t, /actions\/setup-node@v\d+/);
  assert.match(t, /Dependabot/);
});

test('deploy.yml is manual only with a required tag input', () => {
  const t = deploy();
  assert.match(t, /^ {2}workflow_dispatch:/m);
  assert.match(t, /inputs:\s*\n {6}tag:[\s\S]*?required: true/);
  const onBlock = t.match(/^on:\n((?: {2}.*\n|\n)+)/m)[1];
  assert.deepEqual(onBlock.match(/^ {2}(\w+):/gm).map((s) => s.trim()), ['workflow_dispatch:']);
  assert.match(t, /^permissions:\s*\n {2}contents: read\s*$/m);
  assert.match(t, /^concurrency:\s*\n {2}group: deploy\s*\n {2}cancel-in-progress: false/m);
  assert.match(t, /\^v\[0-9\]\+/);
  assert.match(t, /check-version\.js --tag "\$TAG"/);
  assert.match(t, /node --test$/m);
  assert.match(t, /check-config\.js --production/);
  assert.match(t, /superfly\/flyctl-actions\/setup-flyctl/);
  assert.match(t, /flyctl volumes snapshots create/);
  assert.match(t, /flyctl volumes list.*--json/);
  assert.match(t, /flyctl deploy --remote-only/);
  assert.match(t, /\/api\/health/);
  assert.match(t, /ROLLBACK/);
  assert.match(t, /flyctl releases/);
  assert.match(t, /flyctl deploy .*--image <previous image>/);
  assert.ok(t.indexOf('snapshots create') < t.indexOf('deploy --remote-only'));
});

test('no dangerous triggers anywhere', () => {
  for (const f of FILES) {
    const t = code(read(f)).join('\n');
    assert.doesNotMatch(t, /pull_request_target/, f);
  }
  assert.doesNotMatch(code(deploy()).join('\n'), /^ {2}(push|pull_request|pull_request_target):/m);
});

test('no ${{ }} expression inside run blocks', () => {
  for (const f of FILES) {
    const runs = runLines(read(f));
    assert.ok(runs.length > 3, f);
    for (const r of runs) assert.doesNotMatch(r.text, /\$\{\{/, `${f}:${r.line}`);
  }
});

test('secrets: only FLY_API_TOKEN, only in env of deploy steps', () => {
  for (const f of FILES) {
    const lines = code(read(f));
    lines.forEach((l, i) => {
      if (/secrets\./.test(l)) {
        assert.match(l, /^\s+FLY_API_TOKEN: \$\{\{ secrets\.FLY_API_TOKEN \}\}\s*$/, `${f}:${i + 1}`);
        assert.match(lines[i - 1], /^\s+env:\s*$/, `${f}:${i + 1} must be directly in env`);
      }
      assert.doesNotMatch(l, /secrets\[|toJSON\(secrets|secrets\s*\}\}/, `${f}:${i + 1}`);
    });
  }
  assert.doesNotMatch(ci(), /secrets\./);
  assert.equal((deploy().match(/secrets\.FLY_API_TOKEN/g) || []).length, 2);
  for (const r of runLines(deploy())) assert.doesNotMatch(r.text, /echo.*FLY_API_TOKEN/);
});

test('workflow hygiene: no tabs, timeouts set', () => {
  for (const f of [...FILES, '.github/dependabot.yml']) assert.doesNotMatch(read(f), /\t/, f);
  for (const f of FILES) assert.match(read(f), /^ {4}timeout-minutes: \d+/m, f);
  assert.match(ci(), /timeout-minutes: 10\b/);
});

test('dependabot targets github-actions only', () => {
  const t = read('.github/dependabot.yml');
  assert.match(t, /package-ecosystem: github-actions/);
  assert.match(t, /interval: weekly/);
  assert.doesNotMatch(t, /package-ecosystem: (?!github-actions)/);
});

test('checkVersion: valid, bad semver, changelog, tag', () => {
  const changelog = '# Changelog\n\n## 1.2.3\n\nstuff\n';
  assert.deepEqual(checkVersion({ pkgVersion: '1.2.3', changelog }), []);
  assert.deepEqual(checkVersion({ pkgVersion: '1.2.3', changelog, tag: 'v1.2.3' }), []);
  assert.equal(checkVersion({ pkgVersion: '1.2', changelog }).length, 1);
  assert.equal(checkVersion({ pkgVersion: 'abc', changelog: '## abc' }).length, 1);
  assert.match(checkVersion({ pkgVersion: '1.2.4', changelog })[0], /CHANGELOG\.md has no "## 1\.2\.4"/);
  assert.match(checkVersion({ pkgVersion: '1.2.3', changelog, tag: 'v1.2.4' })[0], /does not match/);
  assert.match(checkVersion({ pkgVersion: '1.2.3', changelog, tag: '1.2.3' })[0], /must look like/);
  assert.match(checkVersion({ pkgVersion: '1.2.3', changelog, tag: 'v1.2.3-rc1' })[0], /must look like/);
});

test('check-version runs on the real repo', () => {
  assert.deepEqual(checkVersion({
    pkgVersion: JSON.parse(read('package.json')).version, changelog: read('CHANGELOG.md'),
  }), []);
});

test('DEPLOY.md has the new section and no token-like string', () => {
  const t = read('DEPLOY.md');
  assert.match(t, /^## Automatic checks and releases$/m);
  const section = t.slice(t.indexOf('## Automatic checks and releases'));
  for (const w of ['PRIVATE', 'FLY_API_TOKEN', 'flyctl tokens create deploy', 'Run workflow', 'ROLLBACK', 'no approval gate']) {
    assert.ok(section.includes(w), w);
  }
  assert.doesNotMatch(t, /\bFlyV1\s+\S+|\bfo1_[A-Za-z0-9_-]{10,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\b[A-Za-z0-9+/_-]{40,}={0,2}(?=\s|$)/);
});
