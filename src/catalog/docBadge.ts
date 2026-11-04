// SPDX-License-Identifier: MIT
// GH #402: the compact frontmatter badge row shown above a slice doc's body wherever
// `SliceDoc.html` is rendered — `em catalog`'s per-slice page (catalog/pages.ts) and the live
// viewer's doc flyout (render/sliceOverlay.ts). Both callers already hold a resolved `SliceDoc`
// and can compute its `classifyImplementationDrift()` (catalog/driftSignal.ts) themselves; this
// module takes the four already-resolved primitives rather than either type, so it carries no
// dependency on catalog/sliceDoc.ts or catalog/driftSignal.ts and can't become part of a cycle
// with either. Pure: primitives in, an HTML string out.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** `"state-change"` -> `"State Change"`, `"ready-to-implement"` -> `"Ready To Implement"` — the
 *  frontmatter's kebab-case machine values, in the display label shape the skill prose already
 *  uses for `pattern` (sliceDoc.ts's own comment: "the frontmatter value is a machine key, not a
 *  display label"). */
function titleCase(kebab: string): string {
  return kebab
    .split("-")
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Readable labels for `classifyImplementationDrift`'s `DriftSignalKind` — duplicated here as
 *  strings rather than importing the union type, so this module stays free of any dependency on
 *  catalog/driftSignal.ts (see file header). An unrecognized value (there shouldn't be one) falls
 *  back to showing itself verbatim rather than disappearing. */
const DRIFT_LABELS: Record<string, string> = {
  "in-sync": "In sync",
  "never-implemented": "Not implemented",
  "unpropagated-delta": "Delta pending",
  "implemented-without-link": "Implemented, no link",
  uncertified: "Uncertified",
};

export interface FrontmatterBadgeInput {
  /** `SliceDoc.pattern` — kebab-case or null. */
  pattern: string | null;
  /** `SliceDoc.version` or null. */
  version: number | null;
  /** `SliceDoc.status`, lowercase, or null. */
  status: string | null;
  /** `classifyImplementationDrift(doc)`'s result, as its string value. */
  driftSignal: string;
}

/** GH #402: a compact badge row — pattern, version, lifecycle status, implementation-drift
 *  signal — built from a slice doc's own frontmatter facts. Callers gate this on
 *  `doc.frontmatterPresent` themselves (catalog/pages.ts, render/sliceOverlay.ts): a legacy
 *  freeform doc with no frontmatter at all renders with no badge row, exactly as it did before
 *  this feature. */
export function renderFrontmatterBadgeRow(input: FrontmatterBadgeInput): string {
  const badges: string[] = [];
  if (input.pattern) badges.push(`<span class="doc-badge doc-badge--pattern">${escapeHtml(titleCase(input.pattern))}</span>`);
  if (input.version !== null) badges.push(`<span class="doc-badge doc-badge--version">v${input.version}</span>`);
  if (input.status) badges.push(`<span class="doc-badge doc-badge--status">${escapeHtml(titleCase(input.status))}</span>`);
  const driftLabel = DRIFT_LABELS[input.driftSignal] ?? input.driftSignal;
  badges.push(
    `<span class="doc-badge doc-badge--drift doc-badge--drift-${escapeHtml(input.driftSignal)}">${escapeHtml(driftLabel)}</span>`,
  );
  return `<div class="doc-badge-row">${badges.join("")}</div>`;
}
