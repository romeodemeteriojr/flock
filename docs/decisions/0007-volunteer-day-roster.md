# 7. Volunteers see the full roster of the days they serve

Status: proposed (built; accept when merged)

## TL;DR

- On **My schedule**, every card has **Full roster**: everyone serving that
  **day** (each service on that date, each team and position), with their name
  and whether they **said yes** (Confirmed) or **have not answered** (Waiting
  for answer). Empty positions show as **Open**. The volunteer's own position
  says **You**. It is closed until tapped.
- **Only the days the volunteer serves**: a day where they hold a slot that is
  waiting for their answer or confirmed. Saying no takes that day's roster away.
- **Names only.** No emails, ids, days off, or anyone's other days. Someone who
  **said no** is not named: their position shows as Open, because it needs
  someone.
- Industry check: in Planning Center, people scheduled on a plan open it from
  My Schedule; its Teams tab lists their own teams first and, where permissions
  allow, all teams ("Show all teams"). Its lowest permission (scheduled viewer)
  has no access to people's contact details. Flock does the same, without
  contact details at all.
- No new route or table: `GET /api/me/schedule` also returns
  `rosters: { [date]: [{ time, serviceTitle, teams: [{ teamName, positions: [{ positionName, name, status, mine }] }] }] }`,
  built in `assignmentsService.mySchedule` from the slots it already reads.

## Decision

- **A day, not only a service.** The request was "the full roster for that
  day". With one service a Sunday the two are the same; with two (morning and
  evening) the volunteer sees both, each under its own time and title. To show
  only their own service instead, filter by `serviceId` in `dayRoster`.
- **Waiting counts as serving.** Someone deciding whether to say yes is helped
  by seeing who else is on, and "Serving with" already showed them.
- **Statuses** use the scheduler's words and chips: Confirmed, Waiting for
  answer, Open. `status` is `accepted`, `pending` or `open` (declined and empty
  both become `open`, with `name: null`).
- Order: services by time; teams and positions in the Teams page order.
- "Serving with" on the card stays: the same service only, names and positions.

## Not chosen

- A separate roster page and route (`/api/me/days/:date`): more code and a
  second access check, for data that is already small (at most 12 weeks of one
  person's days).
- Naming who said no: needless social pressure; it is the scheduler's business
  (the Gaps page shows it).
- Contact details: Flock only has emails, which are logins and stay private.

## Consequences

- A volunteer can now see the names on other services of the same day, and
  whether others have answered. `test/security.test.js` pins exactly what they
  can and cannot read; `test/assignments-service.test.js` pins the shape.
