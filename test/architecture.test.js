// Architecture rules, enforced by scanning the source (see ARCHITECTURE.md).
//
// LEGACY lists the files that are still allowed to break the rules while they
// wait for their refactor card. The list can only shrink: a file in LEGACY that
// no longer breaks any rule fails the test until it is taken off the list.
// The final QA card asserts LEGACY is empty.
export const LEGACY = [];

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, listJs, lex, importsOf, analyse, findCycles } from './helpers/source.js';

const under = (file, dir) => file === dir || file.startsWith(`${dir}/`);
const isAny = (file, places) => places.some((p) => (p.endsWith('/') ? under(file, p.slice(0, -1)) : file === p));
const isBuiltin = (t) => t.startsWith('node:');

// Where each exception lives. A trailing '/' means "the whole folder".
const SQLITE_OK = ['src/db.js', 'src/data/sqlite/', 'src/container.js', 'bin/flock.js', 'src/cli/'];
const SQL_TEXT_OK = ['src/db.js', 'src/migrations/', 'src/data/sqlite/'];
const IMPURE_OK = ['src/infra/', 'src/config.js', 'src/container.js', 'bin/', 'src/cli/'];
const DATA_MAY_IMPORT = ['src/data/', 'src/db.js', 'src/errors.js'];
// Code that must reach data only through services / the data layer, never via
// a raw connection (the old ctx.db, now removed from the route deps).
const NO_RAW_DB = ['src/routes/', 'src/services/', 'src/guard.js', 'src/http.js'];
const RAW_DB = /\b(?:ctx|deps)\s*\.\s*db\b|\{[^{}]*\bdb\b[^{}]*\}\s*=\s*(?:ctx|deps)\b/g;

export const SQL_PATTERNS = [
  { name: 'SELECT ... FROM', re: /\bSELECT\b[\s\S]*?\bFROM\b/ },
  { name: 'INSERT INTO', re: /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\b/ },
  { name: 'UPDATE ... SET', re: /\bUPDATE\b[\s\S]*?\bSET\b/ },
  { name: 'DELETE FROM', re: /\bDELETE\s+FROM\b/ },
  { name: 'PRAGMA', re: /\bPRAGMA\b/ },
  { name: 'VACUUM', re: /\bVACUUM\b/ },
];

