# Evaluating PRD/spec to model quality

The protocol for measuring whether em's deterministic fixes (rules, lints, the skill's decomposition guidance) are enough, and whether Jev (typed decisions in skills, vault note `jev-for-em`) is ever worth adding. Run it on real PRD/spec pairs at the day job; the public set here backs a smoke test in em's own CI.

> Lives at `eval/` (not `internal/eval/`): `internal/` is gitignored wholesale, and the protocol and its public inputs must be committed.

Hypotheses, kept separate:

- **H0** The pipeline alone (skill, rules, lints) removes most of the problem.
- **H1** Jev classifies more consistently across reruns than the LLM does on the same rubric.
- **H2** That consistency yields better models.

The Jev spike (Linear MIL-252, GH #300 index) is gated on this protocol's result. Do not start it before arm C is scored.

## Layout

```
eval/
  README.md                      this protocol
  score.mjs                      slices per reaction, entity-clustered rate, event recall, from `em export`
  templates/recording.md         one copy per input x arm x rerun
  templates/results-summary.md   what comes back from the day job (no inputs in it)
  inputs/<name>/input.md         the PRD / spec text given to the session
  inputs/<name>/reference.em     the reference slicing
  inputs/<name>/reference.json   business reactions -> reference slice keys (+ business events)
```

Public set: `meridian-goods` (PRD), `library-lending` and `support-desk` (synthetic PRDs), `inventory-api` (API-spec shape, with a `## Walkthroughs` section). Real pairs stay at the day job; only their summaries come back.

## Arms and setup recipe

The 1.18.0 lints, storyline rules and outcome rule ship together with no per-feature toggle, so the issue's arms B and B' collapse into one. Always run A, B and C: they test different fixes. Only the rerun-agreement trigger decides whether D runs.

| Arm | em CLI | Skill bundle (plugin) | Entry point |
| --- | --- | --- | --- |
| A | `@milehimikey/em@1.17.0` | marketplace `milehimikey/em@v1.17.0`, plugin `em@em-1-17-0` | `/em:discover` |
| B | `@milehimikey/em@1.18.0` | marketplace `milehimikey/em@v1.18.0`, plugin `em@em-1-18-0` (lints + storyline rules + outcome rule) | `/em:discover` |
| C | as B | as B | the PRD/spec path of the discover skill (GH #295). If #295 ships inside 1.18.0, C is B invoked through that entry point; otherwise C is the first release that carries it (use that release's pin and say so in the recording). In that case C differs from B in both CLI/bundle version and entry point, so the C-versus-B comparison is not clean; say so in the verdicts. |
| D | as C | C + Jev grouping/classification | Only if reached (see Rerun agreement) |

Setup per arm (the pin must be the only difference between arms):

```bash
export CLAUDE_CONFIG_DIR=$(mktemp -d)        # fresh profile: no user CLAUDE.md, no memories
export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1     # auto-memory off; if your Claude Code build lacks this switch, the fresh profile above still has no memory
claude auth login                             # a fresh CLAUDE_CONFIG_DIR has no credentials; log in once (or `/login` inside claude)
claude plugin marketplace add milehimikey/em@v1.18.0 --scope user
claude plugin install em@em-1-18-0 --scope user
npm install --prefix "$CLAUDE_CONFIG_DIR/em" @milehimikey/em@1.18.0
export PATH="$CLAUDE_CONFIG_DIR/em/node_modules/.bin:$PATH"
em --version                                  # must print the arm's pin
```

Use the arm's own version in every line (for A: `v1.17.0`, `em-1-17-0`, `1.17.0`). Record `em --version`, the plugin version and the model/effort in the recording sheet.

### Context-leak controls (all required)

- Work directory is a new empty directory outside any git repo (`mktemp -d`); it holds only a copy of `input.md`.
- Fresh profile as above: a profile with no auto-memory and no user CLAUDE.md. No project CLAUDE.md or AGENTS.md; no pre-existing `.event-modeling.md`, `.em` files or `slices/`.
- The reference slicing, other arms' outputs and previous reruns are never reachable from the work directory.
- Same model and effort setting for every run; a new session for every run.

### Fixed opening message and answering rule

Opening message, verbatim (arm A and B use the first form; arm C uses the second):

```
Run /em:discover on input.md and produce <slug>.em; do not ask me about anything input.md already answers.
```

```
Run /em:discover on input.md as a PRD/spec (the PRD/spec path) and produce <slug>.em; do not ask me about anything input.md already answers.
```

Operator answering rule: answer only from `input.md`. If `input.md` does not say, reply exactly:

```
not specified — choose the simplest business reading and record it
```

Every question the session asks, and every STOP/gate prompt, is counted for the human-routing rate, whether or not input.md answers it. Do not volunteer information or hint at decomposition. Approve routine tool permissions without comment.

## Reference slicing

Each input has `reference.em` (a valid, clean model) and `reference.json`:

```json
{
  "input": "library-lending",
  "reactions": [
    { "name": "A book is returned at the desk and leaves the member's loans", "slices": ["return-book", "active-loans-after-return"], "events": ["Book Returned"] }
  ]
}
```

A business reaction is one observable thing the business does or sees in response to something happening. Grouping rule: a reaction is the command slice that records it plus the view slice that follows it (an automation reaction is its feeding view, the reaction slice and any view after it; a view that nothing records, such as a standing dashboard, is its own reaction). `events` lists the business events it records.

**Building references for the real pairs.** A human author writes `reference.em` and `reference.json` from the PRD/spec alone, before any arm runs and blind to every arm's output. The existing day-job model is not the reference: it is the CRUD artifact under study. A second person reviews the reference against the input. Pre-check, mandatory before any arm runs:

```
em validate reference.em                      # no errors or warnings
em export reference.em > ref-export.json
node eval/score.mjs ref-export.json reference.json    # slices per reaction == reference, slice ratio 1.00, recall 1.00, clustered 0.00, extra/missing empty
```

The reference is frozen once an arm starts. Record the author and the blindness in the results summary.

## Metrics

Mechanical metrics come from `score.mjs` over `em export` of the produced model:

```
em export produced.em > produced.json
node eval/score.mjs produced.json eval/inputs/<name>/reference.json [--aliases aliases.json] [--json]
```

`aliases.json` maps a produced slice key to the reference slice key it is equivalent to (`{"combine-ticket": "merge-ticket"}`), decided by a human, so renames are reconciled explicitly. Aliases only reconcile the `extraSlices`/`missingSlices` lists: the produced slice count, and so the primary metric, is always taken from the raw keys and an alias can never lower it. `score.mjs` rejects a many-to-one alias map and an alias onto a key the produced model already has. The number of aliases used is reported and is itself a signal (many aliases means the produced slicing shares little vocabulary with the reference).

| Metric | Kind | Definition |
| --- | --- | --- |
| **Slices per business reaction** (primary) | mechanical | Produced slices (raw count) divided by the reference's business reactions. Compare with the reference's own value (`referenceSlicesPerReaction`). Higher than the reference means over-decomposed, lower means under-decomposed. |
| Slice ratio | mechanical, secondary | Produced slices / reference slices (1.00 = same granularity). Reported with `aliasesUsed`, `extraSlices` and `missingSlices`. |
| Implementation-flavoured element rate | human-labelled | Share of produced commands, events and views whose name or fields describe the implementation (`UpdateRecord`, `RowInserted`, `*DTO`, HTTP verbs, table names) rather than business intent. Label blind to the arm. |
| Business-event recall | mechanical | Reference business events found by name in the produced model, divided by reference business events (normalized for case and punctuation; `aliases.json` maps slice keys only, so event near-misses are noted by hand in the recording sheet and counted as found only if the human says so; no event aliases). |
| Human-routing rate | human-recorded | Questions asked and STOP/gate prompts the session raised, per slice produced. |
| Cost per input | recorded | Input plus output tokens (or dollars) for the whole session, wall-clock minutes, em CLI calls. |
| **Entity-clustered rate** | mechanical | Share of State Change slices inside a run of at least 3 consecutive same-context slices with one trailing view and no cross-context read. The `timeline-entity-clustered` lint (GH #281) should match this count; confirm on the first real run, and once GH #315 exposes it in `em validate --json` prefer that number and report any disagreement. `score.mjs` computes it from the export: walk slices in `index` order; a run is a maximal sequence of State Change slices whose first event shares one context; the run counts if its length is at least 3, the next slice is a State View, and every source event of that view belongs to a slice in the run. 0 is good. |
| Intent-named-command rate | human-labelled | Share of commands named for the user's intent (`Cancel Order`, `Resolve Ticket`) rather than a CRUD verb on an entity (`Update Order`, `Set Status`). Label blind to the arm. |
| Read-models-per-information-need | human-counted | Views produced divided by distinct information needs in the input; a view whose only consumer is a nested-route screen of another view's entity is redundant. 1.0 is ideal. |

Two humans label the human-labelled metrics on a 20% sample of elements for the first input of each arm and report percent agreement; below 0.8, tighten the labelling guide before continuing. Record the agreement in the results summary.

## Rerun agreement

Per input, per arm: three fresh sessions with the identical setup above and no shared context. Save the models as `run1.em`, `run2.em`, `run3.em`.

1. Slice counts: `producedSlices` from `score.mjs` for each run. Spread = max minus min.
2. Pairwise `em diff --json` between runs (1,2), (1,3), (2,3). The diff matches slices and elements by key, so it is diagnostic only: a renamed slice appears as one removed and one added. Record from `counts`: added = `slicesAdded` + `elementsAdded` + `typesAdded`; removed = `slicesRemoved` + `elementsRemoved` + `typesRemoved`; changed = `fieldChanges` + `fromChanges` + `sourceChanges` + `elementsMoved`. `identical: true` means no differences at all.

**Pre-registered threshold (set in the issue before any run):** if, after arm C, the slice counts differ by more than 2 across the three reruns on any input, arm D (Jev) is triggered for that input class. An input class is a shape of input handled alike (PRD, API spec with walkthroughs, mixed). The size of the threshold is not size-independent: 2 is a larger relative spread on a 6-slice model than on a 40-slice one; it is kept as registered and the model's slice count is recorded next to every spread so the reader can judge.

If the spread is 2 or less on every input after arm C, H1 is moot rather than falsified: there is no rerun inconsistency left for Jev to remove, so arm D is not run. Record the arm-C spread on every input either way.

## Procedure

1. Freeze the references (pre-check above).
2. For arms A, B, C in order, for each input, three reruns: set up per the recipe, send the fixed opening message, follow the answering rule, save `runN.em`, fill in a `templates/recording.md` copy.
3. Score: `em validate`, `em export`, `score.mjs`, human labels, rerun-agreement diffs.
4. Fill in `templates/results-summary.md` per arm.
5. D is decided only by the rerun-agreement trigger above.

## Decision

Report per arm: median over reruns of slices per reaction per input, the spread, and the secondary metrics.

Two separate questions, answered separately:

- **Is H0 met?** H0 holds if arm C lands within 0.9 to 1.25 times the reference's slices per reaction on every input, with business-event recall of at least 0.9 on every input. Both sides of the band matter: under-decomposition (below 0.9) is also a failure.
- **Does Jev run?** Only the pre-registered spread trigger decides: spread above 2 on any input after arm C means run arm D for that input class. If the reruns are consistent (spread 2 or less) but H0 is not met, the problem is not inconsistency: the answer is to fix the deterministic pipeline (rules, lints, skill guidance), not to add Jev. The Jev spike starts only after arm D has been justified by the trigger.

## Smoke test

`test/evalScore.test.ts` runs `score.mjs` over the public set in CI: each reference model scored against its own `reference.json` must give a slice ratio of 1.0 (and a slices-per-reaction equal to the reference's), full event recall, no aliases and an entity-clustered rate of 0. The `support-desk` reference deliberately contains a three-slice same-context run followed by a view with a cross-context read, so the clustered metric's negative case is exercised on a real reference.
