# 4. Invite links replace temporary passwords

Status: accepted (not yet built)

## Context

Adding a person meant the scheduler had to send them a username and a
temporary password (for example `maple-river-07`) out of band, and the person
then had to change it on first login (`must_change_password`, enforced in
`src/guard.js`). That is two things to send and type, plus an extra step.
Making accounts start with no password, so the first login sets it, was ruled
out: usernames are predictable (built from names), so anyone who could reach
Flock could claim an account before its owner did.

## Decision (summary)

- Adding a person creates a **one-time invite link** that expires after
  **7 days**. The scheduler copies a ready-made message with one button and
  sends it the usual way. The person taps the link, sees their username and
  chooses a password, which also logs them in.
- **Making a new link cancels the previous one**, because each person has at
  most one invite row.
- **Reset password** clears the password, ends every session and makes a new
  invite.
- The **base URL** is `FLOCK_PUBLIC_URL` if set, otherwise the address the
  scheduler is browsing from. Show a warning when that address is
  `localhost` or `127.0.0.1`.
- **CLI** `create-admin` and `demo` print a link instead of a password.
- **Removed completely**: temporary passwords, `must_change_password`, and the
  forced change-password step. Voluntary "change my password" stays.
- **No upgrade handling.** Flock is not live, so `0001_init.sql` is edited in
  place (see "Schema"). Delete any local `data/*.db` after pulling.

## Implementation guide

Follow the layers in `docs/decisions/0001`–`0003`: routes are thin HTTP
adapters, services hold the rules and never run SQL, the data layer
(`src/data/sqlite/*`) holds the SQL, and services get everything through
`deps` (clock, random, hasher, logger, config). Read
`src/services/auth-service.js` and `src/services/people-service.js` first, and
copy their style: JSDoc on every public method, plain-English error messages,
and the `data.tx(async (d) => …)` pattern.

### 1. Schema (`src/migrations/0001_init.sql`, edit in place)

Why in place: the migration runner wraps each file in a transaction with
`foreign_keys=ON`, so rebuilding `people` in a 0002 file would cascade-delete
sessions and assignments. Flock is not live, so editing 0001 is safe.

```sql
-- people: password_hash becomes nullable; must_change_password is removed.
CREATE TABLE people (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,                 -- NULL = has not joined yet (or was reset)
  role TEXT NOT NULL CHECK(role IN ('admin','member')),
  active INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL
);

-- New. One row per person at most: the PRIMARY KEY is what makes
-- "a new link cancels the old one" true.
CREATE TABLE invites (
  person_id INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,    -- SHA-256 of the raw token, like sessions
  expires_at TEXT NOT NULL,           -- ISO time
  created_at TEXT NOT NULL
);
```

### 2. Config (`src/config.js`)

```js
// loadConfig: add
publicUrl: env.FLOCK_PUBLIC_URL ? env.FLOCK_PUBLIC_URL.replace(/\/+$/, '') : undefined,

// validateConfig: add
if (config.publicUrl !== undefined) {
  let ok = false;
  try { const u = new URL(config.publicUrl); ok = u.protocol === 'https:' || u.protocol === 'http:'; } catch {}
  if (!ok) problems.push('publicUrl must be a full http:// or https:// address (FLOCK_PUBLIC_URL)');
}
```

### 3. Data layer

In `src/data/index.js`, update the typedefs and the `createData` wiring, and
add `src/data/sqlite/invites.js` modelled on `sessions.js`.

- `Person` / `AuthPerson`: remove `mustChangePassword` and add
  `hasPassword: boolean`. In `src/data/sqlite/people.js`, change `PUBLIC` to
  select `password_hash IS NOT NULL AS has_password` and map it to
  `hasPassword`. `AuthPerson.passwordHash` may now be `null`.
- `people.create({ name, username, role, createdAt })`: no `passwordHash` (it
  is stored as NULL) and no `mustChangePassword`.
- `people.setPassword(id, passwordHashOrNull)`: drop the `mustChange`
  argument. It still resets `failed_logins` and `locked_until`, and returns
  true if a row changed.
- New `InvitesRepo`:

```js
// replace: INSERT INTO invites (...) VALUES (...)
//          ON CONFLICT(person_id) DO UPDATE SET token_hash=excluded.token_hash,
//          expires_at=excluded.expires_at, created_at=excluded.created_at
replace({ personId, tokenHash, expiresAt, createdAt }) -> Promise<void>
findByTokenHash(tokenHash) -> Promise<{ personId, tokenHash, expiresAt, createdAt } | null>
deleteForPerson(personId) -> Promise<number>
```

