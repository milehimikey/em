# Implementing a ratified slice

The contract for the implementation half of the workflow: an agent (or engineer) turning **one
ratified slice** into merged, verified code. The facilitation phases (`discover`/`extract` →
`model` → `slice`) produce the inputs; this document governs consuming them. It applies to any
implementing agent, whether or not the session started from `/event-modeling`.

**The contract in one paragraph:** the slice doc is the spec — nothing between it and the code
is a source of truth. Verify readiness mechanically before writing any code; implement exactly
what the doc says; put every gap in front of a human instead of deciding it silently; never
edit the ratified doc except the two lifecycle fields at merge; prove the work with tests
traceable to the doc's invariants and scenarios.

Why the rules are shaped this way: **agents propose, humans ratify.** Everything in the model
and its slice docs is there because a human decided it on purpose — that is what makes the
model authoritative. An implementing agent that silently patches a gap, or edits a ratified
doc outside a session, converts the model into just another generated artifact and voids the
whole methodology. (The full human/agent partition is `docs/process.md` in the
[em repository](https://github.com/milehimikey/em/blob/main/docs/process.md) — not vendored
with this skill.)

## 1. Gate: verify readiness before starting

```bash
em validate <model>.em --slice-ready <slice-key> --json
```

`<slice-key>` is the slice's export key — the kebab-case slug of its name (`"Place Order"` →
`place-order`). Read the JSON document's `ready` field — don't infer it from the exit code or
any printed text. `ready: true` means: the slice has a doc bound via `note "slices/<key>.md"`,
its frontmatter is usable, `status: ready-to-implement`, every `## Open Questions` checkbox is
checked, and no status/version/link incoherence is flagged — `gates` names each of those 4
conditions individually (`docBound`/`frontmatterUsable`/`statusReady`/
`noUncheckedOpenQuestions`) if you need to say which one is blocking.

**`ready: false` means stop.** Report which `gates` entries are `false` (and any `diagnostics`
entries concerning this slice) and hand the slice back to the humans. Never make the gate pass
yourself — checking an open-question box, flipping `status`, or editing frontmatter are
ratification decisions, and ratification happens in a facilitated session, not in an
implementation branch.

## 2. Read the spec

**First, read the project's constitution** — the house rules for *how* implementation happens
here (stack and architectural shape, which implementation skill each slice pattern routes to,
code style, testing norms, NFR baselines, review and merge norms). It lives in one of exactly two
places, never both:

- **spec-kit project** (a `.specify/` directory exists at or above the model):
  `.specify/memory/constitution.md` — spec-kit's own slot, which em defers to.
- **anything else**: `constitution.md` beside the model, where `em scaffold` writes it.

