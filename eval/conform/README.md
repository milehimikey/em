# Evaluating conform quality (GH #452)

Extends the eval protocol at `eval/README.md` (GH #296, shipped 1.21.0's `eval/inputs` set —
discover/slicing quality) to the `event-modeling-conform` skill: does a conform walk actually
catch the drift it's supposed to, classify it correctly, and stay quiet on the idioms conform's
own reference doc (`.claude/skills/event-modeling-conform/reference/conform.md`) explicitly
says are *not* drift?

Unlike the discover protocol, conform's output is **not fully mechanical** — the spec surface
(a named invariant with no enforcement site) and the false-positive-bait idiom (a legitimate
non-materialized view) need an agent reading code and exercising judgment, the same way a real
conform run does. So this harness is **documentation-driven**: a human or an agent runs the
real `event-modeling-conform` skill against a seeded fixture and the result is scored by hand
(or by a follow-up agent) against a committed expected-outcome file, using `score.mjs` for the
parts that reduce to a key/value comparison. CI only runs the parts that genuinely are
mechanical (see "What CI actually checks" below) — it does not and cannot run the skill itself.

## Layout

```
eval/conform/
  README.md                 this doc
  score.mjs                 catch rate / classification accuracy / false-positive count
  helpdesk/                 the one seeded-drift case (GH #452) — see below
    model/                  the tiny implemented .em model + slice docs + state file
    repo/                   the toy target codebase, baseline revision
    repo-head/              overlay: the ONE file that differs at HEAD (case a's seed)
    setup.mjs               materializes model/ + a real two-commit git repo from repo/+repo-head/
    expected/
      full-scope.json       what a --full (or first) conform run must/must-not report
      diff-scoped.json      what a Last-conformance-pinned run must/must-not report (narrower)
```

## The `helpdesk` case

A four-slice toy Event Model (open a ticket, escalate it, show a board) with a matching toy
TypeScript codebase, carrying four deliberately seeded findings — the four GH #452 asks:

| Case | Surface | Seed | Slice(s) | Correct classification |
|---|---|---|---|---|
| (a) structural drift | structural | code's `Ticket Escalated` event (and `Escalate Ticket` command) carries `escalationReason`, a field the `.em` never declared | `escalate-ticket` | Real drift |
| (b) spec drift | spec | `slices/open-ticket.md`'s `INV-OPEN-1` ("subject must not be empty") has no enforcement site in `OpenTicketHandler.ts` | `open-ticket` | Real drift |
| (c) internal inconsistency | internal | `slices/ticket-board.md`'s frontmatter says `pattern: automation`; the `.em` classifies the slice `state-view` | `ticket-board` | Internal inconsistency |
| (d) FALSE-POSITIVE BAIT | — | `EscalationWatcher.ts` implements the "Tickets Awaiting Escalation" watched view as a direct `@EventHandler` + criteria-sourced state entity, no materialized projection — the exact idiom `reference/conform.md`'s "Legitimate non-materialized views" names | `tickets-awaiting-escalation` | **No finding at all** |

Full detail, including the exact evidence file/line for each, is in `helpdesk/expected/full-scope.json` and the `## Note for the conform eval` sections of `helpdesk/model/slices/*.md`.

### The diff-scoped requirement (non-negotiable — 2026-07 Wave-4 lesson)

Case (a) is the **only** seed that lands on a changed path between the fixture's two git
commits (`setup.mjs` commits `repo/` as a baseline, then overlays `repo-head/` — which contains
exactly one file, `src/support/escalation/EscalateTicketHandler.ts`). Both docs anchored at
that directory (`escalate-ticket`, `tickets-awaiting-escalation`) share it as their
`implementedIn:`. That's deliberate: it's what lets `--pin-last-conformance` make
`em conform-scope` restrict its candidate set to exactly those two slices, so a diff-scoped
run is **required** to still find case (a) and still correctly withhold the case (d) bait —
while cases (b) and (c) are legitimately out of scope (their files never changed), not missed.
`expected/diff-scoped.json` encodes that narrower bar; `expected/full-scope.json` is the wider
one a `--full` sweep (or a first run, before any `Last conformance:` exists) must clear. Scoring
the diff-scoped run against the full-scope file would wrongly dock it for (b)/(c) — don't.

