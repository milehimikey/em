// SPDX-License-Identifier: MIT
// The semantic edges of a model: which arrows exist and their colour. This is
// the single source of truth for the diagram's arrows, decoupled from how they
// are drawn (the renderer turns these into SVG paths over the Graphviz grid).

import { AUTOMATION_KINDS, ElementKind } from "../parser/ast.js";
import { Element, NormalizedModel, normalizeName } from "./model.js";
import { edgeColorFor } from "../emit/theme.js";

export interface SemanticEdge {
  from: string;
  to: string;
  color: string;
}

/** Infer pattern arrows from each slice plus cross-slice `from` sources. */
export function semanticEdges(model: NormalizedModel): SemanticEdge[] {
  const edges: SemanticEdge[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string, kind: ElementKind | undefined) => {
    if (from === to) return;
    const key = `${from}>${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, color: edgeColorFor(kind) });
  };

  for (const slice of model.slices) {
    const uis = slice.elements.filter((e) => e.kind === "ui");
    const command = slice.elements.find((e) => e.kind === "command");
    const view = slice.elements.find((e) => e.kind === "view");
    const events = slice.elements.filter((e) => e.kind === "event");
    const auto = slice.elements.find((e) => AUTOMATION_KINDS.has(e.kind));

    // Input pattern: UI -> command -> event(s)
    if (command) {
      for (const ui of uis) add(ui.id, command.id, "ui");
      for (const ev of events) add(command.id, ev.id, "command");
    }

    // Automation/translation: it triggers the command in this same slice — the
    // reaction is to a command what a `ui` is in the State Change pattern. If it
    // also reads a read model that happens to share this slice, wire that too;
    // the far more common cross-slice case is handled by the `from` loop below.
    if (auto && command) add(auto.id, command.id, auto.kind);
    if (auto && view) add(view.id, auto.id, "view");

    // Output pattern: view -> UI (read model feeds the screen)
    if (view) {
      for (const ui of uis) add(view.id, ui.id, "view");
      if ((view.from ?? []).length === 0) {
        for (const ev of events) add(ev.id, view.id, "event");
      }
    }
  }

  // Cross-slice `from` wiring:
  //   view       from event(s)      -> event -> view
  //   automation from read model(s) -> view  -> automation
  for (const el of model.elements) {
    for (const name of el.from ?? []) {
      const src = resolveFromSource(model, el, name);
      if (src) add(src.id, el.id, src.kind);
    }
  }

  // Note: instances of the same logical read model (`view X again`) are deliberately NOT
  // connected to one another. Repeating a view is an ergonomic device for showing it at
  // successive points on the timeline; continuity is implied by the shared name, and the
  // inbound event arrows are what show how the view changes over time. A view->view arrow
  // would be a modelling error — and, since commands and read models share the API lane,
  // it also renders as a flat line through any command box between the two instances,
  // reading as an illegal command->read-model connection.

  // Explicit arrows from the DSL.
  for (const a of model.arrows) {
    if (a.fromId && a.toId) add(a.fromId, a.toId, model.byId.get(a.fromId)?.kind);
  }

  return edges;
}

/**
 * Resolve one `from "Name"` reference to the Element it points at — the same rule
 * for every caller that needs to follow a cross-slice reference (semanticEdges here,
 * and src/render/sliceDiagram.ts's single-slice pattern renderer, which needs the
 * full source Element — not just its id — to draw it as a local context box).
 * A `view`'s sources are events (or, failing that, whatever the bucket's first
 * entry is); anything else (in practice unused today — only `view` populates
 * `from`) resolves to the nearest view at-or-before its own slice, since a
 * reaction reads whatever read-model state exists at that point in the timeline.
 */
export function resolveFromSource(model: NormalizedModel, el: Element, name: string): Element | undefined {
  const bucket = model.byName.get(normalizeName(name));
  if (!bucket) return undefined;
  return el.kind === "view"
    ? bucket.find((x) => x.kind === "event") ?? bucket[0]
    : nearestViewAtOrBefore(bucket, el.sliceIndex) ?? bucket.find((x) => x.kind === "view") ?? bucket[0];
}

/** Latest view instance declared at-or-before the given slice (reactions read what exists). */
function nearestViewAtOrBefore(bucket: Element[], sliceIndex: number): Element | undefined {
  return bucket
    .filter((x) => x.kind === "view" && x.sliceIndex <= sliceIndex)
    .sort((a, b) => b.sliceIndex - a.sliceIndex)[0];
}