# Evaluating PRD/spec to model quality

The protocol for measuring whether em's deterministic fixes (rules, lints, the skill's decomposition guidance) are enough, and whether Jev (typed decisions in skills, vault note `jev-for-em`) is ever worth adding. Run it on real PRD/spec pairs at the day job; run the public set here as a smoke test in em's own CI.

> Lives at `eval/` (not `internal/eval/`): `internal/` is gitignored wholesale, and the protocol and its public inputs must be committed.

Hypotheses, kept separate:

- **H0** The pipeline alone (skill, rules, lints) removes most of the problem.
- **H1** Jev classifies more consistently across reruns than the LLM does on the same rubric.
- **H2** That consistency yields better models.

The Jev spike (Linear MIL-252, GH #300 index) is gated on this protocol's result. Do not start it before arm C is scored.

## Layout

```
eval/
  README.md                  this protocol
  score.mjs                  over-decomposition + entity-clustered + event recall, from `em export`
  templates/recording.md     one copy per input x arm x rerun
  templates/results-summary.md   what comes back from the day job (no inputs in it)
  inputs/<name>/input.md         the PRD / spec text given to the session
  inputs/<name>/reference.em     the reference slicing
  inputs/<name>/reference.json   business reactions -> expected slice keys (+ business events)
```

Public set: `meridian-goods` (PRD), `library-lending` and `support-desk` (synthetic PRDs), `inventory-api` (API-spec shape, with a `## Walkthroughs` section). Real pairs stay at the day job; only their summaries come back.

## Arms

Run in order and stop when the improvement flattens (two consecutive arms whose primary metric differs by under 0.1 on every input).

| Arm | Configuration |
| --- | --- |
| A | Today's skill bundle, as shipped. The baseline. |
| B | A + the outcome rule + the `automation-split-by-outcome` lint in the loop. |
| B' | B + the storyline rules (GH #276) + the `timeline-entity-clustered` lint (GH #281). Measured separately so the storyline fix is attributable. |
| C | B' + the PRD/spec path (GH #295): the input is read as a PRD or spec, not as a conversation. |
| D | C + Jev grouping/classification. Only if the rerun-agreement trigger below fires. |

Pin everything not under test: same em CLI version per arm (record it), same model, same effort setting, same input text, fresh session, no prior model on disk, no shared context between runs. The reference slicing is never shown to the session.

## Reference slicing

Each input has `reference.em` (a valid, clean model: `em validate` reports no issues) and `reference.json`:

```json
{
  "input": "library-lending",
  "reactions": [
    { "name": "A book is returned at the desk", "slices": ["return-book", "active-loans-after-return"], "events": ["Book Returned"] }
  ]
}
```

A business reaction is one observable thing the business does or sees in response to something happening (a customer cancels, a stale ticket is escalated, staff see open orders). `slices` lists the reference slice keys that realize it (the command slice plus the view slice that follows it, an automation's feeding view plus the reaction slice, and so on). `events` lists the business events it records. The reference slicing is authored once by a human and reviewed against the input; it does not change between arms.

## Metrics

Mechanical metrics are computed by `score.mjs` from `em export` of the produced model:

```
em export produced.em > produced.json
node eval/score.mjs produced.json eval/inputs/<name>/reference.json --json
```

| Metric | Kind | Definition |
| --- | --- | --- |
| **Over-decomposition rate** (primary) | mechanical | Produced slices divided by reference slices, i.e. slices per business reaction relative to the reference slicing. 1.0 = same granularity, 1.5 = half again as many slices. Report `extraSlices`/`missingSlices` for diagnosis; slice keys are matched exactly, so a renamed-but-equivalent slice shows as one extra and one missing and is reconciled by the human at scoring time (note it in the recording sheet). |
| Implementation-flavoured element rate | human-labelled | Share of produced commands, events and views whose name or fields describe the implementation (`UpdateRecord`, `RowInserted`, `*DTO`, HTTP verbs, table names) rather than business intent. Two labels per element: business or implementation; label blind to the arm. |
| Business-event recall | mechanical | Reference business events (`reference.json`) found by name in the produced model, divided by reference business events. Name match is normalized (case and punctuation); the human resolves near-misses. |
| Human-routing rate | human-recorded | Share of decisions the session escalated to the human (questions asked, STOP/gate prompts) per slice produced. Count from the transcript. |
| Cost per input | recorded | Input plus output tokens (or dollars) for the whole session, plus wall-clock minutes and the number of em CLI calls. |
| **Entity-clustered rate** | mechanical | Share of State Change slices inside a run of at least 3 consecutive same-context slices followed by exactly one trailing view with no cross-context read. This is what the `timeline-entity-clustered` lint counts. Until GH #315 exposes it in `em validate --json`, `score.mjs` computes it from the export: walk slices in `index` order; a run is a maximal sequence of State Change slices whose first event shares one context; the run counts if it has length of at least 3, the next slice is a State View, and every source event of that view belongs to a slice in the run. 0 is good: slices follow the timeline, not the entity. |
| Intent-named-command rate | human-labelled | Share of commands named for the user's intent (`Cancel Order`, `Resolve Ticket`) rather than a CRUD verb on an entity (`Update Order`, `Set Status`). Label blind to the arm. |
| Read-models-per-information-need | human-counted | Views produced divided by distinct information needs in the input. A view whose only consumer is a nested-route screen of another view's entity counts as redundant (a second view for the same need). 1.0 is ideal. |

Two humans label the human-labelled metrics on a 20% sample of the elements for the first input of each arm and report percent agreement; below 0.8, tighten the labelling guide before continuing.

## Rerun agreement

Per input, per arm: three fresh sessions, no shared context, identical configuration. Save each produced model as `run1.em`, `run2.em`, `run3.em`.

1. Slice counts: `producedSlices` from `score.mjs` (or `model.slices.length` in `em export`) for each run.
2. Pairwise `em diff --json` between the models: (1,2), (1,3), (2,3). Record added, removed and changed counts per pair; a diff of zero changes means identical.
3. Record the spread = max slice count minus min slice count.

**Pre-registered threshold (set before any run):** if, after arm C, the slice counts differ by more than 2 across the three reruns on any input, arm D (Jev) is triggered for that input class. If the spread is 2 or less on every input after C, H1 is not supported and arm D is not run: the LLM is consistent enough on the same rubric. Record the arm-C spread on every input whether or not the trigger fires.

## Procedure

1. Pick the arm configuration; record em version, skill bundle version, model, effort.
2. For each input and each of three reruns: fresh session, give only `input.md` (plus the arm's skill configuration), let the session produce the model, save `runN.em`, fill in a `templates/recording.md` copy.
3. Score: `em validate runN.em`, `em export`, `score.mjs`; human labels; rerun-agreement diffs.
4. Fill in `templates/results-summary.md` per arm. It carries only numbers and short quotes of element names; never the input text.
5. Decide the next arm by the stopping rule above.

## Decision

Report per arm: median over reruns of the primary metric per input, the spread, and the secondary metrics. H0 holds if arm C (or earlier) reaches over-decomposition within 1.0 to 1.25 on every input with a rerun spread of 2 or less. Otherwise arm D is justified, and only then does the Jev spike start.

## Smoke test

`test/evalScore.test.ts` runs `score.mjs` over the public set in CI: each reference model scored against its own `reference.json` must give an over-decomposition rate of 1.0, full event recall and an entity-clustered rate of 0.
