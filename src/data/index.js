// The data layer interface. This is the ONLY place the app gets data from, and
// the adapters behind it (src/data/sqlite/*) plus src/db.js and src/migrations
// are the only files that contain SQL.
//
// Every method returns a Promise, even though node:sqlite is synchronous, so a
// PostgreSQL adapter can later implement the same interface and pass the same
// contract tests (test/data/contract.js).
//
// All results are plain camelCase objects (never raw driver rows). Missing rows
// give `null` (finders/updates) or `false` (removes), never an exception.
// Errors: DuplicateError for unique rules, InUseError for rows still used by
// others (see ./errors.js). Other bad input (for example an id that points at a
// row that does not exist) throws a plain Error.
//
// CONCURRENCY: all top-level calls and every whole `tx` run one at a time
// through a queue. Inside `data.tx(async (d) => ...)` use `d`: its repositories
// are bound to the open transaction and skip the queue. A top-level call made
// from inside the tx callback also joins the transaction (it does not deadlock);
// a call from anywhere else waits until the transaction has finished.
// A `tx` inside a `tx` reuses the open transaction (no savepoint): if the inner
// function throws and the outer one lets the error escape, everything rolls back.

import { createSqliteData } from './sqlite/index.js';

export { DuplicateError, InUseError } from './errors.js';

/**
 * @typedef {object} Person  Public person, never contains secrets.
 * @property {number} id
 * @property {string} name
 * @property {string|null} email  the login (lowercase, unique); null = cannot log in
 * @property {'admin'|'member'} role
 * @property {boolean} hasPassword
 * @property {boolean} joined  has a password or a linked sign-in account
 * @property {boolean} active
 * @property {string} createdAt  ISO time
 * @property {number[]} positionIds  qualified positions, ascending
 */

/**
 * @typedef {object} AuthPerson  Only returned by people.findAuthById / findAuthByEmail.
 * @property {number} id
 * @property {string} name
 * @property {string|null} email
 * @property {'admin'|'member'} role
 * @property {boolean} hasPassword
 * @property {boolean} active
 * @property {string} createdAt
 * @property {string|null} passwordHash
 * @property {number} failedLogins
 * @property {string|null} lockedUntil  ISO time
 */

/**
 * @typedef {object} PeopleRepo
 * @property {(p: {name: string, email?: string|null, role?: 'admin'|'member', createdAt: string}) => Promise<Person>} create
 *   Add an active person with no password (role defaults to member).
 *   Throws DuplicateError when the email is taken (case-insensitive).
 * @property {(id: number) => Promise<Person|null>} findById
 * @property {(id: number) => Promise<AuthPerson|null>} findAuthById  Includes passwordHash, failedLogins, lockedUntil.
 * @property {(email: string) => Promise<AuthPerson|null>} findAuthByEmail  Case-insensitive match.
 * @property {() => Promise<Person[]>} list  Everyone (active or not), sorted by name (case-insensitive) then id.
 * @property {(id: number, patch: {name?: string, role?: 'admin'|'member', active?: boolean, email?: string|null}) => Promise<Person|null>} update
 *   Changes only the given fields; null if the person does not exist.
 * @property {(id: number, passwordHash: string|null) => Promise<boolean>} setPassword
 *   Also clears failedLogins and lockedUntil. False if the person does not exist.
 * @property {(id: number, f: {failedLogins: number, lockedUntil: string|null}) => Promise<boolean>} setLoginFailures
 * @property {() => Promise<number>} countActiveAdmins  Joined active admins only; pending invites cannot prevent lockout.
 */

/**
 * @typedef {object} SessionsRepo
 * @property {(s: {tokenHash: string, personId: number, expiresAt: string, createdAt: string}) => Promise<{id: number, personId: number, expiresAt: string, createdAt: string}>} create
 *   Throws DuplicateError for a token hash that already exists; Error for an unknown person.
 * @property {(tokenHash: string) => Promise<{personId: number, expiresAt: string}|null>} findByTokenHash
 * @property {(tokenHash: string, expiresAt: string) => Promise<boolean>} extend  Move the expiry; false for an unknown token.
 * @property {(tokenHash: string) => Promise<number>} deleteByTokenHash  Returns how many were deleted.
 * @property {(personId: number, exceptTokenHash?: string) => Promise<number>} deleteForPerson
 *   Delete all sessions of a person, optionally keeping one. Returns how many were deleted.
 * @property {(nowIso: string) => Promise<number>} deleteExpired  Deletes sessions with expiresAt <= nowIso.
 */

