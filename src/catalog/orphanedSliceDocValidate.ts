// SPDX-License-Identifier: MIT
// `em validate`'s fifth fs-aware rule (MIL-183, the fragility half of GH #128): a slice doc left
// behind in `slices/` after its slice is renamed or removed used to just quietly stop applying —
// nothing ever pointed at the ORPHANED FILE itself. Same fs-aware-sibling shape as
// catalog/lineageValidate.ts (MIL-84), catalog/frontmatterCoherenceValidate.ts (MIL-85),
// catalog/noteBindingValidate.ts (MIL-126), and catalog/docModelConsistencyValidate.ts (MIL-124):
// a module next to model/validate.ts, not folded into it, because it needs `baseDir`/fs access
// the rest of validate deliberately never touches. Distinct from all four of those, though, in
// which direction it walks: every one of them starts from a *slice* and asks "is its doc/note
// okay?" — this is the only rule that instead walks the filesystem and asks the opposite
// direction, "does every file out there still belong to something?"
//
// Two doc-join mechanisms coexist in this codebase (docJoin.ts's own header comment spells out
// the same split): `docJoin.ts`'s `resolveSliceDocJoin`, gated on an explicit
// `note "slices/<key>.md"` binding, drives `em export`/`em status`/the MCP tools; `em catalog`
// (catalog/build.ts) instead reads `slices/<sliceKey>.md` by BARE FILENAME CONVENTION, ignoring
// `note` entirely — a standing, deliberately-kept-separate, tested invariant (see build.ts's own
// header comment and test/catalog.e2e.test.ts). The GH #128 reporter's "matched by name, silently
// stops applying" experience is build.ts's convention path, not docJoin's note-gated one — status
// coloring on the diagram comes from whether a file happens to sit at the right name, full stop.
// So "orphaned" here is judged the same name-convention way build.ts resolves a doc: by filename
// key (and, for a MIL-121 covering doc, by its `covers:` list), never by whether some element
// happens to carry a `note`. A note-binding problem (a note pointing at the wrong place) is
// noteBindingValidate.ts's business; a stale file nothing names by convention or `covers:` any
// more is this rule's.
//
// A file only counts as a slice doc worth checking when its frontmatter is USABLE
// (hasUsableFrontmatter — sliceDoc.ts, the exact gate `em export`'s `frontmatter-invalid` and
// every sibling module already use, so this rule can't silently disagree with them on what counts
// as a readable doc). This is what keeps a README, a scratch note, or any other non-doc file in
// `slices/` from ever being flagged: nothing here can distinguish such a file from "meant to
// become a slice doc but hasn't been fleshed out yet" except the file declaring itself one via
// frontmatter — the same declare-gating posture docModelConsistencyValidate.ts's checks take.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { Diagnostic } from "../model/validate.js";
import { pushDiag } from "../model/rules.js";
import { hasUsableFrontmatter, parseSliceDoc } from "./sliceDoc.js";

/**
 * Scan `<baseDir>/slices/` for a doc file that no current slice's own key names by filename
 * convention, and whose `covers:` list (if any — MIL-121) doesn't ratify a current slice either.
 * `baseDir` is the `.em` file's directory, same convention every other doc/note path in em uses.
 * Returns `[]` when `slices/` doesn't exist at all — nothing to a scan with no directory to walk,
 * the ordinary state for a model that hasn't authored any slice docs yet.
 */
export function validateOrphanedSliceDocs(_model: NormalizedModel, refs: RefsResult, baseDir: string): Diagnostic[] {
  // `_model` is unused — `refs.sliceKeys` already carries every current slice's key. Kept in the
  // signature anyway to match every sibling fs-aware rule's `(model, refs, baseDir)` shape, so
  // every call site can pass the same three arguments uniformly.
  const slicesDir = join(baseDir, "slices");
  let entries: string[];
  try {
    entries = readdirSync(slicesDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return []; // no slices/ directory (or unreadable) — nothing to orphan
  }

  const liveKeys = new Set(refs.sliceKeys.map((k) => k.toLowerCase()));
  const diags: Diagnostic[] = [];

  for (const entry of entries.slice().sort()) {
    if (!entry.toLowerCase().endsWith(".md")) continue; // not a slice-doc-shaped file at all
    const key = entry.slice(0, -".md".length);
    if (liveKeys.has(key.toLowerCase())) continue; // matches a current slice's key by name — never orphaned

    let parsed;
    try {
      parsed = parseSliceDoc(readFileSync(join(slicesDir, entry), "utf8"));
    } catch {
      continue; // unreadable file (permissions, ...) — not this rule's business
    }
    // Gate on usable frontmatter, same predicate every sibling fs-aware rule uses: a README, a
    // freeform note, or a draft that never got as far as a full frontmatter block is not
    // confidently a slice doc at all, so it's never flagged as one gone stale.
    if (!hasUsableFrontmatter(parsed)) continue;
    // MIL-121: a doc whose own canonical slice is gone can still legitimately serve a DIFFERENT,
    // still-live slice via `covers:` — the two-slice Automation/Translation shape's shared-doc
    // case. Ratifying coverage of any current slice is enough; this mirrors docJoin.ts's own
    // predicate loosely (it doesn't require an actual winning cross-note here, only that the
    // `covers:` declaration itself still names something live) — a stricter "and some note also
    // points here" check would reintroduce exactly the kind of false positive this ticket calls
    // out to avoid.
    if (parsed.covers.some((c) => liveKeys.has(c))) continue;

    pushDiag(diags, "orphaned-slice-doc", {
      message:
        `slice doc "slices/${entry}" matches no current slice's key, and its \`covers:\` list ` +
        `(if any) doesn't name one either — likely left behind by a rename or removal. Rename it ` +
        `to the renamed slice's key, add \`covers: <slice-key>\` (plus a \`note\` binding) to ` +
        `attach it to a live slice, or delete it if it's no longer needed`,
      refs: [key],
    });
  }

  return diags;
}
