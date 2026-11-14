# Testing flock

flock has no test dependencies: every test uses Node's built-in test runner
(`node:test`) and `node:assert`. Tests use only made-up people, in-memory
databases or temporary folders, a fixed clock and a seeded random source. They
never read the real home folder, real data or any credential file.

## Running the tests

| What | Command |
| --- | --- |
| Everything (what CI runs) | `npm test` (the same as `node --test`) |
| One file | `node --test test/stress.test.js` |
| Several files | `node --test test/fuzz.test.js test/upgrade.test.js` |
| Tests whose name matches | `node --test --test-name-pattern="DST" test/calendar-edges.test.js` |
| Coverage | `npm run coverage` |

The whole suite takes about 4 seconds on a laptop; it must stay under 60. No
test sleeps for more than 50 ms: time moves only through the injected clock
(`fixedClock(...).set()` / `.advance()`).

## The kinds of test and what each proves

**Unit tests for the services** (`test/*-service.test.js`). Every business rule
(the 3-positions limit, blockouts, the 366-day limit, lockouts, at least one admin...)
with the service built from fakes or `makeContainer()`.

**Invite links** (`test/invites-service.test.js`, `test/welcome-routes.test.js`,
`test/welcome-ui.test.js`, `test/invite-message.test.js`). One-time use, exact
seven-day expiry, replacement, reset/session revocation, deactivation, weak
password retries, no-password login refusal, and expiry/replacement races
while hashing. Session-write failures roll back the whole claim. Tests also
cover the public URL, POST-only token handling, throttling, welcome UI,
clipboard fallback and accessible action controls.

**Repository contract tests** (`test/data/contract.js`, run by
`test/data/sqlite.test.js`). What any data adapter must do, run against SQLite
in memory. A future PostgreSQL adapter must pass the same file.

**Route integration tests** (`test/auth.test.js`, `test/people.test.js`,
`test/assignments.test.js`, ...). The real app on a free port, real HTTP,
checking status codes and JSON shapes.

**Database and migrations** (`test/db.test.js`). Schema, constraints,
cascades, transactions.

**Architecture** (`test/architecture.test.js`, `test/container.test.js`).
Scans the source: layers only depend downward, no import cycles, no SQL
outside the data layer, no `Date.now()`/`Math.random`/`process.env` outside the
allowed places.

**Security** (`test/security.test.js`). Every route needs a login except
login, health and the token-protected welcome POST routes. Member/scheduler access is checked for every route, and so
is the CSRF header. Also: cookie flags, session fixation, lockout and per-IP
throttle, the body size limit, path traversal, security headers, stored XSS,
and that no password, hash or session token reaches a response, audit row or
log line. Invite tokens appear only in their one-time scheduler handoff
responses, never logs or HTTP URLs.

**End to end** (`test/e2e.test.js`). The whole life of a volunteer, from
`create-admin` on the command line to deactivation, over HTTP. Also: the same
inputs and clock give the same API output, and `npm start` starts and stops.

**Command line** (`test/cli.test.js`). `create-admin`, `demo`, `backup`,
`export` (including CSV-injection guards) as child processes against temporary
databases.

**Web UI without a browser** (`test/member-ui.test.js`,
`test/admin-*-ui.test.js`, `test/polish.test.js`, `test/shell.test.js`). The
views render into a small fake DOM (`test/helpers/fakeui.js`,
`test/helpers/fakeroot.js`). They check that hostile data is escaped, labels
and contrast are right, and the right API calls are made.

**UI flows** (`test/ui-flows.test.js`). The real `web/app.js` and views run on
a fake page (`test/helpers/fakepage.js`) and talk over real HTTP to a test app
with the demo data. Each test follows a numbered scenario in `UAT.md`.

**Deployment** (`test/deploy.test.js`, `test/workflows.test.js`). Dockerfile
and the GitHub workflows are well formed. The Docker build runs only
when Docker is installed (otherwise it is skipped).

**Scale** (`test/scale.test.js`). A church of 1,000 people, 12 teams of 5
positions, 10 upcoming services, a third of people away some days: Fill open
positions, My schedule, Services, Gaps, suggestions, People and reminders each
give right answers in under a second (a few milliseconds on a laptop).

**Stress and concurrency** (`test/stress.test.js`). A church of 70 members
and 5 schedulers with a month of Sunday services, on a temporary WAL database
file, under many requests at once over real HTTP:
- 50 members log in at once;
- 30 people accept or decline at once;
- one member sends accept and decline at the same time;
- five schedulers race to put the same person in 5 positions of one service (3 win);
- five race to fill the same slot;
- two edit the same person;
- password resets at the same time;
- blockouts added and removed at once.

It proves: no 500s; nobody over 3 positions on a service, or in the same
position twice; no lost updates (both concurrent edits
of a person survive, and every lockout failure is counted); exactly one audit
entry per change (none for reads, refusals or answers that change nothing);
and `PRAGMA integrity_check` and `foreign_key_check` pass at the end.

