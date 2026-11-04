// SPDX-License-Identifier: MIT
// Reads each slice's sibling design doc (slices/<kebab-slug>.md, see
// .claude/skills/event-modeling/templates/slice.md), for the main render pipeline
// (composeSvg) to color slice headers by status with, and (MIL-153) to embed each
// slice's doc content in the live view's slice-click flyout — same resolved doc,
// two different things done with it, one fs pass.
//
// Same doc-path convention `em catalog` already uses (src/catalog/build.ts):
// the *deduped* export key from computeRefs(), not a fresh kebabSlug(name) —
// so two same-named slices resolve statuses the same way `em catalog` resolves
// docs for them (first one gets the real file, the second honestly gets null).
//
// MIL-121 fallback: when a slice has no own `slices/<key>.md`, scan the `slices/` directory for
// a sibling doc whose frontmatter `covers:` names this slice's key, and borrow IT. The scan
// itself (readCoverageDocs) is shared with `em catalog`'s own covered-slice handling (MIL-137,
// src/catalog/coverage.ts) so the two never disagree about which doc covers a slice.
//
// MIL-208 fallback (checked last, after own file and the covers: scan both come up empty): a
// continuation slice (an again-view-only slice) borrows the ORIGINATING slice's own file
// directly — same predicate/resolution as catalog/docJoin.ts's note-gated join, model/
// continuation.ts, just applied to this module's filename-convention resolution instead of
// notes.

import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { computeRefs } from "../model/refs.js";
import { continuationOf } from "../model/continuation.js";
import { readCoverageDocsAll, CoveringDoc } from "../catalog/coverage.js";
import { locateDoc } from "../catalog/docLocate.js";
import { parseSliceDoc, SliceDoc } from "../catalog/sliceDoc.js";

/** Each slice's resolved design doc (own `slices/<key>.md`, the MIL-121 covering doc, the
 *  MIL-208 originating slice's own file, or null), same order as model.slices (and so the same
 *  order as the header row's columns — see layout/grid.ts's sliceNames). */
export function readSliceDocs(model: NormalizedModel, baseDir: string): (SliceDoc | null)[] {
  return readSliceDocFiles(model, baseDir).map((f) => f?.doc ?? null);
}

/** A resolved slice doc and where it is: `path` is relative to `baseDir`, posix separators
 *  (`slices/<key>.md`), so a render can link a slice's header cell to it (owner ruling
 *  2026-11-03: every slice header in an SVG is a link to its doc). */
export interface SliceDocFile {
  path: string;
  doc: SliceDoc;
}

export function readSliceDocFiles(model: NormalizedModel, baseDir: string): (SliceDocFile | null)[] {
  const refs = computeRefs(model);
  const { sliceKeys } = refs;
  let coverage: Map<string, CoveringDoc> | null = null; // built lazily, only if ever needed
  // GH #421 step 2: a doc sits beside the file that declares its slice; docLocate finds it by key
  // and `path` is where it IS, relative to the root (`<dir>/slices/<key>.md`), so a header link
  // from any output location resolves to the real file.
  const file = (key: string): SliceDocFile | null => {
    const abs = locateDoc(baseDir, `slices/${key}.md`);
    return abs ? { path: relative(baseDir, abs).split(sep).join("/"), doc: parseSliceDoc(readFileSync(abs, "utf8")) } : null;
  };

  return model.slices.map((_slice, i) => {
    const sliceKey = sliceKeys[i];
    const own = file(sliceKey);
    if (own) return own;
    coverage ??= readCoverageDocsAll(baseDir);
    const covering = coverage.get(sliceKey);
    if (covering) return file(covering.key) ?? { path: `slices/${covering.key}.md`, doc: covering.doc };
    const continuation = continuationOf(model, refs, i);
    if (continuation) return file(continuation.sliceKey);
    return null;
  });
}

/** One status per slice, same order/resolution as readSliceDocs. null means no doc was found
 *  (own or covering), or the doc has no `- **Status:** ...` line. */
export function readSliceStatuses(model: NormalizedModel, baseDir: string): (string | null)[] {
  return readSliceDocs(model, baseDir).map((doc) => doc?.status ?? null);
}
