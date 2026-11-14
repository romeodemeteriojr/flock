// Accessibility guard for icon-heavy screens: checks that no interactive element
// is left without an accessible name and that every icon used is valid.
//
// Renders the main states of each view, then asserts:
//   1. Every <button> has text content, aria-label, or title.
//   2. Every <a> has text content, aria-label, or title.
//   3. Every data-icon attribute references a name from icons.js.
//   4. Icon-only controls (buttons/links where the only real content is an <span class="icon">)
//      have aria-label or title.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { html, raw, esc } from '../web/lib/html.js';
import { ICON_NAMES, ART_NAMES, hydrateIcons, icon } from '../web/lib/icons.js';
import { iconButton } from '../web/lib/iconbutton.js';
import * as nav from '../web/views/nav.js';
import * as login from '../web/views/login.js';
import * as welcome from '../web/views/welcome.js';
import * as password from '../web/views/password.js';
import * as notFound from '../web/views/notfound.js';
import * as mySchedule from '../web/views/my-schedule.js';
import * as myBlockouts from '../web/views/my-blockouts.js';
import * as people from '../web/views/admin-people.js';
import * as teams from '../web/views/admin-teams.js';
import * as services from '../web/views/admin-services.js';
import * as schedule from '../web/views/admin-schedule.js';
import * as gaps from '../web/views/admin-gaps.js';
import { renderGallery, demoData } from '../web/gallery.js';
import { todayString } from '../web/lib/dates.js';
import { addDays } from '../web/views/admin-services.js';
import { avatar } from '../web/lib/avatar.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const CSS = readFileSync(path.join(WEB, 'style.css'), 'utf8');
const TODAY = '2026-11-08'; // a Sunday
const d = demoData(TODAY);

// ---------- helpers ----------

// Extract HTML from a view function's return value (they return strings).
function htmlOf(fn) {
  const out = fn();
  return typeof out === 'string' ? out : String(out);
}

// Parse a string for <button> elements and check they have an accessible name.
// Returns an array of [{tag, content, problem}].
function checkButtons(str) {
  const results = [];
  const re = /<button[^>]*>([\s\S]*?)<\/button>/gi;
  let m;
  while ((m = re.exec(str)) !== null) {
    const inner = m[1];
    // Strip HTML tags to get text content
    const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const ariaLabel = m[0].match(/aria-label="([^"]*)"/);
    const title = m[0].match(/title="([^"]*)"/);
    // An icon-only button still counts as "labelled" if it has aria-label or title.
    const hasLabel = text.length > 0 || ariaLabel || title;
    if (!hasLabel) {
      // Check if it's an icon-only button without a label
      const hasIconSpan = /<span[^>]*class="[^"]*icon[^"]*"[^>]*>/.test(inner);
      results.push({ content: inner, problem: hasIconSpan ? 'icon-only button missing aria-label or title' : 'button has no accessible name' });
    }
  }
  return results;
}

// Same for <a> elements.
function checkLinks(str) {
  const results = [];
  const re = /<a[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(str)) !== null) {
    const inner = m[1];
    const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const ariaLabel = m[0].match(/aria-label="([^"]*)"/);
    const title = m[0].match(/title="([^"]*)"/);
    // Also check for visually-hidden text (aria-hidden but screen-readers can still see it)
    const hasVisuallyHidden = /class="[^"]*visually-hidden[^"]*"/.test(inner);
    const hasLabel = text.length > 0 || ariaLabel || title || hasVisuallyHidden;
    if (!hasLabel) {
      results.push({ content: inner, problem: 'link has no accessible name or visually-hidden text' });
    }
  }
  return results;
}

// Find all data-icon values and check them against ICON_NAMES + ART_NAMES.
function checkIcons(str) {
  const results = [];
  const re = /data-icon="([^"]*)"/gi;
  let m;
  const seen = new Set();
  while ((m = re.exec(str)) !== null) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    if (!ICON_NAMES.includes(name) && !ART_NAMES.includes(name)) {
      results.push({ name, problem: `unknown icon name "${name}" not in icons.js` });
    }
  }
  return results;
}

