// SPDX-License-Identifier: MIT
// POC (MIL-159): generates a TypeSpec (https://typespec.io) contract surface — plain `model`/
// `interface`/`op` declarations, core scalars only, no imports — for a model's commands,
// public events, and public views. EXPERIMENTAL: see docs/cli.md's `em typespec` section for
// the scoping/type-mapping decisions this POC makes and what it deliberately leaves out.
//
// Reuses `buildExportDoc` (emit/json.ts) rather than re-deriving typeRef/tags/renamedFrom/
// assigned/public from the raw model a second time — same discipline `em export` itself
// follows: one resolution pass, one place field metadata is computed, every consumer reads
// the resolved shape. Deterministic and dependency-free: no LLM, no new runtime dependency —
// this emits TypeSpec *source text* directly rather than building an AST through
// `@typespec/compiler` (see test/typespec.test.ts for the optional, skip-if-absent
// compile-verification test that checks the text this module emits is actually valid
// TypeSpec, using `@typespec/compiler` as a devDependency only).

import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { Diagnostic } from "../model/validate.js";
import { dedupe } from "../util/slug.js";
import { buildExportDoc, ElementExport, FieldExport } from "./json.js";

// 1.0 (MIL-159, POC): initial shape. Not part of the `em export` schema-versioning lineage —
// this is source text, not JSON, and the POC's own mapping/scoping decisions (see below) are
// expected to change if/when this graduates past POC, so it gets its own independent version.
export const TYPESPEC_SCHEMA_VERSION = "1.0";

export interface TypeSpecResult {
  /** TypeSpec source text, no trailing newline. */
  text: string;
  /** Same diagnostics `buildExport` would raise for this model (doc-join warnings, ref
   *  collisions, etc.) — the caller decides how to print/gate these, same posture as
   *  `buildExport`'s own `diagnostics` field. */
  diagnostics: Diagnostic[];
  /** Human-readable notes about fields whose em type string had no scalar mapping and fell
   *  back to `unknown` — informational only, never blocking (POC's "best-effort inference with
   *  a warning" choice — see the type-mapping section below). Empty when every included
   *  field's type mapped cleanly, or declared no type at all (an untyped field isn't a mapping
   *  failure — see `mapFieldType`). */
  unmappedTypes: string[];
}

// ---- Type mapping strategy ---------------------------------------------------------------
//
// em field types are free text with no semantic checking (docs/dsl.md, "Fields"). TypeSpec
// needs real scalar/model references, so this POC picks one explicit, documented strategy
// (per the ticket's "needs an explicit mapping strategy" — not assumed) rather than passing
// text through unchanged:
//
//  1. A field whose type names a declared `type` block (`FieldExport.typeRef`, already
//     resolved by `buildExportDoc` — bare or `[]`-suffixed) references that type's generated
//     `model` by name. This is the clean, low-risk case the ticket calls out — em already does
//     all the resolution work.
//  2. Otherwise, the *bare* type name (after stripping a `[]` suffix or a `List<...>`/
//     `Array<...>`/`Set<...>` generic wrapper) is looked up case-insensitively in
//     SCALAR_TYPE_MAP below. A hit maps to that TypeSpec core scalar.
//  3. A field with no declared type at all (`type` was never written) maps to `unknown` —
//     not a mapping failure, just an honest "this field's shape isn't declared here."
//  4. Anything else — a declared type string that's neither a known scalar nor a resolvable
//     `type` reference (`Money`, a typo, a domain-specific string nobody's mapped) — also
//     becomes `unknown`, but is recorded in `TypeSpecResult.unmappedTypes` so the gap is
//     visible instead of silently swallowed. `List<X>` around an unresolved `X` (including a
//     declared type referenced through the generic-wrapper spelling rather than `X[]` — see
//     docs/dsl.md's Named types section on why only the bare/`[]` forms resolve) still maps to
//     `unknown[]`, not `unknown`, so the arity survives even when the element type doesn't.
//
// This table is intentionally small and unopinionated (nothing domain-specific like `Money` ->
// a currency shape) — go/no-go note: a promoted, non-POC version would likely want this
// user-configurable (a mapping file) rather than hardcoded.
export const SCALAR_TYPE_MAP: Readonly<Record<string, string>> = Object.freeze({
  string: "string",
  str: "string",
  text: "string",
  uuid: "string",
  guid: "string",
  int: "int32",
  integer: "int32",
  int32: "int32",
  int64: "int64",
  long: "int64",
  short: "int16",
  int16: "int16",
  byte: "int8",
  int8: "int8",
  uint: "uint32",
  boolean: "boolean",
  bool: "boolean",
  float: "float32",
  float32: "float32",
  double: "float64",
  float64: "float64",
  decimal: "decimal",
  money: "decimal",
  currency: "decimal",
  instant: "utcDateTime",
  datetime: "utcDateTime",
  timestamp: "utcDateTime",
  utcdatetime: "utcDateTime",
  date: "plainDate",
  time: "plainTime",
  duration: "duration",
  url: "url",
  uri: "url",
  bytes: "bytes",
  binary: "bytes",
  object: "unknown",
  any: "unknown",
  void: "void",
});

