// SPDX-License-Identifier: MIT
// Turns a normalized model into a rigid R x C grid.
//
// Rows (bands), top -> bottom:
//   -. storyline     (only when the model declares `storyline` blocks, GH #277: a labelled band
//                     per run of a storyline's columns, drawn in render/storylineBands.ts)
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

export type Band = "storyline" | "header" | "automation" | "ui" | "api" | "event";

export const HEADER_KEY = "__header";
export const STORYLINE_KEY = "__storyline";

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

/** Every alternative of the given event's `event A | B @Ctx` line, in declaration order
 *  (just the event itself when it has no alternatives). The first one is the grid cell's element. */
export function alternativesOf(model: NormalizedModel, el: Element): Element[] {
  if (el.alternativeGroup === undefined) return [el];
  return model.elements.filter((e) => e.alternativeGroup === el.alternativeGroup && e.sliceIndex === el.sliceIndex);
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

/** A `view … again` instance may share an api cell with other `again` instances (GH #287). */
function isStackable(el: Element): boolean {
  return el.kind === "view" && el.again === true;
}

/** The deepest api-cell stack any column needs: the largest count of `again` views in one slice
 *  whose api cell holds nothing but `again` views. 1 when nothing stacks. */
function apiStackDepth(model: NormalizedModel): number {
  let depth = 1;
  for (const slice of model.slices) {
    const api = slice.elements.filter((e) => e.kind === "command" || e.kind === "view");
    if (api.length > 1 && api.every(isStackable)) depth = Math.max(depth, api.length);
  }
  return depth;
}

/** Slice indexes that are continuation-shaped: every non-`ui` element is an `again` view (at
 *  least one). Only these slices stack their `ui` boxes (GH #287). */
function continuationSlices(model: NormalizedModel): Set<number> {
  const out = new Set<number>();
  for (const slice of model.slices) {
    const nonUi = slice.elements.filter((e) => e.kind !== "ui");
    if (nonUi.length > 0 && nonUi.every(isStackable)) out.add(slice.index);
  }
  return out;
}

/** Per persona, the deepest ui-cell stack any continuation column needs (screens of one persona
 *  stack like the views do in the api lane). */
function uiStackDepths(model: NormalizedModel, continuation: Set<number>): Map<string, number> {
  const depths = new Map<string, number>();
  for (const slice of model.slices) {
    if (!continuation.has(slice.index)) continue;
    const counts = new Map<string, number>();
    for (const e of slice.elements) if (e.kind === "ui") counts.set(e.persona!, (counts.get(e.persona!) ?? 0) + 1);
    for (const [persona, n] of counts) depths.set(persona, Math.max(depths.get(persona) ?? 1, n));
  }
  return depths;
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

  if ((model.storylines ?? []).length > 0) {
    rows.push({ key: STORYLINE_KEY, label: "Storyline", band: "storyline" });
  }
  rows.push({ key: HEADER_KEY, label: "", band: "header" });
  if (model.hasAutomation) {
    rows.push({ key: "automation", label: "Automation", band: "automation" });
  }
  const continuation = continuationSlices(model);
  const uiDepths = uiStackDepths(model, continuation);
  for (const persona of model.personas) {
    rows.push({ key: `ui:${persona}`, label: persona, band: "ui" });
    // GH #287: extra rows (`ui:<persona>:2`, …) for screens stacked in one continuation column.
    for (let n = 2; n <= (uiDepths.get(persona) ?? 1); n++) rows.push({ key: `ui:${persona}:${n}`, label: "", band: "ui" });
  }
  rows.push({ key: "api", label: "API", band: "api" });
  for (const context of model.contexts) {
    rows.push({ key: `event:${context}`, label: context, band: "event" });
  }

  // GH #287: several `again` views of one continuation slice stack in its api cell, so the api
  // lane grows by one extra row per additional stacked view (`api:2`, `api:3`, …) — only the
  // columns that stack use them, every other cell there is an invisible spacer.
  const stackDepth = apiStackDepth(model);
  if (stackDepth > 1) {
    const apiAt = rows.findIndex((r) => r.key === "api");
    const extra: GridRow[] = [];
    for (let n = 2; n <= stackDepth; n++) extra.push({ key: `api:${n}`, label: "", band: "api" });
    rows.splice(apiAt + 1, 0, ...extra);
  }

  const indexOf = new Map<string, number>();
  rows.forEach((r, i) => indexOf.set(r.key, i));

  const cols = model.slices.length;
  const cells: (Element | null)[][] = rows.map(() =>
    new Array<Element | null>(cols).fill(null),
  );
  const collisions: Collision[] = [];

  const stacked = new Map<number, number>(); // col -> views already in its api cell
  const uiStacked = new Map<string, number>(); // `${persona}|${col}` -> screens already in that ui cell
  for (const el of model.elements) {
    let r = indexOf.get(rowKeyForElement(el));
    if (r === undefined) continue; // unreachable, rows cover all kinds
    const c = el.sliceIndex;
    // GH #287: `again` views stack in the api lane, and screens of one persona stack in its ui
    // lane, inside a continuation column.
    if (isStackable(el) && cells[r][c] && isStackable(cells[r][c]!)) {
      const depth = (stacked.get(c) ?? 1) + 1;
      stacked.set(c, depth);
      r = indexOf.get(`api:${depth}`)!;
    }
    if (el.kind === "ui" && cells[r][c] && continuation.has(c)) {
      const k = `${el.persona}|${c}`;
      const depth = (uiStacked.get(k) ?? 1) + 1;
      uiStacked.set(k, depth);
      r = indexOf.get(`ui:${el.persona}:${depth}`)!;
    }
    const occupant = cells[r][c];
    // GH #278: alternatives of one `event A | B @Ctx` line share their context's cell — the
    // first is the cell's element, the rest are drawn inside its box (emit/dot.ts).
    if (occupant && el.alternativeGroup !== undefined && occupant.alternativeGroup === el.alternativeGroup) continue;
    if (occupant) {
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