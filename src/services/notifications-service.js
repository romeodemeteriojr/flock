// Push notifications (decision 0008): the devices people turn them on for, and
// sending to them. Sending is best effort: it never throws, removes devices the
// push service says are gone, and logs only the kind, the push host and the status.
// Built once by src/container.js.
import { ConflictError, NotFoundError, TooManyRequestsError, ValidationError } from '../errors.js';
import { subscriptionProblem } from '../infra/webpush.js';
import { todayStr } from '../dates.js';
import { shortDate } from './gaps-service.js';

/** Devices kept per person; turning on another one forgets the oldest. */
export const MAX_DEVICES = 10;
/** At most one "Send me a test" per person per minute. */
export const TEST_GAP_MS = 60_000;
/** Lock-screen text is cut to this many characters. */
export const MAX_BODY = 500;
const MAX_TTL = 28 * 86400;

/**
 * @param {object} deps  Injected by src/container.js.
 * @param {import("../data/index.js").Data} deps.data
 * @param {{now: () => Date}} deps.clock
 * @param {object} deps.logger
 * @param {{publicUrl?: string}} deps.config
 * @param {{enabled: boolean, publicKey: string|null, send: Function}} deps.push  src/infra/webpush.js
 */
export function createNotificationsService(deps) {
  const { data, clock, logger, config, push } = deps;
  const lastTest = new Map(); // personId -> ms

  const requireOn = () => {
    if (!push.enabled) throw new ConflictError('Notifications are not set up on this Flock yet', { code: 'push_off' });
  };

  /** The declarative message (WebKit Declarative Web Push; the service worker reads the same JSON). */
  function message(body, { path = '/#/', tag } = {}) {
    const text = String(body);
    const notification = {
      title: 'Flock',
      body: text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text,
      lang: 'en-GB',
      dir: 'ltr',
      navigate: `${config.publicUrl ?? ''}${path}`,
    };
    if (tag) notification.tag = tag;
    return { web_push: 8030, notification };
  }

  async function deliver(kind, device, msg, opts) {
    const r = await push.send(device, msg, opts);
    const fields = { kind, host: r.host, status: r.status };
    if (r.ok) logger.info('push sent', fields);
    else logger.warn('push not sent', { ...fields, gone: r.gone || undefined });
    if (r.gone) {
      try { await data.pushDevices.remove(device.endpoint); } catch (err) { logger.error('could not forget a push device', { err }); }
    }
    return r;
  }

  /**
   * Send one message to every device of each person. Never throws.
   * @param {string} kind  for the log only (asked, removed, moved, cancelled, declined, reminder, test)
   * @param {number[]} personIds
   * @param {(personId: number) => object|null} build  the message for a person (null = skip them)
   * @param {{ttl?: number, urgency?: string, topic?: string}} [opts]
   * @returns {Promise<Map<number, boolean>>} personId -> reached at least one device
   */
  async function sendTo(kind, personIds, build, opts) {
    const reached = new Map();
    if (!push.enabled) return reached;
    for (const personId of new Set(personIds)) {
      let ok = false;
      try {
        const msg = await build(personId);
        if (!msg) continue;
        for (const device of await data.pushDevices.listForPerson(personId)) {
          if ((await deliver(kind, device, msg, opts)).ok) ok = true;
        }
      } catch (err) {
        logger.error('push failed', { kind, err: { name: err?.name, message: err?.message } });
      }
      reached.set(personId, ok);
    }
    return reached;
  }

  // ---------- what changed, in words (decision 0008) ----------

  const today = () => todayStr(clock.now());
  const at = (date, time) => `${shortDate(date)} ${String(time).replace(/^0(\d)/, '$1')}`;
  const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || 'Someone';
  const joinAnd = (parts) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);
  // Seconds until the service starts (Flock's clock), between 1 hour and 28 days.
  const ttlUntil = (date, time) => {
    const s = Math.floor((Date.parse(`${date}T${time}:00`) - clock.now().getTime()) / 1000);
    return Math.max(3600, Math.min(MAX_TTL, Number.isFinite(s) ? s : MAX_TTL));
  };
  const holding = (s) => s && s.personId !== null && (s.status === 'pending' || s.status === 'accepted');
  const others = (actor, ids) => ids.filter((id) => id !== actor?.id);

  // Fire and forget: the click that caused it never waits. idle() lets tests wait.
  const inFlight = new Set();
  function later(fn) {
    if (!push.enabled) return;
    const p = Promise.resolve().then(fn).catch((err) => {
      logger.error('push failed', { err: { name: err?.name, message: err?.message } });
    }).finally(() => inFlight.delete(p));
    inFlight.add(p);
  }

  /**
   * The "asked" message: every unanswered ask of the person, the first 3
   * services by name. Asks on the same service share one part: "Sound and
   * Vocals, Sun 8 Nov 10:00" (decision 0010).
   */
  async function askedMessage(personId) {
    const asks = await data.slots.listForPerson(personId, today(), null, ['pending']);
    if (!asks.length) return null;
    const byService = new Map();
    for (const s of asks) byService.set(s.serviceId, [...(byService.get(s.serviceId) ?? []), s]);
    const groups = [...byService.values()];
    const parts = groups.slice(0, 3).map((g) => `${joinAnd(g.map((s) => s.positionName))}, ${at(g[0].serviceDate, g[0].serviceTime)}`);
    const rest = groups.slice(3).reduce((n, g) => n + g.length, 0);
    const more = rest ? ` and ${rest} more` : '';
    const last = asks.at(-1);
    return { msg: message(`Asked to serve: ${parts.join('; ')}${more}. Tap to answer.`, { tag: 'asked' }), ttl: ttlUntil(last.serviceDate, last.serviceTime) };
  }

  // The positions each holder has on a service: Map personId -> [positionName].
  function byHolder(slots) {
    const m = new Map();
    for (const s of slots.filter(holding)) m.set(s.personId, [...(m.get(s.personId) ?? []), s.positionName]);
    return m;
  }

  const events = {
    /** People were asked to serve: one notification each, listing all their unanswered asks. */
    asked(actor, personIds) {
      later(async () => {
        const ttl = new Map();
        const msgs = new Map();
        for (const id of others(actor, personIds)) {
          const a = await askedMessage(id);
          if (a) { msgs.set(id, a.msg); ttl.set(id, a.ttl); }
        }
        for (const [id, msg] of msgs) await sendTo('asked', [id], () => msg, { ttl: ttl.get(id), topic: 'asked' });
      });
    },

    /** Someone was taken off a slot (unassigned, replaced, or the position removed). `slot` is as it was. */
    removed(actor, slot) {
      if (!holding(slot) || slot.serviceDate < today() || slot.personId === actor?.id) return;
      later(() => sendTo('removed', [slot.personId],
        () => message(`You're no longer on ${slot.positionName}, ${at(slot.serviceDate, slot.serviceTime)}.`),
        { ttl: ttlUntil(slot.serviceDate, slot.serviceTime), urgency: 'high' }));
    },

    /** A service's date or time changed. `slots` are its slots. */
    moved(actor, before, after, slots) {
      if (before.date === after.date && before.time === after.time) return;
      if (after.date < today()) return;
      const holders = byHolder(slots);
      later(() => sendTo('moved', others(actor, [...holders.keys()]),
        (id) => message(`${after.title} moved to ${at(after.date, after.time)}. You're still on ${joinAnd(holders.get(id))}.`),
        { ttl: ttlUntil(after.date, after.time), urgency: 'high' }));
    },

    /** A service was deleted. `slots` are the slots it had. */
    cancelled(actor, svc, slots) {
      if (svc.date < today()) return;
      const holders = byHolder(slots);
      later(() => sendTo('cancelled', others(actor, [...holders.keys()]),
        (id) => message(`${svc.title} on ${at(svc.date, svc.time)} is cancelled. You were on ${joinAnd(holders.get(id))}.`),
        { ttl: ttlUntil(svc.date, svc.time), urgency: 'high' }));
    },

    /** A volunteer said no: every active scheduler hears (not the volunteer). */
    declined(slot) {
      later(async () => {
        const schedulers = (await data.people.list())
          .filter((p) => p.role === 'admin' && p.active && p.id !== slot.personId).map((p) => p.id);
        await sendTo('declined', schedulers,
          () => message(`${firstName(slot.personName)} can't do ${slot.positionName}, ${at(slot.serviceDate, slot.serviceTime)}.`, { path: '/#/gaps' }),
          { ttl: 86400 });
      });
    },

    /** Resolves once every notification started so far has been sent (for tests and shutdown). */
    async idle() {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
    },
  };

  return {
    message,
    sendTo,
    ...events,

    /** What the page needs to turn push on: {enabled, publicKey}. */
    settings() {
      return { enabled: push.enabled, publicKey: push.publicKey };
    },

    /** People with at least one device turned on. */
    async peopleWithDevices() {
      return data.pushDevices.personIds();
    },

    /**
     * Turn on (or refresh) this device for the person. `replaces` is the
     * device's previous address after the church changed its keys.
     */
    async turnOn(personId, { endpoint, p256dh, auth, replaces } = {}) {
      requireOn();
      const problem = subscriptionProblem({ endpoint, p256dh, auth });
      if (problem) throw new ValidationError(problem);
      await data.tx(async (d) => {
        await d.pushDevices.save({ personId, endpoint, p256dh, auth, createdAt: clock.now().toISOString() });
        if (typeof replaces === 'string' && replaces !== endpoint) await d.pushDevices.removeOwn(personId, replaces);
        await d.pushDevices.trimForPerson(personId, MAX_DEVICES);
      });
      return { on: true };
    },

    /** Turn off this device (only if it is the person's own). */
    async turnOff(personId, endpoint) {
      if (typeof endpoint === 'string' && endpoint) await data.pushDevices.removeOwn(personId, endpoint);
      return { on: false };
    },

    /** Forget every device of a person (Reset login, deactivate). */
    async forgetPerson(personId) {
      return data.pushDevices.deleteForPerson(personId);
    },

    /** "Send me a test" to this device. */
    async sendTest(personId, endpoint) {
      requireOn();
      const device = typeof endpoint === 'string' ? await data.pushDevices.findByEndpoint(endpoint) : null;
      if (!device || device.personId !== personId) throw new NotFoundError('Notifications are not on for this device');
      const now = clock.now().getTime();
      const last = lastTest.get(personId);
      if (last !== undefined && now - last < TEST_GAP_MS) {
        throw new TooManyRequestsError('Please wait a minute before sending another test', Math.ceil((TEST_GAP_MS - (now - last)) / 1000));
      }
      lastTest.set(personId, now);
      const r = await deliver('test', device, message('Notifications work on this device.', { tag: 'test' }), { ttl: 600, urgency: 'high' });
      if (!r.ok) {
        throw new ConflictError(r.gone
          ? 'This device stopped accepting notifications. Turn them on again.'
          : 'The notification could not be sent. Please try again later.', { code: r.gone ? 'push_gone' : 'push_failed' });
      }
      return { sent: true };
    },
  };
}
