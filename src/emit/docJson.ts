// SPDX-License-Identifier: MIT
// GH #401: the structured slice-doc export — `em export --doc-json`. A SEPARATE surface from the
// model snapshot (`em export`, src/emit/json.ts): it serialises the slice DOCS' structure as data
// so a renderer (em-portal, the #396 doc-site layer, `em catalog`) never re-reads and re-parses
// `slices/*.md` itself. Per slice: the frontmatter join (the same doc-join object the model
// export's `slice.doc` carries — status, version, driftSignal, ratification/shipped/conformed
// keys, …) plus the parsed sections as data — the generated field tables, the model-declared
// invariants, the authored Given/When/Then scenarios, the Error Flows list and the Open Questions
// with their deferral state. Model-level: the invariant catalog (id -> owning slice -> the slices
// that reference it elsewhere).
//
// Own schema version, DOC_EXPORT_SCHEMA_VERSION — NOT the model export's SCHEMA_VERSION: the
// doc-structure shape evolves on its own cadence, and plain `em export` stays byte-identical.
//
// Every parse is REUSED, never re-derived ad hoc: the field rows come from `buildSliceRegions`
// (the same generated regions `em slice sync` writes) read back with `splitCells`; invariants
// from the model's own `invariant` lines; scenarios from the doc-join's `parseScenarios`; error
// flows / open questions from sliceDoc.ts's section parsers; INV mentions from coverage.ts's
// `INV_TOKEN_RE`. The whole thing is layered on `buildExportDoc` so the doc join (and its
// continuation/cross-binding resolution) is computed exactly once, the same way the model export
// computes it.

import { dirname } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { Diagnostic, serializeDiagnostic } from "../model/validate.js";
import { buildExportDoc } from "./json.js";
import { SliceDocExport } from "../catalog/docJoin.js";
import { Scenario } from "../catalog/scenarios.js";
import { errorFlows, openQuestions, OpenQuestionExport } from "../catalog/sliceDoc.js";
import { readSliceDoc } from "../catalog/readSliceDoc.js";
import { buildSliceRegions, splitCells } from "../catalog/sliceSections.js";
import { INV_TOKEN_RE } from "../cli/coverage.js";

// 1.0 (GH #401): the first structured slice-doc export. Separate constant from the model export's
// SCHEMA_VERSION on purpose — a change to the model snapshot does not bump this, and a change to
// the doc-structure shape does not bump that.
export const DOC_EXPORT_SCHEMA_VERSION = "1.0";

/** One field-table row as data — `name`/`type` are the first two columns of the generated table,
 *  `notes` is the remaining column(s) (Required+Rules for a command, Source/Notes for an event or
 *  view), joined with " · ", verbatim as `em slice sync` wrote them. */
export interface DocFieldRow {
  name: string;
  type: string;
  notes: string;
}

/** The generated field table for one element of a slice (`buildSliceRegions` region), as data. */
export interface DocFieldGroup {
  /** The element's display name (from the region's `**Command:**`/`**Event:**`/`- **View:**`
   *  marker line). */
  element: string;
  kind: "command" | "event" | "view";
  fields: DocFieldRow[];
}

/** One model-declared invariant of a slice: its stable ID and rule text (`text` null when the
 *  `invariant` line declares no quoted rule), deduped by ID in declaration order. */
export interface DocInvariant {
  id: string;
  text: string | null;
}

