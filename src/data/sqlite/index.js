// SQLite adapter for the data interface described in ../index.js.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createQueue } from './queue.js';
import { peopleRepo } from './people.js';
import { sessionsRepo } from './sessions.js';
import { invitesRepo } from './invites.js';
import { identitiesRepo } from './identities.js';
import { teamsRepo, positionsRepo } from './teams.js';
import { qualificationsRepo } from './qualifications.js';
import { servicesRepo } from './services.js';
import { slotsRepo } from './slots.js';
import { blockoutsRepo } from './blockouts.js';
import { availabilityRepo } from './availability.js';
import { auditRepo } from './audit.js';
import { maintenanceRepo } from './maintenance.js';
import { pushDevicesRepo } from './push-devices.js';

// Runs a synchronous statement function and hands back a promise of its result.
const direct = (fn) => new Promise((resolve) => resolve(fn()));

// One queue (and one open-transaction tracker) per connection, so several
// createData(db) calls on the same db still never interleave.
const shared = new WeakMap();
function sharedFor(db) {
  let s = shared.get(db);
  if (!s) {
    s = { queue: createQueue(), current: new AsyncLocalStorage() };
    shared.set(db, s);
  }
  return s;
}

export function createSqliteData(db) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('createData needs an open database');
  // `current` remembers the open transaction for code running inside a tx callback, so a
  // top-level call made there joins the transaction instead of waiting for it forever.
  const { queue, current } = sharedFor(db);

  function build(run, txFn) {
    const ctx = { db, run };
    const data = {
      people: peopleRepo(ctx),
      sessions: sessionsRepo(ctx),
      invites: invitesRepo(ctx),
      identities: identitiesRepo(ctx),
      teams: teamsRepo(ctx),
      positions: positionsRepo(ctx),
      qualifications: qualificationsRepo(ctx),
      services: servicesRepo(ctx),
      slots: slotsRepo(ctx),
      blockouts: blockoutsRepo(ctx),
      availability: availabilityRepo(ctx),
      audit: auditRepo(ctx),
      maintenance: maintenanceRepo(ctx),
      pushDevices: pushDevicesRepo(ctx),
    };
    data.tx = (fn) => txFn(data, fn);
    return Object.freeze(data);
  }

  const openState = () => {
    const st = current.getStore();
    return st && st.open ? st : null;
  };

  // Top level: go through the queue, unless we are already inside an open transaction.
  const topRun = (fn) => (openState() ? direct(fn) : queue.run(fn));

  function topTx(_data, fn) {
    const st = openState();
    if (st) return st.data.tx(fn);
    return queue.run(async () => {
      const state = { open: true, data: null };
      const boundRun = (f) => (state.open
        ? direct(f)
        : Promise.reject(new Error('This transaction has already finished')));
      state.data = build(boundRun, (d, inner) => {
        if (!state.open) return Promise.reject(new Error('This transaction has already finished'));
        // A tx inside a tx reuses the open transaction.
        return Promise.resolve().then(() => inner(d));
      });
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await current.run(state, () => fn(state.data));
        db.exec('COMMIT');
        return result;
      } catch (e) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw e;
      } finally {
        state.open = false;
      }
    });
  }

  return build(topRun, topTx);
}
