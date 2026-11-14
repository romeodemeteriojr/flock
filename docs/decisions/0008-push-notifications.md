# 8. Push notifications to volunteers' phones

Status: proposed (being built; accept when merged)

## TL;DR

- Flock sends **standard Web Push** itself: no npm packages, no notification
  vendor, no phone app, no emails or texts. The app becomes an installable web
  app (a manifest and a small service worker that only shows notifications;
  no offline caching).
- **Off until the church sets two keys** (`FLOCK_VAPID_PUBLIC_KEY`,
  `FLOCK_VAPID_PRIVATE_KEY`, made by `node bin/flock.js push-keys`). Then each
  person turns it on **per device**, from a card on My schedule or
  **Notifications** in the account sheet. The bell in the top bar shows whether
  they are on here; until 0.14.3 it was a button that opened the page too.
- **iPhone:** push only works from the Home Screen web app, iOS 16.4 or newer.
  In Safari, Flock shows the steps (Share, Add to Home Screen, open, log in,
  Turn on). Android and desktop browsers turn it on in place.
- **What sends a notification:** a volunteer is asked to serve; taken off; their
  service moves (date or time) or is cancelled; their position is removed. All
  schedulers hear when someone says no. Schedulers can **Send reminders** from
  Gaps. Nothing for accepts, nothing for your own click, no timed reminders.
- **Best effort:** sent after the change is saved, never slowing or failing the
  click (Send reminders waits and reports). No retries.

## Decision

### Sending

- `src/infra/webpush.js`, built on `node:crypto` only:
  - VAPID (RFC 8292): an ES256 JWT, `aud` = the push endpoint's origin,
    `exp` at most 12 hours ahead, `sub` = `FLOCK_PUBLIC_URL`. Header
    `Authorization: vapid t=<jwt>, k=<public key>`.
  - Payload encryption (RFC 8291, `Content-Encoding: aes128gcm`): ECDH on
    P-256, HKDF-SHA-256, AES-128-GCM, one record.
  - Headers `TTL`, `Urgency`, optional `Topic`. `fetch` is injected,
    `redirect: 'error'`, with a timeout. Tests use the RFC 8291 example and
    check the JWT against the public key; nothing touches the network.
- The payload is always WebKit's **Declarative Web Push** JSON:
  `{"web_push":8030,"notification":{"title","body","lang","dir","navigate","tag","silent"}}`.
  Safari (iOS 18.4+, macOS 15.5+) can show it without running any code; the
  service worker parses the same JSON for Chrome, Firefox and older Safari and
  calls `showNotification`.

### Keys and settings

- Both keys or neither (the settings refuse to start otherwise, like Google
  sign-in), base64url, 65-byte public and 32-byte private, checked to be a
  pair. Push also needs an `https://` `FLOCK_PUBLIC_URL`.
- Keep a copy of the keys in the church's password manager. If they are lost
  or changed, every device must subscribe again: on each app open the page
  compares its subscription's key with the server's and, if they differ,
  quietly subscribes again and replaces the old device.

### Devices

- Table `push_devices` (migration `0003_push.sql`): person, endpoint (unique),
  `p256dh`, `auth`, created. Saving an endpoint that exists moves it to the
  person saving it.
- Only real push services: `https://` and a host under `push.apple.com`,
  `fcm.googleapis.com`, `push.services.mozilla.com` or `notify.windows.com`.
  Keys are checked (`p256dh` a valid 65-byte P-256 point, `auth` 16 bytes).
  At most 10 devices per person (the oldest goes). **Send me a test** at most
  once a minute.
- Devices belong to the person, not the login session, so a notification still
  arrives after a session expires. A device is removed when: that device logs
  out, the person turns it off, the push service answers 404 or 410, or a
  scheduler resets the person's login or deactivates them (all their devices).
  A 403 does not remove it (that is our key, not their device).

### Sessions

- Sessions now **renew on use**: 14 days from the last visit (renewed at most
  once a day, and the cookie is sent again). Otherwise a volunteer who only
  opens Flock from notifications would be logged out every 14 days. Logout,
  Reset login, deactivating and changing a password still end sessions.

### What people read

The lock screen shows the title "Flock" and one line:

| When | Text | Tap opens |
|---|---|---|
| Asked | Asked to serve: Sound, Sun 15 Nov 9:00. Tap to answer. (first 3 unanswered, then "and 2 more") | My schedule |
| Taken off | You're no longer on Sound, Sun 15 Nov 9:00. | My schedule |
| Moved | Morning service moved to Sun 15 Nov 10:30. You're still on Sound. | My schedule |
| Cancelled / position removed | Morning service on Sun 15 Nov 9:00 is cancelled. You were on Sound. | My schedule |
| Said no (to every scheduler) | Sam can't do Sound, Sun 15 Nov 9:00. | Gaps |
| Reminder | the reminder message Gaps already drafts | My schedule |

- **Ask these people** sends one notification per person, not one per slot.
  The "asked" notification always lists all of the person's unanswered asks and
  replaces the previous one (same `tag`).
- A decline that turns back into a yes sends nothing more.
- Time to live: changes and asks until the service starts (at most 28 days);
  "said no" for 1 day.
- Logs say only the kind, the push service host and the status. Never names,
  endpoints, keys or the text.

### Schedulers

- People shows a bell on everyone who has notifications on.
- Gaps **Send reminders** sends to those people and keeps **Copy** for the
  rest ("Sent to 9; 3 to copy"). A failed send falls back to Copy.

### iPhone and Google sign-in

- iOS has historically refused Google sign-in inside Home Screen apps. If that
  still happens, people log in there with their email and password; someone
  who only ever used Google gets a password through **Reset login**.

## Not chosen

- **A vendor** (OneSignal, Firebase Cloud Messaging directly): an outside
  account, its script on every page and its own data rules, for something the
  standard does with one small file.
- **The `web-push` npm package:** Flock has no npm packages; the two RFCs are
  short and have test vectors.
- **A native app / app stores:** cost, review and two codebases for one church.
- **Email or SMS:** Flock promises not to send them; texts cost money.
- **Timed reminders** ("you serve tomorrow"): Flock's one machine sleeps when
  idle and has no background jobs or time zone setting. A later decision.
- **Notification on every accept:** noise; Gaps shows the state.
- **Action buttons (Yes / No on the lock screen) and app badges:** not on iOS
  with declarative push; later, if wanted.

## Consequences

- Flock now talks to the outside world: Apple, Google, Mozilla or Microsoft
  push servers, only for devices whose owner turned it on. README and the
  privacy page say so. What goes to them is encrypted end to end; they see the
  device address, size and timing.
- One new table and one migration (additive). 0.5.0 deploys over 0.4.0; push
  stays off until the keys are set.
- New secrets to keep safe and back up.
