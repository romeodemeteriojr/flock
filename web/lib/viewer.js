// Flock's file viewer (decision 0011): a full-screen layer over the page with
// a big Close (X) button, so a file opened in the installed app never leaves
// you stuck without a way back. It shows the types a phone can show itself:
// PDF and plain text in a frame, photos, audio and video. Anything else keeps
// opening in the phone's own viewer (the server sends it as a download).
//
// A file link opts in with data-view (web/lib/files.js); watchViewer(doc, win)
// opens those links here instead. Escape, the phone's Back and the X close it,
// and focus goes back to the link. Built with DOM calls, not view HTML.
import { icon } from './icons.js';
import { backStep } from './sheet.js';

const FRAME = new Set(['application/pdf', 'text/plain']);
const IMAGE = /^image\/(png|jpeg|gif|webp|heic|heif)$/;
const AUDIO = /^audio\//;
const VIDEO = /^video\//;

/** How the viewer shows a type: 'frame', 'image', 'audio', 'video', or null (the phone opens it). */
export function viewKind(mime) {
  const m = String(mime ?? '').toLowerCase();
  if (FRAME.has(m)) return 'frame';
  if (IMAGE.test(m)) return 'image';
  if (AUDIO.test(m)) return 'audio';
  if (VIDEO.test(m)) return 'video';
  return null;
}

const FOCUSABLE = 'button, [href], audio[controls], video[controls], iframe';

function media(doc, kind, href, name) {
  if (kind === 'image') {
    const el = doc.createElement('img');
    el.className = 'viewer-image';
    el.alt = name;
    el.src = href;
    return el;
  }
  if (kind === 'audio' || kind === 'video') {
    const el = doc.createElement(kind);
    el.className = `viewer-${kind}`;
    el.controls = true;
    el.setAttribute('playsinline', '');
    el.preload = 'metadata';
    el.src = href;
    return el;
  }
  const el = doc.createElement('iframe');
  el.className = 'viewer-frame';
  el.title = name;
  el.src = href;
  return el;
}

/**
 * Builds the viewer. open({ href, name, kind }, opener) shows it; close() hides it.
 * Returns null without a DOM (the test fakes).
 */
export function createViewer(doc, win = doc?.defaultView) {
  if (typeof doc?.createElement !== 'function' || !doc.body) return null;
  let layer = null;
  let opener = null;
  const isOpen = () => !!layer;
  const back = backStep(win, doc, isOpen, () => close());

  function close() {
    if (!layer) return;
    layer.remove();
    layer = null;
    doc.documentElement?.classList?.remove('viewer-open');
    back.closed();
    if (typeof opener?.focus === 'function' && opener.isConnected !== false) opener.focus();
    opener = null;
  }

  function trap(e) {
    if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const items = [...layer.querySelectorAll(FOCUSABLE)];
    const first = items[0];
    const last = items[items.length - 1];
    const inside = layer.contains(doc.activeElement);
    if (e.shiftKey && (doc.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (doc.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
  }

  function open({ href, name, kind }, from = null) {
    if (layer) close();
    opener = from;
    layer = doc.createElement('div');
    layer.className = 'viewer';
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-labelledby', 'viewer-title');

    const bar = doc.createElement('div');
    bar.className = 'viewer-bar';
    const x = doc.createElement('button');
    x.type = 'button';
    x.className = 'icon-btn viewer-close';
    x.setAttribute('aria-label', 'Close');
    x.title = 'Close';
    x.innerHTML = icon('x');
    x.addEventListener('click', close);
    const title = doc.createElement('h2');
    title.id = 'viewer-title';
    title.className = 'viewer-title';
    title.textContent = name;
    const save = doc.createElement('a');
    save.className = 'icon-btn viewer-save';
    save.href = href;
    save.setAttribute('download', name);
    save.setAttribute('aria-label', `Download ${name}`);
    save.title = 'Download';
    save.innerHTML = icon('install');
    bar.append(x, title, save);

    const body = doc.createElement('div');
    body.className = `viewer-body viewer-body-${kind}`;
    body.append(media(doc, kind, href, name));

    layer.append(bar, body);
    layer.addEventListener('keydown', trap);
    doc.body.append(layer);
    doc.documentElement?.classList?.add('viewer-open');
    back.opened();
    x.focus();
  }

  return { open, close, isOpen };
}

/** Opens every link marked data-view in the viewer instead of leaving the app. */
export function watchViewer(doc, win = doc?.defaultView) {
  const viewer = createViewer(doc, win);
  if (!viewer) return null;
  doc.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target?.closest?.('a[data-view]');
    const kind = a?.dataset.view;
    if (!kind) return;
    e.preventDefault();
    viewer.open({ href: a.getAttribute('href'), name: a.dataset.name || a.textContent.trim(), kind }, a);
  });
  // A new page closes it, so it never stays over a page it does not belong to.
  win?.addEventListener?.('hashchange', () => viewer.close());
  return viewer;
}
