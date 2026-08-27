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
import { collectTags, Element, NormalizedModel, TypeDecl, resolveByName, resolveTypeRef } from "../model/model.js";
import { Field } from "../parser/ast.js";
import { Diagnostic, serializeDiagnostic } from "../model/validate.js";
import { RefsResult } from "../model/refs.js";
import { classifySlicePattern } from "../catalog/classify.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";
import { validateNoteBindings } from "../catalog/noteBindingValidate.js";

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
// 1.5 (MIL-85): `slice.doc` gains `driftSignal` — the status/implementedIn coherence
// classification (catalog/driftSignal.ts), computed from the same doc parse as `doc.status`/
// `doc.version`/`doc.implementedIn`. Additive-only.
// 1.6 (MIL-66): field `tag: boolean` (identity tag marker, always present, `=== true`
// convention like `public`), and element `tags: [{ key, kind, fields, description }] | null`
// (identity/composite/external DCB tag metadata — events only; `null` when the element has
// none). See `model/model.ts`'s `collectTags`. Additive-only.
// Also 1.6 (MIL-68, same unreleased cycle as MIL-66 — no separate bump): field
// `renamedFrom: string[] | null` (the prior name(s) a field was known as, most-recent-first;
// `null` — not the `tag`-style boolean-default convention — when the field carries no
// `renamed from` clause, which includes every field of a declared `type`, since the clause
// can't parse there), and element `renamedFrom: string[] | null` (same shape, on the
// element's own name; events and commands only — `null` on every other kind and on an
// event/command that declares none). Both are purely codegen/export metadata: `em diff`
// does not read either and keeps reporting a rename as remove+add. Additive-only.
// 1.7 (MIL-148): field `assigned: boolean` (system-assigned marker, always present, `=== true`
// convention like `tag`) — event fields only; a trailing `assigned` clause records that the
// server/handler sets the field rather than the triggering command supplying it, and exempts
// it from `fields-completeness/event-field-no-source`. See `model/validate.ts`. Additive-only.
export const SCHEMA_VERSION = "1.7";

export interface ExportResult {
  /** Pretty-printed JSON, no trailing newline. */
  text: string;
  /** validate()'s diagnostics, refs' ref-collision warnings, the doc-join's
   *  binding-missing-file/frontmatter-invalid warnings, and (MIL-126) any note-binding-mismatch
   *  warnings, raised while exporting. */
  diagnostics: Diagnostic[];
}

/** The `em export` document's shape, pre-stringify — what `buildExportDoc` returns and
 *  `buildExport` serializes. Exported so `buildSliceExport` (MIL-128) can pick one slice's
 *  object back out without re-parsing JSON text or re-deriving the doc join. */
export interface ExportDoc {
  schemaVersion: string;
  generator: { name: string; version: string };
  source: { path: string; sha256: string };
  model: {
    name: string | null;
    personas: string[];
    contexts: string[];
    hasAutomation: boolean;
    types: unknown[];
    slices: Array<{ key: string; [k: string]: unknown }>;
    arrows: unknown[];
  };
  diagnostics: ReturnType<typeof serializeDiagnostic>[];
}

export interface SliceExportResult {
  /** Pretty-printed JSON, no trailing newline — `null` when `sliceKey` names no slice
   *  (`found` is `false`). */
  text: string | null;
  /** Whether `sliceKey` matched a slice in the model. */
  found: boolean;
  /** Same diagnostics `buildExport` would have raised for the whole model — the caller
   *  decides how to gate/print these; `buildSliceExport` never refuses on them itself
   *  (see cli.ts's `--slice` handling for the scoping decision, MIL-128). */
  diagnostics: Diagnostic[];
}

export interface FieldExport {
  name: string;
  type: string | null;
  typeRef: { name: string; ref: string; array: boolean } | null;
  /** `true` when the field carries a trailing `tag` clause (identity tag) — same `=== true`
   *  convention as `public`. Always present; `false` on every field that isn't one, including
   *  every field of a declared type (MIL-66). */
  tag: boolean;
  /** The prior name(s) this field was known as, most-recent-first, from a trailing
   *  `renamed from "Old1", "Old2"` clause (event/command fields only, MIL-68) — `typeRef`-style
   *  nullable, not the `tag` boolean-default convention. `null` when the field carries no such
   *  clause, which includes every field of a declared `type` (the clause can't parse there). */
  renamedFrom: string[] | null;
  /** `true` when the field carries a trailing `assigned` clause (system-assigned — the
   *  server/handler sets it, not the triggering command; event fields only, MIL-148) — same
   *  `=== true` convention as `tag`. Always present; `false` on every field that isn't one,
   *  including every field of a declared type. */
  assigned: boolean;
}

