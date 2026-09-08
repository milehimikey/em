// SPDX-License-Identifier: MIT
// `em model version` (MIL-218, from the MIL-214 discussion): the model-level counterpart to
// `em slice conform`'s per-slice certification. Slices carry their own `version:` and drift
// apart over time; nothing before this named "the model" as a whole. Two facts, kept separate:
//
//  - **Design version** — an explicit, human-bumped integer (`em model version bump --by <name>
//    [--on <date>]`), same identity discipline as `em slice ratify`. Bumps when structure
//    changes (slice added/removed, seam change) or a batch of slice deltas is ratified
//    together.
//  - **Certified version** — "design version N was certified at revision R on date D", written
//    by a full (non-`--partial`) `em state set-conformance` (MIL-214) into the CURRENT design
//    version's manifest. A partial marker never certifies.
//
// Sidecar manifest, not the state file: `model-versions/v<N>.json`, sibling of `slices/` and
// `conformance/` — history, not progress, which is why it's not in `.event-modeling.md` (that
// file only ever carries a POINTER: the `Model version:`/`Certified:` bullets, stateFile.ts).
// Deterministic serialization through ONE writer (`serializeModelVersionDoc`), same discipline
// `serializeFindingsDoc` (findings.ts) holds — keys in a fixed order, 2-space, trailing newline,
// never a bare `JSON.stringify`.
//
// `modelHash` is the sha256 of the `.em` file's own bytes, after normalizing line endings to
// `\n` first — so a checkout with different line-ending settings (CRLF vs LF) never reads as a
// content change on its own; only real edits move the hash.
//
// `slices` covers every non-continuation slice (MIL-208's "an `again` view instance is a
// continuation of its originating slice, never a slice with its own doc/version to vector") —
// export key -> that slice's doc `version:` (or `null` when the slice has no usable doc yet).
//
// `modelVersionDrift` is the one shared predicate every warn-only surface (`em status`, `em
// validate`'s `model-version-stale`, `em slice ratify`/`reratify`'s advisory) reads — never
// re-derived three different ways. It never refuses anything itself; every caller decides how
// (or whether) to surface what it found.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";

export const MODEL_VERSION_SCHEMA_VERSION = "1.0";

/** "design version N was certified at revision R on date D" (MIL-214's full, non-`--partial`
 *  `em state set-conformance`) — written into the CURRENT design version's manifest only.
 *  `report` is the conformance report path that run wrote; `findings` is the sibling findings
 *  JSON path beside it, or `null` when none was found (the pre-MIL-214 migration path). */
export interface ModelVersionCertified {
  at: string;
  on: string;
  report: string;
  findings: string | null;
}

/** One `model-versions/v<N>.json` document — see module header. `slices` keys are export keys
 *  (never re-sorted by the reader; `serializeModelVersionDoc` is the one place key order is
 *  made deterministic on write). */
export interface ModelVersionManifest {
  modelVersionSchemaVersion: string;
  /** The `.em` file's own basename — e.g. `"checkout.em"` — disambiguating within a directory
   *  that (like `conformance/`/`slices/`) can hold more than one model's manifests. */
  model: string;
  version: number;
  bumpedBy: string;
  bumpedOn: string;
  /** The running `em`'s own `GENERATOR_VERSION` at bump time — provenance, never read back by
   *  `em` itself. */
  emVersion: string;
  modelHash: string;
  slices: Record<string, number | null>;
  certified: ModelVersionCertified | null;
}

/** sha256 of `source`'s bytes, after normalizing every line ending to `\n` first — so a
 *  CRLF-vs-LF checkout difference never reads as a content change on its own. */
