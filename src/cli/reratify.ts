// SPDX-License-Identifier: MIT
// `em slice reratify` (MIL-161 finding #4): the version-bump / status-flip mechanical edit
// SKILL.md's `slice` phase (step 0/2, re-ratification) has always described as "bump `version`
// and flip `status` back to `ready-to-implement` by hand" — the same shape `em slice
// mark-implemented` (MIL-103) already mechanized at the OTHER end of the lifecycle (the merge-
// time flip). Sets exactly two frontmatter fields on the doc resolved from the key via the SAME
// note-binding resolution `mark-implemented`/`ratify`/`--slice-ready`/`em export` use
// (catalog/docJoin.ts's resolveSliceDocJoin):
//
//   version: <current + 1>
//   status: ready-to-implement
//
// Only applies to a doc currently `status: implemented` — the precondition
// docs/slice-doc-schema.md#status-under-re-ratification describes ("a new version is ratified
// for a slice whose previous version already shipped"). Refuses (never guesses) otherwise: a
// `draft`/`reviewed` doc hasn't shipped yet, so there's no prior version to bump FROM, and a
// doc already `ready-to-implement` means either first-time authoring (never touch this doc with
// reratify at all — `em slice new` is what scaffolds those) or a reratify that already ran (a
// second bump would silently double-increment `version`, which this command deliberately never
// does — bumping isn't naturally idempotent the way ratify/mark-implemented's absolute-value
// writes are).
//
// Also clears `ratifiedBy:`/`ratifiedOn:` if either is present: those fields record who signed
// off the PRIOR version (`em slice ratify`, MIL-165) and describing the brand-new, not-yet-
// reviewed version as already ratified by the old signer would be actively misleading. Clearing
// them (rather than leaving them stale) is also what lets a subsequent `em slice ratify --by
// <name>` apply cleanly afterward — ratify's own idempotent-refusal guard would otherwise read
// the leftover prior ratifiedBy/ratifiedOn as "already ratified by someone else" and refuse.
//
// Write strategy: the same surgical index-math splicing markImplemented.ts/ratify.ts use, via
// the shared primitives in ./frontmatterSurgery.js — never a parse+re-serialize. Everything
// outside the edited value spans — the body, `implementedIn:`, the lineage/`covers` keys, and
// (best-effort) the file's own line-ending style — is copied through verbatim. The `## Delta`
// section (docs/slice-doc-schema.md#delta-section-grammar-and-lifecycle) recording WHAT changed
// stays entirely hand-authored — this command only ever touches the two lifecycle fields above.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";
import { fieldLineRegex, fieldLineWithEolRegex, locateFrontmatterInner, normalizeFieldValue } from "./frontmatterSurgery.js";

/** The status a doc must already be in for `reratify` to apply — mirrors `RATIFIED_STATUS` in
 *  ratify.ts (the status this command flips TO), named separately since it's the precondition
 *  here, not the target. */
const IMPLEMENTED_STATUS = "implemented";
const TARGET_STATUS = "ready-to-implement";

export type ApplyReratifyResult =
  | { ok: true; content: string; newVersion: number }
  | { ok: false; message: string };

/**
 * Pure text transform: bumps `version:` by 1 and flips `status:` to `ready-to-implement` in
 * `raw`'s frontmatter block, clearing any `ratifiedBy:`/`ratifiedOn:` lines found (see module
 * header). Refuses (`ok: false`) unless the doc's CURRENT `status:` is exactly `implemented` —
 * see module header for why this precondition (not idempotent-no-op) is the right refusal
 * shape here. No fs access — the caller reads/writes; see `runReratify` below.
 */