const IMPURE_PATTERNS = [
  { name: 'Date.now()', re: /\bDate\s*\.\s*now\b/g },
  { name: 'new Date() with no arguments', re: /\bnew\s+Date\s*(?:\(\s*\)|(?!\s*\())/g },
  { name: 'Math.random', re: /\bMath\s*\.\s*random\b/g },
  { name: 'process.env', re: /\bprocess\s*\.\s*env\b/g },
];

function lineOf(src, offset) {
  let l = 1;
  for (let k = 0; k < offset; k++) if (src[k] === '\n') l++;
  return l;
}

/** Every rule violation in the given analysed files: [{file, line, rule, detail}]. */
export function checkRules(files) {
  const v = [];
  const add = (file, line, rule, detail) => v.push({ file, line, rule, detail });

  for (const f of files) {
    const { file } = f;
    for (const im of f.imports) {
      const t = im.target;
      if ((t === 'node:sqlite' || t === 'src/db.js') && !isAny(file, SQLITE_OK)) {
        add(file, im.line, 'only the database layer may use node:sqlite or src/db.js', `imports ${im.spec}`);
      }
      if (under(file, 'src/routes') && under(t, 'src/data')) {
        add(file, im.line, 'routes never import the data layer (call a service)', `imports ${im.spec}`);
      }
      if (under(file, 'src/services') && (under(t, 'src/routes') || t === 'src/db.js')) {
        add(file, im.line, 'services never import routes or src/db.js', `imports ${im.spec}`);
      }
      if (under(file, 'src/data') && !isBuiltin(t) && !isAny(t, DATA_MAY_IMPORT)) {
        add(file, im.line, 'the data layer imports nothing from services, routes or infra (only errors)', `imports ${im.spec}`);
      }
      if (under(file, 'src/infra') && !isBuiltin(t) && !under(t, 'src/infra')) {
        add(file, im.line, 'infra imports nothing from the app', `imports ${im.spec}`);
      }
    }

    if (!isAny(file, SQL_TEXT_OK)) {
      for (const s of f.strings) {
        const hit = SQL_PATTERNS.find((p) => p.re.test(s.value));
        if (hit) add(file, s.line, 'no SQL outside src/db.js, src/migrations and src/data/sqlite', `${hit.name} in a ${s.kind} literal`);
      }
    }

    if (isAny(file, NO_RAW_DB)) {
      for (const m of f.code.matchAll(RAW_DB)) {
        add(file, lineOf(f.src, m.index), 'routes, the guard and services never use the raw database (ctx.db is deprecated)', m[0].trim());
      }
    }

    if (!isAny(file, IMPURE_OK)) {
      for (const p of IMPURE_PATTERNS) {
        for (const m of f.code.matchAll(p.re)) {
          add(file, lineOf(f.src, m.index), 'time, randomness and the environment come from injected infra', p.name);
        }
      }
    }
  }

  const graph = {};
  for (const f of files) {
    if (!under(f.file, 'src')) continue;
    graph[f.file] = f.imports.map((im) => im.target).filter((t) => under(t, 'src'));
  }
  for (const cycle of findCycles(graph)) {
    for (const file of cycle) add(file, 0, 'no import cycles', `cycle: ${cycle.join(' <-> ')}`);
  }
  return v;
}

const format = (list) => list.map((x) => `  ${x.file}${x.line ? `:${x.line}` : ''}  ${x.rule} (${x.detail})`).join('\n');

const files = analyse(listJs('src', 'bin'));
const violations = checkRules(files);

test('architecture: no file outside LEGACY breaks a layering rule', () => {
  const bad = violations.filter((x) => !LEGACY.includes(x.file));
  assert.equal(bad.length, 0, `Architecture rules broken (see ARCHITECTURE.md):\n${format(bad)}`);
});

test('architecture: LEGACY only lists files that still break a rule (the list can only shrink)', () => {
  const stale = LEGACY.filter((file) => !violations.some((x) => x.file === file));
  assert.deepEqual(stale, [], `These files follow every rule now; remove them from LEGACY in test/architecture.test.js:\n  ${stale.join('\n  ')}`);
  const missing = LEGACY.filter((file) => !existsSync(path.join(ROOT, file)));
  assert.deepEqual(missing, [], `LEGACY lists files that do not exist: ${missing.join(', ')}`);
  assert.equal(new Set(LEGACY).size, LEGACY.length, 'LEGACY has duplicates');
});

test('architecture: the scan covers the layers', () => {
  const names = files.map((f) => f.file);
  for (const f of ['src/container.js', 'src/server.js', 'src/db.js', 'src/data/index.js', 'src/routes/index.js', 'bin/flock.js']) {
    assert.ok(names.includes(f), `${f} was not scanned`);
  }
  for (const s of ['auth', 'people', 'teams', 'calendar', 'blockouts', 'assignments', 'gaps', 'availability', 'autofill']) {
    assert.ok(names.includes(`src/services/${s}-service.js`), `missing service ${s}`);
  }
  // The container really is wired: it imports the db layer and every service.
  const c = files.find((f) => f.file === 'src/container.js');
  assert.ok(c.imports.some((im) => im.target === 'src/db.js'));
  assert.equal(c.imports.filter((im) => im.target.startsWith('src/services/')).length, 9);
});

// ---------- self-tests of the scanner, so the rules cannot pass by accident ----------

test('scanner: strings, templates, comments and regexes are told apart', () => {
  const src = [
    "import { a } from './a.js';",
    "export * from '../b.js';",
    "const x = await import('node:sqlite');",
    '// SELECT name FROM people in a comment',
    '/* DELETE FROM people */',
    'const re = /DELETE FROM/g; const half = 4 / 2 / 1;',
    "const q = `SELECT ${cols} FROM t WHERE id = ${id}`;",
    "const s = 'Pick a team from the list';",
    "const n = `a ${ { k: 'INSERT INTO x' }.k } b`;",
    'const t = new Date(); const u = Date.now(); // Math.random',
  ].join('\n');
  const { code, strings } = lex(src);
  assert.deepEqual(importsOf(src).map((i) => i.spec), ['./a.js', '../b.js', 'node:sqlite']);
  const values = strings.map((s) => s.value);
  assert.ok(values.includes('SELECT ${} FROM t WHERE id = ${}'));
  assert.ok(values.includes('INSERT INTO x'));
  assert.ok(!values.some((v) => v.includes('DELETE')), 'regex and comment text are not strings');
  assert.ok(!code.includes('SELECT') && !code.includes('DELETE') && !code.includes('Math.random'));
  assert.match(code, /new Date\(\)/);
  assert.match(code, /Date\.now\(\)/);
  assert.equal(code.length, src.length);
});

test('scanner: every rule catches a planted violation', () => {
  const fake = (file, src) => {
    const { code, strings } = lex(src);
    const imports = importsOf(src).map((im) => ({ ...im, target: im.spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), im.spec)) : im.spec }));
    return { file, src, code, strings, imports };
  };
  const planted = [
    fake('src/routes/x.js', "import { createData } from '../data/index.js';\nimport { openDb } from '../db.js';"),
    fake('src/services/x-service.js', "import * as r from '../routes/teams.js';\nconst q = 'UPDATE people SET name = ?';"),
    fake('src/data/sqlite/x.js', "import { createTeamsService } from '../../services/teams-service.js';"),
    fake('src/infra/x.js', "import { AppError } from '../errors.js';"),
    fake('src/services/y-service.js', 'const a = Math.random(); const b = process.env.X; const c = new Date; const d = Date.now();'),
    fake('src/routes/z.js', "export function register(router, ctx) { const { db } = ctx; return ctx.db; }"),
    fake('src/a.js', "import './b.js';"),
    fake('src/b.js', "import './a.js';"),
    fake('src/container.js', "import { openDb } from './db.js'; const e = process.env;"),
  ];
  const found = checkRules(planted);
  const rules = (file) => found.filter((x) => x.file === file).map((x) => x.rule);
  assert.equal(rules('src/routes/x.js').length, 2);
  assert.equal(rules('src/services/x-service.js').length, 2);
  assert.equal(rules('src/data/sqlite/x.js').length, 1);
  assert.equal(rules('src/infra/x.js').length, 1);
  assert.equal(rules('src/services/y-service.js').length, 4);
  assert.equal(rules('src/routes/z.js').length, 2);
  assert.deepEqual(rules('src/a.js'), ['no import cycles']);
  assert.deepEqual(rules('src/b.js'), ['no import cycles']);
  assert.deepEqual(rules('src/container.js'), []);
});

