// SPDX-License-Identifier: MIT
// The eight `em query` verbs (MIL-168), as pure functions over an already-built `QuerySystem`
// (system.ts) — every verb reduces to a map hit or a bounded BFS over `ModelIndex.out`/`.in`
// (model/queryIndex.ts). No fs, no process.exit: a verb either returns `{ ok: true, results }`
// or `{ ok: false, error }` (a bad/ambiguous ref, an unknown invariant ID, cross-model `path`
// endpoints) — the CLI action and the MCP tool each turn that into their own exit-code/tool-error
// convention (never a third implementation of "what counts as a query error").
//
// Determinism (MIL-168's own requirement): every traversal below visits models in `system`
// order, slices in `model.slices` order, and elements in `model.elements` order — the same
// order `ModelIndex.byRef`/`.out`/`.in` were built in (queryIndex.ts's own header), so no verb
// here does its own sorting; it just doesn't disturb the order its inputs already have.
//
// Repeated read models (`view X again`): the closures and `path` treat every timeline instance
// of one read model as the same node — reaching one instance reaches them all, at the same
// depth, reported `via: "view-instance"` — because a change upstream of the read model
// reaches everything that reads ANY instance of it. Instances are never edges (edges.ts's own
// note); this is the query-engine rule MIL-191's design note assigns to MIL-168.

import { Element } from "../model/model.js";
import { IndexEdge } from "../model/queryIndex.js";
import { QuerySystem, QueryModelEntry, resolveElement, qualifyRef } from "./system.js";
import { classifySlicePattern } from "../catalog/classify.js";
import { collectTags } from "../model/model.js";
import { scanTestCitations, Citation } from "../cli/coverage.js";

export interface ElementSummary {
  ref: string;
  kind: string;
  name: string;
  sliceKey: string;
  sliceName: string;
}

function summarize(system: QuerySystem, entry: QueryModelEntry, el: Element): ElementSummary {
  const ref = entry.refs.refById.get(el.id)!;
  const slice = entry.model.slices[el.sliceIndex];
  return {
    ref: qualifyRef(system, entry.modelKey, ref),
    kind: el.kind,
    name: el.name,
    sliceKey: qualifyRef(system, entry.modelKey, entry.refs.sliceKeys[el.sliceIndex]),
    sliceName: slice.name,
  };
}

function elementByEdgeRef(entry: QueryModelEntry, edge: IndexEdge): Element {
  return entry.index.byRef.get(edge.ref)!;
}

export type VerbResult<T> = { ok: true; results: T[] } | { ok: false; error: string };

function err<T>(message: string): VerbResult<T> {
  return { ok: false, error: message };
}

// ---- consumers / producers ----

export interface ConsumerEntry extends ElementSummary {
  via: string;
}

/** Views/reactions (and anything wired by an explicit `arrow`) consuming the named event — its
 *  direct out-neighbors in the legal-connection graph, each with the slice it lives in. */
export function queryConsumers(system: QuerySystem, eventRef: string): VerbResult<ConsumerEntry> {
  const resolved = resolveElement(system, eventRef);
  if (!resolved.ok) return err(resolved.error);
  const { entry, ref, elementKind } = resolved.match;
  if (elementKind !== "event") return err(`em query consumers: "${eventRef}" resolved to a ${elementKind}, not an event`);
  const edges = entry.index.out.get(ref) ?? [];
  return { ok: true, results: edges.map((e) => ({ ...summarize(system, entry, elementByEdgeRef(entry, e)), via: e.kind })) };
}

export interface ProducerEntry extends ElementSummary {
  via: string;
  uiTriggers: ElementSummary[];
}

/** Commands producing the named event, each with its own slice and (MIL-168 spec: "+ slices, ui
 *  triggers") the `ui` elements that trigger that command in turn. */
