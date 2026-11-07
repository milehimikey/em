# Helpdesk (toy target repo)

Not a real, buildable project — a tiny pseudocode fixture for `eval/conform/helpdesk`
(em GH #452). It exists only to give an `em conform` walk real files to read.

- `src/support/open-ticket/` — Open Ticket slice. Carries the seeded SPEC-surface drift
  (INV-OPEN-1 claimed, not enforced).
- `src/support/escalation/` — Tickets Awaiting Escalation + Escalate Ticket slices. Carries
  the seeded STRUCTURAL drift (an extra event field, added only at HEAD) and the
  FALSE-POSITIVE-BAIT idiom (a non-materialized watched view).
- `src/support/board/` — Ticket Board slice. No code-side seed; its drift
  (case c, internal inconsistency) is doc-vs-model only.
