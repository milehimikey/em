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

const HEADER_FILL = "#E3E7EB";
const HEADER_BORDER = "#C7CDD4";
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
    for (let c = 0; c < grid.cols; c++) {
      if (row.band === "header") {
        L.push("  " + headerCell(c, grid.sliceNames[c]));
      } else {
        const el = grid.cells[r][c];
        L.push("  " + (el ? elementCell(el) : emptyCell(r, c)));
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

function elementCell(el: Element): string {
  const s = styleFor(el.kind);
  const shape = el.kind === "ui" ? `"filled"` : `"filled,rounded"`;
  if (el.fields && el.fields.length > 0) {
    // UML-style box: title, a divider rule, then the fields. The HTML table
    // auto-sizes the box (height grows with the field count); width stays at
    // CELL_W as a minimum so columns stay aligned. Arrows still anchor to the
    // box edges read back from the SVG, so they remain stable.
    return (
      `${el.id} [label=${fieldLabel(el)}, fillcolor="${s.fill}", ` +
      `color="${s.stroke}", fontcolor="${s.fontColor}", style=${shape}, ` +
      `shape=box, fixedsize=false, width=${CELL_W}, margin="0.04,0.03"];`
    );
  }
  return (
    `${el.id} [label=${q(wrapLabel(el.name))}, fillcolor="${s.fill}", ` +
    `color="${s.stroke}", fontcolor="${s.fontColor}", style=${shape}, ` +
    `fixedsize=true, width=${CELL_W}, height=${CELL_H}];`
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
function emptyCell(r: number, c: number): string {
  return `${placeholderId(r, c)} [label="", style=invis, fixedsize=true, width=${CELL_W}, height=${CELL_H}];`;
}

/** Fixed-size title cell per slice (same width as cells, so columns line up). */
function headerCell(c: number, name: string): string {
  return (
    `${headerCellId(c)} [label=${q(wrapLabel(name, 20))}, shape=box, ` +
    `style=filled, fillcolor="${HEADER_FILL}", color="${HEADER_BORDER}", ` +
    `fontcolor="#1F2933", fontname="Helvetica-Bold", fontsize=10, ` +
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

function rowLabelId(r: number): string {
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
    if (cur && (cur + " " + w).length > max) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? cur + " " + w : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Quote a string for DOT (label newlines already encoded as \n). */
function q(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}