// SPDX-License-Identifier: MIT
// `em ledger` (MIL-89): checks that a slice doc's `version:` frontmatter field and its content
// (body + lineage refs) always change together across two git revisions — a version bump with
// no real content change is a no-op ledger entry, a content change with no version bump is a
// stale ratification signal, and a version going backwards is a typo/regression. Opt-in,
// CI-recipe tier — never folded into `em validate`, which stays a fast function of the current
// tree (see lineageValidate.ts's header comment, which named this exact shape during MIL-84).
//
// Sibling to diff-inputs.ts in role: testable input handling / git-revision logic factored out
// of cli.ts, with an injectable GitRunner and no process.exit/console — see
// test/ledgerCheck.test.ts. Reuses resolveDocAtRevision/listSliceKeysAtRevision rather than
// second, divergent git plumbing.

import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { hasUsableFrontmatter, SliceDoc, SliceRef } from "../catalog/sliceDoc.js";
import { readSliceDoc } from "../catalog/readSliceDoc.js";
import { GitRunner, realGit, listSliceKeysAtRevision, resolveDocAtRevision } from "./diff-inputs.js";

export type LedgerFindingCode =
  | "ledger-content-without-version-bump"
  | "ledger-version-without-content-change"
  | "ledger-version-regression";

export interface LedgerFinding {
  sliceKey: string;
  code: LedgerFindingCode;
  message: string;
  oldVersion: number;
  newVersion: number;
  bodyChanged: boolean;
  lineageChanged: boolean;
}

export type LedgerSkipReason = "no-prior-revision" | "deleted" | "frontmatter-invalid";

export interface LedgerSkip {
  sliceKey: string;
  reason: LedgerSkipReason;
}

/** Where a waiver of a `ledger-content-without-version-bump` finding came from (MIL-185): the
 *  repeatable `--waive <slice-key>` flag on a manual run, or an `Em-Ledger-Waive: <slice-key>`
 *  git trailer found on a commit in the checked range during a CI run. The trailer variant
 *  carries the exact commit that declared it — see `readLedgerWaiverTrailers` — so the waiver
 *  is auditable back to a specific, reviewed change, not just an unattributed flag.
 */
export type LedgerWaiveSource = { source: "flag" } | { source: "trailer"; commit: string };

/** A `ledger-content-without-version-bump` finding that was excused rather than silenced —
 *  still fully reported (text output prints a `waived:` line, JSON lists it under `waived`),
 *  just not counted toward the exit code. Only this one finding code is ever waivable: a
 *  version regression or a bump-without-content-change is never a "formatting-only" false
 *  positive, so waiving either would hide a real defect (docs/cli.md, docs/ci.md). */
export interface WaivedLedgerFinding extends LedgerFinding {
  waivedBy: LedgerWaiveSource;
}

/** A waiver (flag or trailer) that named a slice key with no matching waivable finding — either
 *  a typo, a key for a slice with a different (non-waivable) finding, or a slice that's already
 *  clean. Not an error: the waiver is simply inert, but silently swallowing it would hide a
 *  typo'd `--waive`/trailer from the operator, so it's surfaced as a note (stderr in the CLI,
 *  never folded into `findings`/`waived`). */
export interface UnknownLedgerWaiver {
  sliceKey: string;
  source: LedgerWaiveSource;
}

export interface LedgerCheckResult {
  findings: LedgerFinding[];
  /** Findings excused by a waiver (MIL-185) — see `WaivedLedgerFinding`. Always present (`[]`
   *  when no waiver applied), so a caller comparing runs before/after MIL-185 sees only this one
   *  additive field, never a shape change to `findings`/`skipped`/`checkedCount`. */
  waived: WaivedLedgerFinding[];
  skipped: LedgerSkip[];
  /** Total slice keys considered (the union of both revisions' `slices/*.md` — every key that
   *  produced either a finding, a skip, or a clean pass). Lets a caller report "N checked"
   *  without re-deriving it from findings.length + skipped.length + (silent clean count). */
  checkedCount: number;
}

