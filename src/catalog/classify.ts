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
 * Classify a single slice by its element kinds. Known simplification, not a
 * bug: docs/patterns.md describes Automation and Translation as spanning
 * *two* slices — the reaction slice, then a following `command`+`event`
 * slice. That second slice has the exact same kind-signature as a State
 * Change slice, so per-slice classification reads it as State Change. This
 * matches "derived from which element kinds appear in the slice" and keeps
 * the classifier a pure function of one slice at a time; don't "fix" this by
 * trying to look at neighboring slices.
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
