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
   `https://<app>.fly.dev/api/auth/google/callback`, then:

   ```
   fly secrets set FLOCK_GOOGLE_CLIENT_ID=... FLOCK_GOOGLE_CLIENT_SECRET=...
   ```

   Type the values only into your terminal, never into files or chats.

6. Optional safety check of the settings:

   ```
   node scripts/check-config.js --production
   ```

7. Deploy:

   ```
   fly deploy
   ```

8. Create the first scheduler account:

   ```
   fly ssh console -C "node bin/flock.js create-admin <email> 'Full Name'"
   ```

   A **one-time invite link is printed**, valid for 7 days. Give it only to that person privately. Opening it lets them choose a password and logs them in. Check that it starts with your deployed HTTPS address, not localhost.

9. Visit `https://<app>.fly.dev` (your app name instead of `<app>`).

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

About **$2.34 a month** for one small machine plus a 1 GB volume. Prices change, so check https://fly.io/docs/about/pricing/.

## 9. Security checklist

- Only use the `https://` address. Flock is set to refuse plain HTTP.
- Never share invite links in public chats or group emails; they are one-time credentials.
- Back up before every upgrade.
- Run **exactly one machine**. Never run `fly scale count 2`: each machine would have its own, different database.
- Keep backup files private.

## 10. Troubleshooting

- **"app name already taken"**: choose a different, more unique name in `fly.toml`.
- **Deploy says no volume found**: run the `fly volumes create` step with the same region as `fly.toml`.
- **Site will not load**: run `fly status` and `fly logs`. The health check is `/api/health`.
- **Lost or expired first-scheduler invite**: run `create-admin` with a different email. If another scheduler can already log in, ask them to make a new invite instead.
- **An invite points at localhost**: set `FLOCK_PUBLIC_URL` to the public HTTPS address before creating CLI accounts. On People, browse using that address and choose **Copy new invite**.
- **Data looks different after a while**: run `fly machine list` and make sure there is only one machine.
- **`fly` not found**: reinstall flyctl and open a new terminal window.

## Automatic checks and releases

GitHub Actions runs the checks for you and, when you press a button, deploys.

### One-time setup

1. Create a **PRIVATE** repository on the church's GitHub account and push this code to it.
2. Create a Fly deploy token: `flyctl tokens create deploy -a <app>` (use your app name from `fly.toml`).
3. In GitHub open Settings, Secrets and variables, Actions, and add a repository secret named `FLY_API_TOKEN` with that token. Never put the token anywhere else (not in files, chats or emails).

### How to release

1. Raise the version in `package.json` and add a matching `## X.Y.Z` heading to `CHANGELOG.md`.
2. Merge that change to `main` and wait for the checks to go green.
3. Tag it: `git tag vX.Y.Z` and push the tag: `git push origin vX.Y.Z`.
4. Open the Actions tab, choose **Deploy**, press **Run workflow** and type the tag (for example `v0.2.0`).

The free GitHub plan has no approval gate, so pressing the manual Run workflow button IS the gate. Nothing deploys by itself.

### What CI checks on every push

On every push to `main` and every pull request, on Node 22 and 24: the whole test suite (including the architecture and security tests), a coverage summary, `scripts/check-config.js` and `scripts/check-version.js`.

### If a deploy fails, or you need to roll back

- The Deploy workflow makes a volume snapshot first and stops if it cannot. It then deploys and checks `/api/health` for 2 minutes.
- If the check fails it prints ROLLBACK instructions. Run `flyctl releases -a <app>` to find the previous image, then `flyctl deploy -a <app> --image <previous image>`.
- If data looks wrong, list snapshots with `flyctl volumes snapshots list <volume id>` and restore as described in the backup section above.
- Check `flyctl status` and `flyctl logs` as well.
