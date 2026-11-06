// A minimal fake screen root. Supports only: innerHTML, addEventListener, and
// events whose target has closest(), dataset and elements. No real DOM, files or network.
export function fakeRoot() {
  const children = [];
  const makeEl = () => {
    const handlers = {};
    const el = {
      innerHTML: '', parentNode: null, handlers,
      addEventListener(type, fn) { (handlers[type] ??= []).push(fn); },
    };
    return el;
  };
  const root = {
    ownerDocument: { createElement: makeEl },
    children,
    appendChild(el) { el.parentNode = root; children.push(el); },
    get innerHTML() { return children.map((c) => c.innerHTML).join(''); },
    set innerHTML(v) { for (const c of children) c.parentNode = null; children.length = 0; },
    // Fire an event at the elements currently on screen.
    fire(type, target) {
      const e = { target: { ...target, closest() { return this; } }, preventDefault() { e.prevented = true; } };
      const results = children.flatMap((c) => (c.handlers[type] ?? []).map((fn) => fn(e)));
      return Object.assign(Promise.all(results), { event: e });
    },
    click(action, id) {
      return root.fire('click', { dataset: { action, ...(id === undefined ? {} : { id: String(id) }) } });
    },
    submit(formName, fields) {
      const elements = {};
      for (const [k, v] of Object.entries(fields)) elements[k] = { value: v };
      return root.fire('submit', { dataset: { form: formName }, elements });
    },
  };
  return root;
}

export function fakeApi(routes) {
  const calls = [];
  const run = async (method, path, body) => {
    calls.push(body === undefined ? `${method} ${path}` : `${method} ${path} ${JSON.stringify(body)}`);
    let r = routes[`${method} ${path}`];
    if (typeof r === 'function') r = r(body);
    if (r instanceof Error) throw r;
    return r ?? {};
  };
  return { calls, get: (p) => run('GET', p), post: (p, b = {}) => run('POST', p, b), del: (p) => run('DELETE', p) };
}
