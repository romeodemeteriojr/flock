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

2. Open `fly.toml` in a text editor and change `flock-CHANGE-ME` to a name nobody else has used, such as `grace-church-flock`. It must be globally unique. Also replace the `primary_region` placeholder with the region nearest you (`fly platform regions` lists them).

3. Register the app without starting it, keeping our settings:

   ```
   fly launch --no-deploy --copy-config
   ```

   If it asks for an app name, type your unique name. Answer **no** if it offers a database or to change the settings.

4. Create the storage disk (the "volume") where the database lives. Use the same region as in `fly.toml`:

   ```
   fly volumes create flock_data --size 1 --region <region>
   ```

5. Optional safety check of the settings:

   ```
   node scripts/check-config.js --production
   ```

6. Deploy:

   ```
   fly deploy
   ```

7. Create the first scheduler account:

   ```
   fly ssh console -C "node bin/flock.js create-admin <username> 'Full Name'"
   ```

   A **temporary password is printed once**. Write it down, give it only to that person privately, and have them change it after signing in.

8. Visit `https://<app>.fly.dev` (your app name instead of `<app>`).

## 3. Your own web address (optional)

If you own a domain such as `schedule.example.org`:

```
fly certs add schedule.example.org
```

Fly shows the DNS records to add at your domain provider. HTTPS is set up automatically.

## 4. Updating to a new version

Get the new version of the Flock folder, **make a backup first** (section 6), then:

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
- Never share temporary passwords in public chats or group emails.
- Back up before every upgrade.
- Run **exactly one machine**. Never run `fly scale count 2`: each machine would have its own, different database.
- Keep backup files private.

## 10. Troubleshooting

- **"app name already taken"**: choose a different, more unique name in `fly.toml`.
- **Deploy says no volume found**: run the `fly volumes create` step with the same region as `fly.toml`.
- **Site will not load**: run `fly status` and `fly logs`. The health check is `/api/health`.
- **Lost the temporary password**: run `create-admin` again with a new username, or ask a technical friend to reset it.
- **Data looks different after a while**: run `fly machine list` and make sure there is only one machine.
- **`fly` not found**: reinstall flyctl and open a new terminal window.
