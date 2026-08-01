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
import { Box, Rect } from "./svgGeometry.js";

const STROKE = 1.5;
const MIN_BOW = 24;
const MAX_BOW = 90;
const SAME_ROW_EPS = 10; // |cy| difference under this counts as the same row
const GUTTER = 14; // clearance left when detouring around a box
const CORRIDOR_STEPS = 6; // heights probed across the gap between two rows

export interface EdgeOverlay {
  defs: string;
  group: string;
  /** Extent of everything drawn, so the caller can grow the canvas to fit a detour. */
  bbox: Box | null;
}

export function buildEdgeOverlay(model: NormalizedModel, rects: Map<string, Rect>): EdgeOverlay {
  const paths: string[] = [];
  const colors = new Set<string>();
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

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
      // Across columns the direct curve can still run through boxes in the slices between —
      // a long span, or (before the CQRS check) a flat same-band edge sailing through a
      // command. Any box on the line reads as a connection that isn't in the model, so when
      // the direct path is blocked, arc around the obstacles instead.
      const blockers: Rect[] = [];
      for (const [id, r] of rects) if (id !== e.from && id !== e.to) blockers.push(r);
      const direct = curvePoints(f, t);
      let pts = direct;
      if (hits(direct, blockers).length) {
        const routed = detour(f, t, blockers);
        if (routed) {
          pts = routed;
        } else {
          // Every detour still crosses something — draw the direct line rather than nothing,
          // but say so: a silently-drawn blocked arrow is exactly the misreading this file
          // exists to prevent.
          const fromName = model.byId.get(e.from)?.name ?? e.from;
          const toName = model.byId.get(e.to)?.name ?? e.to;
          console.warn(
            `  warn  no clear route for "${fromName}" -> "${toName}"; drawing it straight, ` +
              `which may cross a box it doesn't connect to`,
          );
        }
      }
      d = cubic(...pts);
    }
    colors.add(e.color);
    grow(box, d);
    paths.push(
      `<path fill="none" stroke="${e.color}" stroke-width="${STROKE}" ` +
        `d="${d}" marker-end="url(#${markerId(e.color)})"/>`,
    );
  }

  const markers = [...colors].map(marker).join("");
  return {
    defs: markers ? `<defs>${markers}</defs>` : "",
    group: `<g class="em-edges">${paths.join("")}</g>`,
    bbox: paths.length ? box : null,
  };
}

/** Fold a path's coordinates into the running bounds. Control points bound the curve they
 *  describe, so this over-estimates slightly and never under-estimates. */
function grow(box: Box, d: string): void {
  for (const m of d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)) {
    const x = +m[1];
    const y = +m[2];
    box.minX = Math.min(box.minX, x);
    box.maxX = Math.max(box.maxX, x);
    box.minY = Math.min(box.minY, y);
    box.maxY = Math.max(box.maxY, y);
  }
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

/** Control points of the direct cubic between two boxes in different columns. */
type Cubic = [number, number, number, number, number, number, number, number];

function curvePoints(f: Rect, t: Rect): Cubic {
  const dy = t.cy - f.cy;

  if (Math.abs(dy) <= SAME_ROW_EPS) {
    // same band: leave/enter on the facing side, bow horizontally
    const k = clamp(0.5 * Math.abs(t.cx - f.cx), MIN_BOW, MAX_BOW);
    if (t.cx >= f.cx) {
      return [f.right, f.cy, f.right + k, f.cy, t.left - k, t.cy, t.left, t.cy];
    }
    return [f.left, f.cy, f.left - k, f.cy, t.right + k, t.cy, t.right, t.cy];
  }

  const k = clamp(0.6 * Math.abs(dy), MIN_BOW, MAX_BOW);
  if (dy < 0) {
    // t is above f: leave f's top, enter t's bottom
    return [f.cx, f.top, f.cx, f.top - k, t.cx, t.bottom + k, t.cx, t.bottom];
  }
  // t is below f: leave f's bottom, enter t's top
  return [f.cx, f.bottom, f.cx, f.bottom + k, t.cx, t.top - k, t.cx, t.top];
}

/** Leave `f` and enter `t` vertically, running flat at `y` in between. Each end exits by
 *  whichever face points at `y`, so the same shape serves a corridor, an over, and an under. */
function flatRoute(f: Rect, t: Rect, y: number): Cubic {
  const face = (r: Rect) => (y < r.top ? r.top : y > r.bottom ? r.bottom : r.cy);
  return [f.cx, face(f), f.cx, y, t.cx, y, t.cx, face(t)];
}

/** First clear route: through the corridor between the two rows if one fits, else arcing
 *  over everything, else under. Null when nothing clears within the try budget. */
function detour(f: Rect, t: Rect, boxes: Rect[]): Cubic | null {
  return (
    corridorRoute(f, t, boxes) ??
    routeAround(f, t, boxes, -1) ??
    routeAround(f, t, boxes, 1)
  );
}

/** Run the flat middle in the gap between the two boxes' rows — the shortest detour, and the
 *  one that keeps a long cross-row span inside the channel it was already aiming for. */
function corridorRoute(f: Rect, t: Rect, boxes: Rect[]): Cubic | null {
  const [lo, hi] = t.cy < f.cy ? [t.bottom, f.top] : [f.bottom, t.top];
  const half = (hi - lo) / 2 - GUTTER;
  if (half <= 0) return null; // same band, or rows too close to thread between
  const mid = (lo + hi) / 2;
  for (let i = 0; i <= CORRIDOR_STEPS; i++) {
    const off = (half * i) / CORRIDOR_STEPS;
    for (const y of i === 0 ? [mid] : [mid - off, mid + off]) {
      const pts = flatRoute(f, t, y);
      if (!hits(pts, boxes).length) return pts;
    }
  }
  return null;
}

/** Arc over (dir -1) or under (dir 1) everything, widening past whatever it still hits. Each
 *  failed try pushes `y` beyond every box that blocked it, so a box can only ever be the one
 *  that triggers a widen once — the box set is finite, so `boxes.length` widenings is always
 *  enough to either clear everything or prove nothing more can be gained by widening further. */
function routeAround(f: Rect, t: Rect, boxes: Rect[], dir: -1 | 1): Cubic | null {
  let y = dir < 0 ? Math.min(f.top, t.top) - GUTTER : Math.max(f.bottom, t.bottom) + GUTTER;
  for (let i = 0; i < boxes.length + 1; i++) {
    const pts = flatRoute(f, t, y);
    const blocked = hits(pts, boxes);
    if (!blocked.length) return pts;
    y =
      dir < 0
        ? Math.min(y, ...blocked.map((b) => b.top)) - GUTTER
        : Math.max(y, ...blocked.map((b) => b.bottom)) + GUTTER;
  }
  return null;
}

/** Boxes whose interior the cubic passes through, found by sampling along it. Approximate, not
 *  exact: SAMPLES points along the curve, not a true curve/rectangle intersection — good enough
 *  at these box sizes, matching this file's other approximations (see grow()'s comment). */
function hits(p: Cubic, boxes: Rect[]): Rect[] {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = p;
  const found = new Set<Rect>();
  for (let i = 1; i < SAMPLES; i++) {
    const s = i / SAMPLES;
    const x = bezier(x0, x1, x2, x3, s);
    const y = bezier(y0, y1, y2, y3, s);
    for (const b of boxes) {
      if (x > b.left && x < b.right && y > b.top && y < b.bottom) found.add(b);
    }
  }
  return [...found];
}

const SAMPLES = 96;

function bezier(a: number, b: number, c: number, d: number, t: number): number {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
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