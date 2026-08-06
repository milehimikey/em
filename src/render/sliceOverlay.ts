// SPDX-License-Identifier: MIT
// Tags each element's rendered node group with its slice index, and embeds a
// <metadata> block describing every slice's name and x-range in the SVG.
//
// This is what lets the storyboard mode in the live viewer (`em watch --serve`,
// see src/render/serve.ts) highlight and pan/zoom to one slice at a time
// entirely client-side, with no separate data fetch — everything the browser
// needs travels inside the SVG it already loads.
//
// A slice's x-range comes from its header-cell rect (headerCellId), not from
// element rects — a slice can have empty rows, which would give an element-based
// bbox a wrong or missing range.
//
// The row-label (swimlane) column has no rect at all in parseNodeRects' sense:
// row labels render as bare `shape=plaintext` Graphviz nodes, which emit only a
// `<text>` element (no `<polygon>`/`<path>`), so they fall outside
// parseNodeRects' polygon/path-based extraction entirely. Their x-range is
// instead estimated straight from each `<text>` element: an exact center
// (Graphviz always emits `text-anchor="middle"` here) and a width approximated
// from character count and font size. That's a deliberate approximation local
// to this file — good enough to keep the swimlane labels in frame when the
// storyboard viewer pans/zooms to a slice, not meant to be pixel-accurate, and
// not worth teaching the shared parseNodeRects() a text-measuring fallback for
// its one caller that needs it.

import { NormalizedModel } from "../model/model.js";
import { Grid, headerCellId } from "../layout/grid.js";
import { rowLabelId } from "../emit/dot.js";
import {
  decode,
  readGraphTransform,
  parseNodeRects,
  cropCanvas,
  NODE_GROUP,
  TITLE,
  NUM,
  Rect,
} from "./svgGeometry.js";

const TEXT = /<text\b([^>]*)>([^<]*)<\/text>/;

/** Every non-element node id the slice overlay needs a rect for (header cells),
 *  to fold into the same parseNodeRects() call as element ids. */
export function sliceOverlayIds(grid: Grid): string[] {
  const ids: string[] = [];
  for (let c = 0; c < grid.cols; c++) ids.push(headerCellId(c));
  return ids;
}

/** Splice `data-slice="<index>"` onto every element's node group. */
export function tagSliceAttrs(svg: string, model: NormalizedModel): string {
  return svg.replace(NODE_GROUP, (block) => {
    const id = decode(TITLE.exec(block)?.[1] ?? "");
    const el = model.byId.get(id);
    if (!el) return block; // header cell, row label, or placeholder — leave untagged
    return block.replace(/^<g\b/, `<g data-slice="${el.sliceIndex}"`);
  });
}

interface SliceRange {
  index: number;
  name: string;
  x0: number;
  x1: number;
}

/** `<metadata>` (slice ranges, as JSON) + `<style>` (the dim class) block, spliced
 *  just inside the root `<svg>`. `svg` is scanned (post-fitCanvas/tagSliceAttrs is
 *  fine — neither touches `<text>` elements) for the row-label column's x-range.
 *  Returns "" if no slice has a rect — the model is empty, or the SVG shape wasn't
 *  what parseNodeRects expected.
 *
 *  rects (from parseNodeRects) and the row-label `<text>` x positions scanned below
 *  are both in graph-space — the coordinate system *inside* Graphviz's
 *  `<g class="graph" transform="scale(...) translate(...)">` wrapper — not the root
 *  SVG/viewBox space the served viewer sets `viewBox` in. Every x0/x1 here goes
 *  through readGraphTransform()'s toRoot() before it's embedded, the same
 *  conversion fitCanvas() applies to the edge-detour bbox for the same reason. */
