---
name: event-modeling
description: >-
  Guide a user and their team through building rigorous Event Models with the `em` CLI, using
  the 7 steps of Event Modeling and the 4 patterns (State Change, State View, Automation,
  Translation), and produce implementation-ready slice design documents. Use when the user wants
  to event-model a business process or system, do event modeling / event storming, design slices,
  build or edit an `.em` model, run the em tool, extract / reverse-engineer a current-state
  event model from an existing system or codebase (event-driven or legacy/procedural), or check
  a ratified model for drift against the codebase that implements it. Works in resumable phases
  via an argument: `discover` (steps 1-4, greenfield), `extract` (current-state model of an
  existing system), `model` (steps 5-7), `slice` (deep slice specs), `conform` (drift check
  against the codebase), plus `watch` and `validate`. With no argument it resumes from the saved
  state file.
---

# Event Modeling with `em`

You are facilitating an Event Modeling session. Your job is to **extract an accurate model from
the user through Socratic questioning** — never to invent the domain. You drive the `em` CLI to
render the model live, and you produce implementation-ready slice design docs.

Read `reference/methodology.md` (the 7 steps + 4 patterns) and `reference/em-dsl.md` (DSL syntax and
validation rules) before doing real work — they are the source of truth. Templates live in
`templates/`.

## Operating principles (every phase)

- **Socratic, one question at a time.** Ask focused questions; use `AskUserQuestion` for tight
  multiple-choice decisions. Never assume a domain fact — extract it. Prefer "who/why/what-if/
  what-must-always-be-true/how-do-you-know" over yes-no.
- **Don't guess — park it.** Unresolved items go into the Open Questions list in
  `.event-modeling.md`, not into invented model content. Note the source, blocker, and revisit
  date when known — cheap now, useful when you come back to it.
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
- **Headless/API models still use `ui`.** If the system is headless (clients call an API, not
  screens), declare a persona per external caller/role (e.g. `IntegratorAPI`) and treat its `ui`
  boxes as API calls, not screens: writes are `ui → command → event` and reads are
  `read model → ui`, exactly like any other State Change/State View slice — no separate trigger
  slice. `translation` stays reserved for genuine reactions and real external-system boundaries,
  not a synchronous request/response call. Internal-only commands/views with no public route carry
  no `ui` at all — they follow the ordinary Automation pattern instead. **Repeat read models**
  across slices so the timeline flows left-to-right — put each repeat **right after the event that feeds it**, sourcing
  only that one adjacent event, so every arrow is short (a read model far from its source events
  draws a long arrow whose head lands columns away, making the *write* slice read as dangling —
  keep a sub-flow that detours into another context together, not parked at the end of the model).
  Declare every instance after the first with
  **`view X again from "..."`** — `again` instances are exempt from the duplicate-name warning even
  when referenced, and each reference resolves to the right instance. Slice order matters: a
  reaction must be directly followed by its command slice, and a read slice must not be immediately
  followed by a command slice (see `em-dsl.md`).
  See `reference/methodology.md` (State View) and `reference/em-dsl.md`.
- **Never connect two instances of one read model.** The repeat is a timeline device, not a flow:
  continuity is implied by the shared name, and the events arriving at each instance are what show
  it changing. An arrow between instances says the read model feeds itself, and is an error.
- **Every slice is a COMPLETE pattern, never a half-slice.** A State Change is
  `ui → command → event`; a State View is `event → read model → ui` (or `→ reaction`). So: a
  command needs something that **triggers** it (the `ui` it's issued from, or the reaction in the
  slice before it), its event needs a **reader**, and that read model needs a **consumer** of its
  own. A command nothing points at is a write nobody can start; an event nothing projects is a
  write nobody can see; a read model nothing displays is information dropped on the floor. Write
  the whole chain together rather than sweeping up dangling ends later. Reactions don't count as
  readers of *events* — they read views. **Every instance** of a repeated read model needs its own
  consumer: if you repeat a view next to an event just to keep the arrow short, bring its screen
  along, or don't add the instance.