This is the exact trap the issue calls out: a harness that only ever exercises full-scope never
proves the diff-scoped code path (`em conform-scope`'s `implementedIn`-to-changed-path mapping,
the `Last conformance:` marker parse) actually narrows correctly — which is precisely the kind
of gap that let the 2026-07 Wave-4 validation round miss real bugs.

## Running it

### 1. Materialize the fixture

```
node eval/conform/helpdesk/setup.mjs                         # full-scope run (first-run semantics)
node eval/conform/helpdesk/setup.mjs --pin-last-conformance   # diff-scoped run
```

Prints `{ root, modelDir, repoDir, baseRev, headRev }` as JSON. `modelDir` is a full copy of
`helpdesk/model/` (including `.event-modeling.md`, rewritten in the pinned case so
`Last conformance:` names `baseRev`); `repoDir` is a real two-commit git repo built from
`helpdesk/repo/` + `helpdesk/repo-head/`.

### 2. Run the actual conform walk

In a fresh agent session (same context-leak discipline as `eval/README.md`'s discover
protocol — no access to this file's expected-outcome JSON, no memory of prior runs), point the
`event-modeling-conform` skill at `modelDir/helpdesk.em` with `--repo repoDir`. Follow
`reference/conform.md`'s flow exactly (scope → evidence walk → diff → classify → report +
findings JSON) — this harness does not shortcut or script that part; it exists to score the
output, not to replace the skill.

For the diff-scoped run, the skill's own step 1 (`em conform-scope`) does the scoping; don't
pass `--full` and don't hand the agent the pinned fixture's history beyond what the skill reads
itself. For the full-scope run, either use the unpinned fixture (first-run semantics, no flag
needed) or pass `--full` on the pinned one — both must reach the same `expected/full-scope.json`
bar.

### 3. Score it

The run's own `conformance/<date>-findings.json` (reference/conform.md step 5) is the input:

```
node eval/conform/score.mjs conformance/<date>-findings.json eval/conform/helpdesk/expected/full-scope.json --json
# or, for the diff-scoped run:
node eval/conform/score.mjs conformance/<date>-findings.json eval/conform/helpdesk/expected/diff-scoped.json --json
```

Three readouts, per GH #452:

| Metric | Meaning | Ideal |
|---|---|---|
| `catchRate` | share of `mustReport` entries the run reported at all (same `surface` + `slice`), regardless of classification | 1.0 |
| `classificationAccuracy` | share of `mustReport` entries caught **and** classified with the expected `class` string exactly (a miss counts against this too — it's "did the whole job," not accuracy conditioned on having caught it) | 1.0 |
| `falsePositiveCount` | findings classified `Real drift`/`Model gap` on a slice+surface `mustReport` never names — this is what the case (d) bait is FOR | 0 |

Record the run (model/effort, date, which fixture variant, the raw findings JSON, the score)
the same way `eval/templates/recording.md` records a discover run — there's no dedicated
template here yet; reuse that shape and note "conform" as the phase.

## What CI actually checks

`test/evalConformFixture.test.ts` is the mechanical floor — it does NOT run the skill or judge
an agent's output (nothing here can, by design: cases (b)/(d) are judgment-only). It proves the
fixture itself is sound and that the tool-side half of each mechanical surface works:

- `em validate` fires exactly the one seeded internal-surface diagnostic (case c,
  `doc-model-pattern-mismatch` on `ticket-board`) and nothing else.
- A correctly-authored as-is scratch model (`helpdesk/model/helpdesk-asis.em`, the reference
  rewrite an agent's own evidence walk over `repo-head/` should produce) makes `em diff` report
  exactly the seeded structural change (case a) on `escalate-ticket`, with
  `acceptedDivergence: null` — proving the diff computation itself is right once the scratch
  model is.
- Pinning `Last conformance:` to the baseline commit makes `em conform-scope` return exactly
  `{tickets-awaiting-escalation, escalate-ticket}` as candidates, never `open-ticket` or
  `ticket-board` — the diff-scoped hard requirement, mechanically.
- `eval/conform/score.mjs`'s scoring function itself: perfect/missed/misclassified/false-
  positive findings arrays all score the way the table above says they should, against the
  real committed `expected/*.json` files (so those files are also validated for shape/slice
  names by the same test run).

A green CI run means: the fixture is trustworthy and the scorer's math is right. It says
nothing about whether any particular conform run (human- or agent-driven) actually caught the
seeded drift — that's `score.mjs`'s job against a real findings.json, done by whoever ran the
walk.
