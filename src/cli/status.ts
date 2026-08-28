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
//
// Deterministic core: no LLM calls, no wall-clock timestamps in the output, byte-stable for the
// same inputs. Text/markdown/badge are formatting layers over one aggregated StatusReport; the
// JSON document (emit/statusJson.ts) is a versioned envelope around the exact same object.

import { dirname } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { resolveSliceDocJoin, DocReason } from "../catalog/docJoin.js";
import { readSliceDoc } from "../catalog/readSliceDoc.js";
import { DriftSignalKind } from "../catalog/driftSignal.js";
import { CoverageReport } from "./coverage.js";
import { GitRunner, realGit } from "./diff-inputs.js";
import { loadStateFile, parseState } from "./stateFile.js";

/** The 4 canonical slice-doc lifecycle statuses (docs/slice-doc-schema.md) — the same enum
 *  `em catalog`'s header coloring and `em render`'s status legend already recognize. */
export const CANONICAL_STATUSES = ["draft", "reviewed", "ready-to-implement", "implemented"] as const;
export type CanonicalStatus = (typeof CANONICAL_STATUSES)[number];

/** Bucket a slice's lifecycle status falls into for the rollup: one of the 4 canonical values,
 *  `"no-doc"` (no doc found at all — `resolveSliceDocJoin`'s `found: false`, any reason), or
 *  `"unknown"` (a doc was found and usable but its `status` isn't one of the 4 canonical
 *  strings — a freeform doc, matching `em slice index`'s own "unknown" convention). */
export type StatusBucket = CanonicalStatus | "no-doc" | "unknown";

export function classifyStatusBucket(found: boolean, status: string | null): StatusBucket {
  if (!found) return "no-doc";
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
  rawStatus: string | null;
  bucket: StatusBucket;
  driftSignal: DriftSignalKind | null;
  openQuestionsTotal: number;
  openQuestionsUnchecked: number;
}

/**
 * Resolve every slice's status-rollup facts for one already-compiled model. `baseDir` is the
 * `.em` file's directory, same doc-resolution convention every other doc-aware command uses.
 * Open Questions counts are read from the slice's OWN bound doc (re-deriving the key from
 * `doc.path`, not assuming it's this slice's own — MIL-121 cross-binding can resolve to a
 * different slice's doc, same re-derivation `em coverage`/`--slice-ready` use) rather than a
 * second independent parse.
 */
export function resolveSliceStatusFacts(file: string, model: NormalizedModel, refs: RefsResult, baseDir: string): SliceStatusFact[] {
  return model.slices.map((slice, i) => {
    const key = refs.sliceKeys[i];
    const { doc } = resolveSliceDocJoin(slice, key, baseDir, (id) => refs.refById.get(id)!);

    let openQuestionsTotal = 0;
    let openQuestionsUnchecked = 0;
    if (doc.found) {
      const boundKey = doc.path.replace(/^slices\//, "").replace(/\.md$/, "");
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
      rawStatus: doc.status,
      bucket: classifyStatusBucket(doc.found, doc.status),
      driftSignal: doc.driftSignal,
      openQuestionsTotal,
      openQuestionsUnchecked,
    };
  });
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
  /** Set when the state file exists and parses, but git couldn't answer commits-behind-HEAD
   *  (not a git repo, unknown revision, ...) — reported per-model rather than aborting the
   *  whole rollup, since `em status` is a soft report, not a gate. Also carries a state-file
   *  parse failure (unparseable `Last conformance:` bullet), same non-fatal treatment. */
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
 * Resolve one model's conformance entry: read its sibling state file (if any — not every model
 * has reached the `conform` phase, so a missing state file is routine, not an error), then
 * compute commits-behind-HEAD when `Last conformance:` is set. `repoOverride` is `--repo`;
 * omitted, each model's own directory is used as the repo to walk (the common single-repo
 * project case — see `repo` field doc above).
 */
export function resolveConformanceEntry(file: string, repoOverride: string | undefined, runGit: GitRunner = realGit): ConformanceEntry {
  const modelDir = dirname(file);
  const repo = repoOverride ?? modelDir;
  const loaded = loadStateFile(modelDir);
  if (!loaded.ok) {
    return { file, modelDir, hasStateFile: false, lastConformance: null, repo, commitsBehindHead: null, error: null };
  }
  const parsed = parseState(loaded.text);
  if (!parsed.ok) {
    return { file, modelDir, hasStateFile: true, lastConformance: null, repo, commitsBehindHead: null, error: `state file: ${parsed.message}` };
  }
  if (!parsed.state.lastConformance) {
    return { file, modelDir, hasStateFile: true, lastConformance: null, repo, commitsBehindHead: null, error: null };
  }
  const { date, revision } = parsed.state.lastConformance;
  const result = commitsBehindHead(repo, revision, runGit);
  if (!result.ok) {
    return { file, modelDir, hasStateFile: true, lastConformance: { date, revision }, repo, commitsBehindHead: null, error: result.message };
  }
  return { file, modelDir, hasStateFile: true, lastConformance: { date, revision }, repo, commitsBehindHead: result.count, error: null };
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
    unknown: number;
  };
}

