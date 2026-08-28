// SPDX-License-Identifier: MIT
// `em slice ratify` (MIL-165): makes "who ratified, and when" a first-class recorded fact
// instead of an unnamed edit anyone with commit access could make. Flips `status:
// ready-to-implement` and sets `ratifiedBy:`/`ratifiedOn:` on the slice doc resolved from the
// key via the SAME note-binding resolution `mark-implemented`/`--slice-ready`/`em export` use
// (catalog/docJoin.ts's resolveSliceDocJoin) — same shape and idempotency discipline as
// `em slice mark-implemented` (MIL-103, markImplemented.ts), mirrored deliberately so the two
// lifecycle-flip commands (ratify at handoff, mark-implemented at merge) read as one family.
//
// Write strategy: the same surgical index-math splicing markImplemented.ts uses, via the shared
// primitives in ./frontmatterSurgery.js — never a parse+re-serialize (sliceDoc.ts's own parser
// is deliberately read-only and drops everything not in its `SliceDoc` shape). Everything
// outside the edited value spans — the body, `version:`, `implementedIn:`, the lineage/`covers`
// keys, and (best-effort) the file's own line-ending style — is copied through verbatim.
//
// `ratifiedBy`/`ratifiedOn` are additive, optional frontmatter keys (docs/slice-doc-schema.md):
// omitting them is not an error to any existing `em` command (the "unknown keys are captured,
// never read, never a warning" contract already covers a doc that predates this feature), and
// this command is the only thing that ever writes them — same "one write path" discipline
// `mark-implemented` holds for `implementedIn`.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";
import { fieldLineRegex, locateFrontmatterInner, normalizeFieldValue } from "./frontmatterSurgery.js";
import { isValidDateString } from "./stateFile.js";

/** The status this command flips a slice doc to — the handoff gate
 *  (docs/process.md#what-ratified-means): contracts/invariants agreed, open questions resolved
 *  or deferred, ready for an implementing agent or engineer to pick up. */
export const RATIFIED_STATUS = "ready-to-implement";

export type ApplyRatifyResult =
  | { ok: true; content: string; changed: boolean }
  | { ok: false; message: string };

/**
 * Pure text transform: flips `status:` to `ready-to-implement` and sets `ratifiedBy:`/
 * `ratifiedOn:` in `raw`'s frontmatter block. Idempotent (re-applying the same by/on pair once
 * already ratified is a no-op, `changed: false`, `content` returned byte-identical to `raw`);
 * refuses (`ok: false`) rather than silently overwrite provenance when the doc is already
 * `status: ready-to-implement` with a *different* recorded ratifier/date — mirroring
 * `applyImplementedFrontmatter`'s refusal to overwrite a different `implementedIn`. There is no
 * such refusal when `status` isn't already the target: re-ratifying a slice that has since moved
 * on (e.g. back from `implemented` after a version bump — docs/slice-doc-schema.md#status-under-
 * re-ratification) is the ordinary, expected use of this command, so it always applies cleanly.
 * No fs access — the caller reads/writes; see `runRatify` below.
 */
