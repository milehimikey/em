// SPDX-License-Identifier: MIT
// Shared MIL-121 "covered by" doc-discovery: scans `slices/*.md` for a frontmatter `covers:`
// entry naming a slice that has no doc of its own. Every consumer that needs this fallback —
// the render pipeline's Slice Status legend (src/render/sliceStatus.ts) and `em catalog`'s
// detail pages (src/catalog/build.ts, MIL-137) — shares this one scan, so a covered slice never
// resolves to a different doc (or a different notion of which slice covers it) depending on
// which command asked. Filename+frontmatter discovery only: never reads Element.note — that
// cross-note is docJoin.ts's concern (`em export`'s doc join, `em validate --slice-ready`), not
// this module's; test/catalog.e2e.test.ts pins "never reads note" as an invariant for `em
// catalog`, and this module is exactly as blind to it.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSliceDoc, SliceDoc } from "./sliceDoc.js";

/** A covering doc, plus the covering slice's OWN key (its `slices/<key>.md` filename stem,
 *  stripped of the extension). Callers that need to link to or name the covering slice itself
 *  (`em catalog`'s "documented as part of" banner) get it here rather than re-deriving "which
 *  slice does this doc actually belong to" from `doc`, which has no notion of its own key. */
export interface CoveringDoc {
  doc: SliceDoc;
  key: string;
}

/** Scans every `slices/*.md` file (sorted, for deterministic first-wins on an overlapping
 *  `covers:` claim) and maps each covered slice key to the doc — and that doc's own key — that
 *  covers it. Directory-scan, not the single-file existsSync check every other doc lookup in em
 *  uses — the one precedent for it is `em ledger`'s (src/cli/ledgerCheck.ts) own
 *  `readdirSync(slicesDir)` sweep. */
export function readCoverageDocs(slicesDir: string): Map<string, CoveringDoc> {
  const coverage = new Map<string, CoveringDoc>();
  if (!existsSync(slicesDir)) return coverage;
  const files = readdirSync(slicesDir).filter((f) => f.endsWith(".md")).sort();
  for (const file of files) {
    const doc = parseSliceDoc(readFileSync(join(slicesDir, file), "utf8"));
    const key = file.slice(0, -".md".length);
    for (const coveredKey of doc.covers) {
      if (!coverage.has(coveredKey)) coverage.set(coveredKey, { doc, key });
    }
  }
  return coverage;
}
