// SPDX-License-Identifier: MIT
// `em coverage` (MIL-130): a mechanical check for reference/implement.md's definition-of-done
// line "every INV-n has a test that cites its ID" — until now a pure honor system, since no `em`
// command related a slice doc's invariant IDs to a test suite. Both sides are stable strings
// (the doc's `INV-*` tokens, a test file's source text), so the citation check is deterministic
// and grep-shaped: extract every invariant ID a slice doc's own Invariants/Delta sections define
// (MIL-149: not every ID its prose merely mentions — a doc narratively citing another slice's ID
// doesn't own it; MIL-155: including a citation embedded inside those very sections, e.g. an
// Invariants bullet's explanation pointing at a sibling slice's ID), then scan a test tree for
// lines that cite it.
//
// Deliberately a *second*, independent reader of doc bodies, alongside `em export`'s doc join
// (docJoin.ts, MIL-91) — not a change to it. `em export`'s frontmatter-only contract is
// untouched: this module never adds a frontmatter field, and it reads `SliceDoc.body` (already
// exposed for `em ledger`'s content comparison, catalog/sliceDoc.ts) rather than reshaping the
// export document. Checks that an ID is *cited*, nothing about whether the citing test is good
// or passing — that stays with review and CI respectively; no judgment mechanized here.
//
// Token format: `INV-<KEY>-n` where `<KEY>` is present in nothing textually — the actual convention
// found in the codebase (templates/slice.md's own Invariants section, reference/conform.md's
// worked example `INV-CHK-4`) uses either a bare running number (`INV-1`, `INV-2`) or a per-slice
// mnemonic prefix (`INV-CHK-3`, `INV-CHK-3a` for a rename) — IDs are hand-authored per
// docs/slice-doc-schema.md, "give each a stable ID", not machine-generated, so no single fixed
// shape is enforced by any `em` command. INV_TOKEN_RE below matches both: `INV-` followed by a
// greedy run of alphanumeric/hyphen segments. Greedy is what keeps `INV-KEY-1` from partially
// matching inside `INV-KEY-12` during *extraction* (`\d+` inside the run always consumes the full
// digit sequence); citation *scanning* below re-anchors with `\b` on the exact ID string for the
// same reason, since that direction is a substring search rather than a token match.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";
import { readSliceDoc } from "../catalog/readSliceDoc.js";
import { walkDir } from "../util/walkDir.js";

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
const OWNERSHIP_HEADING_RE = /^##\s+(?:Invariants(?:\s*\/\s*Business Rules)?|Delta)\s*$/i;

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
const STRUCTURAL_LINE_RE = /^(?:[-*]\s|#{3,6}\s)/;

/** Statuses `reference/implement.md`'s coverage gate applies to, by default (MIL-207). Doc
 *  ratification (`draft` -> `reviewed` -> `ready-to-implement`) is the hand-off *before*
 *  implementation, not a claim that implementing code exists yet — a `ready-to-implement` doc
 *  has, by definition, nothing to cite its invariants, so scoping the gate to it made every
 *  ratification PR fail coverage before a line of implementing code (or its test) existed
 *  (`em ci init`'s generated job, gating every PR on `main`). Scope starts at `implemented` and
 *  stays in scope forever after (tests shouldn't regress away from citing an invariant just
 *  because the slice shipped). Anything else (`draft`, `reviewed`, or no doc at all) is out of
 *  scope. */
const IN_SCOPE_STATUSES_DEFAULT = new Set(["implemented"]);

/** `--include-ready` (CLI `em coverage`; `includeReady` on the MCP `coverage` tool's input)
 *  opts back into the pre-MIL-207 scope — `ready-to-implement` docs included — for a team that
 *  wants the forward-looking report: which invariants will need a citing test once
 *  implementation starts. Never the default, since that's exactly the every-ratification-PR-
 *  is-red behavior MIL-207 fixes. */
const IN_SCOPE_STATUSES_WITH_READY = new Set(["ready-to-implement", "implemented"]);

function inScopeStatuses(includeReady: boolean): Set<string> {
  return includeReady ? IN_SCOPE_STATUSES_WITH_READY : IN_SCOPE_STATUSES_DEFAULT;
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
  let inOwnershipSection = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^#{1,2}\s/.test(line)) {
      inOwnershipSection = OWNERSHIP_HEADING_RE.test(line);
      continue;
    }
    if (!inOwnershipSection || !STRUCTURAL_LINE_RE.test(line)) continue;
    for (const m of line.matchAll(INV_TOKEN_RE)) {
      if (!seen.has(m[0])) {
        seen.add(m[0]);
        ids.push(m[0]);
      }
    }
  }
  return ids;
}

