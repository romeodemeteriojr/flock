// Files and links on a service (decision 0011): thin HTTP adapters over the
// attachments service. A file is uploaded as the raw request body (its name in
// ?name=, its type worked out from the name) and opened at /api/attachments/:id, which
// the phone shows in its own viewer.
import { v, parse } from '../validate.js';
import { MAX_FILE_BYTES } from '../services/attachments-service.js';

const ok = (json, status = 200) => ({ status, json });
const idSchema = v.string({ pattern: /^\d+$/ });
const linkBody = v.object({
  name: v.string({ max: 200 }).optional(),
  url: v.string({ min: 1, max: 4000 }).label('Web address'),
});

// A numeric path id, or null (the service then answers "not found").
function pathId(raw) {
  try { return Number(parse(idSchema, raw, 'Id')); } catch { return null; }
}

// Types the phone can show itself. Anything else is downloaded, and types a
// browser would run as a page are never sent as themselves.
const INLINE = new Set([
  'application/pdf', 'text/plain',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav',
  'video/mp4', 'video/quicktime',
]);
const ACTIVE = /html|xml|svg|javascript|ecmascript|x-shockwave/;

export function downloadHeaders(a, length) {
  const inline = INLINE.has(a.mime);
  const type = !a.mime || ACTIVE.test(a.mime) ? 'application/octet-stream' : a.mime;
  const ascii = a.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return {
    'Content-Type': type === 'text/plain' ? 'text/plain; charset=utf-8' : type,
    'Content-Length': length,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.name)}`,
    'Cache-Control': 'private, no-store',
    // A PDF viewer will not run in a sandbox; a PDF cannot script this site anyway.
    'Content-Security-Policy': a.mime === 'application/pdf'
      ? "frame-ancestors 'none'"
      : "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  };
}

export function register(router, ctx) {
  const files = () => ctx.services.attachments;

  router.add('GET', '/api/services/:id/files', async ({ params, user }) => (
    ok(await files().list(user, pathId(params.id)))
  ));

  // The type comes from the name (the phone's Content-Type is not trusted).
  router.add('POST', '/api/services/:id/files', async ({ params, query, body, user }) => (
    ok(await files().addFile(user, pathId(params.id), { name: query.name, bytes: body }), 201)
  ), { raw: MAX_FILE_BYTES, tooBig: 'Files can be at most 5 MB. For a bigger file, add a link to it instead.' });

  router.add('POST', '/api/services/:id/links', async ({ params, body, user }) => (
    ok(await files().addLink(user, pathId(params.id), parse(linkBody, body)), 201)
  ));

  router.add('GET', '/api/attachments/:id', async ({ params, res, user }) => {
    const { attachment, content } = await files().open(user, pathId(params.id));
    res.writeHead(200, downloadHeaders(attachment, content.length));
    res.end(content);
  });

  router.add('DELETE', '/api/attachments/:id', async ({ params, user }) => (
    ok(await files().remove(user, pathId(params.id)))
  ));

  router.add('POST', '/api/admin/files/purge', async ({ user }) => (
    ok(await files().purge(user))
  ), { auth: 'admin' });
}
