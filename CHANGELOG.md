# Changelog

## 0.1.0

First release, built card by card.

### Icons pass (C-103)

Every scheduler action on every screen now uses a small hand-drawn 24px icon alongside its label.
Nine new icon names were added to `web/lib/icons.js`: `key`, `shield`, `user-off`, `user-check`,
`list-check`, `send`, `refresh`, `filter`, `dot`.

**Icons per screen**

- **My schedule**: sparkle (hero badge), calendar (empty state), users (co-volunteers line),
  warning (conflict confirm).
- **Days I can't serve**: calendar (blockout icon), plus (add button), warning (clash notice).
- **People**: shield (make scheduler/volunteer icon button), user-off / user-check (deactivate/reactivate
  icon button), edit (edit name icon button), list-check (positions icon button), key (reset password
  icon button), copy (copy password), info (role description), search (search field), plus (add person
  button), lock (password box), users (person count chip).
- **Teams**: plus (add team / add position buttons), users (position count chip).
- **Services**: plus (add service button), calendar (service card icon), edit (edit button).
- **Schedule**: plus (open slot button), calendar (date-range hint), dot (today marker).
- **Gaps**: plus / x / clock / user-off (gap kind icons), copy (copy reminder buttons), copy all,
  bell (reminders header), mail (never-sends notice), send (show messages button), warning (gap group icon).
- **Login / Password**: sparkle (login logo), lock (password logo + hint).
- **Nav**: home, calendar, users, sparkle, clock, grid, warning, more, logout.
- **My schedule (volunteer home)**: confirm / decline buttons keep their words.

**What kept its words (not icon-only)**

- Login and password: form submission buttons ("Log in", "Save my new password") keep their label text.
- Confirmations and destructive steps: "Yes, make a scheduler", "Yes, deactivate", "Yes, delete it",
  "Yes, I can't make it" — all explicit yes/no buttons keep words.
- Volunteer answer buttons: "Yes, I can", "I can't" keep words.
- Primary actions: "Add person", "Add team", "Add position", "Add service", "Save name" keep words.
- Section titles and page headings always have words.

**What the test can check (no browser needed)**

- Every `<button>` and `<a>` has an accessible name (text, aria-label, or title).
- Every `data-icon` attribute references a name that exists in `icons.js`.
- The gallery renders all icon names with their labels.

**What could not be checked without a real browser**

- Icon widths at 380 px and 560 px (layout and touch targets).
- Dark mode visual appearance.
- Touch behaviour on mobile devices.
