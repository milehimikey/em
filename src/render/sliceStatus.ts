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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { computeRefs } from "../model/refs.js";
import { readCoverageDocs, CoveringDoc } from "../catalog/coverage.js";
import { parseSliceDoc, SliceDoc } from "../catalog/sliceDoc.js";

/** Each slice's resolved design doc (own `slices/<key>.md`, or the MIL-121 covering doc, or
 *  null), same order as model.slices (and so the same order as the header row's columns —
 *  see layout/grid.ts's sliceNames). */
export function readSliceDocs(model: NormalizedModel, baseDir: string): (SliceDoc | null)[] {
  const { sliceKeys } = computeRefs(model);
  const slicesDir = join(baseDir, "slices");
  let coverage: Map<string, CoveringDoc> | null = null; // built lazily, only if ever needed

  return model.slices.map((_slice, i) => {
    const sliceKey = sliceKeys[i];
    const docPath = join(slicesDir, `${sliceKey}.md`);
    if (existsSync(docPath)) return parseSliceDoc(readFileSync(docPath, "utf8"));
    coverage ??= readCoverageDocs(slicesDir);
    return coverage.get(sliceKey)?.doc ?? null;
  });
}

/** One status per slice, same order/resolution as readSliceDocs. null means no doc was found
 *  (own or covering), or the doc has no `- **Status:** ...` line. */
export function readSliceStatuses(model: NormalizedModel, baseDir: string): (string | null)[] {
  return readSliceDocs(model, baseDir).map((doc) => doc?.status ?? null);
}