export function buildSliceOverlay(svg: string, grid: Grid, rects: Map<string, Rect>): string {
  const transform = readGraphTransform(svg);
  const toRootX = (x: number): number => transform.toRoot(x, 0).x;

  const slices: SliceRange[] = [];
  for (let c = 0; c < grid.cols; c++) {
    const r = rects.get(headerCellId(c));
    if (!r) continue;
    slices.push({ index: c, name: grid.sliceNames[c], x0: toRootX(r.left), x1: toRootX(r.right) });
  }
  if (slices.length === 0) return "";

  const rowLabels = rowLabelXRange(svg, grid.rows.length, toRootX);
  const payload = { slices, rowLabels };
  const metadata = `<metadata id="em-slices">${escXml(JSON.stringify(payload))}</metadata>`;
  const style = `<style>.em-slice-dim{opacity:.15;transition:opacity .15s ease}</style>`;
  return metadata + style;
}

/**
 * Crop an already-composed full-model SVG down to one slice's own column, for
 * embedding as a standalone slice-scoped diagram (`em render --slice`, `em catalog`'s
 * per-slice pages).
 *
 * The slice's own x-range comes from its header-cell rect (see the file header
 * comment for why). Row/swimlane labels live in a single dedicated gutter column at
 * the far left of the *whole* model (see relocateRowLabels) — unioning the crop with
 * their real position, the way the live storyboard viewer's client-side pan does,
 * would drag every slice but the first few all the way back to column 0, making the
 * "crop" barely narrower than the full diagram. So labels are relocated to sit
 * snugly against this slice's own left edge first, and *that* local position is what
 * gets unioned into the crop range — every slice gets an equally narrow snippet,
 * with its own swimlane labels in frame.
 *
 * Returns `svg` unchanged if the requested slice has no rect (out-of-range index, or
 * an SVG shape parseNodeRects didn't expect).
 */
export function cropToSlice(svg: string, grid: Grid, sliceIndex: number): string {
  const rects = parseNodeRects(svg, new Set([headerCellId(sliceIndex)]));
  const r = rects.get(headerCellId(sliceIndex));
  if (!r) return svg;

  const relocated = relocateRowLabels(svg, grid.rows.length, r.left);
  const transform = readGraphTransform(relocated);
  const toRootX = (x: number): number => transform.toRoot(x, 0).x;

  let x0 = toRootX(r.left);
  let x1 = toRootX(r.right);
  const labels = rowLabelXRange(relocated, grid.rows.length, toRootX);
  if (labels) {
    x0 = Math.min(x0, labels.x0);
    x1 = Math.max(x1, labels.x1);
  }
  return dropOffscreenEdges(cropCanvas(relocated, { x0, x1 }), toRootX);
}

const LABEL_GAP = 12; // graph-space gap between a relocated label's right edge and the slice's own left edge

/**
 * Move every row's label `<text>` (graph-space, still text-anchor="middle") to sit
 * just left of `leftGraphX` — this slice's own header-cell left edge — instead of
 * its original position in the model-wide label gutter. Each row keeps its own
 * halfWidth (same character-count/font-size estimate rowLabelXRange uses), so a
 * "Fulfillment Board"-length label still gets enough room, right-aligned with a
 * `LABEL_GAP` breathing space before the slice starts. Rows with no label text
 * (the header row) or no rect (shouldn't happen, but matches this file's other
 * defensive misses) are left untouched.
 */
function relocateRowLabels(svg: string, rowCount: number, leftGraphX: number): string {
  let out = svg;
  for (let r = 0; r < rowCount; r++) {
    const re = new RegExp(`(<title>${rowLabelId(r)}<\\/title>)([\\s\\S]*?)(<\\/g>)`);
    const m = re.exec(out);
    if (!m) continue;
    const textM = TEXT.exec(m[2]);
    if (!textM) continue; // header row's label is "" — plaintext emits no <text> at all
    const fontSize = +(attr(textM[1], "font-size") ?? 10);
    const halfWidth = (decode(textM[2]).length * fontSize) / 2 + 4;
    const newX = leftGraphX - LABEL_GAP - halfWidth;
    if (!/\bx="(-?[\d.]+)"/.test(textM[1])) continue; // no x to relocate — leave as-is
    const newText = textM[0].replace(/\bx="(-?[\d.]+)"/, `x="${newX}"`);
    const newBody = m[2].slice(0, textM.index) + newText + m[2].slice(textM.index + textM[0].length);
    out = out.slice(0, m.index) + m[1] + newBody + m[3] + out.slice(m.index + m[0].length);
  }
  return out;
}

