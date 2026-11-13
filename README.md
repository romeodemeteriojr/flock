<img src="web/favicon.svg" width="64" alt="">

# Flock

Flock helps a church plan who serves on which Sunday. It keeps your volunteer
teams (band, sound, kids, greeters and so on), the positions in each team, and
your service dates. A scheduler puts people in positions, and volunteers open
Flock on their phones to see when they are serving, say yes or no, and mark the
days they are away.

Everything stays on your own computer. Flock is one small program and one
database file. It uses no outside services and sends no emails or texts. If
the church turns them on, it can send notifications to the phones of people
who ask for them (see "Notifications" below).

## Starting Flock

You need [Node.js](https://nodejs.org) version 22.16 or newer on the computer
that will run Flock. Open a terminal in the Flock folder and type:

```
npm start
```

Flock says `flock is running at http://localhost:8080`. Open that address in
a web browser on the same computer. To stop Flock, press Ctrl+C in the
terminal.

By default the database is the file `data/flock.db` inside the Flock folder.
You can choose another file with `FLOCK_DB=/path/to/church.db npm start`, or
another port with `FLOCK_PORT=3000 npm start`. Set
`FLOCK_PUBLIC_URL=https://schedule.example.org` when you want invite links to
use one shared address; otherwise links use the scheduler's current address.
The command line uses `http://localhost:<port>` if no public URL is set.

**This version needs a fresh database.** Logins moved from usernames to
emails by changing the first schema in place; there is no automatic upgrade
from 0.2.0 or older. Keep existing files and backups safe, and choose a new
`FLOCK_DB` file rather than overwriting real data.

## Creating the first scheduler

The first scheduler account is made from the terminal:

```
node bin/flock.js create-admin pat.smith@example.org 'Pat Smith'
```

The first word is your email (it is how you log in) and the quoted part is
the full name. Flock prints a **one-time invite link**, valid for **7 days**.
Open that link, check the email shown, and choose a password of at least 8
characters. Choosing it also logs you in. Use your email and password next
time, or **Sign in with Google** if it is set up and the email is a Google
account.
If Flock runs on another computer, set `FLOCK_PUBLIC_URL` before creating the
account so that the printed link uses the correct address.

## Adding people

On **People**, choose **Add person** and enter their name and email. The
email is how they log in. Saving opens an invite message: choose
**Copy message** and send it privately through your usual messages app.
The person taps the link, sees the email they log in with and chooses a
password, which also logs them in. The link works once, for 7 days.

Someone without an email (for example a child or a person who does not use
email) can still be added and scheduled; they just cannot log in.

Someone who has not joined is marked **Not joined yet**. **Copy new invite**
makes a new link and cancels their previous one. If the message warns about
localhost, open Flock using its network address or set `FLOCK_PUBLIC_URL`,
then make a new invite; a localhost link only works on the same computer.

If someone forgets their password, choose **Reset login**. Confirming
immediately stops their current password and any linked Google sign-in,
logs them out everywhere, then shows a new invite message.

Once someone has joined, their email is locked: scammers try to get
schedulers to "update" someone's email so they can log in as them. To change
a joined person's email, choose **Reset login** first, then edit it. Nobody, including the scheduler, can read
another person's password. To change your own password, tap your initials at
the top right, then **Change my password**.

On the same page you can mark which positions a person can do, make someone
a scheduler, or deactivate people who have left. A deactivated person cannot
log in. Their past history is kept, and you can reactivate them later.

## How volunteers log in on their phones

Volunteers open the Flock address in the browser on their phone, type their
email and password, and they are in. They stay logged in on that phone until
14 days after they last opened Flock. They do not need to install an app,
though they can add Flock to their Home Screen like one.

When a sign-in provider such as Google is set up (below), they can also tap
**Sign in with Google**. That works without an invite, but only for the email
a scheduler added; the first sign-in links their Google account, and later
sign-ins use that link. To stop someone, deactivate them (after a Reset login
they can link again with the same email).

### Setting up Google sign-in (optional)

1. In Google Cloud (free), create a project, then an OAuth client of type
   **Web application** with the redirect URI
   `<your Flock address>/api/auth/google/callback`, for example
   `http://localhost:8080/api/auth/google/callback`.
2. Start Flock with `FLOCK_GOOGLE_CLIENT_ID` and `FLOCK_GOOGLE_CLIENT_SECRET`
   set (on Fly: `fly secrets set ...`). Set `FLOCK_PUBLIC_URL` when it runs
   behind another address. Other providers: see `docs/decisions/0006-sso-and-email-login.md`.

While you are trying Flock out, phones on the same Wi-Fi can reach it at the
running computer's network address, for example `http://192.168.1.20:8080`.
Before volunteers use it for real, read "Putting it online later" below.
Over plain `http://`, passwords and invite tokens travel across the network
without protection. Use HTTPS for real people.

## Notifications (optional)

Flock can send a notification to a volunteer's phone or computer when they
are **asked to serve**, **taken off** a position, or when a service they are
on **moves** or is **cancelled**. Schedulers also hear when **someone says
no**. Schedulers can send the week's reminders from **Gaps** with **Send
reminders**. Nothing is sent for a yes, nothing for your own clicks, and
there are no automatic "you serve tomorrow" reminders yet.

They are off until the church turns them on:

1. Make the two keys once: `node bin/flock.js push-keys`. Keep a copy of
   both in the church's password manager.
2. Start Flock with `FLOCK_VAPID_PUBLIC_KEY` and `FLOCK_VAPID_PRIVATE_KEY`
   set (on Fly: `fly secrets set ...`, see DEPLOY.md). Notifications also
   need `FLOCK_PUBLIC_URL` to be Flock's `https://` address.

Then each person turns them on for each device, from the card at the top of
**My schedule** or the bell at the top. The bell page has **Send me a test**.

- **Android and computers:** tap **Turn on** and allow notifications.
- **iPhone** (iOS 16.4 or newer): notifications only work once Flock is on
  the Home Screen. In Safari, tap **Share**, then **Add to Home Screen**,
  open Flock from the Home Screen, log in, then tap the bell and **Turn on**.
  Flock shows these steps. If **Sign in with Google** does not work inside
  the Home Screen app, log in there with your email and password (a
  scheduler can give a Google-only person a password with **Reset login**).

**People** shows a bell on everyone who has notifications on. Logging out
on a device, turning them off, Reset login and deactivating stop them.

## What each page does

Everyone sees:

- **My schedule** shows the times you are asked to serve, and who else is
  serving with you. Tap **Yes, I can** or **I can't**. You can also change
  your mind later. Tap **Full roster** on a card to see everyone serving that
  day: every service, team and position, who has said yes, who has not
  answered yet, and which positions are still open (names only).
- **Days I can't serve** is where you add the dates you are away (up to a
  year at a time), with a reason if you like. Flock will not suggest you to
  the scheduler for those days. If you are already scheduled on one of those days,
  Flock tells you so you can let your scheduler know. At the top of the same
  page, **How often can you serve?** lets you choose every week, every 2, 3,
  4, 6 or 8 weeks, or a pause. Until you choose, Flock asks you at most every
  2 weeks.

