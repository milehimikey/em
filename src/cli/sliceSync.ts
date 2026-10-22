// SPDX-License-Identifier: MIT
// `em slice sync <model> [<key>] [--check] [--json]` (MIL-266): regenerate the GENERATED regions
// of existing slice docs in place from the model — the command/event/view field tables and the
// Invariants list catalog/sliceSections.ts defines — so a model edit never leaves a doc's tables
// quietly wrong. Authored bytes are never touched: only the text strictly between a region's two
// marker lines is replaced, edits are spliced in by offset (never parse-and-reserialize), and the
// doc's own line ending (LF or CRLF) is used for every generated line.
//
// Region set per doc: catalog/sliceSections.ts `buildSliceRegions` over every slice whose doc join
// (catalog/docJoin.ts `resolveSliceDocJoin` — the same binding `em export` uses) resolves to that
// doc: its own slice, plus any MIL-121 cross-covered slice or MIL-208 continuation.
//   - a region the doc has and the model expects  → regenerated (`ok` when already current,
//     `stale` under --check, `synced` once rewritten);
//   - a region the doc has and the model doesn't  → `orphan`, left untouched, a `note:`;
//   - a region the model expects and the doc lacks → `missing`, NOT inserted (that would be an
//     edit outside the markers), a `note:`;
//   - a doc with no `em-slice-*` marker at all     → `no-regions`, skipped with a note (a 1.13
//     doc stays exactly as written until someone adopts regions);
//   - unbalanced markers                            → `malformed`, nothing in that doc is
//     rewritten, exit 1.
// `--check` never writes; it exits 1 when any doc is stale (or malformed).
//
// GH #347 — a doc that records a `ratifiedHash:` (a ratified or shipped doc) is synced like any
// other and KEEPS its signature: since 1.19.0 the hash covers the authored text only
// (catalog/sliceDoc.ts `ratifiedBody` leaves the inside of every generated region out), so a
// region rewrite never moves it. A hash still in an older scope (1.17–1.18, regions inside; or
// pre-1.17 whole-body) whose body is intact is re-stamped in the current scope in the same write
// — same authored text, not a re-signing, `ratifiedRef` untouched — because the old-scope hash
// would not survive the rewrite. A doc whose body already fails its hash is synced too, nothing
// re-stamped (the signature was broken before; `--check-signed-bodies` still says so). Each case
// prints a `note:` line (`signatureNote`).
//
// Pure core (`syncDocText`) + fs-aware runner (`runSliceSync`); the CLI and the MCP `slice_sync`
// tool (check-only) share `buildSliceSyncJson`.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";
import { buildSliceRegions, GeneratedRegion, scanSliceRegions } from "../catalog/sliceSections.js";
import { isOldHashScope, parseSliceDoc, ratifiedHashScope, RatifiedHashScope, sliceDocBodyHash } from "../catalog/sliceDoc.js";
import { replaceFieldValue } from "./frontmatterSurgery.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "../emit/json.js";

// 1.0 (MIL-266): initial shape.
export const SLICE_SYNC_SCHEMA_VERSION = "1.0";

export type RegionSyncStatus = "ok" | "stale" | "synced" | "missing" | "orphan";
export type DocSyncStatus = "ok" | "stale" | "synced" | "no-regions" | "malformed";

export interface RegionSyncEntry {
  name: string;
  status: RegionSyncStatus;
}

export interface DocTextSync {
  status: Exclude<DocSyncStatus, "synced">;
  regions: RegionSyncEntry[];
  /** Marker-balance problems (status `malformed`). */
  problems: string[];
  /** The doc text with every expected, present region regenerated — equal to the input when
   *  nothing is stale or the doc is malformed / has no regions. */
  next: string;
}

/** Regenerate `raw`'s regions against `expected`. Pure. Statuses are check-mode (`stale`, never
 *  `synced`); the runner relabels after writing. */
export function syncDocText(raw: string, expected: GeneratedRegion[]): DocTextSync {
  const scan = scanSliceRegions(raw);
  if (scan.problems.length > 0) return { status: "malformed", regions: [], problems: scan.problems, next: raw };
  if (scan.regions.length === 0) return { status: "no-regions", regions: [], problems: [], next: raw };

  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const byName = new Map(expected.map((r) => [r.name, r]));
  const present = new Set(scan.regions.map((r) => r.name));
  const regions: RegionSyncEntry[] = [];
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const span of scan.regions) {
    const want = byName.get(span.name);
    if (!want) {
      regions.push({ name: span.name, status: "orphan" });
      continue;
    }
    const inner = eol + want.body.join(eol) + eol;
    if (raw.slice(span.innerStart, span.innerEnd) === inner) {
      regions.push({ name: span.name, status: "ok" });
    } else {
      regions.push({ name: span.name, status: "stale" });
      edits.push({ start: span.innerStart, end: span.innerEnd, text: inner });
    }
  }
  for (const r of expected) if (!present.has(r.name)) regions.push({ name: r.name, status: "missing" });

  let next = raw;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) next = next.slice(0, e.start) + e.text + next.slice(e.end);
  return { status: edits.length > 0 ? "stale" : "ok", regions, problems: [], next };
}

