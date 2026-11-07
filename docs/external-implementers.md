# The external-implementer loop

[Handing a slice to an agent](process.md#handing-a-slice-to-an-agent) and
[engagements](process.md#engagements-who-operates-the-agents) both assume the implementer can at
least shell out to `em` — read the slice doc off disk, run `em validate --slice-ready`, write its
own `conformance/bindings/<key>.yaml` having seen `bindings.md`. Some implementers can't do any of
that. A ticket-driven cloud agent (a Jira/Linear-fed coding agent, a vendor's autonomous PR bot)
reads a ticket body, writes code, and opens a PR; it may never run `em`, and it may not even have
this repo checked out at the moment its ticket is assembled. This page is the recipe for that case
— GH #456.

Five steps, each with the exact command. Steps 1 and 2 happen on the tracker's side of the seam
(a human or a bridge tool, not `em`); steps 3–5 are what the repo and the person running `em`
do once the agent's PR lands.

## 1. Brief out

```bash
em engagement brief checkout.em demo --slice place-order --inline-context
```

[`em engagement brief`](cli.md#em-engagement-brief-file-slug---slice-key---inline-context---json)
(GH #454) composes the whole ticket body: the slice doc verbatim, model context, the
public-contract surface if any, a definition-of-done (an invariant/scenario list, a bindings-file
skeleton, the exact conform-check command, the isolation rule), and the engagement's own `context:`
documents. `--inline-context` embeds those context documents' full text instead of a path — the
ticket is the agent's only paste, so a pointer to a file in a repo it may not have checked out is
useless; inline makes the brief self-contained. Paste the output into the ticket body as-is (plain
markdown, no ANSI).

The brief's header carries the **tracking key** — `PROJ-1`, from `em engagement new --tracking` or
the slice doc's own `tracking:` — and the PR title to use. That key is what binds the ticket to
the slice everywhere downstream: the agent's PR title, the bindings file's `slice:` stem, and the
Ledger entry `em engagement set` records once the PR is open.

## 2. Agent PR in

The ticket's definition-of-done — the brief's own section 5 — includes committing
`conformance/bindings/place-order.yaml` in the same PR. [bindings.md](bindings.md) is a **file
contract, not a CLI feature**: the brief already seeded the skeleton (`ref`s and `INV-*` ids
filled in, `file`/`identifier` left as `TODO`), and the agent fills in the two fields only it
knows — where the code actually lives — without ever installing or running `em`. This is GH #450's
rule made explicit in the ticket rather than left as hygiene nobody enforces: see
[bindings.md, Who writes this file](bindings.md#who-writes-this-file).

## 3. CI gates

Three checks run on the agent's PR, the same gates [ci.md](ci.md) already documents:

```bash
em validate checkout.em
em api check checkout.em --base "$BASE_SHA"                       # only if the slice touches a public element
em conform bindings check checkout.em --repo . --exit-code        # opt-in job
```

[`em validate`](cli.md#em-validate-file) and [`em api check`](cli.md#em-api-check) are the usual
per-PR gates from [ci.md, The workflow](ci.md#the-workflow) and
[ci.md, `em api check`](ci.md#em-api-check-the-model-owned-contract) — nothing about this loop
changes them; whether the second one applies is exactly what the brief's "Contract surface"
section already told the agent. The third is new to this loop and is **opt-in**: `em conform
bindings check` stays exit-0 unless `--exit-code` is passed (see
[ci.md, `em conform bindings check` (opt-in)](ci.md#em-conform-bindings-check-opt-in)). Wiring
`--exit-code` here is what turns "the agent forgot the bindings file" into a failed check instead
of a silent gap — add it to this PR's gate list deliberately, the same opt-in step ci.md already
describes.

## 4. Scoped conform

Once the PR merges, a scoped conform walk is what actually checks the agent's work against the
spec:

```bash
em conform-scope checkout.em --repo /path/to/target-repo --seed-asis
em conform bindings check checkout.em --repo /path/to/target-repo --slice place-order
```

[`em conform-scope`](cli.md#em-conform-scope-file) maps the target repo's changed paths since
`Last conformance:` to slices via `implementedIn:`, and `--seed-asis` seeds the scratch model the
rest of the `conform` phase diffs against. For each in-scope slice, the walk checks for
`conformance/bindings/<key>.yaml` first: when the agent committed one in step 2, `em conform
bindings check` verifies it and the rest of the walk is scoped through it instead of re-derived
from scratch; when the agent skipped it, this walk **backfills the file from its own evidence** —
written once, from the code, the same rule [bindings.md](bindings.md#who-writes-this-file)
describes. Run this from wherever `em` runs, on the cadence [ci.md's conformance
recipe](ci.md#conformance-cadence-advisory) already schedules — not from the agent's own run, which
never sees this step.

## 5. Rulings → certification

A human rules on whatever the walk found, then two commands close the loop:

```bash
em conform-supersede checkout.em conformance/2026-11-07-report.md \
  --as-of HEAD --findings "1-3" --locus code --by "Sam Okafor"
em slice conform checkout.em place-order --at build:4821
```

[`em conform-supersede`](cli.md#em-conform-supersede-file-report-path) records the ruling
(`locus`/`resolvedBy`/`resolvedOn`) and stamps the report superseded.
[`em slice conform`](cli.md#em-slice-conform-file-slice-key---at-rev) then certifies the slice at
the version that shipped. `--at build:4821` rather than a bare commit SHA is the point this loop
pins down: a cloud-agent PR is routinely squash- or rebase-merged, which orphans the branch `HEAD`
the agent actually built against, and the CI run that exercised the code may itself be a
disposable per-PR environment with no durable commit at all. A kinded `<kind>:<id>` value —
`build:<id>`, `deploy:<id>` — records what was actually exercised without claiming a git revision
that won't stay reachable (GH #261).

## Why conform is the only spec-fidelity check here

In the engagement loop (`em engagement` + the `event-modeling-engagement` skill), four sub-agents
— `em-implementer`, `em-validator`, `em-reviewer`, `em-critic` — gate every slice PR before it
reaches `awaiting-merge`. **None of those run in this loop.** The lead session that dispatches them
assumes an implementer it can hand a worktree and a branch to; a ticket-driven cloud agent answers
to its tracker, not to an orchestrating `em` session, so there is no validator, reviewer, or critic
in the path at all — only the mechanical CI gates in step 3 and the scoped conform walk in step 4.
That is exactly why the bindings file and the scoped walk sit in the ticket's **definition of
done** rather than as optional hygiene someone might get around to: with no reviewing agent to
notice a missing or stale binding, conform is the only thing standing between "the agent said it
matched the spec" and actually checking.

## What `em` deliberately does not do here

`em` never pushes the ticket (updates its status, posts the brief, links the PR back) and never
orchestrates the agent (starts it, watches it, retries it) — that's a tracker bridge's job
(`em-tracker-bridge`), not `em`'s.

## See also

- [process.md, Handing a slice to an agent](process.md#handing-a-slice-to-an-agent) — the same
  hand-off for an implementer that *can* run `em`
- [process.md, Engagements: who operates the agents](process.md#engagements-who-operates-the-agents)
  — the orchestrated loop this one has no equivalent of
- [bindings.md](bindings.md) — the full schema for `conformance/bindings/<slice-key>.yaml`
- [ci.md](ci.md) — the gates named in step 3, and the conformance cadence step 4 runs on
- [cli.md#em-engagement-brief-file-slug---slice-key---inline-context---json](cli.md#em-engagement-brief-file-slug---slice-key---inline-context---json)
  — the full flag/output reference for the brief
