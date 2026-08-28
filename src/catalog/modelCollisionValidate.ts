// SPDX-License-Identifier: MIT
// Cross-model slice-doc collision detection (MIL-160). readSliceDoc.ts resolves every slice doc
// at `<dirname(modelFile)>/slices/<sliceKey>.md` — safe as long as every model owns its own
// directory (the documented convention, docs/cli.md "Multi-model projects"), since computeRefs()
// only dedupes a slice key against the OTHER slices in the SAME model's compile
// (src/model/refs.ts). Two sibling `.em` files sharing a directory, each producing a slice
// keyed e.g. "checkout", would both resolve to the same `slices/checkout.md` — silently: neither
// model's compile ever sees the other, so nothing raises a diagnostic today. This is the one
// check that does: given every input model's file path and its own compiled slice keys, group by
// resolved base directory and flag any key more than one model in the same group produces.
//
// The only cross-model rule in the codebase — every other rule in model/rules.ts is a
// single-model concern raised from inside one compile. Deliberately NOT part of
// model/validate.ts's pipeline (which only ever sees one model at a time); instead wired
// directly into the two commands that ever compile more than one model in the same run
// (`em status` in src/cli.ts, `em catalog` in src/catalog/build.ts) — the only places that
// could possibly witness a collision. Pure — no fs — the compiled `sliceKeys` are handed in by
// the caller, already computed by the same computeRefs() call the caller made anyway.

import { dirname, resolve } from "node:path";
import { Diagnostic } from "../model/validate.js";
import { makeDiag } from "../model/rules.js";

export interface ModelSliceKeys {
  /** The `.em` file as given on the command line — same identity every other multi-model
   *  diagnostic (StatusDiagnostic, CatalogBuildResult.diagnostics) tags itself with. */
  file: string;
  /** This model's own compiled slice export keys, same order/index as `computeRefs()`'s
   *  `sliceKeys` — duplicates already deduped with a `~2` suffix by computeRefs() itself, so a
   *  key here is always a real, single doc path this model expects to read/write. */
  sliceKeys: string[];
}

/**
 * Detect colliding `slices/<key>.md` doc paths across `models`: any two files whose resolved
 * base directory (`dirname(file)`, absolute so `./a.em` and `a.em` from the same cwd count as
 * the same directory) is identical AND who share at least one slice export key. One diagnostic
 * per colliding key, attributed to the SECOND model to use that key in file-list order — same
 * "first wins, the later one gets flagged" convention `computeRefs()`'s own `duplicate-slice-name`
 * diagnostic uses, so a collision reads as "this model's key collides with an earlier one," not
 * the reverse. A model list of 0 or 1 files (or where every file resolves to a distinct
 * directory) always returns `[]` — the ordinary single-model-per-directory case this function
 * exists to leave alone.
 */
export function detectSliceDocCollisions(models: ModelSliceKeys[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const byDir = new Map<string, ModelSliceKeys[]>();
  for (const m of models) {
    const dir = resolve(dirname(m.file));
    const bucket = byDir.get(dir);
    if (bucket) bucket.push(m);
    else byDir.set(dir, [m]);
  }

  for (const bucket of byDir.values()) {
    if (bucket.length < 2) continue; // only one model in this directory — no collision possible
    const firstFileForKey = new Map<string, string>();
    for (const m of bucket) {
      for (const key of m.sliceKeys) {
        const earlier = firstFileForKey.get(key);
        if (earlier === undefined) {
          firstFileForKey.set(key, m.file);
          continue;
        }
        if (earlier === m.file) continue; // same model listed twice on the command line
        diagnostics.push(
          makeDiag("cross-model-slice-doc-collision", {
            message:
              `"${m.file}" and "${earlier}" share a directory and both produce slice key "${key}" — ` +
              `both would read/write "slices/${key}.md"; give each model its own directory ` +
              `(see docs/cli.md, "Multi-model projects")`,
            refs: [key, earlier, m.file],
          }),
        );
      }
    }
  }
  return diagnostics;
}
