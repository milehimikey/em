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
// MIL-258: that is the SHIPPED path. A second path covers a doc at `status: ready-to-implement`
// that still carries `ratifiedBy:` — a ratified version that has not shipped (the most common
// change during delivery: an implementer hits a gap, a human answers it, the doc changes before
// the build resumes). It bumps `version:` and clears the same four sign-off fields but leaves
// `status:` (and any `implementedIn:`) alone, since there is nothing to flip back. A
// `ready-to-implement` doc with NO `ratifiedBy:` still refuses: that is the exact state a
// reratify leaves a doc in, so refusing keeps the double-bump guard — the doc is awaiting
// `em slice ratify --by`, not another bump. `draft`/`reviewed` docs are not ratified and refuse
// too; they can simply be edited.
//
// Shipped path precondition (original, MIL-161) — a doc currently `status: implemented`, the precondition
// docs/slice-doc-schema.md#status-under-re-ratification describes ("a new version is ratified
// for a slice whose previous version already shipped"). Refuses (never guesses) otherwise: a
// `draft`/`reviewed` doc hasn't shipped yet, so there's no prior version to bump FROM, and a
// doc already `ready-to-implement` WITHOUT `ratifiedBy:` means either first-time authoring (never
// touch this doc with reratify at all — `em slice new` is what scaffolds those) or a reratify
// that already ran (a second bump would silently double-increment `version`, which this command
// deliberately never does — bumping isn't naturally idempotent the way ratify/mark-implemented's
// absolute-value writes are).
//
// Also clears `ratifiedBy:`/`ratifiedOn:` if either is present: those fields record who signed
// off the PRIOR version (`em slice ratify`, MIL-165) and describing the brand-new, not-yet-
// reviewed version as already ratified by the old signer would be actively misleading. Clearing
// them (rather than leaving them stale) is also what lets a subsequent `em slice ratify --by
// <name>` apply cleanly afterward — ratify's own idempotent-refusal guard would otherwise read
// the leftover prior ratifiedBy/ratifiedOn as "already ratified by someone else" and refuse.
//
// MIL-201: `reviewedBy:`/`reviewedOn:` are cleared for the same reason and in the same sweep. The
// review record describes the version that shipped, not the new one — a re-ratified version needs
// no fresh review session (the doc lands at `ready-to-implement`, which `em slice ratify`'s review
// gate accepts), but leaving the old review in place would claim the room walked a version it has
// never seen.
//
// Write strategy: the same surgical index-math splicing markImplemented.ts/ratify.ts use, via
// the shared primitives in ./frontmatterSurgery.js — never a parse+re-serialize. Everything
// outside the edited value spans — the body, `implementedIn:`, the lineage/`covers` keys, and
// (best-effort) the file's own line-ending style — is copied through verbatim. The `## Delta`
// section (docs/slice-doc-schema.md#delta-section-grammar-and-lifecycle) recording WHAT changed
// stays entirely hand-authored — this command only ever touches the two lifecycle fields above.
//
// MIL-214: `reratifyAdvisory` below is the certification-aware counterpart to MIL-198's
// upstream-timeline advisory (ratify.ts's `upstreamUnratifiedSlices`) — same shape, same
// never-refuses stance. Bumping a version whose CURRENT one was never certified (or still has
// unruled conformance findings) isn't wrong — the team may have good reason to move on before a
// conform sweep ever ran — so this is advisory only, printed by the CLI layer, never gating the
// bump itself. MIL-258: the advisory is about superseding a SHIPPED version, so the unshipped
// path skips it entirely (`advisory: null`) — an unshipped version has no certification to lack.

//
// MIL-238: `meaningConfirmed:`/`contractChange:` describe the PRIOR version too, so they are
// cleared in the same sweep as the sign-off keys. On a public-touching slice the bump itself
// requires a fresh confirmation (`--meaning-unchanged` or `--contract-change "<why>"`), written
// directly after the new `version:` line; on any other slice either flag is accepted and recorded.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { continuationOf } from "../model/continuation.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";
import { fieldLineRegex, fieldLineWithEolRegex, locateFrontmatterInner, normalizeFieldValue } from "./frontmatterSurgery.js";
import { listAllFindingsFiles, unruledFindingsInScope } from "./findings.js";
import {
  MeaningConfirmation,
  MEANING_CONFIRMATION_KEYS,
  meaningConfirmationLine,
  meaningConfirmationRequiredMessage,
} from "./ratify.js";
import { isPublicTouchingSlice } from "../catalog/apiFirst.js";

