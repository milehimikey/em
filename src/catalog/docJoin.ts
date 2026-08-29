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
//
// Cross-slice binding (MIL-121): the canonical two-slice Automation/Translation shape (MIL-120)
// splits one design conversation across a view-only slice and its reaction+command+event slice,
// but a team may still want ONE doc to cover both. A `note "slices/<other-key>.md"` pointing at
// a DIFFERENT slice's canonical path is an explicit request to borrow that doc — honored only
// when the other end also ratifies it, via that doc's own frontmatter `covers:` list naming this
// slice's key. This is a two-ended handshake by design: an unratified cross-note (the target
// doc doesn't list this slice in `covers`, is missing, or has unusable frontmatter) leaves the
// slice silently unbound (`no-doc-bound`) rather than warning here — a one-sided note is exactly
// the same "hasn't reached specify yet" state as no note at all *from this module's point of
// view*. Canonical binding (a note naming this slice's own path) always takes precedence and is
// checked first, unchanged from before this ticket.
//
// MIL-126 gives the silent cases above (and a canonically-bound slice's OTHER, now-pointless
// notes) their own diagnostic instead of staying silent forever: see
// catalog/noteBindingValidate.ts, a sibling module, not folded in here — same reasoning as
// lineageValidate.ts/frontmatterCoherenceValidate.ts staying separate from this one, and it
// needs a second, cross-cutting pass over EVERY doc-shaped note on a slice (not just the winning
// one) to tell "extra" from "dangling" from "unratified". It reuses `NOTE_SLICE_PATH` and
// `resolveCrossCandidate` below rather than re-deriving the ratification predicate.

import { Slice } from "../model/model.js";
import { Diagnostic } from "../model/validate.js";
import { makeDiag } from "../model/rules.js";
import { classifyImplementationDrift, DriftSignalKind } from "./driftSignal.js";
import { readSliceDoc } from "./readSliceDoc.js";
import { hasUsableFrontmatter, SliceDoc, SliceRef } from "./sliceDoc.js";

// Matches a `note "slices/<key>.md"` value's path shape, to pull `<key>` back out for the
// MIL-121 cross-binding search below (and MIL-126's mismatch sweep, catalog/noteBindingValidate.ts)
// — same kebab-slug grammar sliceDoc.ts's SLICE_REF uses.
export const NOTE_SLICE_PATH = /^slices\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/i;

/** One cross-binding candidate's resolution against `sliceKey`'s ratification requirement:
 *  the target file doesn't exist, exists but its frontmatter isn't usable, exists and is usable
 *  but doesn't list `sliceKey` in its `covers:` (doesn't carry the `doc` — nothing downstream
 *  needs it), or ratifies (does carry `doc`, the parse the caller needs next). */
export type CrossCandidateResolution =
  | { status: "missing" }
  | { status: "unusable" }
  | { status: "unratified" }
  | { status: "ratified"; doc: SliceDoc };

/**
 * Resolves a single `slices/<candidateKey>.md` cross-binding candidate — the exact ratification
 * predicate `resolveSliceDocJoin`'s cross-binding search (MIL-121) applies, extracted so
 * `noteBindingValidate.ts` (MIL-126) can classify a *non*-winning candidate's reason without
 * re-deriving what "ratifies" means. One source of truth for both.
 */
export function resolveCrossCandidate(baseDir: string, candidateKey: string, sliceKey: string): CrossCandidateResolution {
  const doc = readSliceDoc(baseDir, candidateKey);
  if (!doc) return { status: "missing" };
  if (!hasUsableFrontmatter(doc)) return { status: "unusable" };
  if (!doc.covers.includes(sliceKey)) return { status: "unratified" };
  return { status: "ratified", doc };
}

export type DocReason = "no-doc-bound" | "binding-missing-file" | "frontmatter-invalid" | null;

/** A slice's export-facing doc join — always a non-null object (never JSON `null`), matching
 *  every other optional field in `em export`'s style: explicit-null-on-a-stable-key, never a
 *  nullable wrapper. `reason` is null exactly when `found` is true and the frontmatter parsed
 *  cleanly; otherwise it names which of the three broken states applies. */
