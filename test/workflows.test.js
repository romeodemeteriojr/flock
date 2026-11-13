import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { checkVersion } from '../scripts/check-version.js';
import { bumpFor, nextVersion, latestTagVersion, releaseChangelog, changelogSection, plan, titleProblem } from '../scripts/release.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const FILES = ['.github/workflows/ci.yml', '.github/workflows/release.yml', '.github/workflows/release-label.yml'];
const ci = () => read(FILES[0]);
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

test('there is no deploy workflow or Fly token here (deploying happens from a private repo)', () => {
  assert.equal(existsSync(join(root, '.github/workflows/deploy.yml')), false);
  for (const f of FILES) assert.doesNotMatch(read(f), /flyctl|FLY_API_TOKEN|workflow_dispatch/, f);
});

test('no dangerous triggers anywhere', () => {
  for (const f of FILES) {
    const t = code(read(f)).join('\n');
    assert.doesNotMatch(t, /pull_request_target/, f);
  }
});

test('no ${{ }} expression inside run blocks', () => {
  for (const f of FILES) {
    const runs = runLines(read(f));
    assert.ok(runs.length > 0, f);
    for (const r of runs) assert.doesNotMatch(r.text, /\$\{\{/, `${f}:${r.line}`);
  }
});

test('no workflow uses repository secrets', () => {
  for (const f of FILES) {
    code(read(f)).forEach((l, i) => {
      assert.doesNotMatch(l, /secrets\.|secrets\[|toJSON\(secrets/, `${f}:${i + 1}`);
    });
  }
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

test('DEPLOY.md has the releases section and no token-like string', () => {
  const t = read('DEPLOY.md');
  assert.match(t, /^## Automatic checks and releases$/m);
  const section = t.slice(t.indexOf('## Automatic checks and releases'));
  for (const w of ['release label', 'release workflow']) assert.ok(section.toLowerCase().includes(w), w);
  assert.doesNotMatch(t, /\bgh[pousr]_[A-Za-z0-9]{20,}|\b[A-Za-z0-9+/_-]{40,}={0,2}(?=\s|$)/);
});

// ---------- semantic versioning from pull request labels ----------

test('release labels: exactly one of breaking, feat, fix or "no release"', () => {
  assert.deepEqual(bumpFor(['feat', 'documentation']), { bump: 'minor' });
  assert.deepEqual(bumpFor(['Fix']), { bump: 'patch' });
  assert.deepEqual(bumpFor(['breaking']), { bump: 'major' });
  assert.deepEqual(bumpFor(['no release', 'dependencies']), { bump: null });
  assert.match(bumpFor([]).problem, /Add one release label/);
  assert.match(bumpFor(['enhancement']).problem, /Add one release label/);
  assert.match(bumpFor(['feat', 'fix']).problem, /only one release label/);
});

test('PR titles: Conventional Commits, with the type matching the release label', () => {
  const ok = [
    ['feat: retire positions', ['feat']],
    ['feat(teams): retire positions', ['feat', 'documentation']],
    ['fix: keep past rosters', ['fix']],
    ['feat!: drop the old API', ['breaking']],
    ['docs: explain TZ', ['no release']],
    ['ci: check PR titles', ['no release']],
    ['chore: release v0.10.0', ['no release']],
  ];
  for (const [title, labels] of ok) assert.equal(titleProblem(title, labels), null, title);
  const bad = [
    ['Retire positions', ['feat'], /Start the title with a type/],
    ['feat:no space', ['feat'], /Start the title/],
    ['Feat: capital', ['feat'], /Start the title/],
    ['feature: unknown type', ['feat'], /Start the title/],
    ['feat: ', ['feat'], /Start the title/],
    ['', ['feat'], /Start the title/],
    ['fix: wrong label', ['feat'], /"feat" label needs a "feat: …"/],
    ['feat: wrong label', ['fix'], /"fix" label needs a "fix: …"/],
    ['feat: not marked', ['breaking'], /needs a "!"/],
    ['feat!: no breaking label', ['feat'], /use the "breaking" label/],
    ['feat: new thing', ['no release'], /needs the "feat" label/],
    ['fix: a bug', ['no release'], /needs the "fix" label/],
  ];
  for (const [title, labels, re] of bad) assert.match(titleProblem(title, labels) ?? 'null', re, title);
  // With no or two release labels, only the label check complains.
  assert.equal(titleProblem('docs: x', []), null);
  assert.equal(titleProblem('docs: x', ['feat', 'fix']), null);
});

test('nextVersion: semver, with breaking changes bumping the minor before 1.0.0', () => {
  assert.equal(nextVersion('0.4.0', 'minor'), '0.5.0');
  assert.equal(nextVersion('0.5.0', 'patch'), '0.5.1');
  assert.equal(nextVersion('0.5.3', 'major'), '0.6.0');
  assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0');
  assert.throws(() => nextVersion('1.2', 'patch'), /not a version/);
  assert.throws(() => nextVersion('1.2.3', 'huge'), /Unknown bump/);
  assert.equal(latestTagVersion(['v0.3.0', 'v0.10.0', 'v0.4.0', 'junk', 'v1.0.0-rc1', '']), '0.10.0');
  assert.equal(latestTagVersion([]), '0.0.0');
});

test('releaseChangelog renames Unreleased; changelogSection gives the release notes', () => {
  const log = '# Changelog\n\n## Unreleased\n\n- New thing\n\n## 0.4.0\n\n- Old thing\n';
  const done = releaseChangelog(log, '0.5.0');
  assert.equal(done, '# Changelog\n\n## 0.5.0\n\n- New thing\n\n## 0.4.0\n\n- Old thing\n');
  assert.equal(releaseChangelog(done, '0.5.0'), done, 'already named: unchanged');
  assert.throws(() => releaseChangelog('# Changelog\n\n## 0.4.0\n', '0.5.0'), /needs a "## Unreleased" section/);
  assert.throws(() => releaseChangelog('## Unreleased\n\n## 0.5.0\n', '0.5.0'), /both/);
  assert.equal(changelogSection(done, '0.5.0'), '- New thing');
  assert.equal(changelogSection(done, '0.4.0'), '- Old thing');
  assert.equal(changelogSection(done, '9.9.9'), '');
});

test('plan: what a pull request releases, and what stops it', () => {
  const changelog = '## Unreleased\n\n- x\n\n## 0.4.0\n';
  assert.deepEqual(plan({ labels: ['feat'], released: '0.4.0', pkgVersion: '0.4.0', changelog }), { bump: 'minor', version: '0.5.0', problems: [] });
  assert.deepEqual(plan({ labels: ['no release'], released: '0.4.0', pkgVersion: '0.4.0', changelog: '' }), { bump: null, version: null, problems: [] });
  // Bumped by hand to the right number (like 0.5.0) is fine; a wrong number is not.
  assert.deepEqual(plan({ labels: ['feat'], released: '0.4.0', pkgVersion: '0.5.0', changelog: '## 0.5.0\n' }).problems, []);
  assert.match(plan({ labels: ['fix'], released: '0.4.0', pkgVersion: '0.5.0', changelog }).problems[0], /package.json says 0.5.0, but this would release 0.4.1/);
  assert.match(plan({ labels: ['fix'], released: '0.4.0', pkgVersion: '0.4.0', changelog: '## 0.4.0\n' }).problems[0], /Unreleased/);
  assert.match(plan({ labels: [], released: '0.4.0', pkgVersion: '0.4.0', changelog }).problems[0], /Add one release label/);
});

test('release.yml: only after a merge into main, writes contents, plans from the labels, tags and releases', () => {
  const t = read('.github/workflows/release.yml');
  const onBlock = t.match(/^on:\n((?: {2}.*\n|\n)+)/m)[1];
  assert.deepEqual(onBlock.match(/^ {2}(\w+):/gm).map((s) => s.trim()), ['pull_request:']);
  assert.match(onBlock, /types: \[closed\]/);
  assert.match(onBlock, /branches: \[main\]/);
  assert.match(t, /^permissions:\s*\n {2}contents: write\s*$/m);
  assert.match(t, /if: github\.event\.pull_request\.merged == true/);
  assert.match(t, /^concurrency:\s*\n {2}group: release\s*\n {2}cancel-in-progress: false/m);
  assert.match(t, /LABELS: \$\{\{ join\(github\.event\.pull_request\.labels\.\*\.name, ','\) \}\}/);
  assert.match(t, /release\.js plan --labels "\$LABELS"/);
  assert.match(t, /release\.js apply "\$VERSION"/);
  assert.match(t, /check-version\.js --tag "v\$VERSION"/);
  assert.match(t, /git push origin "v\$VERSION"/);
  assert.match(t, /gh release create "v\$VERSION"/);
  assert.doesNotMatch(t, /flyctl|FLY_API_TOKEN|workflow_dispatch/, 'releasing never deploys');
});

test('release-label.yml: runs on label changes, read-only', () => {
  const t = read('.github/workflows/release-label.yml');
  assert.match(t, /types: \[opened, reopened, synchronize, labeled, unlabeled, edited\]/);
  assert.match(t, /TITLE: \$\{\{ github\.event\.pull_request\.title \}\}/);
  assert.match(t, /--title "\$TITLE"/);
  assert.match(t, /^permissions:\s*\n {2}contents: read\s*$/m);
  assert.match(t, /fetch-depth: 0/);
  assert.match(t, /release\.js check --labels "\$LABELS"/);
  assert.match(read('.github/dependabot.yml'), /- no release/);
});
