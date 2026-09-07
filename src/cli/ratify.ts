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
//
// MIL-201 — the review gate: ratification is the SECOND of two human gates, and this command now
// refuses a doc that never passed through the first one (`status: reviewed`, written by
// `em slice review`). `ready-to-implement` stays legal because it covers both the idempotent
// re-run and the post-`reratify` path: `em slice reratify` clears `ratifiedBy`/`ratifiedOn` (and
// `reviewedBy`/`reviewedOn`) and leaves the doc at `ready-to-implement`, so the follow-up
// `ratify --by` for the new version needs no fresh review session. `--skip-review` is the
// explicit, auditable escape hatch — it prints a loud one-line notice on stderr and writes
// nothing about the skip into the file. Never clears `reviewedBy`/`reviewedOn`: the review record
// is provenance for the version being ratified, not something ratification consumes.
//
// MIL-198 — the upstream-timeline advisory: the review/ratify gates above are about THIS slice's
// own doc; they say nothing about whether the slices it depends on (earlier on the timeline,
// per the modeling discipline in event-modeling-design/SKILL.md) are themselves far enough
// along. Ratifying "ahead of" an unratified upstream producer isn't wrong — sometimes the team
// deliberately works out of order — so this is advisory only and never refuses. `runRatify`
// walks the query index's `in` adjacency one hop from every element in the ratifying slice to
// find producing elements that live in OTHER slices (an upstream producer in the SAME slice
// isn't a cross-slice dependency), dedupes by upstream slice, sorts by timeline position, and
// reports any whose doc isn't `ready-to-implement`/`implemented` yet. Repeated-view instance
// hops (`view X again`) are never edges in `ModelIndex.out`/`.in` (queryIndex.ts's own design
// note), so they never surface here either — nothing extra to filter.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { continuationOf } from "../model/continuation.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";
import { buildModelIndex } from "../model/queryIndex.js";
import { fieldLineRegex, locateFrontmatterInner, normalizeFieldValue } from "./frontmatterSurgery.js";
import { REVIEWED_STATUS } from "./review.js";
import { isValidDateString } from "./stateFile.js";

/** The status this command flips a slice doc to — the handoff gate
 *  (docs/process.md#the-slice-lifecycle-gates): contracts/invariants agreed, open questions
 *  resolved or deferred, ready for an implementing agent or engineer to pick up. */
export const RATIFIED_STATUS = "ready-to-implement";

/** The statuses the review gate (MIL-201) lets through without `--skip-review`: `reviewed` (the
 *  ordinary path — `em slice review` recorded a review session) and `ready-to-implement` (the
 *  idempotent re-run, and the post-`reratify` path — see the module header). */
const RATIFIABLE_STATUSES: readonly string[] = [REVIEWED_STATUS, RATIFIED_STATUS];

/** Doc statuses an upstream producing slice can hold without triggering MIL-198's advisory —
 *  the two statuses that mean "this slice's contract is settled enough to build against". */
const UPSTREAM_SETTLED_STATUSES: readonly string[] = [RATIFIED_STATUS, "implemented"];

/** One upstream producing slice (in timeline order earlier than the slice being ratified) whose
 *  doc hasn't reached `ready-to-implement`/`implemented` yet. `status` is the doc's own status
 *  string, or the literal `"no doc"` when no doc is bound/found for that slice at all. */
export interface UpstreamUnratifiedSlice {
  sliceKey: string;
  status: string;
}

/**
 * MIL-198 (ruling R5): for every element in the `sliceKey` slice, walks the query index's `in`
 * adjacency one hop to find producing elements that live in OTHER slices (a producer in the SAME
 * slice isn't a cross-slice dependency), dedupes by upstream slice, and reports every upstream
 * slice whose doc status isn't `ready-to-implement`/`implemented` — sorted by the upstream
 * slice's position on the timeline (`Slice.index`), so the advisory itself reads in the order the
 * team should catch up in. Advisory data only: never refuses, callers decide whether/how to print
 * it. An unknown `sliceKey` (shouldn't happen — the caller already resolved it) yields `[]`
 * rather than throwing.
 */
export function upstreamUnratifiedSlices(
  model: NormalizedModel,
  refs: RefsResult,
  baseDir: string,
  sliceKey: string,
): UpstreamUnratifiedSlice[] {
  const sliceIndex = refs.sliceKeys.indexOf(sliceKey);
  if (sliceIndex === -1) return [];
  const slice = model.slices[sliceIndex];
  const index = buildModelIndex(model, refs, baseDir);

  const upstreamSliceIndexes = new Set<number>();
  for (const el of slice.elements) {
    const ref = refs.refById.get(el.id);
    if (!ref) continue;
    for (const edge of index.in.get(ref) ?? []) {
      const producer = index.byRef.get(edge.ref);
      if (!producer || producer.sliceIndex === sliceIndex) continue;
      upstreamSliceIndexes.add(producer.sliceIndex);
    }
  }

  const results: UpstreamUnratifiedSlice[] = [];
  for (const upstreamIndex of [...upstreamSliceIndexes].sort((a, b) => a - b)) {
    const upstreamKey = refs.sliceKeys[upstreamIndex];
    const status = index.sliceFacts.get(upstreamKey)?.doc.status ?? null;
    if (status !== null && UPSTREAM_SETTLED_STATUSES.includes(status)) continue;
    results.push({ sliceKey: upstreamKey, status: status ?? "no doc" });
  }
  return results;
}

