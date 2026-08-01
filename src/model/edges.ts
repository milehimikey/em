// SPDX-License-Identifier: MIT
// The semantic edges of a model: which arrows exist and their colour. This is
// the single source of truth for the diagram's arrows, decoupled from how they
// are drawn (the renderer turns these into SVG paths over the Graphviz grid).

import { AUTOMATION_KINDS, ElementKind } from "../parser/ast.js";
import { NormalizedModel, normalizeName } from "./model.js";
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

  model.slices.forEach((slice, i) => {
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

    // Automation/translation: it reads the read model in its own slice, then
    // triggers the command in the next slice.
    if (auto) {
      if (view) add(view.id, auto.id, "view");
      const nextCommand = model.slices[i + 1]?.elements.find(
        (e) => e.kind === "command",
      );
      if (nextCommand) add(auto.id, nextCommand.id, auto.kind);
      else for (const ev of events) add(auto.id, ev.id, auto.kind);
    }

    // Output pattern: view -> UI (read model feeds the screen)
    if (view) {
      for (const ui of uis) add(view.id, ui.id, "view");
      if ((view.from ?? []).length === 0) {
        for (const ev of events) add(ev.id, view.id, "event");
      }
    }
  });

  // Cross-slice `from` wiring:
  //   view       from event(s)      -> event -> view
  //   automation from read model(s) -> view  -> automation
  for (const el of model.elements) {
    for (const name of el.from ?? []) {
      const bucket = model.byName.get(normalizeName(name));
      if (!bucket) continue;
      const src =
        el.kind === "view"
          ? bucket.find((x) => x.kind === "event") ?? bucket[0]
          : nearestViewAtOrBefore(bucket, el.sliceIndex) ??
            bucket.find((x) => x.kind === "view") ??
            bucket[0];
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

/** Latest view instance declared at-or-before the given slice (reactions read what exists). */
function nearestViewAtOrBefore(
  bucket: { kind: ElementKind; sliceIndex: number; id: string }[],
  sliceIndex: number,
) {
  return bucket
    .filter((x) => x.kind === "view" && x.sliceIndex <= sliceIndex)
    .sort((a, b) => b.sliceIndex - a.sliceIndex)[0];
}