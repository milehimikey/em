// SPDX-License-Identifier: MIT
// Reads each slice's development status from its sibling design doc
// (slices/<kebab-slug>.md, see .claude/skills/event-modeling/templates/slice.md),
// for the main render pipeline (composeSvg) to color slice headers with.
//
// Same doc-path convention `em catalog` already uses (src/catalog/build.ts):
// the *deduped* export key from computeRefs(), not a fresh kebabSlug(name) —
// so two same-named slices resolve statuses the same way `em catalog` resolves
// docs for them (first one gets the real file, the second honestly gets null).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { computeRefs } from "../emit/json.js";
import { parseSliceDoc } from "../catalog/sliceDoc.js";

/** One status per slice, same order as model.slices (and so the same order as
 *  the header row's columns — see layout/grid.ts's sliceNames). null means no
 *  doc was found, or the doc has no `- **Status:** ...` line. */
export function readSliceStatuses(model: NormalizedModel, baseDir: string): (string | null)[] {
  const { sliceKeys } = computeRefs(model);
  return model.slices.map((_slice, i) => {
    const docPath = join(baseDir, "slices", `${sliceKeys[i]}.md`);
    if (!existsSync(docPath)) return null;
    return parseSliceDoc(readFileSync(docPath, "utf8")).status;
  });
}
