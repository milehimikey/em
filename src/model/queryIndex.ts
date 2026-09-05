// SPDX-License-Identifier: MIT
// `ModelIndex` (MIL-168): the one graph index `em query`'s verbs all reduce to a map hit or a
// BFS over — built once per compiled model (see ../query/pipeline.ts's sub-pipeline) and shared
// by the CLI and the MCP `query` tool (both call `buildModelIndex()`, never a second traversal
// implementation — MCP parity, docs/mcp.md).
//
//  - `byRef`: the inverse of `RefsResult.refById` — the compiled model has never had this
//    before (`NormalizedModel.byName` is the only lookup table, keyed by display name, not ref).
//  - `out`/`in`: adjacency over `semanticEdges()` (model/edges.ts — the SAME edge list the
//    renderer draws, so query and diagram can't disagree on what connects), keyed by export ref
//    so query never has to re-resolve an internal Element.id. Each edge is labeled with its
//    connection kind, a pure function of the endpoint kinds (`connectionKind()`).
//  - `instances`: repeated read-model instances (`view X again`) grouped by `logicalId` — never
//    edges (see edges.ts's note on why instances don't connect), but the thing closures/paths
//    follow so "what's downstream of this event" reaches every later timeline instance of a
//    read model it feeds, not just the first (MIL-191's design note: a query-engine rule).
//  - `sliceFacts`: the doc join done once via `sliceDocIndex.ts`'s single `readdirSync`.
//  - `invariants`: INV-* id -> declaring slice, extracted from EVERY found slice doc's body
//    regardless of its status — reuses `cli/coverage.ts`'s extraction (never re-derives the
//    ownership-heading / structural-line rules a second time), but NOT coverage's in-scope
//    status gate: that gate decides which invariants must be cited by tests, whereas a lookup
//    ("which slice declares INV-X?") has to find a draft doc's invariant too, and reports the
//    doc's status alongside it. Test citations are NOT precomputed here (a query run only ever
//    asks about one ID at a time — see `em query invariant`) — the CLI/MCP layer calls
//    `scanTestCitations()` (also coverage.ts) directly when `--tests` is given.

import { Element, NormalizedModel } from "./model.js";
import { RefsResult } from "./refs.js";
import { semanticEdges, connectionKind, ConnectionKind } from "./edges.js";
import { loadSliceDocsOnce, joinSliceDocFast, SliceQueryDoc } from "./sliceDocIndex.js";
import { extractInvariantIds } from "../cli/coverage.js";

/** What a query result arrived by: one of the six legal connections, `view-instance` (the
 *  zero-cost hop between two timeline instances of one read model — not an edge), or `other`
 *  for an edge whose endpoint kinds form no legal connection (only reachable through a `from`
 *  clause resolving to a non-event; an explicit `arrow` between such a pair is a compile error
 *  query refuses on). */
export type QueryEdgeKind = ConnectionKind | "view-instance" | "other";

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
  /** Ref of a repeated read model instance -> refs of its OTHER instances (same `logicalId`),
   *  in document order. Only populated for views declared more than once; a single-instance
   *  element has no entry. */
  instances: Map<string, string[]>;
  /** Slice export key -> its doc-join facts, in `model.slices` order. */
  sliceFacts: Map<string, SliceIndexFact>;
  /** INV-* id -> the slice that declares it. A doc is scanned once per slice it resolves for
   *  (its own canonical slice, plus every slice it ratifies via MIL-121 `covers:`), so the
   *  CANONICAL binding (`doc.path === slices/<thisSliceKey>.md`) always owns the id, whatever
   *  the slices' document order; a cross-bound slice claims an id only when no canonical slice
   *  for that doc exists in the model. Two canonical docs declaring the same id is first-wins
   *  in slice order — a bug in the model, not something query silently resolves further. */
  invariants: Map<string, InvariantIndexEntry>;
}

function pushEdge(map: Map<string, IndexEdge[]>, key: string, edge: IndexEdge): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(edge);
  else map.set(key, [edge]);
}

export function buildModelIndex(model: NormalizedModel, refs: RefsResult, baseDir: string): ModelIndex {
  const byRef = new Map<string, Element>();
  for (const el of model.elements) {
    const ref = refs.refById.get(el.id);
    if (ref) byRef.set(ref, el);
  }

  const out = new Map<string, IndexEdge[]>();
  const inMap = new Map<string, IndexEdge[]>();
  for (const e of semanticEdges(model)) {
    const fromRef = refs.refById.get(e.from);
    const toRef = refs.refById.get(e.to);
    const fromEl = model.byId.get(e.from);
    const toEl = model.byId.get(e.to);
    if (!fromRef || !toRef || !fromEl || !toEl) continue;
    const kind: QueryEdgeKind = connectionKind(fromEl.kind, toEl.kind) ?? "other";
    pushEdge(out, fromRef, { ref: toRef, kind });
    pushEdge(inMap, toRef, { ref: fromRef, kind });
  }

  const byLogical = new Map<string, string[]>();
  for (const el of model.elements) {
    if (el.kind !== "view") continue;
    const ref = refs.refById.get(el.id);
    if (!ref) continue;
    const bucket = byLogical.get(el.logicalId);
    if (bucket) bucket.push(ref);
    else byLogical.set(el.logicalId, [ref]);
  }
  const instances = new Map<string, string[]>();
  for (const group of byLogical.values()) {
    if (group.length < 2) continue;
    for (const ref of group) instances.set(ref, group.filter((r) => r !== ref));
  }

  const docsByKey = loadSliceDocsOnce(baseDir);
  const sliceFacts = new Map<string, SliceIndexFact>();
  model.slices.forEach((slice, i) => {
    const key = refs.sliceKeys[i];
    const doc = joinSliceDocFast(slice, key, docsByKey);
    sliceFacts.set(key, { key, name: slice.name, index: i, line: slice.line, doc });
  });

  // Two passes, canonical bindings first, so a doc's own slice owns its invariants no matter
  // where a slice it also `covers:` sits in document order (see the `invariants` field doc).
  const invariants = new Map<string, InvariantIndexEntry>();
  const claim = (canonical: boolean) => {
    for (const { key, doc } of sliceFacts.values()) {
      if (doc.body === null || (doc.path === `slices/${key}.md`) !== canonical) continue;
      for (const id of extractInvariantIds(doc.body)) {
        if (!invariants.has(id)) invariants.set(id, { id, sliceKey: key });
      }
    }
  };
  claim(true);
  claim(false);

  return { model, refs, baseDir, byRef, out, in: inMap, instances, sliceFacts, invariants };
}
