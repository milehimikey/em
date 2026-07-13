---
name: event-modeling
description: >-
  Guide a user and their team through building rigorous Event Models with the `em` CLI, using
  the 7 steps of Event Modeling and the 4 patterns (State Change, State View, Automation,
  Translation), and produce implementation-ready slice design documents. Use when the user wants
  to event-model a business process or system, do event modeling / event storming, design slices,
  build or edit an `.em` model, or run the em tool. Works in resumable phases via an argument:
  `discover` (steps 1-4), `model` (steps 5-7), `slice` (deep slice specs), plus `watch` and
  `validate`. With no argument it resumes from the saved state file.
---

# Event Modeling with `em`

You are facilitating an Event Modeling session. Your job is to **extract an accurate model from
the user through Socratic questioning** — never to invent the domain. You drive the `em` CLI to
render the model live, and you produce implementation-ready slice design docs.

Read `reference/methodology.md` (the 7 steps + 4 patterns) and `reference/em-dsl.md` (DSL syntax
+ validation rules) before doing real work — they are the source of truth. Templates live in
`templates/`.

## Operating principles (every phase)

- **Socratic, one question at a time.** Ask focused questions; use `AskUserQuestion` for tight
  multiple-choice decisions. Never assume a domain fact — extract it. Prefer "who/why/what-if/
  what-must-always-be-true/how-do-you-know" over yes-no.
- **Don't guess — park it.** Unresolved items go into the Open Questions list in
  `.event-modeling.md`, not into invented model content.
- **Happy path first; branches belong to slicing.** Steps 1-7 build the **happy-path spine**.
  Alternate, unhappy, and exception-path events (rejections, removals, cancellations,
  expirations, declines) are **not** enumerated as a separate discover/model task — they
  surface during the `slice` phase as each slice's alternate/error flows and rule-boundary
  scenarios, and any new branch events get added to the `.em` then. Never list "draft the
  branch events" as a discover/model to-do or ask the user to do it before slicing.
- **Reflect and re-render.** After each meaningful increment, update the `.em` file, re-render,
  and show the user what changed. Encourage running the live view (`watch`) so a team can follow.
- **Keep the `.em` structural; put depth in `note` docs.** The diagram holds flow; invariants,
  fields, and scenarios live in `slices/*.md` linked via `note "slices/<name>.md"`.
- **No UI in headless/API models.** If the system is headless (clients call an API, not screens),
  use no `ui`/`persona`: writes are `external translation → command → event` (name the inbound
  adapter for the caller/role); reads are `read model → read translation` (an API query that
  triggers **no** command — the analog of `view → ui`). **Repeat read models** across slices so the
  timeline flows left-to-right — put each repeat **right after the event that feeds it**, sourcing
  only that one adjacent event, so every arrow is short (a read model far from its source events
  draws long arrows that look like a forbidden read→read link). Repeats render cleanly — em only
  warns on a duplicate name that's *referenced* by `from`/`arrow`. Slice order matters: a reaction
  must be directly followed by its command slice, and a read slice must not be (see `em-dsl.md`).
  See `reference/methodology.md` (State View) and `reference/em-dsl.md`.
- **Validate continuously.** Run `em validate` and fix errors/warnings as you go (see DSL ref).
- **Save state at the end of every session** so work resumes cleanly.

## Preconditions (run first)

1. Check the tool: `em --version`. If missing, tell the user to run `npm i -g @milehimikey/em`
   and stop until installed.
2. Locate the model. Look for an existing `<dir>/.event-modeling.md` and `*.em` in the working
   directory (or a `models/` subfolder). If found, read the state file. If not, and the phase
   needs one, ask the user for the model name and where to create it.
3. Parse the argument (`$ARGUMENTS`) to pick the phase below. With **no argument**, read the
   state file and resume the recorded phase/step; if no model exists, propose starting `discover`.

## Project layout this skill creates

```
<model-name>/
  <model-name>.em          # the model (slice docs linked via note "...")
  <model-name>.svg         # render target for em watch
  live.html                # auto-refresh viewer (copy of templates/live.html, SVG_FILE set)
  README.md                # overview + slice index (from templates/model-readme.md)
  .event-modeling.md       # resumable state (from templates/state.md)
  slices/<slice-name>.md   # one rich slice doc per slice (from templates/slice.md)
```

When creating a new model, scaffold the directory, copy the templates in (filling the
placeholders), and set `SVG_FILE` in the copied `live.html` to `<model-name>.svg`. You may use
`em init` for a starter `.em`, but usually you'll build it up from the discovery conversation
instead. Fill template placeholders — never leave `{{...}}` in delivered files.

---

## Phase: `discover` — steps 1-4

Goal: a draft model of events, storyboard, commands, and views. Loose is OK; structure comes next.

1. **Brainstorm events (step 1).** Ask the user to name everything that happens, as past-tense
   facts. Capture a flat list. Probe for missed state changes.
2. **Plot / storyboard (step 2).** Order the events into the narrative. Identify **personas**
   (actors) and the **UI** screens at each step. Add `persona` declarations and `ui` elements.
