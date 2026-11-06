# 1. Layered architecture

Status: accepted

## Context

The first cards put SQL, business rules and HTTP handling together in the route
handlers (`src/routes/*.js`, `src/auth.js`, `src/blockouts.js`). That was quick,
but rules are hard to test without HTTP, the same rule ends up in several
handlers, and the database cannot be swapped.

## Decision

Split the code into layers with dependencies that point downward only:
routes (thin HTTP adapters) -> application services (all business rules) ->
data layer interface -> SQLite adapter and `src/db.js`. Infrastructure (clock,
random, hasher, logger) is a separate leaf that imports nothing from the app.
SQL lives only in `src/db.js`, `src/migrations` and `src/data/sqlite`.
`test/architecture.test.js` enforces the rules by scanning the source; existing
files that break them are listed in a `LEGACY` array that may only shrink.

## Consequences

- Business rules get fast unit tests with injected fakes.
- Adding a feature touches up to three small files (route, service, data).
- Until every LEGACY file is refactored, two styles exist side by side; the
  architecture test stops the old style from spreading.
