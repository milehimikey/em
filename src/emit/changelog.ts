// SPDX-License-Identifier: MIT
// Builds the `em changelog` markdown document: a business-readable ledger of
// a model's git history, newest-first, with structural deltas (via
// ../model/diff.ts) and dated Decisions-log entries from the adjacent
// `.event-modeling.md` woven in by date. Pure — no git, no fs; the CLI
// (src/cli.ts) and src/cli/changelog-git.ts own all I/O so this module is
// unit-testable with plain data (see test/changelog.test.ts).

import { ModelDiff, formatModelDiff, hasChanges } from "../model/diff.js";

/** One dated bullet parsed from a state file's `## Decisions log` section. */
export interface DecisionEntry {
  /** YYYY-MM-DD, as written in the bullet. */
  date: string;
  /** Bullet text plus any continuation lines, joined with a space. Markdown (e.g. `**bold**`) passes through untouched. */
  text: string;
}

const HEADING_RE = /^#{1,6}\s+\S/;
const DECISIONS_HEADING_RE = /^##\s+Decisions log\s*$/;
const DATED_BULLET_RE = /^-\s+(\d{4}-\d{2}-\d{2}):\s?(.*)$/;
const BULLET_RE = /^-\s+/;

/**
 * Parse the dated bullets (`- YYYY-MM-DD: …`) out of a state file's
 * `## Decisions log` section, including continuation lines (any non-bullet,
 * non-heading line following a dated bullet) up to the next bullet or the
 * next heading. Returns `[]` when there's no such section — callers treat a
 * missing/absent state file the same way, by never calling this at all.
 */
export function parseDecisionsLog(stateText: string): DecisionEntry[] {
  const lines = stateText.split(/\r?\n/);
  const entries: DecisionEntry[] = [];
  let inSection = false;
  let current: { date: string; text: string } | null = null;

  const flush = () => {
    if (current) {
      entries.push({ date: current.date, text: current.text.trim() });
      current = null;
    }
  };

  for (const line of lines) {
    if (!inSection) {
      if (DECISIONS_HEADING_RE.test(line)) inSection = true;
      continue;
    }
    if (HEADING_RE.test(line)) break; // next section — Decisions log is over

    const dated = DATED_BULLET_RE.exec(line);
    if (dated) {
      flush();
      current = { date: dated[1], text: dated[2] };
      continue;
    }
    if (BULLET_RE.test(line)) {
      // A non-dated bullet (e.g. the template's `{{YYYY-MM-DD}}` placeholder)
      // — not a decision, but it still ends any open continuation.
      flush();
      continue;
    }
    if (line.trim() === "") continue; // blank line: neither ends nor extends a continuation
    if (current) current.text += " " + line.trim();
    // else: a stray line before any bullet (e.g. the template's HTML comment) — ignore.
  }
  flush();
  return entries;
}

/** One commit's worth of changelog content, oldest -> newest (matches `listModelCommits`). */
export interface ChangelogEntry {
  shortHash: string;
  /** YYYY-MM-DD author date. */
  date: string;
  subject: string;
  /**
   * Structural diff against the previous *parseable* revision. `null` for
   * the oldest entry (no predecessor — see `ChangelogOptions.intro`) or when
   * this revision itself failed to compile (see `error`).
   */
  diff: ModelDiff | null;
  /** Set when this revision couldn't be compiled; `diff` is null in that case. */
  error?: string;
}

/** Rollup of the oldest commit's model itself — computed by compiling that revision, not diffing. */
export interface ChangelogIntro {
  slices: number;
  elements: number;
}

export interface ChangelogOptions {
  /** The file path/label to put in the document header. */
  file: string;
  /** Oldest-commit rollup, or `null` when that revision failed to compile (see `introError`). */
  intro: ChangelogIntro | null;
  /** Set when the oldest revision couldn't be compiled; `intro` is null in that case. */
  introError?: string;
}

