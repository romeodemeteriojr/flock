#!/usr/bin/env node
// Semantic versioning from pull request labels (see DEPLOY.md, "How to release").
//
// Every pull request carries exactly one release label:
//   breaking  incompatible change (major; while Flock is 0.x it bumps the minor)
//   feat      something new        (minor)
//   fix       a bug fix            (patch)
//   no release                     (docs, CI, tidying: no new version)
//
// Changelog entries go under "## Unreleased" in CHANGELOG.md; releasing renames
// that heading to the new version.
//
// Usage:
//   node scripts/release.js check --labels "feat,documentation"   (pull request check)
//   node scripts/release.js plan --labels "feat"                   (prints bump=… and version=…)
//   node scripts/release.js apply 0.6.0                            (package.json + CHANGELOG)
//   node scripts/release.js notes 0.6.0                            (that version's CHANGELOG section)
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const RELEASE_LABELS = Object.freeze({ breaking: 'major', feat: 'minor', fix: 'patch', 'no release': null });
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const UNRELEASED = '## Unreleased';

/** The bump the labels ask for: {bump: 'major'|'minor'|'patch'|null} or {problem}. */
export function bumpFor(labels) {
  const found = [...new Set(labels.map((l) => String(l).trim().toLowerCase()))].filter((l) => Object.hasOwn(RELEASE_LABELS, l));
  const names = Object.keys(RELEASE_LABELS).map((l) => `"${l}"`).join(', ');
  if (found.length === 0) return { problem: `Add one release label: ${names}.` };
  if (found.length > 1) return { problem: `Use only one release label, not ${found.map((l) => `"${l}"`).join(' and ')}.` };
  return { bump: RELEASE_LABELS[found[0]] };
}

/** 0.4.0 + minor = 0.5.0. Before 1.0.0 a breaking change bumps the minor (semver item 4). */
export function nextVersion(current, bump) {
  const m = SEMVER.exec(current);
  if (!m) throw new Error(`"${current}" is not a version like 1.2.3`);
  let [major, minor, patch] = m.slice(1).map(Number);
  const kind = bump === 'major' && major === 0 ? 'minor' : bump;
  if (kind === 'major') { major++; minor = 0; patch = 0; } else if (kind === 'minor') { minor++; patch = 0; } else if (kind === 'patch') { patch++; } else throw new Error(`Unknown bump "${bump}"`);
  return `${major}.${minor}.${patch}`;
}

/** The newest vX.Y.Z tag's version, or 0.0.0 when there is none. */
export function latestTagVersion(tags) {
  const versions = tags.map((t) => String(t).trim()).filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).map((t) => t.slice(1));
  const key = (v) => v.split('.').map(Number);
  versions.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  return versions.at(-1) ?? '0.0.0';
}

const lines = (text) => String(text).split(/\r?\n/);
const hasHeading = (changelog, heading) => lines(changelog).some((l) => l.trim() === heading);

/** CHANGELOG with "## Unreleased" renamed to "## <version>" (unchanged if that heading already exists). */
export function releaseChangelog(changelog, version) {
  if (hasHeading(changelog, `## ${version}`)) {
    if (hasHeading(changelog, UNRELEASED)) throw new Error(`CHANGELOG.md has both "${UNRELEASED}" and "## ${version}". Merge them into one.`);
    return changelog;
  }
  if (!hasHeading(changelog, UNRELEASED)) throw new Error(`CHANGELOG.md needs a "${UNRELEASED}" section saying what changed.`);
  return lines(changelog).map((l) => (l.trim() === UNRELEASED ? `## ${version}` : l)).join('\n');
}

/** The text under "## <version>", up to the next "## " heading. */
export function changelogSection(changelog, version) {
  const all = lines(changelog);
  const start = all.findIndex((l) => l.trim() === `## ${version}`);
  if (start === -1) return '';
  const end = all.findIndex((l, i) => i > start && /^## /.test(l));
  return all.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
}

/**
 * What a pull request with these labels would release, and what is wrong with it.
 * @returns {{bump: string|null, version: string|null, problems: string[]}}
 */
export function plan({ labels, released, pkgVersion, changelog }) {
  const { bump, problem } = bumpFor(labels);
  if (problem) return { bump: null, version: null, problems: [problem] };
  if (!bump) return { bump: null, version: null, problems: [] };
  const version = nextVersion(released, bump);
  const problems = [];
  if (pkgVersion !== released && pkgVersion !== version) {
    problems.push(`package.json says ${pkgVersion}, but this would release ${version} (last release ${released}). Leave package.json at ${released}; the release sets it.`);
  }
  try { releaseChangelog(changelog, version); } catch (e) { problems.push(e.message); }
  return { bump, version, problems };
}

// ---------- command line ----------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readPkg = () => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const readChangelog = () => readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
const gitTags = () => execFileSync('git', ['tag', '--list', 'v*'], { cwd: ROOT, encoding: 'utf8' }).split('\n');

function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = (name) => { const i = rest.indexOf(`--${name}`); return i === -1 ? undefined : rest[i + 1] ?? ''; };
  const labels = (opt('labels') ?? '').split(',').filter((l) => l.trim());
  if (cmd === 'check' || cmd === 'plan') {
    const p = plan({ labels, released: latestTagVersion(gitTags()), pkgVersion: readPkg().version, changelog: readChangelog() });
    if (p.problems.length) {
      for (const problem of p.problems) console.error(`Error: ${problem}`);
      return 1;
    }
    if (cmd === 'plan') console.log(`bump=${p.bump ?? ''}\nversion=${p.version ?? ''}`);
    else console.log(p.version ? `Merging this releases ${p.version} (${p.bump}).` : 'Merging this makes no release.');
    return 0;
  }
  if (cmd === 'apply') {
    const version = rest[0];
    if (!SEMVER.test(version ?? '')) { console.error('Usage: release.js apply X.Y.Z'); return 1; }
    const pkgFile = join(ROOT, 'package.json');
    const raw = readFileSync(pkgFile, 'utf8');
    writeFileSync(pkgFile, raw.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`));
    writeFileSync(join(ROOT, 'CHANGELOG.md'), releaseChangelog(readChangelog(), version));
    return 0;
  }
  if (cmd === 'notes') {
    const text = changelogSection(readChangelog(), rest[0]);
    if (!text) { console.error(`CHANGELOG.md has no "## ${rest[0]}" section.`); return 1; }
    console.log(text);
    return 0;
  }
  console.error('Usage: release.js check|plan --labels "a,b" | apply X.Y.Z | notes X.Y.Z');
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`Error: ${e.message}`); process.exitCode = 1; }
}
