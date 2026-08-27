// SPDX-License-Identifier: MIT
// Tags each element's rendered node group with its slice index, and embeds a
// <metadata> block describing every slice's name, x-range, and resolved design
// doc (as rendered HTML) in the SVG.
//
// This is what lets the storyboard mode in the live viewer (`em watch --serve`,
// see src/render/serve.ts) highlight and pan/zoom to one slice at a time, and
// (MIL-153) open a flyout with a slice's own doc on click — entirely
// client-side, with no separate data fetch — everything the browser needs
// travels inside the SVG it already loads.
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
import { SliceDoc } from "../catalog/sliceDoc.js";
import { decode, readGraphTransform, NODE_GROUP, TITLE, Rect } from "./svgGeometry.js";

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
  /** The slice's resolved design doc, rendered to HTML (see catalog/sliceDoc.ts's
   *  marked-based `.html`), or null if it has none yet — the live view's slice-click
   *  flyout (MIL-153) renders this directly, with no separate fetch. */
  docHtml: string | null;
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
 *  conversion fitCanvas() applies to the edge-detour bbox for the same reason.
 *
 *  `docs` is each slice's resolved doc (or null), same order as `grid`'s columns —
 *  see render/sliceStatus.ts's `readSliceDocs`, the same resolution that colors the
 *  slice's header by status. */
export function buildSliceOverlay(
  svg: string,
  grid: Grid,
  rects: Map<string, Rect>,
  docs: (SliceDoc | null)[],
): string {
  const transform = readGraphTransform(svg);
  const toRootX = (x: number): number => transform.toRoot(x, 0).x;

  const slices: SliceRange[] = [];
  for (let c = 0; c < grid.cols; c++) {
    const r = rects.get(headerCellId(c));
    if (!r) continue;
    slices.push({
      index: c,
      name: grid.sliceNames[c],
      x0: toRootX(r.left),
      x1: toRootX(r.right),
      docHtml: docs[c]?.html ?? null,
    });
  }
  if (slices.length === 0) return "";

  const rowLabels = rowLabelXRange(svg, grid.rows.length, toRootX);
  const payload = { slices, rowLabels };
  const metadata = `<metadata id="em-slices">${escXml(JSON.stringify(payload))}</metadata>`;
  const style = `<style>.em-slice-dim{opacity:.15;transition:opacity .15s ease}</style>`;
  return metadata + style;
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
