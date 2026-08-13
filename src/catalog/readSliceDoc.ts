// SPDX-License-Identifier: MIT
// Lowest-level slice-doc read: given a base dir and a slice's export key,
// read+parse `slices/<sliceKey>.md` if it exists. Never throws — a missing
// file is routine (not every slice has reached specify yet), so this is a
// plain `null`, not an exception or a diagnostic. Shared by `em export`'s
// doc join (catalog/docJoin.ts, which additionally gates on a `note` binding
// and produces export-shaped diagnostics for a *missing-but-bound* doc — a
// concern this module doesn't have), `em diff`'s lineage annotation
// (model/diff.ts, via cli.ts), and `em validate`'s lineage-ref resolution
// (catalog/lineageValidate.ts) — three callers with different reactions to
// "no doc here," so the read itself stays opinion-free.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSliceDoc, SliceDoc } from "./sliceDoc.js";

export function readSliceDoc(baseDir: string, sliceKey: string): SliceDoc | null {
  const path = join(baseDir, "slices", `${sliceKey}.md`);
  if (!existsSync(path)) return null;
  return parseSliceDoc(readFileSync(path, "utf8"));
}
