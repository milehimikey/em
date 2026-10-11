---
name: engagement
em-version: 1.15.0
description: >-
  Use when leading an engagement: building a named set of ratified event-modeling slices
  (`em engagement`) into one independent PR per slice, each against main, by dispatching the
  em-implementer, em-validator, em-reviewer and em-critic sub-agents, level by level, and handing
  the human each PR with its evidence as it passes review. The lead session orchestrates and never
  writes slice code itself. To build one slice by hand, use em:implement instead.
---
<!-- GENERATED FILE from .claude/skills/event-modeling-engagement/SKILL.md by scripts/build-plugin.ts — do not hand-edit; run npm run docs:generate -->

# Event Modeling — engagement (lead session)

Goal: take an engagement (a named chunk of the model, `<model dir>/engagements/<slug>.md`) from
its plan to merged PRs. You are the **lead**: you cut worktrees, dispatch scoped sub-agents,
record every step in the Ledger with `em engagement set`, and hand the human one PR per slice,
each cut from and targeting `main`, to merge in any order. You never write slice code, never
merge, and never rebase a slice branch.

An engagement is a *related set* of isolated slices — a workflow, a lifecycle — built together.
It is not a stack: no slice branch is ever cut from another slice's branch, and no PR ever
targets another PR (MIL-280). The foundation PR (implement.md §8) already holds every event, and
a slice never reaches into a sibling's code (§8 rule 3), so each PR compiles, tests and merges
on its own. Levels order the work for the human's review and your dispatch; they never gate a
merge.

**Read `reference/engagement.md` before the first dispatch.** It holds the Ledger state machine,
the evidence bundle format, the gap protocol and the model-selection rule this file uses by
name. Each sub-agent runs `em:implement`'s contract
(`${CLAUDE_PLUGIN_ROOT}/skills/implement/reference/implement.md`) for its one slice; that contract is
theirs, not yours.

The sub-agents are `em-implementer`, `em-validator`, `em-reviewer` and `em-critic`. Under the
plugin their dispatch names are `em:em-implementer`, `em:em-validator`, `em:em-reviewer` and
`em:em-critic`. In a vendored repo they live in `.claude/agents/`; if they are missing, STOP and
tell the user to run `em skill sync` (or `em upgrade`).

Throughout, `<model>.em` is the model file and `<slug>` the engagement's name. Every command
below is real; run it as written.

## 1. Preconditions — STOP on each

Run the shared preconditions first (tool check, bundle currency, locate the model):
`${CLAUDE_PLUGIN_ROOT}/shared/reference/operating-principles.md` ("Preconditions"). Then:

1. **Constitution ratified.** `em status <model>.em` names the constitution (`constitution.md`
   beside the model, or `.specify/memory/constitution.md`). STOP if it is missing or its
   `ratifiedBy:` is empty (spec-kit: no `**Ratified**:` footer). Say so and point at
   `em:implement`'s §7; never draft house rules to get moving.
2. **Foundation PR merged.** Ask the human for the foundation PR (implement.md §8) and confirm it
   has merged into `main` (`gh pr view <n> --json state` shows `MERGED`). STOP if there is none
   or it is still open. No slice branch is cut before it lands.
