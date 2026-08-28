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

Read `slices/<slice-key>.md` end to end — every section is load-bearing:

| Section | What it is to the implementer |
|---|---|
| frontmatter `pattern:` | Which of the four patterns' implementation shapes to build (State Change / State View / Automation / Translation) |
| Command / Event field tables | The contracts — names, types, validation rules, immutable-fact markers |
| `## Invariants / Business Rules` (`INV-<MNEMONIC>-n` IDs) | The non-negotiable rules; every one needs a test citing its ID |
| `## Scenarios (Given / When / Then)` | The acceptance tests, already written — compile them, don't reinvent them |
| `## Alternate & Error Flows` | Retries, idempotency, compensations — real requirements, not appendix |
| `## Non-Functional Requirements` | Authz, PII, performance — implement or consciously surface, never skip |
| `## Dependencies & Read Models Affected` | The blast radius — what else to check before and after |

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
  which assertion library) are yours; anything observable in behavior, data, or contract is not.

## 5. Definition of done

- Every `INV-<MNEMONIC>-n` invariant has at least one test that cites its ID — checked mechanically by
  `em coverage <model>.em --tests <dir>` (MIL-130); run it (add `--strict` in CI) rather than
  eyeballing citations by hand.
- Every scenario in `## Scenarios (Given / When / Then)` exists as a passing test; rejection
  scenarios assert the doc's named rejection reason.
- Alternate/error flows (idempotency included) are covered by tests.
- The build and full test suite are green; the model still validates (`em validate` in CI —
  you didn't touch the `.em`, so this only fails if something else broke).
- Nothing between the slice doc and the code was committed as a source of truth (see §7 —
  work containers are ephemeral; generated or symlinked specs are renderings).

## 6. At merge: the lifecycle flip

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

## 7. Spec-kit projects: the SDD adapter

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

## 8. Never do

| Rule | Because |
|---|---|
| Never implement from a slice that fails `--slice-ready` | The gate is the handoff contract; bypassing it hands you unratified decisions |
| Never edit a ratified slice doc, except the two §6 fields at merge | Doc content is ratified; edits outside a session are unratified decisions |
| Never edit the `.em` model | Model edits are ratified decisions — propose, don't write |
| Never bump `version:` | Versions move only with ratified deltas; see `em ledger` |
| Never silently decide unspecified behavior | Silent divergence is the disease the conformance loop exists to catch |
| Never regenerate merged code from the model | Generated-then-owned: post-merge code belongs to its owners |
| Never commit an authored intermediate spec | The slice is the spec; anything between it and the code is a rendering |

## 9. Afterward: the loop closes

Implementation isn't the end of the slice's story. On a cadence — or whenever someone asks —
the `conform` phase checks implemented slices against the code, using the `implementedIn` link
you recorded, and reports drift for humans to rule on (see the `event-modeling-conform` skill's
`reference/conform.md`). Your two
duties to that future loop are already behind you if you followed this doc: an accurate
lifecycle flip, and zero silent decisions.
