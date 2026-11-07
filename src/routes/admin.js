// Scheduler tools (admin only): gaps, suggestions and draft reminders.
// Thin HTTP adapters over the gaps service.
import { v, parse } from '../validate.js';

const ok = (json, status = 200) => ({ status, json });
const idSchema = v.string({ pattern: /^\d+$/, patternMessage: 'must be a whole number' }).label('Slot id');
const flagSchema = v.enum(['true', 'false', '1', '0']).label('Include unqualified');

// '' and a missing value both mean "use the default".
const opt = (x) => (x === undefined || x === '' ? undefined : x);
const autofillBody = v.object({
  weekOf: v.date().optional(),
  weeks: v.integer({ min: 1, max: 8 }).default(1),
  apply: v.boolean().default(false),
}, { strict: true });

export function register(router, ctx) {
  const gaps = () => ctx.services.gaps;

  router.add('GET', '/api/admin/gaps', async ({ query }) => (
    ok(await gaps().gaps({ from: opt(query.from), to: opt(query.to) }))
  ), { auth: 'admin' });

  router.add('GET', '/api/admin/suggest', async ({ query }) => {
    const slotId = Number(parse(idSchema, opt(query.slotId)));
    const raw = opt(query.includeUnqualified);
    const includeUnqualified = raw === undefined ? false : ['true', '1'].includes(parse(flagSchema, raw));
    return ok(await gaps().suggest({ slotId, includeUnqualified }));
  }, { auth: 'admin' });

  router.add('POST', '/api/admin/autofill', async ({ body, user }) => (
    ok(await ctx.services.autofill.run(user, parse(autofillBody, body)))
  ), { auth: 'admin' });

  router.add('GET', '/api/admin/reminders', async ({ query }) => (
    ok({ reminders: await gaps().reminders({ weekOf: opt(query.weekOf) }) })
  ), { auth: 'admin' });
}
