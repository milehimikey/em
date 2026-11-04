// SPDX-License-Identifier: MIT
// `em slice index` (MIL-98): rewrites the marker-delimited Slices table in a model's sibling
// README.md from the same facts `em export` derives for each slice — export key, AST-derived
// pattern, and the slice-doc frontmatter join — so the README's "ONE place slices are
// enumerated" (templates/model-readme.md) stops being hand-maintained, derived data that drifts.
//
// Deliberately no new parsing: buildSliceIndexTable below calls exactly the two functions
// `em export`'s own per-slice loop (src/emit/json.ts) calls — classifySlicePattern and
// resolveSliceDocJoin — so a slice's pattern/status/implementedIn here can never disagree with
// what `em export`/`em catalog` already say about it.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { Diagnostic } from "../model/validate.js";
import { classifySlicePattern, slicePatternLabel } from "../catalog/classify.js";
import { resolveSliceDocJoin, SliceDocExport } from "../catalog/docJoin.js";
import { applyMarker } from "../util/markers.js";
import { composedRank } from "../model/storylines.js";
import { kebabSlug } from "../util/slug.js";

/** The marker name wrapping the Slices table: `<!-- GENERATED:slices:start -->` /
 *  `<!-- GENERATED:slices:end -->`, matching templates/model-readme.md. */
export const SLICE_INDEX_MARKER = "slices";

/** The full table (`--full`): every lifecycle column. */
const TABLE_HEADER =
  "| # | Slice | Pattern | Status | Reviewed by | Ratified by | Owner | Tracking | Implemented in | Conformed | Design doc |\n" +
  "|---|-------|---------|--------|-------------|-------------|-------|----------|----------------|-----------|------------|";
/** The reader's table (default since the 2026-11-03 ruling): what a person needs to find a slice.
 *  The lifecycle columns are `em status`'s job; `--full` brings them back. */
const READER_HEADER = "| # | Slice | Pattern | Status | Design doc |\n|---|-------|---------|--------|------------|";
/** The root README's storyline table (`GENERATED:storylines`). */
export const STORYLINE_INDEX_MARKER = "storylines";
const STORYLINE_HEADER = "| Storyline | Slices | Implemented | Diagram |\n|-----------|--------|-------------|---------|";

/** MIL-214: `v<N> @ <rev>` when this slice's current version has a conformance certification
 *  (`doc.conformedVersion`/`doc.conformedAt` both set — always set together, `em slice conform`'s
 *  only write path), `—` otherwise. Deliberately reports the RECORDED certification verbatim,
 *  even when it's stale (`conformedVersion !== doc.version`, the `uncertified` driftSignal case)
 *  — `em status`/`em export`'s `driftSignal` is where "is this still current" is judged; this
 *  column is just "what was last certified, and against what revision". */
function conformedCell(doc: SliceDocExport): string {
  if (doc.conformedVersion === null || doc.conformedAt === null) return "—";
  return `v${doc.conformedVersion} @ ${doc.conformedAt}`;
}

/** Escape characters that would break a markdown table cell: `|` (the column separator) and
 *  newlines (a slice name is always one line, but a doc's freeform `implementedIn` text isn't
 *  guaranteed to be). */
function escapeCell(s: string): string {
  // Backslashes first: escaping `|` alone would let a pre-existing `\` in the source text
  // combine with the newly-inserted `\` (e.g. a literal `\|`) and un-escape the pipe again
  // once Markdown unescapes the backslash sequence (CodeQL "incomplete string escaping").
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Status cell wording: mirrors `em catalog`'s own found/status split (catalog/pages.ts's
 *  statusLabel — "no doc" when nothing was found, the doc's own status otherwise, "unknown" for
 *  a found-but-unusable doc) with one deliberate difference: "no doc yet", matching the wording
 *  templates/model-readme.md and reference/extract.md already use for a slice that hasn't
 *  reached the `slice` phase. `doc.found` false covers both of docJoin's not-found reasons
 *  (no-doc-bound and binding-missing-file) — catalog doesn't distinguish them either, since a
 *  broken binding still means "there's no doc a human can currently read." `continuationOf`
 *  (MIL-208) wins over both: a continuation slice's row names the originating slice instead of
 *  echoing its (borrowed) status verbatim, which would otherwise look like an independent slice
 *  happens to share the same status by coincidence. */
function statusCell(doc: SliceDocExport, continuationOf: string | null): string {
  if (continuationOf) return `continuation of \`${continuationOf}\``;
  if (!doc.found) return "no doc yet";
  return doc.status ?? "unknown";
}

export interface SliceIndexRow {
  index: number;
  /** The slice's position in `model.slices` (the timeline), for grouping and ordering. */
  sliceIndex: number;
  name: string;
  /** GH #277: the `storyline` block the slice is declared in, or `—`. The column is only
   *  rendered when the model declares at least one storyline (see `buildSliceIndexTable`), so a
   *  model without storylines keeps its README table byte-identical. */
  storyline: string;
  pattern: string;
  status: string;
  /** MIL-201: the doc's `reviewedBy`, or `—`. Sits between Status and Ratified by so the two
   *  human gates read left-to-right in the order they happen. */
  reviewedBy: string;
  ratifiedBy: string;
  owner: string;
  tracking: string;
  implementedIn: string;
  /** MIL-214: `v<N> @ <rev>`, or `—` — see `conformedCell`. */
  conformed: string;
  /** Null when the slice has no doc bound (nothing to link to) — rendered as `—`. */
  docPath: string | null;
}

