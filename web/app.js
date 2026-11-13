// Starts the app in the browser: checks who is logged in, then shows the page
// for the current #hash. Re-renders when the hash changes.
import { createApi } from './api.js';
import { resolve } from './routes.js';
import * as nav from './views/nav.js';
import * as account from './views/account.js';
import { createSheet } from './lib/sheet.js';
import { watchScroll } from './lib/topbar.js';
import { TOAST_REGION, createToaster } from './lib/toast.js';
import { watchIcons } from './lib/icons.js';
import { skeleton } from './lib/ui.js';
import * as push from './lib/push.js';
import { registerWorker, applyUpdate, watchUpdates } from './lib/worker.js';

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
  const state = { user: null, accountOpen: false };
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
    if (!user) { state.push = null; pushFor = null; state.accountOpen = false; paintLayer(); }
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
  function paintLayer() {
    accountSheet.before();
    layer.innerHTML = account.render(state, { canInstall: false });
    accountSheet.update();
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

  const ctx = {
    api, state, win, navigate, showError, showMessage, setUser, paintTop, rerender: () => render(),
    openAccount, closeAccount, toggleAccount,
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
      pageTitle = view.title ?? '';
      paintTop();
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
    applyUpdate(win);
    closeAccount({ focus: false });
    render();
  }

  async function start() {
    watchUpdates(win);
    registerWorker(win).catch(() => { /* no worker: Flock works, just not offline */ });
    win.addEventListener('hashchange', onHashChange);
    win.addEventListener('unhandledrejection', (e) => { e.preventDefault(); handleError(e.reason); });
    win.addEventListener('error', (e) => { e.preventDefault(); handleError(e.error); });
    main.innerHTML = String(skeleton('Loading…', 'cards', 2));
    try {
      const r = await api.get('/api/me');
      state.user = r?.person ?? null;
    } catch (err) {
      state.user = null;
      if (err.status !== 401) pending = { text: err.message, kind: 'error' };
    }
    render();
  }

  return { state, render, start, navigate, showError, showMessage };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const root = document.getElementById('app');
  if (root) createApp({ root, win: window }).start();
}
