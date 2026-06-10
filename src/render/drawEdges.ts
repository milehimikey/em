// SPDX-License-Identifier: MIT
// Turns the model's semantic edges into SVG, drawn over the Graphviz grid.
//
// Coordinates come from parseNodeRects (same user space as the SVG). y grows
// downward, so the visually-upper box has the smaller cy. We draw:
//   - within a slice (same column): a straight vertical, facing-edge centre to
//     facing-edge centre.
//   - across slices: a cubic bezier that leaves/enters perpendicular to the
//     facing edges and arcs through the channel between the boxes.
// Arrowheads are per-colour markers referenced with marker-end.

import { NormalizedModel } from "../model/model.js";
import { semanticEdges } from "../model/edges.js";
import { Rect } from "./svgGeometry.js";

const STROKE = 1.5;
const MIN_BOW = 24;
const MAX_BOW = 90;
const SAME_ROW_EPS = 10; // |cy| difference under this counts as the same row

export interface EdgeOverlay {
  defs: string;
  group: string;
}

export function buildEdgeOverlay(model: NormalizedModel, rects: Map<string, Rect>): EdgeOverlay {
  const paths: string[] = [];
  const colors = new Set<string>();

  for (const e of semanticEdges(model)) {
    const f = rects.get(e.from);
    const t = rects.get(e.to);
    if (!f || !t) continue;
    const fSlice = model.byId.get(e.from)?.sliceIndex;
    const tSlice = model.byId.get(e.to)?.sliceIndex;
    const d = fSlice !== undefined && fSlice === tSlice ? straight(f, t) : curve(f, t);
    colors.add(e.color);
    paths.push(
      `<path fill="none" stroke="${e.color}" stroke-width="${STROKE}" ` +
        `d="${d}" marker-end="url(#${markerId(e.color)})"/>`,
    );
  }

  const markers = [...colors].map(marker).join("");
  return {
    defs: markers ? `<defs>${markers}</defs>` : "",
    group: `<g class="em-edges">${paths.join("")}</g>`,
  };
}

/** Straight vertical between two same-column boxes, facing edge to facing edge. */
function straight(f: Rect, t: Rect): string {
  const x = (f.cx + t.cx) / 2;
  if (f.cy <= t.cy) {
    // f is upper: leave its bottom, enter t's top (arrow points down)
    return `M${n(x)},${n(f.bottom)} L${n(x)},${n(t.top)}`;
  }
  // f is lower: leave its top, enter t's bottom (arrow points up)
  return `M${n(x)},${n(f.top)} L${n(x)},${n(t.bottom)}`;
}

/** Smooth cubic between two boxes in different columns. */
function curve(f: Rect, t: Rect): string {
  const dy = t.cy - f.cy;

  if (Math.abs(dy) <= SAME_ROW_EPS) {
    // same band: leave/enter on the facing side, bow horizontally
    const k = clamp(0.5 * Math.abs(t.cx - f.cx), MIN_BOW, MAX_BOW);
    if (t.cx >= f.cx) {
      return cubic(f.right, f.cy, f.right + k, f.cy, t.left - k, t.cy, t.left, t.cy);
    }
    return cubic(f.left, f.cy, f.left - k, f.cy, t.right + k, t.cy, t.right, t.cy);
  }

  const k = clamp(0.6 * Math.abs(dy), MIN_BOW, MAX_BOW);
  if (dy < 0) {
    // t is above f: leave f's top, enter t's bottom
    return cubic(f.cx, f.top, f.cx, f.top - k, t.cx, t.bottom + k, t.cx, t.bottom);
  }
  // t is below f: leave f's bottom, enter t's top
  return cubic(f.cx, f.bottom, f.cx, f.bottom + k, t.cx, t.top - k, t.cx, t.top);
}

function cubic(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
): string {
  return `M${n(x0)},${n(y0)} C${n(x1)},${n(y1)} ${n(x2)},${n(y2)} ${n(x3)},${n(y3)}`;
}

function marker(color: string): string {
  return (
    `<marker id="${markerId(color)}" markerWidth="9" markerHeight="9" refX="6.5" refY="3" ` +
    `orient="auto" markerUnits="userSpaceOnUse">` +
    `<path d="M0,0 L7,3 L0,6 Z" fill="${color}"/></marker>`
  );
}

function markerId(color: string): string {
  return `em-arrow-${color.replace(/[^0-9a-z]/gi, "")}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function n(v: number): number {
  return Math.round(v * 100) / 100;
}