/**
 * @typedef {object} Invite
 * @property {number} personId
 * @property {string} tokenHash  Only the SHA-256 is stored.
 * @property {string} expiresAt
 * @property {string} createdAt
 */

/**
 * @typedef {object} InvitesRepo
 * @property {(invite: Invite) => Promise<void>} replace  Replaces this person's previous invite.
 * @property {(tokenHash: string) => Promise<Invite|null>} findByTokenHash
 * @property {(personId: number) => Promise<number>} deleteForPerson  Number deleted.
 */

/**
 * @typedef {object} IdentitiesRepo  Linked sign-in provider accounts.
 * @property {(i: {provider: string, subject: string, personId: number, createdAt: string}) => Promise<void>} link
 *   DuplicateError when the account, or another account of this provider for the person, is already linked.
 * @property {(provider: string, subject: string) => Promise<number|null>} findPersonId
 * @property {(personId: number) => Promise<number>} deleteForPerson  Number unlinked.
 */

/**
 * @typedef {object} Position
 * @property {number} id
 * @property {number} teamId
 * @property {string} name
 * @property {number} sort
 */

/**
 * @typedef {object} Team
 * @property {number} id
 * @property {string} name
 * @property {number} sort
 * @property {Position[]} positions  sorted by sort, name (case-insensitive), id
 */

/**
 * @typedef {object} TeamsRepo
 * @property {() => Promise<Team[]>} list  Active teams with their active positions,
 *   sorted by sort, then name (case-insensitive), then id. Retired ones never appear.
 * @property {(id: number) => Promise<Team|null>} findById  Active teams only (null for retired).
 * @property {(name: string) => Promise<{id: number, name: string, sort: number}|null>} findRetiredByName
 *   A retired team with that name (case-insensitive).
 * @property {(id: number, t: {name: string}) => Promise<Team|null>} revive
 *   Bring a retired team back under the name, last in order. Its positions stay retired.
 * @property {(id: number, at: string) => Promise<boolean>} retire  Retire the team and its active positions.
 * @property {(t: {name: string, sort?: number}) => Promise<Team>} create
 *   Sort defaults to (highest sort + 1). Throws DuplicateError for a taken name (case-insensitive).
 * @property {(id: number, patch: {name?: string, sort?: number}) => Promise<Team|null>} update
 *   DuplicateError for a name taken by an active or a retired team (different messages).
 * @property {(id: number) => Promise<boolean>} remove
 *   Deletes the team and its positions (and their qualifications). Throws InUseError when
 *   one of its positions is used by a slot. False if the team does not exist.
 */

/**
 * @typedef {object} PositionsRepo
 * @property {(id: number) => Promise<Position|null>} findById  Active positions only (null for retired).
 * @property {(teamId: number, name: string) => Promise<Position|null>} findRetiredByName
 *   A retired position in the team with that name (case-insensitive).
 * @property {(id: number, p: {name: string}) => Promise<Position|null>} revive
 *   Bring a retired position back under the name, last in its team; id and qualifications kept.
 * @property {(id: number, at: string) => Promise<boolean>} retire
 *   Hide the position from every list; slots that use it keep it. False if already retired.
 * @property {(teamId: number, p: {name: string, sort?: number}) => Promise<Position>} create
 *   Sort defaults to (highest sort in the team + 1). DuplicateError when the team already has
 *   that name (case-insensitive); Error when the team does not exist.
 * @property {(id: number, patch: {name?: string, sort?: number, teamId?: number}) => Promise<Position|null>} update
 *   DuplicateError for a taken name in the (new) team; Error for an unknown team.
 * @property {(id: number) => Promise<boolean>} remove  InUseError when a slot uses it.
 * @property {(id: number) => Promise<number>} countSlots  Number of slots (any status) using the position.
 */

/**
 * @typedef {object} QualificationsRepo
 * @property {(personId: number, positionIds: number[]) => Promise<number[]>} setForPerson
 *   Replaces the person's active positions in one transaction (rows for retired positions are
 *   kept); returns the unique ids ascending. Throws Error (and changes nothing) for an unknown
 *   person or an unknown or retired position id.
 * @property {(personId: number) => Promise<number[]>} listPositionIds  Ascending.
 * @property {(positionId: number) => Promise<{id: number, name: string}[]>} listPeople
 *   Active qualified people only, sorted by name (case-insensitive) then id.
 * @property {() => Promise<Map<number, number[]>>} mapByPosition
 *   positionId -> ids of active qualified people (ascending). Positions without anyone are absent.
 */

/**
 * @typedef {object} Service
 * @property {number} id
 * @property {string} date  YYYY-MM-DD
 * @property {string} time  HH:MM
 * @property {string} title
 */

