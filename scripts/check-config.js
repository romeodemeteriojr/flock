#!/usr/bin/env node
// Checks the Dockerfile (read as plain text) for mistakes.
// Usage: node scripts/check-config.js [--dockerfile file]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const SECRET_NAME = /(secret|token|password|passwd|api[_-]?key|private[_-]?key|credential)/i;
const SECRET_SHAPES = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}(?=\s|$|["'])/,
];

function stripComment(line) {
  const i = line.indexOf('#');
  return (i === -1 ? line : line.slice(0, i)).trim();
}

function dockerEnv(dockerfile) {
  const env = {};
  const lines = dockerfile.replace(/\\\n/g, ' ').split('\n').map((l) => l.trim());
  for (const line of lines) {
    const m = line.match(/^ENV\s+(.*)$/i);
    if (!m) continue;
    for (const pair of m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)/g)) {
      env[pair[1]] = pair[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return env;
}

export function checkConfig({ dockerfile }) {
  const problems = [];
  const env = dockerEnv(dockerfile);
  if (!env.FLOCK_DB) problems.push('The Dockerfile does not set FLOCK_DB.');
  if (!env.FLOCK_PORT) problems.push('The Dockerfile does not set FLOCK_PORT.');

  dockerfile.split('\n').forEach((raw, i) => {
    const line = stripComment(raw);
    const named = line.match(/^(?:ENV\s+)?([A-Za-z0-9_.-]*)\s*[= ]\s*['"]?([^'"\s]+)/i);
    const looksSecret = (named && SECRET_NAME.test(named[1]) && !/^\d+$/.test(named[2]) && /^(ENV\s|[A-Za-z0-9_.-]+\s*=)/i.test(line))
      || SECRET_SHAPES.some((re) => re.test(line));
    if (looksSecret) problems.push(`Dockerfile line ${i + 1} looks like it contains a secret. Keep secrets out of the repository (set them on your host).`);
  });
  return problems;
}

function main(argv) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const i = argv.indexOf('--dockerfile');
  const path = i !== -1 && argv[i + 1] ? argv[i + 1] : `${root}/Dockerfile`;
  const problems = checkConfig({ dockerfile: readFileSync(path, 'utf8') });
  if (problems.length) {
    console.error(`The Dockerfile has ${problems.length === 1 ? 'a problem' : `${problems.length} problems`}:`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log('Dockerfile settings look good.');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
