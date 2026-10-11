// SPDX-License-Identifier: MIT
// `em slice revise` (MIL-283): open the next version of a slice doc as a real `draft`. This is
// what `em slice reratify` (MIL-161/258, now a deprecated alias) always meant but never did: it
// bumped `version:` and left the doc at `status: ready-to-implement` with the sign-off cleared —
// a status that lied (unsigned), which MIL-258/259 then had to special-case everywhere. Since
// 1.15.0 the shipped version lives in the shipped record (`shippedVersion:`/`shippedRef:`/
// `shippedOn:` + `implementedIn:`, MIL-284 — `shippedRecordOf` in catalog/sliceDoc.ts), so
// `status` is free to say what the WORKING copy is: a draft of v<N+1>, which then takes the same
// two human gates v1 took (`em slice review --by`, `em slice ratify --by`). The MIL-201 carve-out
// that a reratified doc "needs no fresh review session" is gone with the state that needed it.
//
// Three starting states, one target (`status: draft`):
//  - `shipped`   — `status: implemented` (or any status with a shipped record): bump `version:`,
//                  materialise the shipped record if the doc predates 1.15 (so flipping the status
//                  away from `implemented` does not lose the fact that v<N> shipped), clear the
//                  sign-off, re-open the questions deferred to the new version.
//  - `unshipped` — `status: ready-to-implement` WITH `ratifiedBy:` (ratified, never shipped — the
//                  implementer hit a gap, the doc must change): bump `version:`, clear the
//                  sign-off. The ratification of v<N> is withdrawn; v<N> never shipped.
//  - `unsigned`  — `status: ready-to-implement` with NO `ratifiedBy:`: the 1.13.1–1.14.x reratify
//                  leftover. Nothing was signed at this version, so `version:` stays and only the
//                  status moves — the exit path for a doc stuck in a state that no longer exists.
//  - `draft`/`reviewed` refuse: the next version is already open; just edit it.
//
// Sign-off keys cleared: `ratifiedBy`/`ratifiedOn`/`ratifiedRef`/`ratifiedHash` (MIL-165/284),
// `reviewedBy`/`reviewedOn` (MIL-201), `meaningConfirmed`/`contractChange` (MIL-238) — every one
// describes the version being left behind. `implementedIn:`, the `shipped*` keys and the
// `conformed*` keys stay: they describe the version that shipped, which is still the version in
// production. The API-first confirmation (MIL-238) is no longer taken here — it belongs to the
// ratification of the new version, where `em slice ratify` already requires it on a
// public-touching slice. Never touches the body except to re-open deferred questions (MIL-275).
//
// `em slice mark-implemented` reuses `openNextDraft` to open v<N+1> at merge time when a question
// is deferred to it (MIL-283's "the draft is ready for continued work"), and only then — a
// merged slice with nothing deferred stays `implemented` until someone runs this command.
//
// Write strategy: surgical splices over the frontmatter text (frontmatterSurgery.ts), same as
// every other lifecycle writer; the body is copied through verbatim.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { continuationOf } from "../model/continuation.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";
import { fieldLineRegex, fieldLineWithEolRegex, locateFrontmatterInner, normalizeFieldValue } from "./frontmatterSurgery.js";
import { listAllFindingsFiles, unruledFindingsInScope } from "./findings.js";
import { MEANING_CONFIRMATION_KEYS } from "./ratify.js";
import { reopenDeferred } from "./defer.js";

const DRAFT_STATUS = "draft";
const RATIFIED_STATUS = "ready-to-implement";
const IMPLEMENTED_STATUS = "implemented";

/** Every key that describes the version being left behind — cleared on every path that bumps. */
export const SIGN_OFF_KEYS: readonly string[] = [
  "ratifiedBy",
  "ratifiedOn",
  "ratifiedRef",
  "ratifiedHash",
  "reviewedBy",
  "reviewedOn",
  ...MEANING_CONFIRMATION_KEYS,
];

/** See the module header. `unsigned` is the only kind that does not bump `version:`. */
export type ReviseKind = "shipped" | "unshipped" | "unsigned";

export type ApplyReviseResult =
  | { ok: true; content: string; newVersion: number; kind: ReviseKind; reopened: number }
  | { ok: false; message: string };

/**
 * Pure: the shipped → draft transition shared by `revise` and `mark-implemented`'s auto-open.
 * Bumps `version:`, writes `shippedVersion:` (and `shippedRef:` from `ratifiedRef:`) when the
 * doc has none yet, flips `status:` to `draft`, clears the sign-off keys and re-opens the
 * questions deferred to the new version. Refuses a doc whose `version:` is not a positive
 * integer. `raw` is the whole doc.
 */
