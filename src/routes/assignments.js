// Assignments: thin HTTP adapters over the assignments service.
import { v, parse } from '../validate.js';

const ok = (json, status = 200) => ({ status, json });
const idSchema = v.string({ pattern: /^\d+$/ });
const assignBody = v.object({ personId: v.integer({ min: 1 }), force: v.boolean().default(false) });

// A numeric path id, or null (the service then answers "not found").
function pathId(raw) {
  try { return Number(parse(idSchema, raw, 'Id')); } catch { return null; }
}

export function register(router, ctx) {
  const assignments = () => ctx.services.assignments;

  router.add('PUT', '/api/slots/:id/assign', async ({ params, body, user }) => {
    const { personId, force } = parse(assignBody, body);
    return ok({ slot: await assignments().assign(user, pathId(params.id), { personId, force }) });
  }, { auth: 'admin' });

  router.add('DELETE', '/api/slots/:id/assign', async ({ params, user }) => (
    ok({ slot: await assignments().unassign(user, pathId(params.id)) })
  ), { auth: 'admin' });

  router.add('GET', '/api/me/schedule', async ({ query, user }) => (
    ok(await assignments().mySchedule(user.id, { from: query.from }))
  ), { auth: 'login' });

  for (const action of ['accept', 'decline']) {
    router.add('POST', `/api/me/slots/:id/${action}`, async ({ params, user }) => (
      ok({ slot: await assignments().respond(user.id, pathId(params.id), action) })
    ), { auth: 'login' });
  }
}
