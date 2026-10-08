# Engagement reference — the lead session's rules

The `event-modeling-engagement` skill's steps refer here by name. The commands are documented in
full in `docs/cli.md` (`em engagement`) and the file format in `docs/engagement-schema.md`;
neither is vendored, and this file repeats only what the lead needs mid-session.

## The Ledger state machine

Every Ledger write is `em engagement set <model>.em <slug> <key> --state <state> [--branch <b>]
[--base <b>] [--pr <url>]`. The command accepts any state at any time, so the order below is the
skill's discipline, not something em enforces. The exceptions em does enforce: setting the same
state and values again is a no-op, `merged` is terminal (every later `set` is refused), and a
closed engagement refuses every `set`.

| State | Set at | Means | Next |
|---|---|---|---|
| `planned` | `em engagement new` | Selected; nothing cut yet | `building` (step 3) or `held` |
| `building` | step 3, after `git worktree add` (with `--branch impl/<key> --base <base>`); step 4.5 when findings go back | The implementer owns the worktree | `validating`, or `gap` |
| `validating` | step 4.1 (with `--pr <url>` the first time) | `em-validator` is running on the PR | `review` on PASS, `building` on FAIL |
| `review` | step 4.3 | `em-reviewer` and `em-critic` are reading the PR | `awaiting-merge`, or `building` on blocker/major findings |
| `awaiting-merge` | step 5 | Handed to the human with its evidence bundle | `merged` |
| `merged` | step 6.3, after the human merges (also inferred, never written, once the doc reads `status: implemented`) | Terminal | — |
| `held` | only when the human asks to park a slice (`heldBy: human`) | A human hold; the plan's own computed holds are separate (`planHeld`) and never written | `planned` when the human releases it |
| `gap` | step 7 | The implementer stopped on a question the doc must answer | Stays `gap`; the slice comes back in a later engagement once its doc is re-ratified |

`em engagement close <model>.em <slug>` succeeds only when every slice is `merged` (recorded or
inferred) or `gap`; `em engagement status` reports this as `closable`.

A dependent's base changes once, when its upstream merges: record it with the dependent's
current state and `--base main` (step 6.2), so the Ledger matches the PR's real base.

## The evidence bundle (step 5)

Hand the human one block per PR, bottom-first, in this shape:

```markdown
### <level n> · `<key>` · <PR URL>
Base: `<base>` · Ledger: awaiting-merge · Stacked on it: <PR URLs of open dependents, or "none">
Merge with: a merge commit (<a dependent is open | squash allowed: no open dependent>)

Validator (em-validator, <model>):
| Check | Result |
|---|---|
| `em validate <model>.em --slice-ready <key>` | PASS |
| `em coverage <model>.em --slice <key> --tests <dir> --strict` | PASS |
| test command `<cmd>` | PASS |
| diff footprint inside the slice package | PASS |
| no diff under `slices/**`, `*.em`, `constitution.md`, `engagements/` | PASS |
| PR body cites the slice doc | PASS |

Reviewer (em-reviewer, <model>): <findings list verbatim, or NO FINDINGS>
Critic (em-critic, <model>): <findings list verbatim, or NO FINDINGS>
Disagreements: <each blocker/major raised by one and not the other, or "none">
Rounds: <how many times findings went back to the implementer>; unresolved: <findings that
survived two rounds, or "none">

Per-invariant tests (from em-implementer):
- INV-<id> -> <test file>::<test name>
```

Copy the agents' lines verbatim; never summarise a finding away.

## The retarget check (step 6.2)

GitHub retargets every open PR whose base was a merged head branch to the merged PR's base, but
only when that head branch is deleted. After each merge of `impl/<key>`:

1. `gh pr list --base impl/<key> --state open --json number,headRefName` must return `[]`.
2. For each PR it does list, run `gh pr edit <number> --base main`. Then record it:
   `em engagement set <model>.em <slug> <dependent> --state <its current state> --base main`.
3. Confirm with `gh pr view <number> --json baseRefName`.

Because the lower PR merged with a merge commit, the dependent's diff against `main` shrinks to
its own commits by itself. Never rebase it. If its diff still shows the upstream's commits, the
lower PR was squashed: STOP and tell the human. Restacking that PR is their decision.

## The gap protocol (step 7)

A gap is a question only the model can answer: the doc is wrong, incomplete, or contradicts the
constitution. The implementer stops and reports it as the doc line plus the question.

1. `em engagement set <model>.em <slug> <key> --state gap`. Leave the worktree and branch as they
   are.
2. Append one bullet to `.event-modeling.md` under `## Open questions / parking lot`:
   `- [ ] YYYY-MM-DD: <key> — <question, citing the doc line> — source: engagement <slug>`
   (today's local date).
3. Every slice downstream of the gap stays unstarted. Name them to the human.
4. Carry on with every other startable slice. Never answer the question yourself, never edit the
   doc, and never let the implementer guess.

The question is answered in a design session (`event-modeling-design`), which re-ratifies the
doc. The slice is then built in a later engagement.

## Model selection

Models come from the constitution's `- **Agent models:** implementer=<model>, validator=<model>,
reviewer=<model>, critic=<model|codex>` line, or from the defaults when the line is absent:
implementer=sonnet, validator=sonnet, reviewer=sonnet, critic=opus. Pass the model with each
dispatch; the agent definitions fix none.

**The critic never runs on the implementer's model.** If the line names the same model for both,
STOP before the first critic dispatch and tell the human. A critic on the implementer's model
shares its blind spots, which defeats its purpose. Proceed without a critic only if the human
says so, and record that choice in the final report.

## Codex critic

When the constitution's agent-models line says `critic=codex`, the critic runs through Codex instead
of as the `em-critic` sub-agent. Its findings use the same list shape, and every rule above applies
to them unchanged: fresh context, no access to the reviewer's findings, and disagreement is a
finding. The Claude critic path is untouched.

**Prerequisites (check; never write).** Any miss is reported to the human, the Claude critic
(`em-critic`) runs for that PR instead, and the evidence bundle says "critic: codex unavailable
(<reason>), ran em-critic":

1. `command -v codex` succeeds.
2. The project is trusted in Codex: `~/.codex/config.toml` has a `[projects."<repo root>"]` table with
   `trust_level = "trusted"`. Read it; never add it. Trust is the human's to grant.
3. If the project keeps `.codex/rules`, it is present in the review checkout. A repo without
   `.codex/` is fine: the invocation below needs no rules file, and the lead never creates one.

**Invocation** (flags verified against `codex exec --help`, codex-cli 0.159.1). Cut the review
worktree at the PR head, save the diff, then run Codex read-only:

```
git worktree add --detach .claude/worktrees/review-<pr> <pr-head-sha>
gh pr diff <pr> > <scratch>/pr-<pr>.diff
codex exec --cd .claude/worktrees/review-<pr> --sandbox read-only --ephemeral \
  --add-dir <scratch> -o <scratch>/critic-<pr>.txt "<prompt>" < /dev/null
```

`< /dev/null` is required: without it `codex exec` waits on stdin ("Reading additional input from
stdin...") and hangs. `-o` (`--output-last-message`) writes only the final message to the file.
The prompt gives the slice doc path, the constitution path and the diff path, says it is read-only,
and asks for ONLY the `em-critic` list: `- [<severity>] <file:line or doc §> — <finding>`
(`blocker`|`major`|`minor`), every finding citing a slice doc line or constitution rule, or
`NO FINDINGS` naming what was checked. Do not pass the reviewer's findings.

**Parse.** The output file is the critic's findings: keep lines matching `^- \[(blocker|major|minor)\] `
or the `NO FINDINGS` line. If the file is missing, empty, or has neither, treat it as a failed run:
report it and fall back to `em-critic`. Then continue with step 4 onward exactly as for the Claude
critic. Remove the review worktree afterwards (`git worktree remove --force`).
