---
schemaVersion: 1
pattern: state-view
swimlane: — → Support
status: implemented
version: 1
implementedIn: src/support/escalation
---
# Slice: Tickets Awaiting Escalation

_Eval fixture (GH #452) — a deliberately tiny implemented slice used to seed the
false-positive-bait case. Not a real product doc._

## Intent

The to-do list the Escalation Watcher automation (Escalate Ticket, in the next slice) reads to
decide which open tickets still need escalating.

## Trigger & Actor

n/a — this slice has no command, only the read model an automation watches.

## Read Model / View

- **View:** `Tickets Awaiting Escalation` built from events: "Ticket Opened"

| Field | Source / Notes |
|---|---|
| `ticketId` | copied from `Ticket Opened.ticketId` |
| `subject` | copied from `Ticket Opened.subject` |

- **Consumed by:** the Escalation Watcher processor (Escalate Ticket slice).
- **Freshness / consistency expectation:** real-time — the automation must see a ticket as soon
  as it's opened.

## Implementation note (idiom, not drift)

This view has **no materialized projection table** in the toy codebase. The code
(`repo/src/support/escalation/EscalationWatcher.ts`) is a direct `@EventHandler` on `Ticket
Opened` that keeps a criteria-sourced, in-memory `EscalationCandidate` state entity — exactly
the idiom `reference/conform.md` names under "Legitimate non-materialized views": *"an
automation's watched view may have no materialized projection in code — a direct event handler
with criteria-sourced state is the same pattern expressed in the code idiom. That is NOT
structural drift."*

This is the fixture's seeded FALSE-POSITIVE BAIT (GH #452, case d): a conform run that proposes
"add a `TicketsAwaitingEscalation` projection/table — one is missing" against this slice is
wrong. The correct classification is **no finding at all** (the idiom note, not a report).

## Open Questions
- none.
