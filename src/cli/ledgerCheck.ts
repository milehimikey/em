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

export interface LedgerCheckResult {
  findings: LedgerFinding[];
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
    if (!hasUsableFrontmatter(oldDoc) || !hasUsableFrontmatter(newDoc)) {
      skipped.push({ sliceKey, reason: "frontmatter-invalid" });
      continue;
    }

    const oldVersion = oldDoc.version!;
    const newVersion = newDoc.version!;
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

  return { findings, skipped, checkedCount: keys.length };
}
