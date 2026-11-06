#!/usr/bin/env node
// Checks package.json version, the CHANGELOG heading and (optionally) a release tag.
// Usage: node scripts/check-version.js [--tag vX.Y.Z]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function checkVersion({ pkgVersion, changelog, tag } = {}) {
  const problems = [];
  if (typeof pkgVersion !== 'string' || !SEMVER.test(pkgVersion)) {
    problems.push(`package.json version "${pkgVersion}" is not a plain version like 1.2.3.`);
  } else {
    const lines = String(changelog ?? '').split(/\r?\n/).map((l) => l.trim());
    if (!lines.includes(`## ${pkgVersion}`)) problems.push(`CHANGELOG.md has no "## ${pkgVersion}" heading.`);
  }
  if (tag !== undefined) {
    if (!TAG.test(String(tag))) problems.push(`The tag "${tag}" must look like v1.2.3.`);
    else if (typeof pkgVersion === 'string' && tag !== `v${pkgVersion}`) {
      problems.push(`The tag "${tag}" does not match package.json version ${pkgVersion} (expected v${pkgVersion}).`);
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  const i = args.indexOf('--tag');
  const tag = i === -1 ? undefined : args[i + 1] ?? '';
  const problems = checkVersion({
    pkgVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    changelog: readFileSync(join(root, 'CHANGELOG.md'), 'utf8'),
    tag,
  });
  if (problems.length) {
    for (const p of problems) console.error(`Error: ${p}`);
    process.exit(1);
  }
  console.log('Version check passed.');
}