export function computeModelHash(source: string): string {
  const normalized = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/** Serialize a `ModelVersionManifest` deterministically — see module header. The ONE write path
 *  every producer of this file's bytes must go through, same discipline
 *  `findings.ts`'s `serializeFindingsDoc` holds. */
export function serializeModelVersionDoc(doc: ModelVersionManifest): string {
  const sortedSlices: Record<string, number | null> = {};
  for (const key of Object.keys(doc.slices).sort()) sortedSlices[key] = doc.slices[key];
  const canonical = {
    bumpedBy: doc.bumpedBy,
    bumpedOn: doc.bumpedOn,
    certified: doc.certified
      ? { at: doc.certified.at, findings: doc.certified.findings, on: doc.certified.on, report: doc.certified.report }
      : null,
    emVersion: doc.emVersion,
    model: doc.model,
    modelHash: doc.modelHash,
    modelVersionSchemaVersion: doc.modelVersionSchemaVersion,
    slices: sortedSlices,
    version: doc.version,
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

/** `<baseDir>/model-versions` — sibling of `slices/`/`conformance/`. `baseDir` is the `.em`
 *  file's directory, same convention every doc/note/manifest path in `em` uses. */
export function modelVersionsDir(baseDir: string): string {
  return join(baseDir, "model-versions");
}

export function modelVersionManifestPath(baseDir: string, version: number): string {
  return join(modelVersionsDir(baseDir), `v${version}.json`);
}

const MANIFEST_NAME_RE = /^v(\d+)\.json$/;

/** Every design version this model directory has ever bumped to, ascending. `[]` when
 *  `model-versions/` doesn't exist at all — the routine state for a model that has never
 *  bumped. Malformed/non-matching filenames in the directory are silently ignored (this is a
 *  discovery scan, not a validator). */
export function listModelVersionNumbers(baseDir: string): number[] {
  let entries: string[];
  try {
    entries = readdirSync(modelVersionsDir(baseDir));
  } catch {
    return [];
  }
  const nums = new Set<number>();
  for (const name of entries) {
    const m = MANIFEST_NAME_RE.exec(name);
    if (m) nums.add(Number(m[1]));
  }
  return [...nums].sort((a, b) => a - b);
}

/** The highest bumped design version, or `null` when this model directory has never bumped. */
export function latestModelVersionNumber(baseDir: string): number | null {
  const nums = listModelVersionNumbers(baseDir);
  return nums.length > 0 ? nums[nums.length - 1] : null;
}

export type ReadManifestResult = { ok: true; manifest: ModelVersionManifest } | { ok: false; message: string };

/** Read+parse one design version's manifest. `null` when it doesn't exist at all (not an
 *  error — the routine "never bumped to this version" state); `{ ok: false }` when the file
 *  exists but isn't readable/valid JSON (a genuine problem, reported rather than silently
 *  swallowed). No shape validation beyond "is it JSON" — this file is written by exactly one
 *  writer (`serializeModelVersionDoc`) in this codebase. */
export function readModelVersionManifest(baseDir: string, version: number): ReadManifestResult | null {
  const path = modelVersionManifestPath(baseDir, version);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, message: `could not read ${path}: ${(e as Error).message}` };
  }
  try {
    return { ok: true, manifest: JSON.parse(raw) as ModelVersionManifest };
  } catch {
    return { ok: false, message: `${path} is not valid JSON` };
  }
}

/** The current slices vector: every non-continuation slice's export key -> its doc's `version:`
 *  (or `null` when the slice has no usable doc yet). MIL-208: a continuation slice (an
 *  `again`-view-only slice with no legacy doc of its own) is excluded — its originating slice's
 *  own entry already covers it, same exclusion `conformScope.ts`'s `resolveSliceDocFacts` makes.
 *  `baseDir` is the `.em` file's directory, same doc-resolution convention every other doc-aware
 *  command uses. */
export function computeSlicesVector(model: NormalizedModel, refs: RefsResult, baseDir: string): Record<string, number | null> {
  const vector: Record<string, number | null> = {};
  model.slices.forEach((slice, i) => {
    const key = refs.sliceKeys[i];
    const { doc, continuationOf: continuationOfKey } = resolveSliceDocJoin(
      model,
      refs,
      slice,
      key,
      baseDir,
      (id) => refs.refById.get(id)!,
    );
    if (continuationOfKey !== null) return;
    vector[key] = doc.version;
  });
  return vector;
}

export type BumpModelVersionResult =
  | { ok: true; version: number; path: string }
  | { ok: false; message: string };

/**
 * `em model version bump`: write `model-versions/v<N+1>.json` (N+1 = highest existing + 1, or
 * 1 for the first-ever bump). Refuses when `by` is empty, and when nothing has changed since
 * the latest existing manifest (same `modelHash` AND same slices vector) unless `force` — a
 * no-op bump is the one case `--force` is right for (the caller wants a new version stamped
 * even though nothing moved). Pure computation + one fs write; the caller is responsible for
 * the state-file-missing precondition (a model-version bump without a resumable state file to
 * point the `Model version:` bullet at makes no sense — `em model version bump`'s CLI action
 * checks that first, before this function is ever called) and for rewriting the state file's
 * own `Model version:` bullet afterward (`stateFile.ts`'s `setModelVersion`).
 */
export function runModelVersionBump(
  baseDir: string,
  modelFileName: string,
  model: NormalizedModel,
  refs: RefsResult,
  source: string,
  by: string,
  on: string,
  emVersion: string,
  force: boolean,
): BumpModelVersionResult {
  const trimmedBy = by.trim();
  if (!trimmedBy) return { ok: false, message: "a bumper name is required (--by)" };

  const modelHash = computeModelHash(source);
  const slices = computeSlicesVector(model, refs, baseDir);
  const current = latestModelVersionNumber(baseDir);

  if (current !== null && !force) {
    const read = readModelVersionManifest(baseDir, current);
    if (read && read.ok) {
      const sameHash = read.manifest.modelHash === modelHash;
      const sameSlices =
        JSON.stringify(Object.keys(read.manifest.slices).sort()) === JSON.stringify(Object.keys(slices).sort()) &&
        Object.keys(slices).every((k) => (read.manifest.slices[k] ?? null) === (slices[k] ?? null));
      if (sameHash && sameSlices) {
        return {
          ok: false,
          message: `nothing has changed since v${current} (same model content and slice versions) — pass --force to bump anyway`,
        };
      }
    }
  }

  const newVersion = (current ?? 0) + 1;
  const manifest: ModelVersionManifest = {
    modelVersionSchemaVersion: MODEL_VERSION_SCHEMA_VERSION,
    model: modelFileName,
    version: newVersion,
    bumpedBy: trimmedBy,
    bumpedOn: on,
    emVersion,
    modelHash,
    slices,
    certified: null,
  };
  mkdirSync(modelVersionsDir(baseDir), { recursive: true });
  const path = modelVersionManifestPath(baseDir, newVersion);
  writeFileSync(path, serializeModelVersionDoc(manifest), "utf8");
  return { ok: true, version: newVersion, path };
}

export interface ModelVersionSliceChange {
  key: string;
  from: number | null;
  to: number | null;
}

/** The warn-only "has the vector moved since the last bump" fact — never a refusal, every
 *  caller (`em status`, `em validate`'s `model-version-stale`, the ratify/reratify advisory)
 *  decides how to surface it. `current: null` (never bumped) always reads as no drift — a repo
 *  that never bumped a design version has nothing to be stale against. A manifest that exists
 *  but fails to read/parse is treated the same conservative way: no drift reported (the file's
 *  own problem is a `readModelVersionManifest` concern for a caller that wants to surface it,
 *  not this predicate's).
 */
export interface ModelVersionDrift {
  current: number | null;
  hashChanged: boolean;
  slicesChanged: ModelVersionSliceChange[];
}

export function modelVersionDrift(
  baseDir: string,
  model: NormalizedModel,
  refs: RefsResult,
  source: string,
): ModelVersionDrift {
  const current = latestModelVersionNumber(baseDir);
  if (current === null) return { current: null, hashChanged: false, slicesChanged: [] };
  const read = readModelVersionManifest(baseDir, current);
  if (!read || !read.ok) return { current, hashChanged: false, slicesChanged: [] };

  const hashChanged = read.manifest.modelHash !== computeModelHash(source);
  const currentVector = computeSlicesVector(model, refs, baseDir);
  const keys = new Set([...Object.keys(read.manifest.slices), ...Object.keys(currentVector)]);
  const slicesChanged: ModelVersionSliceChange[] = [];
  for (const key of [...keys].sort()) {
    const from = read.manifest.slices[key] ?? null;
    const to = currentVector[key] ?? null;
    if (from !== to) slicesChanged.push({ key, from, to });
  }
  return { current, hashChanged, slicesChanged };
}

/** The most recently bumped design version that has ever been certified — walking every
 *  manifest newest-first, since a later bump doesn't clear an earlier version's own
 *  `certified` stamp (only the CURRENT design version's manifest is ever written to by `em
 *  state set-conformance`; older manifests keep whatever certification they already carried).
 *  `null` when no manifest has ever been certified. Malformed manifests are skipped (best
 *  effort, same posture `findings.ts`'s `listAllFindingsFiles` takes toward a broken file it
 *  isn't itself the loud diagnostic for). */
export function findCertifiedVersion(baseDir: string): { version: number; certified: ModelVersionCertified } | null {
  const nums = listModelVersionNumbers(baseDir).sort((a, b) => b - a);
  for (const v of nums) {
    const read = readModelVersionManifest(baseDir, v);
    if (read && read.ok && read.manifest.certified) return { version: v, certified: read.manifest.certified };
  }
  return null;
}

export type CertifyModelVersionResult =
  | { ok: true; version: number; path: string }
  | { ok: false; message: string };

/**
 * `em state set-conformance` (non-`--partial`, MIL-218 ruling D): write `certified: { at, on,
 * report, findings }` into the CURRENT design version's manifest. Refuses when no manifest
 * exists yet ("bump a model version first") and when the vector has drifted since that
 * manifest was bumped (`modelVersionDrift`, computed here — the question is exactly "has THIS
 * model changed since v<N> was bumped", the same predicate every other warn-only surface
 * reads): the certification would otherwise name a version that isn't what was actually
 * checked. Idempotent on an identical `certified` value; a DIFFERENT one simply overwrites —
 * re-certifying at a later revision is legal and common (MIL-214's own `em slice conform` holds
 * the same "overwrite, no --force" posture for exactly this reason).
 */
export function runCertifyModelVersion(
  baseDir: string,
  model: NormalizedModel,
  refs: RefsResult,
  source: string,
  at: string,
  on: string,
  report: string,
  findings: string | null,
): CertifyModelVersionResult {
  const current = latestModelVersionNumber(baseDir);
  if (current === null) {
    return { ok: false, message: "no model-versions/ manifest exists yet — bump a model version first (`em model version bump`)" };
  }
  const drift = modelVersionDrift(baseDir, model, refs, source);
  if (drift.hashChanged || drift.slicesChanged.length > 0) {
    return {
      ok: false,
      message: `the model has drifted since v${current} was bumped — bump a new model version first (\`em model version bump\`) before certifying`,
    };
  }
  const read = readModelVersionManifest(baseDir, current);
  if (!read || !read.ok) {
    return { ok: false, message: (read && "message" in read && read.message) || `model-versions/v${current}.json is missing or unreadable` };
  }
  const manifest: ModelVersionManifest = { ...read.manifest, certified: { at, on, report, findings } };
  const path = modelVersionManifestPath(baseDir, current);
  writeFileSync(path, serializeModelVersionDoc(manifest), "utf8");
  return { ok: true, version: current, path };
}