export interface Citation {
  /** Path relative to the `--tests <dir>` root, POSIX forward slashes — same convention
   *  walkDir() already returns. */
  file: string;
  /** 1-based line number within `file`. */
  line: number;
}

// Directory segments never worth descending into for citations: dependency trees
// (node_modules) and VCS metadata (.git) can be enormous and never contain a test file worth
// scanning. Passed to walkDir() as a skipDir predicate so these subtrees are pruned during
// descent rather than walked in full and filtered out afterward — the skill walkers
// (skillSync.ts/skillCheck.ts) never encounter this problem in the first place, since the
// bundled skill directory they walk never contains a node_modules or .git of its own.
const SKIP_DIR_SEGMENTS = new Set(["node_modules", ".git"]);

/** Cheap binary sniff: a NUL byte anywhere in the first few KB is not valid UTF-8/ASCII text —
 *  every text source file this check cares about (and every test fixture worth citing an
 *  invariant from) will fail this in exactly zero legitimate cases. */
function isLikelyBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Scan every text file under `testsDir` for lines citing any of `ids`, word-boundary-anchored so
 * `INV-KEY-1` doesn't match inside `INV-KEY-12` (both boundary sides land on a hyphen/alnum
 * transition since the ID alphabet is exactly `[A-Za-z0-9-]`, so no escaping is needed to build
 * the per-ID regex). Returns every citing `{file, line}`, in walk order — a line citing more than
 * one ID is recorded under each. `ids` with zero test-dir mentions still get a `[]` entry, never
 * an absent map key, so a caller never has to guard a lookup with `?? []`.
 */
export function scanTestCitations(testsDir: string, ids: readonly string[]): Map<string, Citation[]> {
  const citations = new Map<string, Citation[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return citations;
  const idPatterns: Array<[string, RegExp]> = ids.map((id) => [id, new RegExp(`\\b${id}\\b`)]);

  for (const rel of walkDir(testsDir, { skipDir: (name) => SKIP_DIR_SEGMENTS.has(name) })) {
    let buf: Buffer;
    try {
      buf = readFileSync(join(testsDir, rel));
    } catch {
      continue; // unreadable (permissions, broken symlink target, ...) — not this check's job
    }
    if (isLikelyBinary(buf)) continue;

    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const [id, re] of idPatterns) {
        if (re.test(line)) citations.get(id)!.push({ file: rel, line: i + 1 });
      }
    }
  }
  return citations;
}

export interface InvariantCoverage {
  id: string;
  cited: boolean;
  citations: Citation[];
}

export interface SliceCoverage {
  key: string;
  /** The joined doc's `status`, or null when no usable doc was found — carried even for an
   *  out-of-scope slice, for transparency (a reader can see *why* it was skipped). */
  status: string | null;
  /** The resolveSliceDocJoin() `DocReason` behind `status: null` — `"no-doc-bound"`,
   *  `"binding-missing-file"`, or `"frontmatter-invalid"` — or null when the doc joined cleanly
   *  (whether or not the slice ended up in scope; a draft slice with a perfectly good doc still
   *  has `docReason: null`). Lets an out-of-scope reader tell "nothing bound yet" apart from
   *  "bound but broken" without re-running the join themselves. */
  docReason: string | null;
  /** True when this slice's doc was found, its frontmatter usable, and `status` is in scope —
   *  `implemented` by default, plus `ready-to-implement` with `--include-ready` (MIL-207). The
   *  only slices `invariants` is populated for. */
  inScope: boolean;
  invariants: InvariantCoverage[];
}

export interface CoverageReport {
  slices: SliceCoverage[];
  /** Total invariant IDs across every in-scope slice (sum of `slices[*].invariants.length`). */
  totalInvariants: number;
  /** Of `totalInvariants`, how many have zero citations. */
  uncoveredCount: number;
}

/** One slice's doc-join outcome, cheap to resolve (no test-tree scan) — the bit every
 *  `--tests <dir>` consumer needs to answer "is there anything in scope at all?" before it
 *  decides whether a missing test directory is an error (MIL-207: with zero in-scope docs
 *  there's nothing to cite, so a fresh scaffold's absent `test/` isn't a defect). */
