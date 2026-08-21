// SPDX-License-Identifier: MIT
// `em validate --slice-ready <key>` (MIL-87): the handoff gate without the bridge. Gives em
// itself a native version of the readiness check that used to live only in em-sdd-bridge's
// `assertReadyToImplement` — status: ready-to-implement AND every Open Question checked —
// so any toolchain reading slice docs directly (not just ones routed through the bridge) has
// a gate to enforce.
//
// Deliberately single-slice, opt-in — unlike catalog/lineageValidate.ts (MIL-84) and
// catalog/frontmatterCoherenceValidate.ts (MIL-85), which run unconditionally on every
// `em validate` because they only fire on genuine anomalies. "Not yet ready-to-implement" /
// "has unchecked Open Questions" is the NORMAL state of most slices most of the time (drafts,
// reviewed-but-not-ready-yet, ...) — splicing this into the unconditional diagnostic set would
// make plain `em validate` permanently noisy on any healthy in-progress model. So this only
// ever runs for the one slice named by `--slice-ready <key>`.
//
// "Note binding" (the ticket's own phrase) means reusing docJoin.ts's resolveSliceDocJoin — the
// same note-gated resolution `em export` (MIL-91) uses — rather than the filename-only
// readSliceDoc/existsSync convention `em catalog`/`em render` deliberately use instead (that
// convention has a tested invariant of ignoring `note` entirely; this module doesn't touch it).
// A slice with no `note "slices/<key>.md"` element bound to it isn't ready by definition: there's
// nothing ratified to check status/Open Questions against.
//
// version/status/link coherence (MIL-85) is folded in for free at the CLI layer (src/cli.ts):
// validateFrontmatterCoherence already runs unconditionally and already tags its diagnostics
// with `refs: [sliceKey]`, so the `--slice-ready` branch filters the full combined diagnostic
// set by that ref instead of this module re-deriving classifyImplementationDrift.

import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { Diagnostic } from "../model/validate.js";
import { makeDiag, pushDiag } from "../model/rules.js";
import { resolveSliceDocJoin } from "./docJoin.js";
import { readSliceDoc } from "./readSliceDoc.js";

/**
 * Readiness gate for one slice, named by its export key (`refs.sliceKeys`). `baseDir` is the
 * `.em` file's directory, same convention every other doc/note path in em uses. Always warning-
 * severity (fits validate's existing warning-producer shape) except for a bad `sliceKey` itself,
 * which is an error — a CLI-argument mistake, not a model-quality finding. The `--slice-ready`
 * flag in src/cli.ts is what decides whether these warnings gate the exit code.
 */
export function validateSliceReady(
  model: NormalizedModel,
  refs: RefsResult,
  baseDir: string,
  sliceKey: string,
): Diagnostic[] {
  const sliceIndex = refs.sliceKeys.indexOf(sliceKey);
  if (sliceIndex === -1) {
    return [
      makeDiag("slice-ready-unknown-slice", {
        message: `no slice with export key "${sliceKey}" in this model`,
        refs: [sliceKey],
      }),
    ];
  }
  const slice = model.slices[sliceIndex];
  const { doc, diagnostics: joinDiagnostics } = resolveSliceDocJoin(
    slice,
    sliceKey,
    baseDir,
    (id) => refs.refById.get(id)!,
  );

  if (doc.reason === "no-doc-bound") {
    return [
      makeDiag("slice-ready-no-doc-bound", {
        message: `slice "${sliceKey}" has no doc bound via \`note "slices/${sliceKey}.md"\` — bind a slice doc before it can be ready-to-implement`,
        line: slice.line,
        refs: [sliceKey],
      }),
    ];
  }
  if (doc.reason === "binding-missing-file" || doc.reason === "frontmatter-invalid") {
    // Reuse docJoin's own diagnostics verbatim — don't re-code binding-missing-file/
    // frontmatter-invalid a second time under a slice-ready-specific code.
    return joinDiagnostics;
  }

  // doc.reason === null: found, usable frontmatter.
  const diags: Diagnostic[] = [];
  if (doc.status !== "ready-to-implement") {
    pushDiag(diags, "slice-ready-status-not-ready", {
      message: `slice "${sliceKey}" is status: ${doc.status ?? "(none)"}, not ready-to-implement`,
      line: slice.line,
      refs: [sliceKey],
    });
  }

  // resolveSliceDocJoin's SliceDocExport deliberately never carries Open Questions counts (same
  // hard boundary that keeps doc.html/doc.raw out of it) — re-read via readSliceDoc for the
  // full SliceDoc. Non-null: doc.reason === null already implies the file exists and parses.
  // Re-derive the key to read from `doc.path` rather than assuming it's `sliceKey`'s own
  // conventional path — MIL-121's ratified cross-binding can resolve `doc` to a DIFFERENT
  // slice's doc (`slices/<other-key>.md`), and Open Questions must come from whichever doc
  // actually supplied status/version above, not always this slice's own file.
  const boundKey = doc.path.replace(/^slices\//, "").replace(/\.md$/, "");
  const parsed = readSliceDoc(baseDir, boundKey)!;
  if (parsed.openQuestionsUnchecked > 0) {
    pushDiag(diags, "slice-ready-open-questions-unchecked", {
      message: `slice "${sliceKey}" has ${parsed.openQuestionsUnchecked} of ${parsed.openQuestionsTotal} Open Question(s) unchecked`,
      line: slice.line,
      refs: [sliceKey],
    });
  }

  return diags;
}
