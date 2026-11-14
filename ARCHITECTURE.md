# flock architecture

flock is a small app: one Node process, one SQLite file, no npm packages. The
code is still split into layers so that each part is easy to test on its own
and can be changed without touching the rest.

## The layers and the dependency rule

```
bin/flock.js, src/cli/*        start-up and command line
        |
src/container.js               the composition root: builds and wires everything
        |
src/server.js, src/http.js,    HTTP: router, error mapper, request log,
src/guard.js                   static files; the guard (session, role, CSRF)
        |
src/routes/*.js                thin HTTP adapters
        |
src/services/*-service.js      application services: all business rules
        |
src/data/index.js              the data layer interface (async repositories)
        |
src/data/sqlite/*, src/db.js   the SQLite adapter, migrations, the connection
```

**Dependencies point downward only.** A layer may use the layers below it and
never the ones above it:

- routes never import `src/data` or `src/db.js`; they call a service;
- services never import routes or `src/db.js`, and never see HTTP objects;
- `src/data` imports nothing from services, routes or infra (only its own
  errors and `src/db.js`);
- `src/infra` (clock, random, hasher, logger) imports nothing from the app;
- there are no import cycles anywhere in `src`.

Small shared modules sit beside the layers and may be used by any of them:
`src/errors.js` (the `AppError` classes), `src/validate.js` (input shape
checks), `src/dates.js` (plain date arithmetic) and `src/config.js`.

`test/architecture.test.js` checks all of this by scanning the source. Its
`LEGACY` array (files still allowed to break the rules) is now empty, and a
test keeps it that way: every file in `src` and `bin` follows every rule.

## What goes where

| Layer | Does | Never does |
| --- | --- | --- |
| route (`src/routes/x.js`) | read params and body, check path ids (and, in some modules, the body shape) with `src/validate.js`, call **one** service method, shape the JSON response | business rules, data access, SQL |
| service (`src/services/x-service.js`) | every rule ("a blockout can be at most 366 days", "keep at least one admin"), the remaining input checks (teams, services, blockouts check their whole input here), transactions through `data.tx`, audit entries for admin changes, throws `AppError`s | `req`/`res`, SQL, reading the clock or `process.env` directly |
| data (`src/data`) | load and save plain objects, translate unique/foreign-key failures into `DuplicateError` / `InUseError` | rules, HTTP, logging |
| infra (`src/infra`) | time, randomness, password hashing, logging | anything about churches, people or rotas |

Only `src/db.js`, `src/migrations` and `src/data/sqlite` contain SQL. Only
`src/infra`, `src/config.js`, `src/container.js`, `bin` and `src/cli` may use
`Date.now()`, `new Date()` with no arguments, `Math.random` or `process.env`;
everyone else gets a clock, random source or config injected.

### Example: adding a feature end to end

The example below shows the shape of a change, using "rename a team" (the real
app already has this as `PATCH /api/teams/:id` and `teams.updateTeam`, which
also returns the public team shape; a second route with the same method and
path would never be reached, because the first match wins).

1. **Data**: `data.teams.update(id, { name })` already exists. If it did not,
   add it to the typedef in `src/data/index.js`, implement it in
   `src/data/sqlite/teams.js` and add a case to `test/data/contract.js`.
2. **Service**: in `src/services/teams-service.js`
   ```js
   async rename(actor, id, name) {
     const team = await deps.data.teams.update(id, { name });
     if (!team) throw new NotFoundError('That team does not exist');
     await deps.data.audit.log({ at: deps.clock.now(), actorId: actor.id, action: 'team.rename', detail: `team ${id}` });
     return team;
   }
   ```
   A `DuplicateError` from the data layer becomes a 409 on its own.
3. **Route**: in `src/routes/teams.js`
   ```js
   const renameBody = v.object({ name: v.string({ min: 1, max: 60 }) });
   router.add('PATCH', '/api/teams/:id', async ({ params, body, user }) => {
     const id = parse(v.integer({ min: 1 }), Number(params.id), 'Team id');
     const { name } = parse(renameBody, body);
     return { status: 200, json: { team: await deps.services.teams.rename(user, id, name) } };
   }, { auth: 'admin' });
   ```
4. **Tests**: a service unit test with injected fakes, and one route
   integration test for the HTTP shape.

## Dependency injection and the container

Every service is a factory, `createXService(deps)`, that gets **all** of its
dependencies as arguments: `{ data, clock, random, hasher, logger, config }`
plus the other services it declares in `SERVICE_SPECS` (some declarations are
wider than what the service uses today, which only affects build order).
Services do not import infrastructure, keep no module-level state and never
look things up in a global.

`src/container.js` is the only place that wires things together. The
environment is read only at the edge: `bin/flock.js` hands `process.env` to
`src/cli/commands.js`, which passes it to `loadConfig` (and reads
`FLOCK_LOG_LEVEL` for `serve`); `createContainer()` with no `config` calls
`loadConfig` itself. The one other reader is `src/infra/hasher.js`, which
checks `NODE_ENV` so the fast test hasher refuses to run in production.
`FLOCK_TRUST_PROXY=1` (config `trustProxy`, default off) makes the login
throttle use the `Fly-Client-IP` header, else the first `X-Forwarded-For`
entry, as the client IP; when off those headers are ignored and the socket
address is used. Turn it on only behind a proxy that sets them, where
every user otherwise shares one IP. The per-IP limit (20 per 5 minutes) counts
failed logins only; the per-account lockout is separate and unchanged.

