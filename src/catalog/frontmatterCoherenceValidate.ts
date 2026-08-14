// SPDX-License-Identifier: MIT
// `em validate`'s frontmatter-coherence check (MIL-85): warns when a slice doc's `status` and
// `implementedIn` are genuinely incoherent — `status: implemented` with no `implementedIn` link
// at all. Deliberately narrow: re-ratifying a shipped slice flips `status` back off
// `implemented` while `implementedIn` keeps naming the prior version's PR (docs/slice-doc-
// schema.md, "`status` under re-ratification") — that combination is the EXPECTED drift signal
// of an unpropagated delta, not incoherence, and must stay silent here. See
// catalog/driftSignal.ts for the shared classification this check (and `em export`'s
// `slice.doc.driftSignal`) both read.
//
// Same fs-aware shape as catalog/lineageValidate.ts (MIL-84): a sibling module to
// model/validate.ts, not folded into it, because resolving a slice's doc needs `baseDir`/fs
// access that the rest of validate deliberately never touches.
//
// Requires usable frontmatter (`hasUsableFrontmatter()`, sliceDoc.ts) — the exact same gate
// `em export`'s docJoin.ts uses for `frontmatter-invalid`, shared as one function precisely so
// the two can't silently disagree on what counts as a readable doc. `implementedIn` is a
// frontmatter-only key (MIL-90/91) with no legacy body-label form (MIL-86's accepted-input
// dialect: `- **Status:** ...`, no frontmatter block), and every canonical field this check
// reads is itself frontmatter-only — so a doc with no fence, or one missing any required key,
// has nothing reliable enough to classify. Flagging it as incoherent would be a false positive
// against a doc that's merely unreadable, not one that's actually incoherent; stay silent
// rather than guess, matching export's classification of the same doc.

import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { Diagnostic } from "../model/validate.js";
import { classifyImplementationDrift } from "./driftSignal.js";
import { readSliceDoc } from "./readSliceDoc.js";
import { hasUsableFrontmatter } from "./sliceDoc.js";

/**
 * Resolve every slice's doc and flag genuine status/implementedIn incoherence. `baseDir` is the
 * `.em` file's directory (doc paths, like every other doc/note path in em, are relative to it).
 */
export function validateFrontmatterCoherence(model: NormalizedModel, refs: RefsResult, baseDir: string): Diagnostic[] {
  const diags: Diagnostic[] = [];

  model.slices.forEach((slice, i) => {
    const sliceKey = refs.sliceKeys[i];
    const doc = readSliceDoc(baseDir, sliceKey);
    if (!doc || !hasUsableFrontmatter(doc)) return;

    const drift = classifyImplementationDrift(doc);
    if (drift !== "implemented-without-link") return;
    // "unpropagated-delta" falls through here silently — that's the point: a re-ratified slice
    // whose implementedIn still names prior work is expected, not a defect.

    diags.push({
      severity: "warning",
      code: "frontmatter-coherence-implemented-without-link",
      message: `slice "${sliceKey}" has status: implemented but no implementedIn link (v${doc.version ?? "?"})`,
      line: slice.line,
      refs: [sliceKey],
    });
  });

  return diags;
}