export interface SliceDocExport {
  found: boolean;
  /** The bound doc's path — the conventional `slices/<sliceKey>.md` for the ordinary canonical
   *  binding, or (MIL-121) a different slice's canonical path when this slice's doc join
   *  resolved to a ratified cross-binding instead. Always present regardless of `found` — when
   *  nothing is bound (or bound-but-unratified), it's still the conventional path this slice's
   *  own doc would need to exist at. */
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
  /** MIL-165: who ratified this doc's current `status`/`version` (frontmatter `ratifiedBy:`),
   *  written only by `em slice ratify` — null when absent (a doc predating this feature, or
   *  ratified by hand before it existed). */
  ratifiedBy: string | null;
  /** MIL-165: when this doc was ratified (frontmatter `ratifiedOn:`, `YYYY-MM-DD`), written only
   *  by `em slice ratify` — null when absent, same as `ratifiedBy`. */
  ratifiedOn: string | null;
  /** MIL-171: who (a person or team) holds this slice, from frontmatter `owner:` — hand-filled,
   *  no `em` command writes it. Null when absent. */
  owner: string | null;
  /** MIL-171: a URL into an external tracker mirroring this slice, from frontmatter `tracking:`
   *  — hand-filled, no `em` command writes it. Null when absent. This is the exact field
   *  em-tracker-bridge reads to find the mirrored ticket — its name/shape here is a cross-tool
   *  contract, not just an internal display field. */
  tracking: string | null;
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
  ratifiedBy: null as string | null,
  ratifiedOn: null as string | null,
  owner: null as string | null,
  tracking: null as string | null,
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
    // No canonical binding — MIL-121: look for a ratified cross-binding before giving up. Walk
    // elements in declaration order (deterministic "first wins") for a `note "slices/<other>.md"`
    // naming a DIFFERENT slice, and accept the first one `resolveCrossCandidate` reports as
    // ratified. Anything short of that (missing file, unusable frontmatter, or no ratifying
    // `covers` entry) is silently not a binding at all here (same as no note ever having been
    // written) — MIL-126's noteBindingValidate.ts is where that non-winning candidate's specific
    // reason becomes its own diagnostic, using this same predicate.
    for (const el of slice.elements) {
      if (!el.note) continue;
      const m = el.note.match(NOTE_SLICE_PATH);
      if (!m) continue;
      const otherKey = m[1].toLowerCase();
      if (otherKey === sliceKey) continue; // already handled above; can't happen if we got here
      const result = resolveCrossCandidate(baseDir, otherKey, sliceKey);
      if (result.status !== "ratified") continue;
      // Normalized (lowercased) path, NOT `el.note` verbatim: `otherKey` is lowercased before
      // the readSliceDoc() call above (NOTE_SLICE_PATH is case-insensitive), so a mixed-case
      // note like `note "slices/Request-Payment.md"` must still report the path it actually
      // read — `slices/request-payment.md` — not the note's original casing. Otherwise a
      // consumer that re-derives the key from `doc.path` (sliceReadyValidate.ts) would try to
      // re-read the mixed-case path and get null on a case-sensitive filesystem.
      return { doc: foundDoc(`slices/${otherKey}.md`, result.doc), diagnostics: [] };
    }
    return { doc: { found: false, path, reason: "no-doc-bound", ...EMPTY_CONTENT }, diagnostics: [] };
  }

  const parsed = readSliceDoc(baseDir, sliceKey);
  if (!parsed) {
    return {
      doc: { found: false, path, reason: "binding-missing-file", ...EMPTY_CONTENT },
      diagnostics: [
        makeDiag("binding-missing-file", {
          message: `slice "${slice.name}" notes "${path}" but no such file exists`,
          line: boundEls[0].line,
          refs: [sliceKey, ...boundEls.map((el) => elementRefOf(el.id))],
        }),
      ],
    };
  }

  if (!hasUsableFrontmatter(parsed)) {
    return {
      doc: { found: true, path, reason: "frontmatter-invalid", ...EMPTY_CONTENT },
      diagnostics: [
        makeDiag("frontmatter-invalid", {
          message: parsed.frontmatterPresent
            ? `slice doc "${path}" is missing required frontmatter keys: ${parsed.missingRequiredFields.join(", ")}`
            : `slice doc "${path}" has no frontmatter block`,
          line: slice.line,
          refs: [sliceKey],
        }),
      ],
    };
  }

  return { doc: foundDoc(path, parsed), diagnostics: [] };
}

/** Builds the `found: true, reason: null` doc join result shared by a canonical binding and a
 *  ratified MIL-121 cross-binding — `path` is whichever path the content actually came from. */
function foundDoc(path: string, parsed: SliceDoc): SliceDocExport {
  return {
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
    ratifiedBy: parsed.ratifiedBy,
    ratifiedOn: parsed.ratifiedOn,
    owner: parsed.owner,
    tracking: parsed.tracking,
  };
}
