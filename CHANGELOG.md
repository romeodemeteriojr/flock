# Changelog

## Unreleased

No database changes.

- **No false "Something went wrong" after adding Flock to the Home Screen.** On some iPhones, Share → Add to Home Screen worked but showed the error anyway. The browser had reported a problem of its own, with no error from Flock attached. Flock now only shows that message for its own errors and quietly logs the rest.

## 0.15.1

No database changes.

- **A quieter top corner.** The Flock logo in the top left was a solid indigo tile, the same colour as the buttons you're meant to tap, so it pulled the eye. It's now a small grey bird and "Flock", like a subtitle. Scrolled, the page title still takes its place.

## 0.15.0

No database changes.

- **Files are PDF, text and photos, and every one opens inside Flock** with the **X** to close: PDF, text and chord charts (TXT, MD, ChordPro), and photos (JPG, PNG, GIF, WebP). Word, Excel and PowerPoint files, audio, video and CSV are no longer kept: add a link instead (a Google Doc, OneDrive or Dropbox file, a YouTube video). iPhone photos are sent as JPEG. Files added before this stay until they expire.

## 0.14.4

No database changes.

- **Closing a PDF works again.** Closing a PDF showed "Something went wrong" and left the page behind stuck, so it could not scroll (which is why a file added again seemed impossible to open). Closing now always finishes cleanly, even while the file is still loading.

## 0.14.3

No database changes.

- **Notifications, Change my password and Install Flock work again from your account.** Since 0.11.1, tapping them in the sheet only closed it (Install Flock's steps on an iPhone flashed and closed): closing the sheet stepped the history back and undid the link. Now the sheet closes and the page (or the install steps) opens, and Back returns to the page you were on.
- **A way back from Notifications and Password.** These pages aren't tabs, so in the installed app they had no way out but the tab bar. They now start with a back link to the page you came from, such as **‹ Gaps**, or **‹ My schedule** when opened directly. It goes back like the phone's own Back, so Back afterwards doesn't land on them again.
- **No purple ring after a tap.** Opening your account drew a ring around your name, and closing it one around your initials (on an iPhone). Rings now show only when you use a keyboard; text fields still show where you're typing.
- **The bell is just a hint now.** It still shows whether notifications are on for this device (crossed out when off), but tapping it does nothing. **Notifications** opens from your account: tap your initials. The card on **My schedule** that invites you to turn them on stays.

## 0.14.2

No database changes.

- **A quieter bell.** With notifications on, the bell is the same plain outline as when they're off, just without the slash. No more solid coloured button.

## 0.14.1

No database changes.

### Every page of a PDF, with the Close button

- **PDFs show every page again.** 0.13.1 opened PDFs in Flock's viewer, but an iPhone only drew the first page there. Flock now draws each page itself (with Mozilla's PDF.js), one under the other, as wide as the screen. The **X** and the download button stay.
- PDF.js loads only when you open a PDF, and is not saved with the installed app, so the app is no bigger to install or update.

## 0.14.0

No database changes.

### Gaps opens on this week

- **Each service is one line**: a date tile, its title and time, and a red count of its gaps. Tap it to see its gaps; tap again to fold it.
- **The nearest service with gaps starts open**, so the page opens on what is left for this Sunday. Fill its last gap and the next one opens.
- **A filter** (Nobody yet, Said no, …) still shows every match, with every service open.

## 0.13.2

No database changes.

- **Services list is slimmer.** Each service is one row: a date tile, its title, and its time and number of spots. The positions and who is scheduled show when you tap the row, next to **Edit**. The rows sit together in one card.
- **Start from** choices are just the title and time.

## 0.13.1

No database changes.

### Easier to close a file, clearer bell

- **Files open with a Close button.** PDFs, photos, text, audio and video now open in Flock's own viewer, full screen, with a big **X** at the top left (and a download button). Back and Escape close it too. Before, a file filled the installed app with no way out but swiping back. Word, Excel and PowerPoint files, and links, still open in the phone.
- **The bell says on or off at a glance.** Notifications on: a solid, coloured bell. Off: a plain bell with a line through it. The small dot that looked like "something unread" is gone.

## 0.13.0

No database changes.

### A shorter Services page

- **Opens on the list.** **Services** now shows the upcoming services first, with an **Add a service** button. The form opens when you tap it, so you no longer scroll past it to reach a service.
- **Start from.** In the add form, tap a recent service (the latest of each title and time, up to 4) to copy its time, title and positions onto the next free week. **Blank** starts clean. (Decision 0012.)
- **Teams fold up.** Each team in the position picker is one line, like "Drums, Keys x2". Tap to open it. What you picked in a folded team is still saved. A single team starts open.

