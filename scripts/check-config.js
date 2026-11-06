#!/usr/bin/env node
// Checks fly.toml and the Dockerfile (read as plain text) for mistakes.
// Usage: node scripts/check-config.js [--production] [--fly file] [--dockerfile file]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, posix } from 'node:path';

const PLACEHOLDER = /CHANGE-ME/i;
const SECRET_NAME = /(secret|token|password|passwd|api[_-]?key|private[_-]?key|credential)/i;
const SECRET_SHAPES = [
  /\bFlyV1\s+\S+/,
  /\bfo1_[A-Za-z0-9_-]{10,}/,
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

function tomlValue(text, key) {
  const m = text.split('\n').map(stripComment).map((l) => l.match(new RegExp(`^${key}\\s*=\\s*(.+)$`))).find(Boolean);
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : undefined;
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

export function checkConfig({ fly, dockerfile, production = false }) {
  const problems = [];
  const env = dockerEnv(dockerfile);
  const flyLines = fly.split('\n').map(stripComment);

  const app = tomlValue(fly, 'app');
  if (!app) problems.push('fly.toml has no app name.');
  else if (production && PLACEHOLDER.test(app)) problems.push(`The app name is still the placeholder "${app}". Choose a globally unique name in fly.toml.`);
  if (production && PLACEHOLDER.test(tomlValue(fly, 'primary_region') ?? '')) {
    problems.push('primary_region is still the placeholder. Choose your region in fly.toml.');
  }

  const db = env.FLOCK_DB;
  const dest = tomlValue(fly, 'destination');
  if (!db) problems.push('The Dockerfile does not set FLOCK_DB.');
  else if (!dest) problems.push('fly.toml has no [mounts] destination.');
  else if (posix.dirname(db) !== dest.replace(/\/+$/, '')) problems.push(`The volume mount (${dest}) is not the folder of FLOCK_DB (${db}), so the database would be lost on every deploy.`);

  const port = env.FLOCK_PORT;
  const internal = tomlValue(fly, 'internal_port');
  if (!port) problems.push('The Dockerfile does not set FLOCK_PORT.');
  else if (internal !== port) problems.push(`internal_port (${internal ?? 'missing'}) is not FLOCK_PORT (${port}).`);

  if (tomlValue(fly, 'force_https') !== 'true') problems.push('fly.toml must have force_https = true.');

  const vms = flyLines.filter((l) => /^\[\[vm\]\]$/.test(l)).length;
  const mounts = flyLines.filter((l) => /^\[+mounts\]+$/.test(l)).length;
  const tooMany = (key) => Number(tomlValue(fly, key)) > 1;
  if (vms > 1 || mounts > 1 || tooMany('min_machines_running') || tooMany('max_machines_running') || tooMany('machines')) {
    problems.push('More than one machine is configured. Flock needs exactly ONE machine, because each machine would have its own database.');
  }

  for (const [name, text] of [['fly.toml', fly], ['Dockerfile', dockerfile]]) {
    text.split('\n').forEach((raw, i) => {
      const line = stripComment(raw);
      const named = line.match(/^(?:ENV\s+)?([A-Za-z0-9_.-]*)\s*[= ]\s*['"]?([^'"\s]+)/i);
      const looksSecret = (named && SECRET_NAME.test(named[1]) && !/^\d+$/.test(named[2]) && /^(ENV\s|[A-Za-z0-9_.-]+\s*=)/i.test(line))
        || SECRET_SHAPES.some((re) => re.test(line));
      if (looksSecret) problems.push(`${name} line ${i + 1} looks like it contains a secret. Keep secrets out of these files (use "fly secrets set").`);
    });
  }
  return problems;
}

function main(argv) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const opt = (name, fallback) => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const production = argv.includes('--production');
  const problems = checkConfig({
    fly: readFileSync(opt('--fly', `${root}/fly.toml`), 'utf8'),
    dockerfile: readFileSync(opt('--dockerfile', `${root}/Dockerfile`), 'utf8'),
    production,
  });
  if (problems.length) {
    console.error(`Deployment settings have ${problems.length === 1 ? 'a problem' : `${problems.length} problems`}:`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log(`Deployment settings look good${production ? ' for production' : ''}.`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
