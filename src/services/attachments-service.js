// Files and links on a service (decision 0011).
// Anyone signed in may add one; only the people serving at that service (asked
// or confirmed) and schedulers can see them. A file is at most 5 MB; anything
// bigger is shared as a link. Only a short list of file types is kept, and
// each person (not schedulers) has an hourly limit and a total. Both expire 7 days after the service date: from
// then on nobody can open them, and a scheduler's clean-up (a button, or
// `flock purge-files`) deletes them. Nothing deletes them on a timer.
import { ValidationError, NotFoundError, ForbiddenError, ConflictError, TooManyRequestsError } from '../errors.js';
import { addDays, todayStr } from '../dates.js';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const KEEP_DAYS = 7;
export const MAX_PER_SERVICE = 20;
export const MAX_NAME = 120;
export const MAX_URL = 2000;
// Per person (schedulers are exempt: they upload for every week).
export const MAX_ADDS_PER_HOUR = 30;
export const MAX_LIVE_BYTES = 50 * 1024 * 1024;

const HOLDING = new Set(['pending', 'accepted']);
const ADD_ACTIONS = ['attachment.add_file', 'attachment.add_link'];
const OOXML = 'application/vnd.openxmlformats-officedocument';
const ODF = 'application/vnd.oasis.opendocument';

/**
 * The only files Flock keeps, by extension, and the type each is sent as.
 * The type the phone sends is ignored. Apps and installers (apk, ipa, exe),
 * iPhone profiles (mobileconfig), pages (html, svg), scripts, archives and
 * office files that can carry macros (doc, docm, xls, ...) are not on it.
 */
export const FILE_TYPES = Object.freeze({
  pdf: 'application/pdf',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  txt: 'text/plain', md: 'text/plain', cho: 'text/plain', chopro: 'text/plain', chordpro: 'text/plain',
  csv: 'text/csv',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
  docx: `${OOXML}.wordprocessingml.document`,
  xlsx: `${OOXML}.spreadsheetml.sheet`,
  pptx: `${OOXML}.presentationml.presentation`,
  odt: `${ODF}.text`, ods: `${ODF}.spreadsheet`, odp: `${ODF}.presentation`,
});

/** The type to keep a file as, from its name; null when it is not allowed. */
export function typeFor(name) {
  const m = /\.([a-z0-9]{1,10})$/i.exec(String(name ?? ''));
  return (m && Object.hasOwn(FILE_TYPES, m[1].toLowerCase())) ? FILE_TYPES[m[1].toLowerCase()] : null;
}

const ALLOWED_WORDS = 'PDF, photos, text, chord charts, audio, video, and Word, Excel or PowerPoint files';

/** The last day a service's files can be opened. */
export const expiresOn = (serviceDate) => addDays(serviceDate, KEEP_DAYS);

/** A file name that is safe to show and to send back in a header. */
export function cleanName(raw) {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    // Direction controls can make "x\u202Efdp.exe" show as "xexe.pdf".
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= MAX_NAME) return s;
  // Keep the extension, so the phone still knows what opens it.
  const dot = s.lastIndexOf('.');
  const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : '';
  return `${s.slice(0, MAX_NAME - ext.length - 1).trimEnd()}…${ext}`;
}

/** An http(s) address, or null. */
export function cleanUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s.length > MAX_URL) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  return u.href;
}

const sizeWords = (bytes) => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

/**
 * @param {object} deps  Injected by src/container.js.
 * @param {import("../data/index.js").Data} deps.data
 * @param {{now: () => Date}} deps.clock
 */
