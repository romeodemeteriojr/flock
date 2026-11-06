// Starts the app in the browser: checks who is logged in, then shows the page
// for the current #hash. Re-renders when the hash changes.
import { createApi } from './api.js';
import { resolve } from './routes.js';
import * as nav from './views/nav.js';

const GENERIC = 'Something went wrong. Please reload the page and try again.';

export function createApp({ root, win = globalThis.window, api = createApi() }) {
  const doc = root.ownerDocument;
  const state = { user: null };
  let pending = null; // message to keep through the next page change
  let renderCount = 0;

  root.innerHTML = `
    <header class="top" id="top"></header>
    <div class="message" id="message" role="alert" hidden></div>
    <main class="main" id="main" tabindex="-1"></main>`;
  const top = root.querySelector('#top');
  const box = root.querySelector('#message');
  const main = root.querySelector('#main');

  function showBox(text, kind) {
    box.textContent = text;
    box.className = `message message-${kind}`;
    box.hidden = false;
  }
  function hideBox() {
    box.hidden = true;
    box.textContent = '';
  }
  function showError(message) {
    const text = message || GENERIC;
    pending = { text, kind: 'error' };
    showBox(text, 'error');
  }
  function showMessage(message) {
    pending = { text: message, kind: 'ok' };
    showBox(message, 'ok');
  }

  function navigate(hash) {
    if (win.location.hash === hash) render();
    else win.location.hash = hash;
  }

  function setUser(user) { state.user = user; }

  const ctx = { api, state, navigate, showError, showMessage, setUser, rerender: () => render() };

  api.onUnauthorized = () => {
    if (!state.user) return;
    state.user = null;
    pending = { text: 'Please log in again.', kind: 'error' };
    navigate('#/login');
  };
  api.onMustChange = () => {
    if (state.user) state.user = { ...state.user, mustChangePassword: true };
    navigate('#/password');
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
      if (pending) { showBox(pending.text, pending.kind); pending = null; } else hideBox();
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
    main.innerHTML = '<p class="loading">Loading…</p>';
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