/**
 * @typedef {object} ServicesRepo
 * @property {(s: {date: string, time?: string, title: string}) => Promise<Service>} create
 *   Time defaults to 09:00. DuplicateError when a service exists at the same date and time.
 * @property {(id: number) => Promise<Service|null>} findById
 * @property {(date: string, time: string) => Promise<Service|null>} findByDateTime
 * @property {(fromDate: string, toDate: string) => Promise<Service[]>} listRange  Inclusive, sorted by date, time, id.
 * @property {(id: number, patch: {date?: string, time?: string, title?: string}) => Promise<Service|null>} update
 *   DuplicateError when the new date and time clash with another service.
 * @property {(id: number) => Promise<boolean>} remove  Also deletes its slots.
 * @property {(id: number) => Promise<number>} assignedCount  Slots of the service that have a person.
 */

/**
 * @typedef {object} Slot  A slot joined with its service, position, team and person.
 * @property {number} id
 * @property {number} serviceId
 * @property {number} positionId
 * @property {number|null} personId
 * @property {'open'|'pending'|'accepted'|'declined'} status
 * @property {string|null} assignedAt
 * @property {string|null} respondedAt
 * @property {string} serviceDate
 * @property {string} serviceTime
 * @property {string} serviceTitle
 * @property {string} positionName
 * @property {number} positionSort
 * @property {number} teamId
 * @property {string} teamName
 * @property {number} teamSort
 * @property {string|null} personName
 */

/**
 * @typedef {object} SlotsRepo
 * @property {(serviceId: number, positionIds: number[]) => Promise<Slot[]>} createMany
 *   One open slot per entry (repeats allowed), all in one transaction, returned in the same order.
 *   Throws Error (and creates nothing) for an unknown service or position.
 * @property {(id: number) => Promise<Slot|null>} findById
 * @property {(fromDate: string, toDate: string) => Promise<Slot[]>} listForServices
 *   Slots of all services in the inclusive range, sorted by date, time, team sort, position sort, id.
 * @property {(serviceId: number) => Promise<Slot[]>} listForService  Sorted by team sort, position sort, id.
 * @property {(personId: number, fromDate?: string|null, toDate?: string|null, statuses?: string[]) => Promise<Slot[]>} listForPerson
 *   The person's slots, optionally limited to a date range (inclusive; null = open end) and statuses.
 *   Sorted by date, time, team sort, position sort, id.
 * @property {(id: number, a: {personId: number, status?: 'pending'|'accepted', assignedAt: string}) => Promise<Slot|null>} assign
 *   Puts a person in the slot (status defaults to pending) and clears respondedAt.
 * @property {(id: number) => Promise<Slot|null>} clear  Back to open: no person, no times.
 * @property {(id: number, r: {status: 'accepted'|'declined'|'pending', respondedAt: string|null}) => Promise<Slot|null>} respond
 * @property {(id: number) => Promise<boolean>} remove
 * @property {(positionIds: number[], from: string) => Promise<Slot[]>} listForPositionsFrom
 *   Slots of these positions on services dated `from` or later, by date then time.
 * @property {(personId: number, serviceId: number) => Promise<number>} countForPersonOnService
 * @property {(fromDate: string, toDate: string) => Promise<Slot[]>} assignedBetween
 *   Every slot with a person (any status) on services in the inclusive range, for statistics. Same order as listForServices.
 */

/**
 * @typedef {object} Blockout
 * @property {number} id
 * @property {number} personId
 * @property {string} startDate
 * @property {string} endDate
 * @property {string} reason
 * @property {string} createdAt
 */

/**
 * @typedef {object} ConflictSlot
 * @property {number} slotId
 * @property {number} serviceId
 * @property {string} date
 * @property {string} time
 * @property {string} serviceTitle
 * @property {string} positionName
 * @property {string} teamName
 * @property {'pending'|'accepted'} status
 */

/**
 * @typedef {object} BlockoutsRepo
 * @property {(b: {personId: number, startDate: string, endDate?: string, reason?: string, createdAt: string}) => Promise<Blockout>} create
 *   endDate defaults to startDate, reason to ''. Error for an unknown person or endDate before startDate.
 * @property {(personId: number, fromDate?: string|null) => Promise<Blockout[]>} listForPerson
 *   Optionally only blockouts ending on/after fromDate. Sorted by startDate, endDate, id.
 * @property {(id: number, personId: number) => Promise<boolean>} remove  Only removes the person's own blockout.
 * @property {(personId: number, date: string) => Promise<boolean>} coversDate
 * @property {(date: string) => Promise<Set<number>>} blockedPersonIds  People with a blockout covering the date.
 * @property {(fromDate?: string|null, toDate?: string|null) => Promise<(Blockout & {personName: string})[]>} listRange
 *   Blockouts overlapping the range (null = open end). Sorted by startDate, endDate, id.
 * @property {(personId: number, startDate: string, endDate: string) => Promise<ConflictSlot[]>} conflictingSlots
 *   The person's pending/accepted slots on services in the inclusive range, sorted by date, time, slot id.
 */

