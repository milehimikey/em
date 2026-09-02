// SPDX-License-Identifier: MIT
// A once-per-model slice-doc join for `em query` (MIL-168): the same canonical-then-
// MIL-121-cross-binding resolution `catalog/docJoin.ts`'s resolveSliceDocJoin() performs, but
// sourced from one `readdirSync(<baseDir>/slices/)` up front instead of one
// `existsSync`+`readFileSync` pair (`readSliceDoc.ts`) per slice/candidate. `em export`/`em
// status`/`em coverage` each call resolveSliceDocJoin() once per slice already and stay on that
// path unchanged (their per-slice cost is amortized across a single command run the same way);
// this module exists because `em query` builds one ModelIndex per compiled model and then
// answers many lookups against it, so paying the fs cost once, up front, per model — rather
// than once per slice scattered through the join — is the win at thousands-of-slices scale (see
// this ticket's report for the benchmark).
//
// Deliberately a read path, not a lint: unlike resolveSliceDocJoin(), this never raises a
// diagnostic for a missing-but-bound doc or invalid frontmatter — `em query` reports facts
// (`found`/`reason`), and leaves surfacing that as a warning to `em export`/`em status`, which
// already do.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSliceDoc, SliceDoc, hasUsableFrontmatter } from "../catalog/sliceDoc.js";
import { classifyImplementationDrift, DriftSignalKind } from "../catalog/driftSignal.js";
import { NOTE_SLICE_PATH } from "../catalog/docJoin.js";
import { Slice } from "./model.js";

/** Matches a slice-doc filename (`slices/<key>.md`) — same kebab-slug grammar
 *  `catalog/sliceDoc.ts`'s SLICE_REF and `docJoin.ts`'s NOTE_SLICE_PATH use for the key itself. */
const SLICE_DOC_FILENAME_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/i;

/** Read + parse every `slices/*.md` file under `baseDir` exactly once, keyed by its filename
 *  stem (lowercased) — the same key `computeRefs()` assigns as a slice's export key. A missing
 *  `slices/` directory (routine — not every model has reached specify yet) returns an empty map,
 *  the same "nothing bound" state `readSliceDoc()` reports per-file via `null`. An individual
 *  file that fails to read (permissions, a broken symlink) is skipped rather than thrown —
 *  same silent-miss convention `readSliceDoc()` uses for a missing file. */
export function loadSliceDocsOnce(baseDir: string): Map<string, SliceDoc> {
  const docs = new Map<string, SliceDoc>();
  let entries: string[];
  try {
    entries = readdirSync(join(baseDir, "slices"));
  } catch {
    return docs;
  }
  for (const name of entries) {
    const m = SLICE_DOC_FILENAME_RE.exec(name);
    if (!m) continue;
    try {
      docs.set(m[1].toLowerCase(), parseSliceDoc(readFileSync(join(baseDir, "slices", name), "utf8")));
    } catch {
      // unreadable — treated as "no doc" for this key, same as a fs error inside readSliceDoc().
    }
  }
  return docs;
}

/** A slice's query-facing doc join — deliberately narrower than `SliceDocExport`
 *  (`catalog/docJoin.ts`): only the facts `em query`'s verbs actually surface (declaring
 *  slice, doc path/status, drift, and the doc body for invariant-ID extraction), no lineage/
 *  ratification/owner fields. */
export interface SliceQueryDoc {
  found: boolean;
  path: string;
  reason: "no-doc-bound" | "binding-missing-file" | "frontmatter-invalid" | null;
  status: string | null;
  implementedIn: string | null;
  driftSignal: DriftSignalKind | null;
  /** The doc's body text (post-frontmatter), for `extractInvariantIds()` — null whenever
   *  `found` is false or the frontmatter wasn't usable (nothing safe to scan). */
  body: string | null;
}

/** Same resolution semantics as `docJoin.ts`'s resolveSliceDocJoin() — canonical `note` binding
 *  first, then a ratified MIL-121 cross-binding naming this slice in its `covers:` list — but
 *  reading from the in-memory map `loadSliceDocsOnce()` built once for the whole model, instead
 *  of one `readSliceDoc()` fs call per slice/candidate. */
export function joinSliceDocFast(slice: Slice, sliceKey: string, docsByKey: Map<string, SliceDoc>): SliceQueryDoc {
  const path = `slices/${sliceKey}.md`;
  const boundEls = slice.elements.filter((el) => el.note === path);

  if (boundEls.length === 0) {
    for (const el of slice.elements) {
      if (!el.note) continue;
      const m = el.note.match(NOTE_SLICE_PATH);
      if (!m) continue;
      const otherKey = m[1].toLowerCase();
      if (otherKey === sliceKey) continue;
      const doc = docsByKey.get(otherKey);
      if (!doc || !hasUsableFrontmatter(doc) || !doc.covers.includes(sliceKey)) continue;
      return foundDoc(`slices/${otherKey}.md`, doc);
    }
    return { found: false, path, reason: "no-doc-bound", status: null, implementedIn: null, driftSignal: null, body: null };
  }

  const doc = docsByKey.get(sliceKey);
  if (!doc) return { found: false, path, reason: "binding-missing-file", status: null, implementedIn: null, driftSignal: null, body: null };
  if (!hasUsableFrontmatter(doc)) {
    return { found: true, path, reason: "frontmatter-invalid", status: null, implementedIn: null, driftSignal: null, body: null };
  }
  return foundDoc(path, doc);
}

function foundDoc(path: string, doc: SliceDoc): SliceQueryDoc {
  return {
    found: true,
    path,
    reason: null,
    status: doc.status,
    implementedIn: doc.implementedIn,
    driftSignal: classifyImplementationDrift(doc),
    body: doc.body,
  };
}