/** Slice keys currently on disk under `<baseDir>/slices/*.md` — the working-tree counterpart to
 *  `listSliceKeysAtRevision`, used when `to` is null (compare against the working tree). */
function listSliceKeysOnDisk(baseDir: string): string[] {
  const dir = join(baseDir, "slices");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => basename(name, ".md"));
}

/** True when two lineage refs (or their absence) carry the same declared text — compared on
 *  `raw` so a malformed ref (null sliceKey/version) still counts as a real change if its text
 *  changes, not silently treated as equal to another malformed ref. */
function refEqual(a: SliceRef | null, b: SliceRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.raw === b.raw;
}

function refListEqual(a: SliceRef[], b: SliceRef[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((ref, i) => refEqual(ref, b[i]));
}

/** True when either side's declared lineage (`split-from`/`merged-from`/`superseded-by`)
 *  differs — these describe what the doc *asserts*, same-commit-authoring convention means a
 *  legitimate change here always co-occurs with a version bump (docs/slice-doc-schema.md). */
function lineageChanged(oldDoc: SliceDoc, newDoc: SliceDoc): boolean {
  return (
    !refEqual(oldDoc.splitFrom, newDoc.splitFrom) ||
    !refListEqual(oldDoc.mergedFrom, newDoc.mergedFrom) ||
    !refListEqual(oldDoc.supersededBy, newDoc.supersededBy)
  );
}

/**
 * Compare every slice doc's version:/content agreement between two revisions of `anchorFile`'s
 * repo. `to` null means "the current working tree" (same convention as `em diff`). Pure aside
 * from the injected GitRunner and fs reads via readSliceDoc — no process.exit, no console.
 *
 * Deliberately excludes `status`/`implementedIn` from the content comparison: those change
 * independently by design during re-ratification (docs/slice-doc-schema.md, "`status` under
 * re-ratification") — including them would false-positive on every ordinary lifecycle
 * transition. Also excludes `pattern`/`swimlane`/`schemaVersion`: decorative, not currently
 * exposed on `SliceDoc` at all. Body comparison is `.trim()`-only — strips leading/trailing
 * whitespace, avoiding a false positive from a trailing-newline/CRLF-only re-save, without
 * risking a false negative on a real prose edit.
 */
export function checkLedger(anchorFile: string, from: string, to: string | null, runGit: GitRunner = realGit): LedgerCheckResult {
  const baseDir = dirname(resolve(anchorFile));
  const oldKeys = listSliceKeysAtRevision(anchorFile, from, runGit);
  const newKeys = to ? listSliceKeysAtRevision(anchorFile, to, runGit) : listSliceKeysOnDisk(baseDir);
  const keys = [...new Set([...oldKeys, ...newKeys])].sort();

  const findings: LedgerFinding[] = [];
  const skipped: LedgerSkip[] = [];

  for (const sliceKey of keys) {
    const oldDoc = resolveDocAtRevision(anchorFile, sliceKey, from, runGit);
    if (!oldDoc) {
      skipped.push({ sliceKey, reason: "no-prior-revision" });
      continue;
    }
    const newDoc = to ? resolveDocAtRevision(anchorFile, sliceKey, to, runGit) : readSliceDoc(baseDir, sliceKey);
    if (!newDoc) {
      skipped.push({ sliceKey, reason: "deleted" });
      continue;
    }
    // hasUsableFrontmatter() only checks that the `version` key is *present*
    // (missingRequiredFields), not that its value parsed to a valid positive integer —
    // `version: abc`/`version: 0`/`version: 1.5` all pass that gate with SliceDoc.version still
    // null (see sliceDoc.ts's parseVersion()). lineageValidate.ts hits the same gap and handles
    // it the same way: an explicit null check, routed to the same skip a missing key gets,
    // rather than a non-null assertion that would corrupt a finding's message/classification.
    if (!hasUsableFrontmatter(oldDoc) || !hasUsableFrontmatter(newDoc) || oldDoc.version === null || newDoc.version === null) {
      skipped.push({ sliceKey, reason: "frontmatter-invalid" });
      continue;
    }

    const oldVersion = oldDoc.version;
    const newVersion = newDoc.version;
    const bodyChanged = oldDoc.body.trim() !== newDoc.body.trim();
    const docsLineageChanged = lineageChanged(oldDoc, newDoc);
    const contentChanged = bodyChanged || docsLineageChanged;

    let code: LedgerFindingCode | null = null;
    if (newVersion < oldVersion) {
      code = "ledger-version-regression";
    } else if (contentChanged && newVersion === oldVersion) {
      code = "ledger-content-without-version-bump";
    } else if (!contentChanged && newVersion > oldVersion) {
      code = "ledger-version-without-content-change";
    }
    if (!code) continue;

    const message =
      code === "ledger-version-regression"
        ? `slice "${sliceKey}": version went backwards (v${oldVersion} -> v${newVersion})`
        : code === "ledger-content-without-version-bump"
          ? `slice "${sliceKey}": doc content changed but version: didn't bump (still v${oldVersion})`
          : `slice "${sliceKey}": version: bumped (v${oldVersion} -> v${newVersion}) but doc content is unchanged`;

    findings.push({ sliceKey, code, message, oldVersion, newVersion, bodyChanged, lineageChanged: docsLineageChanged });
  }

  return { findings, waived: [], skipped, checkedCount: keys.length };
}

/** The only finding code a waiver may excuse (MIL-185, R9) — see `WaivedLedgerFinding`. */
const WAIVABLE_LEDGER_CODE: LedgerFindingCode = "ledger-content-without-version-bump";

/** One `Em-Ledger-Waive: <slice-key>` trailer found on a commit in the checked range, paired
 *  with the commit that declared it. */
export interface LedgerTrailerWaiver {
  sliceKey: string;
  commit: string;
}

// `%x00`/`%x01` are git's own pretty-format escapes for those literal bytes — git substitutes
// them into its OUTPUT, so the argv string handed to spawnSync stays plain ASCII text (an actual
// embedded NUL byte in an argv string throws in Node's child_process). The output bytes they
// produce are never valid in a commit hash or trailer value, so they're safe as delimiters when
// *parsing* `log.stdout` below — same technique as `changelog-git.ts`'s `FS` separator, one step
// removed because these two also need to round-trip through a `--format` argument first.
const FORMAT_HASH_SEP = "%x00";
const FORMAT_RECORD_END = "%x01";
const HASH_SEP = "\x00";
const RECORD_END = "\x01";

/**
 * `Em-Ledger-Waive: <slice-key>` trailers on every commit in `from..to` (`to` null means `HEAD`
 * — an uncommitted working-tree change has no commit to carry a trailer, so it can only be
 * waived via `--waive`; see docs/cli.md). Reads the range oldest-first (`--reverse`) so a slice
 * key repeated across several commits attributes to the **first** (earliest) commit that
 * actually declared the waiver, not the most recent — deterministic for a given repo state, and
 * the answer an auditor wants ("who introduced this waiver").
 *
 * Uses `%(trailers:key=Em-Ledger-Waive,valueonly)` (git's own trailer parser — requires the
 * standard blank-line-separated footer block, same convention `git interpret-trailers` expects)
 * rather than regexing commit messages by hand. A range that fails to resolve (unknown
 * revision, `anchorFile` not in a repo) returns `[]` — routine, matching every other
 * `diff-inputs.ts` git call's "missing is not a crash" stance; `checkLedger`'s own calls against
 * the same revisions already surface a real problem with `--from`/`--to` if there is one.
 */
export function readLedgerWaiverTrailers(anchorFile: string, from: string, to: string | null, runGit: GitRunner = realGit): LedgerTrailerWaiver[] {
  const toplevel = runGit(["-C", dirname(resolve(anchorFile)), "rev-parse", "--show-toplevel"]);
  if (toplevel.status !== 0) return [];
  const repoRoot = toplevel.stdout.trim();
  const range = `${from}..${to ?? "HEAD"}`;
  const log = runGit([
    "-C",
    repoRoot,
    "log",
    "--reverse",
    `--format=%H${FORMAT_HASH_SEP}%(trailers:key=Em-Ledger-Waive,valueonly)${FORMAT_RECORD_END}`,
    range,
  ]);
  if (log.status !== 0) return [];

  const seen = new Set<string>();
  const waivers: LedgerTrailerWaiver[] = [];
  for (const record of log.stdout.split(RECORD_END)) {
    const body = record.startsWith("\n") ? record.slice(1) : record;
    if (!body.trim()) continue;
    const sepIndex = body.indexOf(HASH_SEP);
    if (sepIndex === -1) continue;
    const commit = body.slice(0, sepIndex);
    const values = body
      .slice(sepIndex + 1)
      .split("\n")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    for (const sliceKey of values) {
      if (seen.has(sliceKey)) continue; // keep only the first (earliest, --reverse) commit
      seen.add(sliceKey);
      waivers.push({ sliceKey, commit });
    }
  }
  return waivers;
}

/**
 * Split a `checkLedger` result's findings into still-active and waived (MIL-185, R9), given the
 * flag-provided slice keys (repeatable `--waive <slice-key>`) and the trailer waivers read from
 * the commit range (`readLedgerWaiverTrailers`). Pure — no git access, so flag-only and
 * trailer-only waiver logic is testable without faking a git runner.
 *
 * Only a `ledger-content-without-version-bump` finding is ever waivable (`WAIVABLE_LEDGER_CODE`)
 * — a version regression or a bump-without-content-change stays a hard finding regardless of any
 * waiver naming that slice key. A flag waiver takes precedence over a same-key trailer waiver
 * (both excuse the same finding; the flag is the more explicit, in-hand instruction). A waiver
 * that names a slice key with no matching waivable finding is reported via `unknownWaivers`
 * rather than silently dropped — see `UnknownLedgerWaiver`.
 */
export function applyLedgerWaivers(
  result: LedgerCheckResult,
  flagWaivedKeys: string[],
  trailerWaivers: LedgerTrailerWaiver[],
): { result: LedgerCheckResult; unknownWaivers: UnknownLedgerWaiver[] } {
  const waivableBySliceKey = new Map<string, LedgerFinding>();
  for (const finding of result.findings) {
    if (finding.code === WAIVABLE_LEDGER_CODE) waivableBySliceKey.set(finding.sliceKey, finding);
  }

  const waivedSliceKeys = new Set<string>();
  const waived: WaivedLedgerFinding[] = [...result.waived];
  const unknownWaivers: UnknownLedgerWaiver[] = [];

  const seenFlagKeys = new Set<string>();
  for (const sliceKey of flagWaivedKeys) {
    if (seenFlagKeys.has(sliceKey)) continue;
    seenFlagKeys.add(sliceKey);
    const finding = waivableBySliceKey.get(sliceKey);
    const source: LedgerWaiveSource = { source: "flag" };
    if (finding) {
      waived.push({ ...finding, waivedBy: source });
      waivedSliceKeys.add(sliceKey);
    } else {
      unknownWaivers.push({ sliceKey, source });
    }
  }

  for (const trailer of trailerWaivers) {
    if (waivedSliceKeys.has(trailer.sliceKey)) continue; // already waived by a flag entry
    const finding = waivableBySliceKey.get(trailer.sliceKey);
    const source: LedgerWaiveSource = { source: "trailer", commit: trailer.commit };
    if (finding) {
      waived.push({ ...finding, waivedBy: source });
      waivedSliceKeys.add(trailer.sliceKey);
    } else {
      unknownWaivers.push({ sliceKey: trailer.sliceKey, source });
    }
  }

  waived.sort((a, b) => a.sliceKey.localeCompare(b.sliceKey));
  const findings = result.findings.filter((f) => !waivedSliceKeys.has(f.sliceKey));

  return { result: { ...result, findings, waived }, unknownWaivers };
}