**Fuzzing** (`test/fuzz.test.js`). For every route the router has registered
(the list is read from the router, not written by hand), a seeded generator
sends hostile input as an anonymous visitor, a member and a scheduler:
- huge strings, unicode (emoji, right-to-left marks, lone surrogates), null
  bytes;
- wrong types, negative and huge numbers, invalid dates;
- deeply nested JSON, invalid JSON, duplicate keys, `__proto__` keys;
- wrong content types, bodies over the size limit;
- hostile path ids and query strings;
- valid bodies with one field broken.

It proves: never a 500; never a stack trace, file path, SQL error or JS error
name in a response; anonymous gets 401 and members get 403 on scheduler
routes; a missing CSRF header gets 403; an oversize body gets 413 and invalid
JSON gets 400. The same seed gives the same run every time.

**Backup and restore** (`test/backup-restore.test.js`). A populated database
is backed up with the real `backup` command while it is open, then restored
the way the README says (copy the file, point `FLOCK_DB` at the copy, start).
It proves:
- every table's row count matches the original;
- the key relationships match: who is in which slot with which status,
  qualifications, blockouts, sessions, people, invites, the audit log and the
  applied migrations;
- old session cookies, stored password hashes and still-live unused invites
  work over HTTP after a same-schema restore;
- a backup with a damaged page, one that is cut short (at half, after one
  page, inside the header, or empty) or a file that is not a database is
  refused by `serve`, `export` and `backup` with one plain sentence, and the
  file is left as it was;
- the CSV export contains no password hash, session token or invite token.

**Upgrades** (`test/upgrade.test.js`). A database at every supported schema
version (currently the 0.2.0 `0001_init.sql` schema family) is filled with data
using plain SQL, then
opened by the current flock. It proves:
- every migration is recorded, and the schema equals a fresh install's;
- every old row and column is unchanged, and an old session and an old
  password still work;
- opening it again (five times) changes nothing;
- a database from a newer flock (it lists a migration this version does not
  know) is refused with a plain message, by `openDb`, the container and the
  CLI, without touching the file.

When a new migration is added, this test covers every earlier supported
migration. The pre-release 0.1.0 schema was deliberately replaced in place;
these checks do not promise a 0.1.0 → 0.2.0 upgrade. That change needs a fresh
database, with existing files/backups preserved.

**Time and calendar edge cases** (`test/calendar-edges.test.js`). With the
injected clock and the process time zone set per test:
- the spring-forward and fall-back Sundays in London and New York (the
  service is "today" before and after the jump, and becomes past at local
  midnight);
- weekly repeat across both changeovers stays on Sunday at the same time;
- a session lasts exactly 14 × 24 hours across a changeover;
- a service on today's date can still be scheduled, answered, listed, found
  in gaps and reminders;
- past services are refused with a clear 409 (and past blockouts with a 400);
- the last second of the year and the first second of the next;
- New Year's Eve when UTC is already in January;
- repeats, ranges, blockouts and reminders across the new year;
- February 29: a Sunday service on 2032-02-29, non-leap February 29 refused,
  2000 as a leap year, and the 366-day blockout limit in a leap year.

## What is NOT covered

- **No real browser.** The web views run against a fake DOM, not Chrome,
  Firefox or Safari. Layout, CSS, focus handling, real cookies in a browser
  and JavaScript engine differences are not tested. Check the pages by hand
  (the style gallery helps) after visual changes.
- **No real hosting.** Deployment tests check the files (Dockerfile,
  workflows). They never deploy or use a real volume, proxy or snapshot. The
  `Fly-Client-IP` handling is tested with headers we set ourselves.
- **Docker** is built only when Docker is installed on the machine.
- **Real password hashing cost.** Most tests use the fast test hasher; scrypt
  itself has its own tests, but load tests do not measure real scrypt CPU
  time.
- **Long-running load.** The stress test has about 70 people under many requests
  at once; the scale test (`test/scale.test.js`) checks 1,000 people, 60
  positions and 10 services with only a loose 1-second bound per step. Nothing
  runs for long periods or measures response times closely.
- **Disk problems while running.** A full disk, power loss during a write or
  a file damaged while the app is running are not simulated. The check for
  damaged files runs when the database is opened.
- **Email or SMS.** Reminders are drafts only. Nothing is sent, so nothing is
  tested.
- **Time zone changes while running.** Time zones are tested per process.
  Changing the server's time zone while flock runs is not.

## Coverage

`npm run coverage` (Node's built-in `--experimental-test-coverage`) on this
version, 564 passing tests (1 skipped: Docker not installed):

| | Lines | Branches | Functions |
| --- | --- | --- | --- |
| All files | 76.74 % | 92.14 % | 85.66 % |

Every file under `src/` and `bin/` has at least 90 % line coverage (most have
100 %). The overall figure is lower because of the browser code in `web/`
(such as `api.js` and parts of `web/lib`). It only runs in a
real browser, so the fake-DOM tests use some of it and the coverage tool
counts only part of that.
