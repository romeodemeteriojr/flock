// Small static-analysis helpers for the architecture tests: list source files,
// split a file into code / string literals / comments, find its imports and
// build the import graph. No dependencies, no real parsing; good enough for
// the plain ESM style this repo uses (checked by self-tests).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const toPosix = (p) => p.split(path.sep).join('/');

/** Repo-relative posix paths of every .js file under the given folders. */
export function listJs(...dirs) {
  const out = [];
  const walk = (abs) => {
    let st;
    try { st = statSync(abs); } catch { return; }
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) walk(path.join(abs, name));
    } else if (abs.endsWith('.js')) {
      out.push(toPosix(path.relative(ROOT, abs)));
    }
  };
  for (const d of dirs) walk(path.join(ROOT, d));
  return out;
}

const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);

/**
 * Split JavaScript source.
 * @returns {{code: string, strings: {value: string, start: number, line: number, kind: 'string'|'template'}[]}}
 *   code: the source with every comment, string, template text and regex blanked
 *   (newlines kept, so offsets and line numbers stay the same). Template
 *   expressions stay in `code`; a template's text parts are joined with '${}'.
 */
export function lex(src) {
  const n = src.length;
  const code = src.split('');
  const strings = [];
  const stack = [];
  let i = 0;
  let prev = '';
  const blank = (a, b) => { for (let k = a; k < b && k < n; k++) if (code[k] !== '\n') code[k] = ' '; };
  const lineAt = (idx) => { let l = 1; for (let k = 0; k < idx; k++) if (src[k] === '\n') l++; return l; };

  const regexAllowed = () => {
    if (!prev) return true;
    if (prev === 'val' || prev === 'op:)' || prev === 'op:]') return false;
    if (prev.startsWith('word:')) return REGEX_AFTER_WORD.has(prev.slice(5));
    return true;
  };

  // Reads template text from i until the closing backtick or a `${`.
  function readTemplate(rec) {
    const from = i;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { rec.value += src[i + 1] ?? ''; i += 2; continue; }
      if (c === '`') { i++; blank(from, i); prev = 'val'; return; }
      if (c === '$' && src[i + 1] === '{') {
        rec.value += '${}';
        i += 2;
        blank(from, i);
        stack.push({ tpl: rec });
        prev = 'op:{';
        return;
      }
      rec.value += c;
      i++;
    }
    blank(from, i);
  }

  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      const end = e < 0 ? n : e;
      blank(i, end); i = end; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end); i = end; continue;
    }
    if (c === '#' && i === 0 && src[1] === '!') {
      const e = src.indexOf('\n');
      const end = e < 0 ? n : e;
      blank(0, end); i = end; continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      let value = '';
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') { value += src[i + 1] ?? ''; i += 2; } else { value += src[i]; i++; }
      }
      i++;
      strings.push({ value, start, line: lineAt(start), kind: 'string' });
      blank(start, i);
      prev = 'val';
      continue;
    }
    if (c === '`') {
      const rec = { value: '', start: i, line: lineAt(i), kind: 'template' };
      strings.push(rec);
      code[i] = ' ';
      i++;
      readTemplate(rec);
      continue;
    }
    if (c === '/') {
      if (regexAllowed()) {
        const start = i;
        i++;
        let inClass = false;
        while (i < n) {
          const ch = src[i];
          if (ch === '\\') { i += 2; continue; }
          if (ch === '\n') break;
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) { i++; break; }
          i++;
        }
        while (i < n && /[A-Za-z]/.test(src[i])) i++;
        blank(start, i);
        prev = 'val';
      } else {
        prev = 'op:/';
        i++;
      }
      continue;
    }
    if (c === '{') { stack.push('brace'); prev = 'op:{'; i++; continue; }
    if (c === '}') {
      const top = stack.pop();
      if (top && top.tpl) { code[i] = ' '; i++; readTemplate(top.tpl); continue; }
      prev = 'op:}'; i++; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[\w$]+/.exec(src.slice(i, i + 64));
      prev = `word:${m[0]}`;
      i += m[0].length;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[\w.]+/.exec(src.slice(i, i + 64));
      prev = 'val';
      i += m[0].length;
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    prev = `op:${c}`;
    i++;
  }
  return { code: code.join(''), strings };
}

const IMPORT_BEFORE = /(?:\bfrom|\bimport\s*\(|\bimport)\s*$/;

/** Module specifiers a file imports (static, re-exports and literal dynamic imports). */
export function importsOf(src) {
  const { code, strings } = lex(src);
  const out = [];
  for (const s of strings) {
    if (s.kind === 'template' && s.value.includes('${}')) continue;
    const before = code.slice(Math.max(0, s.start - 40), s.start);
    if (IMPORT_BEFORE.test(before)) out.push({ spec: s.value, line: s.line });
  }
  return out;
}

/** Resolve a specifier from a repo-relative file to a repo-relative path (or keep it, for builtins/packages). */
export function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return spec;
  return toPosix(path.relative(ROOT, path.resolve(ROOT, path.dirname(fromFile), spec)));
}

/** Read and analyse every file: { file, src, code, strings, imports: [{spec, target, line}] }. */
export function analyse(files) {
  return files.map((file) => {
    const src = readFileSync(path.join(ROOT, file), 'utf8');
    const { code, strings } = lex(src);
    const imports = importsOf(src).map((im) => ({ ...im, target: resolveSpec(file, im.spec) }));
    return { file, src, code, strings, imports };
  });
}

/**
 * Import cycles in a graph { node: [targets] } (Tarjan's strongly connected
 * components). Returns arrays of nodes, each one cycle group (size > 1, or a
 * node that imports itself).
 */
export function findCycles(graph) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const st = [];
  const out = [];
  const visit = (v) => {
    idx.set(v, index); low.set(v, index); index++;
    st.push(v); onStack.add(v);
    for (const w of graph[v] ?? []) {
      if (!Object.hasOwn(graph, w)) continue;
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do { w = st.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1 || (graph[v] ?? []).includes(v)) out.push(comp.sort());
    }
  };
  for (const v of Object.keys(graph).sort()) if (!idx.has(v)) visit(v);
  return out;
}

/** 1-based line of an offset. */
export function lineOf(src, offset) {
  let l = 1;
  for (let k = 0; k < offset; k++) if (src[k] === '\n') l++;
  return l;
}
