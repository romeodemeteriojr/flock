# Putting Flock online (Fly.io)

This guide is for the person who schedules volunteers. You do not need to be a programmer, but you will type a few commands.

**Where to type commands:** every command in this guide is typed **on your own computer**, in a terminal window (Terminal on Mac, PowerShell on Windows), inside the Flock folder. Commands starting with `fly ssh console` are sent from your computer to the running app; you still type them on your own computer.

## 1. What you need

- A Fly.io account (https://fly.io). Fly asks for a credit card.
- `flyctl` (the `fly` command) installed on your computer: https://fly.io/docs/flyctl/install/
- The Flock folder (this repository) on your computer.

## 2. First-time setup (on your own computer)

1. Log in:

   ```
   fly auth login
   ```

2. Open `fly.toml` in a text editor and change `flock-CHANGE-ME` to a name nobody else has used, such as `grace-church-flock`. It must be globally unique. Also replace the `primary_region` placeholder with the region nearest you (`fly platform regions` lists them). Under `[env]`, add `FLOCK_PUBLIC_URL = 'https://<app>.fly.dev'` using your app name, so CLI invite links point to the deployed site.

3. Register the app without starting it, keeping our settings:

   ```
   fly launch --no-deploy --copy-config
   ```

   If it asks for an app name, type your unique name. Answer **no** if it offers a database or to change the settings.

4. Create the storage disk (the "volume") where the database lives. Use the same region as in `fly.toml`:

   ```
   fly volumes create flock_data --size 1 --region <region>
   ```

5. Optional, Google sign-in: in your Google OAuth client add the redirect URI
   `https://<app>.fly.dev/api/auth/google/callback`. Under Branding set the home page
   `https://<app>.fly.dev`, the privacy policy `https://<app>.fly.dev/privacy.html` and the
   authorized domain `<app>.fly.dev` (Google will not publish the app without them;
   leave the logo empty). Then:

   ```
   fly secrets set FLOCK_GOOGLE_CLIENT_ID=... FLOCK_GOOGLE_CLIENT_SECRET=...
   ```

   Type the values only into your terminal, never into files or chats.

6. Optional, notifications (Decision 0008). Make the keys on your own computer and set them as secrets:

   ```
   node bin/flock.js push-keys
   fly secrets set FLOCK_VAPID_PUBLIC_KEY=... FLOCK_VAPID_PRIVATE_KEY=...
   ```

   Keep a copy of both keys in the church's password manager. Notifications also need `FLOCK_PUBLIC_URL` (step 2) to be the `https://` address. If you ever change the keys, each phone switches over by itself the next time it opens Flock; phones that are not opened get nothing until then. Removing both secrets turns notifications off again.

7. Optional safety check of the settings:

   ```
   node scripts/check-config.js --production
   ```

8. Deploy:

   ```
   fly deploy
   ```

9. Create the first scheduler account:

   ```
   fly ssh console -C "node bin/flock.js create-admin <email> 'Full Name'"
   ```

   A **one-time invite link is printed**, valid for 7 days. Give it only to that person privately. Opening it lets them choose a password and logs them in. Check that it starts with your deployed HTTPS address, not localhost.

10. Visit `https://<app>.fly.dev` (your app name instead of `<app>`).

## 3. Your own web address (optional)

If you own a domain such as `schedule.example.org`:

```
fly certs add schedule.example.org
```

Fly shows the DNS records to add at your domain provider. HTTPS is set up automatically.

## 4. Updating to a new version

**The pre-release 0.1.0 → 0.2.0 change needs a fresh database; it does not migrate existing files.** Keep existing files and backups private and safe. Do not deploy 0.2.0 over a real 0.1.0 database expecting an automatic upgrade.

For versions with a compatible schema, get the new Flock folder, **make a backup first** (section 6), then:

```
fly deploy
```

## 5. Looking at logs

```
fly logs
```

Press Ctrl+C to stop watching.

## 6. Backups

Your data is one file on the volume. Protect it twice:

- **Daily snapshots by Fly.** Fly takes a volume snapshot every day. Check Fly's documentation for how long they are kept (our research said 5 days). That is short, so also do the next step.
- **Weekly copy to your own computer.** Replace `YYYYMMDD` with today's date, for example `20250105`:

  ```
  fly ssh console -C 'node bin/flock.js backup /data/backup-YYYYMMDD.db'
  fly ssh sftp get /data/backup-YYYYMMDD.db
  ```

  The file lands in your current folder. **Keep it private: it contains people's names.** Do not email it or put it in a shared folder. Backups never overwrite, so use a new date each time; delete old ones from the volume once copied if space gets tight.

### Restoring from a backup file

1. Stop writes by stopping the app: `fly machine list`, then `fly machine stop <machine-id>`.
2. Start it again and upload the file under a new name:

   ```
   fly machine start <machine-id>
   fly ssh sftp shell
   ```

   In the sftp prompt type `put backup-YYYYMMDD.db /data/restore.db` and then `exit`.
3. Move it into place (keeping the old file):

   ```
   fly ssh console -C "mv /data/flock.db /data/flock-before-restore.db"
   fly ssh console -C "cp /data/restore.db /data/flock.db"
   fly machine restart <machine-id>
   ```

   Also remove any leftover `/data/flock.db-wal` and `/data/flock.db-shm` files before restarting if they exist.
4. Visit the site and check your people and schedule are there.

If anything is unclear, stop and ask a technical friend before deleting anything.

## 7. Rolling back a bad update

```
fly releases
```

Find the last version that worked, note its image name, then deploy that image:

```
fly deploy --image <image-name-from-releases>
```

## 8. Costs

At most about **$2.34 a month** for one small machine plus a 1 GB volume, and much less in practice: the machine sleeps when nobody is using it and wakes on the next visit (the first page can take a second). Prices change, so check https://fly.io/docs/about/pricing/.

## 9. Security checklist

- Only use the `https://` address. Flock is set to refuse plain HTTP.
- Never share invite links in public chats or group emails; they are one-time credentials.
- Back up before every upgrade.
- Run **exactly one machine**. Never run `fly scale count 2`: each machine would have its own, different database.
- Keep backup files private.
- Keep the push notification keys (`FLOCK_VAPID_*`) only in Fly secrets and the password manager, never in `fly.toml`.

## 10. Troubleshooting

- **"app name already taken"**: choose a different, more unique name in `fly.toml`.
- **Deploy says no volume found**: run the `fly volumes create` step with the same region as `fly.toml`.
- **Site will not load**: run `fly status` and `fly logs`. The health check is `/api/health`.
- **Flock will not start after setting the notification keys**: `fly logs` names the problem. Set both keys from the same `push-keys` run, and make sure `FLOCK_PUBLIC_URL` is the `https://` address.
- **Notifications do not arrive**: on the bell page, try **Send me a test**. On an iPhone, Flock must be opened from the Home Screen (iOS 16.4 or newer). Check the phone's settings allow notifications for Flock (or for the browser). `fly logs` shows `push sent` / `push not sent` with the push service and its answer, never who or what.
- **Lost or expired first-scheduler invite**: run `create-admin` with a different email. If another scheduler can already log in, ask them to make a new invite instead.
- **An invite points at localhost**: set `FLOCK_PUBLIC_URL` to the public HTTPS address before creating CLI accounts. On People, browse using that address and choose **Copy new invite**.
- **Data looks different after a while**: run `fly machine list` and make sure there is only one machine.
- **`fly` not found**: reinstall flyctl and open a new terminal window.

## Automatic checks and releases

GitHub Actions runs the checks for you on every pull request and push. This repository does **not** deploy: it holds only the code and a template `fly.toml`. Keep your real `fly.toml` and deploy token somewhere private (for example a separate private repository) so your server's name is not published.

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

### Deploying a release

A safe deploy does these steps, in this order, on a checkout of the release tag with your real `fly.toml`:

1. `node scripts/check-version.js --tag vX.Y.Z`, `node --test` and `node scripts/check-config.js --production`.
2. Take a volume snapshot first (`flyctl volumes snapshots create <volume id> -a <app>`) and stop if it fails.
3. `flyctl deploy --remote-only --ha=false` (one machine, one database).
4. Check `https://<app>.fly.dev/api/health` for 2 minutes.

Automating these steps from a private repository, with a manually started workflow and a `FLY_API_TOKEN` secret (`flyctl tokens create deploy -a <app>`), works well. Pressing **Run workflow** is then the approval step.

### What CI checks on every push

On every push to `main` and every pull request, on Node 22 and 24: the whole test suite (including the architecture and security tests), a coverage summary, `scripts/check-config.js` and `scripts/check-version.js`. Pull requests also run the **Release label** check (`scripts/release.js`).

### If a deploy fails, or you need to roll back

- If the health check fails, run `flyctl releases -a <app>` to find the previous image, then `flyctl deploy -a <app> --image <previous image>`.
- If data looks wrong, list snapshots with `flyctl volumes snapshots list <volume id>` and restore as described in the backup section above.
- Check `flyctl status` and `flyctl logs` as well.