/**
 * Drop every `em-edges` path whose bounding box falls entirely outside the (already
 * cropped) viewBox — edges are drawn for the whole model, not just the slice being
 * cropped to, so a cross-slice arrow many columns away from this one is common (see
 * cropToSlice's callers) and, left in, is pure dead weight in an already-cropped file.
 * Worse than dead weight, in fact: a `marker-end` arrowhead anchored entirely outside
 * the canvas crashes resvg's in-process PNG rasterizer (a native panic, not a
 * catchable JS exception) — see the regression test for the concrete repro. A path
 * only *partially* outside the crop (the "truncated at the boundary" case the ticket
 * accepts) is left alone; only ones with zero overlap are removed.
 *
 * Returns `svg` unchanged if its viewBox can't be parsed (defensive, matches
 * cropCanvas's own guard).
 */
function dropOffscreenEdges(svg: string, toRootX: (x: number) => number): string {
  const vb = /viewBox="([\d.eE+-]+)\s+[\d.eE+-]+\s+([\d.eE+-]+)\s+[\d.eE+-]+"/.exec(svg);
  if (!vb) return svg;
  const visibleLeft = +vb[1];
  const visibleRight = visibleLeft + +vb[2];

  return svg.replace(/<g class="em-edges">([\s\S]*?)<\/g>/, (_whole, body: string) => {
    const paths = body.match(/<path\b[^>]*\/>/g) ?? [];
    const kept = paths.filter((path: string) => {
      const d = /\bd="([^"]*)"/.exec(path)?.[1] ?? "";
      const nums = (d.match(NUM) ?? []).map(Number);
      const xs: number[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) xs.push(toRootX(nums[i]));
      if (xs.length === 0) return true; // unparseable — keep it, don't silently drop
      const left = Math.min(...xs);
      const right = Math.max(...xs);
      return right >= visibleLeft && left <= visibleRight; // any overlap at all
    });
    return `<g class="em-edges">${kept.join("")}</g>`;
  });
}

/** Estimate the row-label column's x-range from its `<text>` elements — see the
 *  file header comment for why this can't go through parseNodeRects. `toRootX`
 *  converts the graph-space text position (and the estimated half-width around
 *  it) into root/viewBox space — see buildSliceOverlay's comment. Returns null
 *  if no row label rendered any text (e.g. an empty model). */
function rowLabelXRange(
  svg: string,
  rowCount: number,
  toRootX: (x: number) => number,
): { x0: number; x1: number } | null {
  let range: { x0: number; x1: number } | null = null;
  for (let r = 0; r < rowCount; r++) {
    // Scoped to this row's own node group (up to its closing </g>) rather than a
    // fixed-length lookahead — the header row's label is always "" (no <text> of
    // its own), and a fixed window would otherwise pick up the *next* row's text.
    const body = new RegExp(`<title>${rowLabelId(r)}<\\/title>([\\s\\S]*?)<\\/g>`).exec(svg)?.[1];
    if (!body) continue;
    const m = TEXT.exec(body);
    if (!m) continue; // the header row's label is "" — plaintext emits no <text> at all
    const x = +(attr(m[1], "x") ?? NaN);
    if (Number.isNaN(x)) continue;
    const fontSize = +(attr(m[1], "font-size") ?? 10);
    const halfWidth = (decode(m[2]).length * fontSize) / 2 + 4; // + a little breathing room
    const x0 = toRootX(x - halfWidth);
    const x1 = toRootX(x + halfWidth);
    range = range ? { x0: Math.min(range.x0, x0), x1: Math.max(range.x1, x1) } : { x0, x1 };
  }
  return range;
}

function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="(-?[\\d.]+)"`).exec(attrs)?.[1];
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
