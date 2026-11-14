// Registers every route module. Each module exports register(router, deps).
//
// deps = { services, config, clock, logger }
//   services  the application services built by src/container.js
//   config    the settings (cookie flags, session length)
//   clock     the injected clock (login throttle)
//   logger    the injected logger
// Routes never get the data layer or the raw database. The same object is
// handed to handlers as `ctx`.
import * as auth from './auth.js';
import * as people from './people.js';
import * as teams from './teams.js';
import * as services from './services.js';
import * as assignments from './assignments.js';
import * as blockouts from './blockouts.js';
import * as admin from './admin.js';
import * as availability from './availability.js';
import * as push from './push.js';
import * as attachments from './attachments.js';

export const ROUTE_MODULES = Object.freeze([auth, people, teams, services, assignments, blockouts, availability, push, attachments, admin]);

export function register(router, deps) {
  if (!deps || !deps.services) throw new Error('Routes need deps.services (build them with createContainer)');
  for (const mod of ROUTE_MODULES) mod.register(router, deps);
}

// Older name, kept for callers that still use it.
export const registerAll = register;