/** The status a doc must already be in for `reratify` to apply — mirrors `RATIFIED_STATUS` in
 *  ratify.ts (the status this command flips TO), named separately since it's the precondition
 *  here, not the target. */
const IMPLEMENTED_STATUS = "implemented";
const TARGET_STATUS = "ready-to-implement";

export type ApplyReratifyResult =
  | { ok: true; content: string; newVersion: number; kind: ReratifyKind }
  | { ok: false; message: string };

/** MIL-258: `shipped` = the doc was `status: implemented` (status flips back); `unshipped` = a
 *  ratified `ready-to-implement` doc that never shipped (status untouched). */
export type ReratifyKind = "shipped" | "unshipped";

/**
 * Pure text transform: bumps `version:` by 1 and flips `status:` to `ready-to-implement` in
 * `raw`'s frontmatter block, clearing any `ratifiedBy:`/`ratifiedOn:` lines found (see module
 * header). Refuses (`ok: false`) unless the doc's CURRENT `status:` is `implemented`, or
 * `ready-to-implement` with `ratifiedBy:` set (MIL-258, `kind: "unshipped"`, status left alone) —
 * see module header for why this precondition (not idempotent-no-op) is the right refusal
 * shape here. No fs access — the caller reads/writes; see `runReratify` below.
 */
