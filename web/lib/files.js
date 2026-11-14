// The files and links of one service (decision 0011), as a small panel any
// view can show: the list (each opens in the phone's own viewer), "Add a file"
// (up to 5 MB), "Add a link" (for anything bigger), and Remove for who added it.
// A file over 5 MB is never sent: the panel says so and offers the link form.
//
//   const files = createFiles({ api, paint, onCount });
//   files.render(serviceId, key)          // key keeps element ids unique
//   files.open(serviceId)                 // load it (once) when shown
//   files.click(el) / files.change(e) / files.submit(form)  -> true when handled
import { html } from './html.js';
import { iconSlot } from './icons.js';
import { formatDate } from './dates.js';

export const MAX_BYTES = 5 * 1024 * 1024;
// A web address: http or https, then the site (spelled so no URL sits in this file).
const WEB_ADDRESS = new RegExp(`^https?:${'/'.repeat(2)}\\S`, 'i');

/** "1.2 MB", "340 KB". */
export function sizeWords(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export const tooBigWords = (name, bytes) => `${name} is ${sizeWords(bytes)}. Files can be at most 5 MB, so add a link to it instead.`;

/** "Files", "Files (2)". */
export const filesLabel = (n) => (n ? `Files (${n})` : 'Files');

function row(f, s, serviceId) {
  const busy = s.busy ? 'disabled' : '';
  const meta = [f.kind === 'file' ? sizeWords(f.size) : 'Link', f.addedByName].filter(Boolean).join(' · ');
  if (s.removeId === f.id) {
    return html`<li class="file-row" data-file="${f.id}"><div class="confirm confirm-danger" role="alertdialog" aria-label="Confirm">
      <p>Remove <strong>${f.name}</strong> for everyone?</p>
      <div class="btn-row">
        <button type="button" class="btn btn-sm btn-danger" data-action="files-remove-yes" data-id="${f.id}" data-service="${serviceId}" ${busy}>Yes, remove</button>
        <button type="button" class="btn btn-sm" data-action="files-remove-no" data-id="${serviceId}" ${busy}>No, keep it</button>
      </div></div></li>`;
  }
  return html`<li class="file-row" data-file="${f.id}">
    <a class="file-open" href="${f.href}" target="_blank" rel="noopener noreferrer">${iconSlot(f.kind === 'file' ? 'file' : 'link', 'file-icon')}<span class="file-text"><span class="file-name">${f.name}</span><span class="hint file-meta">${meta}</span></span></a>
    ${f.canRemove ? html`<button type="button" class="btn btn-sm btn-quiet" data-action="files-remove" data-id="${f.id}" data-service="${serviceId}" ${busy}>${iconSlot('trash')}<span class="visually-hidden">Remove ${f.name}</span></button>` : ''}
  </li>`;
}

function linkForm(s, serviceId, key) {
  const busy = s.busy ? 'disabled' : '';
  return html`<form class="form files-link" data-form="files-link" data-id="${serviceId}" novalidate>
    <div class="field"><label for="files-url-${key}">Web address</label>
      <input id="files-url-${key}" name="url" type="url" inputmode="url" autocomplete="off" placeholder="Paste the link" required value="${s.linkUrl ?? ''}">
      <p class="hint">For example a shared Google Drive, Dropbox or YouTube link.</p></div>
    <div class="field"><label for="files-name-${key}">Name <span class="hint">(optional)</span></label>
      <input id="files-name-${key}" name="title" type="text" maxlength="120" value="${s.linkName ?? ''}"></div>
    <div class="btn-row"><button type="submit" class="btn btn-primary btn-sm" ${busy}>Add link</button>
      <button type="button" class="btn btn-sm" data-action="files-link-cancel" data-id="${serviceId}" ${busy}>Cancel</button></div>
  </form>`;
}

export function createFiles({ api, paint = () => {}, onCount = () => {} }) {
  const by = new Map();
  const state = (id) => {
    if (!by.has(id)) by.set(id, {});
    return by.get(id);
  };
  const fail = (s, err) => { if (err?.status !== 401) s.problem = String(err?.message || 'Something went wrong. Please try again.'); };

  async function load(id) {
    const s = state(id);
    try {
      s.data = await api.get(`/api/services/${id}/files`);
      s.error = null;
      onCount(id, s.data.files.length);
    } catch (err) {
      s.error = String(err?.message || 'Could not load the files.');
    }
    s.loading = false;
  }

  async function work(id, fn) {
    const s = state(id);
    if (s.busy) return;
    s.busy = true;
    s.problem = null;
    s.note = null;
    paint();
    try { await fn(s); } catch (err) { fail(s, err); }
    s.busy = false;
    paint();
  }

  function render(id, key = id) {
    const s = state(id);
    let body;
    if (s.error) {
      body = html`<p class="form-error" role="alert">${s.error}</p>
        <button type="button" class="btn btn-sm" data-action="files-retry" data-id="${id}">Try again</button>`;
    } else if (!s.data) {
      body = html`<p class="hint" role="status">Loading files…</p>`;
    } else if (s.data.expired) {
      body = html`<p class="hint">Files are kept until a week after the service, so these are gone.</p>`;
    } else {
      const list = s.data.files;
      const busy = s.busy ? 'disabled' : '';
      body = html`
        ${list.length ? html`<ul class="list file-list">${list.map((f) => row(f, s, id))}</ul>` : html`<p class="hint">No files yet.</p>`}
        ${s.linking ? linkForm(s, id, key) : html`<div class="btn-row btn-row-compact">
          <label class="btn btn-sm file-pick${s.busy ? ' is-disabled' : ''}">${iconSlot('plus')} Add a file<input type="file" class="visually-hidden" data-files-pick="${id}" ${busy}></label>
          <button type="button" class="btn btn-sm" data-action="files-link" data-id="${id}" ${busy}>${iconSlot('link')} Add a link</button>
        </div>`}
        <p class="hint">Up to 5 MB each; for bigger files add a link. Kept until ${formatDate(s.data.expiresOn)}.</p>`;
    }
    return html`<section class="files" data-files="${id}" aria-label="Files">
      ${s.note ? html`<p class="files-note" role="status">${iconSlot('check', 'icon-sm')} ${s.note}</p>` : ''}
      ${s.problem ? html`<p class="form-error" role="alert">${s.problem}</p>` : ''}
      ${s.busy && !s.problem ? html`<p class="hint" role="status">Working…</p>` : ''}
      ${body}
    </section>`;
  }

  async function upload(id, file) {
    const s = state(id);
    if (file.size > MAX_BYTES) {
      s.problem = tooBigWords(file.name, file.size);
      s.note = null;
      s.linking = true;
      s.linkName = file.name;
      paint();
      return;
    }
    await work(id, async () => {
      await api.upload(`/api/services/${id}/files?name=${encodeURIComponent(file.name)}`, file);
      await load(id);
      s.note = `Added ${file.name}.`;
    });
  }

  const actions = {
    'files-retry': (id) => { state(id).error = null; paint(); return load(id).then(paint); },
    'files-link': (id) => { Object.assign(state(id), { linking: true, problem: null, note: null }); paint(); },
    'files-link-cancel': (id) => { Object.assign(state(id), { linking: false, problem: null, linkUrl: '', linkName: '' }); paint(); },
    'files-remove': (fileId, el) => { const s = state(Number(el.dataset.service)); s.removeId = fileId; s.note = null; paint(); },
    'files-remove-no': (id) => { state(id).removeId = null; paint(); },
    'files-remove-yes': (fileId, el) => {
      const id = Number(el.dataset.service);
      return work(id, async (s) => {
        const f = s.data?.files.find((x) => x.id === fileId);
        await api.del(`/api/attachments/${fileId}`);
        s.removeId = null;
        await load(id);
        s.note = `Removed ${f?.name ?? 'it'}.`;
      });
    },
  };

  return {
    render,
    /** Load the panel the first time it is shown. */
    open(id) {
      const s = state(id);
      if (s.data || s.loading) return Promise.resolve();
      s.loading = true;
      return load(id).then(paint);
    },
    click(el) {
      const fn = actions[el?.dataset?.action];
      if (!fn) return false;
      fn(Number(el.dataset.id), el);
      return true;
    },
    change(e) {
      const input = e.target;
      const id = Number(input?.dataset?.filesPick);
      if (!id) return false;
      const file = input.files?.[0];
      if (file) upload(id, file);
      try { input.value = ''; } catch { /* some browsers refuse; harmless */ }
      return true;
    },
    submit(form) {
      if (form?.dataset?.form !== 'files-link') return false;
      const id = Number(form.dataset.id);
      const url = String(form.elements?.url?.value ?? '').trim();
      const name = String(form.elements?.title?.value ?? '').trim();
      const s = state(id);
      s.linkUrl = url;
      s.linkName = name;
      if (!WEB_ADDRESS.test(url)) {
        s.problem = 'Please paste the whole web address, as you copied it (Share, then Copy link).';
        paint();
        return true;
      }
      work(id, async () => {
        await api.post(`/api/services/${id}/links`, { url, name });
        Object.assign(s, { linking: false, linkUrl: '', linkName: '' });
        await load(id);
        s.note = `Added ${name || 'the link'}.`;
      });
      return true;
    },
    /** For tests: the state of one service's panel. */
    state,
  };
}