// Check for icon-only controls that lack aria-label or title.
function checkIconControls(str) {
  const results = [];
  // Pattern: <button...>...<span class="icon" ...></span>...</button> with no text
  // We already caught these in checkButtons, but also check for icon-only links.
  const iconLinkRe = /<a[^>]*>\s*<span[^>]*class="[^"]*icon[^"]*"[^>]*>[\s\S]*?<\/span>\s*<\/a>/gi;
  let m;
  while ((m = iconLinkRe.exec(str)) !== null) {
    const tag = m[0];
    const inner = m[1];
    const ariaLabel = tag.match(/aria-label="([^"]*)"/);
    const title = tag.match(/title="([^"]*)"/);
    const hasLabel = ariaLabel || title;
    if (!hasLabel) {
      results.push({ tag, problem: 'icon-only link missing aria-label or title' });
    }
  }
  return results;
}

// Run all a11y checks on a rendered view string.
function a11yCheck(htmlStr) {
  return {
    buttons: checkButtons(htmlStr),
    links: checkLinks(htmlStr),
    icons: checkIcons(htmlStr),
    iconControls: checkIconControls(htmlStr),
  };
}

// Helper to render and check all states for a view module.
function viewStates(mod, states, label) {
  const allResults = [];
  for (const [stateName, render] of states) {
    try {
      const htmlStr = typeof render === 'function' ? String(render()) : String(render);
      const r = a11yCheck(htmlStr);
      if (r.buttons.length || r.links.length || r.icons.length || r.iconControls.length) {
        allResults.push({ stateName, htmlStr, ...r });
      }
    } catch (err) {
      allResults.push({ stateName, error: err.message });
    }
  }
  return allResults;
}

// ---------- model helpers ----------

const admin = { id: 1, name: 'Morgan Fictional', role: 'admin' };
const member = { id: 3, name: 'Priya Demo', role: 'member' };

// ---------- TESTS ----------

test('icons-a11y: every button and link in login is accessible', () => {
  const results = viewStates(login, [
    ['empty', () => login.render({})],
    ['error', () => login.render({}, { error: 'Wrong password', email: 'test@example.com' })],
  ], 'login');
  const errs = flatErrors(results);
  assert.equal(errs.length, 0, `login a11y errors: ${errs.join('; ')}`);
});

test('icons-a11y: every button and link in welcome is accessible', () => {
  const results = viewStates(welcome, [
    ['checking', () => welcome.render({})],
    ['choose-password', () => welcome.render({}, { info: { name: 'Pat Demo', email: 'pat.demo@example.com' } })],
    ['gone', () => welcome.render({}, { error: 'This link has expired or was already used.' })],
  ], 'welcome');
  assert.deepEqual(flatErrors(results), []);
});

test('icons-a11y: every button and link in password is accessible', () => {
  const results = viewStates(password, [
    ['change-password', () => password.render({ user: {} })],
    ['error', () => password.render({ user: {} }, { error: "Passwords don't match" })],
  ], 'password');
  const errs = flatErrors(results);
  assert.equal(errs.length, 0, `password a11y errors: ${errs.join('; ')}`);
});

test('icons-a11y: every button and link in my-schedule is accessible', () => {
  const items = [
    { slotId: 101, date: addDays(d.today, 2), time: '10:00', serviceTitle: 'Sunday service', positionName: 'Drums', teamName: 'Band', status: 'pending', coVolunteers: [{ name: 'Priya Demo', positionName: 'Keys' }] },
    { slotId: 102, date: addDays(d.today, 9), time: '18:30', serviceTitle: 'Evening prayer', positionName: 'Sound', teamName: 'Tech', status: 'accepted', coVolunteers: [] },
  ];
  const results = viewStates(mySchedule, [
    ['loading', () => mySchedule.render({}, { loading: true })],
    ['next-serving-pending', () => mySchedule.render({}, { data: { nextServing: items[0], items }, loading: false })],
    ['confirmed', () => mySchedule.render({}, { message: 'Confirmed!', data: { nextServing: items[1], items: [items[1]] }, loading: false })],
    ['confirm-decline', () => mySchedule.render({}, { confirmId: 102, data: { nextServing: items[1], items: [items[1]] }, loading: false })],
    ['problem', () => mySchedule.render({}, { problem: 'Someone else took it.', data: { nextServing: items[0], items: [items[0]] }, loading: false })],
    ['nothing-yet', () => mySchedule.render({}, { data: { nextServing: null, items: [] }, loading: false })],
    ['error', () => mySchedule.render({}, { error: 'Network error', loading: false })],
  ], 'my-schedule');
  const errs = flatErrors(results);
  assert.equal(errs.length, 0, `my-schedule a11y errors: ${errs.join('; ')}`);
});

