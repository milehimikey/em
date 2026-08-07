// SPDX-License-Identifier: MIT
// Event Modeling colour conventions.

import { ElementKind } from "../parser/ast.js";

export interface NodeStyle {
  fill: string;
  stroke: string;
  fontColor: string;
}

const STYLES: Record<ElementKind, NodeStyle> = {
  ui: { fill: "#FFFFFF", stroke: "#9AA0A6", fontColor: "#202124" },
  command: { fill: "#B8D0F5", stroke: "#2B6CB0", fontColor: "#10243E" },
  view: { fill: "#C6E7C6", stroke: "#2F855A", fontColor: "#173F25" },
  event: { fill: "#F6B26B", stroke: "#B7791F", fontColor: "#3F2A06" },
  automation: { fill: "#DBDBDB", stroke: "#5F6368", fontColor: "#202124" },
  processor: { fill: "#DBDBDB", stroke: "#5F6368", fontColor: "#202124" },
  saga: { fill: "#DBDBDB", stroke: "#5F6368", fontColor: "#202124" },
  translation: { fill: "#DBDBDB", stroke: "#5F6368", fontColor: "#202124" },
};

export function styleFor(kind: ElementKind): NodeStyle {
  return STYLES[kind];
}

// Slice-status colors — recognized values from the slice.md template's
// `- **Status:** {{draft | reviewed | ready-to-implement | implemented}}`
// (see src/catalog/sliceDoc.ts / .claude/skills/event-modeling/templates/slice.md).
// Deliberately reuses the element-kind palette above rather than inventing new
// hexes, so the diagram's color vocabulary stays small. `draft`, a missing doc,
// and any unrecognized string are NOT in this map on purpose — statusStyle()
// returns null for those and the caller keeps the existing neutral header gray
// (see HEADER_FILL/HEADER_BORDER in emit/dot.ts), since "no signal yet" and "not
// reviewed yet" both read the same visually.
const STATUS_STYLES: Record<string, NodeStyle> = {
  reviewed: STYLES.command,
  "ready-to-implement": STYLES.event,
  implemented: STYLES.view,
};

/** Color for a slice's header cell given its doc's Status value (already
 *  lowercased by parseSliceDoc), or null to keep the default header color. */
export function statusStyle(status: string | null): NodeStyle | null {
  return status ? (STATUS_STYLES[status.toLowerCase()] ?? null) : null;
}

/** Arrow colour keyed on the source element's kind. */
export function edgeColorFor(kind: ElementKind | undefined): string {
  switch (kind) {
    case "command":
      return "#2B6CB0";
    case "view":
      return "#2F855A";
    case "event":
      return "#B7791F";
    case "automation":
    case "processor":
    case "saga":
    case "translation":
      return "#5F6368";
    default:
      return "#3C4043";
  }
}