// SPDX-License-Identifier: MIT
// GH #530: the state file's `Code roots:` bullet, read as places. The bullet has always been a
// place with the repository implied — "this model's code is under these paths of this repo" —
// so it is the default place of a model whose code map gives none, in `self`.
//
// The bullet itself is read by system/scope.ts's `parseCodeRoots`, the same reader
// `em system scope` uses for `code-spans-seam`. Nothing here changes that reader or that rule;
// this module only turns its result into `Place`s.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SELF_REPO_ID } from "../system/manifest.js";
import { parseCodeRoots } from "../system/scope.js";
import { STATE_FILE_NAME } from "../cli/stateFile.js";
import { normalizeRoot, Place } from "./codeMap.js";

/** One place in `self` per code root the model's state file declares, in the order written.
 *  `[]` when there is no state file, no `Code roots:` bullet, or it says `none`. A root that
 *  would leave the repository is dropped. */
export function codeRootPlaces(modelFile: string): Place[] {
  let text: string;
  try {
    text = readFileSync(join(dirname(modelFile), STATE_FILE_NAME), "utf8");
  } catch {
    return [];
  }
  const out: Place[] = [];
  for (const raw of parseCodeRoots(text)) {
    const root = normalizeRoot(raw);
    if (root !== null && !out.some((p) => p.root === root)) out.push({ repo: SELF_REPO_ID, root });
  }
  return out;
}