## 0.12.0

Database change: migration 0005 adds the `attachments` table. Older versions of Flock cannot open the database after this.

### Files and links on a service

Anyone can attach a **file (up to 5 MB) or a link** to a service, such as a setlist, run sheet or rehearsal video. (Decision 0011.)

- **Who sees them:** only the people serving at that service (asked or confirmed) and schedulers.
- **Where:** **Files** under the next service on **My schedule** and in each card's **Details**; schedulers also get **Files** on each service on **Services**. For the week after a service, **My schedule** keeps it under **Last week** so its files can still be opened.
- **Bigger than 5 MB?** Flock says so before sending and opens **Add a link** instead.
- **Only safe file types:** PDF, photos, text and chord charts, audio, video, and Word, Excel or PowerPoint files. Apps, installers, iPhone profiles, web pages, scripts, zip files and office files that can hold macros are refused; share those as a link.
- **Limits per person** (schedulers have none): 30 files and links an hour, and 50 MB of files on services that have not expired.
- **Opening** a file uses the phone's own viewer.
- **They expire a week after the service.** From then on nobody can open them. Nothing is deleted on a timer: a scheduler taps **Clear expired files** on **Services**, or runs `node bin/flock.js purge-files`.
- Who added a file can remove it; schedulers can remove any.

### At most 10 upcoming services

- **Services** can have at most 10 upcoming services. Adding an 11th says so; **Repeat for more weeks** adds as many as fit and names the weeks it left out. This keeps what files can take in check.

### Faster Fill for big churches

- **Fill open positions** is about 3 times faster with many people and blockouts. A new test checks a church of 1,000 people.

## 0.11.2

No database changes.

- **Schedule on a computer:** with many positions, the page no longer scrolls sideways. Hidden screen-reader text in the wide table was widening the page.

## 0.11.1

No database changes.

### Fixes found by monkey testing

- **Back** closes an open panel or sheet instead of leaving the page.
- **Logging back in** after your session ran out takes you to the page you were on, not My schedule.
- **Deactivating** someone says how many upcoming services they are on, and that Gaps will list those spots. `GET /api/people` gains `upcoming`.
- **Names** of people, teams and positions that are only invisible characters, control characters or accents are refused ("Please type a name."), and emoji count as one character toward the limit.
- **Days off** sent twice with the same dates and reason are kept once ("You already have those days off.").
- **Add service** asks for a time instead of saving at 9:00.
- Server error messages end with a full stop.
- Smaller fixes to toasts, "I can't", long names, password forms, suggestions and the Add service form.

## 0.11.0

No database changes.

### One person, up to 3 positions on one service

A scheduler can now put the same person in **up to 3 positions on one service**, for example Vocals and Keys. (Decision 0010.)

- **On Schedule**, someone already serving at that service is listed for the other positions, marked **Already serving** with "Already serving as Vocals at this service". They come after everyone who is not serving there, so **Best match** still goes to someone fresh. The 2nd and 3rd position need no "Assign anyway?".
- **A 4th position is refused**, and so is a second slot of the same position (one person cannot be two Door greeters). The message says why, with only **OK**: neither can be forced.
- Only positions the person holds count (waiting for an answer, or confirmed). One they said no to does not.
- The limit is per service: a 9:00 and an 11:00 service on the same morning are two services, as before.
- **Fill open positions** still puts each person on at most one position per service.
- **Volunteers** answer each position on its own. A card with other positions at the same service says **Also on Vocals**, and saying no names the position ("Are you sure you can't do Sound on ...?") so it is clear the others stay. Taking back a "no" is refused if it would make 4 positions, or a second of the same one.
- **Notifications, reminders and days off** put positions at one service together: "Asked to serve: Sound and Vocals, Sun 15 Nov 9:00".
- **Deleting a service** counts people once each: "1 person is scheduled on this date" for one person in two positions.
- **Deleting a position or team, or taking positions off a service,** also counts people once each, lists one line per person per service ("Sam (Sound and Slides, Sun 15 Nov)"), and sends one "You're no longer on Sound and Slides" per service.
- "Served 2 times in the last 8 weeks", the order of who could do a position, and Fill's fairness count services, not positions: two positions on one Sunday is serving once.