`em status <model>.em --json` reports which one applies and whether it's there
(`conformance[].constitution`) — existence only; nothing in `em` reads or judges its content.
**Its rules bound every technical choice you make on this slice** (see §4). If it's missing, or
its `ratifiedBy:` is empty (spec-kit's file: the `**Ratified**:` footer still a placeholder),
it isn't ratified — go to §7 before writing code.

Then read `slices/<slice-key>.md` end to end — every section is load-bearing:

| Section | What it is to the implementer |
|---|---|
| frontmatter `pattern:` | Which of the four patterns' implementation shapes to build (State Change / State View / Automation / Translation) |
| Command / Event field tables | The contracts — names, types, validation rules, immutable-fact markers |
| `## Invariants / Business Rules` (`INV-<MNEMONIC>-n` IDs) | The non-negotiable rules; every one needs a test citing its ID |
| `## Scenarios (Given / When / Then)` | The acceptance tests, already written — compile them, don't reinvent them |
| `## Alternate & Error Flows` | Retries, idempotency, compensations — real requirements, not appendix |
| `## Non-Functional Requirements` | Authz, PII, performance — implement or consciously surface, never skip |
| `## Dependencies & Read Models Affected` | The blast radius — what else to check before and after |

**Interface obligations follow from the model, not from the doc's prose.** The DSL already
encodes what's reachable — see `em-dsl.md`'s "Headless / API systems & repeated read models"
section — and the routing from it is mechanical, not a technical choice you make while coding:

- A **command with a `ui` trigger** ships the endpoint that dispatches it as part of this slice
  — shape, verb, status codes, and error mapping follow the constitution's interface conventions
  (§7). Because: the model already said this command is reachable from outside; leaving it
  reachable only through an internal gateway silently narrows what the model ratified.
- A **view with a `ui` consumer** ships the query endpoint as part of this slice, same
  conventions.
- **No `ui`** on the trigger or the consumer (a command dispatched by a processor or a
  translation, a view read only by a reaction) means internal-only: no endpoint. If one seems
  needed anyway, that's a gap to surface (§4), not a technical choice to make mid-implementation
  — adding a route the model doesn't show is exactly the kind of silent divergence §4 exists to
  catch.
- **`public` events and views** are the model's published integration surface: their shape is a
  contract, not an implementation detail. `em validate --list-public` lists them; `em typespec`
  is the POC generator for a downstream schema. Changing a public element's shape is a ratified
  delta, never an implementation-time choice.

For timeline context, read the slice's surroundings in the `.em` (what triggers it, what
consumes its output) — the slice's own diagram (`slices/<slice-key>.svg`) shows its canonical
pattern shape. For machine-readable facts, use `em export <model>.em --slice <slice-key>`
rather than parsing the DSL or the doc's frontmatter yourself: it returns just this slice's
object — `pattern`, element refs, fields, and the joined doc metadata (`slice.doc.status`,
`version`, `driftSignal`) — without piping the whole model's export to find one `slice.doc`.

If the project ships pattern-specific implementation skills (for example an Axon/DCB skill
set keyed on a slice doc's `pattern:` frontmatter), route by the slice's pattern and follow
those.

## 3. Two modes: first version vs. ratified delta

Check the doc's `version:` and `## Delta` section (or `em export`'s `slice.doc.driftSignal`):

- **First implementation** (`version: 1`, no `## Delta`, `driftSignal: never-implemented`):
  green-field slice implementation. Build the whole pattern shape the doc specifies.
