# 11. Files and links on a service, kept for a week after it

Status: proposed (built; accept when merged)

## TL;DR

- Anyone signed in can **add a file (up to 5 MB) or a link** to a service.
  Anything over 5 MB must be a link (for example a shared Drive or YouTube link).
- Only the **people serving at that service** (asked or confirmed) and
  **schedulers** can see them. Someone who said no cannot.
- PDF, photos, text, audio and video open in **Flock's viewer**: full screen,
  with a Close (X) button, so the installed app never strands you on a file.
  Everything else opens in the **phone's own viewer**.
- Files and links **expire 7 days after the service date**. From the 8th day
  nobody can open them or add new ones. If the service moves, the expiry moves too.
- Nothing deletes them on a timer. A scheduler runs the clean-up: **Clear
  expired files** on the Services page, or `flock purge-files` on the server.
- Who added a file can remove it; a scheduler can remove any.
- **Only a short list of file types** is kept, by extension (`FILE_TYPES`):
  PDF, text and chord charts, and photos (jpg, png, gif, webp): all shown by
  Flock's viewer on an iPhone and Android. Office files, audio, video, csv
  and HEIC were dropped from the list (see the CHANGELOG), so
  every file opens inside Flock with its Close button; share those as links.
  Ones added before stay until they expire and still open in the phone. The stored type comes from the extension; the phone's
  `Content-Type` is ignored. Anything else is refused (`400 file_type`) and
  the phone offers a link instead.
- **Per person** (not schedulers): at most **30 files and links an hour**
  (`429 too_many_adds`, counted from the audit log, so removing one does not
  give the try back) and **50 MB of files** on services not yet expired
  (`409 quota`).
- **My schedule** lists the past week's services the person served at that
  still have files, under **Last week**, so the files stay in reach until
  they expire.
- There can be at most **10 upcoming services** (today or later). Creating an
  11th is refused (`409 too_many_services`); **Repeat** makes as many as fit and
  lists the rest in `overLimit`. With at most 20 files of 5 MB on each, what
  files can take is bounded (about 1 GB at the very worst).

## Context

Teams pass setlists, run sheets and stage plots around before a Sunday. They
matter for a few days and then are clutter. Flock is one Node process and one
SQLite file, with no packages and no background jobs.

## Decision

- **Storage: in the database.** A new table `attachments` (migration 0005)
  holds the bytes in a `content` BLOB, last in the row so listing skips them.
  One file keeps backups, restores and the "one SQLite file" promise simple.
  5 MB and at most 20 per service keep it small.
- **Expiry is worked out, not stored**: last day = service date + 7. The service
  checks it on every list, open and add. A purge deletes the rows of services
  dated on or before today − 8, then runs `VACUUM` so the space goes back to the disk.
- **Upload is the raw request body** (`POST /api/services/:id/files?name=...`,
  type worked out from the name), not multipart. The router got a per-route `raw` body
  limit; a declared `Content-Length` over 5 MB is refused (413) before reading.
  The phone checks the size first and offers the link form instead.
- **Opening** is `GET /api/attachments/:id` with `Content-Disposition` and a
  strict `Content-Security-Policy`. Common types the phone can show (PDF,
  images, plain text, audio, video) are `inline`; everything else downloads.
  HTML, SVG, XML and scripts are always sent as `application/octet-stream`,
  so an uploaded file can never run as a page on Flock's address. Non-PDF
  files are sandboxed (PDF viewers refuse a sandbox; a PDF cannot script the site).
- **The viewer** (`web/lib/viewer.js`). Opened in the installed app, a file
  link used to replace Flock's own window with no browser bar and so no way
  to close it (only a back swipe). Now a file the phone can show opens in a
  full-screen layer with Close, Download, Escape and Back. Photos, audio and
  video use their own tags. Plain text sits in a frame, so it (and only it)
  may be framed by Flock itself (`frame-ancestors 'self'`,
  `X-Frame-Options: SAMEORIGIN`); every other file and response still refuses
  any frame. Audio and video added before the list was cut still play in
  the viewer; older office, csv and HEIC files download as before. All of
  them go when they expire.
- **PDFs are drawn by PDF.js**, one canvas per page. In a frame an iPhone
  draws only the first page of a PDF (found in 0.13.1), and no browser can
  draw PDF pages without a library. PDF.js (Mozilla, Apache-2.0, legacy build
  for older iPhones) is Flock's first vendored library: two files in
  `web/vendor/pdfjs`, pinned by hash (`test/vendor.test.js`), licence in
  `licenses/`. It is about 1.8 MB, so it is loaded only when a PDF opens and
  is left out of the app shell saved on the phone (`src/static.js`). It runs
  under the normal `default-src 'self'` policy with `isEvalSupported: false`.
  Pages are drawn as they come near the screen, so a long file opens fast.
- **Links** must be `http(s)` without a user name or password; `javascript:`
  and `data:` are refused.
- A file nobody can see answers 404, the same as one that does not exist.

## Consequences

- The database (and every backup) grows by what people upload until someone
  runs the clean-up. Schedulers should run it now and then, for example with
  the weekly backup.
- Moving a service later keeps its files longer; moving it earlier can expire them.
- No virus scanning: files come from people already in the church's Flock,
  and only the people serving can open them.

## Future work: keep uploads apart from the app

This first version trusts the people in the church's Flock. Uploads should be
kept apart from the app, as if behind an air gap, so a bad file can never
reach the app, its data or people's phones. Still to do:

- **Serve files from another address.** Files are served from Flock's own
  address today, behind `nosniff`, a sandbox (not for PDFs) and download for
  anything unusual. A separate, cookieless address (or short-lived signed
  links) would keep a hostile file, or a bug in a phone's viewer, away from
  the session cookie and the API.
- **Check what a file really is.** The type comes from the phone and is
  trusted. Read the first bytes (PDF, JPEG, PNG and so on), refuse files whose
  content and name disagree, and refuse polyglots (a file that is both an
  image and a page).
- ~~**Allow a short list of types only.**~~ Done (see the TL;DR), and cut
  to the types Flock can show itself, so no office files at all (which also
  closes the renamed-`docm` gap).
- **Remove hidden data.** Photos carry location (EXIF GPS) and documents
  carry author names. Strip it on upload, or warn.
- **Scan in a separate process.** Run checks (and any virus scanner) in a
  separate process or machine with no access to the database, and store the
  file only once it passes.
- ~~**Limits per person.**~~ Done: an hourly limit and a quota (see the
  TL;DR). Still open: anyone signed in can add to any service, by choice;
  allowing uploads only by the people serving and schedulers would close it.
- **Backups.** Backups keep files after they expire. Leave files out of
  backups, or keep files in a store of their own with its own clean-up.
- **Links.** Show the site's name next to every link, and warn about
  shortened links. Flock never fetches a link itself; keep it that way (no
  previews), so it cannot be made to call other addresses.
- **Names.** Control and right-to-left characters are already stripped, so a
  name cannot hide its real extension. Also look-alike letters and very long
  names before the extension.