- **Only six connections are legal:** `ui → command`, `command → event`, `event → read model`,
  `read model → ui`, `read model → reaction`, `reaction → command`. Reaching for anything else —
  above all `command → read model` (the CQRS violation) or `read model → command` — means the model
  is missing an **element**, not an arrow.
- **Validate continuously.** Run `em validate` and fix errors/warnings as you go (see DSL ref).
- **Save state at the end of every session** so work resumes cleanly. Also append one line to
  the Usage log: the phase(s) touched and the `em validate` diagnostic *categories* that fired
  (rule name only, e.g. "read model nothing consumes" — never the full message or domain
  content). This is the team's only usage signal today (`docs/usage-data.md`) — keep it cheap
  and habitual, not a task to skip.

## Preconditions (run first)

1. Check the tool: `em --version`. If missing, tell the user to run `npm i -g @milehimikey/em`
   and stop until installed.
2. Locate the model. Look for an existing `<dir>/.event-modeling.md` and `*.em` in the working
   directory (or a `models/` subfolder). If found, read the state file. If not, and the phase
   needs one, ask the user for the model name and where to create it.
3. Parse the argument (`$ARGUMENTS`) to pick the phase below. With **no argument**, read the
   state file and resume the recorded phase/step; if no model exists, propose starting `discover`
   (greenfield) or `extract` (modeling an existing system).
4. Populate the state file's Participants section at session start. For a live workshop, ask for
   a single human proxy to relay questions to the room, and attribute every answer/decision in
   the Decisions log to a named participant.

## Project layout this skill creates

```
<model-name>/
  <model-name>.em          # the model (slice docs linked via note "...")
  <model-name>.svg         # render target for em watch
  live.html                # file:// auto-refresh viewer (copy of templates/live.html, verbatim)
  README.md                # overview + slice index (from templates/model-readme.md)
  .event-modeling.md       # resumable state (from templates/state.md)
  slices/<slice-name>.md   # one rich slice doc per slice (from templates/slice.md)
  conformance/<date>-report.md
                           # conform-phase reports (from templates/conformance-report.md)
  <model-name>-asis.em     # conform-phase scratch model, regenerated per run — git-ignore this
```

When creating a new model, scaffold the directory and copy the templates in (filling the
placeholders). Copy `live.html` **verbatim** — it takes the SVG name from its URL query
(`live.html?svg=<model-name>.svg`), so there's nothing to edit. You may use `em init` for a
starter `.em`, but usually you'll build it up from the discovery conversation instead. Fill
template placeholders — never leave `{{...}}` in delivered files. The `conformance/` directory
and `<model-name>-asis.em` only appear once the `conform` phase runs; add the pattern `*-asis.em`
to the repository's `.gitignore` the first time one is created (see `reference/conform.md`) —
it's scratch, never committed.

---

## Phase: `discover` — steps 1-4

Goal: a draft model of events, storyboard, commands, and views. Loose is OK; structure comes next.
**Existing system?** Use `extract` instead (next section) — discover is for greenfield modeling.
**New feature inside an existing codebase?** Stay in `discover`, but before locking in
command/event names, Grep/Read adjacent real sources (OpenAPI specs, DB migrations, existing
DTOs/event classes in sibling contexts) rather than guessing conventions — same check `slice`
phase applies to field tables, below.

1. **Brainstorm events (step 1).** Ask the user to name everything that happens, as past-tense
   facts. Probe for missed state changes. For each candidate, apply the **"is it an event?"
   test** (`reference/methodology.md` step 1 — the "would this wake the CEO at 3am" heuristic):
   reject derived values (belong in a read model) and telemetry/activity (not business state).
   Don't silently drop rejections — park them in the state file's Decisions log with why, so
   they aren't re-proposed later. Capture the survivors as a flat list.
2. **Plot / storyboard (step 2).** Order the events into the narrative. Identify **personas**
   (actors) and the **UI** screens at each step. Add `persona` declarations and `ui` elements.
   In a **headless/API** model there are no human personas or screens — identify the external
   **callers** at each step instead; declare one persona per caller/role, and its `ui` boxes are
   the API calls (see `reference/methodology.md`).
