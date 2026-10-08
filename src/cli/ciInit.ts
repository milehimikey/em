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

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseManifest } from "../system/manifest.js";
import { pluginInstallCommands } from "./pluginPin.js";
import { applyMarker, markerPair, markerRegex } from "../util/markers.js";

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

/** The `skill-check` job - identical in the single-model and multi-model presets (it checks the
 *  repo-wide skill install). Runs when the repo vendors the skill bundle OR pins the em plugin in
 *  `.claude/settings.json` (MIL-231); a plugin repo first registers the pinned plugin on the runner,
 *  because `em skill check --ci` fails when the plugin is not registered on the machine. Ends
 *  without a trailing blank line. */
function skillCheckJob(em: string, emVersion: string): string {
  const [addCmd, installCmd] = pluginInstallCommands(emVersion);
  return `  skill-check:
    name: em skill check (vendored skill / plugin drift)
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Register the pinned em plugin
        run: |
          if grep -Eq '"em-[0-9]+-[0-9]+-[0-9]+"' .claude/settings.json 2>/dev/null; then
            npm i -g @anthropic-ai/claude-code
            ${addCmd}
            ${installCmd}
          else
            echo "no em plugin pinned in .claude/settings.json - nothing to register"
          fi
      - name: Check the em skills match installed em
        run: |
          if [ -d .claude/skills/event-modeling ] || grep -Eq '"em-[0-9]+-[0-9]+-[0-9]+"' .claude/settings.json 2>/dev/null; then
            ${em} skill check --ci
          else
            echo "no vendored skill and no em plugin pin - skipping (install the em plugin to opt in, docs/ai-workflow.md)"
          fi`;
}

/** The `system` job (MIL-239 consumer adaptation, MIL-231 wiring) - multi-model only. Fetches full
 *  history because the failure message names the producer commit. */
function systemJob(em: string): string {
  return `  system:
    name: "em system (consumer adaptation, seam verification)"
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Check seams and consumer adaptation
        run: ${em} system .`;
}

/** The `system-scope` job (MIL-240 seam-crossing gate, MIL-231 wiring) - multi-model only; needs
 *  the base revision. */
function systemScopeJob(em: string): string {
  return `  system-scope:
    name: "em system scope (seam-crossing change set)"
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Check the change set against the seams
        run: |
          base="\${{ github.event.pull_request.base.sha }}"
          ${em} system scope --base "$base"`;
}

/** The `codeowners-check` job (MIL-234 command, MIL-231 wiring) - multi-model presets only: a
 *  single-model repo has no seams to route review for. One job for the whole model set. */
function codeownersCheckJob(em: string): string {
  return `  codeowners-check:
    name: "em system codeowners --check (review routing current)"
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Check the generated CODEOWNERS block is current
        run: ${em} system codeowners --check .`;
}

/** The `glossary` job - identical in both presets (it already spans every tracked `*.em`). */
function glossaryJob(em: string): string {
  return `  glossary:
    name: "em glossary --fail-on-conflicts (cross-model vocabulary)"
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Check glossary consistency across models
        run: |
          mapfile -t models < <(git ls-files '*.em')
          ${em} glossary "\${models[@]}" --fail-on-conflicts`;
}

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

  api-check:
    name: "em api check (contract current; additive/breaking annotation)"
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Check the generated contract is current
        # Fails only when contracts/<model key>.tsp is missing or stale (run em api generate).
        # The additive/breaking lines are annotation for the reviewer, never a gate (MIL-237).
        run: |
          base="\${{ github.event.pull_request.base.sha }}"
          ${em} api check "${model}" --base "$base"

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
        # Counts INV-* IDs in \`implemented\` slice docs only (MIL-207) - a ready-to-implement
        # doc has nothing yet to cite it, so this job is green on a fresh scaffold and on a
        # doc-only ratification PR. Pass --include-ready for the older, forward-looking report.
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