/** GH #347: what a region rewrite did to a doc's `ratifiedHash:` — `kept` (current scope, the
 *  hash is untouched), `restamped` (an intact older-scope hash moved to the current scope; `from`
 *  names the old scope), `broken` (the body already failed its hash before the sync). */
export type SignatureOutcome = { kind: "kept" } | { kind: "restamped"; from: Exclude<RatifiedHashScope, "current" | "mismatch"> } | { kind: "broken" };

export type SignedSyncResult = { ok: true; content: string; signature: SignatureOutcome | null } | { ok: false; message: string };

/**
 * Pure (GH #347): the signature half of a sync. `raw` is the doc as read, `next` the doc with its
 * regions regenerated. A doc with no `ratifiedHash:` passes through (`signature: null`). Otherwise
 * the recorded hash is judged on `raw` through `ratifiedHashScope`: `current` is kept; an intact
 * `v1.17`/`legacy` hash is re-stamped with the current-scope hash of the same body; `mismatch`
 * passes through untouched. Then — the invariant this rests on — an intact signature must match
 * `next` in the current scope, or nothing is written.
 */
export function keepSignature(raw: string, next: string): SignedSyncResult {
  const recorded = parseSliceDoc(raw).ratifiedHash;
  if (recorded === null) return { ok: true, content: next, signature: null };
  const scope = ratifiedHashScope(raw, recorded);
  if (scope === "mismatch") return { ok: true, content: next, signature: { kind: "broken" } };
  let content = next;
  let signature: SignatureOutcome = { kind: "kept" };
  if (isOldHashScope(scope)) {
    const restamped = replaceFieldValue(next, "ratifiedHash", sliceDocBodyHash(raw));
    if (restamped === null) return { ok: false, message: "could not locate ratifiedHash: in the frontmatter" };
    content = restamped;
    signature = { kind: "restamped", from: scope as "v1.17" | "legacy" };
  }
  const after = parseSliceDoc(content).ratifiedHash;
  if (after === null || ratifiedHashScope(content, after) !== "current") {
    return { ok: false, message: "rewriting the generated regions would leave the authored text unmatched by ratifiedHash — nothing written (this is a bug in em; please report it)" };
  }
  return { ok: true, content, signature };
}

export interface DocSyncResult {
  key: string;
  path: string;
  status: DocSyncStatus;
  regions: RegionSyncEntry[];
  problems: string[];
  /** GH #347: set when the doc records a `ratifiedHash:` and its regions were rewritten. */
  signature?: SignatureOutcome;
  /** GH #347: set (check mode only) on a `stale` doc whose rewrite `keepSignature` would refuse —
   *  the reason a write would fail. A write-mode run reports such a doc as `malformed` instead. */
  signatureRefused?: string;
}

export type SliceSyncOutcome = { ok: true; docs: DocSyncResult[] } | { ok: false; message: string };

/**
 * Sync every bound doc of `model` (or only the doc `sliceKey` resolves to). `check` never
 * writes. `baseDir` is the `.em` file's directory (doc paths are relative to it).
 */