export function openNextDraft(raw: string): ApplyReviseResult {
  return applyRevise(raw, "shipped");
}

/**
 * Pure: classifies the doc's starting state (see module header) and applies the matching
 * transition. Refuses `draft`/`reviewed` (already open) and anything unrecognised.
 */
export function applyReviseFrontmatter(raw: string): ApplyReviseResult {
  const range = locateFrontmatterInner(raw);
  if (!range) return { ok: false, message: "no frontmatter block found" };
  const inner = raw.slice(range.innerStart, range.innerEnd);
  const statusMatch = fieldLineRegex("status").exec(inner);
  if (!statusMatch) return { ok: false, message: "no `status:` field found in frontmatter" };
  const currentStatus = normalizeFieldValue(statusMatch[2])?.toLowerCase() ?? null;
  const shippedVersionMatch = fieldLineRegex("shippedVersion").exec(inner);
  const hasShipped = currentStatus === IMPLEMENTED_STATUS || (shippedVersionMatch !== null && normalizeFieldValue(shippedVersionMatch[2]) !== null);
  const ratifiedByMatch = fieldLineRegex("ratifiedBy").exec(inner);
  const hasRatifiedBy = ratifiedByMatch !== null && normalizeFieldValue(ratifiedByMatch[2]) !== null;

  if (currentStatus === IMPLEMENTED_STATUS) return applyRevise(raw, "shipped");
  if (currentStatus === RATIFIED_STATUS) return applyRevise(raw, hasRatifiedBy ? "unshipped" : "unsigned");
  if (currentStatus === DRAFT_STATUS || currentStatus === "reviewed") {
    return {
      ok: false,
      message:
        `doc is \`status: ${currentStatus}\` — the next version is already open${hasShipped ? " over the shipped one" : ""}; ` +
        "edit it, then `em slice review --by` and `em slice ratify --by` when it is ready",
    };
  }
  return {
    ok: false,
    message:
      `doc is \`status: ${currentStatus ?? "(empty)"}\` — revise applies to a shipped slice doc (\`status: implemented\`) ` +
      "or a ratified `ready-to-implement` doc (see docs/slice-doc-schema.md#status-under-re-ratification)",
  };
}

function applyRevise(raw: string, kind: ReviseKind): ApplyReviseResult {
  const range = locateFrontmatterInner(raw);
  if (!range) return { ok: false, message: "no frontmatter block found" };
  const inner = raw.slice(range.innerStart, range.innerEnd);
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
  const newVersion = kind === "unsigned" ? currentVersion : currentVersion + 1;

  // Materialise the shipped record on a pre-1.15 doc BEFORE the status leaves `implemented`,
  // otherwise `shippedRecordOf`'s read-both rule would forget that v<N> shipped. Inserted right
  // after `implementedIn:` when present (where mark-implemented puts it), else after `version:`.
  let working = inner;
  if (kind === "shipped" && !fieldLineRegex("shippedVersion").exec(working)) {
    const refMatch = fieldLineRegex("ratifiedRef").exec(working);
    const ref = refMatch ? normalizeFieldValue(refMatch[2]) : null;
    const lines = [`shippedVersion: ${currentVersion}`, ...(ref !== null ? [`shippedRef: ${ref}`] : [])];
    const anchor = fieldLineRegex("implementedIn").exec(working) ?? fieldLineRegex("version").exec(working)!;
    const after = working.slice(anchor.index + anchor[0].length);
    const eol = after.startsWith("\r\n") ? "\r\n" : "\n";
    working = working.slice(0, anchor.index) + anchor[0] + eol + lines.join(eol) + after;
  }

  // Clear the sign-off keys (nothing to clear on the unsigned path, but harmless). Done before
  // re-locating `status:`/`version:`, which these keys are disjoint from by construction.
  let cleared = working;
  if (kind !== "unsigned") {
    for (const key of SIGN_OFF_KEYS) cleared = cleared.replace(fieldLineWithEolRegex(key), "");
  }
  const clearedStatus = fieldLineRegex("status").exec(cleared)!;
  const clearedVersion = fieldLineRegex("version").exec(cleared)!;
  const edits = [
    { index: clearedStatus.index, oldLen: clearedStatus[0].length, next: `${clearedStatus[1]}${DRAFT_STATUS}` },
    { index: clearedVersion.index, oldLen: clearedVersion[0].length, next: `${clearedVersion[1]}${newVersion}` },
  ].sort((a, b) => b.index - a.index);
  let updatedInner = cleared;
  for (const edit of edits) {
    updatedInner = updatedInner.slice(0, edit.index) + edit.next + updatedInner.slice(edit.index + edit.oldLen);
  }
  const content = raw.slice(0, range.innerStart) + updatedInner + raw.slice(range.innerEnd);
  // MIL-275: questions deferred to the version this opens come back as `- [ ]`.
  const reopened = kind === "unsigned" ? { content, count: 0 } : reopenDeferred(content, newVersion);
  return { ok: true, content: reopened.content, newVersion, kind, reopened: reopened.count };
}