test('icons-a11y: every button and link in my-blockouts is accessible', () => {
  const results = viewStates(myBlockouts, [
    ['loading', () => myBlockouts.render({}, { loading: true })],
    ['with-days', () => myBlockouts.render({}, { list: d.BLOCKOUTS, loading: false })],
    ['saved-with-clash', () => myBlockouts.render({}, { list: d.BLOCKOUTS, message: 'Saved.', conflicts: [{ date: d.today, positionName: 'Sound' }], loading: false })],
    ['empty', () => myBlockouts.render({}, { list: [], loading: false })],
    ['error', () => myBlockouts.render({}, { error: 'Error', loading: false })],
  ], 'my-blockouts');
  const errs = flatErrors(results);
  assert.equal(errs.length, 0, `my-blockouts a11y errors: ${errs.join('; ')}`);
});

test('icons-a11y: every button and link in people is accessible', () => {
  const pm = (extra = {}) => ({
    people: [{ id: 3, name: 'Priya Demo', email: 'priya.demo@example.com', role: 'member', active: true, positionIds: [10] }],
    teams: [{ id: 1, name: 'Band', positions: [{ id: 10, name: 'Drums', qualifiedPersonIds: [3] }] }],
    query: '', loading: false, adding: false, newName: '',
    panel: null, secret: null, error: '', notice: '', me: 1, ...extra
  });
  const results = viewStates(people, [
    ['loading', () => people.render({})],
    ['list', () => people.renderScreen(pm())],
    ['adding', () => people.renderScreen(pm({ adding: true, newName: 'New Person' }))],
    ['secret', () => people.renderScreen(pm({ secret: { name: 'New Person', password: 'temp-pass' } }))],
    ['positions-panel', () => people.renderScreen(pm({ panel: { kind: 'positions', id: 3, checked: new Set([10]) } }))],
    ['active-panel', () => people.renderScreen(pm({ panel: { kind: 'active', id: 5 } }))],
    ['role-panel', () => people.renderScreen(pm({ panel: { kind: 'role', id: 6, role: 'admin' } }))],
    ['empty-query', () => people.renderScreen(pm({ query: 'zzz' }))],
    ['no-people', () => people.renderScreen(pm({ people: [] }))],
  ], 'people');
  const errs = flatErrors(results);
  assert.equal(errs.length, 0, `people a11y errors: ${errs.join('; ')}`);
});

test('icons-a11y: every button and link in teams is accessible', () => {
  const tm = (extra = {}) => ({
    teams: d.TEAMS,
    loading: false, panel: null, error: '', notice: '', ...extra
  });
  const results = viewStates(teams, [
    ['loading', () => teams.render({})],
    ['list', () => teams.renderScreen(tm())],
    ['add-position', () => teams.renderScreen(tm({ panel: { kind: 'add-position', id: 1 } }))],
    ['rename-team', () => teams.renderScreen(tm({ panel: { kind: 'rename-team', id: 1 } }))],
    ['delete-team', () => teams.renderScreen(tm({ panel: { kind: 'delete-team', id: 3 } }))],
    ['rename-position', () => teams.renderScreen(tm({ panel: { kind: 'rename-position', id: 11 } }))],
    ['delete-position', () => teams.renderScreen(tm({ panel: { kind: 'delete-position', id: 10 } }))],
    ['empty', () => teams.renderScreen(tm({ teams: [] }))],
  ], 'teams');
  const errs = flatErrors(results);
  assert.equal(errs.length, 0, `teams a11y errors: ${errs.join('; ')}`);
});

