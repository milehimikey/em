// SPDX-License-Identifier: MIT
// `em slice review` (MIL-201): gives `status: reviewed` a mechanical path into the slice doc.
// `reviewed` has been a first-class value in the status enum since the schema was written
// (docs/slice-doc-schema.md), but nothing ever wrote it — a facilitator who finished walking a
// slice in a stakeholder review either hand-edited the frontmatter or (the failure this command
// exists to prevent) reached straight for `em slice ratify` and collapsed two distinct human
// gates into one. Review is the FIRST gate: the room agreed the slice reads correctly.
// Ratification is a separate, later, usually multi-person gate — see
// docs/process.md#the-slice-lifecycle-gates.
//
// Deliberately a clone of ratify.ts's mechanics, not a generalization of them: same note-binding
// resolution (catalog/docJoin.ts's resolveSliceDocJoin), same `--by`/`--on` validation, same
// surgical index-splice write via ./frontmatterSurgery.js, same idempotent/refuse-to-overwrite
// discipline. The two commands read as one family precisely because they are the two ends of the
// same handoff.
//
// Status preconditions (R4, docs/cli.md): legal from `draft` (the ordinary case — a slice doc
// walked in a review session) and from `reviewed` itself (idempotent re-run, or a refusal when a
// DIFFERENT reviewer/date is already recorded). Refuses from `ready-to-implement`/`implemented`:
// review applies BEFORE ratification, and a slice that has already shipped is reopened with
// `em slice reratify`, not reviewed in place.
//
// `reviewedBy`/`reviewedOn` are additive, optional frontmatter keys in every status
// (docs/slice-doc-schema.md) — exactly like `ratifiedBy`/`ratifiedOn`. `em slice ratify` never
// clears them (the review record stays as provenance for the version it described);
// `em slice reratify` does clear them alongside `ratifiedBy`/`ratifiedOn`, since neither the old
// sign-off nor the old review describes the brand-new version.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";
import { fieldLineRegex, locateFrontmatterInner, normalizeFieldValue } from "./frontmatterSurgery.js";
import { isValidDateString } from "./stateFile.js";

/** The status this command flips a slice doc to — the review gate
 *  (docs/process.md#the-slice-lifecycle-gates): the room walked the slice and every open question
 *  it raised was resolved. NOT a handoff to an implementer; that's `em slice ratify`. */
export const REVIEWED_STATUS = "reviewed";

/** Statuses `em slice review` refuses to act on: review applies before ratification, so a doc
 *  that has already passed the ratification gate (or shipped) is past the point where "the room
 *  reviewed it" is a meaningful new fact about THIS version. */
const POST_REVIEW_STATUSES = ["ready-to-implement", "implemented"];

export type ApplyReviewResult =
  | { ok: true; content: string; changed: boolean }
  | { ok: false; message: string };

/**
 * Pure text transform: flips `status:` to `reviewed` and sets `reviewedBy:`/`reviewedOn:` in
 * `raw`'s frontmatter block. Idempotent (re-applying the same by/on pair once already reviewed is
 * a no-op, `changed: false`, `content` returned byte-identical to `raw`); refuses (`ok: false`)
 * rather than silently overwrite provenance when the doc is already `status: reviewed` with a
 * *different* recorded reviewer/date — mirroring `applyRatifyFrontmatter`'s refusal exactly.
 * Refuses from `ready-to-implement`/`implemented` (see module header). No fs access — the caller
 * reads/writes; see `runReview` below.
 */