/** MIL-214: the certification-aware advisory `runRevise` computes about the shipped version being
 *  left behind — never gates the bump. */
export interface ReviseAdvisory {
  /** True when the shipped version has no matching `conformedVersion` — never certified, or
   *  certified against a different version. */
  neverCertified: boolean;
  /** Unruled (`locus: null`) conformance findings in scope for this slice, across every
   *  `conformance/*-findings.json` beside the model. */
  unruledFindingsCount: number;
}

export function reviseAdvisory(baseDir: string, sliceKey: string, shippedVersion: number | null, conformedVersion: number | null): ReviseAdvisory {
  const neverCertified = conformedVersion === null || conformedVersion !== shippedVersion;
  let unruledFindingsCount = 0;
  for (const { doc } of listAllFindingsFiles(baseDir)) {
    unruledFindingsCount += unruledFindingsInScope(doc.findings, new Set([sliceKey])).length;
  }
  return { neverCertified, unruledFindingsCount };
}

export type RunReviseResult =
  | { ok: true; path: string; newVersion: number; kind: ReviseKind; advisory: ReviseAdvisory | null; reopened: number }
  | { ok: false; message: string };

/**
 * Resolves `sliceKey` to its bound doc via the same note-binding join `mark-implemented`/
 * `ratify`/`--slice-ready`/`em export` use (MIL-121 cross-binding included), then reads/applies/
 * writes it. `baseDir` is the `.em` file's directory.
 */
export function runRevise(model: NormalizedModel, refs: RefsResult, baseDir: string, sliceKey: string): RunReviseResult {
  const sliceIndex = refs.sliceKeys.indexOf(sliceKey);
  if (sliceIndex === -1) return { ok: false, message: `no slice with export key "${sliceKey}" in this model` };
  const slice = model.slices[sliceIndex];
  const { doc, continuationOf: continuationOfKey } = resolveSliceDocJoin(
    model,
    refs,
    slice,
    sliceKey,
    baseDir,
    (id) => refs.refById.get(id)!,
  );
  if (continuationOfKey) {
    const continuation = continuationOf(model, refs, sliceIndex)!;
    const viewName = model.byId.get(continuation.viewLogicalId)!.name;
    return {
      ok: false,
      message:
        `"${sliceKey}" is a continuation of "${continuationOfKey}" (view "${viewName}" again) — ` +
        `it has no doc of its own; revise "${continuationOfKey}" instead`,
    };
  }
  if (doc.reason === "no-doc-bound") {
    return {
      ok: false,
      message: `slice "${sliceKey}" has no doc bound via \`note "slices/${sliceKey}.md"\` — bind a slice doc before revising it`,
    };
  }
  if (doc.reason === "binding-missing-file") {
    return { ok: false, message: `slice "${sliceKey}" notes "${doc.path}" but no such file exists` };
  }
  if (doc.reason === "frontmatter-invalid") {
    return { ok: false, message: `slice doc "${doc.path}" has missing or invalid frontmatter — run \`em validate\` for details` };
  }

  const absPath = join(baseDir, doc.path);
  const raw = readFileSync(absPath, "utf8");
  const result = applyReviseFrontmatter(raw);
  if (!result.ok) return { ok: false, message: `${doc.path}: ${result.message}` };
  // MIL-214: "was the version we are leaving behind ever certified" — only meaningful when one
  // shipped. Computed from the pre-write join.
  const advisory = result.kind === "shipped" ? reviseAdvisory(baseDir, sliceKey, doc.shipped?.version ?? doc.version, doc.conformedVersion) : null;
  writeFileSync(absPath, result.content, "utf8");
  return { ok: true, path: doc.path, newVersion: result.newVersion, kind: result.kind, advisory, reopened: result.reopened };
}
