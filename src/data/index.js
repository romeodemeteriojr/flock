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
 * @property {string} username
 * @property {'admin'|'member'} role
 * @property {boolean} mustChangePassword
 * @property {boolean} active
 * @property {string} createdAt  ISO time
 * @property {number[]} positionIds  qualified positions, ascending
 */

/**
 * @typedef {object} AuthPerson  Only returned by people.findAuthById / findAuthByUsername.
 * @property {number} id
 * @property {string} name
 * @property {string} username
 * @property {'admin'|'member'} role
 * @property {boolean} mustChangePassword
 * @property {boolean} active
 * @property {string} createdAt
 * @property {string} passwordHash
 * @property {number} failedLogins
 * @property {string|null} lockedUntil  ISO time
 */

/**
 * @typedef {object} PeopleRepo
 * @property {(p: {name: string, username: string, passwordHash: string, role?: 'admin'|'member', mustChangePassword?: boolean, createdAt: string}) => Promise<Person>} create
 *   Add an active person (role defaults to member, mustChangePassword to true).
 *   Throws DuplicateError when the username is taken (case-insensitive).
 * @property {(id: number) => Promise<Person|null>} findById
 * @property {(id: number) => Promise<AuthPerson|null>} findAuthById  Includes passwordHash, failedLogins, lockedUntil.
 * @property {(username: string) => Promise<AuthPerson|null>} findAuthByUsername  Case-insensitive match.
 * @property {() => Promise<Person[]>} list  Everyone (active or not), sorted by name (case-insensitive) then id.
 * @property {(id: number, patch: {name?: string, role?: 'admin'|'member', active?: boolean}) => Promise<Person|null>} update
 *   Changes only the given fields; null if the person does not exist.
 * @property {(id: number, passwordHash: string, mustChange: boolean) => Promise<boolean>} setPassword
 *   Also clears failedLogins and lockedUntil. False if the person does not exist.
 * @property {(id: number, f: {failedLogins: number, lockedUntil: string|null}) => Promise<boolean>} setLoginFailures
 * @property {() => Promise<number>} countActiveAdmins
 */

/**
 * @typedef {object} SessionsRepo
 * @property {(s: {tokenHash: string, personId: number, expiresAt: string, createdAt: string}) => Promise<{id: number, personId: number, expiresAt: string, createdAt: string}>} create
 *   Throws DuplicateError for a token hash that already exists; Error for an unknown person.
 * @property {(tokenHash: string) => Promise<{personId: number, expiresAt: string}|null>} findByTokenHash
 * @property {(tokenHash: string) => Promise<number>} deleteByTokenHash  Returns how many were deleted.
 * @property {(personId: number, exceptTokenHash?: string) => Promise<number>} deleteForPerson
 *   Delete all sessions of a person, optionally keeping one. Returns how many were deleted.
 * @property {(nowIso: string) => Promise<number>} deleteExpired  Deletes sessions with expiresAt <= nowIso.
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
 * @property {() => Promise<Team[]>} list  Sorted by sort, then name (case-insensitive), then id.
 * @property {(id: number) => Promise<Team|null>} findById
 * @property {(t: {name: string, sort?: number}) => Promise<Team>} create
 *   Sort defaults to (highest sort + 1). Throws DuplicateError for a taken name (case-insensitive).
 * @property {(id: number, patch: {name?: string, sort?: number}) => Promise<Team|null>} update  DuplicateError for a taken name.
 * @property {(id: number) => Promise<boolean>} remove
 *   Deletes the team and its positions (and their qualifications). Throws InUseError when
 *   one of its positions is used by a slot. False if the team does not exist.
 */

/**
 * @typedef {object} PositionsRepo
 * @property {(id: number) => Promise<Position|null>} findById
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
 *   Replaces the person's positions in one transaction; returns the unique ids ascending.
 *   Throws Error (and changes nothing) for an unknown person or position id.
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
 * @typedef {object} Data
 * @property {PeopleRepo} people
 * @property {SessionsRepo} sessions
 * @property {TeamsRepo} teams
 * @property {PositionsRepo} positions
 * @property {QualificationsRepo} qualifications
 * @property {ServicesRepo} services
 * @property {SlotsRepo} slots
 * @property {BlockoutsRepo} blockouts
 * @property {AuditRepo} audit
 * @property {MaintenanceRepo} maintenance
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
