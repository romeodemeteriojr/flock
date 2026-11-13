# 10. One person can hold up to 3 positions on one service

Status: proposed (built; accept when merged)

## TL;DR

- A scheduler can put the same person in **up to 3 positions on one service**
  (for example Vocals and Keys, or Sound desk, Slides and Door greeter). The
  2nd and 3rd need no "Assign anyway?": they are allowed, not a clash.
- **A 4th is refused** (`409 too_many_positions`), and so is **a second slot of
  the same position** on one service (`409 same_position`): one person cannot be
  two Door greeters. Neither can be forced, like `past` and `inactive`.
- Only slots the person **holds** count: waiting for their answer or
  confirmed. A position they said no to does not count.
- The limit is **per service** (one date and time). A 9:00 and an 11:00 service
  on the same morning are two services, as before.
- `double_booked` is gone: the server never sends it now.
- **Fill open positions** still puts each person on **at most one position per
  service**. Doubling someone up is the scheduler's own choice.

## Context

Small churches often have one person doing two jobs on a Sunday: leading
vocals and playing keys, or running sound and slides. Until now the server
treated a second position on one service as a clash the scheduler could
override, but the list of people to pick from left out anyone already serving
at that service, even under **Everyone**. In practice it could not be done.

## Decision

The rules, in `assignmentsService.assign` (and the shared helper
`positionLimits`), checked inside the same transaction as the write, so two
schedulers racing cannot pass the limit (`test/stress.test.js`):

| Case | Result |
| --- | --- |
| Person holds 0 to 2 other slots on the service, all other positions | assigned, no warning |
| Person holds 3 other slots on the service | `409 too_many_positions`, never overridable |
| Person holds another slot of the same position on the service | `409 same_position`, never overridable |
| Giving a person a slot they already hold (assign again) | fine: that slot is not counted |
| Their other slots there are declined | not counted |
| Replacing someone else in an accepted slot, person at the limit | `too_many_positions` (it comes before `accepted`) |

Order of the checks: `past`, `inactive`, `same_position`,
`too_many_positions`, then the overridable ones (`accepted`, `not_qualified`,
`blocked`). The hard limits come first so a forced retry is never offered for
something force cannot fix.

**Taking back a "no".** A volunteer may turn a declined slot back into a yes
while it is still theirs. That holds the slot again, so `respond` applies the
same two limits, worded for them: "You already have 3 positions at this
service, the most one person can have" / "You are already on Drums at this
service". Accepting a waiting ask, or saying no, never hits a limit.

**Picking someone** (`gapsService.suggest`):

- Someone already serving at the service in another position is listed, with
  `alsoOn: ['Sound']` and the first reason "Already serving as Sound at this
  service". They sort after everyone who is not serving there, so **Best
  match** goes to a fresh pair of hands; the app never marks them Best match.
- Left out: the person in the slot (or who declined it), anyone holding this
  position elsewhere on the service, and anyone already at 3 there.
- "Served N times" and the order count **services, not slots**: two positions
  on one Sunday is serving once. Auto-fill's fairness counts the same way.

**What people see.**

- The scheduler's slot sheet: an **Already serving** chip, and for the hard
  limits a plain message with only **OK**.
- The volunteer: each position is still its own card, answered on its own.
  A card with other positions at the same service says **Also on Vocals**, and
  saying no names the position ("Are you sure you can't do Sound on Sun 8
  Nov?", **I can't do Sound after all**) so it is clear the others stay.
- Notifications and reminders put positions at one service together: "Asked
  to serve: Sound and Vocals, Sun 15 Nov 9:00", "serving as Sound and Vocals
  on Sun 15 Nov at 09:00".
- Days off: "You are already scheduled on Sun 8 Nov as Sound and Vocals."
- Deleting a service counts **people**, each once: "1 person is scheduled on
  this date", not 2 for one person in two slots.

## Not chosen

- **A setting for the limit.** 3 covers the real cases (two or three jobs on
  one morning) and keeps one person from quietly running a whole service. It is
  one constant, `MAX_POSITIONS_PER_SERVICE`, if a church ever needs another.
- **A warning on the 2nd and 3rd.** The point is that it is allowed; a prompt
  every time would be noise.
- **Auto-fill doubling people up.** It would fill gaps by stretching the same
  few people, the opposite of what it is for.
- **Allowing the same position twice.** One person cannot be in two places.

## Consequences

- API: `double_booked` no longer happens; `same_position` and
  `too_many_positions` are new 409 codes (assign, and respond for a take-back).
  Suggestions carry `alsoOn`; `GET /api/me/schedule` items carry `alsoOn`.
  No database change.
- An installed app still on the old files (decision 0009) shows the server's
  own message for the new codes and offers no force, and lists people already
  serving without the chip, until it updates at the next tap.