export interface ScopedSlice {
  key: string;
  status: string | null;
  docReason: string | null;
  inScope: boolean;
  /** The bound doc's path (`SliceDocExport.path`) — present even when out of scope or unbound,
   *  same convention as `SliceCoverage.status`/`docReason` above. */
  docPath: string;
}

/**
 * Resolve every slice's doc-join and in-scope status, without touching the test tree. Shared by
 * `buildCoverageReport` (below) and every `--tests` consumer that needs to know, before checking
 * whether `--tests <dir>` exists, whether anything is in scope — so "is there anything to check"
 * has exactly one answer everywhere it's asked (MIL-207: don't fork the leniency logic per
 * consumer). `includeReady` selects `IN_SCOPE_STATUSES_WITH_READY` over the MIL-207 default.
 */
export function resolveScopedSlices(
  model: NormalizedModel,
  refs: RefsResult,
  baseDir: string,
  includeReady: boolean,
): ScopedSlice[] {
  const scopeStatuses = inScopeStatuses(includeReady);
  const result: ScopedSlice[] = [];
  model.slices.forEach((slice, i) => {
    const key = refs.sliceKeys[i];
    const { doc, continuationOf: continuationOfKey } = resolveSliceDocJoin(
      model,
      refs,
      slice,
      key,
      baseDir,
      (id) => refs.refById.get(id)!,
    );
    // MIL-208: a continuation slice (an again-view-only slice with no legacy doc of its own)
    // has nothing of its own to cite — its invariants, if any, live in the ORIGINATING slice's
    // doc, which already gets its own entry here. Including the continuation key too would just
    // duplicate that entry under a second key.
    if (continuationOfKey !== null) return;
    const inScope = doc.reason === null && doc.status !== null && scopeStatuses.has(doc.status);
    result.push({ key, status: doc.status, docReason: doc.reason, inScope, docPath: doc.path });
  });
  return result;
}

/**
 * Assemble the full coverage report: for every slice in the model, resolve its doc-join/in-scope
 * status (`resolveScopedSlices`), extract invariant IDs for in-scope slices, then scan `testsDir`
 * once for every ID across the whole model (cheaper than one scan per slice, and citations are
 * looked up per-slice from the single resulting map). `baseDir` is the `.em` file's directory,
 * same convention every doc/note path in `em` uses. `includeReady` (MIL-207, default false)
 * widens scope to also count `ready-to-implement` docs — when false (the default) and nothing in
 * the model is `implemented` yet, `allIds` stays empty and `testsDir` is never read, so calling
 * this with a `testsDir` that doesn't exist yet is safe in that case (see callers' leniency
 * check via `resolveScopedSlices` before this).
 */
export function buildCoverageReport(
  model: NormalizedModel,
  refs: RefsResult,
  baseDir: string,
  testsDir: string,
  includeReady = false,
): CoverageReport {
  const scoped = resolveScopedSlices(model, refs, baseDir, includeReady);
  const allIds = new Set<string>();

  const withIds = scoped.map(({ key, status, docReason, inScope, docPath }) => {
    let ids: string[] = [];
    if (inScope) {
      // Re-derive the bound doc's key from docPath rather than assuming it's this slice's own
      // — MIL-121's ratified cross-binding can resolve the doc to a DIFFERENT slice's doc, same
      // re-derivation sliceReadyValidate.ts uses for Open Questions.
      const boundKey = docPath.replace(/^slices\//, "").replace(/\.md$/, "");
      const parsed = readSliceDoc(baseDir, boundKey);
      if (parsed) ids = extractInvariantIds(parsed.body);
    }
    for (const id of ids) allIds.add(id);
    return { key, status, docReason, inScope, ids };
  });

  const citations = scanTestCitations(testsDir, [...allIds]);

  let totalInvariants = 0;
  let uncoveredCount = 0;
  const slices: SliceCoverage[] = withIds.map(({ key, status, docReason, inScope, ids }) => {
    const invariants: InvariantCoverage[] = ids.map((id) => {
      const cs = citations.get(id) ?? [];
      totalInvariants++;
      if (cs.length === 0) uncoveredCount++;
      return { id, cited: cs.length > 0, citations: cs };
    });
    return { key, status, docReason, inScope, invariants };
  });

  return { slices, totalInvariants, uncoveredCount };
}
