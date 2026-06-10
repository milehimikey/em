// SPDX-License-Identifier: MIT
// Ties the stages together: source -> AST -> model -> grid -> diagnostics -> DOT.

import { parse } from "./parser/parser.js";
import { normalize, NormalizedModel } from "./model/model.js";
import { layout, Grid, LayoutOptions } from "./layout/grid.js";
import { validate, Diagnostic } from "./model/validate.js";
import { emitDot } from "./emit/dot.js";

export type CompileOptions = LayoutOptions;

export interface CompileResult {
  model: NormalizedModel;
  grid: Grid;
  diagnostics: Diagnostic[];
  dot: string;
}

export function compile(source: string, opts: CompileOptions = {}): CompileResult {
  const ast = parse(source);
  const model = normalize(ast);
  const grid = layout(model, opts);
  const diagnostics = validate(model, grid);
  const dot = emitDot(model, grid);
  return { model, grid, diagnostics, dot };
}