export function queryProducers(system: QuerySystem, eventRef: string): VerbResult<ProducerEntry> {
  const resolved = resolveElement(system, eventRef);
  if (!resolved.ok) return err(resolved.error);
  const { entry, ref, elementKind } = resolved.match;
  if (elementKind !== "event") return err(`em query producers: "${eventRef}" resolved to a ${elementKind}, not an event`);
  const edges = entry.index.in.get(ref) ?? [];
  const results = edges.map((e) => {
    const producer = elementByEdgeRef(entry, e);
    const producerRef = entry.refs.refById.get(producer.id)!;
    const triggerEdges = (entry.index.in.get(producerRef) ?? []).filter((x) => x.kind === "ui->command");
    return {
      ...summarize(system, entry, producer),
      via: e.kind,
      uiTriggers: triggerEdges.map((x) => summarize(system, entry, elementByEdgeRef(entry, x))),
    };
  });
  return { ok: true, results };
}

// ---- downstream / upstream ----

export interface ClosureEntry extends ElementSummary {
  depth: number;
  via: string;
}

function closure(system: QuerySystem, ofRef: string, depth: number | undefined, direction: "out" | "in", verbName: string): VerbResult<ClosureEntry> {
  const resolved = resolveElement(system, ofRef);
  if (!resolved.ok) return err(resolved.error);
  if (depth !== undefined && (!Number.isInteger(depth) || depth < 1)) {
    return err(`em query ${verbName}: --depth must be a positive integer`);
  }
  const { entry, ref } = resolved.match;
  const adjacency = direction === "out" ? entry.index.out : entry.index.in;

  const results: ClosureEntry[] = [];
  const visited = new Set<string>([ref]);
  let frontier: string[] = [];
  // Discovering a node also discovers every other instance of the same read model, at the
  // same depth (a zero-cost hop, see this module's header) — including the start's own.
  const add = (next: string[], target: string, d: number, via: string): boolean => {
    if (visited.has(target)) return false;
    visited.add(target);
    next.push(target);
    results.push({ ...summarize(system, entry, entry.index.byRef.get(target)!), depth: d, via });
    return true;
  };
  // One level of sibling discovery, never recursive: `instances` already lists EVERY other
  // member of a read model's group, so recursing would only re-visit the same set.
  const discover = (next: string[], target: string, d: number, via: string) => {
    if (!add(next, target, d, via)) return;
    for (const sibling of entry.index.instances.get(target) ?? []) add(next, sibling, d, "view-instance");
  };
  frontier.push(ref);
  for (const sibling of entry.index.instances.get(ref) ?? []) add(frontier, sibling, 0, "view-instance");

  let d = 0;
  while (frontier.length > 0 && (depth === undefined || d < depth)) {
    d++;
    const next: string[] = [];
    for (const cur of frontier) {
      for (const edge of adjacency.get(cur) ?? []) discover(next, edge.ref, d, edge.kind);
    }
    frontier = next;
  }
  return { ok: true, results };
}

/** Transitive closure along legal edges (direction: element -> whatever it feeds) — impact
 *  analysis: "what breaks if this changes." */
export function queryDownstream(system: QuerySystem, ofRef: string, depth?: number): VerbResult<ClosureEntry> {
  return closure(system, ofRef, depth, "out", "downstream");
}

/** Transitive closure against legal-edge direction — "what feeds this." */
export function queryUpstream(system: QuerySystem, ofRef: string, depth?: number): VerbResult<ClosureEntry> {
  return closure(system, ofRef, depth, "in", "upstream");
}

// ---- slices ----

export interface SliceQueryEntry {
  ref: string;
  name: string;
  index: number;
  pattern: string;
  status: string | null;
  personas: string[];
  contexts: string[];
  tags: string[];
}

export interface SliceFilters {
  pattern?: string;
  status?: string;
  context?: string;
  persona?: string;
  tag?: string;
}

/** The filtered slice list — every filter AND-combines. `pattern`/`status` match the slice's
 *  own single value exactly (case-insensitive); `context`/`persona`/`tag` match when ANY
 *  element in the slice carries that context/persona/tag key. */
