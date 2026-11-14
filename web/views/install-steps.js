// "Add Flock to your Home Screen": the steps for this phone and browser
// (installKind in web/lib/install.js), where the browser has no install
// prompt of its own. A sheet in #layer, opened from the install card on My
// schedule or the account sheet's "Install Flock" row. The Notifications page
// shows the same steps on an iPhone.
import { html, raw } from '../lib/html.js';
import { iconSlot } from '../lib/icons.js';
import { copyInner } from '../lib/copyflash.js';

export const title = 'Add Flock to your Home Screen';

const OPEN_FROM_HOME = { text: html`Open <strong>Flock</strong> from your Home Screen and log in.`, icon: 'flock' };

// kind → { heading, intro, steps: [{ text, icon }], copy }
const GUIDES = {
  'ios-safari': {
    heading: title,
    steps: [
      { text: html`Tap <strong>Share</strong> in Safari's toolbar. <span class="hint">No Share button? Tap <strong>•••</strong> first, then <strong>Share</strong>.</span>`, icon: 'share' },
      { text: html`Scroll down and tap <strong>Add to Home Screen</strong>. <span class="hint">Not in the list? Tap <strong>View More</strong> or <strong>More</strong> at the bottom.</span>`, icon: 'add-square' },
      { text: html`Leave <strong>Open as Web App</strong> on if you see it, then tap <strong>Add</strong>.`, icon: 'check' },
      OPEN_FROM_HOME,
    ],
  },
  'ios-browser': {
    heading: title,
    steps: [
      { text: html`Tap <strong>Share</strong>. <span class="hint">It's next to the address bar, or in the browser's menu (<strong>•••</strong> or <strong>≡</strong>).</span>`, icon: 'share' },
      { text: html`Choose <strong>Add to Home Screen</strong>. <span class="hint">Not in the list? Tap <strong>More</strong> or <strong>View More</strong>.</span>`, icon: 'add-square' },
      { text: html`Tap <strong>Add</strong>.`, icon: 'check' },
      OPEN_FROM_HOME,
    ],
  },
  'ios-inapp': {
    heading: 'Open Flock in Safari first',
    intro: html`This browser can't add Flock to your Home Screen. Safari can.`,
    steps: [
      { text: html`Tap <strong>•••</strong> or <strong>Share</strong> in this app and choose <strong>Open in Safari</strong> (or <strong>Open in browser</strong>).`, icon: 'more' },
      { text: html`No such option? Tap <strong>Copy link</strong> below, open <strong>Safari</strong> and paste it in the address bar.`, icon: 'copy' },
      { text: html`Log in to Flock in Safari, then tap <strong>Show me how</strong> on My schedule.`, icon: 'flock' },
    ],
    copy: true,
  },
  android: {
    heading: title,
    steps: [
      { text: html`Tap the browser's menu: <strong>⋮</strong> (or <strong>≡</strong> in Samsung Internet).`, icon: 'more-vertical' },
      { text: html`Choose <strong>Add to Home screen</strong> or <strong>Install app</strong>. <span class="hint">In Samsung Internet: <strong>Add page to</strong>, then <strong>Home screen</strong>.</span>`, icon: 'add-square' },
      { text: html`Tap <strong>Add</strong> or <strong>Install</strong>.`, icon: 'check' },
      { text: html`Open <strong>Flock</strong> from your Home screen.`, icon: 'flock' },
    ],
  },
  'android-inapp': {
    heading: 'Open Flock in Chrome first',
    intro: html`This browser can't add Flock to your Home screen. Chrome can.`,
    steps: [
      { text: html`Tap <strong>⋮</strong> in this app and choose <strong>Open in Chrome</strong> (or <strong>Open in browser</strong>).`, icon: 'more-vertical' },
      { text: html`No such option? Tap <strong>Copy link</strong> below, open <strong>Chrome</strong> and paste it in the address bar.`, icon: 'copy' },
      { text: html`Log in to Flock there, then tap <strong>Install</strong> on My schedule.`, icon: 'flock' },
    ],
    copy: true,
  },
};

/** The guide for this kind of phone, or null (installed, or a computer). */
export function guideFor(kind) {
  return GUIDES[kind] ?? null;
}

/** The numbered steps, with the Copy link button where the page must move to another browser. */
export function stepsList(kind) {
  const g = guideFor(kind);
  if (!g) return '';
  return html`${g.intro ? html`<p class="howto-intro">${g.intro}</p>` : ''}<ol class="howto">
      ${g.steps.map((s, i) => html`<li><span class="howto-num">${i + 1}</span><span class="howto-text">${s.text}</span>${iconSlot(s.icon, 'howto-icon')}</li>`)}
    </ol>${g.copy ? html`<div class="btn-row howto-copy"><button type="button" class="btn" data-action="install-copy" data-copy-key="install-link">${raw(copyInner('Copy link', false))}</button></div>` : ''}`;
}

/** The sheet's markup, or '' when it is closed (state.installSteps holds the kind). */
export function render(state) {
  const g = state?.installSteps ? guideFor(state.installSteps) : null;
  if (!g) return '';
  return String(html`<div class="sheet-layer is-entering" data-install-sheet>
  <div class="sheet-backdrop" data-action="install-close"></div>
  <section class="sheet" data-install-panel role="dialog" aria-modal="true" aria-labelledby="install-title">
    <div class="sheet-grab" aria-hidden="true"></div>
    <div class="sheet-head"><h2 id="install-title" tabindex="-1">${g.heading}</h2><button type="button" class="icon-btn" data-action="install-close" aria-label="Close">${iconSlot('x')}</button></div>
    <div class="sheet-body">${stepsList(state.installSteps)}</div>
  </section></div>`);
}
