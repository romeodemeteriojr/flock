# 12. Services: start from a recent service, not templates

Status: proposed (built; accept when merged)

## TL;DR

- The Services page opens on **the list**. **Add a service** opens the form.
- The form offers **Start from**: up to 4 recent services (the latest of each
  title and time, within the last 91 days, with positions) plus **Blank**. A
  choice copies time, title and positions with counts, on the next free week.
- Teams in the position picker are **folded to one line** ("Band: Drums, Keys
  x2"). Folded picks are still in the form and still saved.
- No API or database change.

## Context

A new user found the page tedious: the add form was always open with every
team and position laid out, so reaching an existing service meant a long
scroll on a phone. Planning Center solves "the same service again" with
templates.

## Decision

Copy a real service instead of keeping a second list. "Start from" is built
from the services already there, so it can never go stale. The form opens on
**Blank**, so pressing Add does not create a copy nobody asked for.

The next date is a week after the source, rolled forward a week at a time to
today or later and past any service at the same time.

## Not chosen

- **Saved templates (PCO).** A second list to name, edit and keep in step with
  the Teams page. Add them on top of Start from if one-off changes copied
  forward turn out to annoy people.
- **Pre-selecting the newest service.** Saves a tap, but a quick Add would
  create a service the scheduler did not mean to.

## Consequences

- The known catch: a one-off (extra singers at Christmas) is copied into the
  next service until someone edits it back.
- The page now asks for 91 days back as well as 182 ahead (273 days, under the
  366-day limit).