3. **Agent models.** Read the line `- **Agent models:** implementer=<model>,
   validator=<model>, reviewer=<model>, critic=<model|codex>`. If it is absent, say once:
   "no Agent models line — using implementer=sonnet, validator=sonnet, reviewer=sonnet,
   critic=opus", and proceed. Apply the model-selection rule in `reference/engagement.md`
   (the critic never runs on the implementer's model). A constitution that still carries a
   `- **Merge strategy:**` line from em ≤ 1.14.2 is fine: the line is ignored, never a reason to
   stop — PRs merge with whatever strategy the project uses.
4. **Worktrees are ignored.** `git check-ignore -q .claude/worktrees/x` must succeed. If it
   fails, STOP and ask the human to add `.claude/worktrees/` to `.gitignore` in its own commit
   on `main`.
5. **The engagement exists.** `em engagement status <model>.em <slug>`. If there is no such
   engagement, ask the human which slices it covers (a list, a context, or "everything
   downstream of X") and run `em engagement new <model>.em <slug> --slices a,b,c` (or
   `--context <C>`, or `--downstream-of <ref>`) `--by "<their name>"`. When `new` warns that the
   selection has several unconnected components, relay its suggestion (one engagement each)
   and let the human decide before going on.

## 2. Plan and confirm the ceiling once

Run `em engagement plan <model>.em <slug>` (`--json` when you need the fields). Present it in
plain terms: each level, its width against the ceiling (`parallel`), each slice's branch (every
base is `main`), and every held slice with its reason (`not-ready`,
`upstream-outside-engagement-unmerged`, or `human`). Then ask exactly one question:

> "Ceiling N from the plan; proceed?"

Ask it once per engagement. If the human names a lower number, use it for this session. **Never
ask "which slice first"**: the levels decide the order, and the ceiling decides how many at once.
A held slice is never started; the plan releases it when its hold clears.

## 3. Per level: cut the worktree, then dispatch the implementer

Work level by level, in order: a level's slices are dispatched before the next level's, so the
human sees upstream slices first. Nothing in level n+1 waits for a merge — every slice is cut
from `main`. Keep up to the ceiling of slices in flight (`building`, `validating` or `review`)
at once, dispatched in parallel; when a slot frees, take the next not-held slice in level order.
For each slice the plan lists as not held:

1. Take `base` from the plan for this slice. It is always `main`. **Never the current HEAD**,
   never another slice's branch, and never a branch you picked yourself.
2. If `impl/<key>` already exists (`git rev-parse --verify --quiet impl/<key>`) or
   `.claude/worktrees/<key>` already exists, STOP for that slice and report it. Never delete,
   reuse or reset someone's branch.
3. Cut the worktree yourself:
   `git worktree add .claude/worktrees/<key> -b impl/<key> <base>`
4. Record it:
   `em engagement set <model>.em <slug> <key> --state building --branch impl/<key> --base <base>`
5. Dispatch `em-implementer` (`em:em-implementer` under the plugin) on the implementer model.
   Its prompt is ONLY the slice key and the absolute worktree path. It reads its own spec, the
   constitution and the implement contract. Give it no plan, no other slice, and no merge
   instructions.

## 4. Validate, review, criticise

When the implementer returns a PR URL (and a per-invariant test map):

1. `em engagement set <model>.em <slug> <key> --state validating --pr <url>`. Check the PR's
   base: `gh pr view <url> --json baseRefName` must be `main`. If not, fix it with
   `gh pr edit <url> --base main`. That is a lead step; the implementer never changes a base.
2. Dispatch `em-validator` (`em:em-validator`) with the slice key and the worktree path. It
   returns one PASS/FAIL line per check and `OVERALL: PASS` or a failure.
