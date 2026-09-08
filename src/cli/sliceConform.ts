// SPDX-License-Identifier: MIT
// `em slice conform` (MIL-214): the per-slice-per-version certification act — "a conform sweep
// walked THIS version of this slice's code, against target-repo revision R, and found nothing
// left unruled." Nothing wrote this before now: `implementedIn` only ever said "code exists
// somewhere for this slice," never "the code that's there was actually checked against version N
// of this doc" — the gap the whole engagement (MIL-214) exists to close. Sets exactly three
// frontmatter fields — `conformedVersion: <doc.version>`, `conformedAt: <rev>`,
// `conformedOn: <local date>` — on the slice doc resolved from the key via the SAME note-binding
// resolution `ratify`/`reratify`/`mark-implemented`/`em export` use (catalog/docJoin.ts's
// resolveSliceDocJoin).
//
// Write strategy: the same surgical index-math splicing ratify.ts/markImplemented.ts use, via
// the shared primitives in ./frontmatterSurgery.js — never a parse+re-serialize. New fields are
// inserted directly after `implementedIn:` (the anchor this ticket's ruling names) when none of
// the three exist yet; an existing triple is edited in place. Everything else — the body,
// `version:` itself (read, never written), `status:`, lineage/`covers` keys, and (best-effort)
// the file's own line-ending style — is copied through verbatim.
//
// Preconditions (the owner's ruling, MIL-214):
//  - Legal only for `status: implemented` — a slice that hasn't shipped has no code to certify.
//  - Refuses when there's no `implementedIn:` link at all (the OLD, pre-MIL-214
//    driftSignal-would-be-"in-sync" precondition, computed directly from status+implementedIn
//    here rather than via classifyImplementationDrift — that function is now conformedVersion-
//    aware, so calling it here would always read "uncertified" before the first-ever certify and
//    make this command permanently refuse itself).
//  - Idempotent on the SAME (conformedVersion, conformedAt) pair — re-running with the exact
//    triple already recorded is a no-op, `conformedOn` untouched. A DIFFERENT `--at` (a
//    re-certification at a later revision — "legal and common," the ruling's words) simply
//    OVERWRITES rather than refusing/needing a `--force` escape hatch: `em` has no way to tell
//    "later" from "earlier" for an arbitrary target-repo revision string without walking that
//    repo's git history, which this pure, fs-scoped command never does.
//  - Refuses a continuation key (MIL-208 pattern) — no doc of its own to flip.
//  - Refuses when the newest `conformance/*-findings.json` beside this model whose `revision`
//    equals `--at` still has an unruled finding (`locus: null`) in scope for this slice —
//    the whole point (docs the code was never fully certified, so bumping/certifying past it
//    would be exactly the sequencing bug MIL-214 exists to close). `--skip-findings-check`
//    escapes with a loud notice, never silently.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { continuationOf } from "../model/continuation.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";
import { fieldLineRegex, locateFrontmatterInner, normalizeFieldValue } from "./frontmatterSurgery.js";
import { isValidDateString } from "./stateFile.js";
import { FindingsDoc, listAllFindingsFiles, unruledFindingsInScope } from "./findings.js";

export type ApplyConformResult =
  | { ok: true; content: string; changed: boolean; version: number }
  | { ok: false; message: string };

/**
 * Pure text transform: reads the CURRENT `version:` value (never writes it) and writes
 * `conformedVersion:`/`conformedAt:`/`conformedOn:` in `raw`'s frontmatter block. See module
 * header for the full precondition/idempotency contract. No fs access — the caller reads/writes;
 * see `runSliceConform` below.
 */