test('scanner: cycle finder', () => {
  assert.deepEqual(findCycles({ a: ['b'], b: ['c'], c: ['a'], d: ['a'] }), [['a', 'b', 'c']]);
  assert.deepEqual(findCycles({ a: ['a'] }), [['a']]);
  assert.deepEqual(findCycles({ a: ['b'], b: [] }), []);
});

// ---------- final QA (C-78) ----------

test('architecture: LEGACY is empty (every file follows every rule)', () => {
  assert.deepEqual(LEGACY, []);
});

test('architecture: services are built only in src/container.js', () => {
  // A service factory is createXService (in src/services/x-service.js). Only
  // the container may name or call one; nothing in src or bin builds its own.
  // (Importing a plain constant from a service module is fine.)
  const factoryNames = [];
  for (const f of files.filter((x) => under(x.file, 'src/services'))) {
    for (const m of f.code.matchAll(/export\s+function\s+(create[A-Z]\w*Service)\b/g)) factoryNames.push(m[1]);
  }
  assert.ok(factoryNames.length >= 7, `found only ${factoryNames.join(', ')}`);
  const offenders = [];
  for (const f of files) {
    if (f.file === 'src/container.js' || under(f.file, 'src/services')) continue;
    for (const name of factoryNames) {
      if (new RegExp(`\\b${name}\\b`).test(f.code)) offenders.push(`${f.file} uses ${name}`);
    }
  }
  // Services never build each other either: they get other services injected.
  for (const f of files.filter((x) => under(x.file, 'src/services'))) {
    for (const name of factoryNames) {
      const uses = [...f.code.matchAll(new RegExp(`(?<!function\\s+)\\b${name}\\s*\\(`, 'g'))];
      if (uses.length) offenders.push(`${f.file} calls ${name}`);
    }
  }
  assert.deepEqual(offenders, []);
});

