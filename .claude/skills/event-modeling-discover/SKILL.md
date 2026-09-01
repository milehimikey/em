---
name: event-modeling-discover
em-version: 1.9.1
description: >-
  Use when starting a brand-new event model from scratch — greenfield discovery: brainstorming
  past-tense events, storyboarding the happy path, finding the commands and read models — or when
  extracting a current-state model from an EXISTING codebase or system (event-driven or
  procedural). Drives `em`'s discover and extract phases; produces a draft or as-is `.em` model
  ready for the model/slice phases (`event-modeling-design`).
---

# Event Modeling — discover & extract

You are facilitating the start of an Event Modeling session. Your job is to **extract an
accurate model from the user through Socratic questioning** — never to invent the domain. You
drive the `em` CLI to render the model live.

Read `../event-modeling-shared/reference/operating-principles.md` (preconditions, project
layout, the Socratic/validation discipline every phase follows) and
`../event-modeling-shared/reference/methodology.md` (the 7 steps + 4 patterns) before doing real
work — they are the source of truth. Run the preconditions there first.

**Existing system?** Use the `extract` phase below. **New feature inside an existing codebase,
not a whole-system extraction?** Stay in `discover`, but before locking in command/event names,
Grep/Read adjacent real sources (OpenAPI specs, DB migrations, existing DTOs/event classes in
sibling contexts) rather than guessing conventions — same check the `slice` phase applies to
field tables (`event-modeling-design`).

## Phase: `discover` — steps 1-4

Goal: a draft model of events, storyboard, commands, and views. Loose is OK; structure comes next.

1. **Brainstorm events (step 1).** Ask the user to name everything that happens, as past-tense
   facts. Probe for missed state changes. For each candidate, apply the **"is it an event?"
   test** (`methodology.md` step 1 — the "would this wake the CEO at 3am" heuristic):
   reject derived values (belong in a read model) and telemetry/activity (not business state).
   Don't silently drop rejections — park them in the state file's Decisions log with why, so
   they aren't re-proposed later. Capture the survivors as a flat list.
2. **Plot / storyboard (step 2).** Order the events into the narrative. Identify **personas**
   (actors) and the **UI** screens at each step. Add `persona` declarations and `ui` elements.
   In a **headless/API** model there are no human personas or screens — identify the external
   **callers** at each step instead; declare one persona per caller/role, and its `ui` boxes are
   the API calls (see `methodology.md`).
3. **Inputs (step 3).** For each event, find the **command** that causes it (imperative name).
   Form `command → event` slices (State Change pattern). Every command needs a **trigger** in the
   same breath: the screen the user issues it from (a `ui` in the slice), or — for the Automation
   and Translation patterns — the reaction that triggers it, also in this slice. A command
   nothing points at is a write nobody can start. *"Who does this, and where are they when they
   do it?"*
4. **Outputs (step 4).** Identify the **read models / views** consumers need and wire them with
   `from "Event"` (State View pattern), each with the screen (or reaction) that consumes it — a
   read model nothing displays is information dropped on the floor. In a **headless/API** model
   the consumer is the caller persona's `ui` (the API query) — same as any screen. Read models are
   **repeated** in each slice where they're read (use `view X again` after the first, each instance
   with its own consumer) so the timeline flows (see `methodology.md`).
   **Close the loop before leaving this step:** every event from step 3 must be read by at least one
   read model. Walk the event list and ask, for each one, *"who looks at this, and what do they do
   with it?"* An event with no answer is either missing its read model or shouldn't be recorded —
   both are worth raising with the user rather than leaving dangling.

End of phase: write/refresh the `.em`, render it, update `.event-modeling.md` (steps done,
decisions, open questions — run `em state set-phase model` rather than hand-editing `Current
phase:`), and run `em slice index <model-name>.em` to seed `README.md`'s Slices table (every
slice already reads "no doc yet" — no slice docs exist until the `slice` phase writes them).
Tell the user they can stop here and resume with `/event-modeling` (or invoke
`event-modeling-design` directly).

## Phase: `extract` — current-state model of an existing system

Goal: a faithful **current-state** model extracted from an existing system — the as-is sibling
of `discover` (it replaces discover; the model then proceeds to `model` as usual, in
`event-modeling-design`).

**Read `reference/extract.md` before doing any extract work** — it carries a stance override
that inverts methodology step 1 (capture how the system behaves *today*; never model desired
state).

- Two source modes, detected from the system itself and confirmed with the user:
  **event-driven** (an event vocabulary already exists — schemas, topics, handlers) and
  **procedural/monolith** (no event vocabulary — synthesize candidate events from behavior
  and docs).
- Converge via a ~7-round confirm-and-clarify loop (one concern per round; render from round 2,
  validate from round 4 — see the playbook).
- **Current-state-only:** park unknowns as `# TBD` comments in the `.em`, mirrored in the state
  file's Open Questions — never guess intended design.

End of phase: validated as-is model; state file updated (source mode, rounds, decisions; `em
state set-phase model` for `Current phase:`); run `em slice index <model-name>.em` to seed
`README.md`'s Slices table; then hand off to `event-modeling-design` (steps 5-7).