export interface SliceIndexTable {
  /** The full replacement body for the GENERATED:slices block — header + one row per slice
   *  (or just the header when the model has no slices yet). For a model that declares
   *  storylines: one `### <Storyline>` section per storyline, its slices in timeline order and
   *  numbered within the story, then any slice outside every storyline. */
  markdown: string;
  /** The GENERATED:storylines body for the root README: one row per storyline (slice count,
   *  implemented count, diagram link) and the canvas link. Empty string without storylines. */
  storylinesMarkdown: string;
  rows: SliceIndexRow[];
  /** binding-missing-file / frontmatter-invalid warnings from resolveSliceDocJoin — the same
   *  diagnostics `em export` surfaces for a broken doc binding. */
  diagnostics: Diagnostic[];
}

export interface SliceIndexOptions {
  /** Every lifecycle column (the pre-2026-11 table) instead of the reader's five. */
  full?: boolean;
}

/** Build the Slices table body for `model`. `baseDir` is the `.em` file's directory — same
 *  doc-resolution convention `em export`/`em catalog` use for `slices/<key>.md`. */
export function buildSliceIndexTable(model: NormalizedModel, refs: RefsResult, baseDir: string, opts: SliceIndexOptions = {}): SliceIndexTable {
  const diagnostics: Diagnostic[] = [];

  // GH #287: a continuation column synthesized from `view X again` inside another slice has no
  // source slice block of its own, so it gets no row (and does not consume a row number).
  const rows: SliceIndexRow[] = [];
  model.slices.forEach((slice, i) => {
    if (slice.synthesized) return;
    const sliceKey = refs.sliceKeys[i];
    const pattern = classifySlicePattern(slice);
    const { doc, diagnostics: docDiags, continuationOf } = resolveSliceDocJoin(
      model,
      refs,
      slice,
      sliceKey,
      baseDir,
      (id) => refs.refById.get(id)!,
    );
    diagnostics.push(...docDiags);
    rows.push({
      index: rows.length + 1,
      sliceIndex: i,
      name: slice.name,
      storyline: slice.storyline ?? "—",
      pattern: slicePatternLabel(pattern),
      status: statusCell(doc, continuationOf),
      // GH #275: a continuation row borrows its parent's doc, but the parent's review /
      // ratify / tracking / implemented / conformed facts belong to the parent, not to this
      // row — show `—` and keep only the `continuation of …` status.
      reviewedBy: continuationOf ? "—" : (doc.reviewedBy ?? "—"),
      ratifiedBy: continuationOf ? "—" : (doc.ratifiedBy ?? "—"),
      owner: doc.owner ?? "—",
      tracking: continuationOf ? "—" : (doc.tracking ?? "—"),
      implementedIn: continuationOf ? "—" : (doc.implementedIn ?? "—"),
      conformed: continuationOf ? "—" : conformedCell(doc),
      // GH #275: `no-doc-bound` carries a made-up `slices/<key>.md` path that nothing backs.
      docPath: !doc.found && doc.reason === "no-doc-bound" ? null : doc.path,
    });
  });

  const storylines = model.storylines ?? [];
  const withStoryline = storylines.length > 0;
  const full = opts.full === true;
  // `--full` keeps the pre-2026-11 table: every lifecycle column, plus (GH #277) a Storyline
  // column right after Slice when the model declares storylines.
  const header = !full
    ? READER_HEADER
    : withStoryline
      ? TABLE_HEADER.split("\n").map((l, n) => (n === 0 ? l.replace("| Slice |", "| Slice | Storyline |") : l.replace("|-------|", "|-------|-----------|"))).join("\n")
      : TABLE_HEADER;
  const line = (r: SliceIndexRow, n: number): string => {
    const doc = r.docPath ? `[${r.docPath}](${r.docPath})` : "—";
    if (!full) return `| ${n} | ${escapeCell(r.name)} | ${escapeCell(r.pattern)} | ${escapeCell(r.status)} | ${doc} |`;
    return (
      `| ${n} | ${escapeCell(r.name)} | ${withStoryline ? `${escapeCell(r.storyline)} | ` : ""}${escapeCell(r.pattern)} | ${escapeCell(r.status)} | ` +
      `${escapeCell(r.reviewedBy)} | ${escapeCell(r.ratifiedBy)} | ${escapeCell(r.owner)} | ` +
      `${escapeCell(r.tracking)} | ${escapeCell(r.implementedIn)} | ${escapeCell(r.conformed)} | ${doc} |`
    );
  };

  let markdown: string;
  let storylinesMarkdown = "";
  if (!withStoryline) {
    markdown = [header, ...rows.map((r) => line(r, r.index))].join("\n");
  } else {
    // One section per storyline (document order), its slices on the composed timeline and
    // numbered within the story — the same "Step N of M" the doc's story line states — then
    // any slice outside every storyline. The storyline's own diagram is `em render --map`'s
    // (or `--storyline`'s) default output.
    const byIndex = new Map(rows.map((r) => [r.sliceIndex, r]));
    const sections: string[] = [];
    const placed = new Set<number>();
    const storyRows: string[] = [];
    for (const st of storylines) {
      const members = [...st.sliceIndexes].sort((a, b) => composedRank(model, a) - composedRank(model, b)).map((i) => byIndex.get(i)).filter((r): r is SliceIndexRow => r !== undefined);
      for (const r of members) placed.add(r.sliceIndex);
      const svg = `storylines/${kebabSlug(st.name)}.svg`;
      sections.push(`### ${st.name}`, `_${members.length} slice${members.length === 1 ? "" : "s"} · [diagram](${svg})_`, "", header, ...members.map((r, n) => line(r, n + 1)), "");
      const implemented = members.filter((r) => r.status === "implemented").length;
      storyRows.push(`| ${escapeCell(st.name)} | ${members.length} | ${implemented} | [${svg}](${svg}) |`);
    }
    const outside = rows.filter((r) => !placed.has(r.sliceIndex));
    if (outside.length > 0) sections.push("### Outside any storyline", "", header, ...outside.map((r, n) => line(r, n + 1)), "");
    markdown = sections.join("\n").trimEnd();
    storylinesMarkdown = [STORYLINE_HEADER, ...storyRows, "", "Canvas: [storylines/map.html](storylines/map.html) (`em render --map`)"].join("\n");
  }

  return { markdown, storylinesMarkdown, rows, diagnostics };
}

