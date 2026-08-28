---
name: event-modeling-conform
em-version: 1.8.1
description: >-
  Use when checking a ratified event model (and its slice docs) for drift against the codebase
  that implements it — advisory only, never a gate, never an unprompted edit — or when walking
  `em validate` diagnostics on a model to explain and fix rule violations. Drives `em`'s conform
  and validate phases.
---

# Event Modeling — conform & validate

## Phase: `conform` — drift check against the codebase

Goal: check a **ratified** model (and its slice docs) against the codebase that implements it,
and report where they've drifted — advisory only, never a gate, never an unprompted edit.

Preconditions (tool check, model location) are the same as every other phase — see
`../event-modeling-shared/reference/operating-principles.md`.

**Read `reference/conform.md` before doing any conform work** — it carries the full flow
(scope, evidence-first verification, `em diff --json`, classification, report) and the
stance guardrails (evidence-first, uncertainty is never drift, propose-don't-edit). It reuses
the `event-modeling-discover` skill's `extract` sourcing/mode rules
(`../event-modeling-discover/reference/extract.md`) for reading the target codebase rather than
duplicating them.

In short: run `em conform-scope <model-name>.em --repo <target-repo-path> --seed-asis` to
compute the in-scope slice set (diff-scoped by default, via `Last conformance:` + the target
repo's changed paths mapped through each slice doc's `implementedIn:`) and seed the scratch
model in one step; for each in-scope slice, gather code evidence *before* comparing to the model
or doc; write the as-is picture into that scratch model (`<model-name>-asis.em`, reusing the
canonical model's names wherever the code matches them); run `em diff <model-name>.em
<model-name>-asis.em --json` and let `em` decide the structural deltas; classify every finding
(real drift / model gap / internal inconsistency / uncertainty) with cited evidence; write
`conformance/<date>-report.md` with proposed `issue "conformance: …"` red notes; apply only the
proposals the user ratifies, then re-render and validate; run `em state set-conformance
<revision> --report <path>` to update the state file's `Last conformance:` marker.

End of phase: state file's `Last conformance:` marker updated (via `em state set-conformance`),
Decisions log entry if any
proposals were applied. Conform doesn't chain to another phase — it's a recurring loop, run
again whenever the codebase has moved.

## Phase: `validate`

Run `em validate <model-name>.em` and walk through each diagnostic with the user, explaining the
rule (see `../event-modeling-shared/reference/em-dsl.md`) and proposing the fix. Apply fixes on
agreement. Common ones:

| Diagnostic | Fix |
|---|---|
| reaction triggers no command | Add the command it issues, in this same slice, or an explicit `arrow` to one elsewhere |
| **command has nothing that triggers it** | Add the `ui` it's issued from — or, if the system issues it, the reaction that triggers it, also in this slice. Ask *"who does this, and where are they when they do it?"* |
| **read model has no consumer** | Add the screen that displays it, or the reaction that watches it. If it's a repeat added only to shorten an arrow and nothing looks at it there, drop the instance |
| read model has no source | Add the missing `from "Event"` |
| command produces no event | Give the command its event, or drop the command |
| **event is not read by any read model** | Add the read slice that projects it — but ask *who looks at this and what do they do with it* first. "Nobody" is a real answer, and then the question is why it's recorded at all |
| **illegal `arrow` kind pair** | Don't reroute it — the model is missing an element. `command → view` needs the event between them; `view → command` needs a reaction. Between two instances of one read model, just delete the arrow: the repeat needs no connection |
| `view X again` with no earlier declaration | Declare the view plainly the first time it appears |
| event feeding an earlier view instance | Add a `view X again` where the event lands and move the source there |

For anything genuinely unresolved rather than a rule violation, prefer `issue "text"` on the
relevant element over a `# TBD` comment — it shows up as a red marker on the rendered diagram and
`em validate` tracks it as an open-issue warning, so it isn't lost once rendered. `em validate
--list-issues` gives a quick sweep of everything still open.

`em validate` now catches a reaction wired straight to an event too — any reaction with no
`command` in its own slice, and no explicit arrow to one, warns "triggers no command". A
`translation`/`processor`/`automation` should always trigger a `command` in its own slice
(`reaction → command → event`); if one instead records an event directly, route it through a
command instead.

Validate isn't pinned to this phase alone — every other phase runs it continuously as part of
the shared operating principles (`../event-modeling-shared/reference/operating-principles.md`).
This phase is for a dedicated, focused walkthrough of whatever diagnostics remain, and for the
full rule catalog in `../event-modeling-shared/reference/em-dsl.md`.
