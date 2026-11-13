// Starts the app in the browser: checks who is logged in, then shows the page
// for the current #hash. Re-renders when the hash changes.
import { createApi } from './api.js';
import { resolve, pathOf } from './routes.js';
import * as nav from './views/nav.js';
import * as account from './views/account.js';
import * as offline from './views/offline.js';
import * as installSteps from './views/install-steps.js';
import { createInstall, canInstall, isIosSafari } from './lib/install.js';
import { createSheet } from './lib/sheet.js';
import { watchScroll } from './lib/topbar.js';
import { swipeToDismiss } from './lib/swipe.js';
import { TOAST_REGION, createToaster } from './lib/toast.js';
import { watchIcons } from './lib/icons.js';
import { skeleton } from './lib/ui.js';
import * as push from './lib/push.js';
import { registerWorker, applyUpdate, watchUpdates } from './lib/worker.js';
import { loadCounts, setAppBadge } from './lib/counts.js';

const GENERIC = 'Something went wrong. Please reload the page and try again.';

// The page frame: sticky top bar (with the menu), the toast region, the page,
// and the layer that sheets over the whole app are painted in (the account sheet).
export const SHELL = `
    <header class="top" id="top"></header>
    ${TOAST_REGION}
    <main class="main" id="main" tabindex="-1"></main>
    <div id="layer"></div>`;

