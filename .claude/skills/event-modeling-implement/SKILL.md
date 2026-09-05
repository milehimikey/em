---
name: event-modeling-implement
em-version: 1.10.0
description: >-
  Use when building a single ratified event-modeling slice (status: ready-to-implement) into
  merged, tested code — the one phase where the agent builds rather than facilitates. Gates on
  readiness, treats the slice doc as the read-only spec, surfaces gaps instead of deciding them
  silently, and requires tests traceable to the doc's invariants and scenarios.
---

# Event Modeling — implement

Goal: turn a single `ready-to-implement` slice into merged, verified code — the one phase where
the agent builds rather than facilitates.

**Read `reference/implement.md` before doing any implement work and follow it as the
contract.** In short: gate on `em validate <model>.em --slice-ready <key>` (stop and hand
back if it fails — never edit the doc to make the gate pass); treat the slice doc as the
spec (read-only, except the merge-time `status`/`implementedIn` flip); surface every gap to
the user instead of deciding it silently; cover every `INV-<MNEMONIC>-n` and every scenario with
tests; in spec-kit projects, allocate via em-sdd-bridge (redirect mode) and never run
`/speckit.specify`.

That contract applies to any implementing agent, whether or not the session started from
`/event-modeling` — `em contract` prints it to stdout with no `.claude/` awareness required, for
an agent that can run a shell but isn't Claude Code.

If the project ships pattern-specific implementation skills (for example an Axon/DCB skill set
keyed on a slice doc's `pattern:` frontmatter), route by the slice's pattern and follow those —
`reference/implement.md` §2 explains where that hand-off happens.

Preconditions (tool check, model location) are the same as every other phase — see
`../event-modeling-shared/reference/operating-principles.md` — but this phase additionally
requires the target slice to already be ratified; if it isn't, stop and say so rather than
starting on unratified work.

End of phase: PR merged, slice doc flipped to `status: implemented` with `implementedIn`
filled, `em slice index <model-name>.em` run to refresh `README.md`'s Slices table. Implement
doesn't chain to another phase — run it once per ratified slice; `event-modeling-conform`'s
`conform` phase later checks the result against the model.