function heading(entry: ChangelogEntry): string {
  return `## ${entry.date} — ${entry.subject} (${entry.shortHash})`;
}

function decisionsBlock(decisions: DecisionEntry[]): string | null {
  if (decisions.length === 0) return null;
  return ["Decisions:", ...decisions.map((d) => `- ${d.text}`)].join("\n");
}

function assembleSection(parts: (string | null)[]): string {
  return parts.filter((p): p is string => p !== null).join("\n\n");
}

function renderIntroSection(entry: ChangelogEntry, opts: ChangelogOptions, decisions: DecisionEntry[]): string {
  const body = opts.introError
    ? `_could not compile this revision: ${opts.introError}_`
    : opts.intro
      ? `Model introduced: ${opts.intro.slices} slice${opts.intro.slices === 1 ? "" : "s"}, ${opts.intro.elements} element${opts.intro.elements === 1 ? "" : "s"}.`
      : "_model introduced._";
  return assembleSection([heading(entry), body, decisionsBlock(decisions)]);
}

function renderErrorSection(entry: ChangelogEntry, decisions: DecisionEntry[]): string {
  return assembleSection([heading(entry), `_could not compile this revision: ${entry.error}_`, decisionsBlock(decisions)]);
}

function renderDiffSection(entry: ChangelogEntry, diff: ModelDiff, decisions: DecisionEntry[]): string {
  return assembleSection([heading(entry), formatModelDiff(diff), decisionsBlock(decisions)]);
}

function renderUnmatchedSection(decisions: DecisionEntry[]): string {
  const list = decisions.map((d) => `- ${d.date}: ${d.text}`).join("\n");
  return assembleSection(["## Decisions not tied to a model commit", list]);
}

/**
 * Assemble the full `em changelog` markdown document: header, then sections
 * newest-first, then a trailing "Decisions not tied to a model commit"
 * section for any decision whose date matches no commit. A date's decisions
 * attach once, to the newest commit of that date. `entries` must be
 * oldest -> newest (matches `listModelCommits`); `entries[0]` is the model's
 * introduction (no predecessor to diff against — see `opts.intro`).
 *
 * A section is omitted when it has no structural change AND no matching
 * decision. The introduction and any error section always render — they're
 * never silently dropped.
 */
export function buildChangelog(entries: ChangelogEntry[], decisions: DecisionEntry[], opts: ChangelogOptions): string {
  const decisionsByDate = new Map<string, DecisionEntry[]>();
  for (const d of decisions) {
    const bucket = decisionsByDate.get(d.date);
    if (bucket) bucket.push(d);
    else decisionsByDate.set(d.date, [d]);
  }
  const entryDates = new Set(entries.map((e) => e.date));

  // Each decision attaches to exactly ONE section: the newest commit of its
  // date. Attaching to every same-date section duplicates the whole day's
  // decisions block per commit — on a real history with many commits in a
  // day, that duplication drowns the ledger. The map is consumed on first
  // (i.e. newest, given the reverse walk below) use.
  const takeDecisions = (date: string): DecisionEntry[] => {
    const bucket = decisionsByDate.get(date) ?? [];
    decisionsByDate.delete(date);
    return bucket;
  };

  const sections: string[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const matching = takeDecisions(entry.date);

    if (i === 0) {
      sections.push(renderIntroSection(entry, opts, matching));
      continue;
    }
    if (entry.error) {
      sections.push(renderErrorSection(entry, matching));
      continue;
    }
    const diff = entry.diff as ModelDiff; // non-intro, non-error entries always carry a diff
    if (!hasChanges(diff) && matching.length === 0) continue; // skip: nothing to report
    sections.push(renderDiffSection(entry, diff, matching));
  }

  const unmatched = decisions.filter((d) => !entryDates.has(d.date));
  if (unmatched.length > 0) sections.push(renderUnmatchedSection(unmatched));

  return [`# Model changelog — ${opts.file}`, ...sections].join("\n\n");
}