Add these methods to `test/data/contract.js` (see the test plan).

### 4. Auth service (`src/services/auth-service.js`)

Delete `TEMP_WORDS`, `generateTempPassword`, `newTempCredentials` and
`issueTempPassword`. Remove `mustChangePassword` from `publicPerson` and add
`hasPassword: !!person.hasPassword`. Update the header comment about secrets:
the raw invite token is returned only by `newInvite()`.

```js
export const INVITE_DAYS = 7;
export const INVITE_GONE_MESSAGE =
  'This link has expired or was already used. Ask your scheduler for a new one.';

/** Pure: the link a person taps. The token sits after '#', so browsers never send it to the server or in a Referer. */
export function inviteLink(baseUrl, token) {
  return `${baseUrl.replace(/\/+$/, '')}/#/welcome?token=${token}`;
}

// inside createAuthService:

/** A new invite token. The people service stores tokenHash inside its own transaction. */
newInvite() {
  const token = random.token(32);                        // 43 chars, matches TOKEN_RE
  const now = nowDate();
  return {
    token,
    tokenHash: tokenHash(token),
    expiresAt: new Date(now.getTime() + INVITE_DAYS * 86400000).toISOString(),
    createdAt: now.toISOString(),
  };
},

/** Who an invite is for, so the welcome page can greet them. */
async inviteInfo(token) {
  const found = await findLiveInvite(data, token);       // helper below
  if (!found) throw new NotFoundError(INVITE_GONE_MESSAGE);
  return { name: found.person.name, username: found.person.username };
},

/** Use an invite: set the password, end old sessions, start a new one. */
async acceptInvite(token, newPassword) {
  const found = await findLiveInvite(data, token);
  if (!found) throw new NotFoundError(INVITE_GONE_MESSAGE);
  const err = validatePassword(newPassword, { username: found.person.username });
  if (err) throw new ValidationError(err);
  const hash = await hasher.hash(newPassword);
  await data.tx(async (d) => {
    const again = await d.invites.findByTokenHash(tokenHash(token));
    if (!again || again.personId !== found.person.id) throw new NotFoundError(INVITE_GONE_MESSAGE); // used concurrently
    await d.people.setPassword(found.person.id, hash);
    await d.invites.deleteForPerson(found.person.id);
    await d.sessions.deleteForPerson(found.person.id);
  });
  logger.info('invite accepted', { personId: found.person.id });  // never log the token
  const sessionToken = await createSession(found.person.id);
  const person = publicPerson(await data.people.findById(found.person.id));
  return { person, token: sessionToken };
},

// private helper (module or closure level)
async function findLiveInvite(data, token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const inv = await data.invites.findByTokenHash(tokenHash(token));
  if (!inv || !(Date.parse(inv.expiresAt) > nowDate().getTime())) return null;
  const person = await data.people.findById(inv.personId);
  if (!person || !person.active) return null;
  return { invite: inv, person };
}
```

Change `login`: if `found.passwordHash` is null, call `burn(...)` and throw
`invalid('no_password')`, the same message and timing as a wrong password.
Do not count it as a failed login.

`changePassword` stays as it is, but calls `setPassword(personId, hash)` with
no third argument.

### 5. People service (`src/services/people-service.js`)

Update `personView`: remove `mustChangePassword` and add
`joined: !!p.hasPassword`. Update the `deps.auth` JSDoc to list `newInvite`.

```js
// create(actor, input) returns { person, invite: { token, expiresAt } }
const inv = auth.newInvite();
const person = await data.tx(async (d) => {
  // ...existing username logic...
  created = await d.people.create({ name, username: uname, role, createdAt: clock.now().toISOString() });
  await d.invites.replace({ personId: created.id, tokenHash: inv.tokenHash, expiresAt: inv.expiresAt, createdAt: inv.createdAt });
  await audit(d, actor, 'person.create', ...);   // unchanged
  return created;
});
return { person: personView(person), invite: { token: inv.token, expiresAt: inv.expiresAt } };

// invite(actor, id): "Copy new invite" for someone who has not joined
const p = await data.people.findById(id);
if (!p) throw new NotFoundError('That person was not found');
if (!p.active) throw new ValidationError(`${p.name} is deactivated. Reactivate them first.`);
if (p.hasPassword) throw new ValidationError(`${p.name} has already joined. Use Reset password instead.`);
const inv = auth.newInvite();
await data.tx(async (d) => {
  await d.invites.replace({ personId: id, ...inv without token });
  await audit(d, actor, 'person.invite', `person ${id}`);
});
return { person: personView(p), invite: { token: inv.token, expiresAt: inv.expiresAt } };

