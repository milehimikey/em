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

/** The marker name wrapping the Slices table: `<!-- GENERATED:slices:start -->` /
 *  `<!-- GENERATED:slices:end -->`, matching templates/model-readme.md. */
export const SLICE_INDEX_MARKER = "slices";

const TABLE_HEADER =
  "| # | Slice | Pattern | Status | Ratified by | Owner | Tracking | Implemented in | Design doc |\n" +
  "|---|-------|---------|--------|-------------|-------|----------|----------------|------------|";

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
 *  broken binding still means "there's no doc a human can currently read." */
function statusCell(doc: SliceDocExport): string {
  if (!doc.found) return "no doc yet";
  return doc.status ?? "unknown";
}

export interface SliceIndexRow {
  index: number;
  name: string;
  pattern: string;
  status: string;
  ratifiedBy: string;
  owner: string;
  tracking: string;
  implementedIn: string;
  docPath: string;
}

export interface SliceIndexTable {
  /** The full replacement body for the GENERATED:slices block — header + one row per slice
   *  (or just the header when the model has no slices yet). */
  markdown: string;
  rows: SliceIndexRow[];
  /** binding-missing-file / frontmatter-invalid warnings from resolveSliceDocJoin — the same
   *  diagnostics `em export` surfaces for a broken doc binding. */
  diagnostics: Diagnostic[];
}

/** Build the Slices table body for `model`. `baseDir` is the `.em` file's directory — same
 *  doc-resolution convention `em export`/`em catalog` use for `slices/<key>.md`. */
export function buildSliceIndexTable(model: NormalizedModel, refs: RefsResult, baseDir: string): SliceIndexTable {
  const diagnostics: Diagnostic[] = [];

  const rows: SliceIndexRow[] = model.slices.map((slice, i) => {
    const sliceKey = refs.sliceKeys[i];
    const pattern = classifySlicePattern(slice);
    const { doc, diagnostics: docDiags } = resolveSliceDocJoin(
      slice,
      sliceKey,
      baseDir,
      (id) => refs.refById.get(id)!,
    );
    diagnostics.push(...docDiags);
    return {
      index: i + 1,
      name: slice.name,
      pattern: slicePatternLabel(pattern),
      status: statusCell(doc),
      ratifiedBy: doc.ratifiedBy ?? "—",
      owner: doc.owner ?? "—",
      tracking: doc.tracking ?? "—",
      implementedIn: doc.implementedIn ?? "—",
      docPath: doc.path,
    };
  });

  const lines = rows.map(
    (r) =>
      `| ${r.index} | ${escapeCell(r.name)} | ${escapeCell(r.pattern)} | ${escapeCell(r.status)} | ` +
      `${escapeCell(r.ratifiedBy)} | ${escapeCell(r.owner)} | ${escapeCell(r.tracking)} | ` +
      `${escapeCell(r.implementedIn)} | [${r.docPath}](${r.docPath}) |`,
  );

  return { markdown: [TABLE_HEADER, ...lines].join("\n"), rows, diagnostics };
}

export type SliceIndexResult =
  | { ok: true; readmePath: string; wrote: boolean; changed: boolean; table: SliceIndexTable }
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
): SliceIndexResult {
  const baseDir = dirname(emFilePath);
  const readmePath = join(baseDir, "README.md");
  const table = buildSliceIndexTable(model, refs, baseDir);

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

  const changed = updated !== original;
  if (!changed) return { ok: true, readmePath, wrote: false, changed: false, table };

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

  writeFileSync(readmePath, updated, "utf8");
  return { ok: true, readmePath, wrote: true, changed: true, table };
}
