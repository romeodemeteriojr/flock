# 9. The app's own files are kept on the phone

Status: proposed (being built; accept when merged)

## TL;DR

- The service worker now keeps **a copy of the app's own files** (pages,
  scripts, styles, the font, icons) on the device, so an installed Flock opens
  at once, even while Fly is waking the machine up or the signal is poor.
- **Never data.** Nothing under `/api/` is cached, and nothing is stored for
  use offline. With no connection Flock opens to a "Can't reach the server"
  page with **Try again**, not the browser's error page.
- **Updates:** the server writes the list of app files, with a hash of each,
  into the first line of `/sw.js`. Any change to the app changes the worker,
  the phone notices, fetches the new files in the background, and switches at
  the next tap that changes the page (one quick reload).
- This reverses one line of decision 0008 ("no offline caching") for the app's
  files only. Notifications are unchanged.

## Context

Flock is used mostly as an app on the Home Screen. Two things made it feel
slow and broken there:

- Fly stops the machine when nobody uses it. The first person to open Flock
  waits for it to start before even the page frame appears, looking at a blank
  screen.
- On bad signal, or none, an installed app showed the browser's own error
  page, which looks like Flock is broken.

There is no build step, so file names never change between releases. Caching
by name needs a different way to know when something changed.

## Decision

### Serving (`src/static.js`)

- Every file has a weak ETag (16 bytes of SHA-256 of its bytes). Code is sent
  with `Cache-Control: no-cache` (the browser checks each time and gets a 304
  when nothing changed); pictures and the font may be kept for a day.
- Text is sent as brotli or gzip when the browser accepts it and it is smaller.
- `/sw.js` is sent with one line in front:
  `self.FLOCK_SHELL={"build":"<hash of all>","files":{"/app.js":"<hash>",…}};`
  The list is every servable file in `web/` except `/sw.js`, `/gallery.html`,
  `/gallery.js` and `/privacy.html` (not part of the app people use).
  A new release changes some file, so it changes the build, so it changes the
  worker's bytes. The browser compares those bytes when it checks for an update.

### The worker (`web/sw.js`)

- **Install:** fetch every listed file (`cache: 'no-cache'`) into a cache named
  `flock-shell-<build>`. Each answer must be OK and, when it carries an ETag,
  the ETag must be the listed hash. All or nothing: one failure (for example a
  deploy happening at that moment) deletes the new cache and the install fails,
  so the old worker and its files stay. The browser tries again at its next
  update check. The very first worker on a device starts at once.
- **Activate:** delete every other `flock-shell-*` cache; take control of open
  pages.
- **Fetch:** only `GET`, only Flock's own address, never `/api/`. A listed file
  (with `/` meaning `/index.html`, the query string ignored) is answered from
  the cache, falling back to the network. Anything else is left to the browser.
- **Message** `{type: 'skip-waiting'}` lets the page tell a waiting worker to
  take over.

### The page (`web/lib/worker.js`)

- The worker is registered for **everyone** when the app starts (before, only
  when someone turned notifications on), with `updateViaCache: 'none'`.
- A new worker that has finished installing **waits**. It takes over at the
  next in-app page change (a tap on a tab, a link, a button that moves page):
  the page asks it to take over and reloads once. Never in the middle of
  filling in a form, and never on its own while someone is looking at a page.
- When the app comes back to the screen, it asks the browser to check for an
  update, at most once every 30 minutes (an installed app can stay open for
  days without a page load, and page loads are when browsers check by
  themselves).
- On `localhost` a new worker takes over at once (for development).

## Not chosen

- **Offline data** (my schedule readable without a connection, answers queued
  and sent later): stale rosters and answers that look sent but are not are
  worse than an honest "Can't reach the server". Later, if asked for.
- **Background sync, periodic sync:** not on iOS; nothing to sync without
  offline data.
- **Versioned file names** (`app.3f2a.js`): needs a build step, which Flock
  does not have.
- **A hand-kept version number in `sw.js`:** easy to forget; the hash list
  cannot be forgotten.
- **Taking over as soon as a new worker is ready** (`skipWaiting` at once):
  a page running old scripts would start loading new ones, or a reload would
  happen under someone's thumb.
- **Network first for the app's files:** on bad signal the app would wait for
  the network on every start, which is what this decision is meant to fix.

## Consequences

- Each device keeps one copy of the app's files: about 340 KB in 40
  files at 0.6.0, replaced each release.
- After a deploy, a phone shows the old version until its next check and next
  page change. API changes must keep working with the previous release's page
  for that time; so far no release has needed otherwise.
- A broken deploy that serves wrong files cannot replace a working cache: the
  hashes would not match and the install fails.
- Every device now has a service worker, not only those with notifications on.
  It does nothing with push unless the person turned notifications on.