// resetPassword(actor, id): same return shape
const inv = auth.newInvite();
await data.tx(async (d) => {
  if (!(await d.people.setPassword(id, null))) throw new NotFoundError('That person was not found');
  await d.sessions.deleteForPerson(id);
  await d.invites.replace({ personId: id, ...inv without token });
  await audit(d, actor, 'person.reset_password', `person ${id}`);
});
return { person: personView(await data.people.findById(id)), invite: { token: inv.token, expiresAt: inv.expiresAt } };
```

Reset on a deactivated person is allowed. The invite can't be used until the
person is reactivated, because `findLiveInvite` checks `active`.

### 6. Routes

`src/routes/people.js` and the CLI both turn `{ token, expiresAt }` into a
link. Add this to the route file:

```js
import { inviteLink } from '../services/auth-service.js';

// The scheduler's own Host header is only echoed back to that scheduler, so it's fine to use here.
function baseUrl(req, config) {
  if (config.publicUrl) return config.publicUrl;
  const proto = config.secureCookies ? 'https' : 'http';
  return `${proto}://${req.headers.host ?? 'localhost'}`;
}
function inviteOut(req, config, invite) {
  const base = baseUrl(req, config);
  const host = new URL(base).hostname;
  return {
    link: inviteLink(base, invite.token),
    expiresAt: invite.expiresAt,
    localOnly: host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]',
  };
}
```

- `POST /api/people` returns `201 { person, invite: inviteOut(...) }`.
- New `POST /api/people/:id/invite` (admin) returns `200 { person, invite }`.
- `POST /api/people/:id/reset-password` returns `200 { person, invite }`.

In `src/routes/auth.js`, add two routes, both `{ auth: 'none' }`. They use
POST so the token never appears in a URL or the logs. They share a second
`createIpThrottle` instance with the same settings as login: only failures
count, and when over the limit throw `TooManyRequestsError`.

- `POST /api/welcome/check` with body `{ token }` returns
  `200 { name, username }`, or `404 { error: INVITE_GONE_MESSAGE }`.
- `POST /api/welcome` with body `{ token, password }` returns
  `200 { person }` with `Set-Cookie: sessionCookie(req, ctx, token)`, or
  404/400. Use `textOrNone(field(body, ...))` like login does.
- Login's response drops `mustChangePassword`.

### 7. Guard (`src/guard.js`)

Delete `ALLOWED_WHEN_MUST_CHANGE` and the `user.mustChangePassword` block.
The X-Flock header check stays: `web/api.js` already sends the header on
every request, so the new POST routes pass.

### 8. Web

- `web/routes.js`: add `import * as welcome from './views/welcome.js'` and the
  route `{ path: '/welcome', view: welcome, role: 'open' }`. In `resolve`, a
  route with role `'open'` is returned whether or not anyone is logged in, so
  a scheduler testing a link while logged in still sees the page. Remove
  both `mustChangePassword` branches (in `resolve` and `navRoutes`).
- `web/app.js`: remove the line that sets `mustChangePassword: true` (around
  line 59) and any handling of the `must_change_password` code.
- `web/views/login.js`: after login, always `ctx.navigate('#/')`.
- `web/views/password.js`: remove the forced-mode wording. The page is now
  only "Change my password".
- `web/gallery.js`: remove the must-change sample, and add samples of the
  welcome page and the invite box.
- New `web/lib/invite.js`, pure and unit-tested:

```js
export function firstName(name) { return String(name).trim().split(/\s+/)[0] || String(name); }
export function inviteMessage({ name, username, link }) {
  return `Hi ${firstName(name)}, you've been added to Flock. Tap this link to choose your password: ${link} `
    + `Your username is ${username}. The link works for 7 days.`;
}
```

- New `web/views/welcome.js`, modelled on `login.js` (same markup classes,
  `mount(root, ctx)` export):

```
mount:
  token = new URLSearchParams((location.hash.split('?')[1]) ?? '').get('token')
  show "Checking your link…"
  try r = await api.post('/api/welcome/check', { token })
  catch -> show INVITE_GONE text (the server's error message) and a link to #/login. Stop.
  show: "Hi {r.name}. Your username is {r.username}. Remember it for next time."
        password field + "Type it again" field (both type=password, autocomplete=new-password,
        and a hidden username field with autocomplete=username so password managers save it)
        button "Choose password"
  on submit:
    if fields differ -> inline error "The two passwords are not the same."
    r = await api.post('/api/welcome', { token, password })
    ctx.setUser(r.person); ctx.navigate('#/')      // navigating also takes the token out of the address bar
    on error -> show the server message inline (password rules / link gone)
```

- `web/views/admin-people.js`:
  - Replace `passwordBox(secret)` with `inviteBox(inv)`, where
    `inv = { name, username, link, localOnly }` and the model field
    `m.secret` becomes `m.invite`. It shows the heading
    `${iconSlot('send')} Invite for {name}`, then the message from
    `inviteMessage(...)` in a `<p class="lead" data-invite-text>`. If
    `localOnly` is set, it adds the warning: "This link uses localhost, so it
    only works on this computer. Set FLOCK_PUBLIC_URL, or open Flock using
    this computer's network address, then copy a new invite." Last come the
    buttons **Copy message** (`data-action="copy" data-copy-key="invite"`)
    and **Done**.
  - The `copy` action writes `inviteMessage(...)` (not the password) to
    `win.navigator.clipboard.writeText` and calls
    `flashCopied(win, root, target, 'Copy message', hold, 'invite')` from
    `web/lib/copyflash.js`. Keep the existing "no clipboard" fallback
    message.
  - In `personRow`, if `!p.joined && p.active`, add
    `<span class="chip chip-plain">Not joined yet</span>` next to the role
    chip, and an `iconButton('send', 'Copy new invite', { dataAction: 'invite', dataId: p.id })`.
    The `invite` action calls `api.post('/api/people/${id}/invite', {})` and
    opens `inviteBox`.
  - The reset confirm reads: "Make a new invite link for **{name}**? Their
    current password stops working right away, and they are logged out
    everywhere." The button reads "Yes, make a new link". On success, open
    `inviteBox`.
  - The add-person success opens `inviteBox` too.

### 9. CLI (`src/cli/commands.js`, `src/cli/demo.js`)

```js
const base = config.publicUrl ?? `http://localhost:${config.port}`;
const { person, invite } = await services.people.create(null, { name, username, role: 'admin' });
console.log(`Created ${person.name} (${person.username}).`);
console.log(`Invite link (works once, for 7 days): ${inviteLink(base, invite.token)}`);
```

`seedDemo` returns `{ invite, counts }` in place of `tempPassword`, and the
`demo` command prints the link the same way. Update the help text on line 20
to say "prints an invite link".

### 10. Docs

- README: rewrite "Creating the first scheduler", "Adding people and their
  first passwords" (rename it "Adding people"), the demo section, and "How
  passwords work" (a reset now makes a new link). Add `FLOCK_PUBLIC_URL` next
  to `FLOCK_DB` and `FLOCK_PORT`.
- CHANGELOG: add an "Invite links" entry under a new `0.2.0` heading.
- Change this file's status to "accepted (built)".

## Test plan

Use the existing helpers: `test/helpers/data.js` (`makeData`),
`test/helpers/container.js`, `test/helpers/app.js` (`startTestApp({ now })`
for a fixed clock), `test/helpers/client.js` (`createClient`, which keeps
cookies) and `test/helpers/seed.js`. In `seed.js`, `addPerson` loses its
`mustChange` option. Add a `password: null` option that creates a person who
hasn't joined.

### New tests

**`test/data/contract.js`** (invites repo)
1. `replace` then `findByTokenHash` returns the row.
2. A second `replace` for the same person overwrites it, and the old hash
   then returns null.
3. `deleteForPerson` returns 1, then 0.
4. Deleting the person cascades to the invite.
5. `people.create` without a hash gives `hasPassword: false`, and
   `setPassword(id, 'h')` makes it true.

**`test/invites-service.test.js`** (new; auth + people services with a fake clock)
1. `create` returns a 43-character `invite.token` and an `expiresAt` exactly
   7 days after the clock time. The stored row holds only the SHA-256 of the
   token, never the raw token.
2. `inviteInfo(token)` returns `{ name, username }`.
3. `acceptInvite(token, 'good-pass-1')` sets a password, deletes the invite
   and returns a session token that `authenticate` accepts.
4. Using the same token again throws `NotFoundError` with
   `INVITE_GONE_MESSAGE`.
5. After moving the clock to 7 days + 1 ms, the invite is gone. At 7 days −
   1 ms it still works.
6. `invite(actor, id)` twice: the first token is gone and the second works.
7. `invite` on a person who has joined throws `ValidationError`, and on a
   deactivated person throws `ValidationError`.
8. `resetPassword`: the old password no longer logs in, every session is
   ended, and the new token works.
9. A deactivated person's valid token gives `NotFoundError`. After they are
   reactivated, it works.
10. A weak password (under 8 characters, or equal to the username) throws
    `ValidationError`, and the invite is still usable afterwards.
11. Garbage tokens (`''`, `'x'`, 43 `!` characters, a number) give
    `NotFoundError` and never reach the data layer's lookup.
12. `login` for a person with no password gives the same message as a wrong
    password, and does not raise `failed_logins`.
13. The logger never receives the token: scan every call's arguments for the
    token string.

**`test/welcome-routes.test.js`** (new; real app plus client)
1. Admin `POST /api/people` returns 201 with `invite.link` matching
   `^http://127\.0\.0\.1:\d+/#/welcome\?token=[A-Za-z0-9_-]{43}$`
   (or whatever host the test client sends) and `invite.localOnly === true`.
2. With `config.publicUrl = 'https://flock.example.org'`, the link starts
   with that and `localOnly` is false.
3. `/api/welcome/check` returns name and username. `/api/welcome` returns
   200, a `Set-Cookie`, and `GET /api/me` with that cookie works.
4. A used or expired token gives 404 with the plain message on both routes.
5. A request without the `X-Flock` header gives 403.
6. Over 20 failed `/api/welcome` attempts from one IP gives 429.
7. A member calling `POST /api/people/:id/invite` gets 403. A joined person
   gets 400.
8. Reset password: the person's existing cookie gets 401 afterwards.

**`test/invite-message.test.js`** (new; `web/lib/invite.js`)
1. `inviteMessage({ name: 'Pat Smith', username: 'pat.smith', link: L })`
   equals the exact sentence in section 8.
2. `firstName('  Pat  ')` is `'Pat'`, and a single name works.

**`test/config` cases** (in the existing config test file, `core-infra.test.js`)
1. `FLOCK_PUBLIC_URL=https://x.org/` becomes `publicUrl: 'https://x.org'`.
2. `ftp://x` and `not a url` give a `ConfigError` mentioning
   FLOCK_PUBLIC_URL.

**UI tests** (in `test/admin-people-ui.test.js`, with the fakes in
`test/helpers/fakeui.js` and `fakepage.js`)
1. After adding a person, the invite box shows the message text and a
   **Copy message** button. Clicking it writes exactly `inviteMessage(...)`
   to the fake clipboard and shows the check icon.
2. With `localOnly`, the localhost warning appears.
3. A row with `joined: false` shows "Not joined yet" and **Copy new
   invite**, and clicking it posts to `/api/people/:id/invite`.
4. A joined row shows neither.
5. Confirming reset shows the invite box.

Also test the welcome view, in a new `test/welcome-ui.test.js` or next to
the login UI tests:

1. A token in the hash is posted to the check route, and the greeting shows
   the username.
2. Passwords that don't match show an inline error and post nothing.
3. Success calls `setUser` and navigates to `#/`.
4. A gone link shows the message and a link to `#/login`.
5. `resolve('#/welcome?token=…', null)` and `resolve(..., someUser)` both
   return the welcome route.

### Existing tests to update (they use temporary passwords today)

`auth-service`, `auth`, `auth-routes`, `people`, `people-service`,
`admin-people-ui`, `ui-flows`, `e2e`, `shell`, `security`, `stress`, `cli`,
`core-infra`, `backup-restore`, `polish`, `upgrade`, `db`, `icons-a11y`,
`data/sqlite`, `data/contract`, `helpers/seed`.

- Wherever a test did "create, read `tempPassword`, log in, change
  password", make it "create, take `invite.token` (or parse it from
  `invite.link`), `POST /api/welcome`".
- Delete the tests for the forced change-password step and the
  must-change guard. Replace them with test 12 in the service list (no
  password, no login).
- `db.test.js`: the `people` column list loses `must_change_password`, and
  `invites` gets its own column list.
- `upgrade.test.js`: drop `must_change_password` from its 0001-shape insert.
- `cli.test.js`: `create-admin` prints a line matching
  `/Invite link .*#\/welcome\?token=/` and no "Temporary password".

### Done when

- `npm test` passes.
- `grep -rnE "tempPassword|mustChange|must_change|TempPassword|TempCredentials|TEMP_WORDS" src web test bin README.md`
  prints nothing.
- Manual check: run `npm start` with a fresh `FLOCK_DB`, run `create-admin`,
  open the printed link, choose a password, add a person, click **Copy
  message**, paste it, and open the link in a private window to join as
  that person.

## Delivery

One branch and one PR covering sections 1–10 and the test plan.
