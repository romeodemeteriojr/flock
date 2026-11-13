# Changelog

## Unreleased

### App feel

- **Faster opening, less data.** Every file Flock sends has a fingerprint (an ETag). The phone asks "has this changed?" and gets a short "no" when it has not, instead of the whole file again. Text files are sent packed (brotli or gzip), about a third of their size. Pictures and the font may be kept for a day.
- **Opens at once, even on bad signal.** The phone keeps a copy of Flock's own files (pages, scripts, styles, font, icons; never your data), so an installed Flock opens straight away, also while the server is waking up. Every device now gets the small background helper (service worker), not only those with notifications on (decision `docs/decisions/0009-app-shell-cache.md`).
- **Updates reach installed phones by themselves.** The server puts the list of the app's files, with a fingerprint of each, at the top of `/sw.js`, so any new release changes it. The phone fetches the new version in the background and switches to it at the next tap that changes the page (one quick reload). It looks for a new version when the app comes back to the screen, at most every 30 minutes.
- The privacy page says the phone keeps a copy of Flock's files, with nothing about you in it.
- **Edge to edge.** On phones with a notch or rounded corners Flock now fills the whole screen; the top bar, the page and the messages keep clear of the notch and the status bar.
- **"Can't reach the server"** instead of the browser's error page. If Flock cannot reach the church's server when it opens (no signal, or the server is still waking up), it says so, with **Try again**. It also tries again by itself when the phone gets its connection back or Flock comes back to the screen, and then opens the page you asked for. Before, Flock showed the login page with an error.
- **A slimmer top bar.** Just the Flock mark, the bell and your picture. When you scroll down, the page's name slides into the bar. "Logged in as", the key and **Log out** have moved:
- **Your account** is a new sheet that opens when you tap your picture: who you are (name, Scheduler or Volunteer, email), **Notifications**, **Change my password** and **Log out**. Close it with the X, by tapping outside it or with Escape.
- **Numbers on the tabs.** My schedule shows how many asks are waiting for your answer; schedulers see how many gaps there are on Gaps (on a phone, the asks also show on More). Screen readers hear the words ("2 to answer"). An installed Flock also shows the number of asks on its app icon, where the phone supports it.
- **More is a bottom sheet** on phones, rising from behind the tab bar with bigger rows.
- **Put Flock on your Home Screen.** On a phone that can install Flock and has not yet, My schedule shows a small card (after the notifications card, never both at once). On Android and in desktop Chrome or Edge, **Install** brings up the browser's own install box. On an iPhone, **Show me how** opens the three steps in Safari (Share, Add to Home Screen, Add). **Not now** hides it on that device; **Install Flock** stays in the account sheet.
- **Share** invites and reminders straight to Messages, WhatsApp or email, on phones that have a share sheet: **Share** in the invite box (before **Copy message**), **Share all** and **Share** on each reminder in Gaps. What is shared is exactly what Copy copies. Copy is still there; where there is no share sheet nothing changes.
- **Shortcuts.** Press and hold the Flock icon on Android (and in desktop Chrome or Edge) for **My schedule** and **Days off**.

## 0.6.0

No database changes: it deploys over 0.5.1 as it is. Nothing works differently; everything looks different.

### A new look

- **A new mark and app icon.** A white bird on an indigo tile, in the top bar, on the login page, as the browser tab icon and on the phone's home screen. Android gets its own full-bleed ("maskable") icons, so the phone can cut the icon to its own shape without a white box around it, and a small one-colour picture for the status bar when a notification arrives. People who already added Flock to their home screen may need to remove it and add it again to see the new icon.
- **One brand colour.** Indigo, on soft, slightly tinted greys, in light and dark. Cards are white with a hairline and a soft shadow, page titles are bigger and bolder, corners are rounder. The colour list at the top of `web/style.css` is the one place to change it.
- **Every icon redrawn** on one grid with one line weight. Four new ones, so each page has its own picture in the menu: a crossed-out calendar for Days off, a group for Teams, a church for Services, a missing puzzle piece for Gaps (the Schedule is a calendar). The four empty-state pictures are redrawn to match.
- **The tab bar** marks the page you are on with a soft pill, a filled-in icon and bold text. **More** opens a rounded card with bigger rows.
- **Tags, buttons and fields.** Status tags are soft pills with a symbol and a word. The main button is filled and the others are outlined; "I can't" and "Remove person" are soft red, and solid red only where you confirm. Fields are rounder; the choice lists (for example "I can serve") have Flock's own arrow in place of the browser's. The either/or switch on the slot panel shows the chosen side as a raised white tile. Messages at the bottom of the screen are rounder with the symbol in a tinted circle.
- **Faster first load on a phone.** The bundled font now holds Latin letters only (English, accented European letters, Vietnamese, Pacific names with macrons or an ʻokina): 85 KB, down from 352 KB. Names in other alphabets, such as Greek or Cyrillic, are shown in the phone's own font.
- The component gallery (`/gallery.html`) shows the new colours and icons.