${skillCheckJob(em, emVersion)}

  upgrade-check:
    name: "em upgrade --check (advisory - hard incompatibilities only, MIL-219)"
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Check for hard upgrade incompatibilities
        # Advisory: exits non-zero ONLY on a hard incompatibility (an unparseable state file, an
        # old .em shape em migrate itself refuses) - never on the ordinary "some mechanical
        # steps are applicable" case. See docs/upgrading.md.
        run: ${em} upgrade "${model}" --check

${glossaryJob(em)}

  status-badge:
    name: rebuild status badge (advisory - publish only, never a gate)
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
  return `# Generated once by \`em ci init ${model}\` (em ${emVersion}) - docs/ci.md
#
# This file is yours from here: edit it, add jobs, remove ones you don't want. The content
# between the GENERATED:${CI_WORKFLOW_MARKER} markers below is what a future \`em ci init\`
# (e.g. after upgrading em) refreshes in place - add your own jobs above or below the markers,
# at the same indent under \`jobs:\`, and they survive a re-run untouched. Every gate here fails
# the PR the same way any other required check does; the status-badge job only ever publishes.
# \`em ci init ${model} --check\` reports drift in the managed block - advisory unless you wire
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

// ---- em-ci.yml, multi-model (MIL-233, #174) ----

/** One model of a system, as `em ci init <system.yaml>` hands it to the generators: its manifest
 *  key and its path relative to the repo root (the working directory the workflow runs from). */
export interface CiModel {
  key: string;
  path: string;
}

/** Deterministic, valid GitHub Actions job-id suffix per model key. Keys are kebab-case with an
 *  optional `~N` collision suffix (MIL-193), and `~` is not an Actions id character, so it
 *  becomes `-`; if two keys then collide (`a-2` and `a~2`), the later one in key order gets a
 *  numeric suffix until it is unique. Keys are processed in sorted order, so the mapping never
 *  depends on manifest order. */
export function ciJobIds(keys: string[]): Map<string, string> {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const key of [...keys].sort(compareKeys)) {
    const base = key.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    ids.set(key, id);
  }
  return ids;
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Models in the order the generators emit them (key order, not manifest order) so reordering
 *  the manifest never reads as drift. */
function sortedModels(models: CiModel[]): CiModel[] {
  return [...models].sort((a, b) => compareKeys(a.key, b.key));
}

/** The directory a model's design artifacts live in (R6: `dirname(<model>.em)`). */
export function ciModelDir(modelPath: string): string {
  const d = dirname(modelPath);
  return d === "" ? "." : d;
}

function modelJobs(m: CiModel, id: string, testsDir: string, em: string): string {
  const dir = ciModelDir(m.path);
  const pathspec = dir === "." ? "'*.em'" : `"${dir}/*.em"`;
  const badge = dir === "." ? "status-badge.svg" : `${dir}/status-badge.svg`;
  return `  validate-${id}:
    name: "em validate (changed .em files) [${m.key}]"
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
          changed=$(git diff --name-only "$base" "$head" -- ${pathspec})
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

  api-check-${id}:
    name: "em api check (contract current; additive/breaking annotation) [${m.key}]"
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Check the generated contract is current
        # Fails only when contracts/<model key>.tsp is missing or stale (run em api generate).
        # The additive/breaking lines are annotation for the reviewer, never a gate (MIL-237).
        run: |
          base="\${{ github.event.pull_request.base.sha }}"
          ${em} api check "${m.path}" --base "$base"

  slice-index-${id}:
    name: "em slice index --check (README table drift) [${m.key}]"
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Check README Slices table is current
        run: ${em} slice index "${m.path}" --check

  coverage-${id}:
    name: "em coverage --strict (invariant citations) [${m.key}]"
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Check invariant test coverage
        # Counts INV-* IDs in \`implemented\` slice docs only (MIL-207) - a ready-to-implement
        # doc has nothing yet to cite it, so this job is green on a fresh scaffold and on a
        # doc-only ratification PR. Pass --include-ready for the older, forward-looking report.
        run: ${em} coverage "${m.path}" --tests "${testsDir}" --strict

  ledger-${id}:
    name: "em ledger (slice doc version/content agreement) [${m.key}]"
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
        run: ${em} ledger "${m.path}" --from "\${{ github.event.pull_request.base.sha }}"

  upgrade-check-${id}:
    name: "em upgrade --check (advisory - hard incompatibilities only, MIL-219) [${m.key}]"
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Check for hard upgrade incompatibilities
        # Advisory: exits non-zero ONLY on a hard incompatibility (an unparseable state file, an
        # old .em shape em migrate itself refuses) - never on the ordinary "some mechanical
        # steps are applicable" case. See docs/upgrading.md.
        run: ${em} upgrade "${m.path}" --check

  status-badge-${id}:
    name: "rebuild status badge (advisory - publish only, never a gate) [${m.key}]"
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
        run: ${em} status "${m.path}" --tests "${testsDir}" --badge -o "${badge}"
      - name: Commit badge if changed
        # Every model has its own badge job and they run in parallel on a push, so rebase onto
        # whatever a sibling job pushed first.
        run: |
          git add -- "${badge}"
          if git diff --cached --quiet -- "${badge}"; then
            echo "${badge} unchanged"
            exit 0
          fi
          git config user.name "em-ci"
          git config user.email "em-ci@users.noreply.github.com"
          git commit -m "em ci: rebuild status badge [skip ci]"
          git pull --rebase origin "$GITHUB_REF_NAME"
          git push`;
}

/** The managed block for a whole system: per-model `validate-`/`slice-index-`/`coverage-`/
 *  `ledger-`/`upgrade-check-`/`status-badge-<id>` jobs, then ONE `skill-check` and ONE
 *  `glossary` (both repo-wide). Same version-pin discipline as `ciManagedBody`. */
export function ciManagedBodyMulti(models: CiModel[], testsDir: string, emVersion: string): string {
  const em = `npx @milehimikey/em@${emVersion}`;
  const sorted = sortedModels(models);
  const ids = ciJobIds(sorted.map((m) => m.key));
  const perModel = sorted.map((m) => modelJobs(m, ids.get(m.key)!, testsDir, em));
  return [...perModel, codeownersCheckJob(em), systemJob(em), systemScopeJob(em), skillCheckJob(em, emVersion), glossaryJob(em)].join("\n\n");
}

export function buildCiWorkflowFileMulti(arg: string, models: CiModel[], testsDir: string, emVersion: string): string {
  const { start, end } = markerPair(CI_WORKFLOW_MARKER, "hash");
  return `${ciWorkflowHeader(arg, emVersion)}${start}\n${ciManagedBodyMulti(models, testsDir, emVersion)}\n${end}\n`;
}

// ---- em-conform.yml (scheduled, advisory-only conformance cadence) ----

/** The managed block only (no header/`on:`/`permissions:`/`jobs:` scaffolding) — what gets
 *  written between the marker pair, both for a fresh file and to patch an existing marked one
 *  in place. */
export function conformManagedBody(model: string, emVersion: string, usePlugin = false): string {
  const modelDir = dirname(model) === "." ? "." : dirname(model);
  // MIL-231: a repo that declares the em plugin installs it (pinned to this em's version) and runs
  // /em:conform; any other repo keeps the vendored bundle install and /event-modeling conform.
  const install = usePlugin ? `${pluginInstallCommands(emVersion).join(" && ")}` : "em skill install --force";
  const invoke = usePlugin ? "/em:conform" : "/event-modeling conform";
  return `  conform:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Note reports already present
        run: find "$MODEL_DIR/conformance" -maxdepth 1 -name '*-report.md' 2>/dev/null | sort > /tmp/reports-before

      - name: Run conform phase
        run: |
          npm i -g @milehimikey/em@${emVersion} @anthropic-ai/claude-code
          ${install}
          claude -p "${invoke}" \\
            --allowedTools "Bash(em:*),Bash(git:*),Read,Grep,Glob,Write,Edit"
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}

      - name: Post report
        run: |
          find "$MODEL_DIR/conformance" -maxdepth 1 -name '*-report.md' 2>/dev/null | sort > /tmp/reports-after
          report=$(comm -13 /tmp/reports-before /tmp/reports-after | tail -1)
          if [ -z "$report" ]; then
            echo "the run produced no new report - nothing to post"
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
  return `# Generated once by \`em ci init ${model}\` (em ${emVersion}) - docs/ci.md#conformance-cadence-advisory
#
# This file is yours from here: edit it freely. It is advisory-only by construction - the job
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

export function buildConformWorkflowFile(model: string, emVersion: string, usePlugin = false): string {
  const { start, end } = markerPair(CONFORM_WORKFLOW_MARKER, "hash");
  return `${conformWorkflowHeader(model, emVersion)}${start}\n${conformManagedBody(model, emVersion, usePlugin)}\n${end}\n`;
}

/** Conformance for a whole system: the same single `conform` job fanned out over a matrix of
 *  model directories (`MODEL_DIR: ${{ matrix.model }}`). Directories, not models: two models in
 *  one directory share a conformance folder, so the matrix lists each directory once. */
export function conformManagedBodyMulti(models: CiModel[], emVersion: string, usePlugin = false): string {
  const dirs = [...new Set(models.map((m) => ciModelDir(m.path)))].sort(compareKeys);
  const single = conformManagedBody("x/x.em", emVersion, usePlugin);
  const strategy = `    strategy:\n      fail-fast: false\n      matrix:\n        model:\n${dirs.map((d) => `          - ${JSON.stringify(d)}`).join("\n")}\n`;
  return single
    .replace("    runs-on: ubuntu-latest\n", `    runs-on: ubuntu-latest\n${strategy}`)
    .replace(/MODEL_DIR: x$/, "MODEL_DIR: ${{ matrix.model }}");
}

export function buildConformWorkflowFileMulti(arg: string, models: CiModel[], emVersion: string, usePlugin = false): string {
  const { start, end } = markerPair(CONFORM_WORKFLOW_MARKER, "hash");
  return `${conformWorkflowHeader(arg, emVersion)}${start}\n${conformManagedBodyMulti(models, emVersion, usePlugin)}\n${end}\n`;
}

// ---- Install/check plumbing, one file at a time ----

export type CiFileStatus =
  | { kind: "create"; content: string }
  | { kind: "ok"; content: string }
  | { kind: "stale"; content: string; current: string }
  | { kind: "missing-markers" }
  | { kind: "would-replace"; content: string }
  // MIL-256 (#174) / MIL-233: the existing managed block covers a model SET that does not fit
  // the requested one. Without `--force` this is a refusal (nothing written). `previous` and
  // `requested` are model paths for em-ci.yml, model DIRECTORIES for em-conform.yml (which only
  // bakes `MODEL_DIR` in). `narrowing` distinguishes the two causes: false = the sets are
  // disjoint; true = a single `<model.em>` was requested against a block covering several models,
  // which would silently drop all but one of them.
  | { kind: "other-models"; previous: string[]; requested: string[]; narrowing: boolean }
  // The same condition under `--force`: the managed block is replaced; the generated header
  // comment (outside the markers) is retargeted too when it still has its generated wording.
  | { kind: "replace-models"; content: string; previous: string[]; requested: string[]; narrowing: boolean };

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * The model SET an existing managed block was generated for, read from the block's own content
 * (MIL-256, widened to sets by MIL-233). Deliberately content-derived rather than a new marker
 * line: blocks written by em 1.13.0 and earlier carry no machine-readable model, but every one
 * of them bakes the model into the per-model `run:` lines. em-ci.yml: every
 * `slice index "<model>" --check` line (one per model); em-conform.yml: every `matrix.model`
 * entry of a multi-model block, else the single `MODEL_DIR: <dir>` line. None of these patterns
 * includes the `npx @milehimikey/em@<ver>` pin, so a version difference can never read as a
 * different model. Returns `[]` when the block was hand-edited past recognition - callers then
 * treat it as covering the requested models (the conservative, pre-MIL-256 behavior) rather than
 * refusing on a guess.
 */
export function managedBlockModels(markerName: string, blockBody: string): string[] {
  if (markerName === CONFORM_WORKFLOW_MARKER) {
    const lines = blockBody.split("\n");
    const at = lines.findIndex((l) => /^\s*matrix:\s*$/.test(l));
    if (at >= 0) {
      const flow = /^\s*model:\s*\[(.*)\]\s*$/.exec(lines[at + 1] ?? "");
      if (flow) return dedupe(flow[1].split(",").map((v) => unquoteScalar(v.trim())).filter((v) => v !== ""));
      if (/^\s*model:\s*$/.test(lines[at + 1] ?? "")) {
        const out: string[] = [];
        for (const l of lines.slice(at + 2)) {
          const item = /^\s*- (.+?)\s*$/.exec(l);
          if (!item) break;
          out.push(unquoteScalar(item[1]));
        }
        return dedupe(out);
      }
    }
    const m = /^\s*MODEL_DIR: (.+?)\s*$/m.exec(blockBody);
    return m && !m[1].startsWith("${{") ? [m[1]] : [];
  }
  return dedupe([...blockBody.matchAll(/\bslice index "([^"]*)" --check\b/g)].map((m) => m[1]));
}

function unquoteScalar(v: string): string {
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
}

function existingBlockBody(content: string, markerName: string): string | null {
  const m = markerRegex(markerName, "hash").exec(content);
  return m ? m[2] : null;
}

/** The model set of an existing workflow file's managed block (`[]` when unmarked/unreadable). */
export function fileBlockModels(content: string, markerName: string): string[] {
  const body = existingBlockBody(content, markerName);
  return body === null ? [] : managedBlockModels(markerName, body);
}

/** `--check`'s extra detail for a stale multi-model block: which models the manifest adds and
 *  which the workflow still names that the manifest no longer does. `null` when the sets agree. */
export function describeSetChange(previous: string[], requested: string[]): string | null {
  const added = requested.filter((m) => !previous.includes(m));
  const removed = previous.filter((m) => !requested.includes(m));
  if (added.length === 0 && removed.length === 0) return null;
  const parts: string[] = [];
  if (added.length > 0) parts.push(`no section for ${added.join(", ")}`);
  if (removed.length > 0) parts.push(`section for ${removed.join(", ")} is not in the manifest`);
  return parts.join("; ");
}

/** The one-line explanation of an `other-models` refusal (also printed by `--check`), ending in
 *  what to do about it. Names both sets. */
export function describeOtherModels(path: string, status: { previous: string[]; requested: string[]; narrowing: boolean }): string {
  if (status.narrowing) {
    return `${path} covers ${status.previous.length} models (${status.previous.join(", ")}) - re-run with the system manifest, or --force to narrow it to ${status.requested.join(", ")}`;
  }
  return `${path} was generated for ${status.previous.join(", ")}, not ${status.requested.join(", ")} - re-run with --force to replace it`;
}

/** `--force` over another model set's block also retargets the generated header's own wording
 *  (`em ci init <arg>` on `#` comment lines above the start marker) at the new argument, taken
 *  from the freshly generated header. Only those exact generated phrasings are touched; a
 *  header the repo reworded, and everything below the start marker, is left alone. */