/** One slice's structured doc, in `model.slices[]`. */
export interface DocJsonSlice {
  key: string;
  name: string;
  /** Model-derived pattern (`classifySlicePattern`, same value the model export's `slice.pattern`
   *  carries) — NOT the frontmatter's authored `pattern:`. */
  pattern: string;
  /** The frontmatter join — byte-identical to the model export's `slice.doc` (SliceDocExport):
   *  `found`/`reason`, status, version, driftSignal, the review/ratification/shipped/conformed
   *  keys, scenarios, queuedForNext, … See catalog/docJoin.ts. */
  frontmatter: SliceDocExport;
  fields: DocFieldGroup[];
  invariants: DocInvariant[];
  /** The authored Given/When/Then scenarios (parseScenarios) — same array `frontmatter.scenarios`
   *  carries, surfaced here as a first-class section; `[]` when the doc has none. */
  scenarios: Scenario[];
  errorFlows: string[];
  openQuestions: OpenQuestionExport[];
  /** The doc body rendered to HTML (the existing `marked` path) — present only with
   *  `--include-html`; `null` when no usable doc is bound. */
  html?: string | null;
}

/** One entry of the model-level invariant catalog: a declared INV id, the slice whose model
 *  element declares it, and every OTHER slice whose doc body mentions the id. */
export interface DocInvariantCatalogEntry {
  id: string;
  owningSlice: string;
  referencingSlices: string[];
}

export interface DocJsonExportDoc {
  schemaVersion: string;
  generator: { name: string; version: string };
  source: { path: string; sha256: string };
  model: {
    name: string | null;
    key: string;
    invariants: DocInvariantCatalogEntry[];
    slices: DocJsonSlice[];
  };
  diagnostics: ReturnType<typeof serializeDiagnostic>[];
}

export interface DocJsonExportResult {
  /** Pretty-printed JSON, no trailing newline. */
  text: string;
  /** Same diagnostics the model export raises (compile + doc-join + note-binding). */
  diagnostics: Diagnostic[];
}

/** The slice key a doc-join path (`slices/<key>.md` — the actual path the content came from,
 *  which for a cross-bound or continuation slice is another slice's) resolves to. */
function keyFromDocPath(path: string, fallback: string): string {
  const m = /slices\/(.+)\.md$/i.exec(path);
  return m ? m[1] : fallback;
}

/** The element display name from a generated region's lead marker line, or null for a "none"/
 *  placeholder body with no element. An alternatives region (`**Records one of:**`) resolves to
 *  its first alternative's name. */
function leadElementName(body: string[]): string | null {
  for (const line of body) {
    const ce = /^\*\*(?:Command|Event):\*\*\s+`([^`]+)`/.exec(line);
    if (ce) return ce[1];
    const v = /^- \*\*View:\*\*\s+`([^`]+)`/.exec(line);
    if (v) return v[1];
  }
  return null;
}

/** Every data row of every markdown table in a generated region body, read back with the same
 *  `splitCells` the region writers and `structured-section-malformed` use. `name`/`type` are
 *  columns 0/1; `notes` is the rest joined with " · ". A region with no table (an element with no
 *  fields — the `_No fields…_` body) yields none. */
function parseFieldRows(body: string[]): DocFieldRow[] {
  const rows: DocFieldRow[] = [];
  let i = 0;
  while (i < body.length - 1) {
    const isHeader =
      /^\s*\|/.test(body[i]) &&
      /^\s*\|/.test(body[i + 1]) &&
      splitCells(body[i + 1]).every((c) => /^:?-+:?$/.test(c));
    if (!isHeader) {
      i++;
      continue;
    }
    let j = i + 2;
    for (; j < body.length && /^\s*\|/.test(body[j]); j++) {
      const cells = splitCells(body[j]);
      rows.push({ name: cells[0] ?? "", type: cells[1] ?? "", notes: cells.slice(2).join(" · ") });
    }
    i = j;
  }
  return rows;
}

/** The generated field tables of one slice, grouped by element, reusing `buildSliceRegions`. */
function fieldGroups(model: NormalizedModel, sliceIndex: number): DocFieldGroup[] {
  const groups: DocFieldGroup[] = [];
  for (const region of buildSliceRegions(model, [sliceIndex])) {
    if (region.kind === "invariants") continue;
    const element = leadElementName(region.body);
    if (element === null) continue; // "none" body — this slice has no element of that kind
    groups.push({ element, kind: region.kind, fields: parseFieldRows(region.body) });
  }
  return groups;
}

