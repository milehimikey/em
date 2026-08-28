// SPDX-License-Identifier: MIT
// `em state log-usage` / `em usage-report` (MIL-161 finding #2): mechanizes the two
// hand-maintained halves of docs/usage-data.md's Usage log convention.
//
//  - WRITE (`em state log-usage`, `appendUsageLogEntry` below): every session currently ends
//    with the agent running `em validate --json`, pulling each diagnostic's `usageCategory`,
//    deduping by hand, and hand-formatting one line into the exact
//    `- YYYY-MM-DD: phases: X, Y — validate: A, B` shape docs/usage-data.md#categories requires
//    verbatim. docs/usage-data.md:48-50 names the failure mode this replaces: two sessions
//    writing "read model with no source" vs. "read model has no source" for the same rule
//    silently split one count into two in aggregation. Deriving `phases`/categories from actual
//    tool output instead of free recall, and writing the line with one canonical formatter,
//    removes the chance of that drift entirely.
//
//  - READ (`em usage-report`, `aggregateUsageReport`/`parseUsageLogSection` below): replaces
//    docs/usage-data.md#aggregating-across-models-for-a-retro's hand-rolled `grep`/`awk`/`sort`
//    pipeline (with its documented `LC_ALL=C` + UTF-8 em-dash caveat) with a plain, locale-
//    independent parse over every `.event-modeling.md` under a root directory. A logged line
//    that doesn't match the canonical format (hand-authored before this command existed, or
//    edited by hand since) is surfaced in `unparseableLines` rather than silently mistallied or
//    silently dropped — the same "never guess, report the uncertainty" posture the rest of `em`
//    holds for anything it can't parse cleanly.
//
// Deliberately its own module, not folded into stateFile.ts: that module's header explicitly
// scopes itself to the six MECHANICAL top bullets, calling the Usage log (like the Decisions
// log, Open questions, ...) "agent-authored prose and out of scope here." This module's write
// side stays true to that spirit — it only ever APPENDS one new, fully-formed line; it never
// edits, re-reads, or reformats an existing one, so a hand-authored history predating this
// command is left exactly as it was written.

import { basename } from "node:path";
import { PHASES, PatchResult, STATE_FILE_NAME } from "./stateFile.js";
import { walkDir } from "../util/walkDir.js";

/** The Usage log's phase vocabulary (docs/usage-data.md#what-s-captured-and-where): the state
 *  file's own `Current phase:` enum (`stateFile.ts`'s `PHASES`) plus `watch` — a live-viewing
 *  activity a session can touch without ever being a `Current phase:` value itself (see
 *  `stateFile.ts`'s own comment on why `watch` is deliberately excluded there). Order here is
 *  the canonical sort order `log-usage` writes phases in, matching docs/usage-data.md's own
 *  listing order. */
export const USAGE_PHASES = [...PHASES, "watch"] as const;
export type UsagePhase = (typeof USAGE_PHASES)[number];

export function isUsagePhase(value: string): value is UsagePhase {
  return (USAGE_PHASES as readonly string[]).includes(value);
}

/** Dedupe and sort a `--phases` list into `USAGE_PHASES`' own canonical order (matching
 *  docs/usage-data.md's own listing order) rather than input order or alphabetical — so two
 *  sessions naming the same phases in a different order always log an identical line. */
export function sortUsagePhases(phases: readonly string[]): string[] {
  const order = USAGE_PHASES as readonly string[];
  return [...new Set(phases)].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

const USAGE_LOG_HEADING_RE = /^## Usage log[ \t]*\r?\n/m;

/** Locate the "## Usage log" section's body span within a state file's text: `[bodyStart,
 *  bodyEnd)` covers everything between the heading line and the next `## ` heading (or
 *  end-of-file). `null` if the file has no such heading at all. Plain substring search for the
 *  next heading (not a second regex) — every heading in `templates/state.md` is `## <Title>`,
 *  so `"\n## "` is an exact, unambiguous anchor. */
function findUsageLogSection(text: string): { bodyStart: number; bodyEnd: number } | null {
  const headingMatch = USAGE_LOG_HEADING_RE.exec(text);
  if (!headingMatch) return null;
  const bodyStart = headingMatch.index + headingMatch[0].length;
  const nextIdx = text.indexOf("\n## ", bodyStart);
  const bodyEnd = nextIdx === -1 ? text.length : nextIdx + 1; // +1: keep pointing at the '#'
  return { bodyStart, bodyEnd };
}

/** Format one Usage log bullet line — the ONE place this exact shape is generated, so
 *  `log-usage`'s writer and any future caller never drift from `usage-report`'s parser. */
export function formatUsageLogLine(date: string, phases: readonly string[], categories: readonly string[]): string {
  return `- ${date}: phases: ${phases.join(", ")} — validate: ${categories.join(", ")}`;
}

/**
 * Append one Usage log bullet to `text`'s "## Usage log" section — after whatever's already
 * there (the guidance comment, and/or prior bullets), never editing or reordering existing
 * content. `phases`/`categories` are trusted already-deduped, already-sorted, non-empty arrays
 * (the CLI layer owns that — see `sortByCanonicalOrder`/dedup below); `categories` is `["none"]`
 * when nothing fired. Fails (without writing anything) if the file has no "## Usage log"
 * heading at all — same "refuse rather than guess where it goes" discipline
 * `stateFile.ts`'s `applyBulletUpdates` uses for a missing mechanical bullet.
 */
export function appendUsageLogEntry(text: string, date: string, phases: readonly string[], categories: readonly string[]): PatchResult {
  const section = findUsageLogSection(text);
  if (!section) return { ok: false, message: 'missing "## Usage log" section' };

  const { bodyStart, bodyEnd } = section;
  const body = text.slice(bodyStart, bodyEnd);
  const trimmed = body.replace(/[ \t\r\n]+$/, "");
  const trailing = body.slice(trimmed.length) || "\n\n";
  const prefix = trimmed.length > 0 ? `${trimmed}\n` : "";
  const newBody = prefix + formatUsageLogLine(date, phases, categories) + trailing;

  return { ok: true, text: text.slice(0, bodyStart) + newBody + text.slice(bodyEnd) };
}

/** One canonically-formatted Usage log entry, parsed back into its two fields. */
export interface UsageLogEntry {
  date: string;
  phases: string[];
  categories: string[];
}

const USAGE_LOG_LINE_RE = /^-\s+(\d{4}-\d{2}-\d{2}):\s*phases:\s*(.+?)\s*—\s*validate:\s*(.+?)\s*$/;

/**
 * Parse every `- YYYY-MM-DD: phases: ... — validate: ...` bullet out of `text`'s "## Usage log"
 * section. A line that starts with `- ` inside the section but doesn't match the canonical shape
 * (hand-edited, or written before `log-usage` existed) is returned in `malformed` verbatim
 * rather than silently skipped or force-fit — `usage-report` surfaces these so a stale/foreign
 * format is visible, not invisibly under-counted. Lines that are just the guidance comment (or
 * blank) are ignored entirely — only an actual `- ` bullet attempt counts as malformed.
 */
export function parseUsageLogSection(text: string): { entries: UsageLogEntry[]; malformed: string[] } {
  const section = findUsageLogSection(text);
  if (!section) return { entries: [], malformed: [] };

  const body = text.slice(section.bodyStart, section.bodyEnd);
  const entries: UsageLogEntry[] = [];
  const malformed: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("- ")) continue;
    const m = USAGE_LOG_LINE_RE.exec(line);
    if (!m) {
      malformed.push(line);
      continue;
    }
    entries.push({
      date: m[1],
      phases: m[2].split(",").map((s) => s.trim()).filter((s) => s.length > 0),
      categories: m[3].split(",").map((s) => s.trim()).filter((s) => s.length > 0),
    });
  }
  return { entries, malformed };
}

