// SPDX-License-Identifier: MIT
// `em ci init` (MIL-166): scaffolds the CI enforcement preset docs/ci.md describes as a
// copy-paste cookbook into two installed, plain GitHub Actions workflow files — converting
// "machines check this" from available (a recipe someone has to know to copy) to default (a
// command that installs it). Every check the preset wires already exists as its own `em`
// command (docs/ci.md); this module only owns the YAML wiring around them.
//
// Same install discipline as `em skill install`/`em slice index` (see their own modules):
//   - marker-delimited (src/util/markers.ts's "hash" style, since YAML has no `<!-- -->`
//     comment syntax) — the managed job block sits between `# GENERATED:em-ci:start` /
//     `# GENERATED:em-ci:end`, so a repo can add its own jobs above or below the markers, at
//     the same indent under `jobs:`, and keep them across a future re-run.
//   - idempotent — re-running with nothing changed leaves both files byte-identical; a file
//     that already exists without our markers is left alone unless `--force` says to replace
//     it wholesale (matching `em skill install`: existing-and-no-force is reported, not an
//     error).
//   - `--check` for CI self-verification — never writes; reports whether the managed block in
//     each file still matches what the current preset would generate (missing / no-markers /
//     stale / ok), CI-ready the same way `em slice index --check` is.
//
// The generated files are handed to the repo, not owned by `em` forever: past the initial
// `em ci init`, edit them freely (see each file's own header comment). `--check` is there for a
// team that would rather pin the vanilla preset and gate on drift — opt-in, the same posture
// docs/ci.md already recommends for `em skill check` ("if you'd rather pin ... add `em skill
// check` as its own gate instead of silently overwriting").

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyMarker, markerPair } from "../util/markers.js";

export const CI_WORKFLOW_MARKER = "em-ci";
export const CONFORM_WORKFLOW_MARKER = "em-conform";

const CI_WORKFLOW_RELPATH = join(".github", "workflows", "em-ci.yml");
const CONFORM_WORKFLOW_RELPATH = join(".github", "workflows", "em-conform.yml");

export function ciWorkflowPath(repoRoot: string): string {
  return join(repoRoot, CI_WORKFLOW_RELPATH);
}
export function conformWorkflowPath(repoRoot: string): string {
  return join(repoRoot, CONFORM_WORKFLOW_RELPATH);
}

/** Characters that would break out of the double-quoted shell strings the generated workflow
 *  embeds `model`/`testsDir` into (`"model.em"`, `"test"`) — same validate-the-input-not-the-
 *  output posture as `em scaffold`'s name check (src/cli.ts). */
