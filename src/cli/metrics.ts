// SPDX-License-Identifier: MIT
// `em metrics --from <rev>` (MIL-170): the four pilot metrics named in advance by the register —
// conform-cycle cadence + finding counts, ratification turnaround, status-vs-reality
// disagreement, and whether the readiness gate changes what gets built — computed from git
// history alone. Three of the four are deterministically computable; the fourth
// (`readinessGateEffect`) is not and is reported as such rather than approximated by a proxy.
//
// Same seams every other historical/git-facing module in this file reuses rather than
// re-deriving: the injectable `GitRunner`/`realGit` convention (diff-inputs.ts), `resolveRevision`/
// `resolveDocAtRevision`/`listSliceKeysAtRevision` for reading a slice doc or key list at a
// revision, `classifyImplementationDrift` (catalog/driftSignal.ts) for the disagreement signal,
// `parseState`/`STATE_FILE_NAME` (stateFile.ts) for the `Last conformance:` marker, and
// `findingsPathForReport`/`validateFindingsShape` (findings.ts) for the findings record. No
// second git wrapper, no second doc parser.
//
// Deterministic by construction: every date comes from git's own `--date=format:%Y-%m-%d`
// (which renders using the TIMEZONE RECORDED WITH THE COMMIT, not the machine running `em` —
// so it's identical on any machine, unlike `--date=format-local`), every list is either
// naturally ordered by `--reverse` (oldest first) or explicitly sorted before being returned,
// and nothing reads "now" — a range `--from <rev> --to <rev>` (or the working `HEAD` default)
// produces byte-identical output for the same repository state, run twice.

import { realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { GitRunner, realGit, resolveRevision, resolveDocAtRevision, listSliceKeysAtRevision } from "./diff-inputs.js";
import { classifyImplementationDrift } from "../catalog/driftSignal.js";
import { parseState, STATE_FILE_NAME } from "./stateFile.js";
import { findingsPathForReport, validateFindingsShape } from "./findings.js";

// git's own hex-byte format escapes — literal 4/4-character strings handed to `--format`, which
// git substitutes with the corresponding raw byte IN THE OUTPUT. Same technique
// `ledgerCheck.ts`'s `FORMAT_HASH_SEP`/`FORMAT_RECORD_END` use, one separator further: `%x02`
// (STX) delimits one commit's whole record (header line + following name-only/name-status
// lines) so a multi-line-per-commit `git log` call can be split back into records, `%x00` (NUL)
// delimits the two fields on a record's header line.
const FORMAT_RECORD_SEP = "%x02";
const FORMAT_FIELD_SEP = "%x00";
const RECORD_SEP = "\x02";
const FIELD_SEP = "\x00";

function repoRootOf(repo: string, runGit: GitRunner): string | null {
  const toplevel = runGit(["-C", repo, "rev-parse", "--show-toplevel"]);
  return toplevel.status === 0 ? toplevel.stdout.trim() : null;
}

function daysBetween(fromDate: string, toDate: string): number {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface TurnaroundStats {
  count: number;
  medianDays: number | null;
  minDays: number | null;
  maxDays: number | null;
}

function statsOf(nums: number[]): TurnaroundStats {
  return {
    count: nums.length,
    medianDays: median(nums),
    minDays: nums.length > 0 ? Math.min(...nums) : null,
    maxDays: nums.length > 0 ? Math.max(...nums) : null,
  };
}

export interface TurnaroundEvent {
  commit: string;
  date: string;
}

/** One slice's lifecycle-field-appearance events within the range, and the two turnaround
 *  gaps derived from them. An event is the FIRST commit in the range where the field flips
 *  from absent to present relative to what it was immediately before (the state at `--from`,
 *  or the previous commit walked) — a slice re-ratified more than once within the same range
 *  reports only its first cycle's events, a documented simplification (docs/cli.md). */
export interface SliceTurnaround {
  key: string;
  reviewedOn: TurnaroundEvent | null;
  ratifiedOn: TurnaroundEvent | null;
  implementedIn: TurnaroundEvent | null;
  reviewToRatifyDays: number | null;
  ratifyToImplementDays: number | null;
}

export interface RatificationTurnaroundMetric {
  slices: SliceTurnaround[];
  reviewToRatify: TurnaroundStats;
  ratifyToImplement: TurnaroundStats;
}

export type RevisionSource = "findings" | "state" | null;

export interface ConformCadenceEntry {
  /** The date encoded in the report's own filename (`conformance/<date>-report.md`) — the
   *  date the conform run itself recorded, not the (possibly later) commit date. */
  date: string;
  /** Repo-model-relative path, e.g. `conformance/2026-09-01-report.md` — same convention
   *  `Last conformance:`/`em conform-supersede` use. */
  path: string;
  /** The commit that added this report file. */
  commit: string;
  revision: string | null;
  revisionSource: RevisionSource;
  findingsCount: number | null;
  ruledCount: number | null;
  unruledCount: number | null;
  daysSincePrevious: number | null;
}

export interface ConformCadenceMetric {
  entries: ConformCadenceEntry[];
  medianCadenceDays: number | null;
}

export interface StatusVsRealityPoint {
  commit: string;
  date: string;
  disagreementCount: number;
  unpropagatedCount: number;
}

export interface StatusVsRealityMetric {
  series: StatusVsRealityPoint[];
  current: { disagreementCount: number; unpropagatedCount: number };
}

export interface MetricsResult {
  from: string;
  to: string;
  ratificationTurnaround: RatificationTurnaroundMetric;
  conformCadence: ConformCadenceMetric;
  /** Metric 3 name in the register: whether `status:`/`implementedIn:` agree with what a
   *  conform sweep would actually find — see `StatusVsRealityMetric`. */
  statusVsReality: StatusVsRealityMetric;
  /** Metric 4 — "does the readiness gate change what gets built" — is NOT computable from git
   *  history (no counterfactual repo without the gate exists to compare against); always
   *  `null`. See docs/usage-data.md. */
  readinessGateEffect: null;
}

export type ComputeMetricsResult = { ok: true; result: MetricsResult } | { ok: false; message: string };

interface CommitRecord {
  hash: string;
  date: string;
  lines: string[];
}

/** One `git log --reverse` call producing one record per commit, each record's first line
 *  `<hash>\x00<date>` and every following non-blank line whatever `--name-only`/`--name-status`
 *  appended. Returns `[]` (not an error) when the call fails or the range/pathspec matches
 *  nothing — both routine (an empty range, a path that never existed), matching every other
 *  "missing is not a crash" git helper in this codebase. */
function logRecords(repoRoot: string, from: string, to: string, pathspecs: string[], extraArgs: string[], runGit: GitRunner): CommitRecord[] {
  const log = runGit([
    "-C",
    repoRoot,
    "log",
    "--reverse",
    `--format=${FORMAT_RECORD_SEP}%H${FORMAT_FIELD_SEP}%ad`,
    "--date=format:%Y-%m-%d",
    ...extraArgs,
    `${from}..${to}`,
    "--",
    ...pathspecs,
  ]);
  if (log.status !== 0) return [];
  return log.stdout
    .split(RECORD_SEP)
    .map((chunk) => chunk.split("\n").filter((l) => l.length > 0))
    .filter((lines) => lines.length > 0)
    .map((lines) => {
      const [hash, date] = lines[0].split(FIELD_SEP);
      return { hash, date, lines: lines.slice(1) };
    });
}

/** Slice-doc-touching commits in the range, grouped by the slice key each touched path names —
 *  a single `git log --name-only` walk over `slices/`, rather than one walk per key. */
function slicesTouchedByCommit(repoRoot: string, slicesDirAbs: string, from: string, to: string, runGit: GitRunner): Map<string, TurnaroundEvent[]> {
  const records = logRecords(repoRoot, from, to, [slicesDirAbs], ["--name-only"], runGit);
  const byKey = new Map<string, TurnaroundEvent[]>();
  const SLICE_DOC_RE = /(?:^|\/)slices\/([^/]+)\.md$/;
  for (const { hash, date, lines } of records) {
    for (const path of lines) {
      const m = SLICE_DOC_RE.exec(path);
      if (!m) continue;
      const key = m[1];
      const events = byKey.get(key) ?? [];
      events.push({ commit: hash, date });
      byKey.set(key, events);
    }
  }
  return byKey;
}

/** First-appearance detector: locks onto the first commit where `curr` is non-null while the
 *  immediately preceding known value (`prev`) was null — returns the already-locked event on
 *  every subsequent call for the same accumulator. */
function firstAppearance(existing: TurnaroundEvent | null, prev: string | null, curr: string | null, commit: string, date: string): TurnaroundEvent | null {
  if (existing !== null) return existing;
  return prev === null && curr !== null ? { commit, date } : null;
}

function computeRatificationTurnaround(anchorFile: string, repoRoot: string, baseDir: string, from: string, to: string, runGit: GitRunner): RatificationTurnaroundMetric {
  const slicesDirAbs = resolve(baseDir, "slices");
  const byKey = slicesTouchedByCommit(repoRoot, slicesDirAbs, from, to, runGit);
  const keys = [...byKey.keys()].sort();

  const slices: SliceTurnaround[] = keys.map((key) => {
    const baseline = resolveDocAtRevision(anchorFile, key, from, runGit);
    let prevReviewed = baseline?.reviewedOn ?? null;
    let prevRatified = baseline?.ratifiedOn ?? null;
    let prevImplemented = baseline?.implementedIn ?? null;
    let reviewedEvent: TurnaroundEvent | null = null;
    let ratifiedEvent: TurnaroundEvent | null = null;
    let implementedEvent: TurnaroundEvent | null = null;

    for (const { commit, date } of byKey.get(key)!) {
      const doc = resolveDocAtRevision(anchorFile, key, commit, runGit);
      if (!doc) continue; // deleted at this commit — nothing to read, keep prior state
      reviewedEvent = firstAppearance(reviewedEvent, prevReviewed, doc.reviewedOn, commit, date);
      ratifiedEvent = firstAppearance(ratifiedEvent, prevRatified, doc.ratifiedOn, commit, date);
      implementedEvent = firstAppearance(implementedEvent, prevImplemented, doc.implementedIn, commit, date);
      prevReviewed = doc.reviewedOn;
      prevRatified = doc.ratifiedOn;
      prevImplemented = doc.implementedIn;
    }

    const reviewToRatifyDays = reviewedEvent && ratifiedEvent ? daysBetween(reviewedEvent.date, ratifiedEvent.date) : null;
    const ratifyToImplementDays = ratifiedEvent && implementedEvent ? daysBetween(ratifiedEvent.date, implementedEvent.date) : null;
    return { key, reviewedOn: reviewedEvent, ratifiedOn: ratifiedEvent, implementedIn: implementedEvent, reviewToRatifyDays, ratifyToImplementDays };
  });

  return {
    slices,
    reviewToRatify: statsOf(slices.map((s) => s.reviewToRatifyDays).filter((n): n is number => n !== null)),
    ratifyToImplement: statsOf(slices.map((s) => s.ratifyToImplementDays).filter((n): n is number => n !== null)),
  };
}

const REPORT_ADD_RE = /^(?:(.*)\/)?conformance\/(\d{4}-\d{2}-\d{2})-report\.md$/;

function computeConformCadence(baseDir: string, repoRoot: string, from: string, to: string, runGit: GitRunner): ConformCadenceMetric {
  const conformanceDirAbs = resolve(baseDir, "conformance");
  // `repoRoot` (from `git rev-parse --show-toplevel`) is already fully resolved — macOS's
  // `/tmp`/`$TMPDIR` are themselves symlinks into `/private/...`, so `baseDir` needs the same
  // `realpathSync` treatment before `relative()` can compare the two meaningfully; git's own
  // pathspec matching (every OTHER absolute path this module hands to `git log`) already
  // resolves symlinks internally, so this is the one place that needs it done explicitly.
  const baseDirReal = realpathSync(resolve(baseDir));
  const baseDirRepoRel = relative(repoRoot, baseDirReal).split("\\").join("/"); // "" when baseDir IS the repo root
  const records = logRecords(repoRoot, from, to, [conformanceDirAbs], ["--name-status", "--diff-filter=A"], runGit);

  const rows: { commit: string; date: string; path: string }[] = [];
  for (const { hash, lines } of records) {
    for (const line of lines) {
      const tab = line.indexOf("\t");
      if (tab === -1) continue;
      const status = line.slice(0, tab);
      const path = line.slice(tab + 1);
      if (status !== "A") continue;
      const m = REPORT_ADD_RE.exec(path);
      if (!m) continue;
      const prefix = m[1] ?? "";
      if (prefix !== baseDirRepoRel) continue; // a sibling model's own conformance/ report — not this model's
      const relPath = baseDirRepoRel ? path.slice(baseDirRepoRel.length + 1) : path;
      rows.push({ commit: hash, date: m[2], path: relPath });
    }
  }
  // Sort by the report's own filename date (the conform run's own record of when it ran), then
  // by commit hash for a deterministic tiebreak on same-day reports.
  rows.sort((a, b) => (a.date === b.date ? a.commit.localeCompare(b.commit) : a.date.localeCompare(b.date)));

  const entries: ConformCadenceEntry[] = [];
  let prevDate: string | null = null;
  for (const row of rows) {
    let revision: string | null = null;
    let revisionSource: RevisionSource = null;
    let findingsCount: number | null = null;
    let ruledCount: number | null = null;
    let unruledCount: number | null = null;

    const findingsRelPath = findingsPathForReport(row.path);
    if (findingsRelPath) {
      // Read at `to` (the range's end) rather than the adding commit — the findings record is
      // sometimes filled in over one or more commits after the report itself lands; `to`
      // reflects the fullest, final picture of what got ruled, not a point-in-time snapshot.
      const atTo = resolveRevision(join(baseDir, findingsRelPath), to, runGit);
      if (atTo.ok) {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(atTo.content);
        } catch {
          parsed = null;
        }
        const shape = parsed !== null ? validateFindingsShape(parsed) : { ok: false as const, errors: [] };
        if (shape.ok) {
          findingsCount = shape.doc.findings.length;
          ruledCount = shape.doc.findings.filter((f) => f.locus !== null).length;
          unruledCount = findingsCount - ruledCount;
          if (shape.doc.revision) {
            revision = shape.doc.revision;
            revisionSource = "findings";
          }
        }
      }
    }

    if (revision === null) {
      const atCommit = resolveRevision(join(baseDir, STATE_FILE_NAME), row.commit, runGit);
      if (atCommit.ok) {
        const parsed = parseState(atCommit.content);
        if (parsed.ok && parsed.state.lastConformance && parsed.state.lastConformance.report === row.path) {
          revision = parsed.state.lastConformance.revision;
          revisionSource = "state";
        }
      }
    }

    const daysSincePrevious = prevDate === null ? null : daysBetween(prevDate, row.date);
    prevDate = row.date;
    entries.push({ date: row.date, path: row.path, commit: row.commit, revision, revisionSource, findingsCount, ruledCount, unruledCount, daysSincePrevious });
  }

  return { entries, medianCadenceDays: median(entries.map((e) => e.daysSincePrevious).filter((n): n is number => n !== null)) };
}

function countDriftAt(anchorFile: string, rev: string, runGit: GitRunner): { disagreementCount: number; unpropagatedCount: number } {
  const keys = listSliceKeysAtRevision(anchorFile, rev, runGit);
  let disagreementCount = 0;
  let unpropagatedCount = 0;
  for (const key of keys) {
    const doc = resolveDocAtRevision(anchorFile, key, rev, runGit);
    if (!doc) continue;
    const signal = classifyImplementationDrift(doc);
    if (signal === "implemented-without-link" || signal === "uncertified") disagreementCount++;
    else if (signal === "unpropagated-delta") unpropagatedCount++;
  }
  return { disagreementCount, unpropagatedCount };
}

function computeStatusVsReality(anchorFile: string, baseDir: string, repoRoot: string, from: string, to: string, runGit: GitRunner): StatusVsRealityMetric {
  const slicesDirAbs = resolve(baseDir, "slices");
  const stateFileAbs = join(baseDir, STATE_FILE_NAME);
  const records = logRecords(repoRoot, from, to, [slicesDirAbs, stateFileAbs], [], runGit);
  const series: StatusVsRealityPoint[] = records.map(({ hash, date }) => ({ commit: hash, date, ...countDriftAt(anchorFile, hash, runGit) }));
  const current = countDriftAt(anchorFile, to, runGit);
  return { series, current };
}

/**
 * Compute `em metrics <file> --from <rev> --to <rev>` (MIL-170): the three git-history-
 * computable pilot metrics, plus `readinessGateEffect: null` (Metric 4, not computable — see
 * `MetricsResult`). `anchorFile` locates `slices/`/`conformance/`/`.event-modeling.md` relative
 * to it, same convention `em ledger`/`em conform-scope` use — never parsed or compiled.
 */
export function computeMetrics(anchorFile: string, from: string, to: string, runGit: GitRunner = realGit): ComputeMetricsResult {
  const baseDir = dirname(resolve(anchorFile));
  const repoRoot = repoRootOf(baseDir, runGit);
  if (repoRoot === null) {
    return { ok: false, message: `em metrics: ${anchorFile} is not inside a git repository` };
  }
  const fromCheck = runGit(["-C", repoRoot, "rev-parse", "--verify", `${from}^{commit}`]);
  if (fromCheck.status !== 0) {
    return { ok: false, message: `em metrics: unknown revision "${from}"` };
  }
  const toCheck = runGit(["-C", repoRoot, "rev-parse", "--verify", `${to}^{commit}`]);
  if (toCheck.status !== 0) {
    return { ok: false, message: `em metrics: unknown revision "${to}"` };
  }

  const ratificationTurnaround = computeRatificationTurnaround(anchorFile, repoRoot, baseDir, from, to, runGit);
  const conformCadence = computeConformCadence(baseDir, repoRoot, from, to, runGit);
  const statusVsReality = computeStatusVsReality(anchorFile, baseDir, repoRoot, from, to, runGit);

  return { ok: true, result: { from, to, ratificationTurnaround, conformCadence, statusVsReality, readinessGateEffect: null } };
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function statsLine(s: TurnaroundStats): string {
  if (s.count === 0) return "no data";
  return `${pluralize(s.count, "slice")}, median ${s.medianDays}d, min ${s.minDays}d, max ${s.maxDays}d`;
}

/** The `em metrics` text report — same "rollup line(s), then detail" spirit `em status`'s text
 *  form uses, kept plain (no table alignment) since the row counts are unbounded. */
export function formatMetricsText(m: MetricsResult): string {
  const lines: string[] = [];
  lines.push(`em metrics ${m.from}..${m.to}`);
  lines.push("");

  lines.push("Ratification turnaround:");
  lines.push(`  reviewed -> ratified: ${statsLine(m.ratificationTurnaround.reviewToRatify)}`);
  lines.push(`  ratified -> implemented: ${statsLine(m.ratificationTurnaround.ratifyToImplement)}`);
  if (m.ratificationTurnaround.slices.length === 0) {
    lines.push("  (no slice doc's lifecycle fields changed in this range)");
  } else {
    for (const s of m.ratificationTurnaround.slices) {
      const reviewed = s.reviewedOn ? s.reviewedOn.date : "—";
      const ratified = s.ratifiedOn ? `${s.ratifiedOn.date} (${s.reviewToRatifyDays}d)` : "—";
      const implemented = s.implementedIn ? `${s.implementedIn.date} (${s.ratifyToImplementDays}d)` : "—";
      lines.push(`    ${s.key}: reviewed ${reviewed}, ratified ${ratified}, implemented ${implemented}`);
    }
  }
  lines.push("");

  lines.push("Conform cadence:");
  lines.push(`  median cadence: ${m.conformCadence.medianCadenceDays ?? "n/a"} day(s) — ${pluralize(m.conformCadence.entries.length, "report")}`);
  for (const e of m.conformCadence.entries) {
    const findings = e.findingsCount === null ? "findings unknown" : `${pluralize(e.findingsCount, "finding")} (${e.ruledCount} ruled, ${e.unruledCount} unruled)`;
    const cadence = e.daysSincePrevious === null ? "" : `, ${e.daysSincePrevious}d since previous`;
    lines.push(`    ${e.date} ${e.path} — ${findings}, revision ${e.revision ?? "unknown"}${cadence}`);
  }
  lines.push("");

  lines.push("Status-vs-reality disagreement:");
  lines.push(`  current: ${pluralize(m.statusVsReality.current.disagreementCount, "disagreement")}, ${pluralize(m.statusVsReality.current.unpropagatedCount, "unpropagated-delta")}`);
  lines.push(`  ${pluralize(m.statusVsReality.series.length, "commit")} touched slices/state in this range`);
  for (const p of m.statusVsReality.series) {
    lines.push(`    ${p.date} ${p.commit} — ${pluralize(p.disagreementCount, "disagreement")}, ${pluralize(p.unpropagatedCount, "unpropagated-delta")}`);
  }
  lines.push("");

  lines.push("Readiness-gate effect: not computable from history — see docs/usage-data.md");
  return lines.join("\n");
}
