# 3. Dependency injection through one container

Status: accepted

## Context

Code read the time with `new Date()`, made tokens with `crypto` directly and got
the database from `ctx.db`. Tests could not control time or randomness, and
hidden dependencies made modules hard to reuse or replace.

## Decision

Every service is a factory `createXService(deps)` that receives everything it
uses explicitly: `{ data, clock, random, hasher, logger, config }` and the other
services it declares. `src/container.js` (`createContainer(overrides)`) is the
composition root: it gets settings from `loadConfig` (the command line passes
the environment in; nothing below reads it, apart from the hasher's
`NODE_ENV` safety check), creates the infrastructure and the data layer, and builds each
service exactly once in dependency order. No globals and no service locator
inside services. Any part can be overridden; tests use `makeContainer()` with a
fixed clock, seeded random, fast hasher, silent logger and an in-memory
database. A missing dependency or a cycle fails at start-up with a clear error.

## Consequences

- Tests are deterministic and never need the real environment.
- Adding a dependency to a service means declaring it in `SERVICE_SPECS` in
  the container, which keeps the wiring visible in one file.
- Route modules get only `{ services, config, clock, logger }`; the old
  `ctx.db` / `ctx.now()` compatibility fields have been removed. The older
  `createApp({ db, now, config })` form still builds a container from parts.
