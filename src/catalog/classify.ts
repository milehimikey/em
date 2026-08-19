// SPDX-License-Identifier: MIT
// Derives a slice's Event Modeling pattern from which element `kind`s it
// contains — the pattern itself is never stored in the AST/model (see
// docs/patterns.md), so `em catalog` is the first consumer that needs it
// computed. Rules follow docs/patterns.md's "DSL elements" table exactly,
// checked in priority order (a slice can carry a translation and a view
// together, for instance, so order matters).

import { Slice } from "../model/model.js";

export type SlicePattern = "translation" | "automation" | "state-change" | "state-view" | "unclassified";

/**
 * Classify a single slice by its element kinds. A reaction (`translation`/
 * `processor`/`automation`/`saga`) shares its slice with the command it
 * triggers — see docs/patterns.md — so checking translation/automation kinds
 * before command/event is what makes that combined slice read as Translation
 * or Automation rather than State Change. A view the reaction reads via
 * `from` lives in its own, earlier slice and classifies as State View on its
 * own. Order matters for this reason; keep the reaction checks first.
 */
export function classifySlicePattern(slice: Slice): SlicePattern {
  const kinds = new Set(slice.elements.map((el) => el.kind));
  if (kinds.has("translation")) return "translation";
  if (kinds.has("processor") || kinds.has("automation") || kinds.has("saga")) return "automation";
  if (kinds.has("command") || kinds.has("event")) return "state-change";
  if (kinds.has("view")) return "state-view";
  return "unclassified";
}

export function slicePatternLabel(pattern: SlicePattern): string {
  switch (pattern) {
    case "translation":
      return "Translation";
    case "automation":
      return "Automation";
    case "state-change":
      return "State Change";
    case "state-view":
      return "State View";
    case "unclassified":
      return "Unclassified";
  }
}
