---
name: engagement
em-version: 1.23.1
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

**One repository or several.** Sections 1 to 8 are written for a model whose code is in the
model's own repository: one slice, one worktree, one implementer, one PR. When the model has a
`code-map.yaml`, a slice's code can be in other repositories, and in more than one. Then
`em engagement plan --json` carries `units`, and what you cut, dispatch and hand over is a
**work unit** (one slice's code in one repository), not a slice. Read section 9 before the first
dispatch whenever the plan has `units`; it says how each step below changes. Without `units`,
ignore section 9 entirely.

## 1. Preconditions — STOP on each

Run the shared preconditions first (tool check, bundle currency, locate the model):
`${CLAUDE_PLUGIN_ROOT}/shared/reference/operating-principles.md` ("Preconditions"). Then:

1. **Constitution ratified.** `em status <model>.em` names the constitution (`constitution.md`
   beside the model, or `.specify/memory/constitution.md`). STOP if it is missing or its
   `ratifiedBy:` is empty (spec-kit: no `**Ratified**:` footer). Say so and point at
   `em:implement`'s §7; never draft house rules to get moving.
2. **Foundation is in the code.** Do not ask the human whether the foundation PR (implement.md
   §8) landed — check: `em engagement foundation <model>.em <slug> --code <repo root>` (GH #240;
   `--json` when you need the fields). It reports every event the engagement's slices emit or
   consume as `present`, `incomplete` (which fields, which tag fields are missing — named), or
   `missing-event`. Any `missing-event`: STOP — the foundation has not landed for that event; ask
   for the foundation PR and confirm it merged into `main` (`gh pr view <n> --json state` shows
   `MERGED`), then re-run. Any `incomplete`: **one question to the human**, listing every gap the
   report names (an implementer never discovers these alone) — the fix is a foundation follow-up
   on `main`, never a slice PR. All `present`: go on. No slice branch is cut before this is clean.
   The check is a text scan of the target tree, not a compiler: a `present` event may still fail
   to type-check in the slice PR, and that is the slice PR's job to surface.
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
   engagement, ask the human which slices it covers (a list, a context, a storyline, or "everything
   downstream of X") and run `em engagement new <model>.em <slug> --slices a,b,c` (or
   `--context <C>`, `--storyline <name>`, or `--downstream-of <ref>`) `--by "<their name>"`. First check the host
   repo's PR-title convention (a commitlint config, a PR-title workflow, or the last few merged
   PR titles) and pass `--pr-title "<template>"` when it differs from the default
   `<key>: <slice name>`; placeholders are `{key}`, `{slice}` (display name) and `{sliceKey}`
   (kebab key, usually what a lint wants). When `new` warns that the
   selection has several unconnected components, relay its suggestion (one engagement each)
   and let the human decide before going on.

## 2. Plan and confirm the ceiling once

Run `em engagement plan <model>.em <slug>` (`--json` when you need the fields). Present it in
plain terms: each level, its width against the ceiling (`parallel`), each slice's branch (every
base is `main`), and every held slice with its reason (`not-ready`,
`upstream-outside-engagement-unmerged`, or `human`). Then the plan's **`pre-flight:` block** (GH
#239): the model-wide gaps the engagement's slices share — a `repeated-invariant` with no single
enforcing slice, an `event-without-tag` whose consistency boundary is undeclared, a
`shared-trigger` (one `ui`, two slices, no endpoint owner), a `doc-model-mismatch`, a `shape` (a
`em validate --shape` lint fires on the slices; the answer is a `shape-accepted: <rule> <refs> —
<reason>` bullet in `.event-modeling.md` `## Decisions log`, or a model fix). The plan may
also print a **`reviewed, not yet ratified` block**: the engagement's slices whose doc is still
`reviewed`, with the exact `em slice ratify` batch command (and one single command per
public-touching slice, which needs a meaning flag). Show it to the human as the handoff step
still owed, since ratification is the handoff gate and those slices are held until it is done.
It is information, not a hold; you never run the command, and `<name>` is theirs to fill in. These are
exactly what every implementer would otherwise stop on and report separately. Put them to the
human **in the same single question round** as the ceiling, one bullet each with the slices it
spans, and ask for a ruling on each (the answer goes where it belongs: the model, the foundation
PR, a slice doc, or `.event-modeling.md` for a deferral). Then ask exactly one question:

