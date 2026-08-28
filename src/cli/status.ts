// SPDX-License-Identifier: MIT
// `em status` (MIL-163): one deterministic command that answers "what state is the system in"
// over one or more models — the surface a reader currently has to assemble by hand from the
// README's Slices table, a conformance report, and `.event-modeling.md`. Pure aggregation over
// exports the rest of `em` already computes; nothing here re-derives a fact another module owns:
//
//  - lifecycle status / driftSignal come from the same doc join `em export`/`em coverage` use
//    (catalog/docJoin.ts's resolveSliceDocJoin, catalog/driftSignal.ts's classification).
//  - open Open Questions counts come from the same slice-doc parse `em coverage`'s scope check
//    already reads (catalog/sliceDoc.ts's openQuestionsTotal/openQuestionsUnchecked).
//  - invariant coverage totals come from `em coverage`'s own report builder (./coverage.ts),
//    summed across every input model rather than re-implemented.
//  - last-conformance + commits-behind-HEAD reuses stateFile.ts's parser and the same injectable
//    GitRunner convention conform-scope.ts/diff-inputs.ts use, so every git failure branch stays
//    unit-testable without a real repository.
//  - slice-PRs-behind-HEAD (MIL-164) reuses conform-scope.ts's own machinery outright —
//    `changedPathsSince` + `buildConformScope` — rather than re-deriving the
//    implementedIn-to-changed-path match rule a second time. The standalone surface for this
//    freshness clause alone (no full model rollup needed) is `em freshness` (freshness.ts).
//
// Deterministic core: no LLM calls, no wall-clock timestamps in the output, byte-stable for the
// same inputs. Text/markdown/badge are formatting layers over one aggregated StatusReport; the
// JSON document (emit/statusJson.ts) is a versioned envelope around the exact same object.

import { basename, dirname, resolve } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { resolveSliceDocJoin, DocReason } from "../catalog/docJoin.js";
import { readSliceDoc } from "../catalog/readSliceDoc.js";
import { DriftSignalKind } from "../catalog/driftSignal.js";
import { Diagnostic } from "../model/validate.js";
import { CoverageReport } from "./coverage.js";
import { GitRunner, realGit } from "./diff-inputs.js";
import { loadStateFile, parseState } from "./stateFile.js";
import { SliceDocFacts, changedPathsSince, buildConformScope } from "./conformScope.js";

/** The 4 canonical slice-doc lifecycle statuses (docs/slice-doc-schema.md) — the same enum
 *  `em catalog`'s header coloring and `em render`'s status legend already recognize. */
export const CANONICAL_STATUSES = ["draft", "reviewed", "ready-to-implement", "implemented"] as const;
export type CanonicalStatus = (typeof CANONICAL_STATUSES)[number];

/** Bucket a slice's lifecycle status falls into for the rollup: one of the 4 canonical values,
 *  `"no-doc"` (no doc bound at all, or the binding names a missing file — `resolveSliceDocJoin`'s
 *  `found: false`), `"frontmatter-invalid"` (a doc WAS found — a note binds it — but its
 *  frontmatter is missing or malformed, so nothing reliable can be read from it; kept distinct
 *  from `"no-doc"` because "nothing was ever referenced" and "something's referenced but broken"
 *  are different states worth telling apart in a rollup), or `"unknown"` (a doc was found and its
 *  frontmatter usable, but `status` isn't one of the 4 canonical strings — a freeform doc,
 *  matching `em slice index`'s own "unknown" convention). */
export type StatusBucket = CanonicalStatus | "no-doc" | "frontmatter-invalid" | "unknown";

export function classifyStatusBucket(found: boolean, reason: DocReason, status: string | null): StatusBucket {
  if (!found) return "no-doc";
  if (reason === "frontmatter-invalid") return "frontmatter-invalid";
  if (status !== null && (CANONICAL_STATUSES as readonly string[]).includes(status)) return status as CanonicalStatus;
  return "unknown";
}

/** One slice's status-rollup facts, joined from the same doc read every doc-aware command
 *  shares — never a second parse of the model or the doc. */
