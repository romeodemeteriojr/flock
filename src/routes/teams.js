// Teams, positions and qualifications: thin HTTP adapter over services.teams.
// Thin on purpose: the service checks the raw values itself, inside its
// transaction, so the order of checks is exactly the old one (not found first,
// then the name, a duplicate name, then sort).
import { NotFoundError } from '../errors.js';

// Ids in the path: anything that is not digits is simply "not found" (as before).
const toId = (raw) => (/^\d+$/.test(String(raw)) ? Number(raw) : null);

function bodyOf(body) {
  return body !== null && typeof body === 'object' ? body : {};
}

export function register(router, ctx) {
  const teams = () => ctx.services.teams;
  const ok = (json, status = 200) => ({ status, json });

  function teamId(params) {
    const id = toId(params.id);
    if (id === null) throw new NotFoundError('Team not found');
    return id;
  }
  function positionId(params) {
    const id = toId(params.id);
    if (id === null) throw new NotFoundError('Position not found');
    return id;
  }

  router.add('GET', '/api/teams', async ({ user }) => ok(await teams().list(user)), { auth: 'login' });

  router.add('POST', '/api/teams', async ({ body, user }) => {
    return ok(await teams().createTeam(user, { name: bodyOf(body).name }), 201);
  }, { auth: 'admin' });

  router.add('PATCH', '/api/teams/:id', async ({ params, body, user }) => {
    const { name, sort } = bodyOf(body);
    return ok(await teams().updateTeam(user, teamId(params), { name, sort }));
  }, { auth: 'admin' });

  router.add('DELETE', '/api/teams/:id', async ({ params, user }) => ok(await teams().deleteTeam(user, teamId(params))), { auth: 'admin' });

  router.add('POST', '/api/teams/:id/positions', async ({ params, body, user }) => {
    return ok(await teams().createPosition(user, teamId(params), { name: bodyOf(body).name }), 201);
  }, { auth: 'admin' });

  router.add('PATCH', '/api/positions/:id', async ({ params, body, user }) => {
    const { name, sort, teamId: newTeamId } = bodyOf(body);
    return ok(await teams().updatePosition(user, positionId(params), { name, sort, teamId: newTeamId }));
  }, { auth: 'admin' });

  router.add('DELETE', '/api/positions/:id', async ({ params, user }) => ok(await teams().deletePosition(user, positionId(params))), { auth: 'admin' });

  router.add('PUT', '/api/people/:id/positions', async ({ params, body, user }) => {
    const personId = toId(params.id);
    if (personId === null) throw new NotFoundError('Person not found');
    return ok({ positionIds: await teams().setQualifications(user, personId, bodyOf(body).positionIds) });
  }, { auth: 'admin' });

  router.add('GET', '/api/positions/:id/people', async ({ params }) => ok(await teams().listPeopleForPosition(positionId(params))), { auth: 'admin' });

  router.add('GET', '/api/me/positions', async ({ user }) => ok(await teams().myPositions(user.id)), { auth: 'login' });
}
