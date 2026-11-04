// SPDX-License-Identifier: MIT
// Ties the stages together: source -> AST -> model -> grid -> diagnostics -> DOT.

import { parse } from "./parser/parser.js";
import { normalize, NormalizedModel } from "./model/model.js";
import { layout, Grid, LayoutOptions } from "./layout/grid.js";
import { validate, Diagnostic } from "./model/validate.js";
import { computeRefs, RefsResult } from "./model/refs.js";
import { emitDot } from "./emit/dot.js";
import { attributeDiagnosticFiles, loadModelAst, loadModelAstFromText, LoadedModelAst, SourceReader } from "./model/loadModel.js";
import type { ModelNode } from "./parser/ast.js";

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
  return compileAst(parse(source), opts);
}

/** The stages after parsing, shared by `compile` (one text) and `compileModelFile` (a root plus
 *  its storyline model files, GH #421). */
export function compileAst(ast: ModelNode, opts: CompileOptions = {}): CompileResult {
  const model = normalize(ast);
  const grid = layout(model, opts);
  const refs = computeRefs(model);
  const diagnostics = attributeDiagnosticFiles(model, refs, [...validate(model, grid, refs), ...refs.diagnostics]);
  const dot = emitDot(model, grid);
  return { model, grid, refs, diagnostics, dot };
}

/** A compiled root model plus the texts it was compiled from (GH #421). `source` is the root
 *  file's text (line-based edits of root entities use it); `files`/`sources` are the storyline
 *  model files; `hashSource` is what a model-level hash covers. */
export interface CompiledModelFile extends CompileResult, LoadedModelAst {}

/** Compile a root model FILE: the root text plus every storyline model file it declares, as one
 *  model. Throws `ParseError` (either file) or `ModelLoadError` (a storyline file that cannot be
 *  read or whose header disagrees with the root). */
export function compileModelFile(file: string, opts: CompileOptions = {}): CompiledModelFile {
  const loaded = loadModelAst(file);
  return { ...compileAst(loaded.ast, opts), ...loaded };
}

/** Same, from texts already in hand (a git revision): `read` resolves storyline files. */
export function compileModelText(rootSource: string, read: SourceReader, rootLabel: string, opts: CompileOptions = {}): CompiledModelFile {
  const loaded = loadModelAstFromText(rootSource, read, rootLabel);
  return { ...compileAst(loaded.ast, opts), ...loaded };
}