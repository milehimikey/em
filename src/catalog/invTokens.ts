// SPDX-License-Identifier: MIT
// The INV-* token grammar and the ownership-section extraction — a LEAF module (no imports), so
// both `em coverage`'s doc-side extraction (cli/coverage.ts, where this logic lived through
// 1.19.x) and the section-aware doc renderer (catalog/sliceDocRender.ts, GH #402) can read the
// same grammar without the renderer importing cli/coverage.ts — which imports catalog/docJoin.ts
// and catalog/readSliceDoc.ts, which import catalog/sliceDoc.ts, which imports the renderer: a
// genuine import cycle this split exists to break. cli/coverage.ts re-exports everything here,
// so its public surface is unchanged.
//
// Token format: `INV-<KEY>-n` where `<KEY>` is present in nothing textually — the actual
// convention found in the codebase (templates/slice.md's own Invariants section,
// reference/conform.md's worked example `INV-CHK-4`) uses either a bare running number
// (`INV-1`, `INV-2`) or a per-slice mnemonic prefix (`INV-CHK-3`, `INV-CHK-3a` for a rename) —
// IDs are hand-authored per docs/slice-doc-schema.md, "give each a stable ID", not
// machine-generated, so no single fixed shape is enforced by any `em` command. INV_TOKEN_RE
// matches both: `INV-` followed by a greedy run of alphanumeric/hyphen segments. Greedy is what
// keeps `INV-KEY-1` from partially matching inside `INV-KEY-12` during *extraction* (`\d+`
// inside the run always consumes the full digit sequence); citation *scanning* (cli/coverage.ts)
// re-anchors with `\b` on the exact ID string for the same reason, since that direction is a
// substring search rather than a token match.

/** The stable INV token format. `INV-` then one or more alphanumeric/hyphen segments — matches
 *  both `INV-1`/`INV-2` (the template's bare numbering) and `INV-CHK-4`/`INV-CHK-3a` (the
 *  per-slice mnemonic style reference/conform.md's own example uses). Exported so tests can
 *  assert against the exact grammar. */
export const INV_TOKEN_RE = /\bINV-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\b/g;

/** Headings whose content *defines* (or, for `## Delta`, legitimately re-declares) an invariant
 *  ID for the slice doc it appears in — `## Invariants / Business Rules` itself, and `## Delta`'s
 *  Added/Modified/Renamed requirement subsections, which introduce/rename IDs "from Invariants
 *  below" on re-ratification (see templates/slice.md). Every other section — Intent, Scenarios,
 *  Trigger & Actor, Dependencies & Read Models Affected, Open Questions, ... — is prose that may
 *  narratively *cite* another slice's ID without this doc owning it (MIL-149: such a mention was
 *  being cross-credited to the citing slice's own coverage ledger). */
export const OWNERSHIP_HEADING_RE = /^##\s+(?:Invariants(?:\s*\/\s*Business Rules)?|Delta)\s*$/i;

/** A line contributes INV tokens only when it's *structural* — a top-level bullet/list item
 *  (`- ...` / `* ...`, no leading indentation) or a subheading (`### ...` and deeper, since only
 *  `#`/`##` toggles `inOwnershipSection` above) — never an indented continuation line wrapping a
 *  multi-line bullet, nor a standalone prose paragraph with no bullet marker (MIL-155). Every
 *  cross-credit MIL-149 missed turned out to have exactly this shape: a slice's own Invariants
 *  bullet legitimately explains its rule across several wrapped lines, and a later wrapped line
 *  names a sibling slice's ID for context — e.g. `request-payment`'s `INV-RP-1` bullet wraps onto
 *  a line citing `payments-to-request`'s `INV-PTR-2` by way of explaining the exactly-once
 *  mechanism. The bullet's own *opening* line is structural and trusted for every ID it mentions
 *  (this also covers `## Delta`'s Renamed bullets, which legitimately declare two IDs — old and
 *  new — on one line, and its `**MODIFIED (...):** INV-X — ...` bullets, whose bold label isn't
 *  itself an ID); each wrapped continuation line is prose and contributes nothing. The indentation
 *  test also covers MIL-156's blessed nested-elaboration-bullet shape: `templates/slice.md`'s
 *  Invariants section now suggests a rule statement's optional rationale/edge-case detail go on
 *  its own indented sub-bullet (`  - {{...}}`) rather than run on into the rule sentence, purely
 *  for HTML-render readability — that sub-bullet is indented, so it's already excluded here the
 *  same as any other continuation line, and never contributes (or steals) an ID. */
export const STRUCTURAL_LINE_RE = /^(?:[-*]\s|#{3,6}\s)/;

/** The lines `extractInvariantIds` reads: structural lines inside an ownership section. */
export function ownershipStructuralLines(body: string): string[] {
  const out: string[] = [];
  let inOwnershipSection = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^#{1,2}\s/.test(line)) {
      inOwnershipSection = OWNERSHIP_HEADING_RE.test(line);
      continue;
    }
    if (inOwnershipSection && STRUCTURAL_LINE_RE.test(line)) out.push(line);
  }
  return out;
}

/**
 * Extract every distinct `INV-*` token this slice doc *defines*, in first-occurrence order (a
 * rule stated once in `## Invariants` and re-declared in a later `## Delta` section dedupes to
 * its first appearance — order is for stable, readable output, not a claim about which mention is
 * canonical). Scoped to `OWNERSHIP_HEADING_RE`'s sections only, so a doc's prose narratively
 * citing another slice's ID elsewhere (Dependencies, Open Questions, ...) doesn't cross-credit
 * that ID as this slice's own (MIL-149) — the section ends at the next `#`/`##` heading or EOF,
 * same boundary rule sliceDoc.ts's countOpenQuestions() uses, so a `### Added`/`#### Requirement`
 * subheading under `## Delta` stays in scope while a sibling `## Scenarios` does not. Within that
 * scope, only `STRUCTURAL_LINE_RE`'s bullet/subheading lines contribute — MIL-155 — so a wrapped
 * continuation line that legitimately *cites* a sibling slice's ID while explaining this doc's own
 * (e.g. an Invariants bullet's exactly-once rule wrapping onto a line naming another slice's
 * queue-draining ID) doesn't cross-credit that citation just because it sits inside the ownership
 * section too.
 */
export function extractInvariantIds(body: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const line of ownershipStructuralLines(body)) {
    for (const m of line.matchAll(INV_TOKEN_RE)) {
      if (!seen.has(m[0])) {
        seen.add(m[0]);
        ids.push(m[0]);
      }
    }
  }
  return ids;
}
