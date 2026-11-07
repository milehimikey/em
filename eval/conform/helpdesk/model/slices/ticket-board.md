---
schemaVersion: 1
pattern: automation
swimlane: Agent → Support
status: implemented
version: 1
implementedIn: src/support/board
---
# Slice: Ticket Board

_Eval fixture (GH #452) — a deliberately tiny implemented slice used to seed the
internal-inconsistency case. Not a real product doc._

## Intent

Agents watch a board of open and escalated tickets.

## Trigger & Actor

n/a — this slice has no command, only the board read model and the screen that shows it.

## Read Model / View

- **View:** `Ticket Board` built from events: "Ticket Opened", "Ticket Escalated"

| Field | Source / Notes |
|---|---|
| `ticketId` | copied from `Ticket Opened.ticketId` / `Ticket Escalated.ticketId` |
| `subject` | copied from `Ticket Opened.subject` |

- **Consumed by:** the Board Page screen (@Agent).
- **Freshness / consistency expectation:** real-time.

## Note for the conform eval (GH #452, case c — internal inconsistency)

This doc's frontmatter says `pattern: automation`. The `.em` model's "Ticket Board" slice has
only a `view` and a `ui` — no command, event, or processor of its own — which
`classifySlicePattern()` (`src/catalog/classify.ts`) classifies as **state-view**, not
automation. `em validate`'s `doc-model-pattern-mismatch` diagnostic (always-on, no flag needed)
fires on exactly this disagreement. Neither side is "the code" here — the doc and the `.em`
disagree with EACH OTHER — so a correct conform run classifies this **Internal inconsistency**
(surface: internal), not Real drift or a Model gap, and does not guess which side is stale.

## Open Questions
- none.
