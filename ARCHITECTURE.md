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
src/server.js, src/http.js     HTTP: router, guard, error mapper, request log
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

`test/architecture.test.js` checks all of this by scanning the source. Files
written before these rules are listed in its `LEGACY` array; that list can only
get shorter, and the test fails if a file on it already follows every rule.

## What goes where

| Layer | Does | Never does |
| --- | --- | --- |
| route (`src/routes/x.js`) | read params and body, check their shape with `src/validate.js`, call **one** service method, shape the JSON response | business rules, data access, SQL |
| service (`src/services/x-service.js`) | every rule ("a blockout can be at most 366 days", "keep at least one admin"), transactions through `data.tx`, audit entries, throws `AppError`s | `req`/`res`, SQL, reading the clock or `process.env` directly |
| data (`src/data`) | load and save plain objects, translate unique/foreign-key failures into `DuplicateError` / `InUseError` | rules, HTTP, logging |
| infra (`src/infra`) | time, randomness, password hashing, logging | anything about churches, people or rotas |

Only `src/db.js`, `src/migrations` and `src/data/sqlite` contain SQL. Only
`src/infra`, `src/config.js`, `src/container.js`, `bin` and `src/cli` may use
`Date.now()`, `new Date()` with no arguments, `Math.random` or `process.env`;
everyone else gets a clock, random source or config injected.

### Example: adding "rename a team" end to end

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
plus any other services it uses. Services do not import infrastructure, keep
no module-level state and never look things up in a global.

`src/container.js` is the only place that wires things together and the only
place that reads the environment (through `loadConfig`). `createContainer()`
builds, in order: config, clock (system), random (secure), hasher (scrypt),
logger (JSON lines to stderr), the database (`openDb(config.dbPath)`) and the
data layer, then every service **exactly once**, sorted by what it needs
(`SERVICE_SPECS`). A missing or broken dependency, or a cycle between services,
stops start-up with a clear `ContainerError`.

`createContainer(overrides)` can replace any part: `config`, `env`, `clock`,
`random`, `hasher`, `logger`, `db`, `data`, ready-made `services`, or service
`factories`. Tests use `makeContainer()` from `test/helpers/container.js`
(fixed clock, seeded random, fast hasher, silent logger, fresh in-memory
database). `createApp({ container })` builds the HTTP app from a container;
`bin/flock.js serve` does `createApp({ container: createContainer({ logger }) })`
(its logger writes to stdout).

Until the route refactor cards land, route modules still get the deprecated
`ctx.db` (raw connection) and `ctx.now()` next to `ctx.services`. New code must
not use them.

## Errors and validation

Services throw the errors in `src/errors.js` (`ValidationError` 400,
`UnauthenticatedError` 401, `ForbiddenError` 403, `NotFoundError` 404,
`ConflictError` 409, `TooManyRequestsError` 429). The error mapper in
`src/http.js` turns them into `{ error, code? }` responses; data-layer
`DuplicateError` / `InUseError` become 409; anything else is a generic 500 that
is logged with its stack but never shown to the client. Input shape is checked
at the edge with `src/validate.js`; rules that need data are checked in the
service.

## The data layer and a future PostgreSQL adapter

`src/data/index.js` describes the interface: repositories (`people`,
`sessions`, `teams`, `positions`, `qualifications`, `services`, `slots`,
`blockouts`, `audit`, `maintenance`) plus `tx(fn)`. Every method returns a
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

Tests only use made-up people and in-memory databases (or temporary folders),
and never read the real home folder, real data or credential files.

## Logging

One JSON line per event, from `src/infra/logger.js`: `time`, `level`, `msg`
and fields. Every request is logged once with its id, method, path, status and
duration. **Never logged**: passwords, password hashes, session tokens,
cookies, authorization headers, request bodies. Fields with such names are
replaced by `[REDACTED]` at any depth, as a safety net, not as permission.
