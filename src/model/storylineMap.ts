// SPDX-License-Identifier: MIT
// The storyline map (owner rulings 2026-11-03): storylines as nodes, the flow between them as
// edges. Two edge kinds, both derived, no new syntax:
//   - "after": a declared `storyline "B" after "A"` — B picks up where A ends.
//   - "reads": an element of storyline A feeding an element of storyline B (a `from`, an
//     `updates from`, an `arrow` or a `loops-to` crossing the storyline boundary), grouped per
//     ordered storyline pair and labelled with the source element names.
// One derivation over model/edges.ts's semanticEdges, so the map, `em export` and the canvas
// (render/storylineMap.ts) can never disagree about what connects two stories.

import { NormalizedModel, Storyline, normalizeName } from "./model.js";
import { semanticEdges } from "./edges.js";
import { storylineOfSlice } from "./storylines.js";
import { kebabSlug } from "../util/slug.js";

export interface StorylineMapNode {
  name: string;
  slug: string;
  /** The storyline this one is declared `after`, as written; null when none. */
  after: string | null;
  sliceIndexes: number[];
}

export interface StorylineMapEdge {
  from: string;
  to: string;
  kind: "after" | "reads";
  /** Source element ids (model `Element.id`) crossing the boundary, in edge order; empty for "after". */
  elementIds: string[];
}

export interface StorylineMap {
  nodes: StorylineMapNode[];
  edges: StorylineMapEdge[];
}

export function storylineMap(model: NormalizedModel): StorylineMap {
  const storylines = model.storylines ?? [];
  const nodes: StorylineMapNode[] = storylines.map((st) => ({
    name: st.name,
    slug: kebabSlug(st.name),
    after: st.after ?? null,
    sliceIndexes: [...st.sliceIndexes],
  }));
  const byKey = new Map<string, Storyline>();
  for (const st of storylines) if (!byKey.has(normalizeName(st.name))) byKey.set(normalizeName(st.name), st);

  const edges: StorylineMapEdge[] = [];
  for (const st of storylines) {
    if (st.after === undefined) continue;
    const target = byKey.get(normalizeName(st.after));
    if (!target) continue;
    edges.push({ from: target.name, to: st.name, kind: "after", elementIds: [] });
  }

  const reads = new Map<string, StorylineMapEdge>();
  for (const e of semanticEdges(model)) {
    const from = model.byId.get(e.from);
    const to = model.byId.get(e.to);
    if (!from || !to) continue;
    const a = storylineOfSlice(model, from.sliceIndex);
    const b = storylineOfSlice(model, to.sliceIndex);
    if (!a || !b || a === b) continue;
    const key = `${a.name}\u0000${b.name}`;
    let edge = reads.get(key);
    if (!edge) reads.set(key, (edge = { from: a.name, to: b.name, kind: "reads", elementIds: [] }));
    if (!edge.elementIds.includes(from.id)) edge.elementIds.push(from.id);
  }
  edges.push(...[...reads.values()].sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to)));
  return { nodes, edges };
}