function mapRawType(raw: string): { tsType: string; mapped: boolean } {
  let s = raw.trim();
  let array = false;
  const generic = s.match(/^(?:List|Array|Set)<(.+)>$/i);
  if (generic) {
    array = true;
    s = generic[1].trim();
  } else if (s.endsWith("[]")) {
    array = true;
    s = s.slice(0, -2).trim();
  }
  const scalar = SCALAR_TYPE_MAP[s.toLowerCase()];
  if (scalar) return { tsType: array ? `${scalar}[]` : scalar, mapped: true };
  return { tsType: array ? "unknown[]" : "unknown", mapped: false };
}

// ---- Identifier shaping -----------------------------------------------------------------

/** em element/type names are free text ("Place Order", "Order Placed"). TypeSpec model/
 *  operation names need a bare identifier — PascalCase, matching TypeSpec's own convention
 *  for `model`/`interface` names. */
function pascalCase(name: string): string {
  const words = name.match(/[A-Za-z0-9]+/g) ?? [];
  const joined = words.map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  if (joined.length === 0) return "Unnamed";
  return /^[0-9]/.test(joined) ? `_${joined}` : joined;
}

function camelCase(pascal: string): string {
  return pascal.length > 0 ? pascal[0].toLowerCase() + pascal.slice(1) : pascal;
}

/** A field name that isn't a bare TypeSpec identifier (spaces, leading digit, ...) is quoted
 *  with backticks — the same escape TypeSpec itself uses for a non-identifier member name. em
 *  field names are conventionally already valid identifiers (see examples/*.em), so this is a
 *  defensive fallback, not the expected path. */
function fieldIdentifier(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name;
  return "`" + name.replace(/\\/g, "\\\\").replace(/`/g, "\\`") + "`";
}

// ---- Doc-comment metadata -----------------------------------------------------------------
//
// `tag` (DCB), `renamed from`, and `assigned` are modeling/event-store concerns, not wire-
// contract shape — decided (per the ticket's open question) to carry them forward as plain
// `/** ... */` doc comments, never as decorators. A custom `@tag`/`@assigned`/`@renamedFrom`
// decorator would need its own TypeSpec extension library (`extern dec` + a JS implementation)
// to be anything but cosmetic, which is out of scope for a dependency-free POC; a doc comment
// keeps the information visible in the generated contract without inventing new TypeSpec
// vocabulary this POC can't back with real semantics.

function fieldDocComment(f: FieldExport): string | null {
  const notes: string[] = [];
  if (f.tag) notes.push("DCB identity tag");
  if (f.renamedFrom && f.renamedFrom.length > 0) {
    notes.push(`renamed from ${f.renamedFrom.map((n) => JSON.stringify(n)).join(", ")}`);
  }
  if (f.assigned) notes.push("system-assigned — not supplied by the triggering command");
  return notes.length > 0 ? notes.join("; ") : null;
}

function elementDocComment(el: ElementExport): string | null {
  const notes: string[] = [];
  if (el.renamedFrom && el.renamedFrom.length > 0) {
    notes.push(`renamed from ${el.renamedFrom.map((n) => JSON.stringify(n)).join(", ")}`);
  }
  if (el.tags) {
    for (const t of el.tags) {
      if (t.kind === "composite") notes.push(`DCB composite tag \`${t.key}\` from ${(t.fields ?? []).join(", ")}`);
      else if (t.kind === "external") notes.push(`DCB external tag \`${t.key}\`: ${t.description}`);
      // identity tags are already surfaced per-field (fieldDocComment) — not repeated here.
    }
  }
  return notes.length > 0 ? notes.join("; ") : null;
}

function indent(lines: string[], depth: number): string[] {
  const pad = "  ".repeat(depth);
  return lines.map((l) => (l.length > 0 ? pad + l : l));
}

/**
 * Build the `em typespec <file>` document: TypeSpec source text for a model's contract
 * surface. Mirrors `buildExport`'s parameter contract exactly (same four inputs, same
 * "already-validated, error-free model" precondition — the caller, cli.ts, applies the same
 * refuse-on-error gate `em export` uses before calling this).
 */
