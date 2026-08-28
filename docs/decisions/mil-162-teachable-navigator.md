# MIL-162 — interactive, teachable navigator for event models across a multi-model system

**Status:** decided, prototyped. [MIL-162](https://linear.app/milehimikey/issue/MIL-162) is an
"Explore:" ticket — this document is its write-up, per the ticket's own last acceptance
criterion. It stays open in Linear as the decision record; see
["Where this leaves MIL-162"](#where-this-leaves-mil-162) below.

## Problem

Understanding an event model today means reading a diagram plus a directory of markdown slice
docs. Fine for the people who authored it; daunting for a non-technical stakeholder, and
materially worse — not just linearly harder — at a multi-model scale. Neither of em's two
existing presentation surfaces solves this:

- `em watch --serve`'s Review mode is a live, facilitated, one-model-at-a-time storyboard — the
  right shape for a scheduled walkthrough, not a self-serve "let me go look something up" tool.
- `em catalog` is the closer fit in intent (its own docs name this exact audience), but the
  output is a static HTML site: a flat table and per-slice pages you click into one at a time.
  Nothing teaches a first-time reader the notation, and each input model gets its own output
  directory with no shared navigation across them.

## Decision

**Build a separate add-on tool** — a new package/repo, working name **em-portal** — that
consumes `em export --json` (+ `em status --json`) across many models, rather than reworking
`em catalog` into something interactive.

This was the direction set in the 2026-08-28 toolchain gap assessment (recorded as a comment on
MIL-162) and is reaffirmed here, now that a prototype has tested it:

- **The bar this ticket sets is far from what a static-site generator does well.** Click-into-a-
  diagram interactivity, a real onboarding/teaching layer, and a cross-model index are a small
  application's concerns (state, routing, a data layer), not template-per-page generation.
  `em catalog`'s entire design — one output directory per input model, pages that only link to
  each other — is the thing standing in the way, not a gap in its templates.
- **The integration point already exists and is sufficient.** `em export --json`
  (`schemaVersion` 1.8, includes `public`, `doc.ratifiedBy`/`ratifiedOn`, stable `ref`s) and
  `em status --json` (`statusSchemaVersion` 1.1, includes `commitsBehindHead`/
  `slicePRsBehindHead`/freshness) already carry everything a portal's three properties (below)
  need. This prototype exercises exactly that integration point — nothing it does reaches into
  em's internals — and it held up (see [What the prototype found](#what-the-prototype-found)).
- **Ownership and versioning stay clean.** A portal has its own release cadence, its own static-
  hosting/CI story, and doesn't have to keep `em catalog`'s existing static-HTML consumers
  working while it grows an interactive layer underneath them.
- **The standing constraints are unaffected either way**, and a separate tool makes them easier
  to hold: no LLM in `em` core (the portal has no LLM either — everything it shows is
  deterministic, computed by `em` and simply rendered); no hosted storage (built + published by
  CI to static hosting, a presentation layer over git, consistent with the killed-hosted-
  registry decision); one addressing scheme (deep links use the same stable `<sliceKey>/<kind>.
  <slug>` refs `em export` already assigns — see [Cross-model navigation](#cross-model-navigation)).

`em catalog` isn't deprecated by this — it stays the answer for "I just want a static site, no
new tool to run," and this decision doesn't ask `em` core to do anything it doesn't already do
(export a deterministic document).

## The three portal properties

Per the 1.9.0 "communication layer" framing this ticket implements, three things distinguish a
portal from a prettier catalog. All three are addressed below, and all three are represented —
structurally, not just as UI copy — in the prototype's demo page.

### 1. A guided first read

A first-time non-technical reader doesn't know what a command/event/view/swimlane is. The
portal's onboarding layer is a walkthrough over the **team's own model** — not a generic legend
— annotating real elements as the reader encounters them:

- "This element is an **Event**" — spoken the moment the reader's eye lands on the first amber
  box in their own diagram, not in the abstract.
- "Time runs left to right" — stated once, anchored to the reader's own first slice's actual
  left-to-right element order.
- The four patterns (State Change, State View, Automation, Translation) introduced as the reader
  meets a slice of each kind, not as a glossary page nobody reads before the diagram.
  `pattern` is already computed per slice (`classifySlicePattern`, carried on every `em export`
  slice as of schema 1.4) — the portal doesn't have to infer it.
- What a folded corner means (a `note` is attached) — shown the first time the reader's own
  model has one, linking straight to the rendered doc.

The prototype's demo page (`prototypes/portal-spike/spike.ts`'s `renderDemoHtml`) implements
this as annotated call-outs over the synthetic system's own first slice, generated from real
`ElementExport` data (`kind`, `name`) rather than static copy — proof the walkthrough can be
data-driven per team, not a fixed script. `em-portal`'s own build (MIL-174) is where this
becomes real interaction (click an element, get its lesson in place) rather than a static
sequence of `<div>`s.

### 2. State up front

The landing view is `em status`'s rollup (slice counts by lifecycle status, drift-signal
breakdown, invariant coverage, freshness) — not a slice list. A reader's first question is "is
this healthy," and `em status --json` already answers it in one document across however many
models are given. Drill-down is model → slice → doc, in that order — the portal doesn't ask a
reader to already know which model to open.

The prototype builds this directly from `buildStatusReport` (the exact function `em status`
itself calls) fed by `resolveSliceStatusFacts` over every model in the synthetic set — the same
rollup a real `em-portal` build would compute, just handed to a demo template instead of a real
UI. See [What the prototype found](#what-the-prototype-found) for the doc-coverage numbers a
mostly-undocumented large system actually produces in this rollup.

### 3. Multi-model navigation

"This model is one part of a larger system." Two things this needs, both cheaper than expected
once tested:

- **A top-level index across models** — trivial: `em export --json`/`em status --json` already
  accept multiple model files in one invocation (MIL-160's one-directory-per-model convention),
  so the portal's build step is "run export/status once per model, keep every document," not a
  new aggregation primitive.
- **Which model's public events feed another model's slices** — this is the part the ticket
  flagged as an open question, and where the prototype found a real gap: **em has no DSL-level
  cross-model reference.** `from` only resolves within the model currently being compiled — an
  early draft of the prototype's fixture wrote a genuine `view … from "<another model's event>"`
  and `em validate` correctly rejected it (`view-from-unresolved`). The `public` clause (docs/
  dsl.md "Integration surface") is a **promotion flag**, not a link: it marks an event as part of
  a model's published surface, but nothing in the DSL says *who reads it*.

  So cross-model navigation, today, is a **heuristic the portal must compute itself** — matching
  public event/view names against other models' element names — not something it can read off a
  verified reference. `buildCrossModelLinks` in `spike.ts` implements exactly this join, over the
  independently-computed `em export` JSON for each model (no access to internal model objects).
  It works, and it's honest about what it is: a naming-convention join with no compiler
  guarantee behind it. Whether em should eventually grow a real cross-model reference construct
  (so this join stops being a heuristic) is a fair follow-up question, deliberately **not**
  decided here — nothing forces it, and the portal is useful without it. If it comes up again
  from real pilot use, it's a new ticket, not a retrofit onto this one.

## What the prototype found

`prototypes/portal-spike/` (throwaway, not a shipped `em` feature — see its own README) builds:
a deterministic generator for a synthetic multi-model system (`scaleFixture.ts`) and a pipeline
that materializes it, compiles every model the way `em` does, builds each one's real
`em export --json` document, runs the real `em status` rollup logic over all of them, resolves
cross-model links, and renders one self-contained demo page exercising all three properties
above. `test/portalSpike.test.ts` runs this at ~200 slices/5 models as an automated regression
guard (CI-friendly); the numbers below are from ad hoc runs at larger scale.

| Run | Models | Slices | Cross-model links resolved | Total pipeline time |
|---|---|---|---|---|
| CI test scale | 5 | 204 | 4 | (asserted < 15s; typically well under 1s) |
| Demo scale | 6 | 245 | 5 | ~35 ms |
| Stress scale | 20 | 1,219 | 19 | ~71 ms |

**The em export/status substrate is not the bottleneck at hundreds-of-slices, multi-model
scale.** Compiling, exporting, and status-aggregating over 1,200+ slices across 20 models —
well past this ticket's "hundreds of slices" bar — took under 100ms in-process. Nothing about
"decide: rework `em catalog` vs. separate tool" was gated on em's own compute cost; it was
always a shape-of-the-output question, and the numbers confirm the substrate underneath either
answer is cheap.

**What this prototype did NOT benchmark**, and what MIL-172's scaffold should when it gets
there:

- **Process-spawn overhead if a portal build shells out to the `em` CLI once per model** rather
  than importing the library in-process (this prototype does the latter). Hundreds of `em
  export`/`em status` invocations as separate child processes in a CI build is a different cost
  profile than the in-process numbers above.
- **Diagram rendering via the external Graphviz binary.** `compile()` (used here) runs parsing,
  normalization, grid layout, and DOT emission — but not the actual `dot` subprocess call that
  turns DOT into SVG (`render.ts`'s `renderDot`/`writeRendered`, what `em catalog`/`em render`
  actually shell out for). That's a real per-diagram cost a portal at hundreds-of-slices scale
  will pay, and it wasn't exercised here.
- **Browser-side cost of a genuinely interactive multi-model diagram** (click-into-slice,
  progressive zoom) — this prototype only proves the DATA layer (export/status JSON) is
  sufficient and fast to produce; the client-side interactivity design is MIL-172/174's job, not
  this ticket's.

## Constraints honored

- **No LLM anywhere in this design** — the portal's onboarding walkthrough, status rollup, and
  cross-model index are all deterministic transforms of `em export`/`em status` JSON. Same
  stance the prototype takes: `buildCrossModelLinks` is exact-string matching, not fuzzy/LLM
  matching.
- **No storage of its own** — built and published by CI to static hosting; git is the only
  history store; the portal is a presentation layer, same posture `em catalog` already has.
- **One addressing scheme** — a portal deep link should resolve to the same stable
  `<sliceKey>/<kind>.<slug>` ref `em export`/`em diff` already use, so an agent's or a
  stakeholder's citation of "checkout/event.order-placed" means the same thing whether it's read
  by a human clicking a portal link or a tool consuming `em query`/MCP output. This prototype's
  `CrossModelLink`/element data already carries `ref` end to end — nothing invents a second
  identity scheme.

## Follow-up tickets (already scoped)

Filed in the new **[em-portal](https://linear.app/milehimikey/project/em-portal-47d2d4cdf5bf)**
Linear project, milestones 0.1.0 (read-only multi-model browser) → 0.2.0 (guided first read) →
0.3.0 (async review intake):

- [MIL-172](https://linear.app/milehimikey/issue/MIL-172) — scope and scaffold the package:
  export-ingestion layer, multi-model index, per-slice pages, CI publish recipe. Should start
  from this prototype's findings (in-process ingestion over per-file CLI shelling, Graphviz
  render cost still unmeasured) rather than from zero.
- [MIL-173](https://linear.app/milehimikey/issue/MIL-173) — deep links on stable refs (the
  addressing-scheme constraint above).
- [MIL-174](https://linear.app/milehimikey/issue/MIL-174) — the guided first read, built out
  from the prototype's static call-out sequence into real click-driven interaction.
- [MIL-175](https://linear.app/milehimikey/issue/MIL-175) — async review intake ("raise a
  question" on a slice page, triaged into an `issue` marker through the normal ratified path).

## Where this leaves MIL-162

Every rough acceptance criterion on the ticket is addressed:

- [x] **Decide: rework `em catalog` vs. separate add-on** — separate add-on (`em-portal`),
  reasoned through above.
- [x] **Design an onboarding/teaching layer** — [above](#1-a-guided-first-read), prototyped.
- [x] **Design cross-model navigation** — [above](#3-multi-model-navigation), including the
  real gap found (no DSL-level cross-model reference) and the heuristic that stands in for it.
- [x] **Prototype against a large (hundreds-of-slices, multi-model) test set** —
  `prototypes/portal-spike/`, tested up to 1,219 slices / 20 models; regression-guarded in
  `test/portalSpike.test.ts`.
- [x] **Write up the decision and scope follow-up ticket(s)** — this document; MIL-172–175
  already filed under the em-portal project.

MIL-162 itself stays open in Linear per the original comment's plan: it's the decision record,
and the plan was always to close it once MIL-172's scaffold confirms the separate-tool shape
against this same hundreds-of-slices prototype in a real build — not before that scaffold
exists. This PR moves it to the review state with this document and the prototype as its
evidence; closing it is MIL-172's job once the scaffold lands.
