// Emits Graphviz DOT for a normalized model using the strict-grid technique:
//   - one heavily-weighted invisible vertical edge chain per column locks columns
//   - one `rank=same` group per row locks rows and orders cells left -> right
//   - a fixed-width title cell per slice anchors the column widths
//   - empty coordinates are invisible spacers; elements are floating boxes
//   - semantic arrows overlay with constraint=false and head/tail ports so
//     vertical neighbours connect as straight lines and routing stays clean.

import { AUTOMATION_KINDS, ElementKind } from "../parser/ast.js";
import { Element, NormalizedModel, normalizeName } from "../model/model.js";
import { Grid, headerCellId, nodeIdAt, placeholderId } from "../layout/grid.js";
import { edgeColorFor, styleFor } from "./theme.js";

const HEADER_FILL = "#E3E7EB";
const HEADER_BORDER = "#C7CDD4";
const COL_W = 154; // points — header width anchors a uniform column width
const HEADER_H = 34;

interface SemanticEdge {
  from: string;
  to: string;
  color: string;
}

export function emitDot(model: NormalizedModel, grid: Grid): string {
  const L: string[] = [];

  L.push(`digraph EventModel {`);
  L.push(
    `  graph [rankdir=TB, splines=ortho, nodesep=0.35, ranksep="0.5 equally", ` +
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
  L.push("");

  // ---- semantic overlay arrows ----
  // No fixed ports: let Graphviz route each arrow the shortest orthogonal path
  // to the nearest side of the next box.
  L.push("  // semantic arrows");
  L.push(
    `  edge [style=solid, weight=0, constraint=false, arrowsize=0.8, penwidth=1.5];`,
  );
  for (const e of semanticEdges(model)) {
    L.push(`  ${e.from} -> ${e.to} [color="${e.color}"];`);
  }

  L.push(`}`);
  return L.join("\n");
}

function elementCell(el: Element): string {
  const s = styleFor(el.kind);
  const shape = el.kind === "ui" ? `"filled"` : `"filled,rounded"`;
  return (
    `${el.id} [label=${q(wrapLabel(el.name))}, fillcolor="${s.fill}", ` +
    `color="${s.stroke}", fontcolor="${s.fontColor}", style=${shape}];`
  );
}

function emptyCell(r: number, c: number): string {
  return `${placeholderId(r, c)} [label="", style=invis, fixedsize=true, width=1.9, height=0.6];`;
}

/** Fixed-width title cell per slice (anchors the column width). */
function headerCell(c: number, name: string): string {
  return (
    `${headerCellId(c)} [shape=plaintext, label=<<TABLE BORDER="1" ` +
    `COLOR="${HEADER_BORDER}" CELLBORDER="0" CELLSPACING="0" CELLPADDING="6" ` +
    `BGCOLOR="${HEADER_FILL}" WIDTH="${COL_W}" HEIGHT="${HEADER_H}">` +
    `<TR><TD ALIGN="CENTER" VALIGN="MIDDLE">` +
    `<FONT COLOR="#1F2933" POINT-SIZE="10"><B>${htmlLabel(name, 20)}</B></FONT>` +
    `</TD></TR></TABLE>>];`
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

/** Infer pattern arrows from each slice plus cross-slice `from` sources. */
function semanticEdges(model: NormalizedModel): SemanticEdge[] {
  const edges: SemanticEdge[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string, kind: ElementKind | undefined) => {
    if (from === to) return;
    const key = `${from}>${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, color: edgeColorFor(kind) });
  };

  model.slices.forEach((slice, i) => {
    const uis = slice.elements.filter((e) => e.kind === "ui");
    const command = slice.elements.find((e) => e.kind === "command");
    const view = slice.elements.find((e) => e.kind === "view");
    const events = slice.elements.filter((e) => e.kind === "event");
    const auto = slice.elements.find((e) => AUTOMATION_KINDS.has(e.kind));

    // Input pattern: UI -> command -> event(s)
    if (command) {
      for (const ui of uis) add(ui.id, command.id, "ui");
      for (const ev of events) add(command.id, ev.id, "command");
    }

    // Automation/translation: it reads the read model in its own slice, then
    // triggers the command in the next slice.
    if (auto) {
      if (view) add(view.id, auto.id, "view");
      const nextCommand = model.slices[i + 1]?.elements.find(
        (e) => e.kind === "command",
      );
      if (nextCommand) add(auto.id, nextCommand.id, auto.kind);
      else for (const ev of events) add(auto.id, ev.id, auto.kind);
    }

    // Output pattern: view -> UI (read model feeds the screen)
    if (view) {
      for (const ui of uis) add(view.id, ui.id, "view");
      if ((view.from ?? []).length === 0) {
        for (const ev of events) add(ev.id, view.id, "event");
      }
    }
  });

  // Cross-slice `from` wiring:
  //   view       from event(s)      -> event -> view
  //   automation from read model(s) -> view  -> automation
  for (const el of model.elements) {
    for (const name of el.from ?? []) {
      const bucket = model.byName.get(normalizeName(name));
      if (!bucket) continue;
      const src =
        el.kind === "view"
          ? bucket.find((x) => x.kind === "event") ?? bucket[0]
          : bucket.find((x) => x.kind === "view") ?? bucket[0];
      if (src) add(src.id, el.id, src.kind);
    }
  }

  // Explicit arrows from the DSL.
  for (const a of model.arrows) {
    if (a.fromId && a.toId) add(a.fromId, a.toId, model.byId.get(a.fromId)?.kind);
  }

  return edges;
}

/** Word-wrap long labels onto multiple lines for tidier boxes. */
function wrapLabel(name: string, max = 18): string {
  return wrap(name, max).join("\\n");
}

/** Word-wrap + HTML-escape a label, using <BR/> between lines (header cells). */
function htmlLabel(name: string, max = 16): string {
  return wrap(name, max).map(htmlEscape).join("<BR/>");
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

function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Quote a string for DOT (label newlines already encoded as \n). */
function q(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}
