// SPDX-License-Identifier: MIT
// `ModelIndex` (MIL-168): the one graph index `em query`'s verbs all reduce to a map hit or a
// BFS over — built once per compiled model (see ../query/pipeline.ts's sub-pipeline) and shared
// by the CLI and the MCP `query` tool (both call `buildModelIndex()`, never a second traversal
// implementation — MCP parity, docs/mcp.md).
//
//  - `byRef`: the inverse of `RefsResult.refById` — the compiled model has never had this
//    before (`NormalizedModel.byName` is the only lookup table, keyed by display name, not ref).
//  - `out`/`in`: adjacency over the six legal connections + explicit arrows (queryEdges.ts),
//    keyed by export ref so query never has to re-resolve an internal Element.id.
//  - `sliceFacts`: the doc join done once via `sliceDocIndex.ts`'s single `readdirSync`.
//  - `invariants`: INV-* id -> declaring slice, extracted from each in-scope slice's own doc
//    body — reuses `cli/coverage.ts`'s extraction (never re-derives the ownership-heading /
//    structural-line rules a second time). Test citations are NOT precomputed here (a query run
//    only ever asks about one ID at a time — see `em query invariant`) — the CLI/MCP layer
//    calls `scanTestCitations()` (also coverage.ts) directly when `--tests` is given.

import { Element, NormalizedModel } from "./model.js";
import { RefsResult } from "./refs.js";
import { collectQueryEdges, QueryEdgeKind } from "./queryEdges.js";
import { loadSliceDocsOnce, joinSliceDocFast, SliceQueryDoc } from "./sliceDocIndex.js";
import { extractInvariantIds } from "../cli/coverage.js";

export interface IndexEdge {
  ref: string;
  kind: QueryEdgeKind;
}

export interface SliceIndexFact {
  key: string;
  name: string;
  index: number;
  line: number;
  doc: SliceQueryDoc;
}

export interface InvariantIndexEntry {
  id: string;
  sliceKey: string;
}

export interface ModelIndex {
  model: NormalizedModel;
  refs: RefsResult;
  baseDir: string;
  /** Export ref -> Element, in `model.elements` order (== document order: slice, then
   *  within-slice declaration order) — the same order every query verb sorts its results by,
   *  for free, via Map iteration order. */
  byRef: Map<string, Element>;
  out: Map<string, IndexEdge[]>;
  in: Map<string, IndexEdge[]>;
  /** Slice export key -> its doc-join facts, in `model.slices` order. */
  sliceFacts: Map<string, SliceIndexFact>;
  /** INV-* id -> the slice whose doc body first declares it (first-wins on a duplicate — a
   *  bug in the model, not something query silently resolves further). */
  invariants: Map<string, InvariantIndexEntry>;
}

function pushEdge(map: Map<string, IndexEdge[]>, key: string, edge: IndexEdge): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(edge);
  else map.set(key, [edge]);
}

/** Statuses in scope for invariant-ID ownership — same set `cli/coverage.ts`'s
 *  IN_SCOPE_STATUSES uses (a slice doesn't own invariant IDs before ready-to-implement, and
 *  stays in scope forever after implemented). Not imported (coverage.ts doesn't export it) —
 *  small, stable enum kept in lockstep by inspection rather than adding an export whose only
 *  other reader would be this one call site. */
const IN_SCOPE_STATUSES = new Set(["ready-to-implement", "implemented"]);

export function buildModelIndex(model: NormalizedModel, refs: RefsResult, baseDir: string): ModelIndex {
  const byRef = new Map<string, Element>();
  for (const el of model.elements) {
    const ref = refs.refById.get(el.id);
    if (ref) byRef.set(ref, el);
  }

  const out = new Map<string, IndexEdge[]>();
  const inMap = new Map<string, IndexEdge[]>();
  for (const e of collectQueryEdges(model)) {
    const fromRef = refs.refById.get(e.fromId);
    const toRef = refs.refById.get(e.toId);
    if (!fromRef || !toRef) continue;
    pushEdge(out, fromRef, { ref: toRef, kind: e.kind });
    pushEdge(inMap, toRef, { ref: fromRef, kind: e.kind });
  }

  const docsByKey = loadSliceDocsOnce(baseDir);
  const sliceFacts = new Map<string, SliceIndexFact>();
  const invariants = new Map<string, InvariantIndexEntry>();
  model.slices.forEach((slice, i) => {
    const key = refs.sliceKeys[i];
    const doc = joinSliceDocFast(slice, key, docsByKey);
    sliceFacts.set(key, { key, name: slice.name, index: i, line: slice.line, doc });
    if (doc.found && doc.reason === null && doc.status !== null && IN_SCOPE_STATUSES.has(doc.status) && doc.body !== null) {
      for (const id of extractInvariantIds(doc.body)) {
        if (!invariants.has(id)) invariants.set(id, { id, sliceKey: key });
      }
    }
  });

  return { model, refs, baseDir, byRef, out, in: inMap, sliceFacts, invariants };
}