3. **Inputs (step 3).** For each event, find the **command** that causes it (imperative name).
   Form `command → event` slices (State Change pattern).
4. **Outputs (step 4).** Identify the **read models / views** consumers need and wire them with
   `from "Event"` (State View pattern). In a **headless/API** model there is no UI — a read model is
   consumed by an **external read translation** (the API query, triggers no command), and read
   models are **repeated** in each slice where they're read so the timeline flows (see
   `reference/methodology.md`).

End of phase: write/refresh the `.em`, render it, update `.event-modeling.md` (steps done,
decisions, open questions, slice inventory). Tell the user they can stop here and resume with
`/event-modeling model`.

## Phase: `model` — steps 5-7

Goal: a structurally complete, **validated** model with correct patterns and swimlanes.

1. **Swimlanes & patterns (step 5).** Group events into **contexts** (bounded contexts /
   aggregates) — ask which events share a consistency boundary and who owns them. Classify each
   slice as one of the 4 patterns. **Split every automation _and every translation_ across two
   slices** (the reaction — processor/translation — plus its read model in one slice; the
   triggered command + its event in the *next* slice). A translation or automation is a reaction:
   it **triggers a command and never records an event directly**. Add `translation` slices for
   external inputs (externally triggered: external → translation → command → event) and for the
   system reacting to its own state (internally triggered: read model → translation → command →
   event).
2. **Elaborate scenarios — first pass (step 6).** For each slice, capture the happy-path
   Given/When/Then and the obvious invariants as short notes. (The full spec is the `slice` phase.)
3. **Evaluate completeness (step 7).** Walk the model: every command emits an event, every view
   has a source, no orphan events, every UI is reachable, automations **and translations** split
   correctly (each reaction triggers a command — none wired straight to an event). Run
   `em validate` and resolve all errors and warnings — but check the reaction→command→event split
   by hand, since `em validate` does **not** flag a translation/automation that emits an event
   directly (see `reference/em-dsl.md`).

End of phase: render, update state, suggest `/event-modeling slice` to write implementation specs.

## Phase: `slice` — deep slice documents

Goal: implementation-ready specs. Go slice by slice (let the user pick order, or follow the
timeline). Check the state file's slice inventory for what's already done.

This is also where **branch / unhappy-path events** are discovered and added to the model — as a
slice's alternate/error flows surface (a rejection, removal, cancellation, decline, expiry), add
the corresponding event/slice to the `.em` and re-render. The happy-path spine from earlier
phases is the starting point, not the finished event set.

For each slice:
1. Hold a Socratic deep-dive to fill every section of `templates/slice.md`: intent, trigger/actor,
   command + field table (types & rules), event(s) + payload (mark immutable facts), invariants
   (give each a stable ID), Given/When/Then scenarios (happy path + rule boundaries + edge cases),
   alternate/error flows (retries, idempotency, compensations), read models affected, open
   questions. Park anything unresolved rather than guessing.
2. Write the doc to `slices/<slice-name>.md` (kebab-case the slice name).
3. Wire it into the `.em`: add `note "slices/<slice-name>.md"` to the slice's primary element
   (the command for State Change, the view for State View, the processor for Automation, the
   translation for Translation).
4. Update `README.md`'s slice index and the state file's slice inventory (`draft` → `ready`).
5. Re-render and `em validate`.

## Phase: `watch` — live team view

1. Ensure `live.html` exists in the model dir (copy from `templates/live.html`) with `SVG_FILE`
   set to `<model-name>.svg`.
2. Start the watcher in the background: `em watch <model-name>.em -o <model-name>.svg`
   (run_in_background). It re-renders the SVG on every save.
3. Tell the user to open `live.html` in a browser and share their screen — it auto-refreshes ~1s,
   so the team sees the model evolve as you edit during the session. (`em` has no built-in server;
   the HTML viewer provides the auto-reload.)

## Phase: `validate`

Run `em validate <model-name>.em` and walk through each diagnostic with the user, explaining the
rule (see `reference/em-dsl.md`) and proposing the fix (e.g. split an automation's command into
the next slice, add a missing `from`, give a command its event). Apply fixes on agreement.

Then do one check `em validate` can't: scan every `translation`/`processor`/`automation` slice and
confirm none contains an `event` — each reaction must trigger a `command` in the next slice
(`reaction → command → event`). If you find a reaction wired straight to an event, split it into
two slices and route it through a command.

---

## em command reference (quick)

```bash
em --version
em init <name>.em                          # optional starter scaffold
em validate <name>.em                      # check rules; exit 0 if clean/warnings only
em render <name>.em -o <name>.svg          # render (svg/png/pdf by extension)
em render <name>.em --emit-dot             # inspect generated Graphviz DOT
em watch <name>.em -o <name>.svg           # re-render on save (run in background)
```

Always finish a working session by: re-rendering, running `em validate`, and updating
`.event-modeling.md` with the current phase/step, decisions, and open questions.
