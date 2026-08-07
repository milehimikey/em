// SPDX-License-Identifier: MIT
// Renders a single slice's own diagram, matching the canonical shape of
// whichever of the 4 Event Modeling patterns it is (State Change, State View,
// Automation, Translation) — instead of cropping the full multi-slice diagram
// down to one column (which forces a narrow crop to still show a wide swimlane
// label, and can pull in most of a neighboring slice; see git history).
//
// The key trick: every piece of "immediate context" a slice needs to draw its
// own shape is already one hop away in the compiled model — a view's upstream
// event(s) resolve via `from` (resolveFromSource, shared with semanticEdges),
// and an automation/translation's watched view is just whatever `view` sits in
// the same slice. So this builds a tiny *synthetic* NormalizedModel — reusing
// the real, already-normalized Element objects (same ids, same fields, same
// notes), shallow-cloned only to reassign which of a handful of new columns
// they land in — and runs it through the exact same layout()/emitDot() the
// full model uses, unmodified. Edge-drawing comes free too: semanticEdges()
// resolves `from` via byName, so as long as the synthetic model's byName map
// is populated, the arrows get drawn by the existing inference with zero new
// edge-drawing code.
//
// This never chases more than one hop away (previous slice for a triggerless
// State Change; a view's own `from` sources for State View; the next slice for
// Automation/Translation — semanticEdges itself never looks further than i+1),
// so a slice diagram can never balloon into showing most of the model, the way
// a naive crop or a naive "just extract this slice and recompile" both could.

import { AUTOMATION_KINDS } from "../parser/ast.js";
import { Element, NormalizedModel, Slice, normalizeName } from "../model/model.js";
import { resolveFromSource } from "../model/edges.js";
import { Grid, layout } from "../layout/grid.js";
import { emitDot } from "../emit/dot.js";
import { classifySlicePattern } from "../catalog/classify.js";

export interface SliceDiagramResult {
  model: NormalizedModel;
  grid: Grid;
  dot: string;
}

/** Build a small, standalone diagram for one slice — real Graphviz layout, not a crop. */
export function buildSliceDiagram(model: NormalizedModel, sliceIndex: number): SliceDiagramResult {
  const slice = model.slices[sliceIndex];
  const pattern = classifySlicePattern(slice);
  const columns = mergeColumns(collectColumns(model, sliceIndex, pattern));
  const synthetic = assembleSyntheticModel(model, columns, slice.name);
  const grid = layout(synthetic);
  const dot = emitDot(synthetic, grid);
  return { model: synthetic, grid, dot };
}

/** A column of the mini-diagram, anchored to a real origin slice (for naming
 *  and chronological ordering) — never a placeholder. */
interface SyntheticColumn {
  sourceSliceIndex: number;
  elements: Element[];
}

function collectColumns(model: NormalizedModel, sliceIndex: number, pattern: string): SyntheticColumn[] {
  switch (pattern) {
    case "state-change":
      return columnsForStateChange(model, sliceIndex);
    case "state-view":
      return columnsForStateView(model, sliceIndex);
    case "automation":
    case "translation":
      return columnsForReaction(model, sliceIndex);
    default: // "unclassified"
      return [{ sourceSliceIndex: sliceIndex, elements: model.slices[sliceIndex].elements }];
  }
}

/** State Change: UI -> Command -> Event, all in this slice. If there's no local
 *  UI, the command's real trigger is the previous slice's automation/translation
 *  reaction — pull in just that one element as earlier context. */
function columnsForStateChange(model: NormalizedModel, i: number): SyntheticColumn[] {
  const slice = model.slices[i];
  const hasUi = slice.elements.some((e) => e.kind === "ui");
  const cols: SyntheticColumn[] = [{ sourceSliceIndex: i, elements: slice.elements }];
  if (!hasUi) {
    const prev = model.slices[i - 1];
    const trigger = prev?.elements.find((e) => AUTOMATION_KINDS.has(e.kind));
    if (trigger) cols.push({ sourceSliceIndex: i - 1, elements: [trigger] });
  }
  return cols;
}

/** State View: Event(s) -> View -> UI. Each view's `from` names resolve to their
 *  real source Elements (same rule semanticEdges uses) — one column per distinct
 *  origin slice, so a multi-source view (e.g. a dashboard reading two events from
 *  two different, possibly far-apart slices) naturally gets one column per source,
 *  not a single blown-out column. */
function columnsForStateView(model: NormalizedModel, i: number): SyntheticColumn[] {
  const slice = model.slices[i];
  const cols: SyntheticColumn[] = [];
  for (const view of slice.elements.filter((e) => e.kind === "view")) {
    for (const name of view.from ?? []) {
      const src = resolveFromSource(model, view, name);
      if (src) cols.push({ sourceSliceIndex: src.sliceIndex, elements: [src] });
    }
  }
  cols.push({ sourceSliceIndex: i, elements: slice.elements });
  return cols;
}