### Fixed

- The count on each Gaps service had square corners (it used a corner size that did not exist).
- The bell in the top bar looked the same whether notifications were on or off. It is now tinted with a small dot when they are on.
- Schedule showed "Tap any position to fill it" twice, the second time with a stray space before the full stop.
- On a wide screen a scheduler's menu was cut off part-way and had to be scrolled sideways.

## 0.5.1

- Notifications: `flock push-keys` sometimes (about 1 in 256) printed a private key one byte short, which Flock then refused, so it would not start. Keys are now always full length, and a short key made by 0.5.0 is accepted as it is. The test run before deploying 0.5.0 failed on this.

## 0.5.0

One new table (`push_devices`, migration `0003_push.sql`, added by itself): it deploys over 0.4.0. Notifications stay off until the church sets the two keys.

### Notifications on volunteers' phones (Decision 0008)

- Standard Web Push, sent by Flock itself: no outside account, no npm packages, no phone app. Payloads are encrypted (RFC 8291) and signed (VAPID, RFC 8292) with `node:crypto`; messages use WebKit's Declarative Web Push format.
- Turned on by the church with `node bin/flock.js push-keys` and the secrets `FLOCK_VAPID_PUBLIC_KEY` / `FLOCK_VAPID_PRIVATE_KEY` (needs an `https://` `FLOCK_PUBLIC_URL`; both keys or neither, checked to be a pair). Then per person, per device: a card on My schedule and a bell in the top bar (**Turn on**, **Send me a test**, **Turn off**, help when blocked). iPhone in Safari: the Add to Home Screen steps (iOS 16.4+).
- Flock is now an installable web app: `manifest.webmanifest`, 192/512 icons and a small service worker (`/sw.js`) that only shows notifications and opens Flock on tap. No offline caching.
- Sent when a volunteer is asked (one per person for **Ask these people**, listing every unanswered ask), taken off or replaced, their position is removed, their service moves (date or time) or is cancelled; and to every scheduler when someone says no (tap opens Gaps). Not for accepts, not for your own clicks. Best effort: after the change is saved, never slowing the click; devices the push service says are gone are forgotten.
- Gaps: **Send reminders** sends the week's reminders to everyone with notifications on ("Sent to 9; 3 to copy"); the rest, and anyone not reached, keep **Copy**. People: a **Notifications on** chip.
- Devices are forgotten when that device logs out or turns them off, and all of a person's on Reset login and deactivate.
- API: `GET /api/push`, `POST /api/me/push/on|off|test`, `POST /api/admin/reminders/send`; `GET /api/admin/reminders` adds `push` and `hasPush`; `GET /api/people` adds `notifications`; `POST /api/logout` takes an optional `pushEndpoint`.

### Logins renew while used

- A login now lasts until 14 days after it was last used (renewed at most once a day), so people who open Flock from notifications stay logged in. Logout, Reset login, deactivating and changing a password still end it.

## 0.4.0

No database changes: it deploys over 0.3.0 as it is.

### Volunteers see the full roster of their days (Decision 0007)

- My schedule: each card has **Full roster**, everyone serving that day (every service, team and position), who said yes, who has not answered and which positions are open. Names only; someone who said no is not named. The confirmed card stays under Coming up, as before.
- `GET /api/me/schedule` adds `rosters`, keyed by date, for the days the volunteer is asked or confirmed, and no other day.

### Calmer long lists for schedulers

- People, Services and the positions on Teams: tap a row to see its buttons (one row at a time, tap again to hide them). The buttons have words as well as pictures. Rename is now **Edit name** with a pencil, and Delete is a real red button with a bin.
- Teams start closed and say how many positions they have; a new team opens by itself.
- Schedule on a phone: each date is a closed card that says how many positions are open, waiting, confirmed and declined. Tap to see them; it stays open while you assign.
- Gaps are grouped per service (each roster day, with a count), each position marked with its kind of gap. `GET /api/admin/gaps` now sorts by date, time, team and position.

## 0.3.0

Breaking: needs a fresh database (see below). First release deployed to Fly.io (`flock-CHANGE-ME`, Sydney) by the Deploy workflow.

### Also

- New Flock mark (a flock of birds in a V that is also a church roof), favicon and iPhone home-screen icon.
- Privacy page (`/privacy.html`), linked from the login page.
- iPhone: date fields no longer overflow narrow boxes.
- Fly: sleeps when idle; sign-in limits are per visitor behind Fly's proxy (`FLOCK_TRUST_PROXY`).


### Email logins and single sign-on, Google first (Decision 0006)

