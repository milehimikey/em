---
schemaVersion: 1
pattern: state-change
swimlane: Agent → Support
status: implemented
version: 1
implementedIn: src/support/open-ticket
---
# Slice: Open Ticket

_Eval fixture (GH #452) — a deliberately tiny implemented slice used to seed spec-surface
conform drift. Not a real product doc._

## Intent

An agent opens a new helpdesk ticket for a request that comes in by phone or email.

## Trigger & Actor

Triggered by the New Ticket Form screen (@Agent).

## Command / Input

**Command:** `Open Ticket` — fields `ticketId`, `subject`.

## Event(s) Emitted

Records `Ticket Opened` (context Support) with `ticketId`, `subject`. Read by the **Tickets
Awaiting Escalation** view (feeds the Escalate Ticket automation) and the **Ticket Board** view.

## Invariants / Business Rules

- **INV-OPEN-1:** `subject` must not be empty — an empty subject is rejected with a validation
  error before the event is recorded.
  - This is the fixture's seeded SPEC-surface finding (GH #452, case b): the handler in
    `repo/src/support/open-ticket/OpenTicketHandler.ts` accepts any subject, including an empty
    one, and records `Ticket Opened` regardless — there is no enforcement site for INV-OPEN-1 in
    the toy codebase. A correct conform walk cites the handler file/line as evidence and
    classifies this **Real drift** (surface: spec).

## Scenarios (Given / When / Then)

### Scenario: Agent opens a ticket (INV-OPEN-1)
- **Given:**
  - no prior ticket with this id
- **When:**
  - `Open Ticket` is submitted with a non-empty subject
- **Then:**
  - `Ticket Opened` is recorded

### Scenario: Empty subject is rejected (INV-OPEN-1)
- **Given:**
  - no prior ticket with this id
- **When:**
  - `Open Ticket` is submitted with an empty subject
- **Then:**
  - the command is rejected and no event is recorded
  - _(this is the scenario the seeded code does not actually satisfy — see INV-OPEN-1 above)_

## Alternate & Error Flows
- none beyond INV-OPEN-1's rejection path.

## Non-Functional Requirements
- **Security / authz:** any authenticated agent.
- **PII & compliance:** none.
- **Performance / SLA:** none.

## Dependencies & Read Models Affected
- **Upstream events this slice relies on:** none.
- **Downstream read models / slices affected:** Tickets Awaiting Escalation, Ticket Board.

## Open Questions
- none.
