import * as auth from './auth.js';
import * as people from './people.js';
import * as teams from './teams.js';
import * as services from './services.js';
import * as assignments from './assignments.js';
import * as blockouts from './blockouts.js';
import * as admin from './admin.js';

export function registerAll(router, ctx) {
  for (const mod of [auth, people, teams, services, assignments, blockouts, admin]) {
    mod.register(router, ctx);
  }
}
