---
name: event-modeling-design
em-version: 1.8.1
description: >-
  Use when structuring a draft event model into swimlanes and the four patterns (State Change,
  State View, Automation, Translation), evaluating a model's structural completeness, or writing
  implementation-ready deep slice documents (field tables, invariants, Given/When/Then scenarios,
  error flows) for a model that already has its happy-path spine. Drives `em`'s model and slice
  phases — the core modeling work between discovery and implementation.
---

# Event Modeling — model & slice

You are facilitating the core modeling work: turning a draft happy-path spine into a
structurally complete, validated model, and then a deep implementation-ready spec per slice.
Your job is to **extract an accurate model from the user through Socratic questioning** — never
to invent the domain. You drive the `em` CLI to render the model live, and you produce
implementation-ready slice docs.

Read `../event-modeling-shared/reference/operating-principles.md` (preconditions, project
layout, the Socratic/validation discipline every phase follows) and
`../event-modeling-shared/reference/methodology.md` (the 7 steps + 4 patterns) before doing real
work — they are the source of truth. Run the preconditions there first: this phase expects a
draft model already exists (from `event-modeling-discover`'s `discover` or `extract` phase).

## Phase: `model` — steps 5-7

Goal: a structurally complete, **validated** model with correct patterns and swimlanes.

1. **Swimlanes & patterns (step 5).** Group events into **contexts** (bounded contexts /
   aggregates) — ask which events share a consistency boundary and who owns them. Classify each
   slice as one of the 4 patterns. **Share the slice between every automation or translation and
   the command it triggers** (the reaction — processor/translation — together with the command
   and event it produces; the read model it watches, if any, stays in the slice before). A
   translation or automation is a reaction: it **triggers a command and never records an event
   directly**. Add `translation` slices for external inputs (externally triggered: external →
   translation → command → event, no slice before) and for the system reacting to its own state
   (internally triggered: read model in the slice before → translation → command → event).
2. **Elaborate scenarios — first pass (step 6).** For each slice, capture the happy-path
   Given/When/Then and the obvious invariants as short notes. (The full spec is the `slice` phase
   below.)
3. **Evaluate completeness (step 7).** Walk the model: every slice is a **complete** pattern, not a
   half-slice — **every command has something that triggers it**, every command emits an event,
   **every event is read by a read model**, **every read model has a consumer**, every view has a
   source, every UI is reachable, every connection is
   one of the six legal pairs, and every automation **and** translation triggers a command (none
   wired straight to an event, none with no command at all). Run `em validate` and resolve all
   errors and warnings — it catches a reaction wired straight to an event too now (see
   `../event-modeling-shared/reference/em-dsl.md`), so a clean run covers this case.
   For an unread event, don't just bolt on a view to silence the warning: ask the user who looks at
   this fact and what they do with it. The honest answers are "here's the read model we missed" or
   "nobody — so why are we recording it", and both improve the model.

End of phase: render, update state (`em state set-phase slice`), continue with the `slice` phase
below to write implementation specs.

## Phase: `slice` — deep slice documents

Goal: implementation-ready specs. Go slice by slice (let the user pick order, or follow the
timeline). Check `README.md`'s Slices table for what's already done (run `em slice index
<model-name>.em` first if it looks stale).

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
   (see `../event-modeling-shared/templates/slice.md` and
   `docs/slice-doc-schema.md#delta-section-grammar-and-lifecycle`)
   — **overwriting** whatever the section held before, never appending to it. Then continue at
   step 2 to bump `version` and flip `status` back to `ready-to-implement`, leaving
   `implementedIn` naming the prior version's PR (intended drift signal, not a bug — see the
   schema doc). Otherwise, this is first-time authoring: continue at step 1.
1. Hold a Socratic deep-dive to fill every section of `../event-modeling-shared/templates/slice.md`:
   intent, trigger/actor,
   command + field table (types & rules), event(s) + payload (mark immutable facts), invariants
   (give each a stable ID), Given/When/Then scenarios (happy path + rule boundaries + edge cases),
   alternate/error flows (retries, idempotency, compensations), non-functional requirements
   (security/authz, PII/compliance, performance/SLA), read models affected, open questions. Park
   anything unresolved rather than guessing. If the slice lives in an existing codebase, Grep/Read
   adjacent real sources (OpenAPI specs, DB migrations, existing DTOs/event classes in sibling
   contexts) before finalizing field names/types or invariants — don't guess a shape that's
   already defined elsewhere.
