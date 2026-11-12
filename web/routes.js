// The page list, and a pure resolve() that picks the page for a #hash.
// role: 'public' = only when logged out, 'any' = any logged-in person,
//       'member' = logged-in person (members and admins), 'admin' = admins only,
//       'open' = visible whether logged in or out.
import * as login from './views/login.js';
import * as welcome from './views/welcome.js';
import * as password from './views/password.js';
import * as notifications from './views/notifications.js';
import * as notFound from './views/notfound.js';
import * as mySchedule from './views/my-schedule.js';
import * as myBlockouts from './views/my-blockouts.js';
import * as adminPeople from './views/admin-people.js';
import * as adminTeams from './views/admin-teams.js';
import * as adminServices from './views/admin-services.js';
import * as adminSchedule from './views/admin-schedule.js';
import * as adminGaps from './views/admin-gaps.js';

export const LOGIN = '#/login';
export const HOME = '#/';

// `label` puts the page in the nav menu, in this order.
export const routes = [
  { path: '/login', view: login, role: 'public' },
  { path: '/welcome', view: welcome, role: 'open' },
  { path: '/password', view: password, role: 'any' },
  { path: '/notifications', view: notifications, role: 'any' },
  { path: '/', view: mySchedule, role: 'member', label: 'My schedule' },
  { path: '/blockouts', view: myBlockouts, role: 'member', label: "Days I can't serve" },
  { path: '/people', view: adminPeople, role: 'admin', label: 'People' },
  { path: '/teams', view: adminTeams, role: 'admin', label: 'Teams' },
  { path: '/services', view: adminServices, role: 'admin', label: 'Services' },
  { path: '/schedule', view: adminSchedule, role: 'admin', label: 'Schedule' },
  { path: '/gaps', view: adminGaps, role: 'admin', label: 'Gaps' },
];

export const notFoundRoute = { path: null, view: notFound, role: 'any' };

// '#/people?x=1' -> '/people'; '', '#', '#/' -> '/'; trailing slash dropped.
export function pathOf(hash) {
  let p = String(hash ?? '').replace(/^#/, '');
  p = p.split('?')[0];
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

export function isAdmin(user) {
  return !!user && user.role === 'admin';
}

// Returns { route } to show a page, or { redirect: '#/...' } to go elsewhere.
export function resolve(hash, user) {
  const path = pathOf(hash);
  const route = routes.find((r) => r.path === path) ?? null;

  if (route?.role === 'open') return { route };
  if (!user) {
    if (route && route.role === 'public') return { route };
    return { redirect: LOGIN };
  }
  if (!route) return { route: notFoundRoute };
  if (route.role === 'public') return { redirect: HOME };
  if (route.role === 'admin' && !isAdmin(user)) return { redirect: HOME };
  return { route };
}

// Pages to list in the nav for this person.
export function navRoutes(user) {
  if (!user) return [];
  return routes.filter((r) => r.label && (r.role !== 'admin' || isAdmin(user)));
}