/** Automation/Translation share one shape: [View ->] Automation (this slice),
 *  then Command -> Event (the immediately next slice — never further, mirroring
 *  semanticEdges' own i+1-only rule). The watched view is same-slice adjacency,
 *  not a `from` hop, so it's already included via this slice's own elements —
 *  deliberately not chased any further back. Only command/event are pulled from
 *  the next slice; a stray `ui` there belongs to *that* slice's own diagram. */
function columnsForReaction(model: NormalizedModel, i: number): SyntheticColumn[] {
  const slice = model.slices[i];
  const cols: SyntheticColumn[] = [{ sourceSliceIndex: i, elements: slice.elements }];
  const next = model.slices[i + 1];
  const forward = next?.elements.filter((e) => e.kind === "command" || e.kind === "event") ?? [];
  if (forward.length > 0) cols.push({ sourceSliceIndex: i + 1, elements: forward });
  return cols;
}

/** Merge columns sharing a source slice (two `from` names can resolve to the same
 *  origin slice), dedupe elements by id, then sort chronologically. `from`/reaction
 *  wiring only ever points backward or to the immediate next slice, so a plain
 *  ascending sort by real slice index is sufficient for correct left-to-right
 *  placement across every pattern — no pattern-specific ordering code needed. */
function mergeColumns(columns: SyntheticColumn[]): SyntheticColumn[] {
  const bySource = new Map<number, Map<string, Element>>();
  for (const col of columns) {
    let elements = bySource.get(col.sourceSliceIndex);
    if (!elements) {
      elements = new Map();
      bySource.set(col.sourceSliceIndex, elements);
    }
    for (const el of col.elements) elements.set(el.id, el);
  }
  return [...bySource.entries()]
    .map(([sourceSliceIndex, elements]) => ({ sourceSliceIndex, elements: [...elements.values()] }))
    .sort((a, b) => a.sourceSliceIndex - b.sourceSliceIndex);
}

/**
 * Assemble a small, valid NormalizedModel from the given columns — real Element
 * objects, shallow-cloned only to reassign `sliceIndex` to their new synthetic
 * column (never mutating the real model). Two details matter for correctness:
 *
 * - `byId` keeps each clone's *original* id — everything downstream (emitDot's
 *   node ids, styleFor, note markers, parseNodeRects) keys off Element.id, so
 *   preserving it is what keeps the whole rest of the render pipeline working
 *   completely unmodified.
 * - `byName` is populated from the clones actually included, using their
 *   untouched `name`/`from` strings — this is the entire trick that makes edge
 *   drawing free: semanticEdges() (called later, unmodified, inside
 *   composeSvg) resolves `from` via byName exactly as it does for the full
 *   model, so it finds the clones and draws the arrows automatically.
 *
 * `personas`/`contexts` are derived from only the included elements, not
 * copied from the full model — copying them was the exact class of bug that
 * made the previous crop-based approach barely narrower than the full diagram
 * (an unused row still reserves its own swimlane).
 */
function assembleSyntheticModel(model: NormalizedModel, columns: SyntheticColumn[], title: string): NormalizedModel {
  const slices: Slice[] = [];
  const elements: Element[] = [];
  const byId = new Map<string, Element>();
  const byName = new Map<string, Element[]>();

  columns.forEach((col, syntheticIndex) => {
    const origin = model.slices[col.sourceSliceIndex];
    const cloned = col.elements.map((el): Element => ({ ...el, sliceIndex: syntheticIndex }));
    slices.push({ name: origin.name, index: syntheticIndex, source: origin.source, elements: cloned, line: origin.line });
    for (const el of cloned) {
      elements.push(el);
      byId.set(el.id, el);
      const key = normalizeName(el.name);
      const bucket = byName.get(key);
      if (bucket) bucket.push(el);
      else byName.set(key, [el]);
    }
  });

  return {
    name: title,
    personas: dedupeDefined(elements.filter((e) => e.kind === "ui").map((e) => e.persona)),
    contexts: dedupeDefined(elements.filter((e) => e.kind === "event").map((e) => e.context)),
    hasAutomation: elements.some((e) => AUTOMATION_KINDS.has(e.kind)),
    slices,
    elements,
    byId,
    byName,
    // v1 gap, deliberate: explicit DSL `arrow` statements are rare (they exist for
    // relationships semanticEdges' pattern inference can't derive on its own) and
    // dropping them from a single-slice extraction is narrow, not silent — a
    // follow-up could remap model.arrows entries whose both endpoints resolve
    // through an original-id -> cloned-id map, but it's not needed to ship this.
    arrows: [],
    // Unused by layout()/emitDot() — fieldLabel() prints a field's type as a raw
    // string, never resolves it — so passthrough is free and avoids handing back
    // broken/empty maps for no benefit.
    types: model.types,
    typesByName: model.typesByName,
  };
}

function dedupeDefined(values: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