export interface SliceStatusFact {
  file: string;
  key: string;
  docFound: boolean;
  docReason: DocReason;
  /** Resolved absolute path to the bound doc file, or null when none was found. Two slices can
   *  legitimately resolve to the SAME doc (MIL-121 `covers:` cross-binding, one doc ratifying
   *  coverage for several slices) — this is how `buildStatusReport` dedupes doc-body-derived
   *  counts (Open Questions) so a shared doc's single unresolved question isn't counted once per
   *  covered slice. */
  docPath: string | null;
  rawStatus: string | null;
  /** The doc's own `implementedIn:` value verbatim (or null) — carried through from the same
   *  `resolveSliceDocJoin` call this fact set already makes, so `resolveSlicePRsBehindHead`
   *  (MIL-164) can build its `SliceDocFacts[]` input from these facts directly rather than
   *  joining every slice's doc a second time. */
  implementedIn: string | null;
  bucket: StatusBucket;
  driftSignal: DriftSignalKind | null;
  openQuestionsTotal: number;
  openQuestionsUnchecked: number;
}

export interface SliceStatusFactsResult {
  facts: SliceStatusFact[];
  /** Doc-join diagnostics (`binding-missing-file`/`frontmatter-invalid` warnings) raised while
   *  resolving each slice's doc — the same diagnostics `em export`'s doc join raises. Carried
   *  back rather than dropped: a state-of-the-system report shouldn't silently swallow "this
   *  slice's doc reference is broken." */
  diagnostics: Diagnostic[];
}

/**
 * Resolve every slice's status-rollup facts for one already-compiled model. `baseDir` is the
 * `.em` file's directory, same doc-resolution convention every other doc-aware command uses.
 * Open Questions counts are read from the slice's OWN bound doc (re-deriving the key from
 * `doc.path`, not assuming it's this slice's own — MIL-121 cross-binding can resolve to a
 * different slice's doc, same re-derivation `em coverage`/`--slice-ready` use) rather than a
 * second independent parse.
 */