> "Ceiling N from the plan; proceed?"

Ask it once per engagement. If the human names a lower number, use it for this session. **Never
ask "which slice first"**: the levels decide the order, and the ceiling decides how many at once.
A pre-flight finding never holds a slice: if the human says "proceed anyway" on one, dispatch
and make sure each implementer's brief carries the ruling, so no agent rediscovers it.
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
   Its prompt is ONLY the slice key, the absolute worktree path, the exact pull-request title
   and, when there is one, the tracking key. The title is the slice's `prTitle` from
   `em engagement plan --json` (GH #334), already resolved from the engagement's `--pr-title`
   template or the default: pass it verbatim and never compose one. The tracking key is the
   plan's `tracking` (GH #241), already resolved: the slice doc's own `tracking:` wins over the
   engagement's `--tracking`, and it is `null` when neither is set (then say nothing about
   tracking). Surface any `pr-title-fallback` pre-flight entry to the human. It reads
   its own spec, the constitution and the implement contract. Give it no plan, no other slice,
   and no merge instructions.

## 4. Validate, review, criticise

When the implementer returns a PR URL (and a per-invariant test map):

1. `em engagement set <model>.em <slug> <key> --state validating --pr <url>`. Check the PR's
   base: `gh pr view <url> --json baseRefName` must be `main`. If not, fix it with
   `gh pr edit <url> --base main`. That is a lead step; the implementer never changes a base.
2. Dispatch `em-validator` (`em:em-validator`) with the slice key, the worktree path and the same
   tracking key (when the slice has one) and the same `prTitle`. It
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
   like any other PR. If `mark-implemented` printed `opened draft v<n+1>` for a slice, its doc in
   this PR reads `status: draft`: say so in the hand-back and paste the command's notice into the PR
   body — `shippedVersion:`/`implementedIn:` are the record that v<n> was implemented, `status:` is
   the next version's state, so the reviewer does not read it as a slice that was never marked.
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

## 9. Work units: when the plan has `units`

`em engagement plan <model>.em <slug> --json` lists `units` when the model has a `code-map.yaml`.
Each `kind: "unit"` node is one slice's code in one repository: `id` (`<key>@<repo>`), `partOf`
(the slice), `repo`, `roots`, `elements`, `branch`, `prTitle`, `marker`, `dependsOn`, `state`.
Each slice also has one `kind: "close"` node (`close:<key>`), its closing step. `em` publishes
this graph; you run it. You are the only lead, so you are also where claims live: no unit is
ever dispatched twice.

Everything in sections 1 to 8 holds, with these changes.

**Preconditions (section 1).**

- Run `em repos check <model>.em`. Every repo that appears in `units[].repo` must be `resolved`.
  For one that is `missing` or `not a git repo`, STOP and ask the human to check it out beside the
  model's repository or map it in `.em/repos.local.yaml`. **Never clone, pull or push a
  repository to make this pass.** Take each repo's path from `em repos check --json`
  (`repos[].path`) and use that path, as given, everywhere below.
- The worktree check (1.4) and the foundation check (1.2) run in each repository a unit works in:
  `git -C <repo path> check-ignore -q .claude/worktrees/x`, and
  `em engagement foundation <model>.em <slug> --code <repo path>` for each repo whose units hold
  an event. An event only has to be `present` in the repository its own unit is placed in.

**The plan (section 2).** Present units under their slices, as the text plan prints them, and
say which repository each is in. The ceiling counts **units in flight**, not slices. An
`element-unplaced` pre-flight finding means an element is in no unit: it goes to the human in
the same question round, and the fix is in `code-map.yaml`, in a design session.

**Cut and dispatch (section 3), per unit.** A unit is startable when its slice is not held and
every node in its `dependsOn` is `merged`. Units of one slice with empty `dependsOn` start
together; they build in parallel against the slice's contract and never wait for each other's
code. For each startable unit:

1. `base` is `main`, of the unit's own repository. Never that repository's current HEAD.
2. If the branch (`git -C <repo path> rev-parse --verify --quiet <branch>`) or
   `<repo path>/.claude/worktrees/<key>` already exists, STOP for that unit and report it.
3. Cut the worktree in the unit's repository, with the branch name the node gives (the same name
   in every repository the slice touches):
   `git -C <repo path> worktree add .claude/worktrees/<key> -b <branch> main`