export function applyReratifyFrontmatter(raw: string): ApplyReratifyResult {
  const range = locateFrontmatterInner(raw);
  if (!range) return { ok: false, message: "no frontmatter block found" };
  const inner = raw.slice(range.innerStart, range.innerEnd);

  const statusMatch = fieldLineRegex("status").exec(inner);
  if (!statusMatch) return { ok: false, message: "no `status:` field found in frontmatter" };
  const currentStatus = normalizeFieldValue(statusMatch[2])?.toLowerCase() ?? null;
  if (currentStatus !== IMPLEMENTED_STATUS) {
    return {
      ok: false,
      message:
        `doc is \`status: ${currentStatus ?? "(empty)"}\`, not \`implemented\` — reratify only applies to a ` +
        "slice doc that has already shipped (see docs/slice-doc-schema.md#status-under-re-ratification); " +
        "first-time authoring uses `em slice new`, and a doc already `ready-to-implement` may already " +
        "have been reratified",
    };
  }

  const versionMatch = fieldLineRegex("version").exec(inner);
  if (!versionMatch) return { ok: false, message: "no `version:` field found in frontmatter" };
  const currentVersionRaw = normalizeFieldValue(versionMatch[2]);
  const currentVersion = currentVersionRaw !== null ? Number(currentVersionRaw) : NaN;
  if (!Number.isInteger(currentVersion) || currentVersion < 1) {
    return {
      ok: false,
      message: `doc's \`version:\` value "${currentVersionRaw ?? ""}" isn't a positive integer — refusing to guess a bump`,
    };
  }
  const newVersion = currentVersion + 1;

  // Apply from the highest index first so an earlier edit's index stays valid — same convention
  // markImplemented.ts/ratify.ts use.
  const edits = [
    { index: statusMatch.index, oldLen: statusMatch[0].length, next: `${statusMatch[1]}${TARGET_STATUS}` },
    { index: versionMatch.index, oldLen: versionMatch[0].length, next: `${versionMatch[1]}${newVersion}` },
  ].sort((a, b) => b.index - a.index);
  let updatedInner = inner;
  for (const edit of edits) {
    updatedInner = updatedInner.slice(0, edit.index) + edit.next + updatedInner.slice(edit.index + edit.oldLen);
  }

  // Clear stale ratifiedBy:/ratifiedOn: — see module header. A plain `.replace()` (not
  // index-spliced alongside the edits above) is safe here: these two keys are disjoint from
  // `status:`/`version:` by construction (fieldLineRegex matches one key at a time), so removing
  // them from the ALREADY-updated text can't disturb the edits just applied.
  updatedInner = updatedInner.replace(fieldLineWithEolRegex("ratifiedBy"), "").replace(fieldLineWithEolRegex("ratifiedOn"), "");

  const content = raw.slice(0, range.innerStart) + updatedInner + raw.slice(range.innerEnd);
  return { ok: true, content, newVersion };
}

export type RunReratifyResult =
  | { ok: true; path: string; newVersion: number }
  | { ok: false; message: string };

/**
 * Resolves `sliceKey` to its bound doc via the same note-binding join `mark-implemented`/
 * `ratify`/`--slice-ready`/`em export` use (MIL-121 cross-binding included), then reads/applies/
 * writes it. `baseDir` is the `.em` file's directory, same convention every doc/note path in
 * `em` uses.
 */
export function runReratify(
  model: NormalizedModel,
  refs: RefsResult,
  baseDir: string,
  sliceKey: string,
): RunReratifyResult {
  const sliceIndex = refs.sliceKeys.indexOf(sliceKey);
  if (sliceIndex === -1) {
    return { ok: false, message: `no slice with export key "${sliceKey}" in this model` };
  }
  const slice = model.slices[sliceIndex];
  const { doc } = resolveSliceDocJoin(slice, sliceKey, baseDir, (id) => refs.refById.get(id)!);

  if (doc.reason === "no-doc-bound") {
    return {
      ok: false,
      message: `slice "${sliceKey}" has no doc bound via \`note "slices/${sliceKey}.md"\` — bind a slice doc before reratifying it`,
    };
  }
  if (doc.reason === "binding-missing-file") {
    return { ok: false, message: `slice "${sliceKey}" notes "${doc.path}" but no such file exists` };
  }
  if (doc.reason === "frontmatter-invalid") {
    return {
      ok: false,
      message: `slice doc "${doc.path}" has missing or invalid frontmatter — run \`em validate\` for details`,
    };
  }

  const absPath = join(baseDir, doc.path);
  const raw = readFileSync(absPath, "utf8");
  const result = applyReratifyFrontmatter(raw);
  if (!result.ok) {
    return { ok: false, message: `${doc.path}: ${result.message}` };
  }
  writeFileSync(absPath, result.content, "utf8");
  return { ok: true, path: doc.path, newVersion: result.newVersion };
}
