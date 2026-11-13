# Security

Flock holds people's names, emails and schedules. This page says how it keeps
logins safe and what a server running it needs. Fly.io's own checklist is in
[DEPLOY.md](https://github.com/romeodemeteriojr/flock/blob/main/DEPLOY.md).

## How passwords work

Flock never stores passwords. It stores a scrambled form (a "hash") from which
the password cannot be worked out. That is why a scheduler can **reset** a
login but can never **read** a password. A reset removes the old hash, any
linked sign-in and all sessions, then creates a new invite. Accounts without a
chosen password cannot log in.

After 5 wrong passwords in a row, the account waits a few minutes before it
can try again, which stops guessing.

## Invite links and sessions

Only hashes of invite and session tokens are stored. Invite tokens stay in the
link's fragment (the part after `#`) and are sent in POST bodies, never in
HTTP addresses. An invite works once,
for 7 days, and making a new one cancels the old one. Treat invite links as
private credentials: send them to one person, privately.

A login lasts until 14 days after the person last opened Flock. Logging out
ends it on that device; **Reset login** and deactivating end it everywhere.

Once someone has joined, a scheduler cannot change their email without a
**Reset login** first. This stops a scammer from talking a scheduler into
"updating" an email to take over an account.

## Running Flock on a server

Letting volunteers use Flock from home means putting it on the internet. If
you do:

- It **must** be served over **HTTPS** (the padlock in the browser), because
  passwords travel over the network when people log in. Run Flock behind an
  HTTPS proxy or web server that handles the certificate (Fly.io does this
  for you), and start it with `FLOCK_SECURE_COOKIES=1` so browsers only send
  the login cookie over HTTPS.
- Keep the database file private. Run Flock under its own user account, make
  sure only that account can read the `data` folder and the backups, and
  never put them in a shared or public folder.
- Keep making backups, and keep them private too.

## What the phone keeps

An installed Flock keeps a copy of its own files (pages, scripts, styles,
font, icons) so it opens quickly. It never keeps your data: schedules and
names are always fetched fresh. See
[decision 0009](decisions/0009-app-shell-cache.md).
