// A tiny fake screen root: records listeners, and lets a test "click" or "submit"
// by describing the element. No real DOM, no files, no network.
export function fakeRoot() {
  const handlers = {};
  const parts = new Map();
  const root = {
    innerHTML: '',
    addEventListener(type, fn) { (handlers[type] ??= []).push(fn); },
    querySelector(sel) {
      if (!parts.has(sel)) parts.set(sel, { innerHTML: '', textContent: '' });
      return parts.get(sel);
    },
    fire(type, target) {
      const e = { target, preventDefault() { e.prevented = true; } };
      for (const fn of handlers[type] ?? []) fn(e);
      return e;
    },
    click(action, id, extra = {}) {
      return root.fire('click', el({ dataset: { action, ...(id === undefined ? {} : { id: String(id) }) }, ...extra }));
    },
    submit(formName, fields, id) {
      const elements = {};
      for (const [k, v] of Object.entries(fields)) elements[k] = typeof v === 'boolean' ? { checked: v } : { value: v };
      return root.fire('submit', el({ dataset: { form: formName, ...(id === undefined ? {} : { id: String(id) }) }, elements }));
    },
    parts,
  };
  return root;
}

function el(o) { return { ...o, closest() { return this; } }; }

// A fake api that records calls. routes: { 'GET /api/people': value | (body) => value | throws }
export function fakeApi(routes) {
  const calls = [];
  const run = async (method, path, body) => {
    calls.push(body === undefined ? `${method} ${path}` : `${method} ${path} ${JSON.stringify(body)}`);
    let r = routes[`${method} ${path}`];
    if (typeof r === 'function') r = r(body);
    if (r instanceof Error) throw r;
    return r ?? {};
  };
  return {
    calls,
    get: (p) => run('GET', p),
    post: (p, b = {}) => run('POST', p, b),
    put: (p, b = {}) => run('PUT', p, b),
    patch: (p, b = {}) => run('PATCH', p, b),
    del: (p, b) => run('DELETE', p, b),
  };
}

export const tick = () => new Promise((r) => setImmediate(r));