/** Repository name -> method names, read from the JSDoc typedefs in src/data/index.js. */
export function interfaceMethods(src) {
  const blocks = src.split('/**').slice(1).map((b) => b.split('*/')[0]);
  const props = (block) => {
    const out = [];
    let i = 0;
    while ((i = block.indexOf('@property {', i)) >= 0) {
      let depth = 0;
      let j = i + '@property '.length;
      for (; j < block.length; j++) {
        if (block[j] === '{') depth++;
        else if (block[j] === '}' && --depth === 0) break;
      }
      const name = /^\s*([A-Za-z_$][\w$]*)/.exec(block.slice(j + 1));
      if (name) out.push({ type: block.slice(i + '@property {'.length, j), name: name[1] });
      i = j;
    }
    return out;
  };
  const typedefs = {};
  for (const b of blocks) {
    const m = /@typedef\s+\{object\}\s+(\w+)/.exec(b);
    if (m) typedefs[m[1]] = props(b);
  }
  const repos = {};
  for (const { type, name } of typedefs.Data ?? []) {
    if (typedefs[type]) repos[name] = typedefs[type].map((p) => p.name);
  }
  return { repos, dataProps: (typedefs.Data ?? []).map((p) => p.name) };
}

test('data interface: every repository method in src/data/index.js has a contract test', () => {
  const src = readFileSync(path.join(ROOT, 'src/data/index.js'), 'utf8');
  // Code only: a call that is commented out does not count.
  const contract = lex(readFileSync(path.join(ROOT, 'test/data/contract.js'), 'utf8')).code;
  const { repos, dataProps } = interfaceMethods(src);
  assert.deepEqual(Object.keys(repos).sort(),
    ['audit', 'availability', 'blockouts', 'invites', 'maintenance', 'people', 'positions', 'qualifications', 'services', 'sessions', 'slots', 'teams']);
  assert.ok(dataProps.includes('tx'));
  const missing = [];
  let count = 0;
  for (const [repo, methods] of Object.entries(repos)) {
    assert.ok(methods.length > 0, `${repo} has no methods`);
    for (const m of methods) {
      count++;
      if (!new RegExp(`\\.${repo}\\.${m}\\(`).test(contract)) missing.push(`${repo}.${m}`);
    }
  }
  if (!/\.tx\(/.test(contract)) missing.push('tx');
  assert.ok(count >= 50, `only ${count} methods found; is the JSDoc parser broken?`);
  assert.deepEqual(missing, [], `Not exercised in test/data/contract.js: ${missing.join(', ')}`);
});

test('data interface: the JSDoc parser reads nested braces in types', () => {
  const { repos } = interfaceMethods([
    '/**', ' * @typedef {object} FooRepo',
    ' * @property {(p: {a: number, b?: {c: string}}) => Promise<{id: number}>} make  Some text.',
    ' * @property {() => Promise<number>} count', ' */',
    '/**', ' * @typedef {object} Data', ' * @property {FooRepo} foo', ' * @property {Function} tx', ' */',
  ].join('\n'));
  assert.deepEqual(repos, { foo: ['make', 'count'] });
});