test('icons-a11y: every button and link in services is accessible', () => {
  const sm = (extra = {}) => ({
    teams: d.TEAMS, services: d.SERVICES, recent: d.SERVICES, loading: false, panel: null, error: '', notice: '', today: d.today, draft: null, adding: false, startKey: null, openTeams: new Set(), ...extra
  });
  const results = viewStates(services, [
    ['loading', () => services.render({})],
    ['list', () => services.renderScreen(sm())],
    ['add-form', () => services.renderScreen(sm({ adding: true }))],
    ['add-form-open-team', () => services.renderScreen(sm({ adding: true, startKey: null, openTeams: new Set([d.TEAMS[0].id]) }))],
    ['delete-panel', () => services.renderScreen(sm({ panel: { kind: 'delete', id: 1, count: 3 } }))],
    ['repeat-panel', () => services.renderScreen(sm({ panel: { kind: 'repeat', id: 2 } }))],
    ['error', () => services.renderScreen(sm({ error: 'Pick a number from 1 to 20.' }))],
    ['empty', () => services.renderScreen(sm({ services: [] }))],
  ], 'services');
  const errs = flatErrors(results);
  assert.equal(errs.length, 0, `services a11y errors: ${errs.join('; ')}`);
});

test('icons-a11y: every button and link in schedule is accessible (empty slots)', () => {
  const sm = (extra = {}) => ({
    services: [], teams: d.TEAMS, loading: false, error: '', notice: '', today: d.today, from: d.today, to: d.today, ...extra
  });
  const results = viewStates(schedule, [
    ['loading', () => schedule.render({})],
    ['no-services', () => schedule.renderScreen(sm({ services: [] }))],
    ['filled-slots', () => {
      const svc = d.SERVICES[0];
      return schedule.renderScreen({ ...sm(), services: [svc] });
    }],
  ], 'schedule');
  const errs = flatErrors(results);
  assert.equal(errs.length, 0, `schedule a11y errors: ${errs.join('; ')}`);
});

test('icons-a11y: every button and link in gaps is accessible', () => {
  const gm = (extra = {}) => ({
    loading: false, error: '', notice: '', summary: d.GAPS.summary, items: d.GAPS.items,
    reminders: { weekOf: d.sunday, list: d.REMINDERS, loading: false, error: '', notice: '' }, ...extra
  });
  const results = viewStates(gaps, [
    ['loading', () => gaps.render({})],
    ['with-gaps', () => gaps.renderScreen(gm())],
    ['no-gaps', () => gaps.renderScreen(gm({ summary: {}, items: [], reminders: { weekOf: d.sunday, list: [], loading: false, error: '', notice: '' } }))],
    ['empty-reminders', () => gaps.renderScreen(gm({ reminders: { weekOf: d.sunday, list: [], loading: false, error: '', notice: '' } }))],
  ], 'gaps');
  const errs = flatErrors(results);
  assert.equal(errs.length, 0, `gaps a11y errors: ${errs.join('; ')}`);
});

test('icons-a11y: nav links are accessible', () => {
  const adminNav = nav.render(admin, '/schedule');
  const memberNav = nav.render(member, '#/');
  const r1 = a11yCheck(adminNav);
  const r2 = a11yCheck(memberNav);
  const errs = [...r1.buttons, ...r1.links, ...r1.icons, ...r1.iconControls, ...r2.buttons, ...r2.links, ...r2.icons, ...r2.iconControls];
  assert.equal(errs.length, 0, `nav a11y errors: ${errs.join('; ')}`);
});

test('icons-a11y: not-found page is accessible', () => {
  const r = a11yCheck(notFound.render({ user: admin }));
  const errs = [...r.buttons, ...r.links, ...r.icons, ...r.iconControls];
  assert.equal(errs.length, 0, `notfound a11y errors: ${errs.join('; ')}`);
});

