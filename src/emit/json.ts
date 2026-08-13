// SPDX-License-Identifier: MIT
// Builds the `em export` JSON document: a versioned, deterministic snapshot of
// the normalized model with stable public refs (see design/export-schema.md
// under internal/engagements/tier1-intent-capture/ for the approved shape).
//
// Internal `Element.id` is document-order-deduped `slug(name)` — edit-unstable,
// and never exposed here. Export refs are computed separately, keyed off
// `<sliceKey>/<kind>.<slug(name)>`, so inserting or reordering slices never
// changes an existing element's public identity.

import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Element, NormalizedModel, TypeDecl, resolveByName, resolveTypeRef } from "../model/model.js";
import { Field } from "../parser/ast.js";
import { Diagnostic, serializeDiagnostic } from "../model/validate.js";
import { RefsResult } from "../model/refs.js";
import { classifySlicePattern } from "../catalog/classify.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";

// Read once from package.json (two levels up from src/emit/ and dist/emit/
// alike) so `generator.version` can never drift from the released version.
// tsconfig targets NodeNext without resolveJsonModule, hence fs over import.
export const GENERATOR_NAME = "@milehimikey/em";
export const GENERATOR_VERSION: string = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"),
).version;

// 1.4 (MIL-91): each slice gains `pattern` (model-derived, classifySlicePattern — same
// function `em catalog` already uses) and `doc` (the slice-doc frontmatter join, always a
// non-null object; see catalog/docJoin.ts). Diagnostics gain `code`/`refs`. Additive-only per
// the versioning policy below — a minor bump.
export const SCHEMA_VERSION = "1.4";

export interface ExportResult {
  /** Pretty-printed JSON, no trailing newline. */
  text: string;
  /** validate()'s diagnostics, refs' ref-collision warnings, and the doc-join's
   *  binding-missing-file/frontmatter-invalid warnings raised while exporting. */
  diagnostics: Diagnostic[];
}

export interface FieldExport {
  name: string;
  type: string | null;
  typeRef: { name: string; ref: string; array: boolean } | null;
}

/**
 * Export a single field, additively: `name`/`type` are exactly what today's consumers already
 * see. `typeRef` is the new, purely-additive key — non-null only when `type` (bare or `[]`-
 * suffixed) names a declared `type`, else `null`, same as every field in a model that declares
 * no `type` blocks at all. Shared by both a declared type's own fields (`model.types[].fields`)
 * and ordinary element fields (`model.slices[].elements[].fields`) so both get identical
 * resolution.
 */
function fieldExport(
  f: Field,
  typesByName: Map<string, TypeDecl>,
  refByTypeId: Map<string, string>,
): FieldExport {
  const resolved = resolveTypeRef(f.type, typesByName);
  return {
    name: f.name,
    type: f.type ?? null,
    typeRef: resolved
      ? { name: resolved.typeDecl.name, ref: refByTypeId.get(resolved.typeDecl.id)!, array: resolved.array }
      : null,
  };
}

/** Build the `em export` document for an already-validated (error-free) model. `refs` is
 *  `compile()`'s already-computed `RefsResult` (MIL-91) — never recomputed here, so its
 *  ref-collision diagnostics (already folded into `diagnostics` by `compile()`) aren't
 *  emitted a second time. `path` is the `.em` file's own path — the doc join resolves
 *  `slices/*.md` relative to its directory, same convention `em catalog`'s doc lookup uses. */
export function buildExport(
  model: NormalizedModel,
  refs: RefsResult,
  diagnostics: Diagnostic[],
  source: string,
  path: string,
): ExportResult {
  const { sliceKeys, refById, refByTypeId } = refs;
  const baseDir = dirname(path);
  const docDiagnostics: Diagnostic[] = [];

  const refOf = (id: string | undefined): string | null =>
    id ? refById.get(id) ?? null : null;

  const fromOf = (el: Element): { name: string; ref: string | null }[] | null => {
    if (!el.from || el.from.length === 0) return null;
    return el.from.map((name) => ({ name, ref: refOf(resolveByName(model.byName, name)) }));
  };

  // Built ahead of exportDoc (rather than inline) so docDiagnostics is fully populated before
  // allDiagnostics is computed once, below — no repeating the [...diagnostics, ...docDiagnostics]
  // concatenation for both the JSON diagnostics field and the returned ExportResult.
  const slices = model.slices.map((slice, sliceIndex) => {
    const sliceKey = sliceKeys[sliceIndex];
    const { doc, diagnostics: sliceDocDiags } = resolveSliceDocJoin(
      slice,
      sliceKey,
      baseDir,
      (id) => refById.get(id)!,
    );
    docDiagnostics.push(...sliceDocDiags);
    return {
      key: sliceKey,
      name: slice.name,
      index: slice.index,
      // Link to the ticket/conversation this slice traces back to (MIL-69).
      // Distinct from the document's top-level `source` (the .em file's own
      // path/sha256 provenance) — same key name, different scope.
      source: slice.source ?? null,
      line: slice.line,
      // Model-derived (MIL-91) — same classifySlicePattern() `em catalog` already uses.
      // The frontmatter's own authored `pattern:` stays unread (informational only, per
      // docs/slice-doc-schema.md) — this is not that value.
      pattern: classifySlicePattern(slice),
      // The slice-doc frontmatter join (MIL-91) — see catalog/docJoin.ts for the
      // found/reason state machine. Never the markdown body: doc.html/doc.raw never
      // appear here (the hard boundary the ticket requires).
      doc,
      elements: slice.elements.map((el) => ({
        ref: refById.get(el.id)!,
        kind: el.kind,
        name: el.name,
        line: el.line,
        fields: el.fields
          ? el.fields.map((f) => fieldExport(f, model.typesByName, refByTypeId))
          : null,
        note: el.note ?? null,
        issue: el.issue ?? null,
        divergence: el.divergence ?? null,
        from: fromOf(el),
        persona: el.persona ?? null,
        context: el.context ?? null,
        again: el.again === true,
        public: el.public === true,
        logicalRef:
          el.kind === "view" && el.again === true ? refOf(el.logicalId) : null,
      })),
    };
  });

  const allDiagnostics = [...diagnostics, ...docDiagnostics];

  const exportDoc = {
    schemaVersion: SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    source: { path, sha256: createHash("sha256").update(source, "utf8").digest("hex") },
    model: {
      name: model.name,
      personas: model.personas,
      contexts: model.contexts,
      hasAutomation: model.hasAutomation,
      // Declared named types (MIL-64) — independent of the slice timeline, so listed
      // once here rather than nested inside any slice.
      types: model.types.map((t) => ({
        ref: refByTypeId.get(t.id)!,
        name: t.name,
        line: t.line,
        fields: t.fields.map((f) => fieldExport(f, model.typesByName, refByTypeId)),
      })),
      slices,
      arrows: model.arrows.map((a) => ({
        from: a.from,
        to: a.to,
        fromRef: refOf(a.fromId),
        toRef: refOf(a.toId),
        line: a.line,
      })),
    },
    diagnostics: allDiagnostics.map(serializeDiagnostic),
  };

  return { text: JSON.stringify(exportDoc, null, 2), diagnostics: allDiagnostics };
}