/** The model-declared invariants of one slice (`invariant` lines on its command/event elements),
 *  deduped by ID in declaration order — the same lines `buildSliceRegions`' invariants region
 *  restates. */
function sliceInvariants(slice: NormalizedModel["slices"][number]): DocInvariant[] {
  const out: DocInvariant[] = [];
  const seen = new Set<string>();
  for (const el of slice.elements) {
    if (el.kind !== "command" && el.kind !== "event") continue;
    for (const inv of el.invariants ?? []) {
      if (seen.has(inv.id)) continue;
      seen.add(inv.id);
      out.push({ id: inv.id, text: inv.rule ?? null });
    }
  }
  return out;
}

/** Does `body` mention the exact INV id as a whole token (coverage.ts's `INV_TOKEN_RE`)? */
function mentionsInvariant(body: string, id: string): boolean {
  for (const m of body.matchAll(INV_TOKEN_RE)) if (m[0] === id) return true;
  return false;
}

/**
 * Build the `em export --doc-json` document for an already-validated (error-free) model. Layered
 * on `buildExportDoc` so the doc join is resolved exactly once; `includeHtml` opts each slice's
 * rendered HTML body in (excluded by default). See the module comment for the reuse contract.
 */
export function buildDocJsonExport(
  model: NormalizedModel,
  refs: RefsResult,
  diagnostics: Diagnostic[],
  source: string,
  path: string,
  opts: { includeHtml?: boolean } = {},
): DocJsonExportResult {
  const { doc: fullDoc, diagnostics: allDiagnostics } = buildExportDoc(model, refs, diagnostics, source, path);
  const baseDir = dirname(path);

  // Read each slice's bound doc once: its body feeds error flows / open questions / HTML here and
  // the invariant catalog's reference scan below.
  const built = fullDoc.model.slices.map((s, sliceIndex) => {
    const frontmatter = s.doc as SliceDocExport;
    const docKey = keyFromDocPath(frontmatter.path, s.key);
    const parsed = readSliceDoc(baseDir, docKey);
    const body = parsed?.body ?? "";
    const invariants = sliceInvariants(model.slices[sliceIndex]);
    const slice: DocJsonSlice = {
      key: s.key,
      name: s.name,
      pattern: s.pattern,
      frontmatter,
      fields: fieldGroups(model, sliceIndex),
      invariants,
      scenarios: frontmatter.scenarios ?? [],
      errorFlows: errorFlows(body),
      openQuestions: openQuestions(body),
    };
    if (opts.includeHtml) slice.html = parsed?.html ?? null;
    return { slice, body, invariantIds: invariants.map((i) => i.id) };
  });

  // Model-level invariant catalog: first slice to declare an id OWNS it (declaration order);
  // every other slice whose doc body mentions the id REFERENCES it.
  const owningSlice = new Map<string, string>();
  const idOrder: string[] = [];
  for (const b of built) {
    for (const id of b.invariantIds) {
      if (owningSlice.has(id)) continue;
      owningSlice.set(id, b.slice.key);
      idOrder.push(id);
    }
  }
  const invariants: DocInvariantCatalogEntry[] = idOrder.map((id) => {
    const owner = owningSlice.get(id)!;
    const referencingSlices = built
      .filter((b) => b.slice.key !== owner && mentionsInvariant(b.body, id))
      .map((b) => b.slice.key);
    return { id, owningSlice: owner, referencingSlices };
  });

  const docJson: DocJsonExportDoc = {
    schemaVersion: DOC_EXPORT_SCHEMA_VERSION,
    generator: fullDoc.generator,
    source: fullDoc.source,
    model: {
      name: fullDoc.model.name,
      key: fullDoc.model.key,
      invariants,
      slices: built.map((b) => b.slice),
    },
    diagnostics: fullDoc.diagnostics,
  };

  return { text: JSON.stringify(docJson, null, 2), diagnostics: allDiagnostics };
}