export function applyConformFrontmatter(raw: string, sliceKey: string, at: string, on: string): ApplyConformResult {
  const trimmedAt = at.trim();
  if (!trimmedAt) return { ok: false, message: "a target-repo revision is required (--at)" };
  if (/[\x00-\x1f\x7f\s]/.test(trimmedAt)) {
    return { ok: false, message: "revision (--at) must not contain control characters or whitespace" };
  }
  if (!isValidDateString(on)) {
    return { ok: false, message: `invalid date "${on}" — expected YYYY-MM-DD` };
  }

  const range = locateFrontmatterInner(raw);
  if (!range) return { ok: false, message: "no frontmatter block found" };
  const inner = raw.slice(range.innerStart, range.innerEnd);

  const statusMatch = fieldLineRegex("status").exec(inner);
  if (!statusMatch) return { ok: false, message: "no `status:` field found in frontmatter" };
  const currentStatus = normalizeFieldValue(statusMatch[2])?.toLowerCase() ?? null;
  if (currentStatus !== "implemented") {
    return {
      ok: false,
      message:
        `slice "${sliceKey}" is \`status: ${currentStatus ?? "(empty)"}\` — only a slice at ` +
        "`status: implemented` can be certified; run `em slice mark-implemented` first",
    };
  }

  const implMatch = fieldLineRegex("implementedIn").exec(inner);
  const currentImplementedIn = implMatch ? normalizeFieldValue(implMatch[2]) : null;
  if (currentImplementedIn === null) {
    return {
      ok: false,
      message: `slice "${sliceKey}" has \`status: implemented\` but no \`implementedIn:\` link — nothing to certify against`,
    };
  }

  const versionMatch = fieldLineRegex("version").exec(inner);
  const currentVersionRaw = versionMatch ? normalizeFieldValue(versionMatch[2]) : null;
  const version = currentVersionRaw !== null ? Number(currentVersionRaw) : NaN;
  if (!Number.isInteger(version) || version < 1) {
    return { ok: false, message: `doc's \`version:\` value "${currentVersionRaw ?? ""}" isn't a positive integer — refusing to certify` };
  }

  const cvMatch = fieldLineRegex("conformedVersion").exec(inner);
  const caMatch = fieldLineRegex("conformedAt").exec(inner);
  const coMatch = fieldLineRegex("conformedOn").exec(inner);
  const currentConformedVersion = cvMatch ? normalizeFieldValue(cvMatch[2]) : null;
  const currentConformedAt = caMatch ? normalizeFieldValue(caMatch[2]) : null;

  // Idempotent on the (conformedVersion, conformedAt) pair — see module header. `conformedOn` is
  // deliberately excluded from the identity check: it's a timestamp, not provenance identity the
  // way ratifiedBy/ratifiedOn's PAIR is for ratify (there, either differing refuses; here, only
  // the (version, revision) pair is the thing that must not silently change without the caller
  // noticing — a same-day-different-time rerun is not a conflict).
  if (currentConformedVersion === String(version) && currentConformedAt === trimmedAt) {
    return { ok: true, content: raw, changed: false, version };
  }

  // Match the file's own line-ending style for any freshly-inserted line — same trick
  // ratify.ts/markImplemented.ts use.
  const afterImpl = inner.slice(implMatch!.index + implMatch![0].length);
  const eol = afterImpl.startsWith("\r\n") ? "\r\n" : "\n";

  const missingLines: string[] = [];
  if (!cvMatch) missingLines.push(`conformedVersion: ${version}`);
  if (!caMatch) missingLines.push(`conformedAt: ${trimmedAt}`);
  if (!coMatch) missingLines.push(`conformedOn: ${on}`);
  const implNext = missingLines.length > 0 ? `${implMatch![0]}${eol}${missingLines.join(eol)}` : null;

  const edits: { index: number; oldLen: number; next: string }[] = [];
  if (implNext !== null) edits.push({ index: implMatch!.index, oldLen: implMatch![0].length, next: implNext });
  if (cvMatch) edits.push({ index: cvMatch.index, oldLen: cvMatch[0].length, next: `${cvMatch[1]}${version}` });
  if (caMatch) edits.push({ index: caMatch.index, oldLen: caMatch[0].length, next: `${caMatch[1]}${trimmedAt}` });
  if (coMatch) edits.push({ index: coMatch.index, oldLen: coMatch[0].length, next: `${coMatch[1]}${on}` });
  edits.sort((a, b) => b.index - a.index);

  let updatedInner = inner;
  for (const edit of edits) {
    updatedInner = updatedInner.slice(0, edit.index) + edit.next + updatedInner.slice(edit.index + edit.oldLen);
  }

  const content = raw.slice(0, range.innerStart) + updatedInner + raw.slice(range.innerEnd);
  return { ok: true, content, changed: true, version };
}

