// Service dates and their slots: thin HTTP adapters over the calendar service.
import { v, parse } from '../validate.js';
import { ConflictError } from '../errors.js';

const ok = (json, status = 200) => ({ status, json });
const idSchema = v.string({ pattern: /^\d+$/ });

// A numeric path id, or null (the service then answers "not found", as before).
function pathId(raw) {
  try { return Number(parse(idSchema, raw, 'Id')); } catch { return null; }
}
const objectOr = (body) => (body && typeof body === 'object' ? body : {});
const confirmed = (query) => query.confirm === '1';

export function register(router, ctx) {
  const calendar = () => ctx.services.calendar;

  router.add('POST', '/api/services', async ({ body, user }) => {
    const b = objectOr(body);
    const svc = await calendar().createService(user, { date: b.date, time: b.time, title: b.title, slots: b.slots });
    return ok(svc, 201);
  }, { auth: 'admin' });

  router.add('POST', '/api/services/repeat', async ({ body, user }) => {
    const b = objectOr(body);
    return ok(await calendar().repeat(user, { fromServiceId: b.fromServiceId, weeks: b.weeks }), 201);
  }, { auth: 'admin' });

  router.add('GET', '/api/services', async ({ query }) => ok(await calendar().listServices(query.from, query.to)), { auth: 'admin' });

  router.add('PATCH', '/api/services/:id', async ({ params, query, body, user }) => {
    const b = objectOr(body);
    try {
      return ok(await calendar().updateService(user, pathId(params.id),
        { date: b.date, time: b.time, title: b.title, slots: b.slots }, { confirm: confirmed(query) }));
    } catch (e) {
      if (e instanceof ConflictError && e.code === 'has_people') {
        return { status: 409, json: { error: e.message, code: 'has_people', count: e.details.count, people: e.details.people } };
      }
      throw e;
    }
  }, { auth: 'admin' });

  router.add('DELETE', '/api/services/:id', async ({ params, query, user }) => {
    try {
      return ok(await calendar().deleteService(user, pathId(params.id), { confirm: confirmed(query) }));
    } catch (e) {
      if (e instanceof ConflictError && e.code === 'has_people') {
        return { status: 409, json: { error: e.message, code: 'has_people', count: e.details.count } };
      }
      throw e;
    }
  }, { auth: 'admin' });

  router.add('POST', '/api/services/:id/slots', async ({ params, body, user }) => {
    const b = objectOr(body);
    return ok(await calendar().addSlots(user, pathId(params.id), { positionId: b.positionId, count: b.count }), 201);
  }, { auth: 'admin' });

  router.add('DELETE', '/api/slots/:id', async ({ params, query, user }) => (
    ok(await calendar().removeSlot(user, pathId(params.id), { confirm: confirmed(query) }))
  ), { auth: 'admin' });
}
