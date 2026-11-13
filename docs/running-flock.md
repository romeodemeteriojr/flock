# Running Flock

For whoever looks after the computer or server Flock runs on. Using the pages
is in [Using Flock](using-flock.md).

## Starting Flock

You need [Node.js](https://nodejs.org) version 22.16 or newer. Open a terminal
in the Flock folder and type:

```
npm start
```

Flock says `flock is running at http://localhost:8080`. Open that address in a
web browser on the same computer. To stop Flock, press Ctrl+C.

Settings:

| Setting | What it does |
| --- | --- |
| `FLOCK_DB=/path/to/church.db` | The database file. Default: `data/flock.db` in the Flock folder. |
| `FLOCK_PORT=3000` | The port. Default: 8080. |
| `FLOCK_PUBLIC_URL=https://schedule.example.org` | The address invite links use. Without it, links use the scheduler's current address (the command line uses `http://localhost:<port>`). Needed for notifications. |
| `FLOCK_SECURE_COOKIES=1` | Browsers send the login cookie over HTTPS only. Set it whenever Flock is served over HTTPS. |

`node bin/flock.js help` lists every command.

## Creating the first scheduler

The first scheduler account is made from the terminal:

```
node bin/flock.js create-admin pat.smith@example.org 'Pat Smith'
```

The first word is the email (it is how you log in) and the quoted part is the
full name. Flock prints a **one-time invite link**, valid for **7 days**. Open
it, check the email shown, and choose a password of at least 8 characters,
which also logs you in. If Flock runs on another computer, set
`FLOCK_PUBLIC_URL` first so the printed link uses the right address.

Everyone else is added from the **People** page
([how](using-flock.md#adding-people)).

## Trying it with fake data

To look around before entering real people, fill an empty database with
made-up people, teams and services:

```
FLOCK_DB=data/demo.db node bin/flock.js demo
FLOCK_DB=data/demo.db npm start
```

Open the invite link printed by `demo` and choose a password for the demo
scheduler. The other demo people have not joined; make an invite for one on
**People** to try a volunteer's view. Flock refuses to put demo data into a
database that already has people in it. When you are done, stop Flock and
delete `data/demo.db`.

To see every screen and part of the design without logging in, open
`/gallery.html` (for example `http://localhost:8080/gallery.html`). It uses
made-up names, saves nothing and is not linked from the app.

## Google sign-in (optional)

1. In Google Cloud (free), create a project, then an OAuth client of type
   **Web application** with the redirect URI
   `<your Flock address>/api/auth/google/callback`, for example
   `http://localhost:8080/api/auth/google/callback`.
2. Start Flock with `FLOCK_GOOGLE_CLIENT_ID` and `FLOCK_GOOGLE_CLIENT_SECRET`
   set. Set `FLOCK_PUBLIC_URL` when it runs
   behind another address.

Other providers: see
[decision 0006](decisions/0006-sso-and-email-login.md).

## Notifications

Notifications are off until the church turns them on:

1. Make the two keys once: `node bin/flock.js push-keys`. Keep a copy of both
   in the church's password manager.
2. Start Flock with `FLOCK_VAPID_PUBLIC_KEY` and `FLOCK_VAPID_PRIVATE_KEY` set.
   Notifications also need `FLOCK_PUBLIC_URL` to be Flock's `https://`
   address.

Then each person turns them on for their own devices
([how](using-flock.md#notifications)).

## Trying it on phones on the same Wi-Fi

Phones on the same Wi-Fi can reach Flock at the running computer's network
address, for example `http://192.168.1.20:8080`. That is fine for a try-out,
but over plain `http://` passwords and invite links travel without
protection, and phones only allow installing and notifications over HTTPS.
For real people, put Flock online with HTTPS
([Security](security.md#running-flock-on-a-server)).

## Backups: please make one every week

Everything Flock knows is in its one database file. If the disk fails or the
file is deleted by mistake, a backup is the only way back. Make one every
week, for example on Monday morning. Make a `backups` folder once, then:

```
node bin/flock.js backup backups/flock-2026-03-02.db
```

Flock writes a complete copy, even while it is running, and never overwrites
an existing file. Keep some backups on a different device, such as a USB stick
kept somewhere safe. The backup holds people's names, so look after it like
the original.

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
team, position, person, status. Leave out the dates to export everything.
Flock never overwrites an existing file, and any cell a spreadsheet could
mistake for a formula is made safe.