export function createApp({ root, win = globalThis.window, api = createApi() }) {
  const doc = root.ownerDocument;
  const state = { user: null, accountOpen: false, installSteps: false, counts: { answer: 0, gaps: 0 } };
  let pending = null; // message to keep through the next page change
  let renderCount = 0;

  root.innerHTML = SHELL;
  const top = root.querySelector('#top');
  const toaster = createToaster(root.querySelector('#message'), { win });
  const main = root.querySelector('#main');
  const layer = root.querySelector('#layer');
  watchIcons(root, win);
  const checkScroll = watchScroll(win, top, main);
  let pageTitle = '';
  // A new page fades in (its heading rises a little); the same page painted again does not.
  let shownPath = null;
  main.addEventListener('animationend', (e) => { if (e.target === main) main.classList.remove('is-entering'); });

  // A message shown now stays through the next page change (pending.shown);
  // one saved for later (pending without shown) appears on the next page.
  function showError(message) {
    const text = message || GENERIC;
    pending = { text, kind: 'error', shown: true };
    toaster.show(text, 'error');
  }
  function showMessage(message) {
    if (!message) return;
    pending = { text: message, kind: 'ok', shown: true };
    toaster.show(message, 'ok');
  }

  function navigate(hash) {
    if (win.location.hash === hash) render();
    else win.location.hash = hash;
  }

  function setUser(user) {
    state.user = user;
    if (!user) {
      state.push = null; pushFor = null; state.accountOpen = false; state.installSteps = false; paintLayer();
      countsFor = null; state.counts = { answer: 0, gaps: 0 }; setAppBadge(win, 0);
      return;
    }
    // The login reply names the person only; the account sheet also shows the
    // email. Fill in the rest quietly (start-up already has it from /api/me).
    if (!('email' in user)) {
      api.get('/api/me').then((r) => {
        if (state.user !== user || !r?.person) return;
        Object.assign(user, r.person);
        if (state.accountOpen) paintLayer();
      }).catch(() => { /* the sheet just shows less */ });
    }
  }

  function paintTop() {
    top.innerHTML = nav.render(state, win.location.hash, pageTitle);
    nav.mount(top, ctx);
  }

  // ----- the account sheet (opened by the avatar in the top bar) -----
  const accountSheet = createSheet({
    root: layer,
    isOpen: () => state.accountOpen,
    close: () => closeAccount(),
    panel: '[data-account-panel]',
    opener: () => '[data-action="account"]',
    openerRoot: top,
  });
  // One layer, one sheet at a time: the account sheet or the iPhone install steps.
  function paintLayer() {
    accountSheet.before();
    stepsSheet.before();
    layer.innerHTML = account.render(state, { canInstall: canInstall(installer, win) }) || installSteps.render(state);
    accountSheet.update();
    stepsSheet.update();
    const sheet = layer.querySelector('.sheet');
    if (sheet) swipeToDismiss(sheet, { win, onDismiss: () => (state.accountOpen ? closeAccount() : closeInstallSteps()) });
  }
  function openAccount() {
    if (!state.user || state.accountOpen) return;
    state.accountOpen = true;
    accountSheet.opened('account');
    paintTop();
    paintLayer();
  }
  // focus: false when leaving the page anyway (a link, logging out).
  function closeAccount({ focus = true } = {}) {
    if (!state.accountOpen) return;
    state.accountOpen = false;
    if (!focus) accountSheet.opened(null);
    paintTop();
    paintLayer();
  }
  const toggleAccount = () => (state.accountOpen ? closeAccount() : openAccount());

  // ----- putting Flock on the Home Screen (web/lib/install.js) -----
  const installer = createInstall(win);
  const stepsSheet = createSheet({
    root: layer,
    isOpen: () => state.installSteps,
    close: () => closeInstallSteps(),
    panel: '[data-install-panel]',
    opener: () => '[data-action="install"]',
    openerRoot: root,
  });
  function openInstallSteps() {
    state.installSteps = true;
    stepsSheet.opened('install');
    paintLayer();
  }
  function closeInstallSteps({ focus = true } = {}) {
    if (!state.installSteps) return;
    state.installSteps = false;
    if (!focus) stepsSheet.opened(null);
    paintLayer();
  }
  // The browser's own prompt where there is one; the three steps on an iPhone.
  async function install() {
    if (installer.canPrompt()) return installer.prompt();
    if (isIosSafari(win)) { openInstallSteps(); return 'steps'; }
    return 'unavailable';
  }
  layer.addEventListener('click', (e) => {
    const el = e.target?.closest?.('[data-action]');
    if (state.installSteps && el?.dataset?.action === 'install-close') closeInstallSteps();
  });

  // ----- the numbers on the tabs and the app icon (web/lib/counts.js) -----
  let countsFor = null;
  // Pages that already loaded a number pass it here (My schedule, Gaps).
  function setCounts(next) {
    const before = `${state.counts.answer}/${state.counts.gaps}`;
    state.counts = { ...state.counts, ...next };
    setAppBadge(win, state.counts.answer);
    if (state.user && `${state.counts.answer}/${state.counts.gaps}` !== before) paintTop();
  }
  // After a change elsewhere (assigning, autofill): ask the server again.
  async function refreshCounts() {
    const user = state.user;
    if (!user) return;
    const c = await loadCounts(api, user);
    if (state.user === user) setCounts(c);
  }

  const ctx = {
    api, state, win, navigate, showError, showMessage, setUser, paintTop, rerender: () => render(),
    openAccount, closeAccount, toggleAccount, setCounts, refreshCounts,
    install, installer, canInstall: () => canInstall(installer, win),
  };
  account.mount(layer, ctx);

  // Push notifications (decision 0008): loaded once per login, in the
  // background; pages that show them wait on ctx.pushReady. Never breaks the app.
  let pushFor = null;
  function loadPush() {
    const p = { enabled: false, publicKey: null, support: push.support(win), status: 'off' };
    state.push = p;
    ctx.pushReady = (async () => {
      try {
        Object.assign(p, await api.get('/api/push'));
        if (p.enabled) p.status = await push.sync(win, api, p);
      } catch { /* push is an extra: the page works without it */ }
      if (state.push === p) paintTop();
      return p;
    })();
  }

  api.onUnauthorized = () => {
    if (!state.user) return;
    state.user = null;
    pending = { text: 'Please log in again.', kind: 'error' };
    navigate('#/login');
  };

  function render() {
    try {
      const hash = win.location.hash;
      const r = resolve(hash, state.user);
      if (r.redirect) {
        if (hash !== r.redirect) {
          win.history.replaceState(null, '', r.redirect);
          render();
          return;
        }
      }
      const view = r.route.view;
      if (pending) {
        if (!pending.shown) toaster.show(pending.text, pending.kind);
        pending = null;
      } else toaster.clear();
      if (state.user && pushFor !== state.user.id) { pushFor = state.user.id; loadPush(); }
      if (state.user && countsFor !== state.user.id) { countsFor = state.user.id; refreshCounts().catch(() => {}); }
      pageTitle = view.title ?? '';
      paintTop();
      const path = pathOf(win.location.hash);
      if (shownPath !== null && path !== shownPath) main.classList.add('is-entering');
      shownPath = path;
      main.innerHTML = view.render(state);
      doc.title = view.title ? `${view.title} – Flock` : 'Flock';
      const heading = main.querySelector('h1');
      if (renderCount++ > 0 && heading) heading.focus();
      const result = view.mount(main, ctx);
      if (result && typeof result.catch === 'function') result.catch(handleError);
      checkScroll();
    } catch (err) {
      handleError(err);
    }
  }

  function handleError(err) {
    showError(err && err.name === 'ApiError' ? err.message : GENERIC);
  }

  // A new version of the app that is ready takes over at a page change,
  // never in the middle of one (decision 0009). The page then reloads once.
  function onHashChange() {
    if (offlineShown) { boot(); return; }
    applyUpdate(win);
    closeAccount({ focus: false });
    closeInstallSteps({ focus: false });
    render();
  }

  // ----- "Can't reach the server" (views/offline.js) -----
  let offlineShown = false;
  let trying = null;
  function showOffline(busy) {
    offlineShown = true;
    top.innerHTML = '';
    main.innerHTML = offline.render({ busy });
    doc.title = `${offline.title} – Flock`;
  }

  // Who is logged in, then the page. If the server cannot be reached (no
  // signal, or it is waking up), the offline page, until a try works.
  function boot() {
    if (trying) return trying;
    trying = (async () => {
      const again = offlineShown;
      if (again) showOffline(true);
      try {
        const r = await api.get('/api/me');
        state.user = r?.person ?? null;
      } catch (err) {
        if (err?.status !== 401) {
          showOffline(false);
          if (again) main.querySelector('h1')?.focus?.(); // say it again to a screen reader
          return;
        }
        state.user = null;
      }
      offlineShown = false;
      render();
    })().finally(() => { trying = null; });
    return trying;
  }

  async function start() {
    watchUpdates(win);
    registerWorker(win).catch(() => { /* no worker: Flock works, just not offline */ });
    win.addEventListener('hashchange', onHashChange);
    win.addEventListener('unhandledrejection', (e) => { e.preventDefault(); handleError(e.reason); });
    win.addEventListener('error', (e) => { e.preventDefault(); handleError(e.error); });
    // Try again by itself when the phone gets a connection back, or Flock comes back to the screen.
    win.addEventListener('online', () => { if (offlineShown) boot(); });
    doc?.addEventListener?.('visibilitychange', () => {
      if (offlineShown && doc.visibilityState === 'visible') boot();
    });
    main.addEventListener('click', (e) => {
      const el = e.target?.closest?.('[data-action]');
      if (offlineShown && el?.dataset?.action === 'retry-start') boot();
    });
    main.innerHTML = String(skeleton('Loading…', 'cards', 2));
    await boot();
  }

  return { state, render, start, navigate, showError, showMessage };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const root = document.getElementById('app');
  if (root) createApp({ root, win: window }).start();
}
