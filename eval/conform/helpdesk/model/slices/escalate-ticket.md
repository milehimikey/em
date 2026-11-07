---
schemaVersion: 1
pattern: automation
swimlane: Agent → Support
status: implemented
version: 1
implementedIn: src/support/escalation
---
# Slice: Escalate Ticket

_Eval fixture (GH #452) — a deliberately tiny implemented slice used to seed structural conform
drift. Not a real product doc._

## Intent

A ticket that has sat open too long is escalated automatically so an agent follows up.

## Trigger & Actor

Triggered by the Escalation Watcher processor reading the Tickets Awaiting Escalation view
(internally triggered — the processor decides on its own read-model state, not an external
system).

## Command / Input

**Command:** `Escalate Ticket` — fields `ticketId`, `escalatedOn`.

## Event(s) Emitted

Records `Ticket Escalated` (context Support) with `ticketId`, `escalatedOn`. Read by the
**Ticket Board** view.

## Invariants / Business Rules
- none named for this slice.

## Scenarios (Given / When / Then)

### Scenario: Watcher escalates an overdue ticket
- **Given:**
  - `Ticket Opened` was recorded and the ticket is still on the Tickets Awaiting Escalation list
- **When:**
  - the Escalation Watcher issues `Escalate Ticket`
- **Then:**
  - `Ticket Escalated` is recorded

## Alternate & Error Flows
- none.

## Non-Functional Requirements
- **Security / authz:** system-triggered, no end-user authz.
- **PII & compliance:** none.
- **Performance / SLA:** none.

## Dependencies & Read Models Affected
- **Upstream events this slice relies on:** `Ticket Opened` (via the Tickets Awaiting
  Escalation view).
- **Downstream read models / slices affected:** Ticket Board.

## Open Questions
- none.

## Note for the conform eval (GH #452, case a — structural drift)

The model's `Ticket Escalated` event has exactly two fields: `ticketId`, `escalatedOn`. At the
fixture's HEAD revision, the toy codebase's event
(`repo-head/src/support/escalation/EscalateTicketHandler.ts`, overlaid onto
`repo/src/support/escalation/EscalateTicketHandler.ts` by `eval/conform/helpdesk/setup.mjs`)
carries a third field, `escalationReason`, that neither this doc nor the `.em` declares. This is
the one seed that lands on a changed path between the fixture's two commits, so the
diff-scoped `em conform-scope` run (`Last conformance:` pinned to the baseline commit) is the
one that has to find it — see `eval/conform/README.md`.
