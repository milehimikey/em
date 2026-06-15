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