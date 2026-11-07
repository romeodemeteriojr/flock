# 5. Auto-fill: fair weekly assignments and how often volunteers serve

Status: accepted (not yet built)

## TL;DR

- Volunteers choose **how often they can serve**: every 1, 2, 3, 4, 6 or 8
  weeks, or **paused**. If they never choose, Flock assumes **every 2 weeks**.
- Schedulers press **Fill open positions** on the Schedule page, pick a week
  and 1–8 weeks, get a **preview**, then **Ask these people**. Flock never
  assigns anyone without that second click.
- A **pure, deterministic planner** (`planAutofill`) fills every *open*,
  *future* slot it can, one week at a time, picking the person with the
  lowest **load = services in the last 8 weeks × their every-N-weeks**.
- One new table (`availability`), two new services, three new routes, two
  views extended (no new pages). No new dependencies.
- Every code block and diff below was **run against `main` at `cb72451`** (after invite links, #12):
  the full suite (687 tests) passed, and planned bugs (mutations) were each
  caught by at least one test.

## Context

Today the scheduler fills every slot by hand. The slot panel suggests people
(`gaps.suggest`: qualified, not away, fewest services in the last 8 + next 4
weeks), but someone still has to click each position, every week. Volunteers
cannot say "I can only do once a month", so the scheduler keeps that in their
head.

## Decision (summary)

| # | Decision | Chosen | Why / how to change later |
|---|---|---|---|
| D1 | What volunteers set | One number, `everyWeeks`: **0 (paused), 1, 2, 3, 4, 6 or 8** | Simple to explain on a phone. Change `EVERY_WEEKS_CHOICES` (server), `FREQUENCIES` (web), and the `CHECK` in the migration together. |
| D2 | Default when never chosen | **2** (`DEFAULT_EVERY_WEEKS`) | Protects volunteers from burnout; gaps stay visible on the Gaps page. Only the constant changes if the church wants 1. |
| D3 | What a "week" is | **Monday to Sunday** (`mondayOf`) | Sat-evening + Sun-morning services are the same week. |
| D4 | What "every N weeks" means | At most one *auto-filled* slot per person in any N consecutive weeks: a person is free for a service in week W only if **every** pending/accepted slot they hold (existing or just planned) is **≥ N weeks away** from W, before *or after*. | Symmetric, so a hand-made assignment next week also blocks this week. With N = 1 it means "at most once per week". |
| D5 | Which slots auto-fill touches | Only `status = 'open'` slots on dates **≥ today**. Never pending, accepted or **declined** slots. | Declined slots need a human (they are on the Gaps page). Never overwrite anyone. |
| D6 | Fairness key (lowest wins) | 1. `load = count × everyWeeks`, where count = the person's pending/accepted slots from 56 days before the first Monday up to the last Sunday (including what this run just planned). 2. Served longest ago (never served first). 3. `hash32(weekMonday + '|' + personId)`. 4. Person id. | (1) Shares work in proportion to what each person offered. (3) Breaks ties without always favouring the same name, and is still **deterministic**, so preview == apply. |
| D7 | Order slots are filled in | Week by week; inside a week the slot with the **fewest free candidates first** (ties: date, time, team sort, position sort, slot id). | Scarce people go where only they fit. |
| D8 | Preview vs apply | One endpoint, `apply: false` by default. Apply re-plans inside one transaction and calls `assignments.assign` for each slot (which re-checks every rule). | No stale-preview bugs. If a rule fails, the whole apply rolls back. |
| D9 | Status of auto-filled slots | `pending` (the volunteer must accept), exactly like a manual assignment. | No new status. Reminders and Gaps keep working. |
| D10 | Weekly automation | **Not built.** The scheduler presses the button (1–8 weeks at a time). | Flock has no background jobs. A timer or cron command is a later card. |
| D11 | Migration | **New file `0002_availability.sql`** (additive `CREATE TABLE`). | Unlike decision 0004 (people table rebuild), a new table is safe to add as a migration; `test/upgrade.test.js` covers it automatically. |
| D12 | Audit | Each apply writes the usual `slot.assign` entries (from `assignments.assign`) plus **one** `schedule.autofill` summary, and **nothing** when 0 slots were filled. Setting your own availability is **not** audited (like blockouts). | Matches the stress-test rule "exactly one audit entry per change". |

Not in scope (say no if asked during build): admin editing someone else's
frequency, preferred days or positions, refilling declined slots, changing
`gaps.suggest` ranking, notifications, background/cron runs.

## How the planner works (plain pseudocode)

```
planAutofill(today, start /* a Monday */, weeks, slots, history, people, availability, blockouts):
  end       = start + 7*weeks - 1
  countFrom = start - 56 days
  every(p)  = availability[p] if set, else 2

  held[p]      = dates of p's pending/accepted slots in history      // grows as we plan
  onService    = {(serviceId, p)} for every slot in history with a person, ANY status
                 // so: already on that service, or said no to it -> never asked for it again

  todo = slots where personId is null AND status == 'open' AND date >= today
  for each week (ascending Monday) in todo:
    remaining = todo slots of that week
    while remaining not empty:
      for each slot s in remaining:
        qualified(s) = active people with s.positionId in positionIds
        free(s)      = qualified(s) where
                         every(p) != 0                      // not paused
                         and not blocked out on s.date
                         and (s.serviceId, p) not in onService
                         and for all d in held[p]: weeksApart(d, s.date) >= every(p)
      s = slot with the fewest free(s); ties by date, time, teamSort, positionSort, id
      remove s from remaining
      if free(s) is empty:
        unfilled += s with reason 'nobody_qualified' if qualified(s) empty else 'nobody_free'
        continue
      best = min over free(s) by
               ( count(held[p] within [countFrom, end]) * every(p),
                 latest held[p] date before s.date   (none = first),
                 hash32(mondayOf(s.date) + '|' + p.id),
                 p.id )
      assigned += (s, best)
      held[best] += s.date ; onService += (s.serviceId, best)
  return { assigned sorted by slot order, unfilled sorted by slot order }

weeksApart(a, b) = |days between mondayOf(a) and mondayOf(b)| / 7
```

Worked examples (each is a test below):

| Situation | Result |
|---|---|
| 3 weekly volunteers, 6 Sundays | each gets 2 turns; weeks 4–6 repeat the order of weeks 1–3 |
| Pat every week, Quinn every 4 weeks, 4 Sundays | Quinn exactly 1, Pat exactly 3 |
| Pat (every 1) served twice, Quinn (every 4) once in the last 8 weeks | Pat: load 2 < Quinn's 4 |
| Keys: only Pat. Drums: Pat or Quinn (Pat would win Drums) | Keys → Pat, Drums → Quinn (most constrained first) |
| One weekly drummer, Saturday and Sunday service the same week | Saturday filled, Sunday `nobody_free` |

## Implementation guide

Read `ARCHITECTURE.md` and decisions 0001–0003 first. Rules that bite:
routes are thin; services never run SQL; only `src/data/sqlite` has SQL;
services never call `new Date()` (use `clock.now()`); only the container
builds services; views use **only CSS classes that already exist in
`web/style.css`** (`test/polish.test.js` fails otherwise); no `style=` or
`on*=` attributes.

Do the steps in order and run `npm test` after each. Each step lists the
exact code. Diffs are against `main` at `cb72451` and apply with
`git apply` (they were checked with `git apply --check`).

### Step 1. Migration — new file `src/migrations/0002_availability.sql`

```sql
CREATE TABLE availability (
  person_id INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  every_weeks INTEGER NOT NULL CHECK(every_weeks IN (0,1,2,3,4,6,8)),
  updated_at TEXT NOT NULL
);
```

### Step 2. Date helper — `src/dates.js`

```diff
--- a/src/dates.js
+++ b/src/dates.js
@@ -45,6 +45,12 @@ export function todayStr(now) {
   return `${p(now.getFullYear(), 4)}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
 }
 
