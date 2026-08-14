// SPDX-License-Identifier: MIT
// The `em export` slice-doc join (MIL-91): for each slice, resolve whether a design doc was
// declared, found, and well-formed, and if so pull its canonical frontmatter fields into the
// export JSON. Used ONLY by `em export` (src/emit/json.ts) — `em catalog`'s own doc lookup
// (catalog/build.ts) deliberately keeps its simpler existsSync+parseSliceDoc convention: it
// has a standing tested invariant that catalog's doc discovery ignores `note` entirely
// (test/catalog.e2e.test.ts), and doesn't need this module's 3-state reason granularity. The
// underlying read (`readSliceDoc.ts`) is shared with `em diff`'s lineage annotation
// (model/diff.ts) and `em validate`'s lineage-ref resolution (catalog/lineageValidate.ts,
// MIL-84) — this module's `note`-binding gate and 3-state `DocReason` stay export-specific.
//
// Three states (MIL-91): the `note "slices/<name>.md"` binding on an element is the
// load-bearing fact — binding a note IS the ratified declaration that a doc should exist. No
// note binding is a normal, unremarkable state (a slice that hasn't reached specify yet); a
// binding pointing at a missing file, or a doc whose frontmatter is missing or malformed, are
// both broken-contract states and warn.

import { Slice } from "../model/model.js";
import { Diagnostic } from "../model/validate.js";
import { classifyImplementationDrift, DriftSignalKind } from "./driftSignal.js";
import { readSliceDoc } from "./readSliceDoc.js";
import { hasUsableFrontmatter, SliceRef } from "./sliceDoc.js";

export type DocReason = "no-doc-bound" | "binding-missing-file" | "frontmatter-invalid" | null;

/** A slice's export-facing doc join — always a non-null object (never JSON `null`), matching
 *  every other optional field in `em export`'s style: explicit-null-on-a-stable-key, never a
 *  nullable wrapper. `reason` is null exactly when `found` is true and the frontmatter parsed
 *  cleanly; otherwise it names which of the three broken states applies. */
export interface SliceDocExport {
  found: boolean;
  /** The conventional path (`slices/<sliceKey>.md`), always present regardless of `found` —
   *  the path a doc would need to exist at, and (when `found`) the path it was read from. */
  path: string;
  reason: DocReason;
  status: string | null;
  version: number | null;
  implementedIn: string | null;
  splitFrom: SliceRef | null;
  mergedFrom: SliceRef[];
  supersededBy: SliceRef[];
  /** Implementation-drift classification (MIL-85), from `status`+`implementedIn` alone — see
   *  catalog/driftSignal.ts. Null only when `found` is false (nothing to classify); paired with
   *  `version` above from the same doc parse — a finding built from `driftSignal` should always
   *  cite `version` alongside it, never cache one without the other. */
  driftSignal: DriftSignalKind | null;
}

export interface SliceDocJoinResult {
  doc: SliceDocExport;
  diagnostics: Diagnostic[];
}

const EMPTY_CONTENT = {
  status: null,
  version: null,
  implementedIn: null,
  splitFrom: null,
  mergedFrom: [] as SliceRef[],
  supersededBy: [] as SliceRef[],
  driftSignal: null as DriftSignalKind | null,
};

/**
 * Resolve one slice's doc join. `baseDir` is the `.em` file's directory (doc paths, like note
 * paths everywhere else in em, are relative to it). `sliceRef`/`elementRefOf` supply the
 * export-stable refs (from the same `computeRefs()` result `em export`'s per-element/slice
 * entries use) so the returned diagnostics point at the same identities every other export
 * diagnostic does — never a second identifier scheme.
 */
export function resolveSliceDocJoin(
  slice: Slice,
  sliceKey: string,
  baseDir: string,
  elementRefOf: (id: string) => string,
): SliceDocJoinResult {
  const path = `slices/${sliceKey}.md`;
  const boundEls = slice.elements.filter((el) => el.note === path);

  if (boundEls.length === 0) {
    return { doc: { found: false, path, reason: "no-doc-bound", ...EMPTY_CONTENT }, diagnostics: [] };
  }

  const parsed = readSliceDoc(baseDir, sliceKey);
  if (!parsed) {
    return {
      doc: { found: false, path, reason: "binding-missing-file", ...EMPTY_CONTENT },
      diagnostics: [
        {
          severity: "warning",
          code: "binding-missing-file",
          message: `slice "${slice.name}" notes "${path}" but no such file exists`,
          line: boundEls[0].line,
          refs: [sliceKey, ...boundEls.map((el) => elementRefOf(el.id))],
        },
      ],
    };
  }

  if (!hasUsableFrontmatter(parsed)) {
    return {
      doc: { found: true, path, reason: "frontmatter-invalid", ...EMPTY_CONTENT },
      diagnostics: [
        {
          severity: "warning",
          code: "frontmatter-invalid",
          message: parsed.frontmatterPresent
            ? `slice doc "${path}" is missing required frontmatter keys: ${parsed.missingRequiredFields.join(", ")}`
            : `slice doc "${path}" has no frontmatter block`,
          line: slice.line,
          refs: [sliceKey],
        },
      ],
    };
  }

  return {
    doc: {
      found: true,
      path,
      reason: null,
      status: parsed.status,
      version: parsed.version,
      implementedIn: parsed.implementedIn,
      splitFrom: parsed.splitFrom,
      mergedFrom: parsed.mergedFrom,
      supersededBy: parsed.supersededBy,
      driftSignal: classifyImplementationDrift(parsed),
    },
    diagnostics: [],
  };
}