function retargetHeader(content: string, generated: string, markerName: string): string {
  const startLine = markerPair(markerName, "hash").start;
  const at = content.indexOf(startLine);
  const nextModel = /^#.*`em ci init ([^ `]+)/m.exec(generated)?.[1];
  if (at < 0 || !nextModel) return content;
  const head = content.slice(0, at).replace(/^(#.*`em ci init )([^ `]+)/gm, (_w, pre: string) => `${pre}${nextModel}`);
  return head + content.slice(at);
}

/**
 * Decide what to do with one generated file: create it if missing, patch the managed block if
 * the marker pair is present, or (without `force`) leave an existing unmarked file alone. Pure
 * — never touches disk; `applyCiFile` below does the actual write.
 *
 * `generated` is the full from-scratch file content (header + `on:`/`jobs:` scaffolding +
 * marker-wrapped body) — written verbatim for `create`/`would-replace`. `managedBody` is just
 * the text between the markers, reused to patch an existing marked file in place without
 * touching whatever a repo added around it.
 *
 * Block identity (MIL-256 #174, MIL-233): a block is identified by the SET of models it names
 * (`managedBlockModels`). The requested set wins unless that would lose models by accident:
 *   - disjoint sets are `other-models` (refused without `force`, `replace-models` with it);
 *   - `multi` false (a single `<model.em>` argument) against a block naming several models is
 *     `other-models` too (`narrowing`) - the single-model form must never silently narrow it;
 *   - otherwise (same set, superset, subset or overlap, requested from the system manifest) the
 *     block is regenerated for the requested set - `stale` when anything differs, e.g. a version
 *     pin, an added model or a removed one.
 * `em upgrade`'s ci-block step re-derives its arguments from the existing file (and, for a
 * multi-model block, from the manifest), so it only ever plans the same set.
 */
export function planCiFile(
  path: string,
  generated: string,
  managedBody: string,
  markerName: string,
  force: boolean,
  multi = false,
): CiFileStatus {
  if (!existsSync(path)) return { kind: "create", content: generated };

  const original = readFileSync(path, "utf8");
  const updated = applyMarker(original, markerName, managedBody, "hash");

  if (updated === null) {
    return force ? { kind: "would-replace", content: generated } : { kind: "missing-markers" };
  }
  if (updated === original) return { kind: "ok", content: original };

  const previous = fileBlockModels(original, markerName);
  const requested = managedBlockModels(markerName, managedBody);
  if (previous.length > 0 && requested.length > 0) {
    const overlap = requested.some((m) => previous.includes(m));
    const narrowing = overlap && !multi && previous.length > 1;
    if (!overlap || narrowing) {
      if (!force) return { kind: "other-models", previous, requested, narrowing };
      return { kind: "replace-models", content: retargetHeader(updated, generated, markerName), previous, requested, narrowing };
    }
  }
  return { kind: "stale", content: updated, current: original };
}

export function applyCiFile(path: string, status: CiFileStatus): void {
  if (status.kind === "create" || status.kind === "stale" || status.kind === "would-replace" || status.kind === "replace-models") {
    writeFileSync(path, status.content, "utf8");
  }
}

// ---- `em ci init <system.yaml>`: the model list (MIL-233) ----

export type CiModelsResult = { ok: true; models: CiModel[]; manifestPath: string } | { ok: false; message: string };

/** Read the system manifest at `target` (a file, or a directory holding `system.yaml`) and turn
 *  its `models:` into `CiModel`s whose paths are relative to `baseDir` - the repo root the
 *  workflows run from. Reuses MIL-235's `parseManifest`; compiling the models is not needed to
 *  write a workflow, so a model that does not compile does not block it. Every path goes through
 *  `findUnsafeCiInitArg`; a source must be a `.em` file inside `baseDir`. */
export function ciModelsFromManifest(target: string, baseDir: string): CiModelsResult {
  let manifestPath = target;
  try {
    if (statSync(target).isDirectory()) manifestPath = join(target, "system.yaml");
  } catch {
    return { ok: false, message: `cannot read ${target}` };
  }
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch {
    return { ok: false, message: `cannot read ${manifestPath}` };
  }
  const parsed = parseManifest(text);
  if (!parsed.ok) {
    return { ok: false, message: `${manifestPath} is not a valid system manifest: ${parsed.diagnostics.map((d) => d.message).join("; ")}` };
  }
  const models: CiModel[] = [];
  for (const entry of parsed.manifest.models) {
    if (!entry.source.endsWith(".em")) {
      return { ok: false, message: `${manifestPath}: model "${entry.key}" source ${entry.source} is not a .em file - the CI jobs run em against .em sources` };
    }
    const rel = relative(resolve(baseDir), resolve(dirname(manifestPath), entry.source)).split(sep).join("/");
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return { ok: false, message: `${manifestPath}: model "${entry.key}" source ${entry.source} is outside the repository root (${baseDir})` };
    }
    const unsafe = findUnsafeCiInitArg(rel);
    if (unsafe) {
      return { ok: false, message: `${manifestPath}: model "${entry.key}" path must not contain '"', '\`', '$', or a newline: ${unsafe}` };
    }
    models.push({ key: entry.key, path: rel });
  }
  return { ok: true, models, manifestPath };
}
