// SPDX-License-Identifier: MIT
// Turns a normalized model into a rigid R x C grid.
//
// Rows (bands), top -> bottom:
//   0. header        (slice names — one visible cell per column)
//   1. automation    (single row, only if the model uses automation elements)
//   2. ui            (one row per persona)
//   3. api           (commands + read models share one row — the system's API)
//   4. event         (one row per context/concept)
//
// Columns = slices, in declaration order (time, left -> right).
//
// Every (row, col) without a real element becomes an invisible placeholder so
// that rank chains and weighted column edges keep the grid perfectly aligned.

import { Element, NormalizedModel } from "../model/model.js";

export type Band = "header" | "automation" | "ui" | "api" | "event";

export const HEADER_KEY = "__header";

export interface GridRow {
  key: string;
  label: string;
  band: Band;
}

export interface Collision {
  rowKey: string;
  col: number;
  kept: Element;
  dropped: Element;
}

export interface Grid {
  rows: GridRow[];
  cols: number;
  /** Slice names, one per column (rendered in the header row). */
  sliceNames: string[];
  /** cells[rowIndex][colIndex] — real element or null (placeholder/header). */
  cells: (Element | null)[][];
  rowIndexByKey: Map<string, number>;
  collisions: Collision[];
}

export interface LayoutOptions {
  /** Keep the structural command/view rows even when empty. */
  keepEmptyLanes?: boolean;
}

export function placeholderId(row: number, col: number): string {
  return `__ph_${row}_${col}`;
}

export function headerCellId(col: number): string {
  return `__hdr_${col}`;
}

/** Node id at a grid coordinate (header cell, element, or placeholder). */
export function nodeIdAt(grid: Grid, row: number, col: number): string {
  if (grid.rows[row].band === "header") return headerCellId(col);
  const el = grid.cells[row][col];
  return el ? el.id : placeholderId(row, col);
}

function rowKeyForElement(el: Element): string {
  switch (el.kind) {
    case "ui":
      return `ui:${el.persona}`;
    case "command":
    case "view":
      return "api";
    case "event":
      return `event:${el.context}`;
    case "automation":
    case "processor":
    case "saga":
    case "translation":
      return "automation";
  }
}

export function layout(model: NormalizedModel, opts: LayoutOptions = {}): Grid {
  const rows: GridRow[] = [];

  rows.push({ key: HEADER_KEY, label: "", band: "header" });
  if (model.hasAutomation) {
    rows.push({ key: "automation", label: "Automation", band: "automation" });
  }
  for (const persona of model.personas) {
    rows.push({ key: `ui:${persona}`, label: persona, band: "ui" });
  }
  rows.push({ key: "api", label: "API", band: "api" });
  for (const context of model.contexts) {
    rows.push({ key: `event:${context}`, label: context, band: "event" });
  }

  const indexOf = new Map<string, number>();
  rows.forEach((r, i) => indexOf.set(r.key, i));

  const cols = model.slices.length;
  const cells: (Element | null)[][] = rows.map(() =>
    new Array<Element | null>(cols).fill(null),
  );
  const collisions: Collision[] = [];

  for (const el of model.elements) {
    const r = indexOf.get(rowKeyForElement(el));
    if (r === undefined) continue; // unreachable, rows cover all kinds
    const c = el.sliceIndex;
    if (cells[r][c]) {
      collisions.push({ rowKey: rows[r].key, col: c, kept: cells[r][c]!, dropped: el });
      continue;
    }
    cells[r][c] = el;
  }

  // Collapse the API lane only if the model has no commands or read models.
  const keep = rows.map((row, r) => {
    if (opts.keepEmptyLanes) return true;
    if (row.band !== "api") return true;
    return cells[r].some((c) => c !== null);
  });

  const keptRows: GridRow[] = [];
  const keptCells: (Element | null)[][] = [];
  rows.forEach((row, r) => {
    if (keep[r]) {
      keptRows.push(row);
      keptCells.push(cells[r]);
    }
  });

  const rowIndexByKey = new Map<string, number>();
  keptRows.forEach((r, i) => rowIndexByKey.set(r.key, i));

  return {
    rows: keptRows,
    cols,
    sliceNames: model.slices.map((s) => s.name),
    cells: keptCells,
    rowIndexByKey,
    collisions,
  };
}