export interface StatusDriftCounts {
  inSync: number;
  neverImplemented: number;
  unpropagatedDelta: number;
  implementedWithoutLink: number;
  /** Slices with no doc at all — driftSignal is null (nothing to classify), tallied separately
   *  so the 4 named buckets always sum to the slices that actually have a usable doc. */
  notApplicable: number;
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
): StatusReport {
  const byStatus = { draft: 0, reviewed: 0, readyToImplement: 0, implemented: 0, noDoc: 0, unknown: 0 };
  const drift: StatusDriftCounts = { inSync: 0, neverImplemented: 0, unpropagatedDelta: 0, implementedWithoutLink: 0, notApplicable: 0 };
  let openQuestionsTotal = 0;
  let openQuestionsUnchecked = 0;

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
        drift.notApplicable++;
        break;
    }
    openQuestionsTotal += f.openQuestionsTotal;
    openQuestionsUnchecked += f.openQuestionsUnchecked;
  }

  return {
    files,
    slices: { total: sliceFacts.length, byStatus },
    driftSignal: drift,
    invariants,
    issues: { openIssues: openIssuesCount, openQuestionsTotal, openQuestionsUnchecked },
    conformance,
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

function formatConformancePart(entry: ConformanceEntry): string {
  if (entry.error) return `conformance unknown (${entry.error})`;
  if (!entry.hasStateFile) return "no state file";
  if (!entry.lastConformance) return "never conformed";
  const behind = entry.commitsBehindHead;
  const behindPart = behind === null ? "commits behind HEAD unknown" : pluralize(behind, "commit") + " behind HEAD";
  return `last conformed ${entry.lastConformance.revision}, ${behindPart}`;
}

/** Same facts as `formatConformancePart`, without the leading "last conformed"/"conformance
 *  unknown" prose — for a markdown table cell that already carries a "Last conformed" row
 *  label, so the value itself shouldn't repeat it. */
function formatConformanceValue(entry: ConformanceEntry): string {
  if (entry.error) return `unknown (${entry.error})`;
  if (!entry.hasStateFile) return "no state file";
  if (!entry.lastConformance) return "never conformed";
  const behind = entry.commitsBehindHead;
  const behindPart = behind === null ? "commits behind HEAD unknown" : pluralize(behind, "commit") + " behind HEAD";
  return `\`${entry.lastConformance.revision}\` — ${behindPart}`;
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
      `${byStatus.reviewed} reviewed, ${byStatus.draft} draft, ${byStatus.noDoc} no doc, ${byStatus.unknown} unknown status`,
  );
  const d = report.driftSignal;
  lines.push(
    `driftSignal: ${d.inSync} in-sync, ${d.neverImplemented} never-implemented, ${d.unpropagatedDelta} unpropagated-delta, ` +
      `${d.implementedWithoutLink} implemented-without-link, ${d.notApplicable} n/a (no doc)`,
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
  return lines.join("\n");
}

/** Full text report: the summary line, a blank line, then the detail block — same
 *  "rollup line, then detail" shape `em diff`'s text report uses. */
export function formatStatusText(report: StatusReport): string {
  return `${formatStatusSummary(report)}\n\n${formatStatusDetail(report)}`;
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
  const body = rows.map(([k, v]) => `| ${k} | ${v.replace(/\|/g, "\\|")} |`).join("\n");
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

/** Badge color: red when there's a genuine problem (an open issue, an uncovered invariant, or
 *  `implemented-without-link` drift — a doc claiming `implemented` with nothing linking to
 *  it); yellow when things are merely in flight (not every slice implemented yet, an unchecked
 *  Open Question, or any model behind on conformance); green otherwise. Deliberately NOT keyed
 *  on "every slice implemented" alone — most projects spend most of their life not fully
 *  implemented, and that's not a problem a badge should flag red. */
function badgeColor(report: StatusReport): string {
  const hasProblem =
    report.issues.openIssues > 0 ||
    (report.invariants !== null && report.invariants.uncovered > 0) ||
    report.driftSignal.implementedWithoutLink > 0;
  if (hasProblem) return "#e05d44"; // red
  const inFlight =
    report.slices.byStatus.implemented < report.slices.total ||
    report.issues.openQuestionsUnchecked > 0 ||
    report.conformance.some((c) => (c.commitsBehindHead ?? 0) > 0);
  if (inFlight) return "#dfb317"; // yellow
  return "#4c1"; // green
}

/** Build the `em status --badge` SVG document. */
export function buildStatusBadge(report: StatusReport): string {
  return renderBadgeSvg("em status", badgeMessage(report), badgeColor(report));
}
