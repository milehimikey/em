// SPDX-License-Identifier: MIT
// Ties the stages together: source -> AST -> model -> grid -> diagnostics -> DOT.

import { parse } from "./parser/parser.js";
import { normalize, NormalizedModel } from "./model/model.js";
import { layout, Grid, LayoutOptions } from "./layout/grid.js";
import { validate, Diagnostic } from "./model/validate.js";
import { computeRefs, RefsResult } from "./model/refs.js";
import { emitDot } from "./emit/dot.js";

export type CompileOptions = LayoutOptions;

export interface CompileResult {
  model: NormalizedModel;
  grid: Grid;
  /** Export-stable identity (slice keys, element/type refs) — computed exactly once per
   *  compile (MIL-91) so `em export`/`em diff`/`em catalog` reuse it instead of recomputing,
   *  which would double-emit `computeRefs()`'s own ref-collision diagnostics. */
  refs: RefsResult;
  /** validate()'s diagnostics plus refs' ref-collision warnings, combined — every command
   *  that only ever prints `diagnostics` (validate/render/watch/glossary) now sees
   *  collision warnings too, previously visible only to commands that called
   *  computeRefs() themselves. */
  diagnostics: Diagnostic[];
  dot: string;
}

export function compile(source: string, opts: CompileOptions = {}): CompileResult {
  const ast = parse(source);
  const model = normalize(ast);
  const grid = layout(model, opts);
  const refs = computeRefs(model);
  const diagnostics = [...validate(model, grid, refs), ...refs.diagnostics];
  const dot = emitDot(model, grid);
  return { model, grid, refs, diagnostics, dot };
}