3. **Inputs (step 3).** For each event, find the **command** that causes it (imperative name).
   Form `command → event` slices (State Change pattern). Every command needs a **trigger** in the
   same breath: the screen the user issues it from (a `ui` in the slice), or — for the Automation
   and Translation patterns — the reaction in the slice before it. A command nothing points at is
   a write nobody can start. *"Who does this, and where are they when they do it?"*
4. **Outputs (step 4).** Identify the **read models / views** consumers need and wire them with
   `from "Event"` (State View pattern), each with the screen (or reaction) that consumes it — a
   read model nothing displays is information dropped on the floor. In a **headless/API** model
   the consumer is the caller persona's `ui` (the API query) — same as any screen. Read models are
   **repeated** in each slice where they're read (use `view X again` after the first, each instance
   with its own consumer) so the timeline flows (see `reference/methodology.md`).
   **Close the loop before leaving this step:** every event from step 3 must be read by at least one
   read model. Walk the event list and ask, for each one, *"who looks at this, and what do they do
   with it?"* An event with no answer is either missing its read model or shouldn't be recorded —
   both are worth raising with the user rather than leaving dangling.

End of phase: write/refresh the `.em`, render it, update `.event-modeling.md` (steps done,
decisions, open questions) and `README.md`'s slice index. Tell the user they can stop here and
resume with `/event-modeling model`.

## Phase: `extract` — current-state model of an existing system

Goal: a faithful **current-state** model extracted from an existing system — the as-is sibling
of `discover` (it replaces discover; the model then proceeds to `model` as usual).

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

End of phase: validated as-is model; state file updated (source mode, rounds, decisions) and
`README.md`'s slice index seeded; then chain to `/event-modeling model` (steps 5-7).

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
3. **Evaluate completeness (step 7).** Walk the model: every slice is a **complete** pattern, not a
   half-slice — **every command has something that triggers it**, every command emits an event,
   **every event is read by a read model**, **every read model has a consumer**, every view has a
   source, every UI is reachable, every connection is
   one of the six legal pairs, and automations **and translations** split correctly (each reaction
   triggers a command — none wired straight to an event). Run `em validate` and resolve all errors
   and warnings — but check the reaction→command→event split by hand, since `em validate` does
   **not** flag a translation/automation that emits an event directly (see `reference/em-dsl.md`).
   For an unread event, don't just bolt on a view to silence the warning: ask the user who looks at
   this fact and what they do with it. The honest answers are "here's the read model we missed" or
   "nobody — so why are we recording it", and both improve the model.

End of phase: render, update state, suggest `/event-modeling slice` to write implementation specs.

## Phase: `slice` — deep slice documents

Goal: implementation-ready specs. Go slice by slice (let the user pick order, or follow the
timeline). Check `README.md`'s slice index for what's already done.

This is also where **branch / unhappy-path events** are discovered and added to the model — as a
slice's alternate/error flows surface (a rejection, removal, cancellation, decline, expiry), add
the corresponding event/slice to the `.em` and re-render. The happy-path spine from earlier
phases is the starting point, not the finished event set. **Every new event needs its reader too**
— a rejection or cancellation that nothing projects will warn, and usually the missing piece is
real (someone has to see that the request was declined).

For each slice:
0. **Check for re-ratification first.** If `slices/<slice-name>.md` already exists with
   `status: implemented`, this is a re-ratification, not fresh authoring: hold a Socratic
   deep-dive on what changed (same rigor as step 1, scoped to the delta), update whichever
   sections actually changed, then express the change as the `## Delta` section — fixed heading,
   `### Added`/`Modified`/`Removed`/`Renamed` Requirement blocks each carrying its own scenarios
   (see `templates/slice.md` and `docs/slice-doc-schema.md#delta-section-grammar-and-lifecycle`)
   — **overwriting** whatever the section held before, never appending to it. Then continue at
   step 2 to bump `version` and flip `status` back to `ready-to-implement`, leaving
   `implementedIn` naming the prior version's PR (intended drift signal, not a bug — see the
   schema doc). Otherwise, this is first-time authoring: continue at step 1.