export type ApplyRatifyResult =
  | {
      ok: true;
      content: string;
      changed: boolean;
      /** The doc's status BEFORE the edit, when `--skip-review` is what let this ratification
       *  through (i.e. the review gate would otherwise have refused) — `null` whenever the gate
       *  passed on its own merits, so the caller prints the skip notice exactly when the flag
       *  actually did something. */
      skippedReviewFrom: string | null;
    }
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
 *
 * MIL-201: after that idempotency check, refuses any doc whose status isn't `reviewed` or
 * `ready-to-implement` unless `skipReview` is set — the review gate. `sliceKey` appears only in
 * that refusal message (and in the caller's skip notice); every other refusal here is about the
 * doc's own text. No fs access — the caller reads/writes; see `runRatify` below.
 */
export function applyRatifyFrontmatter(
  raw: string,
  sliceKey: string,
  ratifiedBy: string,
  ratifiedOn: string,
  skipReview = false,
): ApplyRatifyResult {
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
      return { ok: true, content: raw, changed: false, skippedReviewFrom: null }; // idempotent no-op
    }
    return {
      ok: false,
      message:
        `already ratified by ${currentBy} on ${currentOn} — refusing to overwrite with ` +
        `${trimmedBy} on ${ratifiedOn}`,
    };
  }

  // The review gate (MIL-201, D1). A doc that never passed through `status: reviewed` has not
  // been through the first human gate, so ratifying it collapses two decisions into one — the
  // exact failure this refusal exists to prevent. `--skip-review` is the deliberate, visible
  // escape hatch, not a silent bypass: the caller prints a notice naming the status it skipped.
  const gateStatus = currentStatus ?? "(empty)";
  const gateWouldRefuse = currentStatus === null || !RATIFIABLE_STATUSES.includes(currentStatus);
  if (gateWouldRefuse && !skipReview) {
    return {
      ok: false,
      message:
        `slice "${sliceKey}" is \`status: ${gateStatus}\` — the review gate comes first: run ` +
        "`em slice review <file> <key> --by <name>` after the review session, or pass " +
        "--skip-review to ratify without one",
    };
  }
  const skippedReviewFrom = gateWouldRefuse ? gateStatus : null;

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
  return { ok: true, content, changed: true, skippedReviewFrom };
}

export type RunRatifyResult =
  | {
      ok: true;
      path: string;
      changed: boolean;
      skippedReviewFrom: string | null;
      /** MIL-198's upstream-timeline advisory — see `upstreamUnratifiedSlices` above. Always
       *  computed once the gate has passed (whether or not `--skip-review` is what let it
       *  through), never gates the ratification itself. */
      upstreamWarnings: UpstreamUnratifiedSlice[];
    }
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
  skipReview = false,
): RunRatifyResult {
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

  // MIL-208: a continuation slice (an again-view-only slice with no legacy doc of its own) has
  // no status/ratification of its own to flip — refuse rather than silently mutating the
  // ORIGINATING slice's doc under this key's name. `doc.continuationOf` is already the
  // "legacy own doc wins" precedence applied (see docJoin.ts): a continuation slice that still
  // carries its own doc is NOT refused here — that's the migration path, flagged instead by the
  // `continuation-has-own-doc` warning.
  if (continuationOfKey) {
    const continuation = continuationOf(model, refs, sliceIndex)!;
    const viewName = model.byId.get(continuation.viewLogicalId)!.name;
    return {
      ok: false,
      message:
        `"${sliceKey}" is a continuation of "${continuationOfKey}" (view "${viewName}" again) — ` +
        `it has no doc of its own; ratify "${continuationOfKey}" instead`,
    };
  }

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
  const result = applyRatifyFrontmatter(raw, sliceKey, ratifiedBy, ratifiedOn, skipReview);
  if (!result.ok) {
    return { ok: false, message: `${doc.path}: ${result.message}` };
  }
  // MIL-198: computed once the gate above has passed, before the write — advisory only, so it
  // runs the same whether the gate passed on its own merits or via --skip-review.
  const upstreamWarnings = upstreamUnratifiedSlices(model, refs, baseDir, sliceKey);
  if (result.changed) {
    writeFileSync(absPath, result.content, "utf8");
  }
  return {
    ok: true,
    path: doc.path,
    changed: result.changed,
    skippedReviewFrom: result.skippedReviewFrom,
    upstreamWarnings,
  };
}