- **Ratified delta** (`version` > 1, `## Delta` present, `status: ready-to-implement` while
  `implementedIn` still names the prior version's PR — `driftSignal: unpropagated-delta`):
  this is a **change to existing, owned code**. The `## Delta` section's typed operations
  (Added/Modified/Removed/Renamed, each with scenarios) scope the work precisely — which
  invariants, which scenarios, which tests change. Touch what the delta names; leave the rest.
  **Never regenerate merged code wholesale from the model** — after merge, code is owned by
  the people who've edited it (generated-then-owned); regeneration is legal only for slices
  whose code never merged.

## 4. Gaps: propose, never decide

Mid-implementation you will hit things the doc doesn't answer — a field's edge case, an
undocumented ordering, a contradiction with adjacent code. The discipline:

- **Stop that thread and surface it.** State precisely what's unspecified, the options, and
  your recommendation. The human resolves it — at the model, where the resolution lands as an
  answered open question or a small ratified delta alongside your fix, so the decision is
  recorded instead of buried in an implementation diff.
- **Never edit the ratified doc to record your own answer**, and never quietly pick a behavior
  a business person could have an opinion on. Silent divergence is the failure mode the whole
  conformance loop exists to catch — don't manufacture it.
- Purely technical choices with no behavioral surface (private naming, idiomatic structure,
  which assertion library) are yours — **within the constitution's rules** (§2); anything
  observable in behavior, data, or contract is not. If no constitution exists (or its
  `ratifiedBy` is empty), surface that to the human and do not proceed on unilateral style or
  stack decisions for a first slice: run the constitution step (§7) first.

## 5. Definition of done

**The unit is the slice doc: one slice doc = one PR.** A doc that `covers:` another slice (an
automation's to-do-list view and its reaction, MIL-121) is one spec, not two — it ships in one
PR, and `mark-implemented` runs for both keys against the same URL. An `again` view instance has
its own doc today and therefore its own PR — that's a fact about today's model, not a judgment
call the constitution gets to override; only MIL-208, changing what an `again` instance is,
changes it. Never fold multiple slice docs' implementations into one PR because they touch the
same read model, ship together, or seem small — see §10.

- The PR description cites exactly one slice doc (plus its `covers:` keys, if any) and lists
  that doc's invariants alongside the tests that cover them.
- Every `INV-<MNEMONIC>-n` invariant has at least one test that cites its ID — checked mechanically by
  `em coverage <model>.em --tests <dir>` (MIL-130); run it (add `--strict` in CI) rather than
  eyeballing citations by hand.
- Every scenario in `## Scenarios (Given / When / Then)` exists as a passing test; rejection
  scenarios assert the doc's named rejection reason.
- Alternate/error flows (idempotency included) are covered by tests.
- The build and full test suite are green; the model still validates (`em validate` in CI —
  you didn't touch the `.em`, so this only fails if something else broke).
- Nothing between the slice doc and the code was committed as a source of truth (see §9 —
  work containers are ephemeral; generated or symlinked specs are renderings).

## 6. At merge: the lifecycle flip

The PR being merged here is the one doc's PR (§5) — its description cites exactly this slice doc
(plus any `covers:` keys) and nothing else, which is what makes the flip below unambiguous: one
PR, one `implementedIn` URL, applied to every key that PR's doc covers.

When the PR merges, exactly **two** frontmatter fields change on the slice doc:

```yaml
status: implemented
implementedIn: <PR or commit URL>
```

This is supply-loop mechanics, not ratification — it's the one edit an implementing agent makes
to a slice doc, and it's why `em ledger` deliberately excludes these two fields from what
counts as content. **Do not bump `version:`** — versions bump only when a delta is ratified;
a bump here is a ledger defect.

`em slice mark-implemented <model>.em <slice-key> <pr-url>` does the flip for you (MIL-103) —
resolves the doc via the same note-binding join `--slice-ready` uses, is idempotent on a re-run
with the same URL, and refuses (never silently overwrites) if the doc is already `implemented`
with a different URL. Prefer it over hand-editing the doc's frontmatter.

Then, if the project keeps a model README (from `../../event-modeling-shared/templates/model-readme.md`), run
`em slice index <model-name>.em` so its generated Slices table reflects the new status and
link — never hand-edit that table. The `implementedIn` link is what the `conform` phase later
uses to anchor drift-checking — leaving it empty blinds the loop.

## 7. Before the first slice: the constitution

The first time this project's slices reach implementation — or any time §2 finds no constitution,
or one whose `ratifiedBy` is still empty — **stop and run this short conversation before writing
code.** It happens once per project, not once per slice.

Start from the template the skill bundle ships,
`../../event-modeling-shared/templates/constitution.md`. Each of its five sections opens with the
question to ask; ask them **conversationally, one section at a time**, and write the answers into
the document as you go — never fill a section by guessing, by reading the codebase and inferring
"what they probably do", or by pasting the template's own examples. Unanswerable questions get
parked in the document as open items, exactly like a slice doc's Open Questions:

1. **Stack and architectural shape** — languages/runtimes, frameworks, the architectural pattern,
   where a slice's code lives, and the routing table: which implementation skill or approach each
   of the four slice patterns uses (for example, State Change slices → the `axon-*` skill set).
   That table is what you obey in §2 when you read a slice's `pattern:`. This is also where the
   **interface conventions** question gets asked — resource style, error/rejection mapping,
   versioning, auth at the edge — so the shape of every endpoint the interface obligations
   paragraph (§2) and the foundation step (§8) require is decided once, here, instead of
   invented per slice.
2. **Code style** — formatter/linter, naming, module layout, and what "idiomatic" means here.
3. **Testing norms** — which test levels each pattern requires, where invariant and scenario
   tests live, and the test-naming convention that lets `em coverage` trace `INV-<MNEMONIC>-n`
   citations.
4. **NFR baselines** — authz model, PII handling, performance defaults, observability: the
   standing defaults every slice inherits where its own `## Non-Functional Requirements` section
   is silent.
5. **Review and merge norms** — who reviews, what blocks a merge, and who runs
   `em slice mark-implemented` at merge (§6).

**A human ratifies it.** The answers are the project's, not yours — you drafted the wording, they
sign it off. In the em-native file that's the `ratifiedBy:`/`ratifiedOn:` frontmatter (a named
person and an ISO date, hand-filled — no `em` command writes this file, and an empty `ratifiedBy:`
means *draft*). In a spec-kit project it's that file's own `**Ratified**:` footer line — never add
frontmatter to spec-kit's document. Until it's ratified, treat it as a proposal: you may not
build a first slice on it.

**In a spec-kit project, merge — never duplicate.** The constitution IS
`.specify/memory/constitution.md`; em writes no second file and neither do you. Append em's five
sections to it under their own `##` headings, **leaving every existing section byte-untouched** —
including spec-kit's own `## Core Principles` and `## Governance`, and any principle a team
already wrote. If a heading of the same name is already there, add to it rather than replacing it,
and show the human the diff before writing. Two cautions: spec-kit's `/speckit.constitution`
command rewrites that whole file from its template, so run it (if at all) **before** this
conversation, never after — and never use it to author em's sections. If the file is still the
blank stock template (`[PROJECT_NAME]`, `[PRINCIPLE_1_NAME]`, … placeholders), say so: filling
spec-kit's own placeholders is the team's call, and em's sections go in alongside them either way.

`em status` will then report `constitution: present` for the model. That's the whole mechanical
check — em stores and locates this document, and never validates a word of it.

## 8. Foundation: contracts first

Once per project, before the first slice PR ever opens, land one **foundation PR** that turns
the model's events — and the cross-cutting shell the constitution names — into code, and
nothing else. Skip this and the failure is the same on every project that's skipped it: the
first slice PR ships fine, then the second one needs an event the first slice already defined
informally, and every PR after that either redefines it slightly differently or reaches into a
sibling slice's package to reuse it — the boundary the constitution drew is gone within a week.

1. **What it contains.** Every event `em export <model>.em` lists in `events[]`, each placed in
   the home the constitution's "where a slice's code lives" rule assigns to its *emitting*
   slice — not a separate shared "events" module, so nothing about where an event lives depends
   on this PR existing rather than the constitution. Fields come verbatim from the slice docs'
   Event tables, with types mapped per the constitution's stack conventions. Add the
   cross-cutting shell the constitution names: shared ports, and the request/response boundary
   and error mapping the interface obligations above (§2) plug their endpoints into. **No
   handlers, no projections — contracts only.** Because: a handler or a projection belongs to
   the slice that owns the behavior behind it; folding one into the foundation PR turns a shared
   contract into a pre-empted slice.
2. **It merges before any slice PR opens.** Every slice branch is cut from `main` *after* the
   foundation PR has landed there — never from a commit that predates it, and never alongside an
   open, unmerged foundation PR. A slice PR never carries foundation files. Because: a slice PR
   opened while the foundation is still in review shows a diff dominated by files the slice
   didn't write and can't be held accountable for, and its merge depends on someone else's
   review timeline instead of its own.
3. **A slice never creates, edits, or reaches into another slice's code.** It *imports* events —
   only events — from wherever the foundation placed them; a sibling slice's handlers, storage,
   and other internals stay off limits. Because: the boundary the constitution drew only holds if
   every slice actually stays inside it — a slice that quietly builds on a sibling's internals has
   erased that boundary informally, one import at a time.
4. **A ratified delta that adds or changes an event re-runs this step for that event, first.**
   Land the code change for the new or changed event — in its emitting slice's home, following
   rule 1 — before the slice's delta PR opens, exactly as if it were the first pass. Because: the
   same contract-before-consumer ordering that applies once per project applies again every time
   the contract itself changes; an event isn't a stable shared type just because it was one
   yesterday.

## 9. Spec-kit projects: the SDD adapter

If the repository uses spec-kit (a `.specify/` directory exists), do not hand-author spec-kit
artifacts — allocate through **em-sdd-bridge**, redirect mode preferred:

```bash
npx em-sdd-bridge@<pinned-version> <slice-key> --symlink
```

That allocates the feature branch and `specs/NNN-slug/` dir, runs the same readiness gates,
and drops `spec.md` as a **symlink to the slice doc** — the slice doc itself travels through
plan/tasks as FEATURE_SPEC. The rules that keep redirect mode safe:

- **Never run `/speckit.specify`.** The ratified slice *is* the spec; an interactive specify
  session against a defined slice creates a second, unratified source of truth.
- **`/speckit.clarify` must never write into a slice doc.** Open questions resolve at the
  model (that's what the readiness gate enforced); a ratified slice has nothing to clarify.
  Projects using em-sdd-preset's overlays carry a mechanical guard for this — respect the
  rule even where the guard isn't installed.
- `/speckit.plan` and `/speckit.tasks` may run against the slice doc directly; the preset's
  redirect preambles map spec-kit's section vocabulary onto the slice doc's sections.
- **Emission fallback**: where redirect can't work (Windows checkouts without symlink
  privileges, a toolchain that mutates its spec files), run the bridge without `--symlink` to
  render `spec.md` from the slice doc. The generated file is a rendering — never hand-edit it;
  regenerate it from the slice doc instead.
- Everything under `specs/NNN-*/` is an **ephemeral work container** — one per change effort,
  discardable; the PR is the durable record of the effort, the slice doc the durable
  definition of the behavior.

No spec-kit (or any SDD tool)? Implement straight from the slice doc — it already contains
everything a spec holds. Don't introduce an intermediate spec document of your own.

## 10. Never do

| Rule | Because |
|---|---|
| Never implement from a slice that fails `--slice-ready` | The gate is the handoff contract; bypassing it hands you unratified decisions |
| Never edit a ratified slice doc, except the two §6 fields at merge | Doc content is ratified; edits outside a session are unratified decisions |
| Never edit the `.em` model | Model edits are ratified decisions — propose, don't write |
| Never bump `version:` | Versions move only with ratified deltas; see `em ledger` |
| Never silently decide unspecified behavior | Silent divergence is the disease the conformance loop exists to catch |
| Never invent the house rules a first slice needs (stack, style, testing, NFR defaults) | They're the project's decision, ratified in the constitution — §7, not your judgment call |
| Never regenerate merged code from the model | Generated-then-owned: post-merge code belongs to its owners |
| Never commit an authored intermediate spec | The slice is the spec; anything between it and the code is a rendering |
| Never open a slice PR before the foundation PR has merged | The foundation is what makes an event a stable shared contract — a slice built ahead of it is building on a moving target (§8) |
| Never implement more than one slice doc in a PR | The PR is the durable record of one spec's implementation; `mark-implemented`, coverage, and conformance all key on one doc ↔ one `implementedIn` |

## 11. Afterward: the loop closes

Implementation isn't the end of the slice's story. On a cadence — or whenever someone asks —
the `conform` phase checks implemented slices against the code, using the `implementedIn` link
you recorded, and reports drift for humans to rule on (see the `event-modeling-conform` skill's
`reference/conform.md`). Your two
duties to that future loop are already behind you if you followed this doc: an accurate
lifecycle flip, and zero silent decisions.
