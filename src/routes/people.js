// People (admin only): thin HTTP adapter over services.people.
import { ValidationError } from '../errors.js';
import { v, parse } from '../validate.js';
import { inviteLink } from '../services/auth-service.js';

const isObj = (b) => b !== null && typeof b === 'object' && !Array.isArray(b);

// Check a value with a schema; any problem becomes one plain message.
function check(schema, value, message) {
  try {
    return parse(schema, value);
  } catch (e) {
    if (e instanceof ValidationError) throw new ValidationError(message);
    throw e;
  }
}

function checkKeys(body, allowed) {
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) throw new ValidationError(`Unknown field: ${k.slice(0, 40)}`);
  }
}

const idSchema = v.string({ pattern: /^[1-9][0-9]{0,9}$/ });
const roleSchema = v.enum(['admin', 'member']);
const activeSchema = v.boolean();
const usernameSchema = v.string({ pattern: /^[A-Za-z0-9._-]{3,30}$/ });

function parseId(raw) {
  return Number(check(idSchema, String(raw), 'That person id is not valid.'));
}

function cleanName(value) {
  const name = check(v.string(), value, 'Please enter a name.');
  check(v.string({ pattern: /^[\s\S]{1,80}$/ }), name, 'The name must be 1 to 80 characters long.');
  check(v.string({ pattern: /^[^\u0000-\u001f\u007f]*$/ }), name, 'The name cannot contain control characters.');
  return name;
}

function inviteOut(req, config, invite) {
  const base = config.publicUrl ?? `${config.secureCookies ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}`;
  const host = new URL(base).hostname;
  return {
    link: inviteLink(base, invite.token), expiresAt: invite.expiresAt,
    localOnly: ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host),
  };
}

export function register(router, ctx) {
  const people = () => ctx.services.people;
  const opts = { auth: 'admin' };

  router.add('GET', '/api/people', async () => ({ status: 200, json: await people().list() }), opts);

  router.add('POST', '/api/people', async ({ req, body, user }) => {
    if (!isObj(body)) throw new ValidationError('Please send the person details.');
    checkKeys(body, ['name', 'username', 'role']);
    const input = { name: cleanName(body.name) };
    if (body.role !== undefined) input.role = check(roleSchema, body.role, 'The role must be admin or member.');
    if (body.username !== undefined && body.username !== null && body.username !== '') {
      input.username = check(usernameSchema, body.username, 'The username must be 3 to 30 letters, digits, dots, underscores or dashes.');
    }
    const { person, invite } = await people().create(user, input);
    return { status: 201, json: { person, invite: inviteOut(req, ctx.config, invite) } };
  }, opts);

  router.add('PATCH', '/api/people/:id', async ({ params, body, user }) => {
    const id = parseId(params.id);
    if (!isObj(body)) throw new ValidationError('Please send the changes.');
    checkKeys(body, ['name', 'role', 'active']);
    if (body.name === undefined && body.role === undefined && body.active === undefined) {
      throw new ValidationError('There is nothing to change.');
    }
    const patch = {};
    if (body.name !== undefined) patch.name = cleanName(body.name);
    if (body.role !== undefined) patch.role = check(roleSchema, body.role, 'The role must be admin or member.');
    if (body.active !== undefined) patch.active = check(activeSchema, body.active, 'Active must be true or false.');
    return { status: 200, json: { person: await people().update(user, id, patch) } };
  }, opts);

  router.add('POST', '/api/people/:id/invite', async ({ req, params, user }) => {
    const { person, invite } = await people().invite(user, parseId(params.id));
    return { status: 200, json: { person, invite: inviteOut(req, ctx.config, invite) } };
  }, opts);

  router.add('POST', '/api/people/:id/reset-password', async ({ req, params, user }) => {
    const { person, invite } = await people().resetPassword(user, parseId(params.id));
    return { status: 200, json: { person, invite: inviteOut(req, ctx.config, invite) } };
  }, opts);
}