export function applyReviewFrontmatter(raw: string, reviewedBy: string, reviewedOn: string): ApplyReviewResult {
  const trimmedBy = reviewedBy.trim();
  if (!trimmedBy) return { ok: false, message: "a reviewer name is required (--by)" };
  // Same guard, same rationale as ratify's: an embedded \r/\n could splice a multi-line value
  // into the frontmatter and corrupt the fence, while internal spaces are legitimate in a name.
  if (/[\x00-\x1f\x7f]/.test(trimmedBy)) {
    return { ok: false, message: "reviewer name must not contain control characters" };
  }
  if (!isValidDateString(reviewedOn)) {
    return { ok: false, message: `invalid date "${reviewedOn}" — expected YYYY-MM-DD` };
  }

  const range = locateFrontmatterInner(raw);
  if (!range) return { ok: false, message: "no frontmatter block found" };
  const inner = raw.slice(range.innerStart, range.innerEnd);

  const statusMatch = fieldLineRegex("status").exec(inner);
  if (!statusMatch) return { ok: false, message: "no `status:` field found in frontmatter" };

  const byMatch = fieldLineRegex("reviewedBy").exec(inner);
  const onMatch = fieldLineRegex("reviewedOn").exec(inner);
  const currentStatus = normalizeFieldValue(statusMatch[2])?.toLowerCase() ?? null;
  const currentBy = byMatch ? normalizeFieldValue(byMatch[2]) : null;
  const currentOn = onMatch ? normalizeFieldValue(onMatch[2]) : null;

  if (currentStatus === REVIEWED_STATUS && currentBy !== null && currentOn !== null) {
    if (currentBy === trimmedBy && currentOn === reviewedOn) {
      return { ok: true, content: raw, changed: false }; // idempotent no-op
    }
    return {
      ok: false,
      message:
        `already reviewed by ${currentBy} on ${currentOn} — refusing to overwrite with ` +
        `${trimmedBy} on ${reviewedOn}`,
    };
  }

  if (currentStatus !== null && POST_REVIEW_STATUSES.includes(currentStatus)) {
    return {
      ok: false,
      message:
        `doc is \`status: ${currentStatus}\` — review applies before ratification; a shipped ` +
        "slice is reopened with `em slice reratify`",
    };
  }

  // Match the file's own line-ending style for any freshly-inserted line — same trick
  // markImplemented.ts/ratify.ts use (see ratify.ts for the full rationale).
  const afterStatus = inner.slice(statusMatch.index + statusMatch[0].length);
  const eol = afterStatus.startsWith("\r\n") ? "\r\n" : "\n";

  // Whichever of reviewedBy/reviewedOn have no existing line get folded directly into the status
  // edit's replacement text (inserted right after the new status value) rather than added as
  // separate zero-length "insert" edits — same convention as ratify.ts.
  const missingLines: string[] = [];
  if (!byMatch) missingLines.push(`reviewedBy: ${trimmedBy}`);
  if (!onMatch) missingLines.push(`reviewedOn: ${reviewedOn}`);
  const newStatusText = `${statusMatch[1]}${REVIEWED_STATUS}`;
  const statusNext = missingLines.length > 0 ? `${newStatusText}${eol}${missingLines.join(eol)}` : newStatusText;

  // Apply from the highest index first so an earlier edit's index stays valid — same convention
  // markImplemented.ts/ratify.ts use.
  const edits: { index: number; oldLen: number; next: string }[] = [
    { index: statusMatch.index, oldLen: statusMatch[0].length, next: statusNext },
  ];
  if (byMatch) edits.push({ index: byMatch.index, oldLen: byMatch[0].length, next: `${byMatch[1]}${trimmedBy}` });
  if (onMatch) edits.push({ index: onMatch.index, oldLen: onMatch[0].length, next: `${onMatch[1]}${reviewedOn}` });
  edits.sort((a, b) => b.index - a.index);

  let updatedInner = inner;
  for (const edit of edits) {
    updatedInner = updatedInner.slice(0, edit.index) + edit.next + updatedInner.slice(edit.index + edit.oldLen);
  }

  const content = raw.slice(0, range.innerStart) + updatedInner + raw.slice(range.innerEnd);
  return { ok: true, content, changed: true };
}

export type RunReviewResult =
  | { ok: true; path: string; changed: boolean }
  | { ok: false; message: string };

/**
 * Resolves `sliceKey` to its bound doc via the same note-binding join `ratify`/`mark-implemented`/
 * `--slice-ready`/`em export` use (MIL-121 cross-binding included), then reads/applies/writes it.
 * `baseDir` is the `.em` file's directory, same convention every doc/note path in `em` uses.
 */
export function runReview(
  model: NormalizedModel,
  refs: RefsResult,
  baseDir: string,
  sliceKey: string,
  reviewedBy: string,
  reviewedOn: string,
): RunReviewResult {
  const sliceIndex = refs.sliceKeys.indexOf(sliceKey);
  if (sliceIndex === -1) {
    return { ok: false, message: `no slice with export key "${sliceKey}" in this model` };
  }
  const slice = model.slices[sliceIndex];
  const { doc } = resolveSliceDocJoin(slice, sliceKey, baseDir, (id) => refs.refById.get(id)!);

  if (doc.reason === "no-doc-bound") {
    return {
      ok: false,
      message: `slice "${sliceKey}" has no doc bound via \`note "slices/${sliceKey}.md"\` — bind a slice doc before reviewing it`,
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
  const result = applyReviewFrontmatter(raw, reviewedBy, reviewedOn);
  if (!result.ok) {
    return { ok: false, message: `${doc.path}: ${result.message}` };
  }
  if (result.changed) {
    writeFileSync(absPath, result.content, "utf8");
  }
  return { ok: true, path: doc.path, changed: result.changed };
}
