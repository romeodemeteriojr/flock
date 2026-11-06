# 2. Async data interface

Status: accepted

## Context

`node:sqlite` is synchronous, and flock only needs SQLite today. But we want the
option of PostgreSQL later (or another adapter), whose drivers are all
asynchronous. Changing every caller from sync to async later would touch the
whole app.

## Decision

The data layer (`src/data/index.js`) is an interface of repositories whose
methods all return Promises and plain camelCase objects. Calls and whole
transactions (`data.tx`) run one at a time through a queue, so awaiting inside a
transaction is safe. Errors are `DuplicateError`, `InUseError` or a plain
`Error`. `test/data/contract.js` is a contract test suite every adapter must pass.

## Consequences

- A PostgreSQL adapter can be added in `src/data/postgres/` without changing
  services or routes; it runs the same contract tests.
- A small cost: promises around synchronous calls, and the queue serialises
  database work (fine for a church of about 70 people).
- Services must use the `d` handed to `data.tx(async (d) => ...)` inside a
  transaction.
