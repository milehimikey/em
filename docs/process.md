# The process: who does what

Event Modeling is a Software Development Life Cycle activity whose product is **shared
clarity** — stakeholders, product owners, and engineers agreeing, in one artifact, on how a
business process works and what must always be true about it. `em` mechanizes the artifact
(rendering, validation, diffing, drift detection); it never replaces the people. This document
is the map of which parts of the workflow require humans in the room, which parts an agent can
carry with human review, and where the boundary between them sits.

The other docs cover the mechanics: [workflow.md](workflow.md) is the lifecycle stage by
stage, [ai-workflow.md](ai-workflow.md) is the Claude Code skill. This one is organized by
**responsibility**.

## The one rule everything else follows from

> **Agents propose. Humans ratify.**

The model's entire authority rests on one property: everything in it was decided by a person,
on purpose. A stakeholder can trust the diagram, a product owner can trust a slice's
invariants, and an engineer can build against them *because* nothing entered the model by
autocomplete. Agents can draft, extract, render, diff, flag, and propose as hard as they like
— but the moment an agent writes an unratified decision into the model, the model stops being
a record of decisions and becomes just another generated artifact.

That's why the human checkpoints below are not process ceremony to optimize away. They are the
product.

## What "ratified" means

Used throughout these docs and the skill, **ratified** means: *a human decided this,
deliberately, and the decision is recorded in the model or its slice docs.* It shows up at
three specific points:

1. **Ratifying a slice** — the sign-off, after review, that flips a slice doc's `status` from
   `reviewed` to `ready-to-implement`: contracts and invariants are agreed, every open question is
   resolved or explicitly deferred ([`em slice defer`](cli.md#em-slice-defer-file-slice-key-question)). This is the second of the two per-slice human gates (the first
   is the review session itself — the whole sequence is
   [The slice lifecycle gates](#the-slice-lifecycle-gates) below), the handoff gate between
   deciding and building, and it's
   mechanically checkable: `em validate <model>.em --slice-ready <key>` verifies the doc,
   status, and open-question state in one command ([cli.md](cli.md#--slice-ready-key-mil-87)).
   `em slice ratify <model>.em <key> --by <name>` (MIL-165) makes the sign-off itself a
   mechanical, one-edit act, recording *who* ratified it and *when* in `ratifiedBy:`/
   `ratifiedOn:` frontmatter alongside the `status` flip
   ([cli.md](cli.md#em-slice-ratify-file-slice-key---by-name)) — pair it with a
   [CODEOWNERS](ci.md#codeowners-routing-ratification-review) rule on `slices/**` so the edit
   itself can't merge without review by a designated ratifier.
   **Re-ratifying** a slice that already shipped is the same act for a change: record the hop
   in the `## Delta` section, then `em slice reratify <model>.em <key>` (MIL-161,
   [cli.md](cli.md#em-slice-reratify-file-slice-key)) bumps `version:` and flips `status` back to
   `ready-to-implement` mechanically — mirroring `em slice mark-implemented`'s shape at the other
   end of the lifecycle ([slice-doc-schema.md](slice-doc-schema.md#status-under-re-ratification)).
   The same command changes a ratified doc that **never shipped** (MIL-258 — typically a gap
   answered mid-build): it bumps `version:` and clears the sign-off but leaves `status:` at
   `ready-to-implement`. Either way the doc is not ratified until `em slice ratify --by <name>`
   records the new sign-off.
   **API first (MIL-238):** ratifying a *public-touching* slice — one that owns a `public`
   command, event or view — also asserts that the model's generated contract
   (`contracts/<model key>.tsp`, written by `em api generate`) is current, and says whether this
   version changes what that contract means to a consumer: `--meaning-unchanged`, or
   `--contract-change "<why>"`, recorded as `meaningConfirmed:`/`contractChange:` frontmatter.
   `em slice ratify` and `reratify` refuse such a slice without one, and `--slice-ready` is not
   ready until the committed contract matches the model.
2. **Ratifying model changes** — every edit to a committed `.em` or slice doc is a ratified
   decision, made in (or reviewed out of) a facilitated session. The PR review of a model
   change is part of this: the diff *is* the decision record.
3. **Ruling on conformance findings** — a *ruling*, not a ratification (the word is reserved
   for the design-exit gate in point 1), but the same human-decides shape: when the conform
   phase reports drift between model and code, a human rules on every finding (fix the model,
   open a red note, fix the prose — [workflow.md](workflow.md#7-rule-on-the-findings)). A ruling is a
   human gate, the same shape as ratifying a slice: an agent gathers evidence and proposes, a person decides, and the decision
   is recorded with a name and a date. The report proposes; you decide.
   **The findings themselves are structured data** (MIL-214): the conform skill writes
   `conformance/<date>-findings.json` alongside its `<date>-report.md`, one entry per `### n.`
   finding, ids matching (shape: [slice-doc-schema.md](slice-doc-schema.md);
   `em conform-findings check <path>` verifies a headless run wrote it correctly).
   `em conform-supersede <model> <report-path> --as-of <rev> --findings <spec> --locus <model|doc|code|none> --by <name>`
   (MIL-164/MIL-214,
   [cli.md](cli.md#em-conform-supersede-file-report-path)) is what records BOTH the ruling
   itself — `locus`/`resolvedBy`/`resolvedOn` on the named findings in that JSON — and the
   ruled-on report's "superseded as of `<rev>`" banner, so the record of what was decided
   stays legible without misleading a later reader into treating a historical report's
   file:line citations as current. `locus: code` on an unresolved finding is the first-class
   carrier for "spec is right, code is wrong" — no doc delta needed for that case any more.
   Once every in-scope finding touching a slice is ruled, `em slice conform <model> <key> --at
   <rev>` (MIL-214, [cli.md](cli.md#em-slice-conform-file-slice-key---at-rev)) records that
   THIS VERSION of that slice was certified — a fact `em state set-conformance` (below) checks
   before advancing the model-wide marker.
   `em state set-conformance` refuses while any `implemented` slice still has an unruled finding
   in scope (`--partial` escapes with a loud notice); nothing writes the marker for you.

## The slice lifecycle gates

A slice doc travels through four statuses, and **two of the three transitions between them are
human gates**. Each has its own command, its own recorded name and date, and — deliberately — its
own moment:

```
draft ──(review session)──▶ reviewed ──(ratification gate)──▶ ready-to-implement ──(merge)──▶ implemented
```

1. **`draft`** — the doc exists and is being written. `em slice new` scaffolds it here; the
   `slice` phase of the skill fills it in. No gate: drafting is work, not a decision.
2. **The review session → `reviewed`.** A facilitated walkthrough with the people who know the
   domain. A slice whose open questions are all resolved in the room ends the walkthrough with
   `em slice review <model>.em <key> --by <name>` ([cli.md](cli.md#em-slice-review-file-slice-key---by-name)),
   which flips `status` to `reviewed` and records `reviewedBy:`/`reviewedOn:`. Anything still
   open stays `draft`. **The facilitator never ratifies in a review session** — that is the next
   gate, and it is not theirs to run.
3. **The ratification gate → `ready-to-implement`.** Human, per-slice, and *typically
   multi-person*: the ratifier plus whoever will own the build. `em slice ratify <model>.em <key>
   --by <name>` ([cli.md](cli.md#em-slice-ratify-file-slice-key---by-name)) makes the sign-off one
   mechanical edit recording `ratifiedBy:`/`ratifiedOn:`, and it **refuses a doc that never passed
   through `reviewed`** unless `--skip-review` is passed (which prints a loud notice on stderr and
   writes nothing about the skip into the doc). The "multi-person" part is routed by the platform,
   not by `em`: put a [CODEOWNERS](ci.md#codeowners-routing-ratification-review) rule on
   `slices/**` naming your ratifiers, so the edit itself can't merge without their review.
   Confirm readiness mechanically with `em validate <model>.em --slice-ready <key>`.
4. **The merge → `implemented`.** Not a gate — bookkeeping. The implementing agent or engineer
   runs `em slice mark-implemented <model>.em <key> <pr-url>` at merge; the human checkpoint here
   was the PR review, which already happened.

A **continuation slice** (MIL-208 — a later `view X again` instance with no doc of its own)
skips all four statuses and both gates above: it inherits the originating slice's status
wholesale, since it isn't a spec unit to review, ratify, or mark implemented separately. See
[slice-doc-schema.md](slice-doc-schema.md#continuations).

**Re-ratification** re-enters the loop rather than repeating it: `em slice reratify <model>.em
<key>` ([cli.md](cli.md#em-slice-reratify-file-slice-key)) bumps `version:`, returns a shipped doc
to `ready-to-implement` (a ratified doc that never shipped, MIL-258, is already there and keeps
its status), and clears both the old sign-off and the old review record (neither
describes the new version). A `em slice ratify --by <name>` following a `reratify` **does not need
a fresh review session** — the doc is already `ready-to-implement`, which the review gate accepts;
the delta was decided when it was written into the `## Delta` section.

Why two gates and not one: "the room understood this slice" and "we commit to building this
slice" are different decisions, made by different people, often days apart. Collapsing them means
whoever facilitated the review also authorized the build — which is exactly the failure the
one rule at the top of this document exists to prevent.

## Model versions

Every slice carries its own `version:`, but nothing above names *the model as a whole* — until
now (MIL-218). Two facts, kept deliberately separate, because they answer different questions:

- **Design version** — what was *decided*. An explicit, human-bumped integer, same identity
  discipline as ratification: `em model version bump <model>.em --by <name>`
  ([cli.md](cli.md#em-model-version-bump-file---by-name)). Bump it when the structure changes
  (a slice added or removed, a seam changed) or when a batch of slice deltas is ratified
  together — the same judgment call that decides "is this worth a changelog entry."
- **Certified version** — what was *proven*. Set by a full (non-`--partial`) `em state
  set-conformance` ([cli.md](cli.md#em-state-set-conformance-revision-dir)): "design version N was certified
  at revision R on date D." A `--partial` marker never certifies. Certification only applies to
  an already-bumped design version — it names what conform actually walked, never a guess.

Both facts live in a sidecar manifest per design version, `model-versions/v<N>.json` (history,
not progress — see [model-versions.md](model-versions.md) for the shape), pointed to from two
new bullets in `.event-modeling.md`: `Model version:` and `Certified:`.

**`em` warns, never auto-bumps.** If the slice-version vector or the `.em` file's own content
has moved since the last bump, `em status`, `em validate` (`model-version-stale`), and `em slice
ratify`/`reratify` all say so — on stderr or in their JSON — but nothing forces a bump. The same
"humans ratify, tools verify" rule the rest of this document holds: a design version is a
deliberate checkpoint the team calls, not a side effect of an unrelated edit.

## Seams between models: who does what

A project with several models (one per team or bounded context, each in its own directory, see
[cli.md, Multi-model projects](cli.md#multi-model-projects)) has seams: one model's translation
reads another model's `public` event or view. A seam is a promise between two teams, and the
same rule holds across it: agents propose, humans ratify. Here the people who ratify are the
teams on *both* sides. Since 1.14 the model is the single authority for that promise. The
producer's model generates the contract, and the consumer's model declares what it reads. Review
is routed and enforced along the seam, and no model's version number has to move.

```mermaid
flowchart LR
    P["1. Producer marks<br/>an element public"] --> G["2. em api generate<br/>writes the contract"]
    G --> C["3. Consumer declares<br/>consumes on a translation"]
    C --> O["4. em system codeowners<br/>routes consumers onto the contract"]
    O --> A["5. API-first gate<br/>--slice-ready, ratify --meaning-unchanged"]
    A --> X["6. em system<br/>consumer adaptation"]
    X --> S["7. em system scope<br/>the PR gate"]
```

1. **The producer marks an element `public`.** A `command` (the write API), `event` or `view`
   that another team or client depends on gets `public`. Its fields must then use the strict
   public type table (or `X[]`, or a declared `type`), or `em validate` errors with
   `public-field-type-unresolved` ([dsl.md](dsl.md#strict-public-types)). Two public elements of
   one kind cannot share a name (`public-name-not-unique`).
2. **`em api generate` writes the contract.** `em api generate <model>.em` turns the public
   surface into `<model dir>/contracts/<model key>.tsp`, committed with the model change and
   never edited by hand ([cli.md](cli.md#em-api-generate)). The header names its source and
   carries no source hash, so an internal edit never changes the file. `em api check <model>.em
   --base <rev>` fails when the committed file is stale and annotates each public-surface change
   `additive` or `breaking` for the reviewer.
3. **The consumer declares `consumes`.** The consuming model writes the dependency on its own
   translation: `translation Order Intake consumes checkout:event.order-submitted`
   ([dsl.md](dsl.md#consuming-another-models-public-surface)). `em validate` checks only the
   grammar. `em system` resolves the ref across models, from a `system.yaml` (schema 2.0: the list
   of models) or by discovering every tracked `.em` in the repository, and reports unknown models,
   unknown or non-public elements, public elements nobody consumes, and translations bound to
   nothing.
4. **`em system codeowners` routes review.** Each model header names its owning team
   (`model "Checkout" owner "@example/storefront"`). `em system codeowners` writes a managed
   CODEOWNERS block that puts that team on the model directory and *every consuming team* on
   the producer's contract file. With branch protection set to require code-owner review, a
   change to the public surface cannot merge without the teams that depend on it
   ([ci.md](ci.md#seams-consuming-teams-on-the-producers-contract)).
5. **The API-first gate.** A *public-touching* slice owns a `public` command, event or view.
   `em validate --slice-ready <key>` reports such a slice not ready until the committed contract
   matches the model (`slice-ready-contract-stale`; the message names the regenerate command).
   Ratifying or re-ratifying it also answers the meaning question: `--meaning-unchanged`, or
   `--contract-change "<why>"` when a consumer must read the change differently. `em slice
   ratify`/`reratify` refuse without one of the two, and record it as `meaningConfirmed:` or
   `contractChange:` frontmatter. A slice that owns a `public` command also needs that command's
   invariants declared in the model before it is ready
   (`invariants/public-command-without-invariants` is a warning scoped to the slice, and
   `--slice-ready` counts warnings).
6. **`em system` checks consumer adaptation.** Every `consumes` binding's translation fields are
   compared with the producer's public element at HEAD. A field the consumer declares that the
   producer removed, renamed or retyped is the error `consumer-not-adapted`, naming both sides
   and the producer commit. It blocks the release until the consumer is updated. A producer
   change that only adds fields stays clean, because consumers tolerate unknown fields (the
   contract says so in its doc comment). `em status` shows the count without failing.
7. **`em system scope --base <rev>` is the PR gate.** It maps every changed path to a model by
   directory and fails (`seam-crossing`) when one change set alters a producer's public surface
   or contract file *and* the design directory of a model that consumes it. Other multi-model
   change sets, new public surface nobody consumes yet, and code spanning a seam only warn.
   Commits made by `em upgrade --apply` (the `Em-Upgrade:` trailer) are exempt. There is no
   override flag or trailer: a change that must cross goes through review, with the producer's
   contract change merged on the consumers' approval and the consumer's adaptation following in
   its own change set ([ci.md](ci.md#em-system-scope-the-seam-crossing-gate)). The design
   skill runs the same check with `--staged` before it commits.

`em ci init <system.yaml>` installs all of it as one workflow: per-model `validate` and
`api-check` jobs, plus the `codeowners-check`, `system` and `system-scope` PR gates
([ci.md](ci.md#multi-model-gates)).

| Step | Who does it | Mechanical part | Human decision |
|---|---|---|---|
| 1. Mark `public` | Producer's design session (agent proposes, team ratifies the model change) | `em validate` strict types, unique public names | **Which elements are a promise to other teams** |
| 2. Generate the contract | Whoever edits the public surface, in the same commit | `em api generate`, `em api check` | — |
| 3. Declare `consumes` | Consumer's design session | `em validate` grammar; `em system` resolution | **What the consumer depends on** |
| 4. Route review | Model owners, once and on change | `em system codeowners [--check]` | **Choosing each model's owner handle; enabling "Require review from Code Owners"** |
| 5. API-first gate | Ratifier of a public-touching slice | `--slice-ready` contract check; ratify/reratify refusal | **Signing the ratification; answering the meaning question** |
| 6. Consumer adaptation | CI, on every PR; the consuming team fixes | `em system` (`consumer-not-adapted`) | Consumers review the adaptation |
| 7. Scope gate | CI, on every PR; the design skill before committing | `em system scope --base` / `--staged` | **Consuming teams approve a contract change** (review is the only override) |

A design session never edits another model to make a seam work. A change it needs from a
producer becomes a seam change request in its own model's Decisions log (see
[Where humans are required](#where-humans-are-required-and-why)), and the producer's team
decides.

## The lifecycle, by responsibility

Same seven stages, same numbering, as [workflow.md](workflow.md) — this table adds the
responsibility columns:

| Stage | What happens | Who decides | What's mechanical |
|---|---|---|---|
| 1. Build the model | Facilitated sessions produce the timeline: events, commands, views, slices | **Humans in the room** — the AI facilitates and scribes, never invents a domain fact | Rendering, live view, validation |
| 2. Specify the slices | Each slice deepened: field contracts, invariants, Given/When/Then; then walked in a review session (`status: reviewed`) | **Humans answer**; the AI asks and drafts (`status: draft`) | Field-completeness warnings, `em slice review` |
| 3. Gate in CI | The committed model validated on every PR that touches it | — | `em validate` as a merge gate |
| 4. Hand off | **Humans ratify** the reviewed slice (status → `ready-to-implement`); then an **agent or engineer builds it, humans review the PR** | Ratification is human; the build is agent-suitable | `em slice ratify` (refuses an unreviewed doc), `em validate --slice-ready`, `em export`, the bridge |
| 5. Track change | Model diffs reviewed; changelog for the business | Humans review | `em diff`, `em changelog`, `em ledger` |
| 6. Check (conform) | Code checked against the model on a cadence; findings reported | Agent walks the code — **advisory only** | `em diff --json`, `driftSignal` |
| 7. Rule on the findings | Every finding gets a human ruling, logged with a date | **Humans** | `em validate --list-issues` keeps rulings visible |

Stages 1–2, the ratification gate inside 4, and stage 7 are where the humans are
load-bearing. The build half of stage 4 and the sweep half of stage 6 are where agents earn
their keep — bounded work, mechanical gates on both ends, human review of the result.

```mermaid
flowchart LR
    classDef human fill:#e0d4f7,stroke:#6b46c1,color:#1a1a1a
    classDef agent fill:#d4ecf7,stroke:#2b6cb0,color:#1a1a1a
    classDef mech fill:#e2e8f0,stroke:#4a5568,color:#1a1a1a

    S12["1-2. Build & specify<br/>humans in the room"]:::human --> S3["3. Gate<br/>em validate in CI"]:::mech
    S3 --> S4a["4. Ratify a slice<br/>human sign-off"]:::human
    S4a --> S4b["4. Implement<br/>agent-suitable, PR reviewed"]:::agent
    S4b --> S5["5. Track<br/>humans review the diff"]:::human
    S5 --> S6["6. Conform sweep<br/>agent gathers evidence, advisory only"]:::agent
    S6 --> S7["7. Rule on the findings<br/>humans rule on every one"]:::human
    S7 -.->|"model updated"| S12
```

Purple is a human decision, blue is agent-suitable work reviewed by a human, gray is a
mechanical gate with no judgment call in it.

## Where humans are required, and why

- **Building the model (stages 1–2).** The knowledge being modeled lives in people's heads —
  the whole point of a session is extracting and *reconciling* it across stakeholders,
  product, and engineering. An AI facilitator asks good questions and keeps the diagram
  honest; it cannot know your business, and the skill is built never to pretend it does
  (anything unresolved is parked as a visible open question, not guessed).
- **Ratifying slices (the stage-4 gate).** A slice that reaches an implementer with
  unresolved questions gets those questions answered *by the implementer, silently* — the
  exact failure the gate exists to prevent. Ratification is cheap (a review and a status
  flip) precisely so it never gets skipped.
- **Ratifying the implementation constitution.** The project's house rules — stack, code style,
  testing norms, NFR baselines, review norms — are decisions about how *this team* builds, and an
  agent that assumes them has quietly made them. The implement skill asks the questions and drafts
  the answers; the document isn't in force until a named human ratifies it (empty `ratifiedBy:` =
  draft). See [Handing a slice to an agent](#handing-a-slice-to-an-agent).
- **Ruling on drift (stage 7).** Only a human can say whether the code or the model is right
  when they disagree — that's a business judgment, and the conform phase is deliberately
  advisory because a false accusation of drift destroys trust in the loop faster than real
  drift justifies it.
- **Owning a seam.** Choosing each model's `owner` handle, and turning on "Require review from
  Code Owners" so the generated CODEOWNERS entries actually gate merges, are decisions `em`
  cannot make: it routes review, the platform enforces it, and people decide who those people
  are. Answering the meaning question when ratifying a public-touching slice
  (`--meaning-unchanged` or `--contract-change "<why>"`) is the ratifier's call too; an agent may
  recommend one but never picks it on the ratifier's behalf. See
  [Seams between models](#seams-between-models-who-does-what).
- **Changing another model's public surface.** A design session is bound to the model directory
  it started in and never writes under another model's directory or its contract file
  (MIL-236). When a question can only be resolved by a producer changing a `public` element,
  the agent records a **seam change request** in its own model's `.event-modeling.md` Decisions
  log — `- YYYY-MM-DD: seam change request → <producerKey>:<kind>.<slug> — <what> — <why>`, a
  dated bullet so `em changelog` reports it — and leaves the question open, blocked on the
  producer's owners. Taking the request to those owners, and their decision, is human work.
  Before committing, the design skill runs `em system scope --staged` and
  `git diff --cached --name-only` and stops on a seam crossing, a path outside the model
  directory, or a derived artifact (generated contracts other than an `em api generate` run
  after marking an element `public`, `specs/`, `.specify/`, implementation source, `plugin/`,
  a draft's `version:`).

## Where agents do the work, with human review

- **Facilitation support** — asking, scribing, rendering, validating, keeping the state file.
  The humans decide; the agent types.
- **Drafting** — an agent may draft slice docs (`status: draft`), park incoming needs, and
  propose model edits for a session to take up. Proposals, not commits.
- **Implementation (stage 4)** — once a slice passes the readiness gate, implementation is
  agent-suitable end to end: the slice doc is a complete brief, the invariants and scenarios
  compile to tests, and the PR review is the human checkpoint. Before a project's first slice
  PR, a one-time foundation PR puts every model event (and the constitution's shared interface
  shell) in place, so no slice PR ever carries another slice's contracts. The bundled skill
  ships the full contract an implementing agent must follow —
  [the agent guide](../.claude/skills/event-modeling-implement/reference/implement.md) — including the
  readiness gate, the foundation step, the read-only rule on ratified docs, the propose-don't-decide
  rule for gaps, the lifecycle flip at merge, and the spec-kit adapter.
- **The conform sweep (stage 6)** — an agent gathers the evidence and writes the report;
  every verdict in it is a proposal for stage 7.

## Handing a slice to an agent

The short version of the [agent guide](../.claude/skills/event-modeling-implement/reference/implement.md),
for the human doing the handing:

0. **Once per project, before the first slice: the constitution exists and is ratified.** The
   implementation constitution is the project's house rules for *how* implementation happens —
   stack and architectural shape (including which implementation skill each slice pattern routes
   to), code style, testing norms, NFR baselines, review and merge norms. It lives in exactly one
   place: `.specify/memory/constitution.md` in a spec-kit project, otherwise `constitution.md`
   beside the model (`em scaffold` writes the template there). The implement skill elicits it in a
   short conversation and drafts the answers; **a named human signs it off** — `ratifiedBy:`/
   `ratifiedOn:` in the em-native file, spec-kit's own `**Ratified**:` footer in
   `.specify/memory/constitution.md`. An empty `ratifiedBy:` means draft, and an implementing
   agent is told to stop rather than decide the project's stack or style for you.
   `em status` reports it per model (`constitution: present` / `absent (<path>)`) — existence
   only; `em` never reads or judges its content. See
   [cli.md](cli.md#em-status-files) and the agent guide's §7.
1. Ratify the slice — `em slice ratify <model>.em <key> --by <name>` (status →
   `ready-to-implement`, records who/when), open questions resolved — and confirm:
   `em validate <model>.em --slice-ready <key>` exits 0. Ratification comes *after* the review
   gate (`em slice review`, status → `reviewed`); `ratify` refuses a doc that skipped it unless
   you pass `--skip-review`. See [The slice lifecycle gates](#the-slice-lifecycle-gates). For a
   public-touching slice, run `em api generate <model>.em` first and add `--meaning-unchanged`
   or `--contract-change "<why>"` to the ratify call (see
   [Seams between models](#seams-between-models-who-does-what)).
2. Point the agent at the slice doc and the guide. If the repo pins the `em` plugin (or still
   vendors the skill bundle), the guide is already there; otherwise `em contract` prints it.
3. Review the PR like any other — plus two model-side checks: the slice doc's only edits are
   the merge-time `status`/`implementedIn` flip, and no new spec-shaped artifacts got
   committed as sources of truth.
4. The implementing agent stays on its side of the seam: it never edits another model's
   directory, slice docs or contract file. A change it needs from a producer goes back to the
   design session as a seam change request (see
   [Where humans are required](#where-humans-are-required-and-why)).

If the project uses spec-kit, the agent allocates through
[em-sdd-bridge](https://github.com/milehimikey/em-sdd-bridge) instead of running
`/speckit.specify` — the ratified slice doc itself is the spec, symlinked into the spec dir
(redirect mode). [em-sdd-preset](https://github.com/milehimikey/em-sdd-preset) packages the
templates and prompt overlays that make spec-kit's plan/tasks phases read a slice doc
natively. Both are separate, versioned packages; their READMEs are the reference — `em`'s own
docs deliberately don't duplicate them.

### Engagements: who operates the agents

When the work is a whole chunk of the model rather than one slice,
[`em engagement`](cli.md#em-engagement) names the slices, levels them, and keeps a Ledger (the
[schema](engagement-schema.md)), and the
[`event-modeling-engagement`](../.claude/skills/event-modeling-engagement/SKILL.md) skill builds
them through em's four sub-agents. The roles do not change; they are named here.

- **The engagement lead is the implementing-agent operator.** The lead session dispatches
  `em-implementer`, `em-validator`, `em-reviewer` and `em-critic`, cuts one worktree per slice
  under `.claude/worktrees/` (that directory must be gitignored), records every step with
  `em engagement set`, and never writes slice code itself. Its follow-up branches are named
  `engagement/<slug>-level-<n>`.
- **The ratifier is not the operator.** Whoever ratified a slice still did not run its build;
  the lead never ratifies, never edits a ratified doc beyond the merge-time flip, and never
  merges.
- **The human merges, bottom-up, with merge commits.** The lead hands over the stack at
  `awaiting-merge`. While a dependent PR is open its base is merged with a merge commit, never
  squashed (the agent guide's §8 rule 2a); a squash is fine only for a PR with no open dependent.
  The constitution's `- **Merge strategy:** merge-commits-when-stacked` line says so, and the
  engagement skill refuses to run without it.
- **The constitution picks the models and the test command.** Its `- **Agent models:**` line
  assigns a model per sub-agent (the critic on a different model from the implementer) and its
  `- **Test command:**` line is what the validator runs; both are plain-text lines the template
  prompts for. See the [constitution template](../.claude/skills/event-modeling-shared/templates/constitution.md).

## What the tool enforces vs. what it leaves to you

`em` is strict about what is unambiguously wrong (structural errors fail `em validate`;
readiness is a hard gate when you invoke it) and advisory about everything that requires
judgment (warnings, conformance findings, ledger checks are all opt-in or non-blocking — the
full table is in [workflow.md](workflow.md#which-parts-enforce-and-which-advise)). The
pattern is the same rule again: mechanical checks gate mechanical properties; humans ratify
judgments. A model is a description of a business, and no tool gets to overrule you about
your own business.
