// SPDX-License-Identifier: MIT
// Emits Graphviz DOT for a normalized model using the strict-grid technique:
//   - one heavily-weighted invisible vertical edge chain per column locks columns
//   - one `rank=same` group per row locks rows and orders cells left -> right
//   - a fixed-width title cell per slice anchors the column widths
//   - empty coordinates are invisible spacers; elements are floating boxes
//
// No semantic arrows are emitted here: Graphviz only lays out the grid and
// renders the boxes/labels. The renderer reads each box's rectangle back out of
// the rendered SVG and draws the arrows itself (see src/render/drawEdges.ts), so
// it has full control over straight within-slice lines and curved cross-slice
// lines instead of fighting Graphviz's global edge router.

import { Element, NormalizedModel } from "../model/model.js";
import { Grid, headerCellId, nodeIdAt, placeholderId } from "../layout/grid.js";
import { styleFor } from "./theme.js";

// Exported: src/render/statusOverlay.ts matches/replaces these exact strings
// to recolor a header cell post-layout based on its slice's doc status.
export const HEADER_FILL = "#E3E7EB";
export const HEADER_BORDER = "#C7CDD4";
export const HEADER_FONT = "#1F2933";
// Every cell is the same width so columns are evenly spaced and the header row
// lines up with the element columns. Header width (pt) must match CELL_W (in).
const CELL_W = 2.0; // inches
const CELL_H = 0.62;
const HEADER_H = 0.46;

export function emitDot(model: NormalizedModel, grid: Grid): string {
  const L: string[] = [];

  L.push(`digraph EventModel {`);
  L.push(
    `  graph [rankdir=TB, splines=false, nodesep=0.35, ranksep="0.5 equally", ` +
      `fontname="Helvetica", fontsize=18, labelloc="t", label=${q(model.name)}];`,
  );
  L.push(
    `  node [shape=box, style="filled", fontname="Helvetica", fontsize=11, ` +
      `margin="0.18,0.10", penwidth=1.3];`,
  );
  L.push(`  edge [fontname="Helvetica", fontsize=9];`);
  L.push("");

  // ---- row label nodes (leftmost column) ----
  L.push("  // row (swimlane) labels");
  grid.rows.forEach((row, r) => {
    L.push(
      `  ${rowLabelId(r)} [shape=plaintext, style="", label=${q(row.label)}, ` +
        `fontsize=10, fontcolor="#5F6368"];`,
    );
  });
  L.push("");

  // ---- cell nodes ----
  L.push("  // cells");
  grid.rows.forEach((row, r) => {
    // MIL-26: every no-fields box in a swimlane shares one height — the tallest any of
    // them needs — so a row with one wrapped 3-line label doesn't leave its neighbors
    // (including the invisible empty-cell spacers) looking shorter and misaligned.
    // Fields-bearing boxes are deliberately excluded: their HTML-table height is fixed
    // by Graphviz during layout, not something computable here before that pass runs,
    // so they keep their existing independent auto-grow behavior (docs/dsl.md already
    // documents this as acceptable — "tops drift slightly when field counts differ").
    const rowHeight = row.band === "header" ? HEADER_H : rowBoxHeight(grid, r);
    for (let c = 0; c < grid.cols; c++) {
      if (row.band === "header") {
        L.push("  " + headerCell(c, grid.sliceNames[c]));
      } else {
        const el = grid.cells[r][c];
        L.push("  " + (el ? elementCell(el, rowHeight) : emptyCell(r, c, rowHeight)));
      }
    }
  });
  L.push("");

  // ---- rigid grid: weighted invisible vertical chains per column ----
  L.push("  // column locks");
  L.push(`  edge [style=invis, weight=1000, arrowhead=none];`);
  L.push("  " + columnChain(grid, -1) + ";"); // label column
  for (let c = 0; c < grid.cols; c++) {
    L.push("  " + columnChain(grid, c) + ";");
  }
  L.push("");

  // ---- rows: rank=same + left-right ordering ----
  L.push("  // row ranks");
  grid.rows.forEach((_row, r) => {
    const ids = [rowLabelId(r)];
    for (let c = 0; c < grid.cols; c++) ids.push(nodeIdAt(grid, r, c));
    L.push(`  { rank=same; ${ids.join(" -> ")} [style=invis, arrowhead=none]; }`);
  });

  L.push(`}`);
  return L.join("\n");
}

// inches, ~13.2pt at fontsize 11
const LINE_H = 0.1833;
// inches, ~12pt top+bottom padding inside a fixedsize box
const V_PAD = 0.1667;

/** A no-fields box's own natural height — CELL_H, or taller if its wrapped label
 *  needs more than one line. The per-row max of this (see rowBoxHeight) is what
 *  every no-fields box and empty-cell spacer in that row actually renders at. */
function naturalBoxHeight(name: string): number {
  const lineCount = wrap(name, 18).length;
  return Math.max(CELL_H, lineCount * LINE_H + V_PAD);
}

/** The uniform height for every no-fields box (and empty-cell spacer) in row `r` —
 *  the tallest natural height among that row's no-fields elements, or CELL_H if the
 *  row has none. Fields-bearing elements don't contribute: their real rendered
 *  height is decided by Graphviz's HTML-table layout, not known at DOT-emission
 *  time, so they're excluded from this max (see the call site's comment). */