const UNSAFE_ARG_CHARS = /["`$\n]/;

export function findUnsafeCiInitArg(value: string): string | null {
  return UNSAFE_ARG_CHARS.test(value) ? value : null;
}

// ---- em-ci.yml (PR gates + push-triggered badge rebuild) ----

/** The managed block only (no header/`on:`/`jobs:` scaffolding) — what gets written between
 *  the marker pair, both for a fresh file and to patch an existing marked one in place.
 *
 *  Every `npx @milehimikey/em` invocation pins the generating em's own exact version
 *  (MIL-188): an unpinned line floats to whatever `latest` resolves to on the runner that
 *  day, which is the opposite of a preset. Because the pin lives inside the managed body,
 *  `--check` from a different em version reports the block as stale — the same
 *  upgrade-visibility `em skill check` gets from its version stamp — and a file scaffolded
 *  by a pre-pin em shows stale the same way. */
export function ciManagedBody(model: string, testsDir: string, emVersion: string): string {
  const em = `npx @milehimikey/em@${emVersion}`;
  return `  validate:
    name: em validate (changed .em files)
    if: github.event_name == 'pull_request'
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
          base="\${{ github.event.pull_request.base.sha }}"
          head="\${{ github.event.pull_request.head.sha }}"
          changed=$(git diff --name-only "$base" "$head" -- '*.em')
          if [ -z "$changed" ]; then
            echo "no .em files changed"
            exit 0
          fi
          status=0
          for f in $changed; do
            echo "::group::em validate $f"
            ${em} validate "$f" || status=1
            ${em} validate "$f" --list-issues
            echo "::endgroup::"
          done
          exit $status

  slice-index:
    name: "em slice index --check (README table drift)"
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Check README Slices table is current
        run: ${em} slice index "${model}" --check

  coverage:
    name: "em coverage --strict (invariant citations)"
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Check invariant test coverage
        run: ${em} coverage "${model}" --tests "${testsDir}" --strict

  ledger:
    name: em ledger (slice doc version/content agreement)
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Check slice doc version/content agreement
        run: ${em} ledger "${model}" --from "\${{ github.event.pull_request.base.sha }}"

  skill-check:
    name: em skill check (vendored skill drift)
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Check vendored skill matches installed em
        run: |
          if [ -d .claude/skills/event-modeling ]; then
            ${em} skill check
          else
            echo "no vendored skill at .claude/skills/event-modeling — skipping (run \`em skill install\` to opt in)"
          fi

  glossary:
    name: "em glossary --fail-on-conflicts (cross-model vocabulary)"
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Check glossary consistency across models
        run: ${em} glossary $(git ls-files '*.em') --fail-on-conflicts

  status-badge:
    name: rebuild status badge (advisory — publish only, never a gate)
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Rebuild status badge
        run: ${em} status "${model}" --tests "${testsDir}" --badge -o status-badge.svg
      - name: Commit badge if changed
        run: |
          if git diff --quiet -- status-badge.svg; then
            echo "status-badge.svg unchanged"
            exit 0
          fi
          git config user.name "em-ci"
          git config user.email "em-ci@users.noreply.github.com"
          git add status-badge.svg
          git commit -m "em ci: rebuild status badge [skip ci]"
          git push`;
}

function ciWorkflowHeader(model: string, emVersion: string): string {
  return `# Generated once by \`em ci init ${model}\` (em ${emVersion}) — docs/ci.md
#
# This file is yours from here: edit it, add jobs, remove ones you don't want. The content
# between the GENERATED:${CI_WORKFLOW_MARKER} markers below is what a future \`em ci init\`
# (e.g. after upgrading em) refreshes in place — add your own jobs above or below the markers,
# at the same indent under \`jobs:\`, and they survive a re-run untouched. Every gate here fails
# the PR the same way any other required check does; the status-badge job only ever publishes.
# \`em ci init ${model} --check\` reports drift in the managed block — advisory unless you wire
# it into a gate yourself (docs/ci.md).
name: em ci

on:
  pull_request:
    paths:
      - "**/*.em"
      - "**/slices/**"
      - "**/README.md"
  push:
    branches: [main]

jobs:
`;
}

// Marker comment lines sit at column 0, not indented to the 2-space job-key column: YAML
// comments are whitespace-agnostic (indentation only matters for actual content nodes), and
// `applyMarker`'s regex only ever recognizes the marker text itself, not any indentation before
// it on the same line — a fixed indent here would get silently swallowed into the discarded
// middle capture group on the very first re-patch (was a real bug during development: the
// closing marker's leading spaces vanished on a second `em ci init` run).
export function buildCiWorkflowFile(model: string, testsDir: string, emVersion: string): string {
  const { start, end } = markerPair(CI_WORKFLOW_MARKER, "hash");
  return `${ciWorkflowHeader(model, emVersion)}${start}\n${ciManagedBody(model, testsDir, emVersion)}\n${end}\n`;
}

// ---- em-conform.yml (scheduled, advisory-only conformance cadence) ----

/** The managed block only (no header/`on:`/`permissions:`/`jobs:` scaffolding) — what gets
 *  written between the marker pair, both for a fresh file and to patch an existing marked one
 *  in place. */
export function conformManagedBody(model: string, emVersion: string): string {
  const modelDir = dirname(model) === "." ? "." : dirname(model);
  return `  conform:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Note reports already present
        run: ls "$MODEL_DIR"/conformance/*-report.md 2>/dev/null | sort > /tmp/reports-before

      - name: Run conform phase
        run: |
          npm i -g @milehimikey/em@${emVersion} @anthropic-ai/claude-code
          em skill install --force
          claude -p "/event-modeling conform" \\
            --allowedTools "Bash(em:*),Bash(git:*),Read,Grep,Glob,Write,Edit"
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}

      - name: Post report
        run: |
          ls "$MODEL_DIR"/conformance/*-report.md 2>/dev/null | sort > /tmp/reports-after
          report=$(comm -13 /tmp/reports-before /tmp/reports-after | tail -1)
          if [ -z "$report" ]; then
            echo "the run produced no new report — nothing to post"
            exit 0
          fi
          gh issue create --title "Model conformance report $(date +%F)" \\
            --body-file "$report"
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
    env:
      MODEL_DIR: ${modelDir}`;
}

function conformWorkflowHeader(model: string, emVersion: string): string {
  return `# Generated once by \`em ci init ${model}\` (em ${emVersion}) — docs/ci.md#conformance-cadence-advisory
#
# This file is yours from here: edit it freely. It is advisory-only by construction — the job
# never fails the build on drift (findings become a GitHub issue for a human to ratify), and
# the state file's \`Last conformance:\` marker only advances when a human ratifies the run's
# outcome locally and commits that update. Resist wiring this to every push; cadence, not
# trigger, is the intended shape (docs/ci.md).
name: model-conformance

on:
  schedule:
    - cron: "0 6 * * 1"     # weekly, Monday 06:00 UTC
  workflow_dispatch: {}     # and on demand

permissions:
  contents: read
  issues: write             # the Post report step opens an issue

jobs:
`;
}

export function buildConformWorkflowFile(model: string, emVersion: string): string {
  const { start, end } = markerPair(CONFORM_WORKFLOW_MARKER, "hash");
  return `${conformWorkflowHeader(model, emVersion)}${start}\n${conformManagedBody(model, emVersion)}\n${end}\n`;
}

// ---- Install/check plumbing, one file at a time ----

export type CiFileStatus =
  | { kind: "create"; content: string }
  | { kind: "ok"; content: string }
  | { kind: "stale"; content: string; current: string }
  | { kind: "missing-markers" }
  | { kind: "would-replace"; content: string };

/**
 * Decide what to do with one generated file: create it if missing, patch the managed block if
 * the marker pair is present, or (without `force`) leave an existing unmarked file alone. Pure
 * — never touches disk; `applyCiFile` below does the actual write.
 *
 * `generated` is the full from-scratch file content (header + `on:`/`jobs:` scaffolding +
 * marker-wrapped body) — written verbatim for `create`/`would-replace`. `managedBody` is just
 * the text between the markers, reused to patch an existing marked file in place without
 * touching whatever a repo added around it.
 */
export function planCiFile(
  path: string,
  generated: string,
  managedBody: string,
  markerName: string,
  force: boolean,
): CiFileStatus {
  if (!existsSync(path)) return { kind: "create", content: generated };

  const original = readFileSync(path, "utf8");
  const updated = applyMarker(original, markerName, managedBody, "hash");

  if (updated === null) {
    return force ? { kind: "would-replace", content: generated } : { kind: "missing-markers" };
  }
  return updated === original ? { kind: "ok", content: original } : { kind: "stale", content: updated, current: original };
}

export function applyCiFile(path: string, status: CiFileStatus): void {
  if (status.kind === "create" || status.kind === "stale" || status.kind === "would-replace") {
    writeFileSync(path, status.content, "utf8");
  }
}