4. Record it, per unit:
   `em engagement set <model>.em <slug> <key> --unit <repo> --state building --branch <branch> --base main`
5. Dispatch `em-implementer` with ONLY: the unit id, the absolute worktree path, the absolute
   path of the model's repository (read-only: the slice doc and the constitution are there), the
   exact pull-request title, the node's `marker` line and, when there is one, the tracking key.
   Also hand it the unit's brief, verbatim:
   `em engagement brief <model>.em <slug> --slice <key> --unit <repo>`. Give it no other unit's
   brief, no plan and no merge instructions.

The engagement file is in the model's repository and **only you write it**. An implementer in a
code repository never touches it; it reports back and you record the result.

**Validate, review, criticise (section 4), per unit.** Use `--unit <repo>` on every
`em engagement set`: `--state validating --pr <url>`, then `review`, then `awaiting-merge`. The
slice's own state follows from its units; never set it directly. The validator gets the unit
id, the worktree path, the model repository's path, the title and the marker. The reviewer and
the critic get the unit id and its PR URL. Findings go back to the same unit's implementer.

**Cross-link the slice's pull requests.** As soon as every unit of a slice has a PR, comment on
each with the others, so a reader of one finds the rest:
`gh pr comment <url> --body "Sibling units of slice <key>: <url>, <url>"`. This is a lead step.
The `marker` line in each PR body and the shared branch name already join them for a tool; the
comment is for people.

**Hand over (section 5).** Hand the human a slice's unit PRs together when they are ready
together, each with its own evidence bundle, and say plainly that the slice is done only when
all of them have merged. Each PR still merges independently, in any order.

**After a merge (section 6).** `em engagement set <model>.em <slug> <key> --unit <repo> --state
merged`, then remove that worktree: `git -C <repo path> worktree remove .claude/worktrees/<key>`.
A slice reads `merged` only when every one of its units does. A unit whose `dependsOn` just
cleared becomes startable. When all of a slice's units are `merged`, its closing step is due.

**The closing step (`close:<key>`), in the model's repository.** It is the node the plan lists
with `kind: "close"`, and it replaces the per-slice part of section 6.3 for a slice with units.
Do it yourself; it is bookkeeping, not slice code. Once every unit of the slice is `merged`:

1. In the model's repository: `git switch main && git pull --ff-only`, then
   `git switch -c close/<key> main` (the branch the node names). Several slices' closing steps
   of one level may share one branch and one PR, `engagement/<slug>-level-<n>`, as in section 6.3.
2. **Write the slice's bindings file** from the entries each unit's implementer handed back in
   its PR description: one file, `conformance/bindings/<key>.yaml`, `bindingsSchemaVersion:
   "1.1"`, `slice: <key>`, then every unit's `elements:` entries and `invariants:` entries
   together, each keeping its `repo:`. Copy what was handed back; do not re-derive it. If a unit
   handed back nothing, or an entry is still `TODO`, go back to that unit's implementer.
3. Verify it against the merged code: update each repository's `main` (`git -C <repo path> switch
   main && git -C <repo path> pull --ff-only`), then
   `em conform bindings check <model>.em --slice <key> --exit-code`. Exit 0 is required.
4. Record each unit's pull request:
   `em slice mark-implemented <model>.em <key> <pr-url> --unit <repo>`, once per unit. The doc
   flips to `implemented` on the last one. Then `em slice index <model>.em`.
5. Commit, and `gh pr create --base main` with the node's `prTitle` and its `marker` line in the
   body. The human merges it like any other PR. The plan then reports the closing step `merged`,
   because the slice doc records the slice as shipped.

A slice whose units have all merged but whose closing step has not is **not done**: its doc
still reads `ready-to-implement`, and its bindings are not recorded. Say so in every hand-back
until it is.

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
| Never clone, pull or push a repository to make a unit startable | `em` resolves checkouts and reports what is missing; fetching one is the human's call |
| Never set a multi-unit slice's state directly, or let a unit's implementer write the engagement file | The Ledger has one writer, in the model's repository; a slice's state is derived from its units |
| Never dispatch a unit whose `dependsOn` is not all `merged`, or dispatch one twice | The graph orders the work and the lead holds the claims |
