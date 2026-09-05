// SPDX-License-Identifier: MIT
// `em query`'s sub-pipeline (MIL-168): `parse -> normalize -> computeRefs -> buildIndex`,
// skipping `pipeline.ts`'s own `layout()` (the dense per-cell Grid allocation — rows x slice
// columns) and `emitDot()` entirely. Neither is query work: nothing here renders, and
// `layout()`'s only diagnostic contribution `validate()` reads is `grid.collisions` (row/col
// placement clashes — a rendering-only concern, `src/model/validate.ts` greps clean for any
// other `grid.` use). `EMPTY_GRID` below hands `validate()` a real, empty `Grid` shape instead
// of computing one, so query pays zero layout cost while every OTHER validate.ts diagnostic
// (unresolved refs, dangling views, tag/field completeness, ...) still runs at full strength.
//
// validate() itself is deliberately still called, one explicit deviation from this ticket's
// design note (which named it alongside layout/DOT as work to skip): the CLI/MCP contract
// this ticket also specifies is "refuse (exit 1) if a model has compile errors," the same
// `hasErrors(diagnostics)` gate `em export`/`em status`/every other JSON surface uses — dropping
// validate() would mean `em query` silently traverses a model with unresolved references
// instead of refusing, a behavior change from every sibling command with no upside once
// layout's own cost is already zero. See this ticket's report for the full tradeoff.

import { parse } from "../parser/parser.js";
import { normalize, NormalizedModel } from "../model/model.js";
import { computeRefs, RefsResult } from "../model/refs.js";
import { validate, Diagnostic } from "../model/validate.js";
import { buildModelIndex, ModelIndex } from "../model/queryIndex.js";
import type { Grid } from "../layout/grid.js";

const EMPTY_GRID: Grid = { rows: [], cols: 0, sliceNames: [], cells: [], rowIndexByKey: new Map(), collisions: [] };

export interface QueryCompileResult {
  model: NormalizedModel;
  refs: RefsResult;
  diagnostics: Diagnostic[];
  index: ModelIndex;
}

/** Compile one `.em` source for query use: parse + normalize + refs + validate (grid-free, see
 *  header) + the ModelIndex every verb queries. `baseDir` is the `.em` file's own directory —
 *  same doc-resolution convention every other command uses (passed straight through to
 *  `buildModelIndex`'s slice-doc join). Throws `ParseError` on a syntax error, same as
 *  `pipeline.ts`'s `compile()` — callers (cli.ts's compileFile-style wrapper, the MCP tool)
 *  catch it the same way. */
export function compileForQuery(source: string, baseDir: string): QueryCompileResult {
  const ast = parse(source);
  const model = normalize(ast);
  const refs = computeRefs(model);
  const diagnostics = [...validate(model, EMPTY_GRID, refs), ...refs.diagnostics];
  const index = buildModelIndex(model, refs, baseDir);
  return { model, refs, diagnostics, index };
}