export type SliceIndexResult =
  | {
      ok: true;
      readmePath: string;
      wrote: boolean;
      changed: boolean;
      table: SliceIndexTable;
      /** `GENERATED:storylines` outcome: `absent` (the README has no such markers — add the
       *  section from templates/model-readme.md), `written`, `current`, or `n/a` (no storylines). */
      storylines: "absent" | "written" | "current" | "n/a";
    }
  | { ok: false; kind: "missing-readme" | "missing-markers" | "stale"; message: string; table: SliceIndexTable };

/**
 * Rewrite (or, in `check` mode, verify) the GENERATED:slices block in `<dirname(emFilePath)>/
 * README.md`. Never creates the README or the marker pair — both are user errors reported back
 * via `ok: false`, not silently fixed: a missing README means the model wasn't scaffolded from
 * templates/model-readme.md yet, and missing markers mean an older/hand-edited README that
 * needs the marker pair added first (see the message text for exactly what to do).
 *
 * `check: true` never writes to disk; a stale table is reported as `kind: "stale"` instead
 * (CI-ready — the caller exits non-zero without having touched the working tree).
 */
export function runSliceIndex(
  model: NormalizedModel,
  refs: RefsResult,
  emFilePath: string,
  check: boolean,
  opts: SliceIndexOptions = {},
): SliceIndexResult {
  const baseDir = dirname(emFilePath);
  const readmePath = join(baseDir, "README.md");
  const table = buildSliceIndexTable(model, refs, baseDir, opts);

  if (!existsSync(readmePath)) {
    return {
      ok: false,
      kind: "missing-readme",
      message:
        `em slice index: expected a README.md next to ${emFilePath} (looked for ${readmePath}) — ` +
        "none found. Scaffold one from templates/model-readme.md first.",
      table,
    };
  }

  const original = readFileSync(readmePath, "utf8");
  const updated = applyMarker(original, SLICE_INDEX_MARKER, table.markdown);
  if (updated === null) {
    return {
      ok: false,
      kind: "missing-markers",
      message:
        `em slice index: ${readmePath} has no <!-- GENERATED:${SLICE_INDEX_MARKER}:start --> / ` +
        `<!-- GENERATED:${SLICE_INDEX_MARKER}:end --> markers around its Slices table — add them ` +
        "(copy the ## Slices section from .claude/skills/event-modeling/templates/model-readme.md) " +
        "before running this command.",
      table,
    };
  }

  // The storyline table is optional: a README scaffolded before 2026-11 has no
  // GENERATED:storylines markers, and that is a hint, never an error.
  let storylines: "absent" | "written" | "current" | "n/a" = "n/a";
  let next = updated;
  if (table.storylinesMarkdown !== "") {
    const withStorylines = applyMarker(updated, STORYLINE_INDEX_MARKER, table.storylinesMarkdown);
    if (withStorylines === null) storylines = "absent";
    else {
      storylines = withStorylines === updated ? "current" : "written";
      next = withStorylines;
    }
  }

  const changed = next !== original;
  if (!changed) return { ok: true, readmePath, wrote: false, changed: false, table, storylines };

  if (check) {
    return {
      ok: false,
      kind: "stale",
      message:
        `em slice index --check: ${readmePath}'s Slices table is stale — run ` +
        `\`em slice index ${emFilePath}\` and commit the result.`,
      table,
    };
  }

  writeFileSync(readmePath, next, "utf8");
  return { ok: true, readmePath, wrote: true, changed: true, table, storylines };
}