export function querySlices(system: QuerySystem, filters: SliceFilters): VerbResult<SliceQueryEntry> {
  const results: SliceQueryEntry[] = [];
  for (const entry of system.entries) {
    entry.model.slices.forEach((slice, i) => {
      const key = entry.refs.sliceKeys[i];
      const pattern = classifySlicePattern(slice);
      const status = entry.index.sliceFacts.get(key)?.doc.status ?? null;
      const personas = [...new Set(slice.elements.filter((e) => e.kind === "ui").map((e) => e.persona!))];
      const contexts = [...new Set(slice.elements.filter((e) => e.kind === "event").map((e) => e.context!))];
      const tags = [...new Set(slice.elements.filter((e) => e.kind === "event").flatMap((e) => collectTags(e).map((t) => t.key)))];

      if (filters.pattern && pattern !== filters.pattern) return;
      if (filters.status && (status ?? "").toLowerCase() !== filters.status.toLowerCase()) return;
      if (filters.context && !contexts.some((c) => c.toLowerCase() === filters.context!.toLowerCase())) return;
      if (filters.persona && !personas.some((p) => p.toLowerCase() === filters.persona!.toLowerCase())) return;
      if (filters.tag && !tags.some((t) => t.toLowerCase() === filters.tag!.toLowerCase())) return;

      results.push({ ref: qualifyRef(system, entry.modelKey, key), name: slice.name, index: i, pattern, status, personas, contexts, tags });
    });
  }
  return { ok: true, results };
}

// ---- invariant ----

export interface InvariantQueryEntry {
  id: string;
  sliceRef: string;
  sliceName: string;
  docPath: string | null;
  status: string | null;
  citations: Citation[] | null;
}

/** The declaring slice + doc facts for one `INV-*` id, and (with `testsDir`) every test file
 *  citing it — a single-ID `scanTestCitations()` call, the same word-boundary citation scan
 *  `em coverage` uses for every ID in the model, reused rather than reimplemented. An id
 *  matching more than one input model is the same "unqualified + multi-model + ambiguous" case
 *  every other verb refuses on, listing qualified candidates. */
export function queryInvariant(system: QuerySystem, id: string, testsDir?: string): VerbResult<InvariantQueryEntry> {
  const hits: Array<{ entry: QueryModelEntry; sliceKey: string }> = [];
  for (const entry of system.entries) {
    const found = entry.index.invariants.get(id);
    if (found) hits.push({ entry, sliceKey: found.sliceKey });
  }
  if (hits.length === 0) return err(`em query invariant: no invariant "${id}" found in ${system.entries.map((e) => e.file).join(", ")}`);
  if (hits.length > 1) {
    const candidates = hits.map((h) => qualifyRef(system, h.entry.modelKey, id)).join(", ");
    return err(`em query invariant: "${id}" is ambiguous across models — ${candidates}`);
  }
  const { entry, sliceKey } = hits[0];
  const fact = entry.index.sliceFacts.get(sliceKey)!;
  const citations = testsDir !== undefined ? scanTestCitations(testsDir, [id]).get(id) ?? [] : null;
  return {
    ok: true,
    results: [
      {
        id,
        sliceRef: qualifyRef(system, entry.modelKey, sliceKey),
        sliceName: fact.name,
        docPath: fact.doc.found ? fact.doc.path : null,
        status: fact.doc.status,
        citations,
      },
    ],
  };
}

// ---- field ----

export interface FieldQueryEntry {
  elementRef: string;
  name: string;
  type: string | null;
  tag: boolean;
  assigned: boolean;
  renamedFrom: string[] | null;
  /** The owning element's own `renamed from` chain (event/command only, MIL-68) — provenance
   *  has two axes: the field's prior names, and the prior names of the element it lives on. */
  elementRenamedFrom: string[] | null;
}

/** One field's facts on the named element — type, identity-tag/system-assigned markers, its
 *  `renamed from` chain, and the owning element's. An element that resolves but carries no
 *  field of that name is a legitimate empty result (`results: []`), not an error — same "none,
 *  exit 0" contract as every other verb's empty answer. */
