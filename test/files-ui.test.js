// The files panel (web/lib/files.js) and api.upload, with a fake API: no browser, no server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFiles, sizeWords, tooBigWords, filesLabel, MAX_BYTES } from '../web/lib/files.js';
import { createApi } from '../web/api.js';

const LIST = {
  serviceId: 7, expiresOn: '2025-01-19', expired: false, maxBytes: MAX_BYTES,
  files: [
    { id: 1, kind: 'file', name: 'Setlist <b>.pdf', mime: 'application/pdf', size: 1258291, href: '/api/attachments/1', addedByName: 'Max Member', canRemove: true },
    { id: 2, kind: 'link', name: 'Video', mime: null, size: 0, href: 'https://video.example/v', addedByName: 'Ada Admin', canRemove: false },
  ],
};

function fakeApi(list = LIST) {
  const calls = [];
  return {
    calls,
    get: async (path) => { calls.push(['GET', path]); return structuredClone(list); },
    post: async (path, body) => { calls.push(['POST', path, body]); return {}; },
    del: async (path) => { calls.push(['DELETE', path]); return {}; },
    upload: async (path, file) => { calls.push(['UPLOAD', path, file.name]); return {}; },
  };
}

const el = (action, id, extra = {}) => ({ dataset: { action, id: String(id), ...extra } });
const settle = () => new Promise((r) => setTimeout(r, 0));

test('files panel: lists files and links that open in a new view, names escaped, remove only when allowed', async () => {
  const api = fakeApi();
  const counts = [];
  const files = createFiles({ api, onCount: (id, n) => counts.push([id, n]) });
  assert.match(String(files.render(7)), /Loading files/);
  await files.open(7);
  await files.open(7); // only loads once
  assert.deepEqual(api.calls, [['GET', '/api/services/7/files']]);
  assert.deepEqual(counts, [[7, 2]]);
  const out = String(files.render(7, 'k'));
  assert.match(out, /href="\/api\/attachments\/1" target="_blank" rel="noopener noreferrer"/);
  assert.match(out, /href="https:\/\/video.example\/v" target="_blank"/);
  assert.ok(out.includes('Setlist &lt;b&gt;.pdf'));
  assert.ok(!out.includes('<b>'));
  assert.match(out, /1\.2 MB · Max Member/);
  assert.equal((out.match(/data-action="files-remove"/g) ?? []).length, 1, 'only the file this person may remove');
  assert.match(out, /Kept until/);
  assert.match(out, /type="file"/);
});

test('files panel: a file over 5 MB is never sent; the link form opens with its name', async () => {
  const api = fakeApi();
  const files = createFiles({ api });
  await files.open(7);
  const input = { dataset: { filesPick: '7' }, files: [{ name: 'Rehearsal.mov', size: MAX_BYTES + 1, type: 'video/quicktime' }], value: 'x' };
  assert.equal(files.change({ target: input }), true);
  await settle();
  assert.ok(!api.calls.some((c) => c[0] === 'UPLOAD'));
  assert.equal(input.value, '', 'the same file can be picked again');
  const out = String(files.render(7));
  assert.match(out, /Rehearsal\.mov is 5 MB\. Files can be at most 5 MB, so add a link to it instead\./);
  assert.match(out, /data-form="files-link"/);
  assert.match(out, /value="Rehearsal\.mov"/);
});

test('files panel: a small file is uploaded with its name, then the list reloads', async () => {
  const api = fakeApi();
  const files = createFiles({ api });
  await files.open(7);
  files.change({ target: { dataset: { filesPick: '7' }, files: [{ name: 'Run sheet & notes.pdf', size: 2000, type: 'application/pdf' }] } });
  await settle(); await settle();
  assert.deepEqual(api.calls.find((c) => c[0] === 'UPLOAD'), ['UPLOAD', '/api/services/7/files?name=Run%20sheet%20%26%20notes.pdf', 'Run sheet & notes.pdf']);
  assert.equal(api.calls.filter((c) => c[0] === 'GET').length, 2);
  assert.match(String(files.render(7)), /Added Run sheet &amp; notes\.pdf\./);
});

test('files panel: add a link; a bad address is caught before sending', async () => {
  const api = fakeApi();
  const files = createFiles({ api });
  await files.open(7);
  files.click(el('files-link', 7));
  const form = (url, title = '') => ({ dataset: { form: 'files-link', id: '7' }, elements: { url: { value: url }, title: { value: title } } });
  assert.equal(files.submit(form('drive.example/x')), true);
  assert.ok(!api.calls.some((c) => c[0] === 'POST'));
  assert.match(String(files.render(7)), /whole web address/);
  files.submit(form(' https://drive.example/x ', 'Big video'));
  await settle(); await settle();
  assert.deepEqual(api.calls.find((c) => c[0] === 'POST'), ['POST', '/api/services/7/links', { url: 'https://drive.example/x', name: 'Big video' }]);
  assert.doesNotMatch(String(files.render(7)), /data-form="files-link"/, 'the form closes once added');
});

test('files panel: remove asks first', async () => {
  const api = fakeApi();
  const files = createFiles({ api });
  await files.open(7);
  files.click(el('files-remove', 1, { service: '7' }));
  assert.match(String(files.render(7)), /Remove <strong>Setlist &lt;b&gt;\.pdf<\/strong> for everyone\?/);
  files.click(el('files-remove-no', 7));
  assert.doesNotMatch(String(files.render(7)), /for everyone/);
  files.click(el('files-remove', 1, { service: '7' }));
  files.click(el('files-remove-yes', 1, { service: '7' }));
  await settle(); await settle();
  assert.ok(api.calls.some((c) => c[0] === 'DELETE' && c[1] === '/api/attachments/1'));
  assert.equal(files.click(el('not-mine', 1)), false);
});

test('files panel: expired services say so and offer nothing to add', async () => {
  const files = createFiles({ api: fakeApi({ ...LIST, expired: true, files: [] }) });
  await files.open(7);
  const out = String(files.render(7));
  assert.match(out, /these are gone/);
  assert.doesNotMatch(out, /type="file"|files-link/);
});

test('files words', () => {
  assert.equal(sizeWords(500), '1 KB');
  assert.equal(sizeWords(340 * 1024), '340 KB');
  assert.equal(sizeWords(7.34 * 1024 * 1024), '7.3 MB');
  assert.equal(tooBigWords('a.mov', 6 * 1024 * 1024), 'a.mov is 6 MB. Files can be at most 5 MB, so add a link to it instead.');
  assert.equal(filesLabel(0), 'Files');
  assert.equal(filesLabel(3), 'Files (3)');
});

test('api.upload sends the file itself with its type and the X-Flock header', async () => {
  const seen = [];
  const api = createApi(async (url, init) => { seen.push([url, init]); return { ok: true, status: 201, text: async () => '{"id":1}' }; });
  const file = { name: 'a.pdf', type: 'application/pdf', size: 3 };
  assert.deepEqual(await api.upload('/api/services/1/files?name=a.pdf', file), { id: 1 });
  const [url, init] = seen[0];
  assert.equal(url, '/api/services/1/files?name=a.pdf');
  assert.equal(init.method, 'POST');
  assert.equal(init.body, file);
  assert.equal(init.headers['Content-Type'], 'application/pdf');
  assert.equal(init.headers['X-Flock'], '1');
  await api.upload('/x', { name: 'b', type: '' });
  assert.equal(seen[1][1].headers['Content-Type'], 'application/octet-stream');
});
