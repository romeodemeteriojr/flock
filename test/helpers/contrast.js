// WCAG 2.x contrast maths, and a tiny reader for the colour tokens in
// web/style.css (light :root, plus the dark :root inside
// @media (prefers-color-scheme: dark)). No dependencies, no files read here.

/** '#abc' or '#aabbcc' -> [r, g, b] (0-255). Throws on anything else. */
export function hexToRgb(hex) {
  let h = String(hex).trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`not a hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** WCAG relative luminance of a hex colour (0 = black, 1 = white). */
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours (1 to 21). */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// Body of the first `{ ... }` block that starts at or after `from` (balanced braces).
function blockAt(css, from) {
  const open = css.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (depth === 0) return { body: css.slice(open + 1, i), end: i + 1 }; }
  }
  return null;
}

function vars(body) {
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Read the palettes: { light, dark } maps of custom property -> value.
 * light = the first top-level `:root { }`; dark = light overridden by the
 * `:root { }` inside `@media (prefers-color-scheme: dark)`.
 */
export function palettes(rawCss) {
  const css = stripComments(rawCss);
  const rootAt = css.search(/(^|\})\s*:root\s*\{/);
  if (rootAt < 0) throw new Error('no :root block');
  const light = vars(blockAt(css, rootAt).body);
  const mediaAt = css.search(/@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)/);
  if (mediaAt < 0) throw new Error('no dark theme');
  const media = blockAt(css, mediaAt).body;
  const innerAt = media.search(/:root\s*\{/);
  const dark = { ...light, ...(innerAt >= 0 ? vars(blockAt(media, innerAt).body) : {}) };
  return { light, dark };
}

/** Follow var(--x) references until a plain value. */
export function resolveToken(palette, name) {
  let v = palette[name];
  for (let i = 0; i < 10 && typeof v === 'string'; i++) {
    const m = /^var\((--[\w-]+)\)$/.exec(v);
    if (!m) return v;
    v = palette[m[1]];
  }
  return v;
}