API: the 409 code `double_booked` is gone. New 409 codes `same_position` and `too_many_positions` (on assign, and on accept when taking back a "no"); neither can be forced. `GET /api/admin/suggest` candidates and `GET /api/me/schedule` items have `alsoOn`, the person's other positions at that service.

## 0.10.0

Adds a database migration (`0004_retire.sql`); it runs by itself on start. Make a backup first.

- **Delete a position or team that has been used.** Deleting now takes it off upcoming services (Flock names anyone down for it first, then tells them) and hides it everywhere; past services still show it. Adding the same name again brings it back with its history and who can do it. A team comes back without its positions.
- **Edit a service's positions.** Services → Edit now has the positions and how many of each. A number goes down only by empty spots; taking off a position with people in it asks first and tells them. People who stay are told about a new date or time.
- **Past services are locked.** Services before today can't be added, edited, deleted or answered. Repeat skips deleted positions and says so.
- **`TZ` setting.** Set it to your church's time zone so "today" is right; Flock warns at start when it isn't set.

## 0.9.0

No API or database changes: it deploys over 0.8.0 as it is.

### Wide screens

On a computer or a large tablet (1024 pixels wide and up), Flock now uses the space instead of stretching the phone layout. Phones and smaller tablets look as before.

- **The menu is a column on the left**, with each page's count beside it. A scheduler's other pages are always visible under **More**, and your name sits at the bottom; clicking it opens your account as a small menu just above.
- **Two panes.** On **People**, **Gaps** and **Schedule**, picking a person or a position opens it in a pane beside the list instead of a sheet over it. The one you picked is highlighted; until you pick, the pane says "Choose a person." or "Choose a position." Escape closes the pane.
- **My schedule** shows **Coming up** beside the big card at the top.
- The login and "Can't reach the server" pages, which have no menu, stay centred on the full width.

## 0.8.0

No API or database changes: it deploys over 0.7.0 as it is.

### Screens

- **My schedule leads with what needs you.** The big card at the top is the earliest ask still waiting for your answer, with **Yes, I can** and **I can't** right in it. With nothing to answer, it shows the next time you serve, who you serve with (their pictures and names) and **I can't make it after all**. After **Yes, I can** the card stays where it is, so the next ask never jumps under your finger. Below it, **Also needs your answer** and **Coming up** are smaller cards; **Details** on each shows who else is serving, the whole day and **I can't make it after all**.
- **Login and Welcome** are centred, with the Flock mark large on a soft glow, and an "or" line before the other sign-in buttons where the church has set them up. Welcome shows who you are in a small card with your picture.
- **Days off: tap the days.** A month calendar replaces the From and To date boxes. Tap the first day you are away, then the last; days already off are struck through, days you are down to serve have a dot, today is ringed. You can look up to 12 months ahead. Arrow keys move around the calendar, and each day says in words what it is.
- **Schedule** opens with a progress card: "34 of 80 positions confirmed", a bar, and what still needs doing (waiting, said no, open). **Fill open positions** now opens in a sheet. Each service card shows a small dot per position and "5 of 9 confirmed", or a check when everyone is confirmed; tags appear only for problems.
- **Gaps** has two tabs, **Gaps** and **Reminders**. Gaps says how many there are in the next 4 weeks, has a chip to filter by each kind of gap (in place of the five number tiles), and groups the gaps in a card per service.
- **People** is a quieter list: one row per person with only the tags that apply, and filters for **Schedulers**, **Not joined** and **Deactivated**. Tap a person for their sheet with every action (positions, change name, make a scheduler or volunteer, new invite, reset login, deactivate); the are-you-sure steps open inside it. **Add** opens a sheet with the Scheduler and Volunteer explanation right under the box. Your own sheet no longer offers to change your role or deactivate you (the server never allowed it).
- **The slot sheet** names the position and its date at the top and shows who is in it now, with **Remove**. The switch reads **Trained** and **Everyone**, and the first trained person on the list (who has served least) is marked **Best match**.
- The component gallery, README and acceptance checks (`UAT.md`) show the new screens.

## 0.7.0

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
- **Feels like an app.** Pages fade in when you move between them. Sheets (the slot panel, your account, More, the install steps) can be swiped down to close on a phone. Rows, cards and tabs show a press. After **Yes, I can**, the card shows a green "You're confirmed. Thank you!" with a check, and the phone gives a tiny buzz where it can. All movement is switched off when the phone asks for reduced motion.
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

Breaking: needs a fresh database (see below).

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