3. On `OVERALL: PASS`: `em engagement set <model>.em <slug> <key> --state review`. Dispatch
   `em-reviewer` (`em:em-reviewer`) with the slice key and the PR URL. Dispatch `em-critic`
   (`em:em-critic`) with the same two inputs, on the critic model, in fresh context. **Never
   show the critic the reviewer's findings.** When the critic is `codex`, run the
   prerequisite checks and the `codex exec` invocation in `reference/engagement.md` ("Codex
   critic") in a fresh `.claude/worktrees/review-<pr>`, treat its output file as the critic's findings, and
   fall back to `em-critic` (saying so in the evidence bundle) if any prerequisite fails.
4. Compare the two findings lists. A blocker or major finding raised by only one of the two is
   itself a finding for the human (record it in the evidence bundle).
5. **Findings go back to the SAME implementer.** On a validator FAIL, or any `blocker`/`major`
   finding: `em engagement set <model>.em <slug> <key> --state building`, then continue the same
   implementer agent (same session, same branch, same worktree) with the failing check lines or
   the findings. Never start a fresh implementer for it, and never fix the code yourself. When
   it reports back, go back to step 4.1: the validator always re-runs before review does. If the
   same finding survives two rounds, stop the loop and put it in the evidence bundle for the
   human.
6. `minor` findings do not loop. They go in the evidence bundle.

## 5. Hand the human each PR as it passes

When a slice passes review: `em engagement set <model>.em <slug> <key> --state awaiting-merge`.
Hand the human the PR with its evidence bundle (`reference/engagement.md`): the validator table,
the reviewer's and critic's findings and any disagreement, and the per-invariant test map. Every
PR is independent — against `main`, carrying only its own slice — so the human merges them in
any order, with the project's usual merge strategy (squash included), and nothing else needs
retargeting or restacking. Suggest level order (upstream slices first) because it reads better,
not because anything depends on it.

You never merge.

## 6. After each human merge

1. Update `main` in your own checkout: `git switch main && git pull --ff-only`.
2. `em engagement set <model>.em <slug> <key> --state merged`, then remove the worktree:
   `git worktree remove .claude/worktrees/<key>`.
3. When every slice of a level is `merged` or `gap`, open one follow-up PR for that level from
   `main`: `git switch -c engagement/<slug>-level-<n> main`, run
   `em slice mark-implemented <model>.em <key> <pr-url>` for each slice merged in the level,
   then `em slice index <model>.em`, commit, and `gh pr create --base main`. The human merges it
   like any other PR.
4. Recompute: `em engagement plan <model>.em <slug>`. A merge can release an
   `upstream-outside-engagement-unmerged` hold once that upstream's doc reads `implemented`.
   Continue with step 3 for anything newly startable.

## 7. Gaps

When the implementer stops on a gap (the doc is wrong, incomplete, or contradicts the
constitution), follow the gap protocol (`reference/engagement.md`):

1. `em engagement set <model>.em <slug> <key> --state gap`.
2. Add the question as a dated bullet under the model's `.event-modeling.md`
   `## Open questions / parking lot`:
   `- [ ] YYYY-MM-DD: <key> — <the question, citing the doc line> — source: engagement <slug>`.
3. Continue with the other slices. Leave the gap slice's dependents unstarted, and tell the
   human which they are. The doc is fixed in a design session, never in this one.

## 8. End

1. `em state log-usage <model>.em --phases engagement`.
2. `em engagement status <model>.em <slug>`. When it reports `closable: true` (every slice
   `merged` or `gap`), run `em engagement close <model>.em <slug>`. Otherwise leave it open: the
   next lead session resumes from the Ledger.
3. Report: what merged (PR links), what is awaiting merge, what is held and why, each gap with
   its question, and every unresolved reviewer or critic disagreement.

## Never do

| Rule | Because |
|---|---|
| Never hand-edit `engagements/<slug>.md` | `em engagement set` and `close` are the only write paths; the Ledger table is generated |
| Never cut a slice branch from another slice's branch, or make a PR target another PR | Every slice PR is cut from and targets `main` (MIL-280); a stack turns isolated slices into one landing and adds merge ceremony the contract never needed |
| Never rebase a slice branch | The branch is the implementer's; the lead orchestrates and records, it does not rewrite history |
| Never run the implementer's work yourself | The lead orchestrates; code comes from a scoped implementer working from its own read of the spec |
| Never dispatch beyond the ceiling | The ceiling was confirmed once for the engagement; exceeding it breaks that agreement |
| Never cut a slice branch from the current HEAD | The base is `main` from the plan; the lead's HEAD may be anything |
| Never hold a PR back for an upstream merge | Slices do not depend on each other's branches (§8 rules 2 and 3); level order is for reading, not gating |
| Never merge a PR | The human merges, in any order |
| Never show the critic the reviewer's findings | The critic's value is an independent view; disagreement is a finding |
| Never start a held slice, or ask "which slice first" | The plan decides order and holds; the human confirms only the ceiling |
