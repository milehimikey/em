# CI recipe

`em validate` is deterministic and side-effect-free, which makes it a natural merge gate: run
it on every `.em` file a pull request touches, and fail the check the same way any other
linter would. This is a copy-paste GitHub Actions workflow that does that, plus an optional
`em export` artifact step for downstream tooling.

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
snapshot of the model — the shape downstream tooling (dashboards, generators, an MCP server,
a future `em diff`) should consume instead of re-parsing the `.em` DSL. A natural extension of
the job above is an artifact-upload step per changed file:

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

## Conformance cadence (advisory)

Once a model's slices are `implemented`, the bundled skill's `conform` phase can check the
codebase against the model on a schedule — drift surfaces as an advisory report, never a
failed build. The pattern is a scheduled job that runs Claude Code headless with the
event-modeling skill installed and asks it to run the phase:

```yaml
name: model-conformance
on:
  schedule:
    - cron: "0 6 * * 1"   # weekly, Monday morning
  workflow_dispatch: {}     # and on demand

jobs:
  conform:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4          # the repo holding model + code
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - name: Run conform phase
        run: |
          npm i -g @milehimikey/em
          em skill install
          claude -p "/event-modeling conform" --allowedTools "Bash,Read,Grep,Glob,Write,Edit"
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - name: Post report
        run: |
          report=$(ls -t "$MODEL_DIR"/conformance/*-report.md | head -1)
          gh issue create --title "Model conformance report $(date +%F)" \
            --body-file "$report" --label conformance
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          MODEL_DIR: docs/model   # wherever the model lives
```

Ground rules, matching the phase's own stance (see the skill's `reference/conform.md`):

- **The job never fails on drift.** Findings land in the report/issue; humans ratify any
  red notes in a normal PR. Fail the job only on infrastructure errors (tool missing, model
  doesn't compile).
- **Diff-scoped by default.** The phase reads the state file's `Last conformance:` marker
  and only walks slices whose code changed since — a weekly run on a quiet repo is cheap.
  Note the marker only advances when a human ratifies the run's outcome and commits the
  state-file update, so unratified scheduled runs re-walk the same span rather than
  silently marking it checked.
- **Cadence, not trigger.** Resist wiring this to every push; a schedule (plus manual
  dispatch before a release or stakeholder review) is the intended shape.
- If the model and code live in different repos, check both out and point the phase at the
  code path when it asks for the target repo (the state file's `Existing system refs`).