`createContainer()` builds, in order: config, clock (system), random (secure),
hasher (scrypt), logger (JSON lines to stderr), the database (it creates the
folder, then `openDb(config.dbPath, { clock })`) and the data layer, then
every service **exactly once**, sorted by what it needs (`SERVICE_SPECS`). A
missing dependency, a clock/random/hasher/logger/data override without its
methods, or a cycle between services stops start-up with a clear
`ContainerError`; bad settings stop it with a `ConfigError` listing every
problem.

Two more core parts are built from the settings: `sso` (the set-up sign-in
providers, `src/infra/oidc.js`) and `push` (`src/infra/webpush.js`, Decision
0008): a Web Push sender when `FLOCK_VAPID_PUBLIC_KEY` and
`FLOCK_VAPID_PRIVATE_KEY` are set, otherwise a sender that does nothing
(`push.enabled` is false). Only the `notifications` service uses it. Other
services (assignments, calendar, autofill, gaps) call `notifications` after
their transaction has committed; sending never throws and is not awaited,
except Gaps **Send reminders**. `notifications.idle()` waits for sends in
flight (tests, and `serve` on shutdown).

`createContainer(overrides)` can replace any part: `config`, `env`, `clock`,
`random`, `hasher`, `logger`, `db`, `data`, `sso`, `push`, ready-made `services`, or service
`factories`. Tests use `makeContainer()` from `test/helpers/container.js`
(fixed clock, seeded random, fast hasher, silent logger, fresh in-memory
database). `createApp({ container })` builds the HTTP app from a container;
`node bin/flock.js serve` (in `src/cli/commands.js`) does
`createApp({ container: createContainer({ config: loadConfig(env), logger }) })`,
where the logger writes JSON lines to stdout at level `FLOCK_LOG_LEVEL`
(default `info`). The older form `createApp({ db, now, config, logger })`
still works and builds a container from those parts (silent unless a logger
is given).

Route modules get `deps = { services, config, clock, logger }` (the same
object reaches handlers as `ctx`). They never get the data layer or the raw
database connection; the old `ctx.db` and `ctx.now()` are gone. When the
container opens the database it passes its clock to `openDb` for the migration
timestamps; `openDb(file)` without a clock (tests) lets SQLite record the time.
Before migrating, `openDb` refuses (with a `DatabaseFileError` and a plain
message) a database file that is empty, damaged (`PRAGMA quick_check`) or not
a database, and one made by a newer flock (it lists a migration this version
does not have). The CLI prints that message as it is.

## Errors and validation

Services throw the errors in `src/errors.js` (`ValidationError` 400,
`UnauthenticatedError` 401, `ForbiddenError` 403, `NotFoundError` 404,
`ConflictError` 409, `TooManyRequestsError` 429). The error mapper in
`src/http.js` turns them into `{ error, code? }` responses (a route may add
fields, such as `count` on a refused service deletion); data-layer
`DuplicateError` / `InUseError` become 409; a body over 100 KB is 413 and
invalid JSON is 400; anything else is a generic 500 that is logged with its
stack but never shown to the client. Input shape is checked with
`src/validate.js`, at the route or (for teams, services and blockouts) at the
start of the service method; rules that need data are checked in the service.

## The data layer and a future PostgreSQL adapter

`src/data/index.js` describes the interface: repositories (`people`,
`sessions`, `invites`, `identities`, `teams`, `positions`, `qualifications`,
`services`, `slots`, `blockouts`, `availability`, `audit`, `maintenance`,
`pushDevices`, `attachments`) plus `tx(fn)`. Every method returns a
Promise and plain camelCase objects. `test/data/contract.js` is a contract test
suite that any adapter must pass.

A PostgreSQL adapter would live in `src/data/postgres/`, implement the same
interface, run the same contract tests against a test database, and be chosen
in `src/container.js` (for example from a `FLOCK_DB` URL). Services and routes
would not change.

## Testing strategy

- **Service unit tests**: build the service with `makeContainer()` or with
  hand-made fakes; control time with `fixedClock`, randomness with
  `seededRandom`, hashing with `fastHasher`.
- **Repository contract tests**: `test/data/contract.js`, run against SQLite
  in memory (and later any other adapter).
- **Route integration tests**: `startTestApp()` starts the real app on a free
  port with an in-memory database and checks status codes and JSON shapes.
- **Architecture tests**: `test/architecture.test.js` and the static check in
  `test/container.test.js`.
- **Push notifications**: `test/webpush.test.js` checks the encryption and
  signing against the RFC 8291 and RFC 8292 examples; route and event tests
  replace `push` with a recording fake (`test/helpers/push.js`). Nothing
  reaches a real push service.

Tests only use made-up people and in-memory databases (or temporary folders),
and never read the real home folder, real data or credential files.

## Logging

One JSON line per event, from `src/infra/logger.js`: `time`, `level`, `msg`
and fields. Every request is logged once with its id, method, path, status,
duration and (when logged in) user id. **Never logged**: passwords, password
hashes, session tokens, cookies, authorization headers, request bodies (no
code passes them to the logger). As a safety net, not as permission, fields
whose names look secret (`password`, `passwd`, `token`, `secret`, `cookie`,
`authorization`, `hash`, `api_key`, and a push device's `endpoint`, `p256dh`,
`auth` or a `privateKey`) are replaced by `[REDACTED]` at any depth. Push
sends log only the kind, the push service host and its status.
`test/security.test.js` checks with a recording logger that no password, hash
or token reaches a log line.
