// SPDX-License-Identifier: MIT
// The semantic edges of a model: which connections exist, and where each came from. This is
// the single source of truth for the graph — the renderer draws exactly these (colouring each
// by its source element's kind at the call site, render/drawEdges.ts), `em query`'s ModelIndex
// traverses exactly these (model/queryIndex.ts), and (MIL-191) export will serialize exactly
// these. One derivation, three consumers: the guards below (the misplaced-ui rule, the
// same-slice-only event->view rule, the pair dedup) are judgment calls invisible in the data,
// so a second walk re-deriving them would drift — it did once already (the MIL-162 portal
// spike re-derived independently).

import { AUTOMATION_KINDS, ElementKind } from "../parser/ast.js";
import { Element, NormalizedModel, normalizeName } from "./model.js";

/** Where an edge came from: inferred from a slice's pattern shape, resolved from an explicit
 *  `from "Name"` clause, or declared by an `arrow`. First-wins on a duplicate (from, to) pair
 *  in exactly this order — an `arrow` restating an inferred connection is the same line. */
export type EdgeSource = "pattern" | "from" | "arrow";

export interface SemanticEdge {
  from: string;
  to: string;
  source: EdgeSource;
}

/** The six legal connection types, named by their endpoint kinds. */
export type ConnectionKind =
  | "ui->command"
  | "command->event"
  | "event->view"
  | "view->ui"
  | "view->reaction"
  | "reaction->command";

/** The legal connection type for an endpoint-kind pair, or undefined when no such connection
 *  is legal — the relationship is a pure function of the two kinds, so edges carry no `kind`
 *  of their own (validate.ts's illegal-pair rule and query's edge labels both derive from
 *  here). */
export function connectionKind(from: ElementKind, to: ElementKind): ConnectionKind | undefined {
  if (from === "ui") return to === "command" ? "ui->command" : undefined; // State Change
  if (from === "command") return to === "event" ? "command->event" : undefined; // State Change
  if (from === "event") return to === "view" ? "event->view" : undefined; // State View
  if (from === "view") {
    if (to === "ui") return "view->ui"; // State View
    if (AUTOMATION_KINDS.has(to)) return "view->reaction"; // Automation / Translation
    return undefined;
  }
  if (AUTOMATION_KINDS.has(from)) return to === "command" ? "reaction->command" : undefined; // reactions always go through a command
  return undefined;
}

/** Infer pattern arrows from each slice plus cross-slice `from` sources. */
export function semanticEdges(model: NormalizedModel): SemanticEdge[] {
  const edges: SemanticEdge[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string, source: EdgeSource) => {
    if (from === to) return;
    const key = `${from}>${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, source });
  };

  for (const slice of model.slices) {
    const uis = slice.elements.filter((e) => e.kind === "ui");
    const command = slice.elements.find((e) => e.kind === "command");
    const view = slice.elements.find((e) => e.kind === "view");
    const events = slice.elements.filter((e) => e.kind === "event");
    const auto = slice.elements.find((e) => AUTOMATION_KINDS.has(e.kind));

    // Input pattern: UI -> command -> event(s). No pattern has a `ui` and a reaction both
    // triggering the same command — that's not a real dual-trigger, it's a `ui` misplaced in
    // a reaction's slice — so skip the ui->command wire when an automation-kind element also
    // shares this slice, matching validate.ts's "renders disconnected here" diagnosis exactly.
    if (command) {
      if (!auto) for (const ui of uis) add(ui.id, command.id, "pattern");
      for (const ev of events) add(command.id, ev.id, "pattern");
    }

    // Automation/translation: it triggers the command in this same slice — the
    // reaction is to a command what a `ui` is in the State Change pattern. If it
    // also reads a read model that happens to share this slice, wire that too;
    // the far more common cross-slice case is handled by the `from` loop below.
    if (auto && command) add(auto.id, command.id, "pattern");
    if (auto && view) add(view.id, auto.id, "pattern");

    // Output pattern: view -> UI (read model feeds the screen)
    if (view) {
      for (const ui of uis) add(view.id, ui.id, "pattern");
      if ((view.from ?? []).length === 0) {
        for (const ev of events) add(ev.id, view.id, "pattern");
      }
    }
  }

  // Cross-slice `from` wiring:
  //   view       from event(s)      -> event -> view
  //   automation from read model(s) -> view  -> automation
  for (const el of model.elements) {
    for (const name of el.from ?? []) {
      const src = resolveFromSource(model, el, name);
      if (src) add(src.id, el.id, "from");
    }
  }

  // Note: instances of the same logical read model (`view X again`) are deliberately NOT
  // connected to one another. Repeating a view is an ergonomic device for showing it at
  // successive points on the timeline; continuity is implied by the shared name, and the
  // inbound event arrows are what show how the view changes over time. A view->view arrow
  // would be a modelling error — and, since commands and read models share the API lane,
  // it also renders as a flat line through any command box between the two instances,
  // reading as an illegal command->read-model connection. (Traversal that needs to follow a
  // read model across its instances — `em query`'s closures — does so via `logicalId`, as a
  // query-engine rule, not as an edge.)

  // Explicit arrows from the DSL.
  for (const a of model.arrows) {
    if (a.fromId && a.toId) add(a.fromId, a.toId, "arrow");
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