test('icons-a11y: all icons used across all views are valid', () => {
  // Collect every data-icon reference across all rendered view states
  const allHtml = [];

  // People
  allHtml.push(String(people.renderScreen({
    people: [{ id: 1, name: 'Test', email: 't@example.com', role: 'admin', active: true, positionIds: [] }],
    teams: [], query: '', loading: false, adding: false, newName: '', panel: null, secret: null, error: '', notice: '', me: 1
  })));

  // Teams
  allHtml.push(String(teams.renderScreen({ teams: [], loading: false, panel: null, error: '', notice: '' })));

  // Services
  allHtml.push(String(services.renderScreen({ teams: [], services: [], recent: [], loading: false, panel: null, error: '', notice: '', today: d.today, draft: null, adding: true, startKey: null, openTeams: new Set() })));

  // Schedule
  allHtml.push(String(schedule.renderScreen({ services: [], teams: [], loading: false, error: '', notice: '', today: d.today, from: d.today, to: d.today })));

  // Gaps
  allHtml.push(String(gaps.renderScreen({ loading: false, error: '', notice: '', summary: {}, items: [], reminders: { weekOf: d.sunday, list: [], loading: false, error: '', notice: '' } })));

  // My schedule
  allHtml.push(String(mySchedule.render({}, { loading: false, data: { nextServing: null, items: [] } })));

  // My blockouts
  allHtml.push(String(myBlockouts.render({}, { loading: false, list: [] })));

  // Login
  allHtml.push(String(login.render({})));

  // Password
  allHtml.push(String(password.render({ user: {} })));

  // Nav
  allHtml.push(String(nav.render(admin, '/schedule')));

  // Not found
  allHtml.push(String(notFound.render({ user: admin })));

  const seenIcons = new Set();
  for (const htmlStr of allHtml) {
    const re = /data-icon="([^"]*)"/gi;
    let m;
    while ((m = re.exec(htmlStr)) !== null) {
      seenIcons.add(m[1]);
    }
  }

  const invalid = [...seenIcons].filter((n) => !ICON_NAMES.includes(n) && !ART_NAMES.includes(n));
  assert.equal(invalid.length, 0, `invalid icons found across all views: ${invalid.join(', ')}`);
});

test('icons-a11y: gallery shows every new icon and the dictionary', () => {
  const galleryHtml = String(renderGallery());
  const NEW_ICONS = ['key', 'shield', 'user-off', 'user-check', 'list-check', 'send', 'refresh', 'filter', 'dot'];
  for (const n of NEW_ICONS) {
    assert.ok(galleryHtml.includes(`data-icon="${n}"`), `gallery missing icon ${n}`);
  }
  // Icon section title
  assert.ok(galleryHtml.includes('<h2 class="gallery-h" id="g-icons-h">Icons</h2>'), 'gallery includes icons section');
  // All icon names rendered
  for (const n of ICON_NAMES) {
    assert.ok(galleryHtml.includes(`<code>${n}</code>`), `gallery missing icon name ${n}`);
  }
  // ART names too
  for (const n of ART_NAMES) {
    assert.ok(galleryHtml.includes(`data-icon="${n}"`), `gallery missing art name ${n}`);
  }
});

test('icons-a11y: icon buttons always have labels (proactive check)', () => {
  // iconButton() always requires a label; verify it renders with aria-label + title
  const out = String(iconButton('trash', 'Delete service'));
  assert.ok(out.includes('aria-label="Delete service"'), 'iconButton has aria-label');
  assert.ok(out.includes('title="Delete service"'), 'iconButton has title');
  assert.ok(out.includes('data-icon="trash"'), 'iconButton contains the icon');
});

test('icons-a11y: deliberately unlabelled icon button triggers failure', () => {
  // Build a fake button like a view would, but without a label, to prove our guard catches it.
  // This is a hand-crafted HTML string representing a broken icon button.
  const brokenButton = '<button type="button" class="icon-btn"><span class="icon" data-icon="x" aria-hidden="true"></span></button>';
  const r = a11yCheck(brokenButton);
  assert.equal(r.buttons.length, 1, 'should detect an unlabeled icon button');
  assert.ok(r.buttons[0].problem.includes('aria-label'), `problem: ${r.buttons[0].problem}`);
  // Now remove it and prove it's gone
  const clean = '<button type="button" class="icon-btn" aria-label="Close"><span class="icon" data-icon="x" aria-hidden="true"></span></button>';
  const r2 = a11yCheck(clean);
  assert.equal(r2.buttons.length, 0, 'labelled icon button should pass');
});

// ---------- helpers ----------

function flatErrors(results) {
  const errs = [];
  for (const r of results) {
    if (r.error) errs.push(`${r.stateName}: ${r.error}`);
    for (const b of r.buttons || []) errs.push(`${r.stateName} button: ${b.problem}`);
    for (const l of r.links || []) errs.push(`${r.stateName} link: ${l.problem}`);
    for (const i of r.icons || []) errs.push(`${r.stateName} icon: ${i.problem}`);
    for (const c of r.iconControls || []) errs.push(`${r.stateName} icon-control: ${c.problem}`);
  }
  return errs;
}