export function queryField(system: QuerySystem, ofRef: string, name: string): VerbResult<FieldQueryEntry> {
  const resolved = resolveElement(system, ofRef);
  if (!resolved.ok) return err(resolved.error);
  const { entry, ref } = resolved.match;
  const el = entry.index.byRef.get(ref)!;
  const field = (el.fields ?? []).find((f) => f.name === name);
  if (!field) return { ok: true, results: [] };
  return {
    ok: true,
    results: [
      {
        elementRef: qualifyRef(system, entry.modelKey, ref),
        name: field.name,
        type: field.type ?? null,
        tag: field.tag === true,
        assigned: field.assigned === true,
        renamedFrom: field.renamedFrom ?? null,
        elementRenamedFrom: el.renamedFrom ?? null,
      },
    ],
  };
}

// ---- path ----

export interface PathQueryEntry {
  refs: string[];
  edgeKinds: string[];
  length: number;
}

/** Shortest directed path from `fromRef` to `toRef` through the legal-connection graph (BFS,
 *  unweighted — first-found is shortest by construction; a `view-instance` hop costs nothing
 *  and isn't counted in `length`). Endpoints resolving to different models is a legitimate
 *  empty result (edges never cross model files — see system.ts's header) rather than an
 *  error. */
export function queryPath(system: QuerySystem, fromRef: string, toRef: string): VerbResult<PathQueryEntry> {
  const from = resolveElement(system, fromRef);
  if (!from.ok) return err(from.error);
  const to = resolveElement(system, toRef);
  if (!to.ok) return err(to.error);
  if (from.match.modelKey !== to.match.modelKey) return { ok: true, results: [] };

  const { entry } = from.match;
  const startRef = from.match.ref;
  const endRef = to.match.ref;
  if (startRef === endRef) {
    return { ok: true, results: [{ refs: [qualifyRef(system, entry.modelKey, startRef)], edgeKinds: [], length: 0 }] };
  }

  const prev = new Map<string, { from: string; kind: string }>();
  const visited = new Set<string>([startRef]);
  // Discovering a node discovers every other instance of the same read model with it, at the
  // same distance (this module's header) — recorded as a "view-instance" step in `edgeKinds`
  // but not counted in `length`. Doing it at discovery time (not as a frontier edge) is what
  // keeps BFS's first-found-is-shortest guarantee intact with zero-cost hops in the graph.
  const add = (next: string[], target: string, from: string, kind: string): "found" | "new" | "seen" => {
    if (visited.has(target)) return "seen";
    visited.add(target);
    prev.set(target, { from, kind });
    if (target === endRef) return "found";
    next.push(target);
    return "new";
  };
  // One level of sibling discovery, never recursive: `instances` already lists EVERY other
  // member of the group, and each sibling links straight back to `target` — so a path through
  // a three-instance read model reports exactly one `view-instance` step, not a chain of two.
  const discover = (next: string[], target: string, from: string, kind: string): boolean => {
    const outcome = add(next, target, from, kind);
    if (outcome !== "new") return outcome === "found";
    for (const sibling of entry.index.instances.get(target) ?? []) {
      if (add(next, sibling, target, "view-instance") === "found") return true;
    }
    return false;
  };

  let frontier: string[] = [];
  let found = false;
  for (const sibling of entry.index.instances.get(startRef) ?? []) {
    if (add(frontier, sibling, startRef, "view-instance") === "found") found = true;
  }
  frontier.unshift(startRef);
  while (frontier.length > 0 && !found) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const edge of entry.index.out.get(cur) ?? []) {
        if (discover(next, edge.ref, cur, edge.kind)) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    frontier = next;
  }

  if (!found) return { ok: true, results: [] };

  const chain: string[] = [endRef];
  const kinds: string[] = [];
  let cur = endRef;
  while (cur !== startRef) {
    const step = prev.get(cur)!;
    kinds.unshift(step.kind);
    chain.unshift(step.from);
    cur = step.from;
  }
  const length = kinds.filter((k) => k !== "view-instance").length;
  return {
    ok: true,
    results: [{ refs: chain.map((r) => qualifyRef(system, entry.modelKey, r)), edgeKinds: kinds, length }],
  };
}