+// The Monday on or before the date (weeks run Monday to Sunday).
+export function mondayOf(dateStr) {
+  const dow = new Date(need(dateStr)).getUTCDay(); // 0 = Sunday
+  return addDays(dateStr, -((dow + 6) % 7));
+}
+
 export function weekdayName(dateStr) { return DAYS[new Date(need(dateStr)).getUTCDay()]; }
 
 export function compareDates(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
```

### Step 3. Data layer

New file `src/data/sqlite/availability.js`:

```js
import { translate } from './util.js';

const toAvailability = (r) => ({ personId: r.person_id, everyWeeks: r.every_weeks, updatedAt: r.updated_at });

export function availabilityRepo({ db, run }) {
  const get = (personId) => {
    const r = db.prepare('SELECT person_id, every_weeks, updated_at FROM availability WHERE person_id = ?').get(personId);
    return r ? toAvailability(r) : null;
  };
  return {
    get: (personId) => run(() => get(personId)),

    set: (personId, { everyWeeks, updatedAt }) => run(() => {
      try {
        db.prepare(
          `INSERT INTO availability (person_id, every_weeks, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(person_id) DO UPDATE SET every_weeks = excluded.every_weeks, updated_at = excluded.updated_at`,
        ).run(personId, everyWeeks, updatedAt);
      } catch (e) {
        if (/CHECK constraint failed/i.test(String(e?.message))) throw new Error('every weeks must be 0, 1, 2, 3, 4, 6 or 8');
        throw translate(e, { missing: 'That person does not exist' });
      }
      return get(personId);
    }),

    mapAll: () => run(() => new Map(
      db.prepare('SELECT person_id, every_weeks FROM availability ORDER BY person_id').all()
        .map((r) => [r.person_id, r.every_weeks]),
    )),
  };
}
```

Wire it and document it (the architecture test reads these JSDoc typedefs
and requires every method to be called in `test/data/contract.js`):

```diff
--- a/src/data/sqlite/index.js
+++ b/src/data/sqlite/index.js
@@ -9,6 +9,7 @@ import { qualificationsRepo } from './qualifications.js';
 import { servicesRepo } from './services.js';
 import { slotsRepo } from './slots.js';
 import { blockoutsRepo } from './blockouts.js';
+import { availabilityRepo } from './availability.js';
 import { auditRepo } from './audit.js';
 import { maintenanceRepo } from './maintenance.js';
 
@@ -45,6 +46,7 @@ export function createSqliteData(db) {
       services: servicesRepo(ctx),
       slots: slotsRepo(ctx),
       blockouts: blockoutsRepo(ctx),
+      availability: availabilityRepo(ctx),
       audit: auditRepo(ctx),
       maintenance: maintenanceRepo(ctx),
     };
```

```diff
--- a/src/data/index.js
+++ b/src/data/index.js
@@ -245,6 +245,21 @@ export { DuplicateError, InUseError } from './errors.js';
  *   The person's pending/accepted slots on services in the inclusive range, sorted by date, time, slot id.
  */
 
+/**
+ * @typedef {object} Availability  How often a person is willing to serve.
+ * @property {number} personId
+ * @property {number} everyWeeks  0 = paused, else at most once every N weeks (1, 2, 3, 4, 6 or 8)
+ * @property {string} updatedAt  ISO time
+ */
+
+/**
+ * @typedef {object} AvailabilityRepo
+ * @property {(personId: number) => Promise<Availability|null>} get  null when the person never chose.
+ * @property {(personId: number, a: {everyWeeks: number, updatedAt: string}) => Promise<Availability>} set
+ *   Insert or replace the person's choice. Error for an unknown person or a value outside 0, 1, 2, 3, 4, 6, 8.
+ * @property {() => Promise<Map<number, number>>} mapAll  personId -> everyWeeks, for everyone who chose.
+ */
+
 /**
  * @typedef {object} AuditEntry
  * @property {number} id
@@ -280,6 +295,7 @@ export { DuplicateError, InUseError } from './errors.js';
  * @property {ServicesRepo} services
  * @property {SlotsRepo} slots
  * @property {BlockoutsRepo} blockouts
+ * @property {AvailabilityRepo} availability
  * @property {AuditRepo} audit
  * @property {MaintenanceRepo} maintenance
  * @property {<T>(fn: (d: Data) => T | Promise<T>) => Promise<T>} tx
```

### Step 4. Availability service — new file `src/services/availability-service.js`

```js
// Availability: how often a volunteer is willing to serve.
// Application service: all business rules for this area live here. It never
// sees HTTP objects and never runs SQL; it talks to the data layer through
// `deps.data` and throws AppErrors (src/errors.js). Built once by
// src/container.js.
import { ValidationError } from '../errors.js';

/** Allowed values: 0 = paused, else "at most once every N weeks". */
export const EVERY_WEEKS_CHOICES = Object.freeze([0, 1, 2, 3, 4, 6, 8]);
/** Used for anyone who has not chosen yet. */
export const DEFAULT_EVERY_WEEKS = 2;
export const EVERY_WEEKS_ERR = 'How often must be one of 0, 1, 2, 3, 4, 6 or 8 weeks';

/** The JSON shape: { everyWeeks, isDefault, updatedAt }. */
export function availabilityView(row) {
  return row
    ? { everyWeeks: row.everyWeeks, isDefault: false, updatedAt: row.updatedAt }
    : { everyWeeks: DEFAULT_EVERY_WEEKS, isDefault: true, updatedAt: null };
}

/**
 * @param {object} deps  Injected by src/container.js (nothing is imported or global).
 * @param {import("../data/index.js").Data} deps.data  The data layer.
 * @param {{now: () => Date}} deps.clock
 * @returns {object}
 */
export function createAvailabilityService(deps) {
  const { data, clock } = deps;
  return {
    /** The person's own choice, or the default when they never chose. */
    async getMine(personId) {
      return availabilityView(await data.availability.get(personId));
    },

    /** Save the person's own choice. everyWeeks must be one of EVERY_WEEKS_CHOICES. */
    async setMine(personId, { everyWeeks } = {}) {
      if (!EVERY_WEEKS_CHOICES.includes(everyWeeks)) throw new ValidationError(EVERY_WEEKS_ERR);
      return availabilityView(await data.availability.set(personId, { everyWeeks, updatedAt: clock.now().toISOString() }));
    },
  };
}
```

### Step 5. Auto-fill service — new file `src/services/autofill-service.js`

`planAutofill` is pure (no data, no clock) so it is tested with plain
objects. `run` loads everything inside **one** `data.tx`, plans, and on apply
calls `assignments.assign` for each planned slot. Calling another service
inside `data.tx` is safe: per decision 0002 a nested `data.tx` and top-level
data calls join the open transaction.

```js
// Auto-fill: put volunteers into the open slots of one or more weeks, fairly.
// Application service: all business rules for this area live here. It never
// sees HTTP objects and never runs SQL; it talks to the data layer through
// `deps.data` and throws AppErrors (src/errors.js). Built once by
// src/container.js. The plan itself is the pure function planAutofill.
import { ValidationError } from '../errors.js';
import { isValidDate, addDays, daysBetween, todayStr, mondayOf } from '../dates.js';
import { DEFAULT_EVERY_WEEKS } from './availability-service.js';

/** The most weeks one run may fill. */
export const MAX_AUTOFILL_WEEKS = 8;
/** Fairness looks back this many days before the first week. */
export const FAIRNESS_LOOKBACK_DAYS = 56;
/** Spacing looks this far after the last week (the longest choice, 8 weeks, minus one). */
const SPACING_AHEAD_DAYS = 49;
const HOLDING = ['pending', 'accepted'];

const isInt = (v) => Number.isSafeInteger(v);

/** Whole weeks between the Monday-to-Sunday weeks of two dates (0 = same week). */
export function weeksApart(a, b) {
  return Math.abs(daysBetween(mondayOf(a), mondayOf(b))) / 7;
}

/** FNV-1a: a stable 32-bit number for a text. Used only to break ties without favouring names. */
export function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const slotOrder = (a, b) => cmp(a.serviceDate, b.serviceDate) || cmp(a.serviceTime, b.serviceTime)
  || a.teamSort - b.teamSort || a.positionSort - b.positionSort || a.id - b.id;

const slotInfo = (s) => ({
  slotId: s.id,
  serviceId: s.serviceId,
  date: s.serviceDate,
  time: s.serviceTime,
  serviceTitle: s.serviceTitle,
  teamName: s.teamName,
  positionName: s.positionName,
});

/**
 * Pure: decide who goes where. Nothing is read or written here.
 * @param {object} input
 * @param {string} input.today  YYYY-MM-DD; slots before it are left alone
 * @param {string} input.start  the Monday of the first week
 * @param {number} input.weeks  1 to 8
 * @param {object[]} input.slots  data.slots.listForServices(start, end)
 * @param {object[]} input.history  data.slots.assignedBetween(start - 56 days, end + 49 days)
 * @param {object[]} input.people  data.people.list()
 * @param {Map<number, number>} input.availability  data.availability.mapAll()
 * @param {object[]} input.blockouts  data.blockouts.listRange(start, end)
 * @returns {{assigned: object[], unfilled: object[]}}  both in slot order
 */
export function planAutofill({ today, start, weeks, slots, history, people, availability, blockouts }) {
  const end = addDays(start, 7 * weeks - 1);
  const countFrom = addDays(start, -FAIRNESS_LOOKBACK_DAYS);
  const everyOf = (id) => (availability.has(id) ? availability.get(id) : DEFAULT_EVERY_WEEKS);
  const isBlocked = (id, date) => blockouts.some((b) => b.personId === id && b.startDate <= date && date <= b.endDate);

  const held = new Map(); // personId -> dates of pending/accepted slots (existing and planned)
  const onService = new Set(); // `${serviceId}:${personId}`: already on it, or said no to it
  for (const s of history) {
    onService.add(`${s.serviceId}:${s.personId}`);
    if (!HOLDING.includes(s.status)) continue;
    if (!held.has(s.personId)) held.set(s.personId, []);
    held.get(s.personId).push(s.serviceDate);
  }
  const active = people.filter((p) => p.active);

  function candidates(slot) {
    const qualified = active.filter((p) => p.positionIds.includes(slot.positionId));
    const free = qualified.filter((p) => {
      const n = everyOf(p.id);
      if (n === 0) return false;
      if (isBlocked(p.id, slot.serviceDate)) return false;
      if (onService.has(`${slot.serviceId}:${p.id}`)) return false;
      return (held.get(p.id) ?? []).every((d) => weeksApart(d, slot.serviceDate) >= n);
    });
    return { qualified, free };
  }

  function rank(p, slot) {
    const dates = held.get(p.id) ?? [];
    const count = dates.filter((d) => d >= countFrom && d <= end).length;
    const before = dates.filter((d) => d < slot.serviceDate).sort();
    return {
      load: count * everyOf(p.id),
      last: before.length ? before[before.length - 1] : null,
      tie: hash32(`${mondayOf(slot.serviceDate)}|${p.id}`),
      id: p.id,
    };
  }
  const better = (a, b) => a.load - b.load
    || (a.last === b.last ? 0 : a.last === null ? -1 : b.last === null ? 1 : cmp(a.last, b.last))
    || a.tie - b.tie
    || a.id - b.id;

  const todo = slots.filter((s) => s.personId === null && s.status === 'open' && s.serviceDate >= today);
  const byWeek = new Map();
  for (const s of todo) {
    const w = mondayOf(s.serviceDate);
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(s);
  }

  const assigned = [];
  const unfilled = [];
  for (const week of [...byWeek.keys()].sort()) {
    const remaining = byWeek.get(week);
    while (remaining.length) {
      // Most constrained slot first, so scarce people go where only they fit.
      let pick = null;
      for (const s of remaining) {
        const c = candidates(s);
        if (!pick || c.free.length < pick.c.free.length || (c.free.length === pick.c.free.length && slotOrder(s, pick.s) < 0)) {
          pick = { s, c };
        }
      }
      remaining.splice(remaining.indexOf(pick.s), 1);
      const { s, c } = pick;
      if (!c.free.length) {
        unfilled.push(c.qualified.length
          ? { ...slotInfo(s), reason: 'nobody_free', message: `Everyone set up for ${s.positionName} is away, paused, already serving that week or served too recently` }
          : { ...slotInfo(s), reason: 'nobody_qualified', message: `Nobody is set up for ${s.positionName}` });
        continue;
      }
      const best = c.free.map((p) => ({ p, r: rank(p, s) })).sort((a, b) => better(a.r, b.r))[0].p;
      assigned.push({ ...slotInfo(s), personId: best.id, personName: best.name, everyWeeks: everyOf(best.id) });
      if (!held.has(best.id)) held.set(best.id, []);
      held.get(best.id).push(s.serviceDate);
      onService.add(`${s.serviceId}:${best.id}`);
    }
  }
  const order = new Map(todo.map((s) => [s.id, s]));
  const bySlot = (a, b) => slotOrder(order.get(a.slotId), order.get(b.slotId));
  return { assigned: assigned.sort(bySlot), unfilled: unfilled.sort(bySlot) };
}

/**
 * @param {object} deps  Injected by src/container.js (nothing is imported or global).
 * @param {import("../data/index.js").Data} deps.data  The data layer.
 * @param {{now: () => Date}} deps.clock
 * @param {{assign: Function}} deps.assignments  The assignments service (re-checks every rule on apply).
 * @returns {object}
 */
export function createAutofillService(deps) {
  const { data, clock, assignments } = deps;
  const today = () => todayStr(clock.now());

  return {
    /**
     * Plan (and with apply: true, make) assignments for the open slots of
     * `weeks` weeks (1-8, default 1) starting the Monday of `weekOf` (default:
     * next week). Planning and applying run in one transaction, so the
     * preview and the result match when nothing changed in between.
     * @param {{id: number}} actor
     * @param {{weekOf?: string, weeks?: number, apply?: boolean}} input
     */
    async run(actor, { weekOf, weeks = 1, apply = false } = {}) {
      const now = today();
      const day = weekOf === undefined ? addDays(now, 7) : weekOf;
      if (!isValidDate(day)) throw new ValidationError('Week of must be a real date like 2026-03-02');
      if (!isInt(weeks) || weeks < 1 || weeks > MAX_AUTOFILL_WEEKS) {
        throw new ValidationError(`Weeks must be a whole number from 1 to ${MAX_AUTOFILL_WEEKS}`);
      }
      if (typeof apply !== 'boolean') throw new ValidationError('Apply must be true or false');
      const start = mondayOf(day);
      const end = addDays(start, 7 * weeks - 1);
      if (end < now) throw new ValidationError('Those weeks are already over');
      return data.tx(async (d) => {
        const plan = planAutofill({
          today: now,
          start,
          weeks,
          slots: await d.slots.listForServices(start, end),
          history: await d.slots.assignedBetween(addDays(start, -FAIRNESS_LOOKBACK_DAYS), addDays(end, SPACING_AHEAD_DAYS)),
          people: await d.people.list(),
          availability: await d.availability.mapAll(),
          blockouts: await d.blockouts.listRange(start, end),
        });
        if (apply && plan.assigned.length) {
          for (const a of plan.assigned) await assignments.assign(actor, a.slotId, { personId: a.personId });
          await d.audit.log({
            at: clock.now(),
            actorId: actor?.id ?? null,
            action: 'schedule.autofill',
            detail: `${start} for ${weeks} week(s): ${plan.assigned.length} assigned, ${plan.unfilled.length} left open`,
          });
        }
        return { applied: apply, weekOf: start, weeks, ...plan };
      });
    },
  };
}
```

### Step 6. Container — `src/container.js`

```diff
--- a/src/container.js
+++ b/src/container.js
@@ -24,6 +24,8 @@ import { createCalendarService } from './services/calendar-service.js';
 import { createBlockoutsService } from './services/blockouts-service.js';
 import { createAssignmentsService } from './services/assignments-service.js';
 import { createGapsService } from './services/gaps-service.js';
+import { createAvailabilityService } from './services/availability-service.js';
+import { createAutofillService } from './services/autofill-service.js';
 
 /** Infrastructure every service may ask for. */
 export const CORE_DEPS = Object.freeze(['data', 'clock', 'random', 'hasher', 'logger', 'config']);
@@ -41,6 +43,8 @@ export const SERVICE_SPECS = Object.freeze({
   blockouts: { factory: createBlockoutsService, needs: [...CORE] },
   assignments: { factory: createAssignmentsService, needs: [...CORE, 'people', 'teams', 'calendar', 'blockouts'] },
   gaps: { factory: createGapsService, needs: [...CORE, 'teams', 'calendar', 'blockouts', 'assignments'] },
+  availability: { factory: createAvailabilityService, needs: [...CORE] },
+  autofill: { factory: createAutofillService, needs: [...CORE, 'assignments'] },
 });
 
 export class ContainerError extends Error {
```

### Step 7. Routes

New file `src/routes/availability.js`. Importing a plain constant from a
service module is allowed by the architecture test; never import a
`create...Service` factory outside the container.

```js
// Availability: thin HTTP adapters over the availability service.
import { v, parse } from '../validate.js';
import { EVERY_WEEKS_CHOICES } from '../services/availability-service.js';

const ok = (json, status = 200) => ({ status, json });
const setBody = v.object({ everyWeeks: v.enum([...EVERY_WEEKS_CHOICES]).label('How often') }, { strict: true });

export function register(router, ctx) {
  const availability = () => ctx.services.availability;

  router.add('GET', '/api/me/availability', async ({ user }) => (
    ok({ availability: await availability().getMine(user.id) })
  ), { auth: 'login' });

  router.add('PUT', '/api/me/availability', async ({ user, body }) => {
    const { everyWeeks } = parse(setBody, body);
    return ok({ availability: await availability().setMine(user.id, { everyWeeks }) });
  }, { auth: 'login' });
}
```

```diff
--- a/src/routes/index.js
+++ b/src/routes/index.js
@@ -14,8 +14,9 @@ import * as services from './services.js';
 import * as assignments from './assignments.js';
 import * as blockouts from './blockouts.js';
 import * as admin from './admin.js';
+import * as availability from './availability.js';
 
-export const ROUTE_MODULES = Object.freeze([auth, people, teams, services, assignments, blockouts, admin]);
+export const ROUTE_MODULES = Object.freeze([auth, people, teams, services, assignments, blockouts, availability, admin]);
 
 export function register(router, deps) {
   if (!deps || !deps.services) throw new Error('Routes need deps.services (build them with createContainer)');
```

Auto-fill goes with the other scheduler tools in `src/routes/admin.js`:

```diff
--- a/src/routes/admin.js
+++ b/src/routes/admin.js
@@ -8,6 +8,11 @@ const flagSchema = v.enum(['true', 'false', '1', '0']).label('Include unqualifie
 
 // '' and a missing value both mean "use the default".
 const opt = (x) => (x === undefined || x === '' ? undefined : x);
+const autofillBody = v.object({
+  weekOf: v.date().optional(),
+  weeks: v.integer({ min: 1, max: 8 }).default(1),
+  apply: v.boolean().default(false),
+}, { strict: true });
 
 export function register(router, ctx) {
   const gaps = () => ctx.services.gaps;
@@ -23,6 +28,10 @@ export function register(router, ctx) {
     return ok(await gaps().suggest({ slotId, includeUnqualified }));
   }, { auth: 'admin' });
 
+  router.add('POST', '/api/admin/autofill', async ({ body, user }) => (
+    ok(await ctx.services.autofill.run(user, parse(autofillBody, body)))
+  ), { auth: 'admin' });
+
   router.add('GET', '/api/admin/reminders', async ({ query }) => (
     ok({ reminders: await gaps().reminders({ weekOf: opt(query.weekOf) }) })
   ), { auth: 'admin' });
```

API summary:

| Method and path | Auth | Body | 200 response |
|---|---|---|---|
| `GET /api/me/availability` | login | — | `{ availability: { everyWeeks, isDefault, updatedAt } }` |
| `PUT /api/me/availability` | login + `X-Flock` | `{ everyWeeks: 0\|1\|2\|3\|4\|6\|8 }` (strict: other keys are 400) | same as GET |
| `POST /api/admin/autofill` | admin + `X-Flock` | `{ weekOf?: 'YYYY-MM-DD', weeks?: 1..8 (default 1), apply?: boolean (default false) }` (strict) | `{ applied, weekOf /* the Monday */, weeks, assigned: [...], unfilled: [...] }` |

`assigned[i]` = `{ slotId, serviceId, date, time, serviceTitle, teamName,
positionName, personId, personName, everyWeeks }`. `unfilled[i]` = `{ slotId,
serviceId, date, time, serviceTitle, teamName, positionName, reason:
'nobody_qualified'|'nobody_free', message }`. Errors: 400 for bad input or
"Those weeks are already over", 403 for members, 401 logged out.

### Step 8. Volunteer UI — `web/views/my-blockouts.js`

A "How often can you serve?" card above "Add days off". No new page, so the
route table, nav, gallery and security view list do not change.

Watch out: the submit handler must dispatch on `form.dataset.form`. The test
fake's `closest()` returns the target whatever the selector, so checking
`closest('form[data-form="blockout"]')` alone would send the availability
form to `add()`. The availability `GET` also repaints when it lands.

```diff
--- a/web/views/my-blockouts.js
+++ b/web/views/my-blockouts.js
@@ -18,6 +18,34 @@ export function checkForm({ from, to }) {
   return '';
 }
 
+// How often a volunteer can serve; the values match EVERY_WEEKS_CHOICES on the server.
+export const FREQUENCIES = Object.freeze([
+  [1, 'Every week'],
+  [2, 'Every 2 weeks'],
+  [3, 'Every 3 weeks'],
+  [4, 'Every 4 weeks'],
+  [6, 'Every 6 weeks'],
+  [8, 'Every 8 weeks'],
+  [0, 'Not right now (pause)'],
+]);
+
+export function frequencyLabel(n) {
+  return FREQUENCIES.find(([v]) => v === n)?.[1] ?? '';
+}
+
+function availabilityCard(a, busy) {
+  const current = a?.everyWeeks ?? 2;
+  return html`<form class="form card form-card" data-form="availability" novalidate>
+      <h2 class="card-title">How often can you serve?</h2>
+      <div class="field">
+        <label for="av-every">I can serve</label>
+        <select id="av-every" name="everyWeeks">${FREQUENCIES.map(([v, label]) => html`<option value="${v}"${v === current ? html` selected` : ''}>${label}</option>`)}</select>
+      </div>
+      <p class="hint">${a && !a.isDefault ? 'Flock uses this when it fills the schedule.' : 'You have not chosen yet, so Flock asks you at most every 2 weeks.'}</p>
+      <button type="submit" class="btn btn-primary btn-block" ${busy}>Save</button>
+    </form>`;
+}
+
 export function conflictLine(c) {
   return `You are already scheduled on ${formatDate(c.date)} as ${c.positionName}. Please tell your scheduler.`;
 }
@@ -52,6 +80,7 @@ export function render(state, view = { loading: true }) {
     ${conflicts.length ? html`<div class="notice notice-warn" role="alert" data-conflicts>
       ${iconSlot('warning', 'notice-icon')}<div class="notice-body"><ul>${conflicts.map((c) => html`<li>${conflictLine(c)}</li>`)}</ul></div>
     </div>` : ''}
+    ${availabilityCard(view.availability, busy)}
     <form class="form card form-card" data-form="blockout" novalidate>
       <h2 class="card-title">Add days off</h2>
       <div class="field-pair">
@@ -92,6 +121,34 @@ export function mount(main, ctx) {
     paint();
   }
 
+  async function loadAvailability() {
+    try {
+      const r = await ctx.api.get('/api/me/availability');
+      view.availability = r?.availability ?? null;
+    } catch {
+      view.availability = null; // the form still shows the default
+    }
+    paint();
+  }
+
+  async function saveAvailability(form) {
+    const everyWeeks = Number(form.everyWeeks?.value);
+    view.message = null;
+    view.problem = null;
+    view.conflicts = [];
+    view.busy = true;
+    paint();
+    try {
+      const r = await ctx.api.put('/api/me/availability', { everyWeeks });
+      view.availability = r?.availability ?? null;
+      view.message = everyWeeks === 0 ? 'Saved. Flock will not ask you for now.' : `Saved. ${frequencyLabel(everyWeeks)} at most.`;
+    } catch (err) {
+      view.problem = err?.message || GENERIC;
+    }
+    view.busy = false;
+    paint();
+  }
+
   async function add(form) {
     const values = {
       from: String(form.from?.value ?? '').trim(),
@@ -142,12 +199,13 @@ export function mount(main, ctx) {
     if (el.dataset.action === 'retry') { view.loading = true; paint(); return load(); }
   });
   root.addEventListener('submit', (e) => {
-    const form = e.target?.closest?.('form[data-form="blockout"]');
+    const form = e.target?.closest?.('form[data-form]');
     if (!form) return;
     e.preventDefault();
+    if (form.dataset.form === 'availability') return saveAvailability(form.elements);
     return add(form.elements);
   });
 
   paint();
-  return load();
+  return Promise.all([loadAvailability(), load()]);
 }
```

### Step 9. Scheduler UI — `web/views/admin-schedule.js`

A "Fill open positions" card under the date-range hint: week picker (defaults
to the next Monday), weeks select (1–8), **Preview**, then the list of who
would be asked and what stays open, with **Ask these people** / **Cancel**.
After applying, the schedule reloads and a notice says how many were asked.
`renderScreen` is also called by the gallery and tests with hand-made models
that have no `autofill` key; hence `m.autofill ?? { weekOf: '', weeks: 1 }`.

```diff
--- a/web/views/admin-schedule.js
+++ b/web/views/admin-schedule.js
@@ -44,6 +44,15 @@ export function buildSchedule(services, teams) {
   return { columns: columns.filter((c) => c.positions.length), rows };
 }
 
+// The Monday after today (today itself is never returned): the default week to fill.
+export function nextMonday(today) {
+  const [y, m, d] = String(today).split('-').map(Number);
+  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
+  return addDays(today, ((8 - dow) % 7) || 7);
+}
+
+export const AUTOFILL_MAX_WEEKS = 8;
+
 // The slot as the panel wants it (adds the service's date, time and title).
 export const panelSlot = (slot, svc) => ({ ...slot, date: svc.date, time: svc.time, title: svc.title });
 
@@ -96,6 +105,41 @@ function cards(s, today) {
   </li>`)}</ul>`;
 }
 
+function autofillCard(a) {
+  const busy = a.busy ? 'disabled' : '';
+  const r = a.result;
+  let body = '';
+  if (r) {
+    body = html`<div data-autofill-result>
+      <h3 class="team-title">Who Flock would ask (${r.assigned.length})</h3>
+      ${r.assigned.length ? html`<ul class="list">${r.assigned.map((x) => html`<li data-autofill-slot="${x.slotId}">
+        <span class="num">${formatDate(x.date)} ${formatTime(x.time)}</span>: ${x.teamName} / ${x.positionName}: <strong>${x.personName}</strong>
+      </li>`)}</ul>` : html`<p class="hint">Nobody can be asked for these weeks.</p>`}
+      ${r.unfilled.length ? html`<h3 class="team-title">Still open (${r.unfilled.length})</h3>
+      <ul class="list">${r.unfilled.map((x) => html`<li data-autofill-open="${x.slotId}">
+        <span class="num">${formatDate(x.date)} ${formatTime(x.time)}</span>: ${x.teamName} / ${x.positionName}. <span class="hint">${x.message}</span>
+      </li>`)}</ul>` : ''}
+      <div class="btn-row">
+        ${r.assigned.length ? html`<button type="button" class="btn btn-primary" data-action="autofill-apply" ${busy}>Ask these people</button>` : ''}
+        <button type="button" class="btn" data-action="autofill-cancel" ${busy}>Cancel</button>
+      </div>
+    </div>`;
+  }
+  return html`<section class="card form-card" data-autofill>
+    <h2 class="card-title">Fill open positions</h2>
+    <p class="hint">Flock picks people who are set up for the position, are not away, and have not served more often than they said they can. Nothing changes until you choose "Ask these people".</p>
+    ${toasts([[a.error, 'error']])}
+    <form class="form form-inline" data-form="autofill" novalidate>
+      <div class="field"><label for="af-week">Week starting</label>
+        <input id="af-week" name="weekOf" type="date" required value="${a.weekOf}"></div>
+      <div class="field"><label for="af-weeks">Weeks</label>
+        <select id="af-weeks" name="weeks">${Array.from({ length: AUTOFILL_MAX_WEEKS }, (_, i) => i + 1).map((n) => html`<option value="${n}"${n === a.weeks ? html` selected` : ''}>${n}</option>`)}</select></div>
+      <button type="submit" class="btn btn-primary" ${busy}>Preview</button>
+    </form>
+    ${body}
+  </section>`;
+}
+
 export function renderScreen(m, panelHtml = '') {
   if (m.loading) return String(skeleton('Loading…', 'rows', 6));
   const s = buildSchedule(m.services, m.teams);
@@ -104,6 +148,7 @@ export function renderScreen(m, panelHtml = '') {
     ${toasts([[m.notice, 'ok']])}
     ${panelHtml}
     <p class="hint sched-range">${iconSlot('calendar', 'icon-sm')} <span class="num">${formatDate(m.from)} to ${formatDate(m.to)}</span>. Tap a position to fill it.</p>
+    ${autofillCard(m.autofill ?? { weekOf: '', weeks: 1 })}
     ${s.rows.length ? html`${grid(s, m.today)}${cards(s, m.today)}`
     : emptyState(`No services in the next ${WEEKS} weeks. Add them on the Services page.`, 'art-calendar')}
   `);
@@ -112,7 +157,10 @@ export function renderScreen(m, panelHtml = '') {
 // ---------- screen controller ----------
 
 export function createScreen({ api, root, today = todayString() }) {
-  const m = { services: [], teams: [], loading: true, error: '', notice: '', today, from: today, to: addDays(today, WEEKS * 7 - 1) };
+  const m = {
+    services: [], teams: [], loading: true, error: '', notice: '', today, from: today, to: addDays(today, WEEKS * 7 - 1),
+    autofill: { weekOf: nextMonday(today), weeks: 1, input: null, result: null, busy: false, error: '' },
+  };
   const paint = () => {
     sheet.before();
     root.innerHTML = renderScreen(m, panel.render());
@@ -143,11 +191,63 @@ export function createScreen({ api, root, today = todayString() }) {
     return null;
   }
 
+  async function preview(form) {
+    const a = m.autofill;
+    const weekOf = String(form?.weekOf?.value ?? '').trim();
+    const weeks = Number(form?.weeks?.value ?? 1);
+    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) { a.error = 'Please pick a date.'; paint(); return; }
+    a.weekOf = weekOf;
+    a.weeks = weeks;
+    a.busy = true;
+    a.error = '';
+    a.result = null;
+    m.notice = '';
+    paint();
+    try {
+      const r = await api.post('/api/admin/autofill', { weekOf, weeks, apply: false });
+      a.input = { weekOf, weeks };
+      a.result = { assigned: r?.assigned ?? [], unfilled: r?.unfilled ?? [] };
+    } catch (err) {
+      a.error = String(err?.message || 'Could not plan those weeks.');
+    }
+    a.busy = false;
+    paint();
+  }
+
+  async function applyPlan() {
+    const a = m.autofill;
+    if (!a.input || a.busy) return;
+    a.busy = true;
+    a.error = '';
+    paint();
+    try {
+      const r = await api.post('/api/admin/autofill', { ...a.input, apply: true });
+      const n = r?.assigned?.length ?? 0;
+      a.result = null;
+      a.input = null;
+      m.notice = n === 1 ? 'Asked 1 person. They will see it in My schedule.' : `Asked ${n} people. They will see it in My schedule.`;
+      await reload();
+    } catch (err) {
+      a.error = String(err?.message || 'Could not fill those weeks.');
+    }
+    a.busy = false;
+    paint();
+  }
+
+  root.addEventListener('submit', (e) => {
+    const form = e.target?.closest?.('form[data-form]');
+    if (!form || form.dataset.form !== 'autofill') return undefined;
+    e.preventDefault();
+    return preview(form.elements);
+  });
+
   root.addEventListener('click', (e) => {
     const el = e.target?.closest?.('[data-action]');
     if (!el) return undefined;
     const action = el.dataset.action;
     const id = Number(el.dataset.id);
+    if (action === 'autofill-apply') return applyPlan();
+    if (action === 'autofill-cancel') { m.autofill.result = null; m.autofill.input = null; paint(); return undefined; }
     if (action === 'slot-open') {
       const slot = findSlot(id);
       if (!slot) return undefined;
```

### Step 10. Docs

```diff
--- a/README.md
+++ b/README.md
@@ -94,7 +94,10 @@ Everyone sees:
 - **Days I can't serve** is where you add the dates you are away (up to a
   year at a time), with a reason if you like. Flock will not suggest you to
   the scheduler for those days. If you are already scheduled on one of those days,
-  Flock tells you so you can let your scheduler know.
+  Flock tells you so you can let your scheduler know. At the top of the same
+  page, **How often can you serve?** lets you choose every week, every 2, 3,
+  4, 6 or 8 weeks, or a pause. Until you choose, Flock asks you at most every
+  2 weeks.
 
 Schedulers also see:
 
@@ -109,6 +112,14 @@ Schedulers also see:
   away, and have not served too often lately. It warns you about clashes
   (away that day, not set up for that position, already serving that
   morning). You can still go ahead if you really mean to.
+  **Fill open positions** plans one to 8 weeks at a time: it puts someone in
+  every empty position it can, fairly, and shows you the plan first. Flock
+  only picks people who are set up for the position, are not away, and have
+  not served more often than they said they can. Among those it picks whoever
+  has served least for how often they offered, then whoever served longest
+  ago. Nobody is asked until you choose **Ask these people**; then they see it
+  in My schedule as waiting for their answer. Positions nobody can fill stay
+  empty and show on the Gaps page.
 - **Gaps** shows the next 4 weeks of positions that still need attention:
   empty, declined, not answered, held by someone who is away, or by someone
   who is no longer active. It also writes **reminder messages** for a chosen
```

```diff
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -1,5 +1,13 @@
 # Changelog
 
+## Unreleased
+
+### Fill open positions and how often volunteers serve
+
+- Volunteers choose how often they can serve (every week, every 2, 3, 4, 6 or 8 weeks, or a pause) on "Days I can't serve". The default is every 2 weeks.
+- Schedulers preview and then apply a fair plan for the open positions of 1 to 8 weeks on the Schedule page (`POST /api/admin/autofill`).
+- New table `availability` (migration `0002_availability.sql`).
+
 ## 0.2.0
 
 ### Invite links
```

## Test plan

Run `npm test`. It must stay under 60 s (it takes about 4 s) and end with
**0 failures**. The prototype ended with 687 tests, all passing.

### Existing tests that MUST change (and only these)

| File | Why it breaks | Change |
|---|---|---|
| `test/architecture.test.js` | lists services, counts 7 service imports, lists repositories | add `availability`, `autofill`; 7 → 9; add `'availability'` to the repo list |
| `test/container.test.js` | `SERVICE_NAMES` | add `'availability', 'autofill'` |
| `test/db.test.js` | assumes 1 migration | `n` 1 → 2; two `applied_at` values; add the `availability` columns; cascade + CHECK tests |
| `test/member-ui.test.js` | the days-off page now makes 2 GETs on load | `calls.length === 1` → exact list of the 2 GETs; the POST is now `calls[2]` |
| `test/helpers/fakeroot.js` | its fake api has no `put` | add `put` |
| `test/data/contract.js` | every repo method must be called there | new `availability` block |

```diff
--- a/test/architecture.test.js
+++ b/test/architecture.test.js
@@ -130,13 +130,13 @@ test('architecture: the scan covers the layers', () => {
   for (const f of ['src/container.js', 'src/server.js', 'src/db.js', 'src/data/index.js', 'src/routes/index.js', 'bin/flock.js']) {
     assert.ok(names.includes(f), `${f} was not scanned`);
   }
-  for (const s of ['auth', 'people', 'teams', 'calendar', 'blockouts', 'assignments', 'gaps']) {
+  for (const s of ['auth', 'people', 'teams', 'calendar', 'blockouts', 'assignments', 'gaps', 'availability', 'autofill']) {
     assert.ok(names.includes(`src/services/${s}-service.js`), `missing service ${s}`);
   }
   // The container really is wired: it imports the db layer and every service.
   const c = files.find((f) => f.file === 'src/container.js');
   assert.ok(c.imports.some((im) => im.target === 'src/db.js'));
-  assert.equal(c.imports.filter((im) => im.target.startsWith('src/services/')).length, 7);
+  assert.equal(c.imports.filter((im) => im.target.startsWith('src/services/')).length, 9);
 });
 
 // ---------- self-tests of the scanner, so the rules cannot pass by accident ----------
@@ -271,7 +271,7 @@ test('data interface: every repository method in src/data/index.js has a contrac
   const contract = lex(readFileSync(path.join(ROOT, 'test/data/contract.js'), 'utf8')).code;
   const { repos, dataProps } = interfaceMethods(src);
   assert.deepEqual(Object.keys(repos).sort(),
-    ['audit', 'blockouts', 'invites', 'maintenance', 'people', 'positions', 'qualifications', 'services', 'sessions', 'slots', 'teams']);
+    ['audit', 'availability', 'blockouts', 'invites', 'maintenance', 'people', 'positions', 'qualifications', 'services', 'sessions', 'slots', 'teams']);
   assert.ok(dataProps.includes('tx'));
   const missing = [];
   let count = 0;
```

```diff
--- a/test/container.test.js
+++ b/test/container.test.js
@@ -12,7 +12,7 @@ import { makeContainer } from './helpers/container.js';
 import { startTestApp } from './helpers/app.js';
 import { listJs, analyse } from './helpers/source.js';
 
-const SERVICE_NAMES = ['auth', 'people', 'teams', 'calendar', 'blockouts', 'assignments', 'gaps'];
+const SERVICE_NAMES = ['auth', 'people', 'teams', 'calendar', 'blockouts', 'assignments', 'gaps', 'availability', 'autofill'];
 const memConfig = () => ({ ...loadConfig({}), dbPath: ':memory:' });
 
 test('container: defaults are the real system parts', () => {
```

```diff
--- a/test/db.test.js
+++ b/test/db.test.js
@@ -29,6 +29,7 @@ test('schema has all tables and columns', () => {
     slots: ['id', 'service_id', 'position_id', 'person_id', 'status', 'assigned_at', 'responded_at'],
     blockouts: ['id', 'person_id', 'start_date', 'end_date', 'reason', 'created_at'],
     audit: ['id', 'at', 'actor_id', 'action', 'detail'],
+    availability: ['person_id', 'every_weeks', 'updated_at'],
   };
   for (const [t, c] of Object.entries(want)) assert.deepEqual(cols(db, t).sort(), [...c].sort(), t);
 });
@@ -41,7 +42,7 @@ test('migrations are idempotent on a file db', () => {
     person(db);
     db.close();
     db = openDb(f);
-    assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n, 1);
+    assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n, 2);
     assert.equal(db.prepare('SELECT COUNT(*) n FROM people').get().n, 1);
     db.close();
   } finally {
@@ -49,6 +50,18 @@ test('migrations are idempotent on a file db', () => {
   }
 });
 
+test('availability only takes the listed choices and a real person', () => {
+  const db = openDb();
+  const a = person(db);
+  for (const n of [0, 1, 2, 3, 4, 6, 8]) {
+    db.prepare('INSERT OR REPLACE INTO availability (person_id,every_weeks,updated_at) VALUES (?,?,?)').run(a, n, T);
+  }
+  for (const n of [-1, 5, 7, 9]) {
+    assert.throws(() => db.prepare('INSERT OR REPLACE INTO availability (person_id,every_weeks,updated_at) VALUES (?,?,?)').run(a, n, T), /CHECK/);
+  }
+  assert.throws(() => db.prepare('INSERT INTO availability (person_id,every_weeks,updated_at) VALUES (?,?,?)').run(999, 2, T), /FOREIGN KEY/);
+});
+
 test('foreign keys enforced', () => {
   const db = openDb();
   assert.throws(() => db.prepare('INSERT INTO sessions (token_hash,person_id,expires_at,created_at) VALUES (?,?,?,?)').run('t', 99, T, T));
@@ -65,10 +78,11 @@ test('cascades and set null', () => {
   db.prepare('INSERT INTO sessions (token_hash,person_id,expires_at,created_at) VALUES (?,?,?,?)').run('t', a, T, T);
   db.prepare('INSERT INTO blockouts (person_id,start_date,end_date,created_at) VALUES (?,?,?,?)').run(a, '2025-01-01', '2025-01-02', T);
   db.prepare('INSERT INTO person_positions VALUES (?,?)').run(a, t2.p);
+  db.prepare('INSERT INTO availability (person_id,every_weeks,updated_at) VALUES (?,?,?)').run(a, 2, T);
   const s = Number(db.prepare('INSERT INTO services (date,title) VALUES (?,?)').run('2025-01-05', 'Sun').lastInsertRowid);
   db.prepare("INSERT INTO slots (service_id,position_id,person_id,status) VALUES (?,?,?,'declined')").run(s, t2.p, a);
   db.prepare('DELETE FROM people WHERE id=?').run(a);
-  for (const tb of ['sessions', 'blockouts', 'person_positions']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${tb}`).get().n, 0, tb);
+  for (const tb of ['sessions', 'blockouts', 'person_positions', 'availability']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${tb}`).get().n, 0, tb);
   assert.equal(db.prepare('SELECT person_id FROM slots').get().person_id, null);
   assert.ok(p);
 });
@@ -127,7 +141,7 @@ test('logAudit truncates and stores', () => {
 test('migration time comes from the injected clock (no direct new Date())', () => {
   const clock = { now: () => new Date('2030-02-03T04:05:06.000Z') };
   const db = openDb(':memory:', { clock });
-  assert.deepEqual(db.prepare('SELECT applied_at FROM schema_migrations').all().map((r) => r.applied_at), ['2030-02-03T04:05:06.000Z']);
+  assert.deepEqual(db.prepare('SELECT applied_at FROM schema_migrations').all().map((r) => r.applied_at), ['2030-02-03T04:05:06.000Z', '2030-02-03T04:05:06.000Z']);
   db.close();
   // Without a clock SQLite's own clock records a valid ISO time.
   const plain = openDb();
```

```diff
--- a/test/helpers/fakeroot.js
+++ b/test/helpers/fakeroot.js
@@ -43,5 +43,5 @@ export function fakeApi(routes) {
     if (r instanceof Error) throw r;
     return r ?? {};
   };
-  return { calls, get: (p) => run('GET', p), post: (p, b = {}) => run('POST', p, b), del: (p) => run('DELETE', p) };
+  return { calls, get: (p) => run('GET', p), post: (p, b = {}) => run('POST', p, b), put: (p, b = {}) => run('PUT', p, b), del: (p) => run('DELETE', p) };
 }
```

```diff
--- a/test/member-ui.test.js
+++ b/test/member-ui.test.js
@@ -137,10 +137,10 @@ test('days off: form is prefilled, validated, and posts', async () => {
   assert.match(root.innerHTML, /Please pick/);
   await root.submit('blockout', { from: '2026-11-10', to: '2026-11-09', reason: '' });
   assert.match(root.innerHTML, /be before the/);
-  assert.equal(api.calls.length, 1);
+  assert.deepEqual(api.calls, ['GET /api/me/availability', 'GET /api/me/blockouts']);
 
   await root.submit('blockout', { from: '2026-11-10', to: '2026-11-12', reason: 'Trip' });
-  assert.equal(api.calls[1], 'POST /api/me/blockouts {"startDate":"2026-11-10","endDate":"2026-11-12","reason":"Trip"}');
+  assert.equal(api.calls[2], 'POST /api/me/blockouts {"startDate":"2026-11-10","endDate":"2026-11-12","reason":"Trip"}');
   assert.match(root.innerHTML, /Saved/);
   assert.doesNotMatch(root.innerHTML, /data-conflicts/);
 });
@@ -164,6 +164,35 @@ test('days off: conflict notice, list, remove, errors', async () => {
   assert.match(bad.root.innerHTML, /That is too long\./);
 });
 
+test('how often: shows the default, then saves a choice with PUT', async () => {
+  const { root, api } = await setup(off, {
+    'GET /api/me/blockouts': { blockouts: [] },
+    'GET /api/me/availability': { availability: { everyWeeks: 2, isDefault: true, updatedAt: null } },
+    'PUT /api/me/availability': { availability: { everyWeeks: 4, isDefault: false, updatedAt: '2026-11-04T10:00:00.000Z' } },
+  });
+  assert.match(root.innerHTML, /How often can you serve\?/);
+  assert.match(root.innerHTML, /<option value="2" selected>Every 2 weeks<\/option>/);
+  assert.match(root.innerHTML, /You have not chosen yet/);
+  await root.submit('availability', { everyWeeks: '4' });
+  assert.equal(api.calls.at(-1), 'PUT /api/me/availability {"everyWeeks":4}');
+  assert.match(root.innerHTML, /<option value="4" selected>Every 4 weeks<\/option>/);
+  assert.match(root.innerHTML, /Saved\. Every 4 weeks at most\./);
+  assert.doesNotMatch(root.innerHTML, /You have not chosen yet/);
+  assert.equal(api.calls.filter((c) => c.startsWith('POST')).length, 0, 'saving how often never adds a day off');
+});
+
+test('how often: pause, and a failed save shows the server message', async () => {
+  const ok = await setup(off, {
+    'GET /api/me/blockouts': { blockouts: [] },
+    'PUT /api/me/availability': { availability: { everyWeeks: 0, isDefault: false, updatedAt: 'x' } },
+  });
+  await ok.root.submit('availability', { everyWeeks: '0' });
+  assert.match(ok.root.innerHTML, /Saved\. Flock will not ask you for now\./);
+  const bad = await setup(off, { 'GET /api/me/blockouts': { blockouts: [] }, 'PUT /api/me/availability': new Error('How often must be one of 0, 1, 2, 3, 4, 6 or 8 weeks') });
+  await bad.root.submit('availability', { everyWeeks: '5' });
+  assert.match(bad.root.innerHTML, /How often must be one of/);
+});
+
 test('mounting twice on the same root leaves one set of handlers', async () => {
   const root = fakeRoot();
   const api = fakeApi({
```

```diff
--- a/test/data/contract.js
+++ b/test/data/contract.js
@@ -704,6 +704,37 @@ export function runContract(name, makeData) {
       });
     });
 
+    // ---------- availability ----------
+    describe('availability', () => {
+      test('get, set (insert then update), mapAll', async () => {
+        await fresh();
+        const w = await world();
+        assert.equal(await data.availability.get(w.ann.id), null);
+        const a1 = await data.availability.set(w.ann.id, { everyWeeks: 2, updatedAt: T });
+        assert.deepEqual(a1, { personId: w.ann.id, everyWeeks: 2, updatedAt: T });
+        clean(a1, 'availability.set');
+        const T2 = '2025-02-01T00:00:00.000Z';
+        assert.deepEqual(await data.availability.set(w.ann.id, { everyWeeks: 0, updatedAt: T2 }), { personId: w.ann.id, everyWeeks: 0, updatedAt: T2 });
+        assert.deepEqual(await data.availability.get(w.ann.id), { personId: w.ann.id, everyWeeks: 0, updatedAt: T2 });
+        await data.availability.set(w.cy.id, { everyWeeks: 4, updatedAt: T });
+        const map = await data.availability.mapAll();
+        assert.ok(map instanceof Map);
+        assert.deepEqual([...map.entries()], [[w.ann.id, 0], [w.cy.id, 4]]);
+      });
+
+      test('set refuses an unknown person and a value outside the choices, and changes nothing', async () => {
+        await fresh();
+        const w = await world();
+        const plain = (e) => e instanceof Error && !(e instanceof DuplicateError) && !(e instanceof InUseError);
+        await assert.rejects(data.availability.set(9999, { everyWeeks: 2, updatedAt: T }), plain);
+        for (const bad of [5, 7, 9, -1]) {
+          await assert.rejects(data.availability.set(w.ann.id, { everyWeeks: bad, updatedAt: T }), plain);
+        }
+        assert.equal(await data.availability.get(w.ann.id), null);
+        assert.equal((await data.availability.mapAll()).size, 0);
+      });
+    });
+
     // ---------- audit ----------
     describe('audit', () => {
       test('log truncates detail and list returns newest first', async () => {
```

Tests that keep passing without changes, and why: `security.test.js` (every
new route goes through the guard; the login GET returns 200 for a member
with no setup), `fuzz.test.js` (strict schemas, so hostile bodies are 400,
never 500), `upgrade.test.js` / `backup-restore.test.js` (they read the
migration list and table list themselves), `polish.test.js` /
`icons-a11y.test.js` (only existing classes, every input has a label, no
icons added).

### New test files

`test/autofill-service.test.js`: the planner (pure) and the service.

| Test | Proves |
|---|---|
| mondayOf / weeksApart / hash32 | week maths across year end and leap day; FNV-1a known values |
| only active, qualified, unpaused, not away, not on that service, not said no, not too soon | each exclusion rule (D4, D5) |
| nobody_qualified message | reason codes and the item shape |
| default is every 2 weeks | D2 |
| a later existing assignment keeps the spacing | D4 is symmetric |
| one slot per person per week across two services | N = 1 meaning |
| past / non-open slots left alone | D5 |
| load = count × every weeks | D6.1 |
| 8-week look-back | D6.1 window |
| longest ago, never-served first | D6.2 |
| full tie by hash, repeatable, order-independent | D6.3 and determinism |
| 3 weekly volunteers over 6 weeks | even rotation |
| every 4 weeks never twice in 4 weeks | D1 cap |
| most constrained slot first | D7 |
| service: preview writes nothing; apply writes pending + 3 audit rows; re-run is a no-op | D8, D9, D12 |
| service: defaults (next week, 1 week) | input defaults |
| service: bad input | 400s, "already over", current week allowed |
| service: a slot filled by hand between preview and apply is left alone | apply re-plans |

```js
// Unit tests for the auto-fill planner (pure) and service. Made-up people only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planAutofill, weeksApart, hash32 } from '../src/services/autofill-service.js';
import { mondayOf } from '../src/dates.js';
import { makeContainer } from './helpers/container.js';
import { ValidationError } from '../src/errors.js';

const TODAY = '2025-01-05'; // a Sunday; the clock in makeContainer()
const W1 = '2025-01-06'; // Monday of next week
const DRUMS = 10;
const KEYS = 11;
const NAMES = { [DRUMS]: 'Drums', [KEYS]: 'Keys' };

// A slot as data.slots.listForServices / assignedBetween return it.
let nextId = 1;
const slot = (date, positionId = DRUMS, extra = {}) => ({
  id: extra.id ?? nextId++, serviceId: extra.serviceId ?? Number(date.replaceAll('-', '')) * 100 + (extra.serviceTime === '18:00' ? 1 : 0),
  positionId, personId: null, status: 'open', assignedAt: null, respondedAt: null,
  serviceDate: date, serviceTime: '09:00', serviceTitle: 'Sunday service',
  positionName: NAMES[positionId], positionSort: positionId === DRUMS ? 1 : 2,
  teamId: 1, teamName: 'Band', teamSort: 1, personName: null, ...extra,
});
const held = (date, personId, status = 'accepted', positionId = DRUMS, extra = {}) => slot(date, positionId, { personId, status, ...extra });
const person = (id, name, positionIds = [DRUMS], active = true) => ({ id, name, active, positionIds });

function plan({ slots, history = [], people, availability = new Map(), blockouts = [], start = W1, weeks = 1, today = TODAY }) {
  // history must hold every slot with a person, as assignedBetween would (open slots never appear there).
  return planAutofill({ today, start, weeks, slots, history, people, availability, blockouts });
}
const who = (r) => r.assigned.map((a) => [a.date, a.positionName, a.personName]);

// ---------- date helpers ----------

test('mondayOf: the Monday on or before the date', () => {
  assert.equal(mondayOf('2025-01-05'), '2024-12-30'); // Sunday
  assert.equal(mondayOf('2025-01-06'), '2025-01-06'); // Monday
  assert.equal(mondayOf('2025-01-11'), '2025-01-06'); // Saturday
  assert.equal(mondayOf('2024-02-29'), '2024-02-26'); // leap day, Thursday
  assert.equal(mondayOf('2024-03-03'), '2024-02-26'); // Sunday after the leap day
  assert.throws(() => mondayOf('2025-02-30'));
});

test('weeksApart: whole Monday-to-Sunday weeks between two dates', () => {
  assert.equal(weeksApart('2025-01-06', '2025-01-12'), 0);
  assert.equal(weeksApart('2025-01-12', '2025-01-13'), 1);
  assert.equal(weeksApart('2025-01-13', '2025-01-12'), 1);
  assert.equal(weeksApart('2024-12-29', '2025-01-05'), 1);
  assert.equal(weeksApart('2025-01-12', '2025-03-02'), 7);
});

test('hash32 is FNV-1a', () => {
  assert.equal(hash32(''), 0x811c9dc5);
  assert.equal(hash32('a'), 0xe40c292c);
  assert.equal(hash32('2025-01-06|1'), hash32('2025-01-06|1'));
  assert.notEqual(hash32('2025-01-06|1'), hash32('2025-01-06|2'));
});

// ---------- who may be picked ----------

test('plan: only active, qualified, unpaused, not away, not on that service, not said no to it, not too soon', () => {
  const s = slot('2025-01-12');
  const other = slot('2025-01-12', KEYS, { serviceId: s.serviceId });
  const declined = slot('2025-01-12', KEYS, { serviceId: s.serviceId });
  const people = [
    person(1, 'Ina Inactive', [DRUMS], false),
    person(2, 'Una Unqualified', [KEYS]),
    person(3, 'Pia Paused'),
    person(4, 'Abe Away'),
    person(5, 'Ona OnService'),
    person(6, 'Dee Declined'),
    person(7, 'Rex Recent'),
  ];
  const history = [
    held('2025-01-12', 5, 'pending', KEYS, { id: other.id, serviceId: s.serviceId }),
    held('2025-01-12', 6, 'declined', KEYS, { id: declined.id, serviceId: s.serviceId }),
    held('2025-01-05', 7, 'accepted'), // last week, and Rex chose every 2 weeks
  ];
  const r = plan({
    slots: [s, { ...other, personId: 5, status: 'pending' }, { ...declined, personId: 6, status: 'declined' }],
    history,
    people,
    availability: new Map([[3, 0], [7, 2]]),
    blockouts: [{ personId: 4, startDate: '2025-01-10', endDate: '2025-01-12' }],
  });
  assert.deepEqual(r.assigned, []);
  assert.deepEqual(r.unfilled.map((u) => [u.slotId, u.reason]), [[s.id, 'nobody_free']]);

  // Rex is free again two weeks later.
  const later = slot('2025-01-19');
  const r2 = plan({ slots: [later], history, people: [people[6]], availability: new Map([[7, 2]]), start: '2025-01-13' });
  assert.deepEqual(who(r2), [['2025-01-19', 'Drums', 'Rex Recent']]);
});

test('plan: nobody set up for the position gives nobody_qualified, with a message', () => {
  const s = slot('2025-01-12', KEYS);
  const r = plan({ slots: [s], people: [person(1, 'Pat Drums')] });
  assert.deepEqual(r.unfilled, [{
    slotId: s.id, serviceId: s.serviceId, date: '2025-01-12', time: '09:00', serviceTitle: 'Sunday service',
    teamName: 'Band', positionName: 'Keys', reason: 'nobody_qualified', message: 'Nobody is set up for Keys',
  }]);
});

test('plan: anyone who never chose counts as every 2 weeks', () => {
  const r = plan({ slots: [slot('2025-01-12')], history: [held('2025-01-05', 1)], people: [person(1, 'Pat Default')] });
  assert.deepEqual(r.assigned, []);
  assert.equal(r.unfilled[0].reason, 'nobody_free');
});

test('plan: an existing assignment LATER than the week also keeps the spacing', () => {
  const r = plan({
    slots: [slot('2025-01-12')],
    history: [held('2025-01-19', 1, 'pending')],
    people: [person(1, 'Pat Later')],
    availability: new Map([[1, 2]]),
  });
  assert.deepEqual(r.assigned, []);
});

test('plan: at most one slot per person per week, even across two services that week', () => {
  const sat = slot('2025-01-11', DRUMS, { serviceTime: '18:00' });
  const sun = slot('2025-01-12');
  const r = plan({ slots: [sun, sat], people: [person(1, 'Pat Only')], availability: new Map([[1, 1]]) });
  assert.deepEqual(who(r), [['2025-01-11', 'Drums', 'Pat Only']]);
  assert.deepEqual(r.unfilled.map((u) => [u.slotId, u.reason]), [[sun.id, 'nobody_free']]);
});

test('plan: past, filled, pending, accepted and declined slots are left alone', () => {
  const past = slot('2025-01-04'); // the Saturday before today
  const pending = slot('2025-01-12', DRUMS, { personId: 9, status: 'pending' });
  const r = plan({ slots: [past, pending], people: [person(1, 'Pat')], start: '2024-12-30', weeks: 2 });
  assert.deepEqual(r, { assigned: [], unfilled: [] });
});

// ---------- fairness ----------

test('plan: fewer services relative to how often they offered wins (load = count x every weeks)', () => {
  // Pat (every week) served twice in the last 8 weeks: load 2. Quinn (every 4 weeks) once: load 4.
  const history = [held('2024-12-15', 1), held('2024-12-22', 1), held('2024-11-24', 2)];
  const people = [person(1, 'Pat Weekly'), person(2, 'Quinn Monthly')];
  const r = plan({ slots: [slot('2025-01-12')], history, people, availability: new Map([[1, 1], [2, 4]]) });
  assert.deepEqual(who(r), [['2025-01-12', 'Drums', 'Pat Weekly']]);
});

test('plan: services before the 8-week look-back do not count', () => {
  // Quinn served twice, 9 and 10 weeks before the week: load 0. Pat once inside the window: load 1.
  const history = [held('2024-10-27', 2), held('2024-11-03', 2), held('2024-12-22', 1)];
  const people = [person(1, 'Pat'), person(2, 'Quinn')];
  const r = plan({ slots: [slot('2025-01-12')], history, people, availability: new Map([[1, 1], [2, 1]]) });
  assert.deepEqual(who(r), [['2025-01-12', 'Drums', 'Quinn']]);
});

test('plan: equal load goes to whoever served longest ago, never-served first', () => {
  const people = [person(1, 'Ann'), person(2, 'Bo'), person(3, 'Cy')];
  const availability = new Map([[1, 1], [2, 1], [3, 1]]);
  // Each served once in the window, Bo longest ago.
  const history = [held('2024-12-29', 1), held('2024-11-17', 2), held('2024-12-22', 3)];
  assert.deepEqual(who(plan({ slots: [slot('2025-01-12')], history, people, availability })), [['2025-01-12', 'Drums', 'Bo']]);
  // A newcomer (never served, load 0) beats everyone.
  const r = plan({ slots: [slot('2025-01-12')], history, people: [...people, person(4, 'Dee New')], availability });
  assert.deepEqual(who(r), [['2025-01-12', 'Drums', 'Dee New']]);
});

test('plan: a full tie is broken by hash32(week|id), not by name, and is repeatable', () => {
  // Ids chosen so the hash winner (8) is neither the lowest id nor the first name.
  const people = [person(2, 'Ann'), person(3, 'Bo'), person(8, 'Cy')];
  const s = slot('2025-01-12');
  const expected = [...people].sort((a, b) => hash32(`${W1}|${a.id}`) - hash32(`${W1}|${b.id}`))[0].name;
  assert.equal(expected, 'Cy');
  const a = plan({ slots: [s], people });
  const b = plan({ slots: [s], people: [...people].reverse() });
  assert.equal(a.assigned[0].personName, 'Cy');
  assert.deepEqual(a, b);
});

test('plan: weekly rotation over 6 weeks gives three weekly volunteers two turns each, in a repeating order', () => {
  const people = [person(1, 'Ann'), person(2, 'Bo'), person(3, 'Cy')];
  const availability = new Map([[1, 1], [2, 1], [3, 1]]);
  const sundays = ['2025-01-12', '2025-01-19', '2025-01-26', '2025-02-02', '2025-02-09', '2025-02-16'];
  const r = plan({ slots: sundays.map((d) => slot(d)), people, availability, weeks: 6 });
  const ids = r.assigned.map((a) => a.personId);
  assert.equal(ids.length, 6);
  for (const id of [1, 2, 3]) assert.equal(ids.filter((x) => x === id).length, 2);
  assert.deepEqual(ids.slice(3), ids.slice(0, 3));
});

test('plan: every 4 weeks is never asked more than once in 4 weeks', () => {
  const people = [person(1, 'Pat Weekly'), person(2, 'Quinn Monthly')];
  const sundays = ['2025-01-12', '2025-01-19', '2025-01-26', '2025-02-02'];
  const r = plan({ slots: sundays.map((d) => slot(d)), people, availability: new Map([[1, 1], [2, 4]]), weeks: 4 });
  const ids = r.assigned.map((a) => a.personId);
  assert.equal(ids.length, 4);
  assert.equal(ids.filter((x) => x === 2).length, 1);
  assert.equal(ids.filter((x) => x === 1).length, 3);
});

test('plan: the most constrained slot is filled first', () => {
  // Keys: only Pat. Drums: Pat or Quinn, and Pat would win Drums on fairness (Quinn has load 1).
  const svc = 202501120;
  const drums = slot('2025-01-12', DRUMS, { serviceId: svc });
  const keys = slot('2025-01-12', KEYS, { serviceId: svc });
  const people = [person(1, 'Pat Both', [DRUMS, KEYS]), person(2, 'Quinn Drums', [DRUMS])];
  const r = plan({ slots: [drums, keys], history: [held('2024-12-15', 2)], people, availability: new Map([[1, 1], [2, 1]]) });
  assert.deepEqual(who(r), [['2025-01-12', 'Drums', 'Quinn Drums'], ['2025-01-12', 'Keys', 'Pat Both']]);
});

test('plan: the assigned item shape', () => {
  const s = slot('2025-01-12');
  const r = plan({ slots: [s], people: [person(1, 'Pat')], availability: new Map([[1, 3]]) });
  assert.deepEqual(r, {
    assigned: [{
      slotId: s.id, serviceId: s.serviceId, date: '2025-01-12', time: '09:00', serviceTitle: 'Sunday service',
      teamName: 'Band', positionName: 'Drums', personId: 1, personName: 'Pat', everyWeeks: 3,
    }],
    unfilled: [],
  });
});

// ---------- the service ----------

async function setup() {
  const c = makeContainer();
  const { data, services } = c;
  const at = '2025-01-01T00:00:00.000Z';
  const admin = await data.people.create({ name: 'Ada Admin', username: 'ada', role: 'admin', passwordHash: 'x', createdAt: at });
  const band = await data.teams.create({ name: 'Band' });
  const drums = await data.positions.create(band.id, { name: 'Drums' });
  const add = async (name, username, everyWeeks) => {
    const p = await data.people.create({ name, username, passwordHash: 'x', createdAt: at });
    await data.qualifications.setForPerson(p.id, [drums.id]);
    if (everyWeeks !== undefined) await data.availability.set(p.id, { everyWeeks, updatedAt: at });
    return p;
  };
  const sunday = async (date) => {
    const s = await data.services.create({ date, title: 'Sunday service' });
    return (await data.slots.createMany(s.id, [drums.id]))[0];
  };
  const run = (input) => services.autofill.run({ id: admin.id }, input);
  return { c, data, admin, drums, add, sunday, run };
}

test('service: a preview writes nothing; apply makes pending assignments and one audit entry', async () => {
  const { data, add, sunday, run, admin } = await setup();
  const pat = await add('Pat Person', 'pat', 1);
  const s1 = await sunday('2025-01-12');
  const s2 = await sunday('2025-01-19');
  const auditBefore = (await data.audit.list()).length;

  const preview = await run({ weekOf: '2025-01-08', weeks: 2 });
  assert.equal(preview.applied, false);
  assert.equal(preview.weekOf, W1);
  assert.equal(preview.weeks, 2);
  assert.deepEqual(preview.assigned.map((a) => [a.slotId, a.personId]), [[s1.id, pat.id], [s2.id, pat.id]]);
  assert.equal((await data.slots.findById(s1.id)).status, 'open');
  assert.equal((await data.audit.list()).length, auditBefore);

  const done = await run({ weekOf: '2025-01-08', weeks: 2, apply: true });
  assert.equal(done.applied, true);
  assert.deepEqual(done.assigned, preview.assigned);
  for (const id of [s1.id, s2.id]) {
    const s = await data.slots.findById(id);
    assert.equal(s.personId, pat.id);
    assert.equal(s.status, 'pending');
  }
  const audit = await data.audit.list();
  assert.equal(audit.length, auditBefore + 3); // two slot.assign and one schedule.autofill
  assert.equal(audit[0].action, 'schedule.autofill');
  assert.equal(audit[0].actorId, admin.id);
  assert.equal(audit[0].detail, '2025-01-06 for 2 week(s): 2 assigned, 0 left open');

  // Running again finds nothing open, changes nothing and logs nothing.
  const again = await run({ weekOf: '2025-01-08', weeks: 2, apply: true });
  assert.deepEqual([again.assigned, again.unfilled], [[], []]);
  assert.equal((await data.audit.list()).length, auditBefore + 3);
});

test('service: weekOf defaults to next week, weeks to 1', async () => {
  const { add, sunday, run } = await setup();
  await add('Pat Person', 'pat', 1);
  const next = await sunday('2025-01-12');
  await sunday('2025-01-19');
  const r = await run({});
  assert.equal(r.weekOf, W1);
  assert.equal(r.weeks, 1);
  assert.deepEqual(r.assigned.map((a) => a.slotId), [next.id]);
});

test('service: bad input is a ValidationError', async () => {
  const { run } = await setup();
  const bad = [
    [{ weekOf: '2025-02-30' }, /real date/],
    [{ weekOf: 20250106 }, /real date/],
    [{ weeks: 0 }, /from 1 to 8/],
    [{ weeks: 9 }, /from 1 to 8/],
    [{ weeks: 1.5 }, /from 1 to 8/],
    [{ apply: 'yes' }, /true or false/],
    [{ weekOf: '2024-12-29' }, /already over/], // the week of 2024-12-23 ended before today
  ];
  for (const [input, re] of bad) {
    await assert.rejects(run(input), (e) => e instanceof ValidationError && re.test(e.message), JSON.stringify(input));
  }
  // The current week is still allowed (today is its Sunday).
  assert.equal((await run({ weekOf: TODAY })).weekOf, '2024-12-30');
});

test('service: a slot changed by hand between preview and apply is respected', async () => {
  const { data, add, sunday, run } = await setup();
  const pat = await add('Pat Person', 'pat', 1);
  const quinn = await add('Quinn Quill', 'quinn', 1);
  const s1 = await sunday('2025-01-12');
  const preview = await run({ weekOf: W1 });
  assert.equal(preview.assigned.length, 1);
  const other = preview.assigned[0].personId === pat.id ? quinn : pat;
  await data.slots.assign(s1.id, { personId: other.id, status: 'accepted', assignedAt: '2025-01-05T12:00:00.000Z' });
  const done = await run({ weekOf: W1, apply: true });
  assert.deepEqual(done.assigned, []);
  assert.equal((await data.slots.findById(s1.id)).personId, other.id);
});
```

`test/availability.test.js`: availability service and the three routes over
real HTTP.

```js
// Availability (how often a volunteer serves) and auto-fill over real HTTP. Made-up people only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/app.js';
import { seedAdminAndMember } from './helpers/seed.js';
import { makeData } from './helpers/data.js';
import { fixedClock } from '../src/infra/clock.js';
import { createAvailabilityService, DEFAULT_EVERY_WEEKS } from '../src/services/availability-service.js';
import { ValidationError } from '../src/errors.js';

const X = { 'X-Flock': '1' };
const NOW = '2025-01-05T12:00:00';

async function boot() {
  const app = await startTestApp({ now: () => new Date(NOW) });
  const s = await seedAdminAndMember(app);
  return { app, ...s };
}

// ---------- service ----------

test('availability service: default until chosen, then the choice; bad values refused', async () => {
  const { data } = makeData();
  const svc = createAvailabilityService({ data, clock: fixedClock(new Date(NOW)) });
  const p = await data.people.create({ name: 'Pat', username: 'pat', passwordHash: 'x', createdAt: NOW });
  assert.equal(DEFAULT_EVERY_WEEKS, 2);
  assert.deepEqual(await svc.getMine(p.id), { everyWeeks: 2, isDefault: true, updatedAt: null });
  const saved = await svc.setMine(p.id, { everyWeeks: 4 });
  assert.deepEqual(saved, { everyWeeks: 4, isDefault: false, updatedAt: new Date(NOW).toISOString() });
  assert.deepEqual(await svc.getMine(p.id), saved);
  assert.deepEqual((await svc.setMine(p.id, { everyWeeks: 0 })).everyWeeks, 0);
  for (const bad of [5, 7, 9, -1, '2', null, undefined, 1.5]) {
    await assert.rejects(svc.setMine(p.id, { everyWeeks: bad }), ValidationError, String(bad));
  }
  assert.equal((await svc.getMine(p.id)).everyWeeks, 0);
});

// ---------- routes ----------

test('GET/PUT /api/me/availability: a member reads and sets their own', async () => {
  const { app, memberCookie, memberId } = await boot();
  try {
    let r = await app.request('GET', '/api/me/availability', { cookie: memberCookie });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { availability: { everyWeeks: 2, isDefault: true, updatedAt: null } });

    r = await app.request('PUT', '/api/me/availability', { cookie: memberCookie, headers: X, body: { everyWeeks: 3 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.availability.everyWeeks, 3);
    assert.equal(r.json.availability.isDefault, false);
    assert.equal((await app.data.availability.get(memberId)).everyWeeks, 3);

    for (const body of [{ everyWeeks: 5 }, { everyWeeks: '3' }, {}, { everyWeeks: 3, personId: 1 }, []]) {
      const bad = await app.request('PUT', '/api/me/availability', { cookie: memberCookie, headers: X, body });
      assert.equal(bad.status, 400, JSON.stringify(body));
      assert.equal(typeof bad.json.error, 'string');
    }
    assert.equal((await app.data.availability.get(memberId)).everyWeeks, 3);
  } finally { await app.close(); }
});

test('PUT /api/me/availability only changes the caller', async () => {
  const { app, memberCookie, adminId } = await boot();
  try {
    await app.request('PUT', '/api/me/availability', { cookie: memberCookie, headers: X, body: { everyWeeks: 8 } });
    assert.equal(await app.data.availability.get(adminId), null);
  } finally { await app.close(); }
});

test('POST /api/admin/autofill: scheduler only; preview then apply', async () => {
  const { app, adminCookie, memberCookie, memberId } = await boot();
  try {
    const team = (await app.request('POST', '/api/teams', { cookie: adminCookie, headers: X, body: { name: 'Band' } })).json;
    const drums = (await app.request('POST', `/api/teams/${team.id}/positions`, { cookie: adminCookie, headers: X, body: { name: 'Drums' } })).json;
    await app.request('PUT', `/api/people/${memberId}/positions`, { cookie: adminCookie, headers: X, body: { positionIds: [drums.id] } });
    const svc = (await app.request('POST', '/api/services', { cookie: adminCookie, headers: X, body: { date: '2025-01-12', slots: [{ positionId: drums.id }] } })).json;

    assert.equal((await app.request('POST', '/api/admin/autofill', { cookie: memberCookie, headers: X, body: {} })).status, 403);

    const preview = await app.request('POST', '/api/admin/autofill', { cookie: adminCookie, headers: X, body: { weekOf: '2025-01-06' } });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.applied, false);
    assert.deepEqual(preview.json.assigned.map((a) => [a.slotId, a.personId, a.personName]), [[svc.slots[0].id, memberId, 'Max Member']]);
    assert.deepEqual(preview.json.unfilled, []);

    const done = await app.request('POST', '/api/admin/autofill', { cookie: adminCookie, headers: X, body: { weekOf: '2025-01-06', apply: true } });
    assert.equal(done.status, 200);
    assert.equal(done.json.applied, true);
    const mine = await app.request('GET', '/api/me/schedule', { cookie: memberCookie });
    assert.deepEqual(mine.json.items.map((i) => [i.date, i.positionName, i.status]), [['2025-01-12', 'Drums', 'pending']]);

    for (const body of [{ weeks: 0 }, { weeks: 9 }, { weekOf: 'soon' }, { apply: 'yes' }, { surprise: 1 }]) {
      const bad = await app.request('POST', '/api/admin/autofill', { cookie: adminCookie, headers: X, body });
      assert.equal(bad.status, 400, JSON.stringify(body));
    }
  } finally { await app.close(); }
});
```

UI tests appended to `test/admin-schedule-ui.test.js` (the "how often" UI
tests are in the `test/member-ui.test.js` diff above):

```diff
--- a/test/admin-schedule-ui.test.js
+++ b/test/admin-schedule-ui.test.js
@@ -621,3 +621,64 @@ test('reminders: copy button shows a check SVG, then the copy SVG after 1.5s', a
   assert.ok(!btn.innerHTML.includes(CHECK));
   assert.match(btn.innerHTML, /<svg[^>]*>.*rect.*<\/svg><\/span> Copy$/);
 });
+
+// ---------- fill open positions (auto-fill) ----------
+
+test('nextMonday: the Monday after today, never today', () => {
+  assert.equal(schedule.nextMonday('2026-11-04'), '2026-11-09'); // Wednesday
+  assert.equal(schedule.nextMonday('2026-11-08'), '2026-11-09'); // Sunday
+  assert.equal(schedule.nextMonday('2026-11-09'), '2026-11-16'); // Monday
+  assert.equal(schedule.nextMonday('2026-12-31'), '2027-01-04'); // across the year
+});
+
+const PLAN = {
+  applied: false, weekOf: '2026-11-09', weeks: 2,
+  assigned: [{ slotId: 4, serviceId: 1, date: '2026-11-15', time: '09:00', serviceTitle: 'Sunday service', teamName: 'Band', positionName: 'Keys', personId: 30, personName: '<b>Sam</b> Ortiz', everyWeeks: 2 }],
+  unfilled: [{ slotId: 5, serviceId: 2, date: '2026-11-15', time: '09:00', serviceTitle: 'Sunday service', teamName: 'Sound', positionName: 'Mixer', reason: 'nobody_qualified', message: 'Nobody is set up for Mixer' }],
+};
+
+test('schedule: fill open positions previews, then asks, then reloads', async () => {
+  const { api, root } = await schedSetup({
+    'POST /api/admin/autofill': (body) => (body.apply ? { ...PLAN, applied: true } : PLAN),
+  });
+  assert.match(root.innerHTML, /Fill open positions/);
+  assert.match(root.innerHTML, /name="weekOf" type="date" required value="2026-11-09"/);
+  assert.match(root.innerHTML, /<option value="1" selected>1<\/option>/);
+
+  await root.submit('autofill', { weekOf: '2026-11-09', weeks: '2' });
+  await flush();
+  assert.deepEqual(api.calls, ['POST /api/admin/autofill {"weekOf":"2026-11-09","weeks":2,"apply":false}']);
+  const h = root.innerHTML;
+  assert.match(h, /Who Flock would ask \(1\)/);
+  assert.match(h, /&lt;b&gt;Sam&lt;\/b&gt; Ortiz/);
+  assert.match(h, /Still open \(1\)/);
+  assert.match(h, /Nobody is set up for Mixer/);
+  assert.match(h, /<option value="2" selected>2<\/option>/);
+
+  api.calls.length = 0;
+  await root.click('autofill-apply');
+  await flush();
+  assert.equal(api.calls[0], 'POST /api/admin/autofill {"weekOf":"2026-11-09","weeks":2,"apply":true}');
+  assert.ok(api.calls.includes('GET /api/teams') && api.calls.includes(SCHED_PATH), 'the schedule reloads');
+  assert.match(root.innerHTML, /Asked 1 person\. They will see it in My schedule\./);
+  assert.doesNotMatch(root.innerHTML, /data-autofill-result/);
+});
+
+test('schedule: fill open positions: bad date, cancel and a server error', async () => {
+  const { api, root } = await schedSetup({ 'POST /api/admin/autofill': PLAN });
+  await root.submit('autofill', { weekOf: '', weeks: '1' });
+  assert.match(root.innerHTML, /Please pick a date\./);
+  assert.equal(api.calls.length, 0);
+
+  await root.submit('autofill', { weekOf: '2026-11-09', weeks: '1' });
+  await flush();
+  assert.match(root.innerHTML, /data-autofill-result/);
+  await root.click('autofill-cancel');
+  assert.doesNotMatch(root.innerHTML, /data-autofill-result/);
+  assert.equal(api.calls.filter((c) => c.includes('"apply":true')).length, 0, 'cancel asks nobody');
+
+  const bad = await schedSetup({ 'POST /api/admin/autofill': new ApiError({ status: 400, message: 'Those weeks are already over' }) });
+  await bad.root.submit('autofill', { weekOf: '2026-11-02', weeks: '1' });
+  await flush();
+  assert.match(bad.root.innerHTML, /Those weeks are already over/);
+});
```

### Mutation check (done on the prototype; repeat if you change the planner)

Each of these one-line bugs, put into `autofill-service.js` alone, made at
least one test in `test/autofill-service.test.js` fail: no
most-constrained-first; load ignores N; no spacing; history not marking
"on service"; no 8-week window; no hash tie-break; "served longest ago"
reversed; paused ignored; past slots included; default 1 instead of 2;
planned assignments not tracked. If you change a test and one of these stops
failing, the test got weaker.

### Manual check (5 minutes, demo data)

1. `FLOCK_DB=data/demo.db node bin/flock.js demo && FLOCK_DB=data/demo.db npm start`
2. Log in as a demo member, open **Days I can't serve**, set **Every 4 weeks**, save, reload: it stays.
3. Log in as `demo-admin`, **Schedule** → **Fill open positions** → next week, 4 weeks → **Preview**. Nothing on the grid changes.
4. **Ask these people**. Empty positions fill with "Waiting for answer". The member from step 2 is asked at most once in those 4 weeks.
5. **Preview** again: nothing more to ask (or only positions that are still free).
6. On a phone width (380 px), both cards fit without sideways scrolling.

## Done when

- [ ] `npm test` passes, no test skipped that was not skipped before.
- [ ] `git grep -n "new Date()\|Date.now\|Math.random" src/services` shows nothing new.
- [ ] The six existing test files above are the only existing tests changed.
- [ ] README and CHANGELOG updated.
- [ ] Manual check done once.

## Pitfalls for the implementer

1. **Do not** run SQL or `new Date()` in a service; use `d.availability.*` and `clock.now()`.
2. **Do not** read `availability` with `data.` inside `data.tx`; use the `d` passed to the callback.
3. **Do not** make the planner random. Preview and apply must give the same answer for the same data; that is why the tie-break is `hash32`, not `random`.
4. **Do not** touch declined, pending or accepted slots.
5. Views: **no new CSS classes**, no `style=`; every `<input>`/`<select>` needs a `<label for>`.
6. Keep `planAutofill` pure: it gets plain arrays and a `Map`, returns plain objects. All loading happens in `run`.
7. `v.enum([...])` on numbers rejects the string `"3"`. The web sends `Number(...)`; keep it that way.

## Relation to invite links (decision 0004, #12)

This plan is written against `main` **after** #12 merged (`cb72451`). #12
edited `0001_init.sql` in place; this card adds `0002_availability.sql` and
never touches `0001`, so the migrations do not conflict. If `main` moves again
before you build, rebase first; where a hunk no longer applies, make the same
change by hand, then re-run the whole suite. The "Existing tests that MUST
change" table is the checklist.

## Delivery

One branch `rdemeterio/autofill-availability`, one PR, rebase-merge.
Suggested commits: (1) migration + data + contract tests; (2) services +
container + service tests; (3) routes + route tests; (4) volunteer UI;
(5) scheduler UI; (6) docs.
