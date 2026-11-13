# Putting Flock online

For the person who looks after Flock's server. Flock runs on any host that can run a container (the `Dockerfile` is included) or Node.js 22.16 or newer. This page lists what every host needs, so you can follow your host's own guide.

## What a host must give Flock

- **One running copy.** Flock keeps everything in one SQLite file, so run exactly **one** instance. Two copies would each have their own, different database.
- **A disk that survives restarts and updates.** The database is `FLOCK_DB` (in the `Dockerfile`, `/data/flock.db`). Mount a persistent volume at `/data`, or point `FLOCK_DB` at a folder that is kept.
- **HTTPS in front.** Passwords travel over the network, so serve Flock only over HTTPS (most hosts do this for you) and set `FLOCK_SECURE_COOKIES=1`.
- **The port.** Flock listens on `FLOCK_PORT` (8080 in the `Dockerfile`). The health check is `GET /api/health`.

## Settings

Set these as environment variables on your host (see [Running Flock](docs/running-flock.md#starting-flock) for what each does):

| Setting | Value |
| --- | --- |
| `FLOCK_DB` | `/data/flock.db` (already set in the `Dockerfile`) |
| `FLOCK_SECURE_COOKIES` | `1` |
| `FLOCK_TRUST_PROXY` | `1`, only when a proxy in front sets the client address header (otherwise everyone shares one IP for the sign-in limits) |
| `FLOCK_PUBLIC_URL` | your `https://` address, so invite links and notifications use it |
| `FLOCK_GOOGLE_CLIENT_ID`, `FLOCK_GOOGLE_CLIENT_SECRET` | optional, Google sign-in. Keep as your host's secrets |
| `FLOCK_VAPID_PUBLIC_KEY`, `FLOCK_VAPID_PRIVATE_KEY` | optional, notifications (`node bin/flock.js push-keys` makes them). Keep as your host's secrets |

Never put secrets in files in the repository.

## First start

1. Start Flock with the settings above and open your HTTPS address. `/api/health` should answer.
2. Make the first scheduler from a terminal on the server: `node bin/flock.js create-admin <email> 'Full Name'` (in a container, run it inside the container). It prints a one-time invite link, valid for 7 days. Check it starts with your HTTPS address, not localhost, and give it only to that person, privately.

## Updating

Make a backup first, then deploy the new version the way your host does. Keep the disk. If something is wrong, deploy the previous version again.

## Backups

Everything is one file. Copy it every week to somewhere private (it holds people's names):

```
node bin/flock.js backup /data/backup-YYYYMMDD.db
```

Flock writes a complete copy while it is running and never overwrites a file. Many hosts can also snapshot the disk; use that too. To restore, stop Flock, put the backup in place of `flock.db` (keep the old file, and remove any `flock.db-wal` and `flock.db-shm` beside it), and start Flock again. If anything is unclear, ask a technical friend before deleting anything.

## Security checklist

- Only use the `https://` address; Flock is set to refuse plain HTTP cookies.
- Never share invite links in public chats or group emails.
- Back up before every upgrade, and keep backups private.
- Run exactly one instance.
- Keep the push notification keys only in your host's secrets and the church's password manager.

## Troubleshooting

- **Site will not load:** check your host's logs and the `/api/health` check.
- **Flock will not start after setting the notification keys:** the log names the problem. Set both keys from the same `push-keys` run, and make sure `FLOCK_PUBLIC_URL` is the `https://` address.
- **Notifications do not arrive:** on the bell page, try **Send me a test**. On an iPhone, Flock must be opened from the Home Screen (iOS 16.4 or newer).
- **Lost or expired first-scheduler invite:** run `create-admin` with a different email, or ask another scheduler for a new invite.
- **An invite points at localhost:** set `FLOCK_PUBLIC_URL` before creating accounts from the terminal; on People, browse using the public address and choose **Copy new invite**.
- **Data looks different after a while:** make sure only one instance is running.

## Automatic checks and releases

GitHub Actions runs the checks for you on every pull request and push. This repository does not deploy anything. Keep your host's settings and deploy token somewhere private, such as a separate private repository.

### How to release

Versions follow semantic versioning and come from the pull request's **release label**:

| Label | Meaning | Example |
| --- | --- | --- |
| `breaking` | incompatible change (needs a fresh database, removes an API) | 1.4.2 → 2.0.0 |
| `feat` | something new | 0.4.0 → 0.5.0 |
| `fix` | a bug fix | 0.5.0 → 0.5.1 |
| `no release` | docs, CI, tidying | no new version |

While Flock is 0.x, `breaking` bumps the middle number (0.5.3 → 0.6.0), as semantic versioning allows before 1.0.0.

1. In the pull request, write what changed under `## Unreleased` at the top of `CHANGELOG.md`. Leave `package.json` alone.
2. Add exactly one release label. The **Release label** check says which version merging will release, and fails if the label or the `## Unreleased` section is missing.
3. Merge to `main` when the checks are green. The **Release** workflow then sets the version in `package.json`, renames `## Unreleased` to that version, pushes the `vX.Y.Z` tag and makes a GitHub release from the CHANGELOG section. Nothing is deployed.

Do it by hand only if the Release workflow cannot run: set the version in `package.json`, rename the CHANGELOG heading, merge, then `git tag vX.Y.Z` and `git push origin vX.Y.Z`.

### What CI checks on every push

On every push to `main` and every pull request, on Node 22 and 24: the whole test suite (including the architecture and security tests), a coverage summary, `scripts/check-config.js` and `scripts/check-version.js`. Pull requests also run the **Release label** check (`scripts/release.js`).