1. Hold a Socratic deep-dive to fill every section of `templates/slice.md`: intent, trigger/actor,
   command + field table (types & rules), event(s) + payload (mark immutable facts), invariants
   (give each a stable ID), Given/When/Then scenarios (happy path + rule boundaries + edge cases),
   alternate/error flows (retries, idempotency, compensations), non-functional requirements
   (security/authz, PII/compliance, performance/SLA), read models affected, open questions. Park
   anything unresolved rather than guessing. If the slice lives in an existing codebase, Grep/Read
   adjacent real sources (OpenAPI specs, DB migrations, existing DTOs/event classes in sibling
   contexts) before finalizing field names/types or invariants — don't guess a shape that's
   already defined elsewhere.
2. Write the doc to `slices/<slice-name>.md` (kebab-case the slice name), with the YAML
   frontmatter block (`pattern`/`swimlane`/`status`/`version`/`implementedIn`, kebab-case
   `pattern` value, `version` starting at `1`) at the very top — the canonical, machine-read
   metadata dialect (`- **Status:** ...` bullet lines are legacy/accepted input only; never
   write new docs that way). When this doc exists because of a split, merge, or rename, add the
   matching lineage key(s) too (`split-from`/`merged-from`/`superseded-by`, `<slice-key>@v<N>`
   grammar — see `docs/slice-doc-schema.md` for the full schema). On a re-ratification (step 0),
   bump `version` and flip `status` here instead of setting them fresh. Record the originating
   need (ticket/conversation link) in the Intent section when one exists.
3. Render the slice's own diagram: `em render <model>.em --slice "<slice name>" -o
   slices/<slice-name>.svg` (kebab-case, matching the doc's filename) — redraws just this slice
   in its own canonical pattern shape, and add `![Diagram](./<slice-name>.svg)` near the top of
   the doc, right after the `# Slice:` heading (below the frontmatter block).
4. Wire it into the `.em`: add `note "slices/<slice-name>.md"` to the slice's primary element
   (the command for State Change, the view for State View, the processor for Automation, the
   translation for Translation).
5. Update `README.md`'s slice index — the one canonical slice table (`draft` →
   `ready-to-implement`, later `implemented` once shipped, with `Implemented in:` filled in).
6. Re-render and `em validate`.

## Phase: `conform` — drift check against the codebase

Goal: check a **ratified** model (and its slice docs) against the codebase that implements it,
and report where they've drifted — advisory only, never a gate, never an unprompted edit.

