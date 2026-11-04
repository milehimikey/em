// SPDX-License-Identifier: MIT
// GH #421 step 2 — finding a slice doc on disk when storylines live in their own folders.
//
// A doc path is `slices/<key>.md`, written and compared relative to the file that declares the
// slice (model/sliceDocPath.ts): for a root slice that is `<root>/slices/<key>.md`, for a slice
// of a storyline model `<root>/<dir>/slices/<key>.md`. Slice keys are unique per model, so a key
// names exactly one doc wherever it sits; this module looks it up across the root's `slices/`
// and every immediate subdirectory that has a `slices/` of its own (a storyline folder), root
// first. Reading needs no model in hand — `readSliceDoc(baseDir, key)` keeps its signature — and
// writing an existing doc rewrites it where it is; only a NEW doc needs its slice to pick the
// folder (`docAbsPath`'s third argument).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { docDirOf } from "../model/sliceDocPath.js";
import { stripComment } from "../parser/lexer.js";

/** True when `dir` holds a storyline model file: a `.em` whose first significant line is a
 *  `storyline "…"` header with no `{` (parser `parseStorylineFile`'s shape). A sibling MODEL's
 *  directory (`examples/order-fulfillment/`, its `.em` starting with `model`/`slice`) is not a doc
 *  folder of this model, even though it has a `slices/` of its own. */
function isStorylineFolder(dir: string): boolean {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".em"));
  } catch {
    return false;
  }
  for (const n of names) {
    try {
      const first = readFileSync(join(dir, n), "utf8").split(/\r?\n/).map((l) => stripComment(l).trim()).find((l) => l.length > 0);
      if (first && /^storyline\b/.test(first) && !first.includes("{")) return true;
    } catch {
      // unreadable — not a storyline folder we can use
    }
  }
  return false;
}

/** Doc folder prefixes under `baseDir`: `""` (the root's `slices/`) first, then `"<sub>/"` for
 *  every immediate subdirectory that is a storyline model folder with a `slices/` directory,
 *  sorted. Never cached: a split or a new storyline folder mid-session must be seen on the next
 *  call. */
export function docFolders(baseDir: string): string[] {
  const out = [""];
  let entries: string[];
  try {
    entries = readdirSync(baseDir).sort();
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith(".") || name === "slices" || name === "node_modules") continue;
    const sub = join(baseDir, name);
    try {
      if (statSync(sub).isDirectory() && statSync(join(sub, "slices")).isDirectory() && isStorylineFolder(sub)) out.push(`${name}/`);
    } catch {
      // not a directory, or no slices/ inside — not a doc folder
    }
  }
  return out;
}

/** Absolute path of the existing file `relPath` (a `slices/<key>.md`-shaped path, or any path
 *  relative to the declaring file's directory), searched root first across the doc folders;
 *  `null` when no folder has it. A path that already starts with a folder prefix is honoured
 *  as written. */
export function locateDoc(baseDir: string, relPath: string): string | null {
  const direct = join(baseDir, relPath);
  if (existsSync(direct)) return direct;
  if (!relPath.startsWith("slices/")) return null;
  for (const folder of docFolders(baseDir)) {
    if (folder === "") continue;
    const candidate = join(baseDir, folder, relPath);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Where `relPath` is — or, when it does not exist yet, where it belongs: the folder of the
 *  slice that declares it (`slice.file`'s directory), the root for a root slice. */
export function docAbsPath(baseDir: string, relPath: string, slice?: { file?: string }): string {
  return locateDoc(baseDir, relPath) ?? join(baseDir, docDirOf(slice), relPath);
}

/** Every existing `slices/` directory under `baseDir` (root first), absolute. */
export function docDirs(baseDir: string): string[] {
  return docFolders(baseDir)
    .map((f) => join(baseDir, f, "slices"))
    .filter((d) => existsSync(d));
}
