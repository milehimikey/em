// SPDX-License-Identifier: MIT
// Storyline bands and stub dimming for the rendered SVG (GH #277).
//
// Graphviz lays the storyline row out as one filled box per column belonging to a storyline
// (emit/dot.ts). This reads those boxes' rectangles back out and draws one continuous labelled
// band per run of columns — bridging the inter-column gaps — plus, for an `em render
// --storyline` subset, dims the stub columns (elements the storyline reads from outside it).

import { NormalizedModel } from "../model/model.js";
import { Grid, STORYLINE_KEY, headerCellId, placeholderId } from "../layout/grid.js";
import { storylineStyle } from "../emit/theme.js";
import { storylineRuns } from "../model/storylines.js";
import { Rect } from "./svgGeometry.js";

/** Row index of the storyline band row, or -1 when the grid has none. */
function bandRow(grid: Grid): number {
  return grid.rowIndexByKey.get(STORYLINE_KEY) ?? -1;
}

/** Node ids whose rectangles `buildStorylineBands` needs (the band row's real cells). */
export function storylineBandIds(grid: Grid): string[] {
  const r = bandRow(grid);
  if (r < 0) return [];
  const ids: string[] = [];
  for (let c = 0; c < grid.cols; c++) ids.push(placeholderId(r, c));
  return ids;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** One `<g class="em-storyline-band">` per run, in graph space (append inside the graph group,
 *  after the nodes). Returns "" when the model has no storylines. */
export function buildStorylineBands(model: NormalizedModel, grid: Grid, rects: Map<string, Rect>): string {
  const r = bandRow(grid);
  if (r < 0) return "";
  const parts: string[] = [];
  const seen = new Set<number>();
  for (const run of storylineRuns(model)) {
    const first = rects.get(placeholderId(r, run.fromCol));
    const last = rects.get(placeholderId(r, run.toCol));
    if (!first || !last) continue;
    const style = storylineStyle(run.index);
    const left = first.left;
    const width = last.right - first.left;
    const height = first.bottom - first.top;
    const continued = seen.has(run.index);
    seen.add(run.index);
    const label = continued ? `${run.storyline.name} (cont.)` : run.storyline.name;
    const maxChars = Math.max(4, Math.floor((width - 12) / 6.4));
    const shown = label.length > maxChars ? `${label.slice(0, Math.max(1, maxChars - 1))}…` : label;
    const tip = run.storyline.source ? `${run.storyline.name} — ${run.storyline.source}` : run.storyline.name;
    parts.push(
      `<g class="em-storyline-band" data-storyline="${esc(run.storyline.name)}">` +
        `<title>${esc(tip)}</title>` +
        `<rect x="${left}" y="${first.top}" width="${width}" height="${height}" rx="4" ` +
        `fill="${style.fill}" stroke="${style.stroke}" stroke-width="1"/>` +
        `<text text-anchor="middle" x="${left + width / 2}" y="${first.top + height / 2 + 4}" ` +
        `font-family="Helvetica-Bold, Helvetica, Arial, sans-serif" font-weight="bold" font-size="11" ` +
        `fill="${style.fontColor}">${esc(shown)}</text></g>`,
    );
  }
  return parts.join("");
}

const STUB_OPACITY = 0.4;

/** Dim every node of the stub columns (`Slice.stub`) — the header cell and each element — by
 *  adding an opacity attribute to its node group. */
export function dimStubColumns(svg: string, model: NormalizedModel): string {
  let out = svg;
  model.slices.forEach((slice, c) => {
    if (!slice.stub) return;
    const ids = [headerCellId(c), ...slice.elements.map((e) => e.id)];
    for (const id of ids) {
      const re = new RegExp(`(<g\\b[^>]*class="node")([^>]*>\\s*<title>${escapeRe(id)}</title>)`);
      out = out.replace(re, `$1 opacity="${STUB_OPACITY}"$2`);
    }
  });
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