/**
 * @typedef {object} Availability  How often a person is willing to serve.
 * @property {number} personId
 * @property {number} everyWeeks  0 = paused, else at most once every N weeks (1, 2, 3, 4, 6 or 8)
 * @property {string} updatedAt  ISO time
 */

/**
 * @typedef {object} AvailabilityRepo
 * @property {(personId: number) => Promise<Availability|null>} get  null when the person never chose.
 * @property {(personId: number, a: {everyWeeks: number, updatedAt: string}) => Promise<Availability>} set
 *   Insert or replace the person's choice. Error for an unknown person or a value outside 0, 1, 2, 3, 4, 6, 8.
 * @property {() => Promise<Map<number, number>>} mapAll  personId -> everyWeeks, for everyone who chose.
 */

/**
 * @typedef {object} AuditEntry
 * @property {number} id
 * @property {string} at
 * @property {number|null} actorId
 * @property {string} action
 * @property {string} detail
 */

/**
 * @typedef {object} AuditRepo
 * @property {(e: {at: string|Date, actorId?: number|null, action: string, detail?: string}) => Promise<void>} log
 *   Detail is cut to 500 characters.
 * @property {(limit?: number) => Promise<AuditEntry[]>} list  Newest first (default 100 entries).
 */

/**
 * @typedef {object} MaintenanceRepo
 * @property {(path: string) => Promise<void>} backupTo
 *   Writes a consistent copy of the database (VACUUM INTO). Throws Error if the file already
 *   exists (never overwrites). Cannot run inside a transaction.
 * @property {() => Promise<number>} personCount
 */

/**
 * @typedef {object} PushDevice  One browser on one device that turned on push (decision 0008).
 * @property {number} id
 * @property {number} personId
 * @property {string} endpoint  The push service address (unique).
 * @property {string} p256dh  The device's public key, base64url.
 * @property {string} auth  The device's secret, base64url.
 * @property {string} createdAt  ISO time
 */

/**
 * @typedef {object} PushDevicesRepo
 * @property {(d: {personId: number, endpoint: string, p256dh: string, auth: string, createdAt: string}) => Promise<PushDevice>} save
 *   Insert, or replace the device with the same endpoint (it moves to this person). Error for an unknown person.
 * @property {(endpoint: string) => Promise<PushDevice|null>} findByEndpoint
 * @property {(personId: number) => Promise<PushDevice[]>} listForPerson  Oldest first (createdAt, id).
 * @property {() => Promise<Set<number>>} personIds  Everyone with at least one device.
 * @property {(personId: number, keep: number) => Promise<number>} trimForPerson
 *   Keep only the person's newest `keep` devices; returns how many were removed.
 * @property {(endpoint: string) => Promise<boolean>} remove  Whoever it belongs to.
 * @property {(personId: number, endpoint: string) => Promise<boolean>} removeOwn  Only if it is this person's.
 * @property {(personId: number) => Promise<number>} deleteForPerson  Number removed.
 */

/**
 * @typedef {object} Data
 * @property {PeopleRepo} people
 * @property {SessionsRepo} sessions
 * @property {InvitesRepo} invites
 * @property {IdentitiesRepo} identities
 * @property {TeamsRepo} teams
 * @property {PositionsRepo} positions
 * @property {QualificationsRepo} qualifications
 * @property {ServicesRepo} services
 * @property {SlotsRepo} slots
 * @property {BlockoutsRepo} blockouts
 * @property {AvailabilityRepo} availability
 * @property {AuditRepo} audit
 * @property {MaintenanceRepo} maintenance
 * @property {PushDevicesRepo} pushDevices
 * @property {<T>(fn: (d: Data) => T | Promise<T>) => Promise<T>} tx
 *   Runs fn in one transaction (BEGIN IMMEDIATE ... COMMIT, ROLLBACK if fn throws) and
 *   resolves to fn's result. `d` has the same repositories bound to the transaction.
 *   Calling d after the transaction finished rejects. A tx inside a tx reuses it.
 */

/**
 * Build the data layer on an open database (from src/db.js openDb).
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Data}
 */
export function createData(db) {
  return createSqliteData(db);
}