2. **First-time authoring:** scaffold the doc mechanically rather than hand-writing the
   frontmatter — `em slice new "<slice name>" --pattern <state-change|state-view|automation|
   translation> --swimlane "<Persona> → <Context>" --wire <model>.em` writes `slices/<slice-name>.md`
   (kebab-cased to match, via the same slugging `em` uses everywhere else) with the canonical
   `schemaVersion`/`pattern`/`swimlane`/`status: draft`/`version: 1` frontmatter — exactly the
   five keys `em export` and the readiness gate require, no more — and the `# Slice:` heading +
   diagram-image stub already in place. `--wire` also inserts the `note
   "slices/<slice-name>.md"` line straight into the `.em`, onto the slice's primary element (the
   command for State Change, the view for State View, the processor for Automation, the
   translation for Translation), matched by export key — see step 4 for when it refuses instead.
   Both `--pattern` and `--swimlane` are required; an invalid `--pattern` is refused with the
   valid choices listed. Never hand-type this block, and never fall back to a placeholder
   pattern/swimlane to dodge the flags. Then fill in every judgment section below the stub from
   step 1 (Intent, Command, Event(s), Invariants, Scenarios, ...) — the doc's prose is still
   entirely hand-authored, only the frontmatter/heading scaffold and the `.em` wiring are
   mechanized. Record the originating need (ticket/conversation link) in the Intent section when
   one exists. When this doc exists because of a split, merge, or rename, add the matching
   lineage key(s) by hand (`split-from`/`merged-from`/`superseded-by`, `<slice-key>@v<N>` grammar
   — see `docs/slice-doc-schema.md` for the full schema; `em validate` catches a malformed one
   after the fact, see the `lineage-*` rules below).
   **Re-ratification (step 0):** the doc already exists, so `em slice new` doesn't apply here
   (it refuses to overwrite an existing file without `--force`, and forcing would blow away the
   doc's authored body) — run `em slice reratify <model>.em <slice-key>` instead: it bumps
   `version` and flips `status` back to `ready-to-implement` in the existing frontmatter,
   clearing any stale `ratifiedBy:`/`ratifiedOn:` from the prior version so a follow-up
   `em slice ratify --by <name>` (if the team records that) applies cleanly.
3. Render the slice's own diagram: `em render <model>.em --slice "<slice name>" -o
   slices/<slice-name>.svg` (kebab-case, matching the doc's filename and the `![Diagram]` stub
   `em slice new` already wrote) — redraws just this slice in its own canonical pattern shape.
4. Confirm it's wired into the `.em`: `em slice new --wire` (step 2) already inserted the `note
   "slices/<slice-name>.md"` line onto the slice's primary element's own declaration line — it
   only ever edits that one line, and only when doing so is unambiguous, so it refuses (writing
   NEITHER the doc nor the `.em` edit) rather than guess when the slice has zero or more than one
   candidate element of the primary kind, or when that line already carries a `note` clause. On a
   refusal, re-run step 2 without `--wire` — it prints the exact line to add, paste it onto the
   slice's primary element by hand.
5. Run `em slice index <model-name>.em` to regenerate `README.md`'s Slices table — the one
   canonical slice index — from the model and the doc frontmatter you just wrote (status,
   `implementedIn` once shipped). Never hand-edit the table; it's a generated block.
6. Re-render and `em validate`.

When a slice is **ratified** — a human flips its `status` to `ready-to-implement` with every
open question resolved — it's ready to hand to an implementer. Confirm with
`em validate <model>.em --slice-ready <key>`, and point whoever (or whatever) implements it
at the `event-modeling-implement` skill.

End of phase: every slice that should exist has a doc, `README.md`'s Slices table is current,
and the model validates clean. Suggest `event-modeling-implement` for each ratified slice.