/** Scan `<baseDir>/conformance/*-findings.json`, newest filename first, for the first one whose
 *  `revision` matches `at` — the "newest findings JSON whose revision == --at" the ruling
 *  describes. A malformed candidate is silently skipped (not refused): this is a best-effort
 *  lookup for the findings-check gate below, not itself a validator — `em conform-findings
 *  check` is where a broken findings file gets a loud diagnosis. Returns null when the
 *  `conformance/` directory doesn't exist, or no candidate matches `at`. */
export function findLatestFindingsForRevision(baseDir: string, at: string): { path: string; doc: FindingsDoc } | null {
  return listAllFindingsFiles(baseDir).find((f) => f.doc.revision === at) ?? null;
}

export type RunSliceConformResult =
  | {
      ok: true;
      path: string;
      changed: boolean;
      version: number;
      /** Non-null exactly when `--skip-findings-check` is what let this certification through —
       *  the finding ids that were still unruled, for the caller's loud notice. `null` whenever
       *  the findings-check gate passed on its own merits (no findings file for this revision, or
       *  nothing unruled in scope), whether or not the flag was passed. */
      skippedFindingsCheck: number[] | null;
    }
  | { ok: false; message: string };

/**
 * Resolves `sliceKey` to its bound doc via the same note-binding join `ratify`/`reratify`/
 * `mark-implemented`/`em export` use (MIL-121 cross-binding included), runs the findings-check
 * gate, then reads/applies/writes it. `baseDir` is the `.em` file's directory, same convention
 * every doc/note path in `em` uses.
 */
export function runSliceConform(
  model: NormalizedModel,
  refs: RefsResult,
  baseDir: string,
  sliceKey: string,
  at: string,
  on: string,
  skipFindingsCheck = false,
): RunSliceConformResult {
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

  // MIL-208: see ratify.ts's runRatify — a continuation slice has no doc of its own to certify.
  if (continuationOfKey) {
    const continuation = continuationOf(model, refs, sliceIndex)!;
    const viewName = model.byId.get(continuation.viewLogicalId)!.name;
    return {
      ok: false,
      message:
        `"${sliceKey}" is a continuation of "${continuationOfKey}" (view "${viewName}" again) — ` +
        `it has no doc of its own; conform "${continuationOfKey}" instead`,
    };
  }

  if (doc.reason === "no-doc-bound") {
    return {
      ok: false,
      message: `slice "${sliceKey}" has no doc bound via \`note "slices/${sliceKey}.md"\` — bind a slice doc before certifying it`,
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

  const found = findLatestFindingsForRevision(baseDir, at);
  let skippedFindingsCheck: number[] | null = null;
  if (found) {
    const unruled = unruledFindingsInScope(found.doc.findings, new Set([sliceKey]));
    if (unruled.length > 0) {
      if (!skipFindingsCheck) {
        return {
          ok: false,
          message:
            `slice "${sliceKey}" has ${unruled.length} unruled conformance finding(s) in ${found.path} ` +
            `(id ${unruled.map((f) => f.id).join(", ")}) — rule on them (\`em conform-supersede --locus --by\`) ` +
            "or pass --skip-findings-check to certify anyway",
        };
      }
      skippedFindingsCheck = unruled.map((f) => f.id);
    }
  }

  const absPath = join(baseDir, doc.path);
  const raw = readFileSync(absPath, "utf8");
  const result = applyConformFrontmatter(raw, sliceKey, at, on);
  if (!result.ok) {
    return { ok: false, message: `${doc.path}: ${result.message}` };
  }
  if (result.changed) {
    writeFileSync(absPath, result.content, "utf8");
  }
  return { ok: true, path: doc.path, changed: result.changed, version: result.version, skippedFindingsCheck };
}
