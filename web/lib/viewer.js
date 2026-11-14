// Flock's file viewer (decision 0011): a full-screen layer over the page with
// a big Close (X) button, so a file opened in the installed app never leaves
// you stuck without a way back. It shows the types a phone can show itself:
// PDF (every page, drawn by PDF.js), plain text in a frame, photos, audio and
// video. Anything else keeps opening in the phone's own viewer (the server
// sends it as a download).
//
// Why PDF.js: an iPhone draws only the first page of a PDF in a frame. PDF.js
// (web/vendor/pdfjs, Apache-2.0, licenses/) is loaded only when a PDF opens,
// and is not part of the app saved on the phone (src/static.js).
//
// A file link opts in with data-view (web/lib/files.js); watchViewer(doc, win)
// opens those links here instead. Escape, the phone's Back and the X close it,
// and focus goes back to the link. Built with DOM calls, not view HTML.
import { icon } from './icons.js';
import { backStep } from './sheet.js';

const FRAME = new Set(['text/plain']);
const IMAGE = /^image\/(png|jpeg|gif|webp|heic|heif)$/;
const AUDIO = /^audio\//;
const VIDEO = /^video\//;

/** How the viewer shows a type: 'pdf', 'frame', 'image', 'audio', 'video', or null (the phone opens it). */
export function viewKind(mime) {
  const m = String(mime ?? '').toLowerCase();
  if (m === 'application/pdf') return 'pdf';
  if (FRAME.has(m)) return 'frame';
  if (IMAGE.test(m)) return 'image';
  if (AUDIO.test(m)) return 'audio';
  if (VIDEO.test(m)) return 'video';
  return null;
}

const FOCUSABLE = 'button, [href], audio[controls], video[controls], iframe';
const PDFJS = '../vendor/pdfjs/pdf.min.js';
const PDF_WORKER = '/vendor/pdfjs/pdf.worker.min.js';
const MAX_PIXEL_RATIO = 3;

function note(doc, text, cls = 'hint') {
  const p = doc.createElement('p');
  p.className = `viewer-note ${cls}`;
  p.setAttribute('role', cls === 'form-error' ? 'alert' : 'status');
  p.textContent = text;
  return p;
}

/**
 * Draws every page of the PDF at href into box, one canvas each, as wide as
 * the screen. A page is drawn when it comes near the screen, so a long file
 * opens fast. live() is false once the viewer closed: then it stops.
 * Returns a function that frees the file.
 */
async function showPdf(doc, win, box, href, live) {
  const wait = note(doc, 'Opening…');
  box.append(wait);
  let pdf = null;
  try {
    const pdfjs = await import(PDFJS);
    pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER;
    pdf = await pdfjs.getDocument({ url: href, isEvalSupported: false }).promise;
  } catch {
    wait.remove();
    if (live()) box.append(note(doc, "Couldn't show this file. Use the download button to open it on your phone.", 'form-error'));
    return () => {};
  }
  if (!live()) { pdf.destroy(); return () => {}; }
  wait.remove();
  const ratio = Math.min(win?.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  const width = Math.max(200, box.clientWidth - 16);
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    if (!live()) break;
    const base = page.getViewport({ scale: 1 });
    const css = page.getViewport({ scale: width / base.width });
    const wrap = doc.createElement('div');
    wrap.className = 'viewer-page';
    wrap.style.aspectRatio = `${css.width} / ${css.height}`;
    wrap.setAttribute('aria-label', `Page ${n} of ${pdf.numPages}`);
    wrap.setAttribute('role', 'img');
    box.append(wrap);
    pages.push({ page, wrap, css, drawn: false });
  }
  const draw = (p) => {
    if (p.drawn || !live()) return;
    p.drawn = true;
    const view = p.page.getViewport({ scale: p.css.scale * ratio });
    const canvas = doc.createElement('canvas');
    canvas.width = Math.floor(view.width);
    canvas.height = Math.floor(view.height);
    p.wrap.append(canvas);
    p.page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: view }).promise.catch(() => {});
  };
  if (typeof win?.IntersectionObserver === 'function') {
    const seen = new win.IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) draw(pages.find((p) => p.wrap === e.target));
    }, { root: box, rootMargin: '100% 0px' });
    for (const p of pages) seen.observe(p.wrap);
    return () => { seen.disconnect(); pdf.destroy(); };
  }
  pages.forEach(draw);
  return () => pdf.destroy();
}

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
  let free = null; // frees an open PDF
  const isOpen = () => !!layer;
  const back = backStep(win, doc, isOpen, () => close());

  function close() {
    if (!layer) return;
    layer.remove();
    layer = null;
    free?.();
    free = null;
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
    if (kind !== 'pdf') body.append(media(doc, kind, href, name));

    layer.append(bar, body);
    layer.addEventListener('keydown', trap);
    doc.body.append(layer);
    doc.documentElement?.classList?.add('viewer-open');
    back.opened();
    x.focus();
    if (kind === 'pdf') {
      const mine = layer;
      showPdf(doc, win, body, href, () => layer === mine).then((f) => {
        if (layer === mine) free = f; else f();
      });
    }
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
