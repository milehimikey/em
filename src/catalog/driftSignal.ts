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

import { shippedRecordOf, SliceDoc } from "./sliceDoc.js";

export type DriftSignalKind =
  /** shipped, implementedIn set, the doc's version IS the shipped version and conformedVersion
   *  matches it — certified current. */
  | "in-sync"
  /** nothing shipped, implementedIn absent — normal pre-ship state. */
  | "never-implemented"
  /** a ratified/drafted delta hasn't shipped yet: either the doc's `version:` is past the shipped
   *  version (MIL-283 — a later draft is open over a shipped version), or (pre-1.15 shape) status
   *  is off `implemented` while `implementedIn` still names the prior version's PR. Expected, not
   *  a defect: never surface this as fresh drift or a validate diagnostic. */
  | "unpropagated-delta"
  /** shipped, implementedIn absent — genuine incoherence (em validate warns). */
  | "implemented-without-link"
  /** shipped, implementedIn set, the doc's version is the shipped version, but conformedVersion
   *  is absent or doesn't match — nobody has certified THIS version yet. Expected post-ship
   *  default, not a defect: never surface this as an `em validate` diagnostic (see
   *  catalog/frontmatterCoherenceValidate.ts, which only ever flags implemented-without-link). */
  | "uncertified";

/**
 * Classify a doc's drift from its shipped record (MIL-283: `shippedRecordOf`, which reads the
 * `shipped*` keys and, for a doc written before 1.15, `status: implemented`), its `implementedIn`,
 * its working `version` and `conformedVersion`. Takes a `Pick` rather than the full `SliceDoc`
 * so callers building a partial/synthetic doc (tests, future callers) don't need every field.
 */
export function classifyImplementationDrift(
  doc: Pick<
    SliceDoc,
    "status" | "implementedIn" | "version" | "conformedVersion" | "ratifiedRef" | "shippedVersion" | "shippedRef" | "shippedOn"
  >,
): DriftSignalKind {
  const hasLink = typeof doc.implementedIn === "string" && doc.implementedIn.trim().length > 0;
  const shipped = shippedRecordOf(doc);
  if (shipped === null) return hasLink ? "unpropagated-delta" : "never-implemented";
  if (!hasLink) return "implemented-without-link";
  // A later version is open (draft/reviewed/ready-to-implement) over the shipped one.
  if (shipped.version !== null && doc.version !== null && doc.version > shipped.version) return "unpropagated-delta";
  return doc.conformedVersion !== null && doc.conformedVersion === shipped.version ? "in-sync" : "uncertified";
}