export function createAttachmentsService(deps) {
  const { data, clock } = deps;
  const today = () => todayStr(clock.now());
  const isExpired = (serviceDate) => today() > expiresOn(serviceDate);
  const isAdmin = (user) => user?.role === 'admin';

  async function serving(d, user, serviceId) {
    return (await d.slots.listForService(serviceId))
      .some((s) => s.personId === user.id && HOLDING.has(s.status));
  }

  async function canSee(d, user, serviceId) {
    return isAdmin(user) || serving(d, user, serviceId);
  }

  const view = (a, user) => ({
    id: a.id,
    kind: a.kind,
    name: a.name,
    mime: a.mime,
    size: a.size,
    href: a.kind === 'file' ? `/api/attachments/${a.id}` : a.url,
    addedByName: a.addedByName,
    createdAt: a.createdAt,
    canRemove: isAdmin(user) || (a.addedBy !== null && a.addedBy === user.id),
  });

  async function serviceOr404(d, serviceId) {
    const svc = Number.isSafeInteger(serviceId) ? await d.services.findById(serviceId) : null;
    if (!svc) throw new NotFoundError('That service does not exist');
    return svc;
  }

  async function checkRoom(d, svc) {
    if (isExpired(svc.date)) {
      throw new ConflictError('This service was more than a week ago, so files can no longer be added', { code: 'expired' });
    }
    if ((await d.attachments.countForService(svc.id)) >= MAX_PER_SERVICE) {
      throw new ConflictError(`A service can have at most ${MAX_PER_SERVICE} files and links. Remove one first.`, { code: 'too_many' });
    }
  }

  // Per person, so one account cannot fill the disk or flood the server.
  // Counted from the audit log, so removing a file does not give the try back.
  async function checkPerson(d, user, size) {
    if (isAdmin(user)) return;
    const since = new Date(clock.now().getTime() - 60 * 60 * 1000);
    const recent = await d.audit.countSince({ actorId: user.id, actions: ADD_ACTIONS, since });
    if (recent >= MAX_ADDS_PER_HOUR) {
      throw new TooManyRequestsError(`You can add at most ${MAX_ADDS_PER_HOUR} files and links an hour. Please try again later.`, 60 * 60, { code: 'too_many_adds' });
    }
    if (!size) return;
    const live = await d.attachments.bytesAddedBy(user.id, addDays(today(), -KEEP_DAYS));
    if (live + size > MAX_LIVE_BYTES) {
      throw new ConflictError(`Your files on upcoming services already take ${sizeWords(live)}, and each person can have at most ${sizeWords(MAX_LIVE_BYTES)}. Remove one, or add a link instead.`, { code: 'quota' });
    }
  }

  async function added(d, user, a, svc) {
    await d.audit.log({ at: clock.now(), actorId: user.id, action: `attachment.add_${a.kind}`, detail: `service ${svc.id}: ${a.name}` });
    return view(a, user);
  }

  return {
    /** The service's files and links, for someone serving there (or a scheduler). */
    async list(user, serviceId) {
      return data.tx(async (d) => {
        const svc = await serviceOr404(d, serviceId);
        if (!(await canSee(d, user, svc.id))) throw new ForbiddenError('Only the people serving at this service can see its files');
        const expired = isExpired(svc.date);
        const files = expired ? [] : (await d.attachments.listForService(svc.id)).map((a) => view(a, user));
        return { serviceId: svc.id, expiresOn: expiresOn(svc.date), expired, maxBytes: MAX_FILE_BYTES, types: Object.keys(FILE_TYPES), files };
      });
    },

    /** bytes: a Buffer of the whole file. */
    async addFile(user, serviceId, { name, bytes }) {
      const clean = cleanName(name);
      if (!clean) throw new ValidationError('The file needs a name');
      const mime = typeFor(clean);
      if (!mime) {
        throw new ValidationError(`Flock keeps ${ALLOWED_WORDS}. For anything else, add a link to it instead.`, { code: 'file_type' });
      }
      if (!bytes?.length) throw new ValidationError('That file is empty');
      if (bytes.length > MAX_FILE_BYTES) {
        throw new ValidationError(`That file is ${sizeWords(bytes.length)}. Files can be at most 5 MB, so add a link to it instead.`, { code: 'too_big' });
      }
      return data.tx(async (d) => {
        const svc = await serviceOr404(d, serviceId);
        await checkRoom(d, svc);
        await checkPerson(d, user, bytes.length);
        const a = await d.attachments.create({
          serviceId: svc.id, kind: 'file', name: clean, mime, content: bytes,
          addedBy: user.id, createdAt: clock.now().toISOString(),
        });
        return added(d, user, a, svc);
      });
    },

    async addLink(user, serviceId, { name, url }) {
      const href = cleanUrl(url);
      if (!href) throw new ValidationError('Please paste a full web address that starts with https://');
      const clean = cleanName(name) || cleanName(new URL(href).hostname);
      return data.tx(async (d) => {
        const svc = await serviceOr404(d, serviceId);
        await checkRoom(d, svc);
        await checkPerson(d, user, 0);
        const a = await d.attachments.create({
          serviceId: svc.id, kind: 'link', name: clean, url: href,
          addedBy: user.id, createdAt: clock.now().toISOString(),
        });
        return added(d, user, a, svc);
      });
    },

    /** A file to send: { attachment, content }. Expired files are gone for everyone. */
    async open(user, attachmentId) {
      return data.tx(async (d) => {
        const a = Number.isSafeInteger(attachmentId) ? await d.attachments.findById(attachmentId) : null;
        if (!a || a.kind !== 'file' || !(await canSee(d, user, a.serviceId))) throw new NotFoundError('That file does not exist');
        if (isExpired(a.serviceDate)) throw new NotFoundError('That file has expired');
        return { attachment: a, content: await d.attachments.content(a.id) };
      });
    },

    /** The person who added it, or a scheduler. */
    async remove(user, attachmentId) {
      return data.tx(async (d) => {
        const a = Number.isSafeInteger(attachmentId) ? await d.attachments.findById(attachmentId) : null;
        if (!a) throw new NotFoundError('That file does not exist');
        if (!isAdmin(user) && a.addedBy !== user.id) throw new ForbiddenError('Only the person who added it, or a scheduler, can remove it');
        await d.attachments.remove(a.id);
        await d.audit.log({ at: clock.now(), actorId: user.id, action: 'attachment.remove', detail: `service ${a.serviceId}: ${a.name}` });
        return { removed: a.id };
      });
    },

    /**
     * Deletes every file and link whose service was more than a week ago and
     * gives the space back to the disk. actor is null from the command line.
     */
    async purge(actor) {
      const lastDate = addDays(today(), -(KEEP_DAYS + 1));
      const result = await data.tx(async (d) => {
        const r = await d.attachments.removeForServicesUpTo(lastDate);
        if (r.removed) {
          await d.audit.log({ at: clock.now(), actorId: actor?.id ?? null, action: 'attachment.purge', detail: `${r.removed} removed, ${r.bytes} bytes` });
        }
        return r;
      });
      if (result.removed) await data.maintenance.compact();
      return result;
    },
  };
}
