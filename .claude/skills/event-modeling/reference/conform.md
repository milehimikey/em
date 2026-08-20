# Conform Phase — Drift Detection Against the Codebase

Read this **before doing any conform work**. It governs the `conform` phase: checking a
**ratified** model (and its slice docs) against the codebase that is supposed to implement it,
and reporting where they've drifted apart. Conform reuses `extract`'s sourcing/mode rules
(`reference/extract.md`) for reading the target codebase rather than duplicating them — the
difference is what you do with what you find: extract *builds* a model from the code; conform
*compares* code evidence against a model that already exists.

## Stance — advisory-only, evidence-first

- **Advisory-only.** Conform never gates anything and never edits the canonical model or a
  slice doc on its own initiative. It proposes; the user ratifies. There is no such thing as
  an auto-applied conformance fix.
- **Evidence-first, not model-first.** For every slice you check, gather code evidence —
  handler/event/projection/endpoint sites, invariant-enforcement sites, scenario-test sites —
  **before** you compare anything to the model or doc. Read the doc and model first to know
  *what to look for*, but write down what the code actually shows before you judge whether it
  matches. Anchoring bias is the failure mode this rule exists to block: "the model says X" is
  never allowed to substitute for "the code shows X at `path/to/File.kt:42`".
- **Uncertainty is never drift.** If you can't find evidence either way — the code path is
  unclear, the test is ambiguous, you ran out of budget — that's an **uncertainty**, reported
  in its own section, never folded into a drift or gap finding. A false positive here is worse
  than a missed one; it's what burns the loop's credibility.
- **Anchored, not blind.** You read the canonical model's vocabulary before walking the code,
  and you reuse its slice/element names wherever the code genuinely matches them. This trades
  some independence for precision: naming a scratch model's elements from scratch (blind
  extraction) would report wholesale slice add/remove noise from naming alone the moment your
  synonym for an existing element doesn't match the model's — the exact false-drift failure
  mode this phase exists to avoid. The guardrail against anchoring bias is the evidence-first
  rule above, not independence from the model's vocabulary.

## Preconditions

1. A canonical `.em` model with a state file (`.event-modeling.md`), reachable the same way the
   SKILL.md preconditions locate it.
2. The slices you're about to check should be **implemented** — docs at `status: implemented`
   (or the status the user says corresponds to shipped code) for whichever slices are in scope.
   Checking a `draft` or `ready-to-implement` slice against code is a wasted walk — ratified or
   not, nobody has built to it yet; tell the user and skip it rather than reporting "drift"
   against it.
3. The codebase to check: the state file's **Existing system refs** (populated during
   `extract`, if this model came from one) or ask the user for the repo path if not set. Record
   it if missing. In a headless/scheduled run with no user to ask, default to the repository
   the model lives in (if it contains the implementation) and state that assumption in the
   report's run metadata.
4. Confirm `em --version` works (same check as every other phase) — you'll run `em diff`. The
   phase needs `em diff --json`; if the flag errors as unknown, the installed `em` predates it
   — say so and stop rather than falling back to eyeballing the two models.

## The three conformance surfaces

The model isn't just the `.em` — slice docs carry the detailed spec (field tables with rules,
named invariants, Given/When/Then scenarios). Conform checks all three surfaces that can drift:

| Surface | What drifts | Who checks | How |
|---|---|---|---|
| **Structural** — `.em` ↔ code | slices/elements/fields/flow | `em` (deterministic) | `em diff --json` on canonical vs. an as-is scratch model |
| **Spec** — slice doc ↔ code | field rules not enforced, named invariants (`INV-*`) without enforcement/test sites, GWT scenarios without test sites | you (judgment) | per-slice evidence walk: each checkable claim in the doc mapped to a code/test site by name (`INV-CHK-4` → its enforcement site + its test) |
| **Internal** — slice doc ↔ `.em` | the doc's frontmatter (`pattern:`, `status:`) or its Command/Event/Read Model sections and field tables disagreeing with the model's own elements/fields | you (judgment, v1) | cross-check the doc's structured sections against the slice's model elements |

The internal surface is deterministically checkable in principle (structured doc sections +
`{ fields }` blocks) — promoting it to an `em validate` rule is a natural follow-up; file it as
its own issue rather than growing this phase's scope. For now it's agent judgment, same as spec.

**Internal inconsistency is its own class, not drift.** When a doc and the `.em` disagree with
each other, neither one is "the code" — you don't know which is stale. Report it as internal
inconsistency and let the user decide which side is right; don't guess by treating one as
authoritative.

## Flow

### 1. Scope

