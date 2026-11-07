// Starts the app in the browser: checks who is logged in, then shows the page
// for the current #hash. Re-renders when the hash changes.
import { createApi } from './api.js';
import { resolve } from './routes.js';
import * as nav from './views/nav.js';
import { TOAST_REGION, createToaster } from './lib/toast.js';
import { watchIcons } from './lib/icons.js';
import { skeleton } from './lib/ui.js';

const GENERIC = 'Something went wrong. Please reload the page and try again.';

// The page frame: sticky top bar (with the menu), the toast region, the page.
export const SHELL = `
    <header class="top" id="top"></header>
    ${TOAST_REGION}
    <main class="main" id="main" tabindex="-1"></main>`;

export function createApp({ root, win = globalThis.window, api = createApi() }) {
  const doc = root.ownerDocument;
  const state = { user: null };
  let pending = null; // message to keep through the next page change
  let renderCount = 0;

  root.innerHTML = SHELL;
  const top = root.querySelector('#top');
  const toaster = createToaster(root.querySelector('#message'), { win });
  const main = root.querySelector('#main');
  watchIcons(root, win);

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

  function setUser(user) { state.user = user; }

  const ctx = { api, state, win, navigate, showError, showMessage, setUser, rerender: () => render() };

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
      top.innerHTML = nav.render(state, hash);
      nav.mount(top, ctx);
      main.innerHTML = view.render(state);
      doc.title = view.title ? `${view.title} – Flock` : 'Flock';
      const heading = main.querySelector('h1');
      if (renderCount++ > 0 && heading) heading.focus();
      const result = view.mount(main, ctx);
      if (result && typeof result.catch === 'function') result.catch(handleError);
    } catch (err) {
      handleError(err);
    }
  }

  function handleError(err) {
    showError(err && err.name === 'ApiError' ? err.message : GENERIC);
  }

  async function start() {
    win.addEventListener('hashchange', render);
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
