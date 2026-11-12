// Notifications (the bell in the top bar, decision 0008): turn them on or off
// for this device, send a test, or see how to get them on an iPhone.
import { html } from '../lib/html.js';
import { iconSlot } from '../lib/icons.js';
import { toasts } from '../lib/toast.js';
import { pageHead } from '../lib/ui.js';
import { makeHost, isAlive } from '../lib/host.js';
import * as push from '../lib/push.js';

export const title = 'Notifications';

const WHAT = "Get a notification on this device when you're asked to serve, and when a service you're on moves or is cancelled.";
const ADMIN = "As a scheduler, you also hear when someone can't serve.";

function iphoneSteps() {
  return html`
    <p>On an iPhone, Flock can only send notifications once it is on your Home Screen.</p>
    <ol class="steps">
      <li>Tap the <strong>Share</strong> button at the bottom of Safari (the square with an arrow).</li>
      <li>Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
      <li>Open <strong>Flock</strong> from your Home Screen.</li>
      <li>Log in.</li>
      <li>Tap the bell at the top, then <strong>Turn on</strong>.</li>
    </ol>`;
}

const BLOCKED = html`
  <p>Notifications are blocked for Flock on this device. To allow them:</p>
  <ul class="steps">
    <li><strong>iPhone:</strong> Settings → Notifications → Flock → Allow Notifications.</li>
    <li><strong>Android:</strong> tap the settings icon next to the address bar (or long-press the Flock icon → App info) → Notifications → Allow.</li>
    <li><strong>Computer:</strong> click the icon next to the address bar → Notifications → Allow.</li>
  </ul>
  <p>Then come back here and tap <strong>Turn on</strong>.</p>`;

function body(p, view, isAdmin) {
  if (!p) return html`<p class="hint">Loading…</p>`;
  if (!p.enabled) return html`<p>Notifications are not set up on this Flock yet. Your scheduler can turn them on.</p>`;
  if (p.support === 'ios-install') return iphoneSteps();
  if (p.support === 'ios-update') return html`<p>To get notifications, update your iPhone to iOS 16.4 or newer (Settings → General → Software Update), then come back.</p>`;
  if (p.support === 'unsupported') return html`<p>This browser cannot show notifications from Flock. Try Chrome, Edge or Firefox, or Safari on a Mac.</p>`;
  const busy = view.busy ? 'disabled' : '';
  const extra = isAdmin ? html`<p class="hint">${ADMIN}</p>` : '';
  if (p.status === 'on') {
    return html`
      <div class="notice notice-info">${iconSlot('check', 'notice-icon')}<p class="notice-body">Notifications are on for this device.</p></div>
      ${extra}
      <div class="btn-row">
        <button type="button" class="btn btn-primary" data-action="push-test" ${busy}>Send me a test</button>
        <button type="button" class="btn" data-action="push-off" ${busy}>Turn off</button>
      </div>`;
  }
  return html`
    <p>${WHAT}</p>
    ${extra}
    ${p.status === 'blocked' ? BLOCKED : ''}
    <div class="btn-row"><button type="button" class="btn btn-primary" data-action="push-on" ${busy}>Turn on</button></div>`;
}

// view: { busy, message, problem }
export function render(state, view = {}) {
  return String(html`
    ${pageHead(title)}
    ${toasts([[view.message, 'ok', 'data-note'], [view.problem, 'error']])}
    <section class="card push-card">
      ${body(state?.push, view, state?.user?.role === 'admin')}
      <p class="hint">This is for this device only. Turn it on on each phone or computer you use.</p>
    </section>
  `);
}

/** The shared tap handlers for Turn on (also used by the My schedule card). */
export async function turnOn(ctx) {
  const p = ctx.state.push;
  p.status = await push.turnOn(ctx.win, ctx.api, p);
  ctx.paintTop?.();
  if (p.status === 'on') return 'Notifications are on for this device.';
  if (p.status === 'blocked') throw new Error('Notifications are blocked for Flock on this device. See below for how to allow them.');
  return null;
}

export function mount(main, ctx) {
  const root = makeHost(main);
  const view = {};
  const paint = () => { if (isAlive(root, main)) root.innerHTML = render(ctx.state, view); };
  const run = async (fn) => {
    view.busy = true; view.message = null; view.problem = null;
    paint();
    try {
      view.message = await fn();
    } catch (err) {
      if (err?.status === 401) return;
      view.problem = err?.message || 'Something went wrong. Please try again.';
    }
    view.busy = false;
    paint();
  };
  root.addEventListener('click', (e) => {
    const el = e.target?.closest?.('[data-action]');
    const action = el?.dataset?.action;
    if (action === 'push-on') return run(() => turnOn(ctx));
    if (action === 'push-off') {
      return run(async () => {
        ctx.state.push.status = await push.turnOff(ctx.win, ctx.api);
        ctx.paintTop?.();
        return 'Notifications are off for this device.';
      });
    }
    if (action === 'push-test') {
      return run(async () => {
        await push.sendTest(ctx.win, ctx.api);
        return 'Sent. It should arrive in a few seconds.';
      });
    }
    return undefined;
  });
  paint();
  ctx.pushReady?.then(() => { if (!view.busy) paint(); });
}
