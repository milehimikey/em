# CI recipe

`em validate` is deterministic and side-effect-free, which makes it a natural merge gate: run
it on every `.em` file a pull request touches, and fail the check the same way any other
linter would. This is a copy-paste GitHub Actions workflow that does that, plus an optional
`em export` artifact step for downstream tooling.

**Installed, not just copy-pasted:** `em ci init <model>` (MIL-166, see
[cli.md](cli.md#em-ci-initmodel)) scaffolds most of this page's recipe as two ready-to-commit
GitHub Actions files — `em validate` below, `em slice index --check`, `em coverage --strict`,
`em ledger`, `em skill check`, `em glossary --fail-on-conflicts`, a status-badge rebuild, and
the conformance cadence — in one command, marker-delimited and idempotent the same way `em
skill install` is. The rest of this page stays the reference for what each check does and why;
reach for `em ci init` when you just want it wired.

## Where this fits

Treat a committed `.em` model the same way you'd treat a schema or an OpenAPI spec: it's a
source of truth that other things depend on (diagrams, slice docs, eventually generated code
or `em export` consumers), so a PR that breaks it should fail before merge, not after. `em
validate` only fails on **errors** — model-breaking problems like an unresolved `from` or a
backward-pointing arrow — never on warnings, so the gate doesn't get noisy as a model evolves.
Open questions (`issue "text"`) are warnings by default; `--fail-on-issues` is there if a repo
wants to additionally block on unresolved issues, but that's opt-in, not the default in this
recipe.

## The workflow

```yaml
name: em validate

on:
  pull_request:
    paths:
      - "**/*.em"

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Validate changed models
        run: |
          set -e
          base="${{ github.event.pull_request.base.sha }}"
          head="${{ github.event.pull_request.head.sha }}"
          changed=$(git diff --name-only "$base" "$head" -- '*.em')
          if [ -z "$changed" ]; then
            echo "no .em files changed"
            exit 0
          fi
          status=0
          for f in $changed; do
            echo "::group::em validate $f"
            npx @milehimikey/em validate "$f" || status=1
            npx @milehimikey/em validate "$f" --list-issues
            echo "::endgroup::"
          done
          exit $status
```

Notes on the recipe:

- `paths: ["**/*.em"]` keeps the job from running on PRs that don't touch a model.
- `fetch-depth: 0` on checkout is needed so `git diff` against the PR base works.
- `em validate "$f"` is what actually gates the merge — it exits non-zero on errors.
- `em validate "$f" --list-issues` runs a second time to surface open `issue` clauses in the
  job output (grouped per file); this never fails the build on its own.
- To additionally block merges while any `issue` remains open, add `--fail-on-issues` to the
  first `em validate` call — opt-in, since issues are meant to be visible, not necessarily
  blocking.
- No local install needed — `npx @milehimikey/em` fetches the package for the run.

## `em export` as the artifact step

Once validation passes, `em export <file.em> -o <file.json>` produces a versioned JSON
snapshot of the model — the shape downstream tooling (dashboards, generators, an MCP server)
should consume instead of re-parsing the `.em` DSL. A natural extension of the job above is
an artifact-upload step per changed file:

```yaml
      - name: Export changed models
        run: |
          for f in $changed; do
            out="${f%.em}.json"
            npx @milehimikey/em export "$f" -o "$out"
          done

      - uses: actions/upload-artifact@v4
        with:
          name: em-exports
          path: "**/*.json"
```

`em export` is deterministic (same source text -> byte-identical JSON) and refuses to export
when the model has errors, mirroring `em validate`'s gate — so it's safe to run right after
the validate step with no extra error handling. See [cli.md](cli.md#em-export-file) for the
schema.

`em diff --from <rev> --json --exit-code` is the machine-readable counterpart for a change
gate — one JSON document on stdout, exit 1 when the model actually changed. See
[cli.md](cli.md#em-diff-old-new).

When a repo holds more than one `.em` model, `em glossary <files...> --fail-on-conflicts`
adds a vocabulary-consistency gate the same way (also wired by default in the `em ci init`
scaffold): opt-in, off by default in a hand-assembled workflow, exits non-zero only
when the same term is used inconsistently across models (a different element kind, or a
different field type). Add it as its own step once changed-files detection covers every
`.em` file in the repo, not just the ones a PR touched — a conflict can be introduced by
either side of a rename, so scoping the check to the diff alone can miss it:

```yaml
      - name: Check glossary consistency across models
        run: npx @milehimikey/em glossary $(git ls-files '*.em') --fail-on-conflicts
```

See [cli.md](cli.md#em-glossary-files) for the conflict rules and the `--json` schema.

## `em ledger` (opt-in)

Opt-in here means: not part of `em validate`, so add it yourself if you're hand-assembling a
workflow. `em ci init` wires it in by default as its own PR gate — the preset's opinion is that
once a repo has `slices/*.md` docs at all, ledger agreement is worth enforcing from the start.

`em ledger` (MIL-89) checks that a slice doc's `version:` frontmatter field and its content
(body + lineage refs) always change together between two git revisions — a version bump with
no real content change, or a content change with no version bump, is a ledger bug (see
[slice-doc-schema.md](slice-doc-schema.md)). Unlike the `em validate` job above, this needs
git history to compare revisions, so it's **deliberately not part of `em validate`** — that
command stays a fast function of the current tree (see
[validation.md#lineage](validation.md#lineage)). It's its own opt-in step, only worth adding
once your team has decided version/content agreement should be enforced rather than left to
review discipline:

```yaml
      - name: Check slice doc version/content agreement
        run: npx @milehimikey/em ledger model.em --from "${{ github.event.pull_request.base.sha }}"
```

Add this alongside the `actions/checkout@v4` step above (it already sets `fetch-depth: 0`,
which this needs too). `--from` compares the PR base against the current working tree (the PR
head, once checked out); `em ledger` exits non-zero on any mismatch — every finding is a
defect once you've opted into running this check, so unlike `em diff`/`em glossary` there's no
separate `--exit-code`/`--fail-on-*` opt-in flag. See
[cli.md](cli.md#em-ledger-file) for the full flag/output reference and `--json` shape.

## `em coverage` (opt-in)

Same "opt-in unless you install the preset" story as `em ledger` above — `--strict` is on by
default in the `em ci init` scaffold, gating the PR rather than only reporting.

`em coverage` (MIL-130) mechanizes `reference/implement.md`'s definition-of-done citation check:
for every slice whose doc `status` is `ready-to-implement` or `implemented`, every `INV-*`
invariant ID mentioned in the doc's body must be cited by at least one test under `--tests
<dir>`. Advisory by default — uncovered IDs are reported but don't fail the run — because a
freshly-added invariant with a test still in flight is a normal, transient state, not
automatically a defect the way a ledger mismatch is. `--strict` turns it into a hard CI gate:

```yaml
      - name: Check invariant test coverage
        run: npx @milehimikey/em coverage model.em --tests test/ --strict
```

Add this once your team wants "every invariant is cited by a test" enforced rather than left to
review discipline — a natural pairing with the `em validate --slice-ready` gate an implementing
agent already runs before starting work (`reference/implement.md`, §1 and §5). Like `em ledger`,
this needs no git history — it's a pure function of the current tree (the doc bodies plus the
test tree), so unlike `em ledger` it doesn't need `fetch-depth: 0` on checkout. See
[cli.md](cli.md#em-coverage-file---tests-dir) for the full flag/output reference and `--json`
shape.

## Conformance cadence (advisory)

`em ci init <model>` scaffolds this recipe verbatim as `.github/workflows/em-conform.yml` — the
walkthrough below is what that file does and why.

Once a model's slices are `implemented`, the bundled skill's `conform` phase can check the
codebase against the model on a schedule — drift surfaces as an advisory report, never a
failed build. The pattern is a scheduled job that runs Claude Code headless with the
event-modeling skill installed and asks it to run the phase:

```yaml
name: model-conformance

on:
  schedule:
    - cron: "0 6 * * 1"     # weekly, Monday 06:00 UTC
  workflow_dispatch: {}     # and on demand

permissions:
  contents: read
  issues: write             # the Post report step opens an issue

env:
  MODEL_DIR: docs/model     # wherever the model lives

jobs:
  conform:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4          # the repo holding model + code
      - uses: actions/setup-node@v4
        with: { node-version: 20 }

      - name: Note reports already present
        run: ls "$MODEL_DIR"/conformance/*-report.md 2>/dev/null | sort > /tmp/reports-before

      - name: Run conform phase
        run: |
          npm i -g @milehimikey/em@1 @anthropic-ai/claude-code
          em skill install --force
          claude -p "/event-modeling conform" \
            --allowedTools "Bash(em:*),Bash(git:*),Read,Grep,Glob,Write,Edit"
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

      - name: Post report
        run: |
          ls "$MODEL_DIR"/conformance/*-report.md 2>/dev/null | sort > /tmp/reports-after
          report=$(comm -13 /tmp/reports-before /tmp/reports-after | tail -1)
          if [ -z "$report" ]; then
            echo "the run produced no new report — nothing to post"
            exit 0
          fi
          gh issue create --title "Model conformance report $(date +%F)" \
            --body-file "$report"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Unlike the recipes above, this one installs `em` globally rather than reaching for `npx`: the
agent shells out to a bare `em` of its own accord, so the binary has to be on `PATH` for the
whole run. `em skill install --force` overwrites the copy committed in the repo, so the phase
that runs is the one bundled with the `em` version just installed — drop the `--force` if you'd
rather pin the phase to whatever your repo has committed. `em skill sync` (MIL-93) is the more
precise tool for this exact "always take the latest, no drift check" intent — same
always-overwrite semantics as `install --force`, plus a change report — so newer setups should
reach for `em skill sync` here instead.

If you'd rather **pin** the vendored copy and fail the build when it drifts from whatever `em`
version CI just installed, add `em skill check` as its own gate instead of silently overwriting:

```yaml
      - name: Check vendored skill matches installed em
        run: npx @milehimikey/em skill check
```

`em skill check` exits non-zero on any mismatch — a stale `em-version:` stamp, or content that
diverges from the packaged skill even with a matching stamp (e.g. a hand-edited file). See
[cli.md](cli.md#em-skill-check-path) for the full flag/output reference and `--json` shape.

Ground rules, matching the phase's own stance (see
`.claude/skills/event-modeling/reference/conform.md` once the skill is installed):

- **The job never fails on drift.** Findings land in the report/issue; humans ratify any
  red notes in a normal PR. Fail the job only on infrastructure errors (tool missing, model
  doesn't compile).
- **The report itself is throwaway; the issue is the artifact.** Nothing commits the
  generated `conformance/<date>-report.md`, so the state file's `Last conformance:` line —
  which cites that path — gets written by whoever ratifies the findings locally, in the same
  PR that applies them. If you want the file itself kept, add an `upload-artifact` step or
  have the job open a PR instead of an issue.
- **Diff-scoped by default.** The phase reads the state file's `Last conformance:` marker
  and only walks slices whose code changed since — a weekly run on a quiet repo is cheap.
  Note the marker only advances when a human ratifies the run's outcome and commits the
  state-file update, so unratified scheduled runs re-walk the same span rather than
  silently marking it checked.
- **Cadence, not trigger.** Resist wiring this to every push; a schedule (plus manual
  dispatch before a release or stakeholder review) is the intended shape.
- **Know what the structural diff can see.** `em diff` compares what the `.em` declares —
  in a model that declares `{ fields }` on commands but not events (a common style), an
  event-schema change in code is invisible to the structural diff and is caught instead on
  the spec surface, via the slice docs' event field tables. If event-schema drift matters
  to you structurally, declare event fields in the model.
- **Scope the agent's shell.** `--allowedTools` above grants `Bash` only for `em` and `git`;
  an unattended run has an API key and a full checkout in reach, so widen that list
  deliberately rather than passing a bare `Bash`.
- If the model and code live in different repos, check both out and point the phase at the
  code path when it asks for the target repo (the state file's `Existing system refs`).

## CODEOWNERS: routing ratification review

`em slice ratify` (MIL-165) mechanizes the *edit* — flipping `status` to `ready-to-implement`
and recording `ratifiedBy:`/`ratifiedOn:` in one command
([cli.md](cli.md#em-slice-ratify-file-slice-key---by-name)) — but a mechanized edit is still
just an edit: anyone with commit access can run it, or hand-edit the same frontmatter, unless
the platform itself routes the review. A [CODEOWNERS
file](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
is the mechanical half of that: with **"Require review from Code Owners"** enabled on the
branch's protection rule, GitHub refuses to let a PR touching `slices/**` merge without an
approval from someone the file names — the same enforcement a repo already leans on for any
other reviewed path.

```text
# CODEOWNERS — route slice-doc changes through your designated ratifier(s)
# (docs/process.md#what-ratified-means — the E3 playbook's "ratifier" role, made mechanical)
slices/**  @your-org/ratifiers
```

Notes on the recipe:

- **Route the directory, not the command.** There's no way for CODEOWNERS (or any git hook) to
  distinguish "`ratifiedBy` was set by running `em slice ratify`" from "someone typed the same
  YAML by hand" — both are just a diff to `slices/*.md`. The enforcement point is the *path*:
  every ratification, mechanized or not, touches a file under `slices/**`, so gating that glob
  gates every route to the same edit.
- **List a team, not a person**, where your platform supports it (`@org/team-slug`) — a named
  individual as sole owner becomes a bottleneck (and a single point of failure) the moment
  they're out; GitHub accepts either, but a team survives roster changes without editing the
  file.
- **This is a convention, not something `em` checks.** `em` stays git-only, account-free, and
  server-free (no concept of "who is a ratifier" lives in the tool or the model) — CODEOWNERS
  enforcement lives entirely in your git host's branch protection, alongside whatever other
  required reviews and status checks (e.g. the `em validate` gate above) already apply to the
  same PR.
- **Split the glob further** if different slice groups need different ratifiers (e.g. a
  `payments/` swimlane with its own sign-off) — CODEOWNERS matches the *last* pattern that
  applies to a path, so put narrower patterns after `slices/**`, not before it.
