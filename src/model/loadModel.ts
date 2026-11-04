// SPDX-License-Identifier: MIT
// GH #421 — storyline models. A root model may declare a storyline without a body:
//
//   storyline "Chase an overdue loan" after "Borrow and return a tool"
//
// and its slices live in `chase-an-overdue-loan/chase-an-overdue-loan.em` (or the path an
// `in "…"` clause names), a file that starts with `storyline "Chase an overdue loan" [source
// "…"]` and holds slice blocks. The ROOT is the compile unit: this loader reads the root and every
// storyline file and splices each file's slices in at the position of its declaration, so the
// composed timeline, `from`/`again` resolution, refs and validation see ONE model exactly as if the
// blocks were inline. A storyline file never compiles on its own; every slice and element it
// contributes carries `file` (posix, relative to the root's directory) so diagnostics and
// line-based edits know which file a line number belongs to.
//
// Step 1 of #421: the FILE split. Slice docs stay under the root's `slices/` and `note` paths in a
// storyline file are relative to the root's directory, exactly as before — moving docs into the
// storyline folders is step 2.

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse, parseStorylineFile, ParseError } from "../parser/parser.js";
import type { ModelNode, SliceNode } from "../parser/ast.js";
import type { NormalizedModel } from "./model.js";
import type { RefsResult } from "./refs.js";
import type { Diagnostic } from "./validate.js";

/** Reads a file's text given its path relative to the root model's directory (posix). Injected
 *  so `em diff`'s git-revision form can read a storyline file at a revision. */
export type SourceReader = (relPath: string) => string;

export interface LoadedModelAst {
  ast: ModelNode;
  /** The root file's text. */
  source: string;
  /** Every storyline model file read, posix-relative to the root's directory, in declaration order. */
  files: string[];
  /** Each file's text, keyed as in `files`. */
  sources: Record<string, string>;
  /** Root text followed by every storyline file's text (each under a `# -- file: <path>` line):
   *  the text a model-level hash covers, so a storyline edit changes the pin like a root edit. */
  hashSource: string;
}

export class ModelLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelLoadError";
  }
}

const toPosix = (p: string): string => p.split(sep).join("/");

/** The default reader: files relative to `rootDir` on disk. */
export function diskReader(rootDir: string): SourceReader {
  return (rel) => readFileSync(resolve(rootDir, rel), "utf8");
}

/**
 * Parse the root text and every storyline model file it declares, splicing each file's slices in
 * at its declaration's timeline position. `read` resolves storyline files; `rootLabel` names the
 * root in messages.
 */
export function loadModelAstFromText(rootSource: string, read: SourceReader, rootLabel = "model"): LoadedModelAst {
  const ast = parse(rootSource);
  const files: string[] = [];
  const sources: Record<string, string> = {};
  let offset = 0; // slices already spliced in before the current declaration
  for (const st of ast.storylines) {
    if (!st.external || st.file === undefined) continue;
    const rel = toPosix(st.file);
    if (isAbsolute(rel) || rel.startsWith("../") || rel.includes("/../")) {
      throw new ModelLoadError(`${rootLabel}:${st.line}: storyline "${st.name}" names a file outside the model's directory (${st.file}) — storyline models live under the root`);
    }
    let text: string;
    try {
      text = read(rel);
    } catch {
      throw new ModelLoadError(`${rootLabel}:${st.line}: storyline "${st.name}" declares its slices in ${rel}, which cannot be read — create it (a \`storyline "${st.name}"\` header, then slice blocks) or point \`in "…"\` at the right file`);
    }
    let parsed;
    try {
      parsed = parseStorylineFile(text);
    } catch (e) {
      if (e instanceof ParseError) throw new ModelLoadError(`parse error in ${rel} ${e.message}`);
      throw e;
    }
    if (parsed.header.name.trim().toLowerCase() !== st.name.trim().toLowerCase()) {
      throw new ModelLoadError(`${rel}:${parsed.header.line}: this file declares storyline "${parsed.header.name}" but the root (${rootLabel}:${st.line}) declares "${st.name}" — the two headers must agree`);
    }
    if (st.source === undefined) st.source = parsed.header.source;
    const slices: SliceNode[] = parsed.slices.map((sl) => ({
      ...sl,
      storyline: st.name,
      file: rel,
      elements: sl.elements.map((el) => ({ ...el, file: rel })),
    }));
    const at = (st.insertAt ?? ast.slices.length) + offset;
    ast.slices.splice(at, 0, ...slices);
    offset += slices.length;
    st.sliceNames = slices.map((s) => s.name);
    files.push(rel);
    sources[rel] = text;
  }
  const hashSource = [rootSource, ...files.map((f) => `# -- file: ${f}\n${sources[f]}`)].join("\n");
  return { ast, source: rootSource, files, sources, hashSource };
}

/** Load a root model file from disk (the common case). Throws `ModelLoadError` / `ParseError`. */
export function loadModelAst(file: string): LoadedModelAst {
  const rootSource = readFileSync(file, "utf8");
  return loadModelAstFromText(rootSource, diskReader(dirname(file)), toPosix(relative(process.cwd(), file) || file));
}

/**
 * Give each diagnostic the file its `line` counts in: the file of the first entity its `refs`
 * name that sits in a storyline model file. A diagnostic with no refs, or whose entities are all
 * in the root, keeps the root (no `file`). Mutates and returns `diags`.
 */
export function attributeDiagnosticFiles(model: NormalizedModel, refs: RefsResult, diags: Diagnostic[]): Diagnostic[] {
  if (!model.slices.some((s) => s.file)) return diags;
  const fileByRef = new Map<string, string>();
  model.slices.forEach((s, i) => {
    if (s.file) fileByRef.set(refs.sliceKeys[i], s.file);
  });
  for (const el of model.elements) {
    const ref = refs.refById.get(el.id);
    if (ref && el.file) fileByRef.set(ref, el.file);
  }
  for (const d of diags) {
    if (d.file || !d.line) continue;
    for (const r of d.refs ?? []) {
      const f = fileByRef.get(r);
      if (f) {
        d.file = f;
        break;
      }
    }
  }
  return diags;
}