- **Breaking: usernames are gone; the email is the login.** Needs a fresh database (the first schema changed in place). `create-admin <email> 'Full Name'`; `POST /api/login` takes `{ email, password }`.
- People without an email can be added and scheduled but cannot log in (no invite).
- An email is locked once its person has joined (against "profile takeover"); **Reset login** (was Reset password, `POST /api/people/:id/reset-login`) clears the password, linked sign-ins and sessions, unlocks the email and makes a new invite.
- Provider-agnostic sign-in (`/api/auth/:provider`), Google as the first provider when `FLOCK_GOOGLE_CLIENT_ID` and `FLOCK_GOOGLE_CLIENT_SECRET` are set; only emails a scheduler added can link, and refusals never reveal whether an email is in Flock. Accounts are linked by the provider's stable id (`sub`), passwords are optional, scopes are `openid email`. Redirect URI: `<FLOCK_PUBLIC_URL>/api/auth/google/callback`.
- Schema: `people.email` replaces `people.username`; new table `identities`.

### Fill open positions and how often volunteers serve

- Volunteers choose how often they can serve (every week, every 2, 3, 4, 6 or 8 weeks, or a pause) on "Days I can't serve". The default is every 2 weeks.
- Schedulers preview and then apply a fair plan for the open positions of 1 to 8 weeks on the Schedule page (`POST /api/admin/autofill`).
- New table `availability` (migration `0002_availability.sql`).

## 0.2.0

### Invite links

- One-time invite links replace account-creation and reset passwords. Links expire after 7 days; making a new link cancels the old one.
- The welcome page shows the username, lets the person choose a password and logs them in. Ordinary password changes remain available from the key button in the top bar.
- People shows who has not joined, ready-to-copy private messages and a warning for localhost links. Copying uses the shared mobile clipboard fallback.
- Resetting a password clears it and ends every session immediately. Invite claims are transactional, including expiry/deactivation checks and session creation; pending schedulers cannot bypass last-joined-scheduler protection.
- `FLOCK_PUBLIC_URL` supplies a shared invite address. CLI `create-admin` and `demo` print invite links.
- Pre-release 0.1.0 databases are not automatically upgraded: use a fresh database file and retain existing data/backups.

### UI styling

- Neutral oMLX-inspired light and dark palettes, flatter buttons and subtler cards.
- Locally bundled Inter font; text and mouse/trackpad controls are 10% smaller.
- Touch targets remain at least 48px, including devices with both touch and a mouse.
- Existing mobile navigation, responsive schedules, contrast checks and print layouts stay intact.

## 0.1.0

First release, built card by card.

### Icons pass (C-103)

Every scheduler action on every screen now uses a small hand-drawn 24px icon alongside its label.
Nine new icon names were added to `web/lib/icons.js`: `key`, `shield`, `user-off`, `user-check`,
`list-check`, `send`, `refresh`, `filter`, `dot`.

**Icons per screen**

- **My schedule**: sparkle (hero badge), calendar (empty state), users (co-volunteers line),
  warning (conflict confirm).
- **Days I can't serve**: calendar (blockout icon), plus (add button), warning (clash notice).
- **People**: shield (make scheduler/volunteer icon button), user-off / user-check (deactivate/reactivate
  icon button), edit (edit name icon button), list-check (positions icon button), key (reset password
  icon button), copy (copy password), info (role description), search (search field), plus (add person
  button), lock (password box), users (person count chip).
- **Teams**: plus (add team / add position buttons), users (position count chip).
- **Services**: plus (add service button), calendar (service card icon), edit (edit button).
- **Schedule**: plus (open slot button), calendar (date-range hint), dot (today marker).
- **Gaps**: plus / x / clock / user-off (gap kind icons), copy (copy reminder buttons), copy all,
  bell (reminders header), mail (never-sends notice), send (show messages button), warning (gap group icon).
- **Login / Password**: sparkle (login logo), lock (password logo + hint).
- **Nav**: home, calendar, users, sparkle, clock, grid, warning, more, logout.
- **My schedule (volunteer home)**: confirm / decline buttons keep their words.

**What kept its words (not icon-only)**

- Login and password: form submission buttons ("Log in", "Save my new password") keep their label text.
- Confirmations and destructive steps: "Yes, make a scheduler", "Yes, deactivate", "Yes, delete it",
  "Yes, I can't make it" — all explicit yes/no buttons keep words.
- Volunteer answer buttons: "Yes, I can", "I can't" keep words.
- Primary actions: "Add person", "Add team", "Add position", "Add service", "Save name" keep words.
- Section titles and page headings always have words.

**What the test can check (no browser needed)**

- Every `<button>` and `<a>` has an accessible name (text, aria-label, or title).
- Every `data-icon` attribute references a name that exists in `icons.js`.
- The gallery renders all icon names with their labels.

**What could not be checked without a real browser**

- Icon widths at 380 px and 560 px (layout and touch targets).
- Dark mode visual appearance.
- Touch behaviour on mobile devices.