**Read `reference/conform.md` before doing any conform work** — it carries the full flow
(scope, evidence-first verification, `em diff --json`, classification, report) and the
stance guardrails (evidence-first, uncertainty is never drift, propose-don't-edit). It reuses
`extract`'s sourcing/mode rules for reading the target codebase rather than duplicating them.

In short: for each in-scope slice, gather code evidence *before* comparing to the model or doc;
write the as-is picture into a scratch model (`<model-name>-asis.em`, reusing the canonical
model's names wherever the code matches them); run `em diff <model-name>.em
<model-name>-asis.em --json` and let `em` decide the structural deltas; classify every finding
(real drift / model gap / internal inconsistency / uncertainty) with cited evidence; write
`conformance/<date>-report.md` with proposed `issue "conformance: …"` red notes; apply only the
proposals the user ratifies, then re-render and validate; update the state file's
`Last conformance:` marker.

End of phase: state file's `Last conformance:` marker updated, Decisions log entry if any
proposals were applied. Conform doesn't chain to another phase — it's a recurring loop, run
again whenever the codebase has moved.

## Phase: `watch` — live team view

**Recommended (instant push, no polling):** start the watcher with `--serve` in the background:
`em watch <model-name>.em -o <model-name>.svg --serve` (run_in_background). It re-renders on every
save and pushes an instant reload to the browser over Server-Sent Events. Tell the user to open the
URL it prints (e.g. `http://localhost:5173/?svg=<model-name>.svg`) and share their screen — updates
appear the moment you save, with no idle churn between edits.

**No-server fallback (`file://`):** if the user prefers not to run a server, start the plain watcher
`em watch <model-name>.em -o <model-name>.svg` (run_in_background) and have them open the copied
`live.html?svg=<model-name>.svg` in a browser. It polls every ~2s and reloads without flicker. No
editing of `live.html` is needed — the `?svg=` query picks the model.

## Phase: `review` — stakeholder walkthrough

Goal: step a real stakeholder review session through the model slice by slice, one slice
spotlighted at a time, with any open questions the room raises captured live as `issue "..."`
red notes.

**Trigger: a real stakeholder review session is on the calendar — a scheduled use, not
speculation.** Don't propose this phase proactively; it exists for facilitated reviews with
non-engineer stakeholders in the room, not routine model editing.

Start the same live server as `watch`: `em watch <model-name>.em -o <model-name>.svg --serve`
(run_in_background). Open the printed URL, click **Review mode** in the header, and share the
screen. Use Prev/Next (or the left/right arrow keys) to step through slices in declaration
order — each one pans/zooms into view with everything else dimmed, so the room's attention
tracks one slice at a time.

**Live capture:** when a stakeholder raises something unresolved, add `issue "..."` to the
relevant element in the `.em` file and save — exactly the same mechanism as any other issue
(see `validate` below). The browser updates over the existing SSE push within moments, without
losing the current slice or resetting review mode.

Wrap-up: run `em validate --list-issues` to sweep everything captured during the session and
walk each one with the user, same as any open issue. Update the state file's Participants
section with who attended, and set a `Last stakeholder review:` marker (mirrors `Last
conformance:`).

End of phase: state file's `Last stakeholder review:` marker updated, every issue captured
live triaged (resolved on the spot, moved to Open questions / parking lot, or left open on
purpose). Review doesn't chain to another phase — it's a recurring, scheduled activity like
`conform`, not a step in the discover → model → slice sequence.

## Phase: `validate`

Run `em validate <model-name>.em` and walk through each diagnostic with the user, explaining the
rule (see `reference/em-dsl.md`) and proposing the fix. Apply fixes on agreement. Common ones:

| Diagnostic | Fix |
|---|---|
| automation/translation shares a slice with a command | Split the command into the next slice |
| **command has nothing that triggers it** | Add the `ui` it's issued from — or, if the system issues it, the reaction in the slice before it. Ask *"who does this, and where are they when they do it?"* |
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

Then do one check `em validate` can't: scan every `translation`/`processor`/`automation` slice and
confirm none contains an `event` — each reaction must trigger a `command` in the next slice
(`reaction → command → event`). If you find a reaction wired straight to an event, split it into
two slices and route it through a command.

---

## em command reference (quick)

<!-- GENERATED:cli-quick:start -- run `npm run docs:generate` to refresh, do not hand-edit -->
```bash
em --version
em init <name>.em                          # optional starter scaffold
em validate <name>.em                      # check rules; exit 0 if clean/warnings only
em render <name>.em -o <name>.svg          # render (svg/png/pdf by extension)
em render <name>.em --emit-dot             # inspect generated Graphviz DOT
em render <name>.em --slice "<slice-name>" -o slices/<slug>.svg   # this slice's own diagram
em watch <name>.em -o <name>.svg           # re-render on save (run in background)
em watch <name>.em -o <name>.svg --serve   # + live viewer with instant push-reload (--port N)
                                            #   click "Review mode" for a slice-by-slice storyboard walkthrough
```
<!-- GENERATED:cli-quick:end -->

Always finish a working session by: re-rendering, running `em validate`, and updating
`.event-modeling.md` with the current phase/step, decisions, open questions, and a Usage log
entry (phases touched + validate diagnostic categories hit).