export function resolveSliceStatusFacts(file: string, model: NormalizedModel, refs: RefsResult, baseDir: string): SliceStatusFactsResult {
  const diagnostics: Diagnostic[] = [];
  const facts = model.slices.map((slice, i) => {
    const key = refs.sliceKeys[i];
    const { doc, diagnostics: docDiags } = resolveSliceDocJoin(slice, key, baseDir, (id) => refs.refById.get(id)!);
    diagnostics.push(...docDiags);

    let docPath: string | null = null;
    let openQuestionsTotal = 0;
    let openQuestionsUnchecked = 0;
    if (doc.found) {
      const boundKey = doc.path.replace(/^slices\//, "").replace(/\.md$/, "");
      docPath = resolve(baseDir, doc.path);
      const parsed = readSliceDoc(baseDir, boundKey);
      if (parsed) {
        openQuestionsTotal = parsed.openQuestionsTotal;
        openQuestionsUnchecked = parsed.openQuestionsUnchecked;
      }
    }

    return {
      file,
      key,
      docFound: doc.found,
      docReason: doc.reason,
      docPath,
      rawStatus: doc.status,
      implementedIn: doc.implementedIn,
      bucket: classifyStatusBucket(doc.found, doc.reason, doc.status),
      driftSignal: doc.driftSignal,
      openQuestionsTotal,
      openQuestionsUnchecked,
    };
  });
  return { facts, diagnostics };
}

/** Open `issue "text"` markers in a model — the same predicate `em validate --list-issues`
 *  counts, here reduced to a bare count for the rollup. */
export function countOpenIssues(model: NormalizedModel): number {
  return model.elements.filter((el) => el.issue).length;
}

// ---- Conformance (last-conformance revision + commits-behind-HEAD) ----

export interface ConformanceEntry {
  file: string;
  modelDir: string;
  hasStateFile: boolean;
  lastConformance: { date: string; revision: string } | null;
  /** The repo `commitsBehindHead` was computed in — `--repo` when given, else the model's own
   *  directory (works out of the box for a single-repo project; conform-scope's `--repo`
   *  convention still applies for a model whose implementation lives in a different repo). */
  repo: string;
  commitsBehindHead: number | null;
  /** Slices whose bound doc's `implementedIn:` maps to a path changed since `lastConformance`'s
   *  revision (MIL-164) — the same `candidateSlices` computation `em conform-scope` makes for
   *  one model at a time (`conformScope.ts`'s `changedPathsSince` + `buildConformScope`), rolled
   *  up here to a single count: "how many slices likely shipped code since the last conform
   *  sweep." Each candidate slice typically corresponds to one merged slice PR, hence the name.
   *  Null under the same conditions `commitsBehindHead` is null — it needs the same revision to
   *  diff against, and by construction is only ever null when `error` is also set (see
   *  `resolveConformanceEntry` below): a bare "opted out of computing this" state doesn't occur
   *  on the real CLI/MCP call paths, which always supply `sliceDocFacts`. */
  slicePRsBehindHead: number | null;
  /** Set when the state file exists and parses, but git couldn't answer commits-behind-HEAD or
   *  slice-PRs-behind-HEAD (not a git repo, unknown revision, ...) — reported per-model rather
   *  than aborting the whole rollup, since `em status` is a soft report, not a gate. Also carries
   *  a state-file parse failure (unparseable `Last conformance:` bullet), same non-fatal
   *  treatment. */
  error: string | null;
}

/**
 * `git rev-list --count <revision>..HEAD` in `repo` (any directory inside it, not necessarily
 * its root — same "anchor dir, resolve toplevel" convention `conformScope.ts`'s
 * `changedPathsSince` uses). The git runner is injectable so every failure branch is
 * unit-testable without a real repository.
 */
export function commitsBehindHead(repo: string, revision: string, runGit: GitRunner = realGit): { ok: true; count: number } | { ok: false; message: string } {
  const toplevel = runGit(["-C", repo, "rev-parse", "--show-toplevel"]);
  if (toplevel.status !== 0) {
    return { ok: false, message: `em status: ${repo} is not a git repository` };
  }
  const repoRoot = toplevel.stdout.trim();
  const result = runGit(["-C", repoRoot, "rev-list", "--count", `${revision}..HEAD`]);
  if (result.status !== 0) {
    return {
      ok: false,
      message: `em status: git rev-list failed: ${(result.stderr || "").trim() || `unknown revision "${revision}"`}`,
    };
  }
  const count = parseInt(result.stdout.trim(), 10);
  if (Number.isNaN(count)) {
    return { ok: false, message: `em status: unexpected git rev-list output for revision "${revision}"` };
  }
  return { ok: true, count };
}

/**
 * `M` in "N commits and M slice-PRs behind HEAD" (MIL-164) — how many slices whose doc's
 * `implementedIn:` names a path this model's target repo changed since `revision`. Reuses the
 * exact `em conform-scope` machinery for one model at a time: `changedPathsSince` (the same
 * `git diff --name-only <revision>..HEAD` walk, same injectable `GitRunner`) to get the changed
 * paths, then `buildConformScope`'s own `implementedIn`-prefix matching (never fuzzy, never a
 * second guess) to turn them into a candidate-slice count. `full` is always `false` here — this
 * is only ever called once `lastConformance` is known non-null (see `resolveConformanceEntry`
 * below), so there is always a revision to diff against.
 */
export function resolveSlicePRsBehindHead(
  repo: string,
  revision: string,
  slices: SliceDocFacts[],
  runGit: GitRunner = realGit,
): { ok: true; count: number } | { ok: false; message: string } {
  const changed = changedPathsSince(repo, revision, runGit);
  if (!changed.ok) return { ok: false, message: changed.message };
  // `date`/`report` are irrelevant to matching (buildConformScope only echoes them back in its
  // own `lastConformance` field, which this function discards) — only `revision` drives the
  // implementedIn-to-changed-path match below.
  const scope = buildConformScope(slices, { date: "", revision, report: "" }, changed.paths, false);
  return { ok: true, count: scope.candidateSlices.length };
}

/**
 * Resolve one model's conformance entry: read its sibling state file (if any — not every model
 * has reached the `conform` phase, so a missing state file is routine, not an error), then
 * compute commits-behind-HEAD and slice-PRs-behind-HEAD (MIL-164) when `Last conformance:` is
 * set. `repoOverride` is `--repo`; omitted, each model's own directory is used as the repo to
 * walk (the common single-repo project case — see `repo` field doc above). `sliceDocFacts` is
 * THIS model's own slice facts (`key`/`status`/`implementedIn`) — the caller's responsibility to
 * scope correctly per file, since `resolveSlicePRsBehindHead` matches against exactly this
 * model's slices, not some other input model's.
 *
 * A state file is shared by every `.em` file in its directory (`.event-modeling.md` has no
 * per-model namespacing), but its `Model file:` bullet names exactly ONE of them — so a sibling
 * file it does NOT describe (the common case: a `conform-scope --seed-asis` scratch copy like
 * `checkout-asis.em` sitting next to `checkout.em`) must not inherit `checkout.em`'s conformance
 * record just because it lives in the same directory. When `Model file:` is set and doesn't match
 * `basename(file)`, the record is reported as unattributed (via `error`, the same non-fatal
 * channel a git failure uses) rather than silently misattributed.
 */
export function resolveConformanceEntry(
  file: string,
  repoOverride: string | undefined,
  sliceDocFacts: SliceDocFacts[],
  runGit: GitRunner = realGit,
): ConformanceEntry {
  const modelDir = dirname(file);
  const repo = repoOverride ?? modelDir;
  const loaded = loadStateFile(modelDir);
  if (!loaded.ok) {
    return { file, modelDir, hasStateFile: false, lastConformance: null, repo, commitsBehindHead: null, slicePRsBehindHead: null, error: null };
  }
  const parsed = parseState(loaded.text);
  if (!parsed.ok) {
    return {
      file,
      modelDir,
      hasStateFile: true,
      lastConformance: null,
      repo,
      commitsBehindHead: null,
      slicePRsBehindHead: null,
      error: `state file: ${parsed.message}`,
    };
  }
  if (parsed.state.modelPath && parsed.state.modelPath !== basename(file)) {
    return {
      file,
      modelDir,
      hasStateFile: true,
      lastConformance: null,
      repo,
      commitsBehindHead: null,
      slicePRsBehindHead: null,
      error: `state file describes "${parsed.state.modelPath}", not "${basename(file)}" — not attributing its conformance record`,
    };
  }
  if (!parsed.state.lastConformance) {
    return { file, modelDir, hasStateFile: true, lastConformance: null, repo, commitsBehindHead: null, slicePRsBehindHead: null, error: null };
  }
  const { date, revision } = parsed.state.lastConformance;
  const commitsResult = commitsBehindHead(repo, revision, runGit);
  if (!commitsResult.ok) {
    return {
      file,
      modelDir,
      hasStateFile: true,
      lastConformance: { date, revision },
      repo,
      commitsBehindHead: null,
      slicePRsBehindHead: null,
      error: commitsResult.message,
    };
  }
  const slicePRsResult = resolveSlicePRsBehindHead(repo, revision, sliceDocFacts, runGit);
  if (!slicePRsResult.ok) {
    return {
      file,
      modelDir,
      hasStateFile: true,
      lastConformance: { date, revision },
      repo,
      commitsBehindHead: commitsResult.count,
      slicePRsBehindHead: null,
      error: slicePRsResult.message,
    };
  }
  return {
    file,
    modelDir,
    hasStateFile: true,
    lastConformance: { date, revision },
    repo,
    commitsBehindHead: commitsResult.count,
    slicePRsBehindHead: slicePRsResult.count,
    error: null,
  };
}

// ---- Aggregation ----

export interface StatusSliceCounts {
  total: number;
  byStatus: {
    draft: number;
    reviewed: number;
    readyToImplement: number;
    implemented: number;
    noDoc: number;
    /** A doc IS bound (a `note` names it) but its frontmatter is missing/malformed — see
     *  `StatusBucket`'s `"frontmatter-invalid"` doc comment. Kept apart from `noDoc` (nothing
     *  bound at all) and `unknown` (bound, usable, just a freeform `status` value), and always
     *  equal to `driftSignal.frontmatterInvalid` below — same slices, two dimensions. */
    frontmatterInvalid: number;
    unknown: number;
  };
}

export interface StatusDriftCounts {
  inSync: number;
  neverImplemented: number;
  unpropagatedDelta: number;
  implementedWithoutLink: number;
  /** Slices with no doc bound at all (or a binding naming a missing file) — driftSignal is null
   *  because there's nothing to classify. Distinct from `frontmatterInvalid` below: THIS bucket
   *  is `resolveSliceDocJoin`'s `found: false`, in either dimension. */
  notApplicable: number;
  /** A doc IS bound and found (`found: true`) but its frontmatter is missing/malformed, so
   *  `driftSignal` couldn't be classified — always equal to `slices.byStatus.frontmatterInvalid`
   *  (same slices). Kept apart from `notApplicable` so "nothing was ever referenced" and
   *  "something's referenced but broken" don't collapse into one ambiguous bucket (a doc that
   *  IS found shouldn't tally the same as one that plain doesn't exist). */
  frontmatterInvalid: number;
}

export interface StatusInvariantTotals {
  testsDir: string;
  total: number;
  cited: number;
  uncovered: number;
}

export interface StatusIssueTotals {
  openIssues: number;
  openQuestionsTotal: number;
  openQuestionsUnchecked: number;
}

/** One doc-join diagnostic, tagged with the input file it came from — `em status` can aggregate
 *  several models in one run, so (unlike `em export`'s single-model diagnostics) each entry
 *  needs to say which file it concerns. */
export type StatusDiagnostic = { file: string } & Diagnostic;

export interface StatusReport {
  files: string[];
  slices: StatusSliceCounts;
  driftSignal: StatusDriftCounts;
  /** Null when `--tests <dir>` wasn't given — invariant coverage is opt-in (it needs a test
   *  tree to scan), unlike every other rollup dimension, which is always computable from the
   *  model(s) alone. */
  invariants: StatusInvariantTotals | null;
  issues: StatusIssueTotals;
  conformance: ConformanceEntry[];
  /** Doc-join diagnostics (`binding-missing-file`/`frontmatter-invalid` warnings) collected
   *  while resolving every slice's doc, across every input file — carried here rather than
   *  discarded, so a state-of-the-system report doesn't hide a broken doc reference just
   *  because it also folded that slice into `frontmatterInvalid`/`noDoc` above. */
  diagnostics: StatusDiagnostic[];
}

/** Aggregate everything `em status` reports into one `StatusReport` — pure, no I/O. Callers
 *  (the CLI action, the MCP tool) resolve every input first (compile each model, join every
 *  slice's doc, scan the test tree once, resolve conformance) and hand the results here. */
export function buildStatusReport(
  files: string[],
  sliceFacts: SliceStatusFact[],
  openIssuesCount: number,
  invariants: StatusInvariantTotals | null,
  conformance: ConformanceEntry[],
  diagnostics: StatusDiagnostic[],
): StatusReport {
  const byStatus = { draft: 0, reviewed: 0, readyToImplement: 0, implemented: 0, noDoc: 0, frontmatterInvalid: 0, unknown: 0 };
  const drift: StatusDriftCounts = {
    inSync: 0,
    neverImplemented: 0,
    unpropagatedDelta: 0,
    implementedWithoutLink: 0,
    notApplicable: 0,
    frontmatterInvalid: 0,
  };
  let openQuestionsTotal = 0;
  let openQuestionsUnchecked = 0;
  // MIL-121 `covers:` cross-binding lets several slices resolve to the SAME doc file — a doc's
  // own Open Questions belong to the doc, not to each slice covered by it, so a shared doc is
  // only counted once regardless of how many slices are bound to it (keyed by resolved absolute
  // path, since two different input models' `slices/` dirs could otherwise collide on the same
  // relative path string without actually being the same file).
  const countedDocPaths = new Set<string>();

  for (const f of sliceFacts) {
    switch (f.bucket) {
      case "draft":
        byStatus.draft++;
        break;
      case "reviewed":
        byStatus.reviewed++;
        break;
      case "ready-to-implement":
        byStatus.readyToImplement++;
        break;
      case "implemented":
        byStatus.implemented++;
        break;
      case "no-doc":
        byStatus.noDoc++;
        break;
      case "frontmatter-invalid":
        byStatus.frontmatterInvalid++;
        break;
      case "unknown":
        byStatus.unknown++;
        break;
    }
    switch (f.driftSignal) {
      case "in-sync":
        drift.inSync++;
        break;
      case "never-implemented":
        drift.neverImplemented++;
        break;
      case "unpropagated-delta":
        drift.unpropagatedDelta++;
        break;
      case "implemented-without-link":
        drift.implementedWithoutLink++;
        break;
      case null:
        if (f.docReason === "frontmatter-invalid") drift.frontmatterInvalid++;
        else drift.notApplicable++;
        break;
    }
    const alreadyCounted = f.docPath !== null && countedDocPaths.has(f.docPath);
    if (f.docPath !== null) countedDocPaths.add(f.docPath);
    if (!alreadyCounted) {
      openQuestionsTotal += f.openQuestionsTotal;
      openQuestionsUnchecked += f.openQuestionsUnchecked;
    }
  }

  return {
    files,
    slices: { total: sliceFacts.length, byStatus },
    driftSignal: drift,
    invariants,
    issues: { openIssues: openIssuesCount, openQuestionsTotal, openQuestionsUnchecked },
    conformance,
    diagnostics,
  };
}

/** Sum per-model `CoverageReport`s (see `./coverage.ts`) into one `StatusInvariantTotals` —
 *  `em status` doesn't need the per-slice/per-ID detail `em coverage --json` carries, just the
 *  totals, across however many models `--tests <dir>` was scanned against. */
export function aggregateInvariantTotals(testsDir: string, reports: CoverageReport[]): StatusInvariantTotals {
  let total = 0;
  let uncovered = 0;
  for (const r of reports) {
    total += r.totalInvariants;
    uncovered += r.uncoveredCount;
  }
  return { testsDir, total, cited: total - uncovered, uncovered };
}

// ---- Text / markdown / badge formatting ----

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "N commits and M slice-PRs behind HEAD" (MIL-164's freshness clause), handling either count
 *  being independently unknown — defensive against a hand-built `ConformanceEntry` (tests) even
 *  though on the real `resolveConformanceEntry` path the two counts are only ever null together
 *  (both fail whenever `error` is set, which callers check first — see that function's doc). */
function formatBehindHead(entry: ConformanceEntry): string {
  const commits = entry.commitsBehindHead;
  const slicePRs = entry.slicePRsBehindHead;
  if (commits === null && slicePRs === null) return "commits and slice-PRs behind HEAD unknown";
  if (commits === null) return `commits behind HEAD unknown, ${pluralize(slicePRs!, "slice-PR")} behind HEAD`;
  if (slicePRs === null) return `${pluralize(commits, "commit")} behind HEAD, slice-PRs behind HEAD unknown`;
  return `${pluralize(commits, "commit")} and ${pluralize(slicePRs, "slice-PR")} behind HEAD`;
}

/** Exported for `em freshness` (freshness.ts, MIL-164) — the standalone surface for exactly
 *  this one clause, without pulling in the rest of `em status`'s rollup. */
export function formatConformancePart(entry: ConformanceEntry): string {
  if (entry.error) return `conformance unknown (${entry.error})`;
  if (!entry.hasStateFile) return "no state file";
  if (!entry.lastConformance) return "never conformed";
  return `last conformed ${entry.lastConformance.revision} — ${formatBehindHead(entry)}`;
}

/** Same facts as `formatConformancePart`, without the leading "last conformed"/"conformance
 *  unknown" prose — for a markdown table cell that already carries a "Last conformed" row
 *  label, so the value itself shouldn't repeat it. */
function formatConformanceValue(entry: ConformanceEntry): string {
  if (entry.error) return `unknown (${entry.error})`;
  if (!entry.hasStateFile) return "no state file";
  if (!entry.lastConformance) return "never conformed";
  return `\`${entry.lastConformance.revision}\` — ${formatBehindHead(entry)}`;
}

/** The one-line rollup: `"8/8 implemented · 20/20 invariants covered · 0 open issues · last
 *  conformed <rev>, N commits behind HEAD"` (MIL-163's acceptance line). For multiple input
 *  models, the conformance clause reports the FIRST file's entry — a single-file invocation is
 *  the common case this line is written for; the full per-model breakdown is always in
 *  `formatStatusDetail`/the JSON document regardless of file count. */
export function formatStatusSummary(report: StatusReport): string {
  const { implemented } = report.slices.byStatus;
  const total = report.slices.total;
  const invPart = report.invariants
    ? `${report.invariants.cited}/${report.invariants.total} invariants covered`
    : "invariants not checked (pass --tests <dir>)";
  const issuesPart = pluralize(report.issues.openIssues, "open issue");
  const oqPart = report.issues.openQuestionsUnchecked > 0 ? `, ${pluralize(report.issues.openQuestionsUnchecked, "unchecked open question")}` : "";
  const conformancePart = formatConformancePart(report.conformance[0]);
  return `${implemented}/${total} implemented · ${invPart} · ${issuesPart}${oqPart} · ${conformancePart}`;
}

/** The detail block below the summary line: one line per rollup dimension, plus one line per
 *  model's conformance entry. */
export function formatStatusDetail(report: StatusReport): string {
  const { byStatus } = report.slices;
  const lines: string[] = [];
  lines.push(
    `slices: ${report.slices.total} total — ${byStatus.implemented} implemented, ${byStatus.readyToImplement} ready-to-implement, ` +
      `${byStatus.reviewed} reviewed, ${byStatus.draft} draft, ${byStatus.noDoc} no doc, ${byStatus.frontmatterInvalid} frontmatter invalid, ` +
      `${byStatus.unknown} unknown status`,
  );
  const d = report.driftSignal;
  lines.push(
    `driftSignal: ${d.inSync} in-sync, ${d.neverImplemented} never-implemented, ${d.unpropagatedDelta} unpropagated-delta, ` +
      `${d.implementedWithoutLink} implemented-without-link, ${d.notApplicable} n/a (no doc), ${d.frontmatterInvalid} n/a (frontmatter invalid)`,
  );
  lines.push(
    report.invariants
      ? `invariants: ${report.invariants.cited}/${report.invariants.total} covered (${report.invariants.uncovered} uncovered) — ${report.invariants.testsDir}`
      : "invariants: not checked — pass --tests <dir> to enable",
  );
  lines.push(
    `issues: ${pluralize(report.issues.openIssues, "open issue")}, ` +
      `${report.issues.openQuestionsUnchecked}/${report.issues.openQuestionsTotal} open question(s) unchecked`,
  );
  const multi = report.conformance.length > 1;
  for (const entry of report.conformance) {
    const label = multi ? `conformance (${entry.file}): ` : "conformance: ";
    lines.push(`${label}${formatConformancePart(entry)}`);
  }
  if (report.diagnostics.length > 0) {
    lines.push(`doc issues: ${pluralize(report.diagnostics.length, "warning")} — see diagnostics (${report.diagnostics.map((d) => d.code).join(", ")})`);
  }
  return lines.join("\n");
}

/** Full text report: the summary line, a blank line, then the detail block — same
 *  "rollup line, then detail" shape `em diff`'s text report uses. */
export function formatStatusText(report: StatusReport): string {
  return `${formatStatusSummary(report)}\n\n${formatStatusDetail(report)}`;
}

/** Escape characters that would break a markdown table cell: `|` (the column separator) and
 *  newlines — plus backslashes, escaped FIRST. Escaping `|` alone would let a pre-existing `\`
 *  in the source text (a Windows path in `entry.file`, or free text inside a conformance
 *  `error` string) combine with the newly-inserted `\` (e.g. a literal `\|`) and un-escape the
 *  pipe again once Markdown unescapes the backslash sequence — a CodeQL
 *  `js/incomplete-sanitization` finding (PR #116 review). Same convention `em slice index`'s
 *  own `escapeCell` (sliceIndex.ts) already uses for exactly this reason. Applied to both the
 *  key and value columns: the multi-model `Last conformed (${entry.file})` row embeds
 *  `entry.file`, which is CLI-argument/glob-controlled, not just the value column. */
function escapeCell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** A markdown block suited for pasting into a README (MIL-163's `--md`) — a small table,
 *  same spirit as `em slice index`'s GENERATED Slices table, but not marker-managed: `--md`
 *  just prints the block, leaving where/whether to embed it to the caller. */
export function formatStatusMarkdown(report: StatusReport): string {
  const { byStatus } = report.slices;
  const rows: Array<[string, string]> = [
    ["Slices", `${byStatus.implemented}/${report.slices.total} implemented (${byStatus.readyToImplement} ready-to-implement, ${byStatus.reviewed} reviewed, ${byStatus.draft} draft)`],
    ["Invariants", report.invariants ? `${report.invariants.cited}/${report.invariants.total} covered` : "not checked"],
    ["Open issues", `${report.issues.openIssues}`],
    ["Open questions", `${report.issues.openQuestionsUnchecked} unchecked`],
  ];
  if (report.conformance.length <= 1) {
    const entry = report.conformance[0];
    rows.push(["Last conformed", formatConformanceValue(entry)]);
  } else {
    for (const entry of report.conformance) {
      rows.push([`Last conformed (${entry.file})`, formatConformanceValue(entry)]);
    }
  }
  const header = "| Metric | Value |\n|---|---|";
  const body = rows.map(([k, v]) => `| ${escapeCell(k)} | ${escapeCell(v)} |`).join("\n");
  return `${header}\n${body}`;
}

// ---- SVG badge ----

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Deterministic, dependency-free text-width estimate for a shields.io-style flat badge: a
 *  fixed average character advance (no font metrics table, no rendering) so the same message
 *  always measures to the same width — good enough for a legible badge, not a claim of
 *  pixel-perfect parity with shields.io's own Verdana metrics. */
function textWidth(s: string): number {
  return Math.ceil(s.length * 6.5) + 10;
}

/** Render one flat-style SVG badge — two colored rects (label, message) plus centered text,
 *  no external fonts/images/scripts, so it renders identically anywhere an SVG does. */
export function renderBadgeSvg(label: string, message: string, color: string): string {
  const labelWidth = textWidth(label);
  const messageWidth = textWidth(message);
  const totalWidth = labelWidth + messageWidth;
  const labelX = labelWidth / 2;
  const messageX = labelWidth + messageWidth / 2;
  const ariaLabel = escapeXml(`${label}: ${message}`);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${ariaLabel}">\n` +
    `  <title>${ariaLabel}</title>\n` +
    `  <linearGradient id="s" x2="0" y2="100%">\n` +
    `    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>\n` +
    `    <stop offset="1" stop-opacity=".1"/>\n` +
    `  </linearGradient>\n` +
    `  <clipPath id="r">\n` +
    `    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>\n` +
    `  </clipPath>\n` +
    `  <g clip-path="url(#r)">\n` +
    `    <rect width="${labelWidth}" height="20" fill="#555"/>\n` +
    `    <rect x="${labelWidth}" width="${messageWidth}" height="20" fill="${color}"/>\n` +
    `    <rect width="${totalWidth}" height="20" fill="url(#s)"/>\n` +
    `  </g>\n` +
    `  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">\n` +
    `    <text x="${labelX}" y="14">${escapeXml(label)}</text>\n` +
    `    <text x="${messageX}" y="14">${escapeXml(message)}</text>\n` +
    `  </g>\n` +
    `</svg>`
  );
}

/** Badge message: a compact version of the summary line's first two/three clauses — a
 *  badge has no room for the full conformance clause. */
function badgeMessage(report: StatusReport): string {
  const { implemented } = report.slices.byStatus;
  const total = report.slices.total;
  const parts = [`${implemented}/${total} implemented`];
  if (report.invariants) parts.push(`${report.invariants.cited}/${report.invariants.total} invariants`);
  parts.push(pluralize(report.issues.openIssues, "issue"));
  return parts.join(" · ");
}

/** Badge color contract (documented here AND in docs/cli.md — keep both in sync):
 *
 *  - **red** `#e05d44` — a genuine problem: an open issue, an uncovered invariant, a
 *    `frontmatter-invalid` doc, or `implemented-without-link` drift (a doc claiming
 *    `implemented` with nothing linking to it).
 *  - **yellow** `#dfb317` — things are merely in flight, OR conformance couldn't be verified:
 *    not every slice implemented yet, an unchecked Open Question, any model with
 *    `commitsBehindHead > 0` or `slicePRsBehindHead > 0` (MIL-164), or — MIL-163 review — any
 *    conformance entry carrying a non-null `error` (an unresolvable revision, an unparseable
 *    state file, a `--repo` that isn't a git repo, or a state file describing a different
 *    model). An unverifiable conformance state must never be indistinguishable from a verified,
 *    current one — `commitsBehindHead: null`/`slicePRsBehindHead: null` from an `error` is NOT
 *    the same fact as "0 behind", so neither can be allowed to coalesce to 0 and read as healthy.
 *  - **green** `#4c1` — otherwise. Deliberately NOT keyed on "every slice implemented" alone —
 *    most projects spend most of their life not fully implemented, and that's not a problem a
 *    badge should flag. A model with NO conformance history yet (`hasStateFile: false`, or
 *    `Last conformance: never` — both `error: null`) is a legitimate, unremarkable state too
 *    ("hasn't reached the conform phase", not "broken") and stays eligible for green — only an
 *    actual `error` demotes a conformance entry out of green.
 */
function badgeColor(report: StatusReport): string {
  const hasProblem =
    report.issues.openIssues > 0 ||
    (report.invariants !== null && report.invariants.uncovered > 0) ||
    report.driftSignal.implementedWithoutLink > 0 ||
    report.driftSignal.frontmatterInvalid > 0;
  if (hasProblem) return "#e05d44"; // red
  const inFlight =
    report.slices.byStatus.implemented < report.slices.total ||
    report.issues.openQuestionsUnchecked > 0 ||
    report.conformance.some((c) => (c.commitsBehindHead ?? 0) > 0 || (c.slicePRsBehindHead ?? 0) > 0 || c.error !== null);
  if (inFlight) return "#dfb317"; // yellow
  return "#4c1"; // green
}

/** Build the `em status --badge` SVG document. */
export function buildStatusBadge(report: StatusReport): string {
  return renderBadgeSvg("em status", badgeMessage(report), badgeColor(report));
}