Schedulers also see:

Long lists stay short to read: tap a person, a position or a service to see
its buttons (one at a time; tap it again to hide them), and tap a team or a
date to open it.

- **People** lets you add people, set what they can do, reset logins, make
  someone a scheduler, and deactivate or reactivate people.
- **Teams** lets you create teams and the positions in each team (for example
  Band: Vocals, Guitar, Drums). Each team opens to show its positions and how
  many people can do each.
- **Services** lets you add service dates with the positions you need. You
  can repeat a service weekly for several weeks.
- **Schedule** is a grid of the next 8 weeks (on a phone, one card per date,
  closed, saying how many positions are open, waiting and confirmed; tap it
  to see them). Click a position to put someone in it. Flock suggests people who are set up for that position, are not
  away, and have not served too often lately. It warns you about clashes
  (away that day, not set up for that position, already serving that
  morning). You can still go ahead if you really mean to.
  **Fill open positions** plans one to 8 weeks at a time: it puts someone in
  every empty position it can, fairly, and shows you the plan first. Flock
  only picks people who are set up for the position, are not away, and have
  not served more often than they said they can. Among those it picks whoever
  has served least for how often they offered, then whoever served longest
  ago. Nobody is asked until you choose **Ask these people**; then they see it
  in My schedule as waiting for their answer. Positions nobody can fill stay
  empty and show on the Gaps page.