export function applyReratifyFrontmatter(raw: string, confirmation: MeaningConfirmation | null = null): ApplyReratifyResult {
  const range = locateFrontmatterInner(raw);
  if (!range) return { ok: false, message: "no frontmatter block found" };
  const inner = raw.slice(range.innerStart, range.innerEnd);

  const statusMatch = fieldLineRegex("status").exec(inner);
  if (!statusMatch) return { ok: false, message: "no `status:` field found in frontmatter" };
  const currentStatus = normalizeFieldValue(statusMatch[2])?.toLowerCase() ?? null;
  let kind: ReratifyKind = "shipped";
  if (currentStatus !== IMPLEMENTED_STATUS) {
    const ratifiedByMatch = fieldLineRegex("ratifiedBy").exec(inner);
    const hasRatifiedBy = ratifiedByMatch !== null && normalizeFieldValue(ratifiedByMatch[2]) !== null;
    if (currentStatus === TARGET_STATUS && hasRatifiedBy) {
      kind = "unshipped";
    } else if (currentStatus === TARGET_STATUS) {
      return {
        ok: false,
        message:
          "doc is `status: ready-to-implement` with no `ratifiedBy:` — it is awaiting ratification " +
          "(a reratify already ran, or it was never signed off), so another version bump would " +
          "double-increment `version:`; record the sign-off with `em slice ratify --by <name>`",
      };
    } else {
      return {
        ok: false,
        message:
          `doc is \`status: ${currentStatus ?? "(empty)"}\` — reratify only applies to a slice doc that has ` +
          "shipped (`status: implemented`) or to a ratified `ready-to-implement` doc that has not (see " +
          "docs/slice-doc-schema.md#status-under-re-ratification); a `draft`/`reviewed` doc is not ratified " +
          "and can simply be edited, and first-time authoring uses `em slice new`",
      };
    }
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

  // Clear stale ratifiedBy:/ratifiedOn:/reviewedBy:/reviewedOn: — see module header — and
  // (MIL-238) the prior version's meaningConfirmed:/contractChange:. Done FIRST, on the original
  // text, so the fresh confirmation line spliced in after `version:` below is never swept away.
  // These keys are disjoint from `status:`/`version:` by construction (fieldLineRegex matches one
  // key at a time), so the two lines are re-located on the cleared text unchanged.
  let cleared = inner;
  for (const key of ["ratifiedBy", "ratifiedOn", "reviewedBy", "reviewedOn", ...MEANING_CONFIRMATION_KEYS]) {
    cleared = cleared.replace(fieldLineWithEolRegex(key), "");
  }
  const clearedStatus = fieldLineRegex("status").exec(cleared)!;
  const clearedVersion = fieldLineRegex("version").exec(cleared)!;
  const afterVersion = cleared.slice(clearedVersion.index + clearedVersion[0].length);
  const eol = afterVersion.startsWith("\r\n") ? "\r\n" : "\n";
  const versionNext = `${clearedVersion[1]}${newVersion}`;

  // Apply from the highest index first so an earlier edit's index stays valid — same convention
  // markImplemented.ts/ratify.ts use.
  const edits = [
    // MIL-258: the unshipped path is already at the target status — nothing to flip.
    ...(kind === "shipped"
      ? [{ index: clearedStatus.index, oldLen: clearedStatus[0].length, next: `${clearedStatus[1]}${TARGET_STATUS}` }]
      : []),
    {
      index: clearedVersion.index,
      oldLen: clearedVersion[0].length,
      next: confirmation ? `${versionNext}${eol}${meaningConfirmationLine(confirmation)}` : versionNext,
    },
  ].sort((a, b) => b.index - a.index);
  let updatedInner = cleared;
  for (const edit of edits) {
    updatedInner = updatedInner.slice(0, edit.index) + edit.next + updatedInner.slice(edit.index + edit.oldLen);
  }

  const content = raw.slice(0, range.innerStart) + updatedInner + raw.slice(range.innerEnd);
  return { ok: true, content, newVersion, kind };
}

/** MIL-214: the certification-aware advisory `runReratify` computes about the version being
 *  superseded — never gates the bump, see module header. */
export interface ReratifyAdvisory {
  /** True when the CURRENT (pre-bump) version has no matching `conformedVersion` — either never
   *  certified at all, or certified against a different version. */
  neverCertified: boolean;
  /** Count of unruled (`locus: null`) conformance findings in scope for this slice, across every
   *  `conformance/*-findings.json` beside the model — not scoped to one revision, since a
   *  reratify has no `--at` of its own to anchor on. */
  unruledFindingsCount: number;
}

/** Pure: the two facts `runReratify`'s advisory reports, from the doc's own pre-bump
 *  `version`/`conformedVersion` plus a scan of every findings file beside the model — see
 *  `ReratifyAdvisory`. No refusal here or anywhere downstream; this is data for the CLI layer to
 *  print as `warn:` lines. */
export function reratifyAdvisory(
  baseDir: string,
  sliceKey: string,
  currentVersion: number | null,
  conformedVersion: number | null,
): ReratifyAdvisory {
  const neverCertified = conformedVersion === null || conformedVersion !== currentVersion;
  let unruledFindingsCount = 0;
  for (const { doc } of listAllFindingsFiles(baseDir)) {
    unruledFindingsCount += unruledFindingsInScope(doc.findings, new Set([sliceKey])).length;
  }
  return { neverCertified, unruledFindingsCount };
}

export type RunReratifyResult =
  | { ok: true; path: string; newVersion: number; kind: ReratifyKind; advisory: ReratifyAdvisory | null }
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
  confirmation: MeaningConfirmation | null = null,
): RunReratifyResult {
  const sliceIndex = refs.sliceKeys.indexOf(sliceKey);
  if (sliceIndex === -1) {
    return { ok: false, message: `no slice with export key "${sliceKey}" in this model` };
  }
  const slice = model.slices[sliceIndex];
  const { doc, continuationOf: continuationOfKey } = resolveSliceDocJoin(
    model,
    refs,
    slice,
    sliceKey,
    baseDir,
    (id) => refs.refById.get(id)!,
  );

  // MIL-208: see runRatify's own comment — a continuation slice has no status of its own.
  if (continuationOfKey) {
    const continuation = continuationOf(model, refs, sliceIndex)!;
    const viewName = model.byId.get(continuation.viewLogicalId)!.name;
    return {
      ok: false,
      message:
        `"${sliceKey}" is a continuation of "${continuationOfKey}" (view "${viewName}" again) — ` +
        `it has no doc of its own; reratify "${continuationOfKey}" instead`,
    };
  }

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
  const result = applyReratifyFrontmatter(raw, confirmation);
  if (!result.ok) {
    return { ok: false, message: `${doc.path}: ${result.message}` };
  }
  // MIL-238: the API-first gate — after the doc's own preconditions, before any write: a
  // public-touching slice's new version needs a meaning confirmation.
  if (confirmation === null && isPublicTouchingSlice(model, refs, sliceKey)) {
    return { ok: false, message: meaningConfirmationRequiredMessage(sliceKey) };
  }
  // MIL-214: computed from the doc's PRE-BUMP version/certification (`doc` was resolved before
  // the write below changes `version`) — "was the version we're about to supersede ever fully
  // certified". MIL-258: only meaningful for a SHIPPED version; an unshipped one has no
  // certification to lack, so that path carries no advisory at all.
  const advisory =
    result.kind === "shipped" ? reratifyAdvisory(baseDir, sliceKey, doc.version, doc.conformedVersion) : null;
  writeFileSync(absPath, result.content, "utf8");
  return { ok: true, path: doc.path, newVersion: result.newVersion, kind: result.kind, advisory };
}
