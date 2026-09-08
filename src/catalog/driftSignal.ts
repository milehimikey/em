// SPDX-License-Identifier: MIT
// Classifies a slice doc's implementation-drift state from `status` + `implementedIn` alone
// (MIL-85). Pure — same spirit as sliceDoc.ts itself: no fs, no model, no baseDir — so
// `em export`'s doc join (catalog/docJoin.ts), `em validate`'s frontmatter-coherence check
// (catalog/frontmatterCoherenceValidate.ts), and the conform skill (reading `em export --json`'s
// `slice.doc.driftSignal`) all consume the exact same answer instead of re-deriving this
// predicate three different ways.
//
// The load-bearing distinction (docs/slice-doc-schema.md, "`status` under re-ratification"):
// re-ratifying a shipped slice flips `status` back off `implemented` while `implementedIn` keeps
// naming the prior version's PR. That combination — `unpropagated-delta` — is the EXPECTED drift
// signal, not staleness, and must never be flagged as incoherence. Only `implemented-without-link`
// (status: implemented, no link at all) is a genuine coherence problem worth a diagnostic.
//
// MIL-214: certification is per slice PER VERSION, not per model — `implementedIn` only ever
// said "code exists somewhere for this slice," never "the code that's there was actually walked
// against version N of this doc." `conformedVersion` (frontmatter, written only by
// `em slice conform` — cli/sliceConform.ts) records the version a conform run last certified.
// `uncertified` is the new, EXPECTED post-ship default: a slice reaches `status: implemented`
// long before anyone runs a conform sweep against it, and every version bump (`em slice
// reratify`) invalidates the prior certification even though `status`/`implementedIn` still read
// "shipped" — so this is not folded into `in-sync` and not flagged by `em validate` (same
// "expected, not a defect" treatment `unpropagated-delta` gets).

import { SliceDoc } from "./sliceDoc.js";

export type DriftSignalKind =
  /** status: implemented, implementedIn set, conformedVersion === version — certified current. */
  | "in-sync"
  /** status not implemented, implementedIn absent — normal pre-ship state. */
  | "never-implemented"
  /** status not implemented, implementedIn still set — a ratified delta hasn't shipped yet.
   *  Expected, not a defect: never surface this as fresh drift or a validate diagnostic. */
  | "unpropagated-delta"
  /** status: implemented, implementedIn absent — genuine incoherence (em validate warns). */
  | "implemented-without-link"
  /** status: implemented, implementedIn set, but conformedVersion is absent or doesn't match the
   *  current version — nobody has certified THIS version yet. Expected post-ship default, not a
   *  defect: never surface this as an `em validate` diagnostic (see
   *  catalog/frontmatterCoherenceValidate.ts, which only ever flags implemented-without-link). */
  | "uncertified";

/**
 * Classify a doc's status/implementedIn/version/conformedVersion quadruple. Takes a `Pick`
 * rather than the full `SliceDoc` so callers building a partial/synthetic doc (tests, future
 * callers) don't need every field.
 */
export function classifyImplementationDrift(
  doc: Pick<SliceDoc, "status" | "implementedIn" | "version" | "conformedVersion">,
): DriftSignalKind {
  const hasLink = typeof doc.implementedIn === "string" && doc.implementedIn.trim().length > 0;
  if (doc.status === "implemented") {
    if (!hasLink) return "implemented-without-link";
    return doc.conformedVersion !== null && doc.conformedVersion === doc.version ? "in-sync" : "uncertified";
  }
  return hasLink ? "unpropagated-delta" : "never-implemented";
}
