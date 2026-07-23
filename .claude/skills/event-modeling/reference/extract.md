# Extract Phase — Current-State Model of an Existing System

Read this **before doing any extract work**. It governs the `extract` phase and **overrides
`methodology.md` step 1's stance** for the duration of extraction: you are capturing how the
system behaves **today**, not modeling what the business needs. Everything else in the
methodology — the 4 patterns, the "is it an event?" test, the Socratic stance, the two-slice
reaction split — still applies.

## Stance override — current-state-only

- Capture the system **as it is**, faithfully, warts included. Never invent future or desired
  state. Improvement ideas that surface go to the state file's Open Questions or Decisions log
  — never into the model.
- Methodology step 1's caution ("model the process the business **needs**, not how the current
  system happens to work — existing system behavior is a common source of fake events") is
  **deliberately suspended**: here the existing system *is* the subject.
- The **"is it an event?" filter still applies.** Derived values (totals, calculated fields)
  and telemetry/activity (clicks, page views, logins) are still not events, even when the
  current system stores or emits them as such. Park each rejection in the Decisions log with
  why, so it isn't re-proposed.
- **Never guess.** Unknown or ambiguous current behavior is parked (see TBD convention below),
  not filled in with what the design "probably" intends.

## Setup

1. Run the SKILL.md preconditions (tool check, model location) and scaffold the standard
   project layout if no model exists yet.
2. **Agree the scope line first**: which system, which part, what's out of bounds. Write it to
   the state file's Session inputs.
3. Record in the state file: `Source mode` (after detection, below) and
   `Existing system refs` — the repo paths, event-schema/topic locations, and docs you will
   extract from.

## Mode detection

Inspect the system with your own tools (Grep/Read over the codebase and docs), then confirm
the mode with the user:

- **Event-driven** — the system already has an event vocabulary. Signals: event
  schemas/classes, topics/streams/queues, message or CDC handlers, an event store, pub/sub
  wiring. Extraction *lifts* the model from that vocabulary.
- **Procedural / monolith** — no event vocabulary. Signals: transaction scripts, service
  methods mutating rows, CRUD controllers, procedural runbooks/docs. Extraction *synthesizes*
  candidate events from the state changes the behavior implies.

Mixed systems happen: pick the dominant mode, note the exception areas in the state file.

## Sourcing by mode

- **Event-driven:** inventory the emitted/consumed event types; take past-tense business facts
  directly; then filter — technical/infrastructure messages (retries, heartbeats, envelope
  wrappers) and derived/telemetry types are dropped (log why). Keep the system's own names
  where they are honest past-tense facts; propose a cleaner past-tense name only when the
  original is technical (record the mapping in the Decisions log).
- **Procedural:** for each significant operation, ask "what business fact has become true when
  this completes?" — those are the candidate events. Screens and tables are *evidence* of
  state changes, not events themselves; a table row's lifecycle (created/updated/closed) often
  implies several events. Apply the event filter hard here — procedural systems are where
  derived values and activity records masquerade as facts.

## The confirm-and-clarify loop (~7 rounds)

One concern per round. After every round: mirror what you extracted back to the user, update
the `.em`, and (from R2) re-render so they see the model grow. Convergence beats coverage —
it is fine to finish a round with `# TBD`s still parked.

- **R1 — Candidate events.** Extract (event-driven) or synthesize (procedural) the past-tense
  facts; apply the event test; user confirms/renames/rejects. Ambiguous candidates → `# TBD`.
- **R2 — Timeline order.** Order the confirmed events into the as-is narrative. Identify the
  *actual* actors/callers and the *real* UI or API surfaces (headless systems: no
  `ui`/`persona` — use write/read translations per `em-dsl.md`). **First `em render` here.**
- **R3 — Commands / inputs.** For each event, the request that actually produces it today
  (imperative name). Unclear trigger → `# TBD`, not a plausible guess.
- **R4 — Read models / outputs.** The projections/queries the system actually serves; wire
  `from "Event"` (repeat read models span-1 per `em-dsl.md`). **Start running `em validate`**
  each round from here.
- **R5 — Boundaries & reactions.** Current automations and integrations as-is: schedulers,
  listeners, outbound syncs, inbound webhooks. Model each as a reaction with the two-slice
  `reaction → command → event` split and the slice-ordering rules in `em-dsl.md` — even when
  the current code wires it as one procedural step (note the as-built shape in the slice's
  `# TBD`/Decisions if it differs).
- **R6 — Gap & TBD reconciliation.** Walk every parked `# TBD` with the user. Resolve only
  what they can confirm **as a current-state fact**; everything else stays parked. Explicitly
  refuse to resolve a TBD by inventing desired behavior.
- **R7 — Convergence.** Final `em render` + `em validate` (fix errors and warnings; remember
  the validator's blind spot — check the reaction split by hand). User confirms the model is a
  faithful picture of today. Mark extraction complete in the state file and hand off.

Seven rounds is the default shape, not a quota — collapse rounds for a small system, repeat
one for a sprawling one. Record any deviation in the Decisions log.

## TBD parking convention

- Inline `.em` comment on its own line directly above (or trailing) the element it concerns:
  `# TBD: <specific question about current behavior>`. Comments are native DSL syntax — they
  render and validate cleanly.
- Mirror every `# TBD` 1:1 as a checkbox in the state file's **Open questions / parking lot**,
  and remove both together when resolved.
- A `# TBD` is only ever resolved by a confirmed current-state fact — never replaced by a
  guessed element.

## Completion & handoff

Extraction is complete when: the model renders; `em validate` is clean (or remaining warnings
are consciously accepted in the Decisions log); every unknown is a parked `# TBD`; and the
user has confirmed the model reflects today's behavior. Then:

1. State file: set phase progress (extraction rounds checked), log the completion decision,
   seed the **Slice inventory** (every slice, pattern, doc status `none`).
2. The extracted model **replaces `discover`** — suggest `/event-modeling model` next
   (steps 5-7: swimlanes, patterns, completeness). Desired-state changes belong *after* the
   as-is model is agreed — as normal `model`/`slice` evolution, clearly separated from
   extraction.

## Anti-patterns

- **Inventing desired state** — the cardinal sin of extraction; park it instead.
- **Importing screens/tables as events** — they are evidence of state changes, not facts.
- **Guessing an unclear trigger or reaction** instead of parking a `# TBD`.
- **Cleaning up the domain while extracting** — renames and restructures beyond honest
  past-tense naming are `model`-phase work, done with the user after the as-is picture exists.
- **Skipping render/validate until the end** — the loop depends on the user seeing the model
  grow round by round.