function rowBoxHeight(grid: Grid, r: number): number {
  let max = CELL_H;
  for (let c = 0; c < grid.cols; c++) {
    const el = grid.cells[r][c];
    if (el && !(el.fields && el.fields.length > 0)) {
      max = Math.max(max, naturalBoxHeight(el.name));
    }
  }
  return max;
}

function elementCell(el: Element, rowHeight: number): string {
  const s = styleFor(el.kind);
  const shape = el.kind === "ui" ? `"filled"` : `"filled,rounded"`;
  if (el.fields && el.fields.length > 0) {
    // UML-style box: title, a divider rule, then the fields. The HTML table
    // auto-sizes the box (height grows with the field count); width stays at
    // CELL_W as a minimum so columns stay aligned. Arrows still anchor to the
    // box edges read back from the SVG, so they remain stable. Deliberately NOT
    // sized to rowHeight — see rowBoxHeight's doc comment.
    return (
      `${el.id} [label=${fieldLabel(el)}, fillcolor="${s.fill}", ` +
      `color="${s.stroke}", fontcolor="${s.fontColor}", style=${shape}, ` +
      `shape=box, fixedsize=false, width=${CELL_W}, margin="0.04,0.03"];`
    );
  }
  return (
    `${el.id} [label=${q(wrapLabel(el.name))}, fillcolor="${s.fill}", ` +
    `color="${s.stroke}", fontcolor="${s.fontColor}", style=${shape}, ` +
    `fixedsize=true, width=${CELL_W}, height=${rowHeight}];`
  );
}

/** Graphviz HTML-table label: bold title, a horizontal rule, one row per field. */
function fieldLabel(el: Element): string {
  const rows: string[] = [];
  rows.push(`<TR><TD><B>${esc(el.name)}</B></TD></TR>`);
  rows.push(`<HR/>`);
  for (const f of el.fields ?? []) {
    const ftype = f.type ? ` : <FONT COLOR="#5F6368">${esc(f.type)}</FONT>` : "";
    rows.push(
      `<TR><TD ALIGN="LEFT"><FONT POINT-SIZE="9">${esc(f.name)}${ftype}</FONT></TD></TR>`,
    );
  }
  return (
    `<<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="1">` +
    rows.join("") +
    `</TABLE>>`
  );
}

/** Escape text for use inside a Graphviz HTML-like label. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Empty cells are invisible spacers that hold the column width and row height. */
function emptyCell(r: number, c: number, rowHeight: number): string {
  return `${placeholderId(r, c)} [label="", style=invis, fixedsize=true, width=${CELL_W}, height=${rowHeight}];`;
}

/** Fixed-size title cell per slice (same width as cells, so columns line up). */
function headerCell(c: number, name: string): string {
  return (
    `${headerCellId(c)} [label=${q(wrapLabel(name, 20))}, shape=box, ` +
    `style=filled, fillcolor="${HEADER_FILL}", color="${HEADER_BORDER}", ` +
    `fontcolor="${HEADER_FONT}", fontname="Helvetica-Bold", fontsize=10, ` +
    `fixedsize=true, width=${CELL_W}, height=${HEADER_H}, penwidth=1];`
  );
}

function columnChain(grid: Grid, col: number): string {
  const ids: string[] = [];
  grid.rows.forEach((_row, r) => {
    ids.push(col < 0 ? rowLabelId(r) : nodeIdAt(grid, r, col));
  });
  return ids.join(" -> ");
}

/** Node id of a row's swimlane label (leftmost column). Shared with the renderer
 *  so it can read the label column's rect for the storyboard viewer's slice
 *  overlay — see src/render/sliceOverlay.ts. */
export function rowLabelId(r: number): string {
  return `__row_${r}`;
}

/** Word-wrap long labels onto multiple lines for tidier boxes. */
function wrapLabel(name: string, max = 18): string {
  return wrap(name, max).join("\\n");
}

function wrap(name: string, max: number): string[] {
  const words = name.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (w.length <= max) {
      if (cur && (cur + " " + w).length > max) {
        lines.push(cur);
        cur = w;
      } else {
        cur = cur ? cur + " " + w : w;
      }
      continue;
    }
    // w has no whitespace and is longer than max on its own (e.g. a
    // PascalCase/camelCase identifier pasted in place of a phrase): break it
    // at natural boundaries so it still wraps instead of overflowing the
    // fixed-width box. Hard-chop any leftover piece still too long (e.g. a
    // single unbroken run of lowercase characters) as a last resort.
    if (cur) {
      lines.push(cur);
      cur = "";
    }
    for (const piece of splitLongToken(w, max)) {
      if (cur && (cur + piece).length > max) {
        lines.push(cur);
        cur = piece;
      } else {
        cur = cur + piece;
      }
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Break a single unspaced token at camelCase/PascalCase transitions and
 *  -, _, / separators; hard-chop any resulting piece still longer than max. */
function splitLongToken(word: string, max: number): string[] {
  const pieces = word.split(/(?=[A-Z][a-z])|(?<=[a-z0-9])(?=[A-Z])|[-_/]/).filter(Boolean);
  const result: string[] = [];
  for (const p of pieces) {
    if (p.length <= max) {
      result.push(p);
    } else {
      for (let i = 0; i < p.length; i += max) result.push(p.slice(i, i + max));
    }
  }
  return result;
}

/** Quote a string for DOT (label newlines already encoded as \n). */
function q(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}