export function applyRatifyFrontmatter(raw: string, ratifiedBy: string, ratifiedOn: string): ApplyRatifyResult {
  const trimmedBy = ratifiedBy.trim();
  if (!trimmedBy) return { ok: false, message: "a ratifier name is required (--by)" };
  // Refuse control characters (including an embedded \r/\n, which could splice a multi-line
  // value into the frontmatter and corrupt the fence) — unlike mark-implemented's PR-URL guard,
  // internal whitespace is fine: a person's name legitimately contains spaces ("Alice Smith").
  if (/[\x00-\x1f\x7f]/.test(trimmedBy)) {
    return { ok: false, message: "ratifier name must not contain control characters" };
  }
  if (!isValidDateString(ratifiedOn)) {
    return { ok: false, message: `invalid date "${ratifiedOn}" — expected YYYY-MM-DD` };
  }

  const range = locateFrontmatterInner(raw);
  if (!range) return { ok: false, message: "no frontmatter block found" };
  const inner = raw.slice(range.innerStart, range.innerEnd);

  const statusMatch = fieldLineRegex("status").exec(inner);
  if (!statusMatch) return { ok: false, message: "no `status:` field found in frontmatter" };

  const byMatch = fieldLineRegex("ratifiedBy").exec(inner);
  const onMatch = fieldLineRegex("ratifiedOn").exec(inner);
  const currentStatus = normalizeFieldValue(statusMatch[2])?.toLowerCase() ?? null;
  const currentBy = byMatch ? normalizeFieldValue(byMatch[2]) : null;
  const currentOn = onMatch ? normalizeFieldValue(onMatch[2]) : null;

  if (currentStatus === RATIFIED_STATUS && currentBy !== null && currentOn !== null) {
    if (currentBy === trimmedBy && currentOn === ratifiedOn) {
      return { ok: true, content: raw, changed: false }; // idempotent no-op
    }
    return {
      ok: false,
      message:
        `already ratified by ${currentBy} on ${currentOn} — refusing to overwrite with ` +
        `${trimmedBy} on ${ratifiedOn}`,
    };
  }

  // Match the file's own line-ending style for any freshly-inserted line, same trick
  // markImplemented.ts uses: on a CRLF doc, the text right after the status line's match starts
  // with the "\r\n" that used to terminate it, so reusing it keeps a new line consistent with
  // its neighbors instead of being the one bare-LF line in an otherwise-CRLF file.
  const afterStatus = inner.slice(statusMatch.index + statusMatch[0].length);
  const eol = afterStatus.startsWith("\r\n") ? "\r\n" : "\n";

  // Whichever of ratifiedBy/ratifiedOn have no existing line get folded directly into the status
  // edit's replacement text (inserted right after the new status value) rather than added as
  // separate zero-length "insert" edits — simpler and unambiguous to splice than reasoning about
  // an insert-edit's index coinciding with an adjacent replace-edit's span.
  const missingLines: string[] = [];
  if (!byMatch) missingLines.push(`ratifiedBy: ${trimmedBy}`);
  if (!onMatch) missingLines.push(`ratifiedOn: ${ratifiedOn}`);
  const newStatusText = `${statusMatch[1]}${RATIFIED_STATUS}`;
  const statusNext = missingLines.length > 0 ? `${newStatusText}${eol}${missingLines.join(eol)}` : newStatusText;

  // Apply from the highest index first so an earlier edit's index stays valid — same convention
  // markImplemented.ts uses. Each present match (status always, ratifiedBy/ratifiedOn only when
  // an existing line was found) is replaced independently of the others' positions, so this is
  // safe even when the frontmatter's keys are out of the usual order.
  const edits: { index: number; oldLen: number; next: string }[] = [
    { index: statusMatch.index, oldLen: statusMatch[0].length, next: statusNext },
  ];
  if (byMatch) edits.push({ index: byMatch.index, oldLen: byMatch[0].length, next: `${byMatch[1]}${trimmedBy}` });
  if (onMatch) edits.push({ index: onMatch.index, oldLen: onMatch[0].length, next: `${onMatch[1]}${ratifiedOn}` });
  edits.sort((a, b) => b.index - a.index);

  let updatedInner = inner;
  for (const edit of edits) {
    updatedInner = updatedInner.slice(0, edit.index) + edit.next + updatedInner.slice(edit.index + edit.oldLen);
  }

  const content = raw.slice(0, range.innerStart) + updatedInner + raw.slice(range.innerEnd);
  return { ok: true, content, changed: true };
}

export type RunRatifyResult =
  | { ok: true; path: string; changed: boolean }
  | { ok: false; message: string };

/**
 * Resolves `sliceKey` to its bound doc via the same note-binding join `mark-implemented`/
 * `--slice-ready`/`em export` use (MIL-121 cross-binding included), then reads/applies/writes
 * it. `baseDir` is the `.em` file's directory, same convention every doc/note path in `em` uses.
 */
export function runRatify(
  model: NormalizedModel,
  refs: RefsResult,
  baseDir: string,
  sliceKey: string,
  ratifiedBy: string,
  ratifiedOn: string,
): RunRatifyResult {
  const sliceIndex = refs.sliceKeys.indexOf(sliceKey);
  if (sliceIndex === -1) {
    return { ok: false, message: `no slice with export key "${sliceKey}" in this model` };
  }
  const slice = model.slices[sliceIndex];
  const { doc } = resolveSliceDocJoin(slice, sliceKey, baseDir, (id) => refs.refById.get(id)!);

  if (doc.reason === "no-doc-bound") {
    return {
      ok: false,
      message: `slice "${sliceKey}" has no doc bound via \`note "slices/${sliceKey}.md"\` — bind a slice doc before ratifying it`,
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
  const result = applyRatifyFrontmatter(raw, ratifiedBy, ratifiedOn);
  if (!result.ok) {
    return { ok: false, message: `${doc.path}: ${result.message}` };
  }
  if (result.changed) {
    writeFileSync(absPath, result.content, "utf8");
  }
  return { ok: true, path: doc.path, changed: result.changed };
}