export interface TagExport {
  key: string;
  kind: "identity" | "composite" | "external";
  fields: string[] | null;
  description: string | null;
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
    tag: f.tag === true,
    renamedFrom: f.renamedFrom ?? null,
    assigned: f.assigned === true,
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
  const { doc, diagnostics: allDiagnostics } = buildExportDoc(model, refs, diagnostics, source, path);
  return { text: JSON.stringify(doc, null, 2), diagnostics: allDiagnostics };
}

/** Build one slice's `em export` object, scoped (MIL-128): same `pattern`/`fields`/`doc` shape
 *  as that slice's entry in the full `em export` document (`ExportDoc.model.slices[i]`), plus
 *  the envelope fields (`schemaVersion`, `generator`, `source`) every em JSON surface carries.
 *  Reuses `buildExportDoc` wholesale rather than re-deriving the doc join for one slice — the
 *  cost of computing every slice's join even though only one is returned is the same tradeoff
 *  `validateSliceReady` already accepts for a single-slice check, and keeps this function from
 *  drifting from the full export's own slice shape. `diagnostics` in the result is the same
 *  scan `buildExport` would have raised for the whole model (unfiltered) — deciding whether an
 *  error elsewhere in the model should block a *scoped* export is the caller's call (cli.ts
 *  scopes the refusal to diagnostics that concern this slice, so an unrelated slice's breakage
 *  never closes the structured path for one that's fine — the whole point of MIL-128). Returns
 *  `found: false` (and a `null` `text`) when `sliceKey` matches no slice — the caller reports
 *  that as a CLI error. */
export function buildSliceExport(
  model: NormalizedModel,
  refs: RefsResult,
  diagnostics: Diagnostic[],
  source: string,
  path: string,
  sliceKey: string,
): SliceExportResult {
  const { doc, diagnostics: allDiagnostics } = buildExportDoc(model, refs, diagnostics, source, path);
  const slice = doc.model.slices.find((s) => s.key === sliceKey);
  if (!slice) return { text: null, found: false, diagnostics: allDiagnostics };

  const sliceDoc = {
    schemaVersion: doc.schemaVersion,
    generator: doc.generator,
    source: doc.source,
    sliceKey,
    slice,
    // Same scoping predicate as `em validate --slice-ready`'s own filter (cli.ts): a bare
    // sliceKey ref (slice-level facts) or an element ref prefixed `<sliceKey>/` — never a
    // second identifier scheme, always the refs the `slice` object above already uses.
    diagnostics: doc.diagnostics.filter(
      (d) => d.refs?.some((r) => r === sliceKey || r.startsWith(`${sliceKey}/`)),
    ),
  };
  return { text: JSON.stringify(sliceDoc, null, 2), found: true, diagnostics: allDiagnostics };
}

/** The shared body of `buildExport`/`buildSliceExport`: builds the full export document as a
 *  JS object (pre-stringify) so a scoped export can pick one slice back out without
 *  re-parsing JSON text or re-deriving the doc join. See `buildExport`'s own docstring for the
 *  parameter contract — unchanged here, just split out. */
function buildExportDoc(
  model: NormalizedModel,
  refs: RefsResult,
  diagnostics: Diagnostic[],
  source: string,
  path: string,
): { doc: ExportDoc; diagnostics: Diagnostic[] } {
  const { sliceKeys, refById, refByTypeId } = refs;
  const baseDir = dirname(path);
  const docDiagnostics: Diagnostic[] = [];

  const refOf = (id: string | undefined): string | null =>
    id ? refById.get(id) ?? null : null;

  const fromOf = (el: Element): { name: string; ref: string | null }[] | null => {
    if (!el.from || el.from.length === 0) return null;
    return el.from.map((name) => ({ name, ref: refOf(resolveByName(model.byName, name)) }));
  };

  // Identity/composite/external DCB tag metadata (MIL-66) — events only in practice (`tag`
  // clauses are a parse error on any other kind), `null` when the event carries none. Order:
  // inline field identity tags in field order, then element-level composite/external clauses
  // in declaration order (see `model/model.ts`'s `collectTags`).
  const tagsOf = (el: Element): TagExport[] | null => {
    const tags = collectTags(el);
    return tags.length > 0 ? tags : null;
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
        tags: tagsOf(el),
        renamedFrom: el.renamedFrom ?? null,
        logicalRef:
          el.kind === "view" && el.again === true ? refOf(el.logicalId) : null,
      })),
    };
  });

  // MIL-126: a note that looks like a doc binding but doesn't actually participate in one
  // (already-bound slice, dangling/unusable/unratified cross-note) — computed once per model,
  // not once per slice like the per-slice docDiagnostics loop above, since it needs to see every
  // element on a slice at once to tell "extra" from "dangling" from "unratified".
  const noteBindingDiagnostics = validateNoteBindings(model, refs, baseDir);

  const allDiagnostics = [...diagnostics, ...docDiagnostics, ...noteBindingDiagnostics];

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

  return { doc: exportDoc, diagnostics: allDiagnostics };
}