/** Every `.event-modeling.md` under `root`, recursively, as paths relative to `root` — sorted,
 *  POSIX forward slashes (see `walkDir`). Prunes VCS/dependency directories a repo-wide sweep
 *  should never descend into. */
export function findStateFiles(root: string): string[] {
  return walkDir(root, { skipDir: (name) => name === "node_modules" || name === ".git" }).filter(
    (relPath) => basename(relPath) === STATE_FILE_NAME,
  );
}

export interface CountEntry {
  key: string;
  count: number;
}

/** Sort by count descending, ties broken alphabetically — deterministic regardless of Map
 *  insertion order (which itself depends on file-walk/parse order). */
function sortCounts(counts: Map<string, number>): CountEntry[] {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export interface UsageReport {
  root: string;
  files: string[];
  sessions: number;
  phaseCounts: CountEntry[];
  /** Excludes `"none"` — same as docs/usage-data.md's own aggregation recipe (`grep -v
   *  '^none$'`): a session with nothing to report isn't a category worth tallying. */
  categoryCounts: CountEntry[];
  unparseableLines: Array<{ file: string; line: string }>;
}

/** Aggregate every input file's Usage log into one report — pure, no I/O; the CLI layer resolves
 *  `entries` first (`findStateFiles` + a plain read per file). `root` is carried through only
 *  for the report's own labeling, never used to re-derive `files`. */
export function aggregateUsageReport(root: string, entries: Array<{ file: string; text: string }>): UsageReport {
  const phaseCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  const unparseableLines: Array<{ file: string; line: string }> = [];
  let sessions = 0;

  for (const { file, text } of entries) {
    const { entries: logEntries, malformed } = parseUsageLogSection(text);
    for (const line of malformed) unparseableLines.push({ file, line });
    for (const entry of logEntries) {
      sessions++;
      for (const p of entry.phases) phaseCounts.set(p, (phaseCounts.get(p) ?? 0) + 1);
      for (const c of entry.categories) {
        if (c === "none") continue;
        categoryCounts.set(c, (categoryCounts.get(c) ?? 0) + 1);
      }
    }
  }

  return {
    root,
    files: entries.map((e) => e.file).sort(),
    sessions,
    phaseCounts: sortCounts(phaseCounts),
    categoryCounts: sortCounts(categoryCounts),
    unparseableLines,
  };
}

/** Text report: a one-line summary, then a phase tally and a category tally, each empty-aware. */
export function formatUsageReportText(report: UsageReport): string {
  const lines: string[] = [];
  lines.push(
    `${report.files.length} state file(s) under ${report.root}, ${report.sessions} logged session(s)`,
  );
  lines.push("");
  lines.push("Phases touched:");
  if (report.phaseCounts.length === 0) lines.push("  (none logged)");
  for (const { key, count } of report.phaseCounts) lines.push(`  ${count}\t${key}`);
  lines.push("");
  lines.push("Validate diagnostic categories hit:");
  if (report.categoryCounts.length === 0) lines.push("  (none logged)");
  for (const { key, count } of report.categoryCounts) lines.push(`  ${count}\t${key}`);
  if (report.unparseableLines.length > 0) {
    lines.push("");
    lines.push(`${report.unparseableLines.length} line(s) didn't match the canonical format (not counted above):`);
    for (const { file, line } of report.unparseableLines) lines.push(`  ${file}: ${line}`);
  }
  return lines.join("\n");
}
