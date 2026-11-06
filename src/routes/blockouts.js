// Blockouts: thin HTTP adapters over the blockouts service.
import { v, parse } from '../validate.js';

const ok = (json, status = 200) => ({ status, json });
const idSchema = v.string({ pattern: /^\d+$/ });

// A numeric path id, or null (the service then answers "not found", as before).
function pathId(raw) {
  try { return Number(parse(idSchema, raw, 'Id')); } catch { return null; }
}

export function register(router, ctx) {
  const blockouts = () => ctx.services.blockouts;

  router.add('GET', '/api/me/blockouts', async ({ user }) => (
    ok({ blockouts: await blockouts().listMine(user.id) })
  ), { auth: 'login' });

  router.add('POST', '/api/me/blockouts', async ({ user, body }) => {
    const b = body && typeof body === 'object' ? body : {};
    const r = await blockouts().add(user.id, { startDate: b.startDate, endDate: b.endDate, reason: b.reason });
    return ok(r, 201);
  }, { auth: 'login' });

  router.add('DELETE', '/api/me/blockouts/:id', async ({ user, params }) => (
    ok(await blockouts().removeOwn(user.id, pathId(params.id)))
  ), { auth: 'login' });

  router.add('GET', '/api/people/:id/blockouts', async ({ params }) => (
    ok({ blockouts: await blockouts().listForPerson(pathId(params.id)) })
  ), { auth: 'admin' });

  router.add('GET', '/api/blockouts', async ({ query }) => (
    ok({ blockouts: await blockouts().listRange(query.from, query.to) })
  ), { auth: 'admin' });
}