export function runSliceSync(
  model: NormalizedModel,
  refs: RefsResult,
  baseDir: string,
  sliceKey: string | undefined,
  check: boolean,
): SliceSyncOutcome {
  const groups = new Map<string, number[]>();
  const refOf = (id: string) => refs.refById.get(id)!;
  model.slices.forEach((slice, i) => {
    const { doc } = resolveSliceDocJoin(model, refs, slice, refs.sliceKeys[i], baseDir, refOf);
    if (!doc.found || doc.reason !== null) return;
    const list = groups.get(doc.path);
    if (list) list.push(i);
    else groups.set(doc.path, [i]);
  });

  let only: string | null = null;
  if (sliceKey !== undefined) {
    const idx = refs.sliceKeys.indexOf(sliceKey);
    if (idx === -1) return { ok: false, message: `no slice with export key "${sliceKey}" in this model` };
    const { doc } = resolveSliceDocJoin(model, refs, model.slices[idx], sliceKey, baseDir, refOf);
    if (doc.reason === "no-doc-bound") {
      return { ok: false, message: `slice "${sliceKey}" has no doc bound via \`note "slices/${sliceKey}.md"\` — nothing to sync` };
    }
    if (doc.reason === "binding-missing-file") return { ok: false, message: `slice "${sliceKey}"'s bound doc ${doc.path} does not exist` };
    if (doc.reason === "frontmatter-invalid") {
      return { ok: false, message: `slice "${sliceKey}"'s doc ${doc.path} has unusable frontmatter — run em validate and fix it first` };
    }
    only = doc.path;
  }

  const docs: DocSyncResult[] = [];
  for (const [path, indices] of groups) {
    if (only !== null && path !== only) continue;
    const docKey = path.replace(/^slices\//, "").replace(/\.md$/, "");
    const ownerIdx = indices.find((i) => refs.sliceKeys[i] === docKey) ?? Math.min(...indices);
    const abs = join(baseDir, path);
    const raw = readFileSync(abs, "utf8");
    const result = syncDocText(raw, buildSliceRegions(model, indices));
    let status: DocSyncStatus = result.status;
    let regions = result.regions;
    let problems = result.problems;
    let signature: SignatureOutcome | null = null;
    let signatureRefused: string | null = null;
    if (check && result.status === "stale") {
      const probe = keepSignature(raw, result.next);
      if (!probe.ok) signatureRefused = probe.message;
    }
    if (!check && result.status === "stale") {
      const signed = keepSignature(raw, result.next);
      if (signed.ok) {
        writeFileSync(abs, signed.content);
        status = "synced";
        regions = regions.map((r) => (r.status === "stale" ? { name: r.name, status: "synced" as const } : r));
        signature = signed.signature;
      } else {
        status = "malformed";
        problems = [signed.message];
      }
    }
    docs.push({
      key: refs.sliceKeys[ownerIdx],
      path,
      status,
      regions,
      problems,
      ...(signature !== null ? { signature } : {}),
      ...(signatureRefused !== null ? { signatureRefused } : {}),
    });
  }
  return { ok: true, docs };
}

/** `em slice sync … --json` (and the MCP `slice_sync` tool, check mode only). */
export function buildSliceSyncJson(file: string, docs: DocSyncResult[]): string {
  return JSON.stringify(
    {
      sliceSyncSchemaVersion: SLICE_SYNC_SCHEMA_VERSION,
      generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
      file,
      docs: docs.map((d) => ({ key: d.key, path: d.path, status: d.status, regions: d.regions })),
    },
    null,
    2,
  );
}

/** The exit-1 condition shared by the CLI: a malformed doc always, a stale doc under --check. */
export function sliceSyncFailed(docs: DocSyncResult[], check: boolean): boolean {
  return docs.some((d) => d.status === "malformed" || (check && d.status === "stale"));
}

/** GH #347: the line `em slice sync` prints after rewriting the regions of a doc that records a
 *  `ratifiedHash:`. */
export function signatureNote(path: string, signature: SignatureOutcome): string {
  switch (signature.kind) {
    case "kept":
      return `note: ${path} is signed — generated regions rewritten, ratifiedHash kept (it covers the authored text only)`;
    case "restamped":
      return `note: ${path} is signed — generated regions rewritten, ratifiedHash re-stamped from the ${signature.from === "v1.17" ? "1.17" : "pre-1.17 whole-body"} scope to the current scope (same authored text, not a re-signing; ratifiedRef untouched)`;
    case "broken":
      return `note: ${path}'s body already failed its ratifiedHash before this sync (edited after ratification) — generated regions rewritten, nothing re-stamped; see em validate --check-signed-bodies`;
  }
}

/** Text-mode report: `{ out, err }` lines (status lines on stdout, notes and problems on stderr). */
export function formatSliceSync(docs: DocSyncResult[], check: boolean): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  for (const d of docs) {
    const changed = d.regions.filter((r) => r.status === "stale" || r.status === "synced").map((r) => r.name);
    switch (d.status) {
      case "ok":
        out.push(`ok: ${d.path}`);
        break;
      case "stale":
        out.push(`stale: ${d.path} (${changed.join(", ")})`);
        break;
      case "synced":
        out.push(`synced: ${d.path} (${changed.join(", ")})`);
        if (d.signature) err.push(signatureNote(d.path, d.signature));
        break;
      case "no-regions":
        if (check) out.push(`no-regions: ${d.path}`);
        else err.push(`note: ${d.path} has no generated regions — re-create with em slice new --force to adopt them`);
        break;
      case "malformed":
        err.push(`malformed: ${d.path} (${d.problems.join("; ")}) — nothing in it was rewritten`);
        break;
    }
    for (const r of d.regions) {
      if (r.status === "orphan") err.push(`note: ${d.path}: region "${r.name}" matches nothing in the model — left untouched`);
      if (r.status === "missing") {
        err.push(`note: ${d.path}: the model expects region "${r.name}", which the doc lacks — add its marker pair, or re-create with em slice new --force`);
      }
    }
  }
  return { out, err };
}