Run `em conform-scope <model-name>.em --repo <target-repo-path>` — it mechanizes everything
about scoping that's deterministic: parsing `Last conformance:` (via the same state-file reader
`em state read` uses), running `git diff --name-only <revision>..HEAD` in the target repo, and
mapping each changed path to a slice via that slice doc's `implementedIn:` link (a bare/embedded
repo-relative path that's a prefix of or equal to the changed path — a URL-only `implementedIn`,
e.g. a PR link, deterministically matches nothing). It prints one JSON document
(`docs/cli.md`'s conform-scope section documents the envelope):

```json
{ "lastConformance": { "date": "...", "revision": "..." } | null,
  "changedPaths": ["..."],
  "candidateSlices": [ { "key": "checkout", "matchedBy": "implementedIn", "paths": ["..."] } ],
  "unmappedPaths": ["..."] }
```

Default: **diff-scoped** — `lastConformance` set, `--full` not passed — `candidateSlices` is
your in-scope set for step 2. If `lastConformance` is `null` (first run) or you pass `--full`,
`em conform-scope` scopes every `implemented` slice instead (`matchedBy: "full"`,
`changedPaths`/`unmappedPaths` both empty) — the tool makes this call for you, no need to
special-case it yourself.

**`unmappedPaths` is your judgment queue, not a dead end.** A changed path the tool couldn't
place mechanically (`implementedIn` stale, a URL-only link, code that moved) still might belong
to an in-scope slice — a quick Grep for the path's obvious symbols against the slice docs/model
vocabulary is exactly the judgment call this phase reserves for you (`em conform-scope` never
guesses on purpose). Fold anything you place this way into your in-scope set alongside
`candidateSlices`; leave genuinely unplaceable paths out of scope but note them in the report's
run metadata rather than silently dropping them.

Cost containment here is cadence, not a trigger condition — diff-scoped-by-default is what
keeps a recurring conform run cheap; don't invent a smarter trigger.

### 2. Anchored, evidence-first verification (per in-scope slice)

For each slice in scope:

1. Read the slice's **doc** (`slices/<slice-name>.md`) alongside its elements in the `.em`.
   This tells you the vocabulary to anchor on and the claims to check — not the answer.
2. Walk the code and **record evidence before comparing**:
   - **Structural:** the handler, event class(es), projection(s), endpoint(s) that implement
     this slice.
   - **Spec:** for every named invariant (`INV-*`) in the doc, its enforcement site and its
     test site (by name/path, both or neither — a half-found invariant is an uncertainty, not
     a pass). Scenarios are budgeted: map Given/When/Then scenarios to individual test sites
     when the in-scope slice count is small (roughly ≤5) or the user asks for that depth;
     otherwise record slice-level scenario-test presence and say so in the report — per-scenario
     mapping across a full model roughly doubles the walk. Where the doc doesn't name
     invariants/scenarios individually, fall back to slice-level test presence (some vs. none)
     rather than inventing IDs the doc never gave you.
   - **Legitimate non-materialized views:** an automation's watched view may have no
     materialized projection in code — a direct event handler with criteria-sourced state is
     the same pattern expressed in the code idiom (extract.md's R5 reaction rules). That is
     NOT structural drift; note the idiom in the evidence log instead of reporting the view
     as missing. This is the *general*, idiom-level version of the next bullet — prefer citing
     an actual `divergence` annotation when the element carries one; fall back to this idiom
     note only when it doesn't.
   - **Accepted divergences:** before treating any finding as drift, check whether the
     relevant canonical element already carries a `divergence "..."` annotation (visible in
     the `.em`, in `em export --json`'s `divergence` field, or — for a structural finding — as
     the `acceptedDivergence` field already attached to that `em diff --json` entry, see step
     3). If it does, this is not a fresh finding to litigate: classify it as **Accepted
     divergence** (step 4) and cite the annotation text as the evidence. This is the specific,
     per-element, ratified counterpart to the idiom-level bullet above.
   - **Unpropagated deltas (MIL-85):** before treating any slice-level finding as drift, check
     that slice's `doc.driftSignal` in `em export --json` (see `docs/slice-doc-schema.md`'s
     "`status` under re-ratification" section for the mechanics). `"unpropagated-delta"` means
     the slice was re-ratified (a new
     `version`, `status` flipped back off `implemented`) but `implementedIn` still names the
     *prior* version's PR — the code you're evidence-walking is that prior version, on purpose.
     Do not diff it against the newer doc content and do not report a mismatch as Real drift or
     a Model gap; classify it as **Unpropagated delta** (step 4) instead and stop — the finding
     is "this delta hasn't shipped yet," not a defect in the shipped code. `"implemented-
     without-link"` (status: implemented, no link at all) is a genuine coherence problem, but
     it's already surfaced by `em validate`'s `frontmatter-coherence-implemented-without-link`
     warning — don't re-raise it here as a separate conform finding.
3. Write what you found into the scratch model (`<model-name>-asis.em`, see below) — start it
   with `em conform-scope <model-name>.em --repo <target-repo-path> --seed-asis`, which
   byte-copies the canonical `.em` to `<model-name>-asis.em` and ensures `*-asis.em` is
   gitignored (idempotent — safe to pass on every run). **Then replace only the in-scope
   slices** with the as-is picture, leaving out-of-scope slices byte-identical. This is not an optimization:
   `em diff` matches slices by name, so a scratch model containing *only* the in-scope slices
   reports every other canonical slice as `slice-removed` plus one `element-removed` per
   element — a phantom-removal flood on every diff-scoped run, which is the exact false drift
   this phase exists to avoid. It also keeps the scratch model compilable (see step 3). Within
   the slices you do rewrite, **reuse the canonical model's slice and element names wherever
   the code genuinely matches them** — the canonical model is the vocabulary anchor. Give a
   new name only to code behavior the model doesn't cover at all. When you do need a new name,
   check `em glossary` across sibling `.em` models first (same aid the `extract` phase uses) —
   if the term already exists elsewhere under a different kind or spelling, that's a signal to
   reuse the established name rather than mint another synonym for the same concept. Record the
   mapping decision for every element you name this way (e.g. `CartItemAdded` code class ↔
   `"Cart Item Added"` model event) so it's auditable, not a silent judgment call. **Match the
   canonical model's field granularity:** declare `{ fields }`
   in the scratch model only where the canonical model declares them (if the canonical model
   puts fields on commands but not events, so does the scratch model — writing code-derived
   event fields there would flood the diff with `field-added` noise). Schema claims at finer
   granularity than the `.em` declares — e.g. event fields documented only in a slice doc's
   table — are checked on the **spec surface** against the doc, not smuggled into the
   structural diff.
4. Cross-check the doc's header metadata and Command/Event/Read Model sections against the
   slice's actual `.em` elements and fields for the internal surface — this doesn't need code
   evidence, just doc-vs-`.em` reading. Narrative sections (Intent, Open Questions, notes)
   count too when the contradiction is unambiguous — a stale sentence that flatly contradicts
   the `.em` is an internal inconsistency; a vague or interpretable one is not a finding.

Do this for every in-scope slice before moving on to diffing. The evidence you record here is
what every finding in the report will cite — file paths, not vibes.

### 3. Deterministic diff

First `em validate <model-name>-asis.em`. `em diff` refuses when either side has validation
*errors* (warnings are fine), so a scratch model that doesn't compile stops the run cold. The
usual cause is a slice that depends on one you rewrote incompletely — a `view X again` whose
first declaration you dropped, an automation `from` a read model that no longer exists, or an
`arrow` you wrote joining kinds the patterns don't connect. (An unread event is only a *warning*,
so it never blocks the diff — and in an as-is scratch model it's expected.)
Seeding from the canonical model (step 2) prevents this; if it still fails, **fix the scratch
model and report the failure as a tooling problem in the run metadata — never as drift.** A
model you couldn't compile is an uncertainty about your own scratch file, not a finding
against the codebase.

Then run `em diff <model-name>.em <model-name>-asis.em --json`. `em`, not you, decides what
structurally differs — don't re-derive by eye what the tool already computed. Parse the JSON
(`docs/cli.md`'s diff section documents the envelope: `diffSchemaVersion`, `counts`, `changes`,
`removals`, every optional `ChangeEntry` field explicit-`null` when unused) and use it as the
structural-surface findings directly. Check each entry's `acceptedDivergence` field first: a
non-null value means `em` itself already found a `divergence` annotation on the canonical
element behind this entry — that finding is Accepted divergence (step 4), not something to
re-litigate.

### 4. Classify

Every finding — structural deltas from step 3, plus spec- and internal-surface findings from
step 2 — sorts into exactly one class:

- **Real drift** — code evidence contradicts the model or doc.
- **Model gap** — code evidence shows behavior neither the model nor the doc covers.
- **Internal inconsistency** — the doc and the `.em` disagree with each other (surface 3 only).
- **Accepted divergence** — the relevant canonical element carries a `divergence "..."`
  annotation (cited directly from a structural entry's `acceptedDivergence` field, or from the
  `.em`/`em export` for a spec/internal finding). This is what the annotation is *for*: a
  reasoned, ratified deviation stops being re-reported as drift on every run. Cite the
  annotation text, not fresh judgment — that judgment already happened when it was written.
- **Unpropagated delta** (MIL-85) — the slice's `doc.driftSignal` (`em export --json`) is
  `"unpropagated-delta"`: a ratified version bump hasn't shipped yet, so `implementedIn` still
  names prior work on purpose. Distinct from Accepted divergence — this is a structurally-
  derived, deterministic signal (`status`/`implementedIn` coherence), not a human-authored
  `divergence` annotation; keep the two separate so a reader can tell which mechanism produced
  which finding. Cite `slice.doc.driftSignal` and `slice.doc.version` together as evidence.
- **Extraction uncertainty** — no evidence either way. Never reported as drift or a gap.

Every classification must cite the evidence recorded in step 2 (or the `em diff` entry, for
structural findings) — a finding with no citation isn't ready to report.

### 5. Report + proposals

Write `conformance/<YYYY-MM-DD>-report.md` in the model directory, from
`templates/conformance-report.md`. For a real-drift or model-gap finding, propose a
ready-to-apply red note — `issue "conformance: <text>"` on the right element, written out in
the report exactly as it should be pasted into the `.em` — when a model-side marker is the
right fix; when the fix is purely doc wording (or the finding is an internal inconsistency
with no clear side to flag), omit the red note and say why instead. **Never propose a red note
for a finding already classified Accepted divergence** — report it (so the annotation itself
stays auditable) but don't ask the user to ratify what's already ratified. **You never edit the
canonical model or a slice doc unprompted** — walk the report with the user, apply only the
proposals they approve, then re-render and `em validate`.

End of run: update the state file's `Last conformance:` marker with

```
em state set-conformance <target-repo revision> --report conformance/YYYY-MM-DD-report.md
```

— the revision is the one you just diffed against, so the next run's scope starts from here.
The command writes the exact format step 1 parses back out; never hand-edit the bullet.
**The marker only advances with the human in the loop**: in an interactive session, run it
after walking the report with the user; a headless/scheduled run writes the report but never
the marker (nobody ratified the outcome), so the next run re-walks the same span — see
`docs/ci.md`. If any proposals were ratified and applied, log a Decisions entry noting what
changed and why.

## Conventions

- **Scratch model:** `<model-name>-asis.em`, written **next to** the canonical model (same
  directory as `.event-modeling.md`). Always seeded as a copy of the canonical model with only
  the in-scope slices rewritten (step 2) — `em conform-scope --seed-asis` does the seeding and
  the gitignoring (`*-asis.em`, idempotent) mechanically, never built up from nothing and never
  hand-maintained. It's regenerated every conform run.
- **Report location:** `conformance/<YYYY-MM-DD>-report.md` in the model directory. One file
  per run; don't overwrite a prior date's report.
- **Red note wording:** `issue "conformance: <what's wrong, plainly>"` — plain enough that
  whoever ratifies it later understands the claim without re-reading the report.
- **Naming/matching rules:** same past-tense-event / imperative-command / thing-shown-view
  naming discipline as the rest of the skill (`methodology.md`'s Socratic stance) — you're
  matching code to existing names here, not inventing new ones except for genuinely uncovered
  behavior.

## Completion & handoff

Conform is complete when: every in-scope slice has been walked (step 2), the scratch model has
been diffed (step 3), every finding is classified with cited evidence (step 4), the report is
written (step 5), the state file's `Last conformance:` marker is updated, and the user has seen
the report and said which proposals (if any) to apply. Applied proposals get re-rendered and
re-validated before you call the run done.

Conform doesn't chain to another phase automatically — it's a recurring loop, not a step in
building the model. Suggest running it again next time the target codebase has moved, at
whatever cadence the user wants (see `docs/ci.md` for a scheduled-run recipe).

## Anti-patterns

- **Blind extraction** — deriving the as-is scratch model with no sight of the canonical
  model's vocabulary. Loses the anchor and produces naming-driven false drift.
- **A scratch model holding only the in-scope slices** — `em diff` reads every omitted
  canonical slice as removed, so a diff-scoped run drowns in phantom removals. Seed from the
  canonical model and rewrite only the slices you walked.
- **Reporting uncertainty as drift** — "I couldn't find the enforcement site" is an
  uncertainty, never a finding against the model.
- **Editing the model or a slice doc without ratification** — conform proposes; the user
  applies. No exceptions, even for an "obviously correct" fix.
- **Treating scenario/test absence as a build failure** — a missing test site is a spec-surface
  finding to report and classify, not a reason to stop the run or block anything. Conform is
  advisory; there's no gate here.
- **Re-deriving what `em diff` already decided** — once you have the JSON, use it; don't
  eyeball the two `.em` files yourself looking for structural differences the tool already
  computed for you.
- **Re-litigating an accepted divergence** — a non-null `acceptedDivergence` on a diff entry
  (or a `divergence` annotation on the element behind a spec/internal finding) means this exact
  question was already reasoned through and ratified. Classify it as Accepted divergence and
  cite the annotation; don't propose a new red note or re-open the judgment call from scratch.