export function buildTypeSpec(
  model: NormalizedModel,
  refs: RefsResult,
  diagnostics: Diagnostic[],
  source: string,
  path: string,
): TypeSpecResult {
  const { doc, diagnostics: allDiagnostics } = buildExportDoc(model, refs, diagnostics, source, path);
  const unmappedNotes: string[] = [];

  const recordUnmapped = (refLabel: string, field: string, rawType: string) => {
    unmappedNotes.push(`${refLabel} field "${field}": type "${rawType}" has no scalar mapping — emitted as \`unknown\``);
  };

  const typesByRef = new Map(doc.model.types.map((t) => [t.ref, t]));

  // ---- Scoping (per the ticket's own decision points) --------------------------------
  //
  // Events/views: exactly `public` (docs/dsl.md's Integration surface — the flag this
  // generator was built for). Commands have no `public` flag of their own (dsl.md), so this
  // POC's decision is: a command is included when its own slice declares at least one public
  // event or view — the request contract for a slice that's already promoted its outcome
  // (or its read model) to the integration surface belongs on the same contract. A slice with
  // no public event/view contributes nothing, including its commands.
  const slicePublic = new Map<string, boolean>();
  for (const slice of doc.model.slices) {
    slicePublic.set(
      slice.key,
      slice.elements.some((el) => (el.kind === "event" || el.kind === "view") && el.public === true),
    );
  }

  const publicEvents: ElementExport[] = [];
  const publicViews: ElementExport[] = [];
  const scopedCommands: ElementExport[] = [];
  // A repeated view instance (`view X again`) shares one logical identity (docs/dsl.md,
  // "view … again") — only the first instance is emitted as a `model`; later instances are
  // folded into it rather than re-declared under the same name (which TypeSpec would reject
  // as a duplicate). Left out of this POC: merging the *new* fields a later public instance
  // adds — see buildTypeSpec's module comment / the PR's "left out of POC" notes.
  const seenViewNames = new Set<string>();

  for (const slice of doc.model.slices) {
    for (const el of slice.elements) {
      if (el.kind === "event" && el.public) publicEvents.push(el);
      else if (el.kind === "view" && el.public) {
        const key = el.name.trim().toLowerCase();
        if (!seenViewNames.has(key)) {
          seenViewNames.add(key);
          publicViews.push(el);
        }
      } else if (el.kind === "command" && slicePublic.get(slice.key)) {
        scopedCommands.push(el);
      }
    }
  }

  // ---- Named types: only those reachable from an included element's fields, transitively
  // (never every declared type — a type nobody in the public/command surface references
  // would be dead weight in a *contract* artifact, unlike `em export`'s full-model dump). ----
  const reachableTypeRefs = new Set<string>();
  const walkFields = (fields: FieldExport[] | null) => {
    if (!fields) return;
    for (const f of fields) {
      if (f.typeRef && !reachableTypeRefs.has(f.typeRef.ref)) {
        reachableTypeRefs.add(f.typeRef.ref);
        const t = typesByRef.get(f.typeRef.ref);
        if (t) walkFields(t.fields);
      }
    }
  };
  for (const el of [...publicEvents, ...publicViews, ...scopedCommands]) walkFields(el.fields);

  const usedNames = new Set<string>();
  const typeNameByRef = new Map<string, string>();
  const typeBlocks: string[] = [];
  for (const t of doc.model.types) {
    if (!reachableTypeRefs.has(t.ref)) continue;
    const name = dedupe(pascalCase(t.name), usedNames, "_");
    typeNameByRef.set(t.ref, name);
  }

  const resolveFieldType = (f: FieldExport, refLabel: string): string => {
    if (f.typeRef) {
      const name = typeNameByRef.get(f.typeRef.ref) ?? pascalCase(f.typeRef.name);
      return f.typeRef.array ? `${name}[]` : name;
    }
    if (f.type == null) return "unknown";
    const { tsType, mapped } = mapRawType(f.type);
    if (!mapped) recordUnmapped(refLabel, f.name, f.type);
    return tsType;
  };

  const renderFieldLines = (fields: FieldExport[] | null, refLabel: string): string[] => {
    if (!fields || fields.length === 0) return [];
    const lines: string[] = [];
    for (const f of fields) {
      const fieldDoc = fieldDocComment(f);
      if (fieldDoc) lines.push(`/** ${fieldDoc} */`);
      lines.push(`${fieldIdentifier(f.name)}: ${resolveFieldType(f, refLabel)};`);
    }
    return lines;
  };

  const renderModel = (name: string, fields: FieldExport[] | null, refLabel: string, docComment?: string | null): string => {
    const lines: string[] = [];
    if (docComment) lines.push(`/** ${docComment} */`);
    lines.push(`model ${name} {`);
    lines.push(...indent(renderFieldLines(fields, refLabel), 1));
    lines.push(`}`);
    return lines.join("\n");
  };

  // Named types, in declaration order, filtered to what's reachable.
  for (const t of doc.model.types) {
    const name = typeNameByRef.get(t.ref);
    if (!name) continue;
    typeBlocks.push(renderModel(name, t.fields, `types/${t.name}`));
  }

  // ---- Events (message payloads): plain `model` declarations, schema only ------------------
  //
  // Open question the ticket asks to research: how does TypeSpec represent an async/event
  // contract, given core TypeSpec is HTTP/OpenAPI-shaped? This POC's answer is the option the
  // ticket itself lists as viable without new tooling: a plain `model` for the payload shape,
  // no protocol semantics attached. A promoted version could layer `@typespec/events` or an
  // AsyncAPI emitter on top of these same models for channel/binding semantics — deliberately
  // not attempted here (see "left out of POC", the PR description, and the go/no-go note in
  // this module's header).
  const eventNames = new Set(usedNames);
  const eventBlocks: string[] = [];
  for (const el of publicEvents) {
    const name = dedupe(pascalCase(el.name), eventNames, "_");
    eventBlocks.push(renderModel(name, el.fields, el.ref, elementDocComment(el)));
  }

  // ---- Views (read-model contracts): a `model` for the shape, plus a no-arg accessor `op` —
  // covers both halves of the ticket's "Views -> TypeSpec models/operations". Deliberately no
  // `@get`/`@route` (that's `@typespec/http` territory, a new dependency this POC doesn't
  // need to prove the field-mapping question) — a bare, protocol-agnostic `op`. --------------
  const viewNames = new Set(eventNames);
  const viewBlocks: string[] = [];
  const viewOps: string[] = [];
  for (const el of publicViews) {
    const name = dedupe(pascalCase(el.name), viewNames, "_");
    viewBlocks.push(renderModel(name, el.fields, el.ref, elementDocComment(el)));
    viewOps.push(`op get${name}(): ${name};`);
  }

  // ---- Commands (request contracts): an `op` per command, one parameter per field. ---------
  const commandOpNames = new Set<string>();
  const commandOps: string[] = [];
  for (const el of scopedCommands) {
    const opName = dedupe(camelCase(pascalCase(el.name)), commandOpNames, "_");
    const docComment = elementDocComment(el);
    const params = (el.fields ?? []).map((f) => {
      const fieldDoc = fieldDocComment(f);
      const line = `${fieldIdentifier(f.name)}: ${resolveFieldType(f, el.ref)}`;
      return fieldDoc ? `/** ${fieldDoc} */ ${line}` : line;
    });
    if (docComment) commandOps.push(`/** ${docComment} */`);
    commandOps.push(params.length > 0 ? `op ${opName}(${params.join(", ")}): void;` : `op ${opName}(): void;`);
  }

  // ---- Assemble ------------------------------------------------------------------------
  const namespaceName = pascalCase(doc.model.name ?? "Model") || "Model";
  const sections: string[] = [];
  if (typeBlocks.length > 0) sections.push(typeBlocks.join("\n\n"));
  if (eventBlocks.length > 0) sections.push(eventBlocks.join("\n\n"));
  if (viewBlocks.length > 0) {
    sections.push(viewBlocks.join("\n\n"));
    sections.push(["interface Views {", ...indent(viewOps, 1), "}"].join("\n"));
  }
  if (commandOps.length > 0) {
    sections.push(["interface Commands {", ...indent(commandOps, 1), "}"].join("\n"));
  }

  const header = [
    `// GENERATED by \`em typespec\` (${TYPESPEC_SCHEMA_VERSION}) — EXPERIMENTAL / POC (MIL-159).`,
    `// Source: ${doc.source.path} (sha256 ${doc.source.sha256})`,
    `// Scope: \`public\` events/views (docs/dsl.md "Integration surface"), plus every command in`,
    `// a slice that declares at least one of them. \`tag\`/\`renamed from\`/\`assigned\` are recorded`,
    `// as doc comments only — see docs/cli.md's "em typespec" section for the full mapping.`,
    `// Do not edit by hand — regenerate with \`em typespec ${doc.source.path}\`.`,
  ];

  const body = sections.length > 0 ? indent(sections.join("\n\n").split("\n"), 1) : [];
  const namespaceLines =
    body.length > 0
      ? [`namespace ${namespaceName} {`, ...body, `}`]
      : [`namespace ${namespaceName} {}`];

  const text = [...header, "", ...namespaceLines].join("\n");

  return { text, diagnostics: allDiagnostics, unmappedTypes: unmappedNotes };
}
