// SPDX-License-Identifier: MIT
// `em validate`'s note-binding mismatch check (MIL-126): stops a slice-doc-shaped `note` from
// being silently discarded when it doesn't actually participate in the slice's resolved doc
// binding. Follow-on to MIL-121 (cross-slice `covers:` binding) — that ticket deliberately left
// every non-ratifying cross-note silent ("that's MIL-126"); this module is where the silence
// ends. Same fs-aware-sibling shape as catalog/lineageValidate.ts (MIL-84) and
// catalog/frontmatterCoherenceValidate.ts (MIL-85): a module next to model/validate.ts, not
// folded into it, because resolving a slice's doc needs `baseDir`/fs access the rest of validate
// deliberately never touches.
//
// Only `note`s shaped like `slices/<key>.md` (`docJoin.ts`'s `NOTE_SLICE_PATH`, case-insensitive)
// are this module's business — `note` is a general annotation mechanism rendered on diagrams
// (src/render/drawNotes.ts) for freeform text files, other paths, anything at all; a note that
// was never trying to bind a slice doc in the first place must never warn here.
//
// For each slice, first resolve what it's ACTUALLY bound to — mirroring resolveSliceDocJoin's
// own precedence exactly (canonical note first, else the first ratified cross-binding in element
// order, reusing `resolveCrossCandidate` so the two modules can't disagree on "ratifies"). Then
// walk every doc-shaped note again and classify it against that resolution:
//
//   - A note that equals the slice's OWN canonical path (`slices/<sliceKey>.md`, exact match) is
//     always fine, whether or not the doc behind it actually resolves — MIL-91's
//     `binding-missing-file`/`frontmatter-invalid` already cover a broken canonical doc; this
//     module would only be duplicating them.
//   - A note whose (normalized) path equals the slice's resolved bound path — canonical or the
//     winning cross-binding — is fine too; multiple elements can legitimately carry the same
//     winning note (`resolveSliceDocJoin`'s own `boundEls` semantics).
//   - Anything else warns, with a reason:
//       * the slice IS bound (to a different path) — `note-binding-extra`: this note is simply
//         ignored. Covers both an extra note in an already-(canonically-)bound slice AND a
//         second, later, also-technically-ratifiable cross-note losing to an earlier one
//         (MIL-121's "first wins") — from this note's point of view both read the same: "the
//         slice is already bound elsewhere, this note does nothing."
//       * the slice is UNBOUND, and this note's own candidate resolution says why it couldn't
//         become the binding: `note-binding-dangling` (file missing), `note-binding-unusable`
//         (frontmatter unusable), or `note-binding-unratified` (usable doc, but its `covers:`
//         doesn't name this slice).
//
// A note naming this slice's own key but in the wrong case (`note "slices/Checkout.md"` on
// slice "checkout") is deliberately NOT special-cased: `resolveSliceDocJoin`'s canonical check is
// exact-string, so a case-mismatched self-note can never bind canonically, and its cross-search
// skips same-key candidates outright (`resolveSliceDocJoin`'s own `if (otherKey === sliceKey)
// continue`) — the exact-case behavior predates this ticket. This module mirrors that same skip
// rather than inventing a new case-sensitivity linter MIL-126 never asked for; such a note stays
// exactly as inert as it always was.

import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { Diagnostic } from "../model/validate.js";
import { pushDiag } from "../model/rules.js";
import { NOTE_SLICE_PATH, resolveCrossCandidate } from "./docJoin.js";

/**
 * Resolve every slice's note-binding mismatches. `baseDir` is the `.em` file's directory, same
 * convention every other doc/note path in em uses.
 */
export function validateNoteBindings(model: NormalizedModel, refs: RefsResult, baseDir: string): Diagnostic[] {
  const diags: Diagnostic[] = [];

  model.slices.forEach((slice, sliceIndex) => {
    const sliceKey = refs.sliceKeys[sliceIndex];
    const canonicalPath = `slices/${sliceKey}.md`;
    const hasCanonical = slice.elements.some((el) => el.note === canonicalPath);

    // Mirrors resolveSliceDocJoin's own precedence exactly: canonical (any element noting the
    // exact own path, regardless of whether that doc actually resolves) wins outright; otherwise
    // the first ratified cross-binding candidate in element order. `boundPath` is null when
    // neither applies — the slice is genuinely unbound.
    let boundPath: string | null = null;
    if (hasCanonical) {
      boundPath = canonicalPath;
    } else {
      for (const el of slice.elements) {
        if (!el.note) continue;
        const m = el.note.match(NOTE_SLICE_PATH);
        if (!m) continue;
        const candidateKey = m[1].toLowerCase();
        if (candidateKey === sliceKey) continue; // same self-key skip resolveSliceDocJoin makes
        if (resolveCrossCandidate(baseDir, candidateKey, sliceKey).status === "ratified") {
          boundPath = `slices/${candidateKey}.md`;
          break;
        }
      }
    }

    for (const el of slice.elements) {
      if (!el.note || el.note === canonicalPath) continue; // absent, or the canonical slot itself
      const m = el.note.match(NOTE_SLICE_PATH);
      if (!m) continue; // not doc-shaped at all — a freeform annotation, never this module's business
      const candidateKey = m[1].toLowerCase();
      if (candidateKey === sliceKey) continue; // case-mismatched self-note — see header comment
      const candidatePath = `slices/${candidateKey}.md`;
      const elementRefs = [sliceKey, refs.refById.get(el.id)!];

      if (boundPath !== null) {
        if (candidatePath === boundPath) continue; // agrees with the resolved binding — fine
        pushDiag(diags, "note-binding-extra", {
          message: `slice "${slice.name}" is already bound to "${boundPath}"${
            boundPath === canonicalPath ? "" : " (a ratified cross-binding)"
          } — this note's "${el.note}" is ignored`,
          line: el.line,
          refs: elementRefs,
        });
        continue;
      }

      // Slice is unbound — classify why THIS candidate specifically didn't become the binding.
      const result = resolveCrossCandidate(baseDir, candidateKey, sliceKey);
      if (result.status === "missing") {
        pushDiag(diags, "note-binding-dangling", {
          message: `slice "${slice.name}" notes "${el.note}" but no such file exists — dangling, ignored`,
          line: el.line,
          refs: elementRefs,
        });
      } else if (result.status === "unusable") {
        pushDiag(diags, "note-binding-unusable", {
          message: `slice "${slice.name}" notes "${el.note}", but that doc's frontmatter isn't usable, so it can't ratify coverage of this slice`,
          line: el.line,
          refs: elementRefs,
        });
      } else {
        // result.status === "unratified" — the only remaining case: "ratified" is unreachable
        // here, since a ratified non-self candidate would already have set `boundPath` above
        // (self-key candidates, the one exception, were already skipped in this same loop).
        pushDiag(diags, "note-binding-unratified", {
          message: `slice "${slice.name}" notes "${el.note}", but that doc's \`covers:\` doesn't list "${sliceKey}" — add \`covers: ${sliceKey}\` there, or correct this note's path`,
          line: el.line,
          refs: elementRefs,
        });
      }
    }
  });

  return diags;
}
