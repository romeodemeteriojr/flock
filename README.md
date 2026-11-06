# Flock

Flock helps a church plan who serves on which Sunday. It keeps your volunteer
teams (band, sound, kids, greeters and so on), the positions in each team, and
your service dates. A scheduler puts people in positions, and volunteers open
Flock on their phones to see when they are serving, say yes or no, and mark the
days they are away.

Everything stays on your own computer. Flock is one small program and one
database file. It uses no outside services and sends nothing to anyone.

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
another port with `FLOCK_PORT=3000 npm start`.

## Creating the first scheduler

The first scheduler account is made from the terminal:

```
node bin/flock.js create-admin pat.smith 'Pat Smith'
```

The first word is the username and the quoted part is the full name. Flock
prints a **temporary password**, and shows it only this once. Log in with
that username and password. Flock then asks you to choose your own password,
which must be at least 8 characters long.

## Adding people and their first passwords

On the **People** page, choose **Add person** and type their name. Flock
suggests a username, which you can change. When you save, Flock shows a
temporary password once. Give it to the person in a private way, for example
in person or in a private message. When they first log in, Flock makes them
choose their own password.

If someone forgets their password, open **People** and choose **Reset
password**. Flock gives you a new temporary password for them. Nobody, not
even the scheduler, can see a person's own password (see "How passwords work"
below).

On the same page you can mark which positions a person can do, make someone
a scheduler, or deactivate people who have left. A deactivated person cannot
log in. Their past history is kept, and you can reactivate them later.

## How volunteers log in on their phones

Volunteers open the Flock address in the browser on their phone, type their
username and password, and they are in. They stay logged in for 14 days on
that phone. They do not need to install an app.

While you are trying Flock out, phones on the same Wi-Fi can reach it at the
running computer's network address, for example `http://192.168.1.20:8080`.
Before volunteers use it for real, read "Putting it online later" below.
Over plain `http://`, passwords travel across the network without protection.

## What each page does

Everyone sees:

- **My schedule** shows the times you are asked to serve, and who else is
  serving with you. Tap **Yes, I can** or **I can't**. You can also change
  your mind later.
- **Days I can't serve** is where you add the dates you are away (up to a
  year at a time), with a reason if you like. Flock will not suggest you to
  the scheduler for those days. If you are already scheduled on one of those days,
  Flock tells you so you can let your scheduler know.

Schedulers also see:

- **People** lets you add people, set what they can do, reset passwords, make
  someone a scheduler, and deactivate or reactivate people.
- **Teams** lets you create teams and the positions in each team (for example
  Band: Vocals, Guitar, Drums).
- **Services** lets you add service dates with the positions you need. You
  can repeat a service weekly for several weeks.
- **Schedule** is a grid of the next 8 weeks. Click a position to put someone
  in it. Flock suggests people who are set up for that position, are not
  away, and have not served too often lately. It warns you about clashes
  (away that day, not set up for that position, already serving that
  morning). You can still go ahead if you really mean to.
- **Gaps** shows the next 4 weeks of positions that still need attention:
  empty, declined, not answered, held by someone who is away, or by someone
  who is no longer active. It also writes **reminder messages** for a chosen
  week. Copy them into your usual messages app. Flock never sends messages
  itself.

## Trying it with fake data

To look around before entering real people, start with an empty database and
fill it with made-up people, teams and services:

```
FLOCK_DB=data/demo.db node bin/flock.js demo
FLOCK_DB=data/demo.db npm start
```

Log in as `demo-admin` with the temporary password the `demo` command
printed. Every name in the demo is fake. Flock refuses to put demo data into
a database that already has people in it. When you are done, stop Flock and
delete `data/demo.db`.

## Look and feel

Flock follows your phone or computer's light or dark setting by itself (dark
mode), and turns off animations if you have asked your device for less
motion. On phones the main pages sit in a tab bar at the bottom; on wider
screens they are tabs along the top. Printing the Schedule page gives a plain
black-and-white grid.

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
**reset** a password but can never **read** one. After 5 wrong passwords in a
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

- Flock does not send emails, texts or notifications. It drafts reminder
  messages for you to copy and send.
- It has no songs, set lists, files or media. It is only for scheduling
  people.
- Volunteers use a web browser. There is no phone app.
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