- **Gaps** shows the next 4 weeks of positions that still need attention,
  grouped per service (each roster day), each marked with why: empty,
  declined, not answered, held by someone who is away, or by someone who is
  no longer active. It also writes **reminder messages** for a chosen
  week. Copy them into your usual messages app, or, when notifications are
  on, choose **Send reminders** to send them to everyone with the bell
  ("Sent to 9; 3 to copy"). Anyone not reached keeps the **Copy** button.

## Trying it with fake data

To look around before entering real people, start with an empty database and
fill it with made-up people, teams and services:

```
FLOCK_DB=data/demo.db node bin/flock.js demo
FLOCK_DB=data/demo.db npm start
```

Open the invite link printed by `demo` and choose a password for
`demo-admin`. Other demo people have not joined yet; make an invite for them
on **People** when you want to try their views. Every name in the demo is fake. Flock refuses to put demo data into
a database that already has people in it. When you are done, stop Flock and
delete `data/demo.db`.

## Look and feel

Flock has one brand colour (indigo) on soft, slightly tinted greys, in a light
and a dark version. The mark is a white bird on an indigo tile; the same tile
is the app icon on a phone's home screen. Inter is bundled locally (license:
`licenses/Inter-OFL.txt`), cut down to Latin letters so it loads quickly on a
phone: English, accented European letters, Vietnamese, and Pacific names with
macrons or an ʻokina. Names in other alphabets (Greek or Cyrillic, say) are
shown in the phone's own font. No fonts or other assets are fetched from
outside services.

Every icon is drawn on the same grid, and each page has its own picture in the
menu: a calendar for the Schedule, a missing puzzle piece for Gaps, a crossed-out
calendar for Days off. Status is never shown by colour alone: every coloured tag
also has a symbol and a word. Touch targets are at least 48px.

Flock follows your phone or computer's light or dark setting by itself (dark
mode), and turns off animations if you have asked your device for less
motion. On phones the main pages sit in a tab bar at the bottom, with the page
you are on marked by a soft pill, a filled-in icon and bold text; on wider
screens they are a row of buttons along the top. Printing the Schedule page
gives a plain black-and-white grid.

**On a phone Flock behaves like an app.** Add it to the Home Screen (My
schedule offers it, or tap your initials, then **Install Flock**; on an
iPhone it shows the three steps). It then opens straight away, even while the
server is waking up or the signal is poor, because the phone keeps a copy of
Flock's own files (never your data; see
`docs/decisions/0009-app-shell-cache.md`). With no connection at all it says
**Can't reach the server** with **Try again**, and opens by itself when the
connection is back. A new version reaches an installed phone by itself: it is
fetched in the background and used from the next tap that changes the page.

The top bar is slim: the mark, the bell and your initials, which open your
account (notifications, password, install, log out). Scroll down and the page
title takes the place of "Flock". The tabs show numbers: on **My schedule**
the asks waiting for your answer (also on the app icon of an installed app),
on **Gaps** the gaps. Sheets come up from the bottom and can be swiped down to
close; **More** is one of them. Invites and reminders can go straight to the
phone's share sheet. Pages fade in, things you press give a little, and
saying yes is thanked with a check. With reduced motion turned on, none of it
moves.

