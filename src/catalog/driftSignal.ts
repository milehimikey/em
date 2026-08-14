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

import { SliceDoc } from "./sliceDoc.js";

export type DriftSignalKind =
  /** status: implemented, implementedIn set — normal shipped state. */
  | "in-sync"
  /** status not implemented, implementedIn absent — normal pre-ship state. */
  | "never-implemented"
  /** status not implemented, implementedIn still set — a ratified delta hasn't shipped yet.
   *  Expected, not a defect: never surface this as fresh drift or a validate diagnostic. */
  | "unpropagated-delta"
  /** status: implemented, implementedIn absent — genuine incoherence (em validate warns). */
  | "implemented-without-link";

/**
 * Classify a doc's status/implementedIn pair. Takes a `Pick` rather than the full `SliceDoc` so
 * callers building a partial/synthetic doc (tests, future callers) don't need every field.
 */
export function classifyImplementationDrift(doc: Pick<SliceDoc, "status" | "implementedIn">): DriftSignalKind {
  const hasLink = typeof doc.implementedIn === "string" && doc.implementedIn.trim().length > 0;
  if (doc.status === "implemented") return hasLink ? "in-sync" : "implemented-without-link";
  return hasLink ? "unpropagated-delta" : "never-implemented";
}
