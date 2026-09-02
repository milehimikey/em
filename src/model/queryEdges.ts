// SPDX-License-Identifier: MIT
// `em query`'s own edge collection (MIL-168): the same six legal connections
// src/model/edges.ts's semanticEdges() computes for rendering (ui->command, command->event,
// event->read model, read model->ui, read model->reaction, reaction->command) plus explicit
// `arrow` declarations — but labeled with the connection KIND itself, keyed by internal
// Element.id the same way semanticEdges() is (query's index layer resolves those to export
// refs, see queryIndex.ts).
//
// Deliberately NOT built by post-processing semanticEdges()'s own SemanticEdge[]: that list
// carries a render `color` (derived from the SOURCE element's ElementKind, see emit/theme.ts)
// and dedupes an `arrow` declaration into whichever pattern edge already claimed the same
// (from, to) pair — exactly right for drawing one line, exactly wrong for query, which needs
// every edge's kind preserved and an explicit `arrow` kept distinguishable from an inferred
// pattern edge even when they connect the same two elements (traversal filters/reports on kind,
// dedup-by-erasure would silently hide that distinction). Both walks traverse the identical
// slice/from/arrow structure and reuse `resolveFromSource` (edges.ts) for the one non-trivial
// bit (cross-slice `from` resolution) — so they stay in lockstep by construction, not by
// promise. See this ticket's report for the open question of unifying them behind one shared
// walk that both color and kind derive from (deferred — export's schema stays untouched here).

import { AUTOMATION_KINDS } from "../parser/ast.js";
import { NormalizedModel } from "./model.js";
import { resolveFromSource } from "./edges.js";

export type QueryEdgeKind =
  | "ui->command"
  | "command->event"
  | "event->view"
  | "view->ui"
  | "view->reaction"
  | "reaction->command"
  | "arrow";

export interface QueryEdge {
  fromId: string;
  toId: string;
  kind: QueryEdgeKind;
}

/** Every legal-connection edge in `model`, keyed by internal `Element.id` — mirrors
 *  `semanticEdges()`'s own slice/from/arrow walk exactly (same loop order, same
 *  `resolveFromSource` cross-slice resolution) so the two never drift on WHICH pairs are
 *  connected, only on what's recorded about each connection. Deduped on `(from, to, kind)`
 *  rather than semanticEdges' `(from, to)` — an inferred pattern edge and an explicit `arrow`
 *  between the same two elements are two distinct facts here, not one drawn line. */
export function collectQueryEdges(model: NormalizedModel): QueryEdge[] {
  const edges: QueryEdge[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string, kind: QueryEdgeKind) => {
    if (from === to) return;
    const key = `${from}>${to}>${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ fromId: from, toId: to, kind });
  };

  for (const slice of model.slices) {
    const uis = slice.elements.filter((e) => e.kind === "ui");
    const command = slice.elements.find((e) => e.kind === "command");
    const view = slice.elements.find((e) => e.kind === "view");
    const events = slice.elements.filter((e) => e.kind === "event");
    const auto = slice.elements.find((e) => AUTOMATION_KINDS.has(e.kind));

    // Input pattern: UI -> command -> event(s) — see semanticEdges()'s own comment for why the
    // ui->command wire is skipped when an automation-kind element shares this slice.
    if (command) {
      if (!auto) for (const ui of uis) add(ui.id, command.id, "ui->command");
      for (const ev of events) add(command.id, ev.id, "command->event");
    }

    // Automation/translation: reaction -> command (same slice), and read model -> reaction
    // when the view it reads happens to share this slice too (the far more common case is the
    // cross-slice `from` loop below).
    if (auto && command) add(auto.id, command.id, "reaction->command");
    if (auto && view) add(view.id, auto.id, "view->reaction");

    // Output pattern: read model -> UI, and (same-slice only) event -> read model.
    if (view) {
      for (const ui of uis) add(view.id, ui.id, "view->ui");
      if ((view.from ?? []).length === 0) {
        for (const ev of events) add(ev.id, view.id, "event->view");
      }
    }
  }

  // Cross-slice `from` wiring: view from event(s) -> event->view; automation from read
  // model(s) -> view->reaction. Same resolution `resolveFromSource` (edges.ts) already does.
  for (const el of model.elements) {
    for (const name of el.from ?? []) {
      const src = resolveFromSource(model, el, name);
      if (!src) continue;
      if (el.kind === "view") add(src.id, el.id, "event->view");
      else add(src.id, el.id, "view->reaction");
    }
  }

  // Explicit arrows from the DSL — always their own kind, never folded into an inferred edge.
  for (const a of model.arrows) {
    if (a.fromId && a.toId) add(a.fromId, a.toId, "arrow");
  }

  return edges;
}
