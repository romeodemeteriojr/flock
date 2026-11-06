// A fake whole page for UI flow tests: the REAL web/app.js (router, nav, toasts,
// forced password change, logged-out redirect) running over a tiny fake DOM,
// with the REAL web/api.js talking real HTTP to a started test app.
//
// It is built so a test can only do what a person could do:
//  - click(action, id) / clickButton('Label') only work if that control is on
//    the page, and do nothing if the control is disabled;
//  - submit(formName, fields) fills in a form that is on the page (unknown field
//    names throw; fields not given keep the value the page showed) and does
//    nothing while the form's submit button is disabled;
//  - text() / html() give what is on screen, and accessibilityProblems() checks
//    every button, link and input has a name.
// Additive: nothing here changes the older helpers (fakeui.js, fakeroot.js).
// No real files, no real home folder, made-up data only.
import { createApi } from '../../web/api.js';
import { createApp } from '../../web/app.js';
import { esc } from '../../web/lib/html.js';

// ---------- small HTML tools ----------

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#96;': '`' };
export const unescapeHtml = (s) => String(s).replace(/&(?:amp|lt|gt|quot|#39|#96);/g, (m) => ENTITIES[m]);

const INLINE = /<\/?(?:strong|span|em|b|i|a|small|label|abbr|mark)\b[^>]*>/gi;
/** The words a person would read in an HTML string. */
export function textOf(html) {
  return unescapeHtml(String(html)
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(INLINE, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

const TAG_RE = /<([a-zA-Z][\w-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link']);

export function parseAttrs(str) {
  const attrs = new Map();
  for (const m of String(str).matchAll(ATTR_RE)) attrs.set(m[1].toLowerCase(), unescapeHtml(m[2] ?? m[3] ?? m[4] ?? ''));
  return attrs;
}

/** Every opening tag in html: { name, attrs, index, end }. */
export function allTags(html) {
  const out = [];
  for (const m of String(html).matchAll(TAG_RE)) {
    out.push({ name: m[1].toLowerCase(), attrs: parseAttrs(m[2]), index: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** The index where the element opened by `tag` closes (start of its end tag), or end of html. */
export function closeIndex(html, tag) {
  if (VOID.has(tag.name)) return tag.end;
  const re = new RegExp(`<(/?)${tag.name}(?=[\\s>/])(?:"[^"]*"|'[^']*'|[^>"'])*>`, 'gi');
  re.lastIndex = tag.end;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1]) { if (--depth === 0) return m.index; } else depth++;
  }
  return String(html).length;
}

const innerOf = (html, tag) => String(html).slice(tag.end, closeIndex(html, tag));

// ---------- selectors (the simple kinds the views use) ----------

function lastCompound(sel) {
  let depth = 0;
  let cut = 0;
  const s = String(sel).trim();
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (/\s/.test(c) && depth === 0) cut = i + 1;
  }
  return s.slice(cut);
}

export function parseSelector(sel) {
  let s = lastCompound(sel);
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const t = /^[a-zA-Z][\w-]*/.exec(s);
  if (t) { out.tag = t[0].toLowerCase(); s = s.slice(t[0].length); }
  while (s) {
    let m;
    if ((m = /^#([\w-]+)/.exec(s))) out.id = m[1];
    else if ((m = /^\.([\w-]+)/.exec(s))) out.classes.push(m[1]);
    else if ((m = /^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/.exec(s))) out.attrs.push([m[1].toLowerCase(), m[2] ?? m[3] ?? m[4]]);
    else throw new Error(`fakepage cannot read the selector "${sel}"`);
    s = s.slice(m[0].length);
  }
  return out;
}

function tagMatches(tag, p) {
  if (p.tag && tag.name !== p.tag) return false;
  if (p.id !== null && tag.attrs.get('id') !== p.id) return false;
  if (p.classes.length) {
    const have = (tag.attrs.get('class') ?? '').split(/\s+/);
    if (!p.classes.every((c) => have.includes(c))) return false;
  }
  return p.attrs.every(([n, v]) => tag.attrs.has(n) && (v === undefined || tag.attrs.get(n) === v));
}

export function findTags(html, sel) {
  const p = parseSelector(sel);
  return allTags(html).filter((t) => tagMatches(t, p));
}

// ---------- the fake element ----------

const datasetOf = (attrs) => {
  const d = {};
  for (const [k, v] of attrs) {
    if (k.startsWith('data-')) d[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return d;
}

const FIELD = /^(input|select|textarea)$/;

class FakeEl {
  constructor(page, { tag = 'div', attrs = new Map(), html = '', parent = null } = {}) {
    this.page = page;
    this.name = tag;
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this._html = html;
    this.parent = parent;
    this.handlers = {};
    this.kids = []; // { el, index, start, end }: elements found inside _html
    this.children = []; // appended elements
    this.dirty = false;
    this.dataset = datasetOf(attrs);
    this.disabled = attrs.has('disabled');
    this.checked = attrs.has('checked');
    this.value = attrs.get('value') ?? '';
    this.elements = null;
    this.ownerDocument = page.document;
    const classes = new Set((attrs.get('class') ?? '').split(/\s+/).filter(Boolean));
    this.classList = {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
    };
  }

  get parentNode() { return this.parent; }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this.dirty = true;
    this.kids = [];
    for (const c of this.children) c.parent = null;
    this.children = [];
  }

  get textContent() { return textOf(this.effective()); }
  set textContent(v) { this.innerHTML = esc(v); }

  set className(v) { this.attrs.set('class', String(v)); }
  get className() { return this.attrs.get('class') ?? ''; }

  addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
  setAttribute(n, v) { this.attrs.set(String(n).toLowerCase(), String(v)); if (n === 'disabled') this.disabled = true; }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  hasAttribute(n) { return this.attrs.has(n); }
  removeAttribute(n) { this.attrs.delete(n); }
  focus() { this.page.focused = this; }
  blur() { if (this.page.focused === this) this.page.focused = null; }
  contains() { return false; }
  closest() { return this; }

  appendChild(el) { el.parent = this; this.children.push(el); }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  // The first element matching sel inside this one, or null (like a real DOM).
  querySelector(sel) {
    const found = findTags(this._html, sel)[0];
    if (!found) return null;
    const inside = this.kids.find((k) => found.index >= k.start && found.index < k.end);
    if (inside) return inside.el.querySelector(sel);
    const same = this.kids.find((k) => k.index === found.index);
    if (same) return same.el;
    const end = closeIndex(this._html, found);
    const el = new FakeEl(this.page, { tag: found.name, attrs: found.attrs, html: this._html.slice(found.end, end), parent: this });
    const entry = { el, index: found.index, start: found.end, end };
    // Kids found earlier that sit inside this new element now belong to it.
    for (const k of this.kids.filter((x) => x.index >= entry.start && x.index < entry.end)) {
      k.el.parent = el;
      el.kids.push({ ...k, index: k.index - entry.start, start: k.start - entry.start, end: k.end - entry.start });
    }
    this.kids = this.kids.filter((k) => !(k.index >= entry.start && k.index < entry.end));
    this.kids.push(entry);
    return el;
  }

  // The HTML a person sees for this element: its own markup with the pieces
  // that code has since changed swapped in, plus anything appended to it.
  effective() {
    let s = this._html;
    for (const k of [...this.kids].sort((a, b) => b.start - a.start)) {
      s = s.slice(0, k.start) + k.el.effective() + s.slice(k.end);
    }
    for (const c of this.children) {
      const attrs = [...c.attrs].map(([n, v]) => ` ${n}="${esc(v)}"`).join('');
      s += `<${c.name}${attrs}>${c.effective()}</${c.name}>`;
    }
    return s;
  }

  // Own markup with the regions that kids replaced blanked out (same length).
  ownMarkup() {
    let s = this._html;
    for (const k of this.kids) s = s.slice(0, k.start) + ' '.repeat(k.end - k.start) + s.slice(k.end);
    return s;
  }
}

// Fields of a form as the page shows them, with typed values on top.
function formElements(inner, typed = {}) {
  const elements = {};
  for (const t of allTags(inner)) {
    if (!FIELD.test(t.name)) continue;
    const name = t.attrs.get('name');
    if (!name) continue;
    const type = (t.attrs.get('type') ?? 'text').toLowerCase();
    if (type === 'submit' || type === 'button') continue;
    elements[name] = { name, type, value: t.attrs.get('value') ?? '', checked: t.attrs.has('checked'), disabled: t.attrs.has('disabled') };
  }
  for (const [k, v] of Object.entries(typed)) {
    if (!Object.hasOwn(elements, k)) throw new Error(`The form has no field "${k}". Fields: ${Object.keys(elements).join(', ')}`);
    if (typeof v === 'boolean') elements[k].checked = v; else elements[k].value = String(v);
  }
  return elements;
}

// ---------- the page ----------

/**
 * Open the app against a running test app (its `url`).
 * jar: pass the jar of another page to share a login (a second tab, or a reload).
 */
export function openPage({ url, jar = { cookie: '' }, fetchLog = [] } = {}) {
  const page = { jar, fetchLog, focused: null, timers: [], clipboard: [], errors: [] };
  const winHandlers = {};
  let hash = '';
  const fire = (type, ev) => { for (const fn of winHandlers[type] ?? []) fn(ev); };
  const win = {
    location: {
      get hash() { return hash; },
      set hash(h) {
        const next = String(h).startsWith('#') ? String(h) : `#${h}`;
        if (next === hash) return;
        hash = next;
        Promise.resolve().then(() => fire('hashchange', {}));
      },
    },
    history: { replaceState(_s, _t, u) { hash = String(u); } },
    addEventListener(type, fn) { (winHandlers[type] ??= []).push(fn); },
    setTimeout(fn, ms) { const t = { fn, ms }; page.timers.push(t); return t; },
    clearTimeout(t) { page.timers = page.timers.filter((x) => x !== t); },
    navigator: { clipboard: { writeText: async (t) => { page.clipboard.push(t); } } },
  };
  page.win = win;
  page.document = { title: '', createElement: (tag) => new FakeEl(page, { tag }), get activeElement() { return page.focused; } };

  let inflight = 0;
  const fetchFn = async (path, init = {}) => {
    inflight++;
    try {
      const headers = { ...(init.headers ?? {}) };
      if (jar.cookie) headers.Cookie = jar.cookie;
      const res = await fetch(url + path, { method: init.method, headers, body: init.body });
      const text = await res.text();
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const pair = c.split(';')[0];
        if (/Max-Age=0/i.test(c) || pair.endsWith('=')) jar.cookie = '';
        else jar.cookie = pair;
      }
      fetchLog.push({ method: init.method, path, status: res.status, body: init.body ? JSON.parse(init.body) : undefined, text });
      return { ok: res.ok, status: res.status, text: async () => text };
    } finally {
      inflight--;
    }
  };
  page.api = createApi(fetchFn);

  const root = new FakeEl(page, { tag: 'div', attrs: new Map([['id', 'app']]) });
  page.root = root;
  const handleThrown = (err) => {
    page.errors.push(err);
    fire('error', { error: err, preventDefault() {} });
  };
  const handleRejected = (reason) => {
    page.errors.push(reason);
    fire('unhandledrejection', { reason, preventDefault() {} });
  };

  page.app = createApp({ root, win, api: page.api });

  // ----- reading the page -----
  page.html = () => root.effective();
  page.text = () => textOf(page.html());
  page.has = (sel) => findTags(page.html(), sel).length > 0;
  page.count = (sel) => findTags(page.html(), sel).length;
  page.hash = () => hash;
  page.title = () => page.document.title;
  page.focusedText = () => (page.focused ? page.focused.textContent : null);
  page.toasts = () => findTags(page.html(), '.toast').map((t) => textOf(innerOf(page.html(), t)));
  page.buttons = () => {
    const h = page.html();
    return allTags(h).filter((t) => t.name === 'button').map((t) => ({
      label: accessibleName(h, t), disabled: t.attrs.has('disabled'), action: t.attrs.get('data-action') ?? null,
    }));
  };
  page.accessibilityProblems = () => accessibilityProblems(page.html());
  page.injectionProblems = () => injectionProblems(page.html());

  // ----- doing things -----
  // Find a control on the page (depth first). Returns { el, tag } where el is the
  // real fake element when code has looked it up, otherwise a stand-in.
  function locate(sel, el = root) {
    const own = el.ownMarkup();
    for (const tag of findTags(own, sel)) {
      const kid = el.kids.find((k) => k.index === tag.index);
      if (kid) return { el: kid.el, tag, owner: el };
      const stand = new FakeEl(page, { tag: tag.name, attrs: tag.attrs, parent: el });
      stand.markup = own;
      stand.tag = tag;
      return { el: stand, tag, owner: el };
    }
    for (const k of el.kids) { const r = locate(sel, k.el); if (r) return r; }
    for (const c of el.children) { const r = locate(sel, c); if (r) return r; }
    return null;
  }
  page.locate = locate;

  function dispatch(type, target) {
    const e = { type, target, preventDefault() { e.defaultPrevented = true; }, defaultPrevented: false };
    const results = [];
    for (let el = target; el; el = el.parent) {
      for (const fn of el.handlers[type] ?? []) {
        try {
          const r = fn(e);
          if (r && typeof r.then === 'function') results.push(r.catch(handleRejected));
        } catch (err) { handleThrown(err); }
      }
    }
    return { e, done: Promise.all(results) };
  }

  const selFor = (action, id, extra = '') => `[data-action="${action}"]${id === undefined ? '' : `[data-id="${id}"]`}${extra}`;
  const finish = async (d) => { await d.done; await page.settle(); return d.e; };

  page.settle = async () => {
    let idle = 0;
    for (let i = 0; i < 2000 && idle < 3; i++) {
      await new Promise((r) => setImmediate(r));
      if (inflight === 0) idle++; else idle = 0;
    }
  };

  /** Click the control with this data-action (and data-id). Returns false if it is missing or disabled. */
  page.click = (action, id) => {
    const found = locate(selFor(action, id));
    if (!found) throw new Error(`There is no "${action}"${id === undefined ? '' : ` ${id}`} control on the page`);
    if (found.el.disabled || found.tag.attrs.has('disabled')) return Promise.resolve(false);
    return finish(dispatch('click', found.el)).then(() => true);
  };
  /** Is there such a control, and is it usable? */
  page.canClick = (action, id) => {
    const found = locate(selFor(action, id));
    return !!found && !found.el.disabled && !found.tag.attrs.has('disabled');
  };

  /** Click a button by the name a person sees (text or aria-label). */
  page.clickButton = (label, { nth = 0 } = {}) => {
    const h = page.html();
    const same = (n) => (label instanceof RegExp ? label.test(n) : n === label);
    const hits = allTags(h).filter((t) => t.name === 'button' && same(accessibleName(h, t)));
    const tag = hits[nth];
    if (!tag) throw new Error(`There is no button named "${label}". Buttons: ${page.buttons().map((b) => b.label).join(' | ')}`);
    if (tag.attrs.has('disabled')) return Promise.resolve(false);
    const action = tag.attrs.get('data-action');
    if (!action) throw new Error(`The "${label}" button is a submit button: use submit()`);
    return page.click(action, tag.attrs.get('data-id'));
  };

  /** Follow a link (<a href="#/...">) by its text, as a tap would. */
  page.clickLink = async (label) => {
    const h = page.html();
    const tag = allTags(h).find((t) => t.name === 'a' && t.attrs.has('href') && (label instanceof RegExp ? label.test(textOf(innerOf(h, t))) : textOf(innerOf(h, t)) === label));
    if (!tag) throw new Error(`There is no link "${label}"`);
    const href = tag.attrs.get('href');
    const found = locate(`a[href="${href}"]`);
    const d = dispatch('click', found.el);
    if (href.startsWith('#')) win.location.hash = href;
    return finish(d);
  };

  /** Fill and submit a form that is on the page. Does nothing while its button is disabled. */
  page.submit = (formName, fields = {}) => {
    const found = locate(`form[data-form="${formName}"]`);
    if (!found) throw new Error(`There is no "${formName}" form on the page`);
    const { el, owner } = found;
    const formTag = found.tag;
    // A form the code has looked up holds its own markup; otherwise read it from the owner.
    const inner = el.tag ? innerOf(owner.ownMarkup(), formTag) : el.effective();
    const submit = allTags(inner).find((t) => t.name === 'button' && (t.attrs.get('type') ?? 'submit') === 'submit');
    if (submit && submit.attrs.has('disabled')) return Promise.resolve(false);
    // A button the code has disabled (login and password forms do this).
    const lookedUp = el.kids.map((k) => k.el).find((k) => k.name === 'button' && k.attrs.get('type') === 'submit');
    if (lookedUp?.disabled) return Promise.resolve(false);
    // Fields keep what the page showed unless the person typed something.
    el.elements = formElements(inner, fields);
    el.dataset = datasetOf(formTag.attrs);
    return finish(dispatch('submit', el)).then(() => true);
  };

  /** Type into an input that has this data-action (search box, new-name). */
  page.type = (action, value) => {
    const found = locate(selFor(action));
    if (!found) throw new Error(`There is no input "${action}" on the page`);
    found.el.value = String(value);
    return finish(dispatch('input', found.el));
  };

  /** Tick or untick a checkbox with data-action (the "What can they do?" list). */
  page.tick = (action, attrs, on = true) => {
    const extra = Object.entries(attrs).map(([k, v]) => `[data-${k}="${v}"]`).join('');
    const found = locate(selFor(action, undefined, extra));
    if (!found) throw new Error(`There is no checkbox "${action}" ${JSON.stringify(attrs)}`);
    found.el.checked = !!on;
    dispatch('click', found.el);
    return finish(dispatch('change', found.el));
  };

  /** Change the address, like typing in the bar or pressing the back button. */
  page.goto = async (to) => { win.location.hash = to; await page.settle(); };
  /** Run every pending timer (toasts fading away, for example). */
  page.runTimers = () => { const t = page.timers; page.timers = []; for (const x of t) x.fn(); };
  /** Start the app, as the browser does when the page loads. */
  page.start = async () => { await page.app.start(); await page.settle(); return page; };

  return page;
}

// ---------- accessibility and safety checks ----------

/** What a screen reader says for this tag: aria-label, aria-labelledby, or its text. */
export function accessibleName(html, tag) {
  const label = tag.attrs.get('aria-label');
  if (label && label.trim()) return label.trim();
  const by = tag.attrs.get('aria-labelledby');
  if (by) {
    const t = allTags(html).find((x) => x.attrs.get('id') === by.split(/\s+/)[0]);
    if (t) return textOf(innerOf(html, t));
  }
  return textOf(innerOf(html, tag));
}

/** Problems that would leave a control without a name, or break label links. Empty means fine. */
export function accessibilityProblems(html) {
  const problems = [];
  const tags = allTags(html);
  const ids = new Map();
  for (const t of tags) {
    const id = t.attrs.get('id');
    if (id) ids.set(id, (ids.get(id) ?? 0) + 1);
  }
  for (const [id, n] of ids) if (n > 1) problems.push(`id "${id}" is used ${n} times`);

  const labels = tags.filter((t) => t.name === 'label').map((t) => ({ tag: t, end: closeIndex(html, t) }));
  const labelFor = new Map();
  for (const l of labels) {
    const f = l.tag.attrs.get('for');
    if (f) {
      if (!ids.has(f)) problems.push(`a label points at "${f}" but nothing has that id`);
      if (textOf(innerOf(html, l.tag)) === '') problems.push(`the label for "${f}" is empty`);
      labelFor.set(f, true);
    }
  }
  const where = (t) => `<${t.name}${t.attrs.get('id') ? ` id="${t.attrs.get('id')}"` : ''}${t.attrs.get('data-action') ? ` data-action="${t.attrs.get('data-action')}"` : ''}>`;
  for (const t of tags) {
    if (t.name === 'button' || t.name === 'a') {
      if (t.name === 'a' && !t.attrs.has('href')) continue;
      if (!accessibleName(html, t)) problems.push(`${where(t)} has no name`);
    }
    if (FIELD.test(t.name)) {
      const type = (t.attrs.get('type') ?? 'text').toLowerCase();
      if (type === 'hidden' || type === 'submit' || type === 'button') continue;
      const named = (t.attrs.get('aria-label') ?? '').trim() || t.attrs.get('aria-labelledby')
        || (t.attrs.get('id') && labelFor.has(t.attrs.get('id')))
        || labels.some((l) => t.index >= l.tag.end && t.index < l.end);
      if (!named) problems.push(`${where(t)} (${type}) has no label`);
    }
    if (t.name === 'img' && !t.attrs.has('alt')) problems.push('an image has no alt text');
    if (t.name === 'svg' && t.attrs.get('aria-hidden') !== 'true' && !t.attrs.has('aria-label')) problems.push('an svg is neither hidden nor named');
    for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
      const v = t.attrs.get(attr);
      if (v) for (const id of v.split(/\s+/)) if (!ids.has(id)) problems.push(`${where(t)} ${attr} points at missing "${id}"`);
    }
    const role = t.attrs.get('role');
    if ((role === 'dialog' || role === 'alertdialog') && !t.attrs.has('aria-label') && !t.attrs.has('aria-labelledby')) {
      problems.push(`a ${role} has no name`);
    }
  }
  return problems;
}

/** Signs that user-supplied text became markup: script/iframe/img tags, on* attributes, javascript: links. */
export function injectionProblems(html) {
  const problems = [];
  for (const t of allTags(html)) {
    if (['script', 'iframe', 'img', 'object', 'embed', 'style'].includes(t.name)) problems.push(`a <${t.name}> tag is on the page`);
    for (const [n, v] of t.attrs) {
      if (n.startsWith('on')) problems.push(`<${t.name}> has an ${n} attribute`);
      if (['href', 'src'].includes(n) && /^\s*javascript:/i.test(v)) problems.push(`<${t.name}> has a javascript: ${n}`);
    }
  }
  return problems;
}
