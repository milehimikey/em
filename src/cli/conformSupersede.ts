// SPDX-License-Identifier: MIT
// `em conform-supersede` (MIL-164): stamps a conformance report with a "this describes an
// ancestor" banner once its findings have been ruled on (docs/process.md's "Ratifying
// conformance findings" — stage 7 of workflow.md, the companion step to run alongside/after
// `em slice ratify` once a report's findings are ruled). A reader following a superseded
// report's file:line citations needs to know, before trusting them, that the report was
// written against an older revision — the exact problem a stale-but-uncaptioned report causes
// (Meridian Goods' 2026-08-23 report citing a file a later ruling renamed: correct as history,
// misleading as a current view).
//
// Write strategy: additive-only text splice, never a parse+re-serialize of the report — same
// surgical discipline ratify.ts/markImplemented.ts hold for slice-doc frontmatter, applied here
// to a plain-markdown report instead. The banner is inserted as a blockquote line directly under
// the report's title (its first line); every byte after that — the metadata bullets, Summary,
// Findings, everything — is copied through verbatim. Repeated calls (a report ruled on
// incrementally, across more than one session) accumulate one banner line per call rather than
// overwriting the last — each stamp names its own revision/findings/date, so the accumulated
// block reads as a small history of rulings, not a single mutable fact. Calling again with the
// EXACT same revision/findings/date is a no-op (`changed: false`), same idempotency convention
// every other `em` write command holds.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isValidDateString } from "./stateFile.js";

const BANNER_PREFIX = "> **Superseded as of `";

/** Conservative charset for `--findings`: digits, commas, spaces, and either dash style (ASCII
 *  hyphen or an en/em dash pasted from a report) — enough to write "1-3", "1, 2, 4", or "1–3",
 *  nothing that could smuggle markdown/HTML into the banner it gets spliced into. */
const FINDINGS_RE = /^[\d,\s\-–—]+$/;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

export type ApplySupersedeResult = { ok: true; content: string; changed: boolean } | { ok: false; message: string };

/**
 * Pure text transform: inserts (or, if already present, no-ops on) a `> **Superseded as of
 * `<revision>`** — findings <findings> since ruled (<on>).` banner line directly under `raw`'s
 * first line. Refuses when `raw` has no first line to anchor under, or when any input carries
 * control characters / an unsafe `findings` value that could corrupt the report or smuggle
 * unintended markdown into it. No fs access — the caller reads/writes; see `runConformSupersede`
 * below.
 */
export function applySupersededBanner(raw: string, revision: string, findings: string, on: string): ApplySupersedeResult {
  const trimmedRev = revision.trim();
  if (!trimmedRev) return { ok: false, message: "a revision is required (--as-of)" };
  if (CONTROL_CHARS_RE.test(trimmedRev) || trimmedRev.includes("`")) {
    return { ok: false, message: "revision must not contain control characters or a backtick" };
  }
  const trimmedFindings = findings.trim();
  if (!trimmedFindings) return { ok: false, message: "a findings spec is required (--findings)" };
  if (!FINDINGS_RE.test(trimmedFindings)) {
    return {
      ok: false,
      message: `--findings "${findings}" must be a plain list/range of numbers (e.g. "1-3" or "1, 2, 4")`,
    };
  }
  if (!isValidDateString(on)) {
    return { ok: false, message: `invalid date "${on}" — expected YYYY-MM-DD` };
  }

  const firstNl = raw.indexOf("\n");
  if (firstNl === -1) {
    return { ok: false, message: "report has no title line to anchor the banner after" };
  }
  const eol = raw[firstNl - 1] === "\r" ? "\r\n" : "\n";
  const titleEnd = firstNl - (eol === "\r\n" ? 1 : 0);
  const titleLine = raw.slice(0, titleEnd);
  const rest = raw.slice(firstNl + 1);

  const newLine = `${BANNER_PREFIX}${trimmedRev}\`** — findings ${trimmedFindings} since ruled (${on}). This report describes an ancestor of the current model; verify file:line citations against the current code before relying on them.`;

  const restLines = rest.split(eol);
  const bannerLines: string[] = [];
  let i = 0;
  while (i < restLines.length && restLines[i].startsWith(BANNER_PREFIX)) {
    bannerLines.push(restLines[i]);
    i++;
  }
  if (bannerLines.includes(newLine)) {
    return { ok: true, content: raw, changed: false }; // idempotent no-op — exact stamp already recorded
  }
  const remainder = restLines.slice(i).join(eol);
  const newBannerBlock = [...bannerLines, newLine];
  const content = `${titleLine}${eol}${newBannerBlock.join(eol)}${eol}${remainder}`;
  return { ok: true, content, changed: true };
}

export type RunConformSupersedeResult = { ok: true; path: string; changed: boolean } | { ok: false; message: string };

/**
 * Resolves `reportPath` (relative to `baseDir` — the `.em` file's directory, same convention
 * every doc/note/report path in `em` uses) and applies the banner. Refuses cleanly when the
 * report doesn't exist rather than creating one — `em conform-supersede` stamps an existing
 * report, it never authors one.
 */
export function runConformSupersede(baseDir: string, reportPath: string, revision: string, findings: string, on: string): RunConformSupersedeResult {
  const absPath = join(baseDir, reportPath);
  if (!existsSync(absPath)) {
    return { ok: false, message: `no such report: ${reportPath}` };
  }
  const raw = readFileSync(absPath, "utf8");
  const result = applySupersededBanner(raw, revision, findings, on);
  if (!result.ok) {
    return { ok: false, message: `${reportPath}: ${result.message}` };
  }
  if (result.changed) {
    writeFileSync(absPath, result.content, "utf8");
  }
  return { ok: true, path: reportPath, changed: result.changed };
}
