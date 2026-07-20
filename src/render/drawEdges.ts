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

  const sideLaneBySource = new Map<string, number>();
  for (const e of semanticEdges(model)) {
    const f = rects.get(e.from);
    const t = rects.get(e.to);
    if (!f || !t) continue;
    const fSlice = model.byId.get(e.from)?.sliceIndex;
    const tSlice = model.byId.get(e.to)?.sliceIndex;
    let d: string;
    if (fSlice !== undefined && fSlice === tSlice) {
      // A straight vertical that would pass THROUGH another box in the column (the multi-event
      // fan case: command -> 2nd/3rd event) reads as a false event->event chain. Route those
      // around the column's right side instead, one gutter lane per fanned edge.
      if (isObstructed(model, rects, fSlice, e.from, e.to, f, t)) {
        const lane = sideLaneBySource.get(e.from) ?? 0;
        sideLaneBySource.set(e.from, lane + 1);
        d = sideRoute(f, t, lane);
      } else {
        d = straight(f, t);
      }
    } else {
      d = curve(f, t);
    }
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

/** True when any other box in the slice's column sits vertically between f and t on the
 *  centerline a straight edge would use. */
function isObstructed(
  model: NormalizedModel,
  rects: Map<string, Rect>,
  sliceIndex: number,
  fromId: string,
  toId: string,
  f: Rect,
  t: Rect,
): boolean {
  const top = Math.min(f.bottom, t.bottom);
  const bottom = Math.max(f.top, t.top);
  const x = (f.cx + t.cx) / 2;
  for (const el of model.slices[sliceIndex]?.elements ?? []) {
    if (el.id === fromId || el.id === toId) continue;
    const r = rects.get(el.id);
    if (!r) continue;
    if (r.left < x && r.right > x && r.top < bottom && r.bottom > top) return true;
  }
  return false;
}

/** Route around the column's right gutter, entering the target's right edge — used when the
 *  direct vertical would cross intermediate boxes (multi-event fans stay visually a fan). */
function sideRoute(f: Rect, t: Rect, lane: number): string {
  const gx = Math.max(f.right, t.right) + 10 + lane * 12;
  const s = t.cy > f.cy ? 1 : -1;
  const b = 14;
  return (
    `M${n(f.right)},${n(f.cy)} ` +
    `C${n(f.right + b)},${n(f.cy)} ${n(gx)},${n(f.cy)} ${n(gx)},${n(f.cy + s * b)} ` +
    `L${n(gx)},${n(t.cy - s * b)} ` +
    `C${n(gx)},${n(t.cy)} ${n(t.right + b)},${n(t.cy)} ${n(t.right)},${n(t.cy)}`
  );
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