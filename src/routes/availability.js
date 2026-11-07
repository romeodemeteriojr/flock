// Availability: thin HTTP adapters over the availability service.
import { v, parse } from '../validate.js';
import { EVERY_WEEKS_CHOICES } from '../services/availability-service.js';

const ok = (json, status = 200) => ({ status, json });
const setBody = v.object({ everyWeeks: v.enum([...EVERY_WEEKS_CHOICES]).label('How often') }, { strict: true });

export function register(router, ctx) {
  const availability = () => ctx.services.availability;

  router.add('GET', '/api/me/availability', async ({ user }) => (
    ok({ availability: await availability().getMine(user.id) })
  ), { auth: 'login' });

  router.add('PUT', '/api/me/availability', async ({ user, body }) => {
    const { everyWeeks } = parse(setBody, body);
    return ok({ availability: await availability().setMine(user.id, { everyWeeks }) });
  }, { auth: 'login' });
}