To change the brand colour, edit the colour list at the top of `web/style.css`
(`--brand`, `--accent` and the few colours next to them, once for light and once
for dark). `npm test` checks that every text and background pair is still easy
to read.

To see every screen and part of the design without logging in, open
`/gallery.html` (for example `http://localhost:8080/gallery.html`). It uses
made-up names only, saves nothing and is not linked from the app.

## Backups: please make one every week

Everything Flock knows is in its one database file. If that computer's disk
fails or the file is deleted by mistake, a backup is the only way back. Make
one every week, for example on Monday morning. Make a `backups` folder once,
then:

```
node bin/flock.js backup backups/flock-2026-03-02.db
```

Flock writes a complete copy, even while it is running, and never overwrites
an existing file. Keep some backups on a different device, such as a USB
stick kept somewhere safe. The backup holds people's names, so look after it
like the original.

To restore, stop Flock, then make a fresh copy of the backup and use the copy
(so the backup itself stays untouched):

```
cp backups/flock-2026-03-02.db data/restored.db
FLOCK_DB=data/restored.db npm start
```

## Exporting the schedule (CSV)

To open the schedule in a spreadsheet:

```
node bin/flock.js export schedule.csv --from 2026-03-01 --to 2026-05-31
```

The file has one row per position, with these columns: date, time, service,
team, position, person, status. You can leave out the dates to export
everything. Flock never overwrites an existing file. Any cell that a
spreadsheet could mistake for a formula is made safe.

## How passwords work

Flock never stores passwords. It stores a scrambled form (a "hash") from
which the password cannot be worked out. That is why a scheduler can
**reset** a login but can never **read** a password. A reset removes the old
hash, any linked sign-in and all sessions, then creates a new invite. Accounts without a chosen
password cannot log in. Only hashes of invite and session tokens are stored;
invite tokens stay in the link fragment and are sent in POST bodies, not
HTTP URLs. Treat invite links as private credentials.
After 5 wrong passwords in a
row, the account waits a few minutes before it can try again, which stops
guessing.

## Putting it online later

Flock works on one computer as it is. Letting volunteers use it from home
means putting it on the internet, and that is a decision for the church to
make carefully, because Flock holds people's names and schedules.

If you do:

- It **must** be served over **HTTPS** (the padlock in the browser), because
  passwords travel over the network when people log in. The usual way is to
  run Flock behind an HTTPS proxy or web server that handles the certificate.
  Then start Flock with `FLOCK_SECURE_COOKIES=1`, so that browsers only send
  the login cookie over HTTPS.
- Keep the database file private. Run Flock under its own user account on
  the server, make sure only that account can read the `data` folder and the
  backups, and never put them in a shared or public folder.
- Keep making the weekly backups, and keep them private too.

## Limitations

- Flock does not send emails or texts. Notifications are only for people
  who turn them on, on devices that support them. It drafts reminder
  messages for you to copy and send to everyone else.
- It has no songs, set lists, files or media. It is only for scheduling
  people.
- Volunteers use a web browser. There is no phone app in the app stores;
  Flock can be added to the Home Screen instead.
- It is built for one church of about 70 people, running on one computer.

## For developers

Flock is plain JavaScript for Node.js 22.16 or newer, with no npm packages.

- [ARCHITECTURE.md](ARCHITECTURE.md) explains the layers (routes, services,
  data layer, SQLite adapter), dependency injection through
  `src/container.js`, errors, logging and the testing strategy.
- [docs/decisions/](docs/decisions/) records the main design decisions.
- `npm test` (or `node --test`) runs every test. Tests use made-up people
  and in-memory or temporary databases only.
- `npm run coverage` runs the tests with Node's built-in coverage report.
- `node bin/flock.js help` lists the commands. `node bin/flock.js version`
  prints the version.
