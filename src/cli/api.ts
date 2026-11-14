// SPDX-License-Identifier: MIT
// `em api generate | check | surface` (MIL-237, GH #448): the contract path convention
// (briefing R6), the "is the committed contract current" text comparison, the structural
// public-surface diff that annotates each change additive or breaking (briefing R8/R12), and the
// public surface as a structured document for companion tools (GH #448). Pure where it can be —
// fs/git reads go through injectable readers so the diff and the classification are unit-
// testable without a repository; cli.ts and the MCP `api_check`/`api_surface` tools share
// `runApiCheck`/`runApiSurface`.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { EnumDecl, NormalizedModel, ScalarDecl, TypeDecl, normalizeName, resolvePublicType } from "../model/model.js";
import { computeModelKey } from "../model/qualifiedRef.js";
import { hasErrors, Diagnostic } from "../model/validate.js";
import { compile, compileModelFile, compileModelText } from "../pipeline.js";
import { ModelLoadError } from "../model/loadModel.js";
import { ParseError } from "../parser/parser.js";
import { buildApiContract, publicSurfaceOf, reachableEnumRefs, reachableScalarRefs, reachableTypeRefs } from "../emit/api.js";
import { buildExportDoc, ElementExport, EnumExport, FieldExport, TypeExport } from "../emit/json.js";
import { RefsResult } from "../model/refs.js";
import { kebabSlug } from "../util/slug.js";
import { GitRunner, realGit, resolveRevision, gitSourceReader } from "./diff-inputs.js";

/** `<modelDir>/contracts/<modelKey>.tsp` (R6), built from the model path as given. */
export function contractPathFor(modelFile: string, modelKey: string): string {
  return join(dirname(modelFile), "contracts", `${modelKey}.tsp`);
}

/** The `Source:` label: the model path relative to the contract file's directory, `/`-separated,
 *  so the generated text never depends on the cwd `em api generate` ran from. */
export function sourceLabelFor(modelFile: string, contractFile: string): string {
  return relative(dirname(resolve(contractFile)), resolve(modelFile)).split(sep).join("/");
}

export interface GeneratedContract {
  modelKey: string;
  contractPath: string;
  /** Full file text, trailing newline included. */
  text: string;
  diagnostics: Diagnostic[];
}

/** Compile result + generated contract text for an error-free model. */
export function generateContract(
  file: string,
  source: string,
  compiled: ReturnType<typeof compile>,
  outPath?: string,
): GeneratedContract {
  const modelKey = computeModelKey(compiled.model, file);
  const contractPath = outPath ?? contractPathFor(file, modelKey);
  const result = buildApiContract(
    compiled.model,
    compiled.refs,
    compiled.diagnostics,
    source,
    file,
    sourceLabelFor(file, contractPath),
  );
  return { modelKey, contractPath, text: result.text + "\n", diagnostics: result.diagnostics };
}

// ---- Structural public-surface diff (R8) ------------------------------------------------

export type ApiChangeKind = "additive" | "breaking";

export interface ApiCheckChange {
  kind: ApiChangeKind;
  /** `<kind>.<slug>` of the element (or `type.<slug>` for a declared type) — contract-level
   *  identity, no slice key (moving an element between slices does not change the contract). */
  element: string;
  /** The field the change concerns, or null for an element-level change. */
  field: string | null;
  what: string;
}

type Role = "input" | "output";

interface SurfaceEntry {
  /** command | event | view | type | enum */
  kind: string;
  name: string;
  /** Normalized identity key: kind + normalizeName(name). */
  key: string;
  fields: FieldExport[];
  renamedFrom: string[];
  roles: Set<Role>;
  /** Model-declared invariants (MIL-265), declaration order; `[]` for a type/enum. */
  invariants: { id: string; rule: string | null }[];
  /** GH #478: an enum's own members, in declaration order — `[]` for every non-enum kind. */
  members: string[];
}

interface Surface {
  entries: SurfaceEntry[];
  /** Normalized `kind:name` of every element present in the model, public or not — tells
   *  "`public` dropped" apart from "removed". */
  allElements: Set<string>;
}

const keyOf = (kind: string, name: string) => `${kind}:${normalizeName(name)}`;


/** Build the public surface of one compiled model: public commands (input), events and views
 *  (output), and every declared type/enum reachable from them (carrying the roles that reach
 *  it — GH #478 extends the existing type-reach walk to also track an `enumRef` field,
 *  directly or through a reachable type's own fields, the same way `reachableEnumRefs`
 *  (emit/api.ts) tracks it for `em api generate`). `enums` defaults to `[]` so every existing
 *  caller (and the one test helper that built a `Surface` before enums existed) keeps compiling
 *  without a required third argument at a call site that never has one. */
export function surfaceOf(
  slices: { elements: ElementExport[] }[],
  types: TypeExport[],
  enums: EnumExport[] = [],
): Surface {
  const s = publicSurfaceOf(slices);
  const entries: SurfaceEntry[] = [];
  const typesByRef = new Map(types.map((t) => [t.ref, t]));
  const typeRoles = new Map<string, Set<Role>>();
  const enumRoles = new Map<string, Set<Role>>();
  const reach = (fields: FieldExport[] | null, role: Role) => {
    for (const f of fields ?? []) {
      if (f.enumRef) {
        const roles = enumRoles.get(f.enumRef.ref) ?? new Set<Role>();
        roles.add(role);
        enumRoles.set(f.enumRef.ref, roles);
      }
      if (!f.typeRef) continue;
      const roles = typeRoles.get(f.typeRef.ref) ?? new Set<Role>();
      if (roles.has(role)) continue;
      roles.add(role);
      typeRoles.set(f.typeRef.ref, roles);
      reach(typesByRef.get(f.typeRef.ref)?.fields ?? null, role);
    }
  };
  const push = (el: ElementExport, role: Role) => {
    entries.push({
      kind: el.kind,
      name: el.name,
      key: keyOf(el.kind, el.name),
      fields: el.fields ?? [],
      renamedFrom: el.renamedFrom ?? [],
      roles: new Set([role]),
      invariants: el.invariants ?? [],
      members: [],
    });
    reach(el.fields, role);
  };
  for (const el of s.commands) push(el, "input");
  for (const el of s.events) push(el, "output");
  for (const el of s.views) push(el, "output");
  for (const t of types) {
    const roles = typeRoles.get(t.ref);
    if (!roles) continue;
    entries.push({ kind: "type", name: t.name, key: keyOf("type", t.name), fields: t.fields, renamedFrom: [], roles, invariants: [], members: [] });
  }
  for (const e of enums) {
    const roles = enumRoles.get(e.ref);
    if (!roles) continue;
    entries.push({ kind: "enum", name: e.name, key: keyOf("enum", e.name), fields: [], renamedFrom: [], roles, invariants: [], members: e.members });
  }
  const allElements = new Set<string>();
  for (const slice of slices) for (const el of slice.elements) allElements.add(keyOf(el.kind, el.name));
  for (const t of types) allElements.add(keyOf("type", t.name));
  for (const e of enums) allElements.add(keyOf("enum", e.name));
  return { entries, allElements };
}

/** A field's type as the contract sees it: a declared type's, identity scalar's or enum's
 *  name, or the raw string, normalized, with its array arity. */
export function typeLabel(f: Pick<FieldExport, "type" | "typeRef" | "scalarRef" | "enumRef">): string {
  if (f.typeRef) return `${f.typeRef.name}${f.typeRef.array ? "[]" : ""}`;
  if (f.scalarRef) return `${f.scalarRef.name}${f.scalarRef.array ? "[]" : ""}`;
  if (f.enumRef) return `${f.enumRef.name}${f.enumRef.array ? "[]" : ""}`;
  return f.type ?? "(none)";
}
/**
 * GH #477: a `scalarRef` folds its `base` into the identity string too, not just `ref`/`array` —
 * so a surviving scalar DECLARATION's base changing (`OrderId: uuid` -> `OrderId: string`)
 * registers as a type change on every field that uses it, even though the scalar's own ref and
 * the field's array arity are unchanged. This reuses `diffFields`' existing per-field
 * `compare()` rather than adding a second comparison path — see its `scalarRef`-aware branch
 * below for the breaking-change message this produces. GH #478: `enumRef` needs no equivalent
 * fold — an enum's MEMBER changes are diffed on the enum's own `SurfaceEntry` (`diffEnumMembers`
 * below), not per using field, so `ref`/`array` alone identify a field's enum reference here.
 */
export function typeIdentity(f: Pick<FieldExport, "type" | "typeRef" | "scalarRef" | "enumRef">): string {
  if (f.typeRef) return `ref:${f.typeRef.ref}:${f.typeRef.array}`;
  if (f.scalarRef) return `ref:${f.scalarRef.ref}:${f.scalarRef.array}:${f.scalarRef.base}`;
  if (f.enumRef) return `enum-ref:${f.enumRef.ref}:${f.enumRef.array}`;
  return `raw:${(f.type ?? "").replace(/\s+/g, "").toLowerCase()}`;
}

function diffFields(base: SurfaceEntry, head: SurfaceEntry, element: string, out: ApiCheckChange[]): void {
  const roles = new Set([...base.roles, ...head.roles]);
  const isInput = roles.has("input");
  const isOutput = roles.has("output");
  const headByName = new Map(head.fields.map((f) => [normalizeName(f.name), f]));
  const baseByName = new Map(base.fields.map((f) => [normalizeName(f.name), f]));
  // HEAD field -> base field it renames (a `renamed from` naming a base field that HEAD no
  // longer carries under its old name).
  const renamedTo = new Map<string, FieldExport>();
  for (const f of head.fields) {
    if (baseByName.has(normalizeName(f.name))) continue;
    for (const old of f.renamedFrom ?? []) {
      const k = normalizeName(old);
      if (baseByName.has(k) && !headByName.has(k) && !renamedTo.has(k)) {
        renamedTo.set(k, f);
        break;
      }
    }
  }
  const compare = (b: FieldExport, h: FieldExport) => {
    if (typeIdentity(b) !== typeIdentity(h)) {
      // GH #477: same scalar declaration, same array arity, different `base` — the field's own
      // reference didn't change, but what it resolves to on the wire did (every consumer
      // deserializing this field as the old base now gets the new one). Phrased distinctly from
      // an ordinary type change so the report doesn't read as "OrderId -> OrderId" (no visible
      // difference) when the real story is the scalar's declaration.
      if (
        b.scalarRef && h.scalarRef &&
        b.scalarRef.ref === h.scalarRef.ref &&
        b.scalarRef.array === h.scalarRef.array &&
        b.scalarRef.base !== h.scalarRef.base
      ) {
        out.push({
          kind: "breaking",
          element,
          field: h.name,
          what: `scalar "${h.scalarRef.name}" base changed ${b.scalarRef.base} → ${h.scalarRef.base}`,
        });
      } else {
        out.push({ kind: "breaking", element, field: h.name, what: `type changed ${typeLabel(b)} → ${typeLabel(h)}` });
      }
    }
    if (b.optional !== h.optional) {
      if (h.optional) {
        // required → optional: outputs may now omit it (breaking); inputs only loosen.
        out.push({ kind: isOutput ? "breaking" : "additive", element, field: h.name, what: "changed required → optional" });
      } else {
        out.push({ kind: "breaking", element, field: h.name, what: "changed optional → required" });
      }
    }
  };
  // Base order first: removals, renames and changes to existing fields.
  for (const b of base.fields) {
    const k = normalizeName(b.name);
    const h = headByName.get(k);
    if (h) {
      compare(b, h);
      continue;
    }
    const renamed = renamedTo.get(k);
    if (renamed) {
      out.push({ kind: "breaking", element, field: renamed.name, what: `renamed from "${b.name}"` });
      compare(b, renamed);
      continue;
    }
    out.push({ kind: "breaking", element, field: b.name, what: "removed" });
  }
  // Then HEAD-only fields, HEAD order.
  const renameTargets = new Set([...renamedTo.values()]);
  for (const h of head.fields) {
    if (baseByName.has(normalizeName(h.name)) || renameTargets.has(h)) continue;
    const required = !h.optional;
    // Adding a required input is breaking (existing callers do not send it); adding to an
    // output is additive (consumers tolerate unknown fields).
    const kind: ApiChangeKind = isInput && required ? "breaking" : "additive";
    out.push({ kind, element, field: h.name, what: `added (${required ? "required" : "optional"})` });
  }
}

/**
 * GH #478: an enum's own member set, base vs HEAD, diffed by role (the same `isInput`/
 * `isOutput` union `diffFields` computes above) — the issue's pinned severity matrix:
 *   - member REMOVED (or, since there's no rename clause, the removal half of what reads as a
 *     rename) is breaking wherever the enum reaches an OUTPUT (an existing receiver may still
 *     expect that known value) — not conditioned on input reach at all.
 *   - member ADDED is breaking wherever the enum reaches an INPUT (existing senders are
 *     unaffected; a strict receiver built against the old member set rejects the new value) —
 *     additive on a PURE output (`isInput` false): a receiver tolerates an unknown value.
 * A rename is never detected as such (same "no rename detection" posture `em diff` already
 * takes for a `type`/element rename, model/diff.ts) — it reads as remove+add, each half scored
 * independently by the rules above. Base order first (removals), then HEAD-only (additions),
 * same convention `diffFields` uses.
 */
function diffEnumMembers(base: SurfaceEntry, head: SurfaceEntry, element: string, out: ApiCheckChange[]): void {
  const roles = new Set([...base.roles, ...head.roles]);
  const isInput = roles.has("input");
  const isOutput = roles.has("output");
  const baseKeys = new Set(base.members.map(normalizeName));
  const headKeys = new Set(head.members.map(normalizeName));
  for (const b of base.members) {
    if (headKeys.has(normalizeName(b))) continue;
    out.push({ kind: isOutput ? "breaking" : "additive", element, field: null, what: `member "${b}" removed` });
  }
  for (const h of head.members) {
    if (baseKeys.has(normalizeName(h))) continue;
    out.push({ kind: isInput ? "breaking" : "additive", element, field: null, what: `member "${h}" added` });
  }
}

/** MIL-265: a public element's invariants, base vs HEAD, matched by ID. Added or rule text
 *  changed = breaking (the contract got tighter); removed = additive (looser). HEAD order for
 *  additions/changes, then base order for removals. */
function diffInvariants(base: SurfaceEntry, head: SurfaceEntry, element: string, out: ApiCheckChange[]): void {
  const baseById = new Map(base.invariants.map((i) => [i.id, i]));
  const headIds = new Set(head.invariants.map((i) => i.id));
  for (const h of head.invariants) {
    const b = baseById.get(h.id);
    if (!b) out.push({ kind: "breaking", element, field: null, what: `invariant ${h.id} added` });
    else if (b.rule !== h.rule) out.push({ kind: "breaking", element, field: null, what: `invariant ${h.id} rule changed` });
  }
  for (const b of base.invariants) {
    if (!headIds.has(b.id)) out.push({ kind: "additive", element, field: null, what: `invariant ${b.id} removed` });
  }
}

/** Diff two public surfaces. `base === null` means the model did not exist at the base
 *  revision: every HEAD element is an additive addition. */
export function diffSurfaces(base: Surface | null, head: Surface): ApiCheckChange[] {
  const out: ApiCheckChange[] = [];
  const elementId = (e: SurfaceEntry) => `${e.kind}.${kebabSlug(e.name)}`;
  if (!base) {
    for (const h of head.entries) out.push({ kind: "additive", element: elementId(h), field: null, what: "added" });
    return out;
  }
  const baseByKey = new Map(base.entries.map((e) => [e.key, e]));
  const matchedBase = new Set<string>();
  for (const h of head.entries) {
    const element = elementId(h);
    const same = baseByKey.get(h.key);
    if (same) {
      matchedBase.add(same.key);
      if (h.kind === "enum") diffEnumMembers(same, h, element, out);
      else diffFields(same, h, element, out);
      diffInvariants(same, h, element, out);
      continue;
    }
    const renamedFrom = h.renamedFrom
      .map((old) => baseByKey.get(keyOf(h.kind, old)))
      .find((b): b is SurfaceEntry => b !== undefined && !matchedBase.has(b.key) && !head.entries.some((x) => x.key === b.key));
    if (renamedFrom) {
      matchedBase.add(renamedFrom.key);
      out.push({ kind: "breaking", element, field: null, what: `renamed from "${renamedFrom.name}"` });
      if (h.kind === "enum") diffEnumMembers(renamedFrom, h, element, out);
      else diffFields(renamedFrom, h, element, out);
      diffInvariants(renamedFrom, h, element, out);
      continue;
    }
    if (h.kind !== "type" && h.kind !== "enum" && base.allElements.has(h.key)) {
      out.push({ kind: "additive", element, field: null, what: "marked public" });
    } else {
      out.push({ kind: "additive", element, field: null, what: "added" });
    }
  }
  for (const b of base.entries) {
    if (matchedBase.has(b.key)) continue;
    const element = elementId(b);
    if (b.kind !== "type" && b.kind !== "enum" && head.allElements.has(b.key)) {
      out.push({ kind: "breaking", element, field: null, what: "`public` dropped" });
    } else {
      out.push({ kind: "breaking", element, field: null, what: "removed" });
    }
  }
  return out;
}

// ---- The check itself ------------------------------------------------------------------

export interface ApiCheckReport {
  file: string;
  contractPath: string;
  current: boolean;
  /** True when the contract file does not exist at all (a special case of not current). */
  missing: boolean;
  base: string | null;
  changes: ApiCheckChange[];
}

export type ApiCheckOutcome =
  | { ok: true; report: ApiCheckReport; diagnostics: Diagnostic[] }
  | { ok: false; message: string; diagnostics: Diagnostic[] };

/**
 * Run `em api check <file> [--base <rev>]`. (a) "current" = regenerate from the working-tree
 * model and compare to the committed contract file's text; (b) with `base`, compile the model
 * at that revision (`resolveRevision`) and diff the public surfaces structurally. A model
 * absent at `base` (new model) reports every public element as additive.
 *
 * GH #473: the HEAD side compiles through `compileModelFile` — the same storyline-aware loader
 * `em api generate` uses (root plus every storyline model file it declares, GH #421) — so a
 * public element declared in a storyline file is part of the surface instead of making the
 * contract stale forever. GH #475: the `--base` side loads the root at `base` plus every storyline
 * file it declares, each read at that same revision (`gitSourceReader`), so both surfaces are
 * whole.
 */
export function runApiCheck(file: string, base: string | undefined, runGit: GitRunner = realGit): ApiCheckOutcome {
  if (!existsSync(file)) {
    return { ok: false, message: `em api check: cannot read ${file}`, diagnostics: [] };
  }
  let head;
  try {
    head = compileModelFile(file);
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, message: `em api check: parse error in ${file} ${e.message}`, diagnostics: [] };
    if (e instanceof ModelLoadError) return { ok: false, message: `em api check: ${e.message}`, diagnostics: [] };
    throw e;
  }
  if (hasErrors(head.diagnostics)) {
    return { ok: false, message: "em api check: not checking — fix the errors above", diagnostics: head.diagnostics };
  }
  const generated = generateContract(file, head.source, head);
  const missing = !existsSync(generated.contractPath);
  const current = !missing && readFileSync(generated.contractPath, "utf8") === generated.text;

  let changes: ApiCheckChange[] = [];
  if (base !== undefined) {
    const top = runGit(["-C", dirname(resolve(file)), "rev-parse", "--show-toplevel"]);
    if (top.status !== 0) {
      return { ok: false, message: `em api check: ${file} is not inside a git repository (needed for --base)`, diagnostics: head.diagnostics };
    }
    const verify = runGit(["-C", dirname(resolve(file)), "rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
    if (verify.status !== 0) {
      return { ok: false, message: `em api check: unknown revision "${base}" (needed for --base)`, diagnostics: head.diagnostics };
    }
    const headDoc = buildExportDoc(head.model, head.refs, head.diagnostics, head.source, file).doc;
    const headSurface = surfaceOf(headDoc.model.slices, headDoc.model.types, headDoc.model.enums);
    const atBase = resolveRevision(file, base, runGit);
    let baseSurface: Surface | null = null;
    if (atBase.ok) {
      let baseCompiled;
      try {
        // GH #475: root at `base` plus every storyline model file it declares, each read at the
        // same revision — the base surface carries the storyline files' public elements too.
        baseCompiled = compileModelText(atBase.content, gitSourceReader(file, base, runGit), `${file}@${base}`);
      } catch (e) {
        if (e instanceof ParseError) {
          return { ok: false, message: `em api check: parse error in ${file}@${base} ${e.message}`, diagnostics: head.diagnostics };
        }
        if (e instanceof ModelLoadError) return { ok: false, message: `em api check: ${e.message}`, diagnostics: head.diagnostics };
        throw e;
      }
      // Base-side validate errors (e.g. a pre-1.14 free-text public type) do not block the
      // structural diff — the diff reads shapes, not strictness.
      const baseDoc = buildExportDoc(baseCompiled.model, baseCompiled.refs, baseCompiled.diagnostics, atBase.content, file).doc;
      baseSurface = surfaceOf(baseDoc.model.slices, baseDoc.model.types, baseDoc.model.enums);
    } else if (!/is not tracked by git/.test(atBase.message)) {
      return { ok: false, message: atBase.message.replace(/^em diff:/, "em api check:"), diagnostics: head.diagnostics };
    }
    changes = diffSurfaces(baseSurface, headSurface);
  }
  return {
    ok: true,
    report: { file, contractPath: generated.contractPath, current, missing, base: base ?? null, changes },
    diagnostics: generated.diagnostics,
  };
}

/** The text report: one status line, then one `additive:`/`breaking:` line per change. */
export function formatApiCheckText(r: ApiCheckReport): string[] {
  const lines: string[] = [];
  const regen = `run: em api generate ${r.file}`;
  if (r.current) lines.push(`contract ${r.contractPath} is current`);
  else if (r.missing) lines.push(`contract ${r.contractPath} is missing — ${regen}`);
  else lines.push(`contract ${r.contractPath} is stale — ${regen}`);
  if (r.base !== null) {
    if (r.changes.length === 0) lines.push(`no public-surface changes since ${r.base}`);
    for (const c of r.changes) {
      lines.push(`${c.kind}: ${c.element}${c.field !== null ? ` field "${c.field}"` : ""} ${c.what}`);
    }
  }
  return lines;
}

// ---- `em api surface` (GH #448) ---------------------------------------------------------

/** A public field's resolved type (R7's fixed table, a declared identity scalar, a declared
 *  enum, or a declared type), the same shape `resolvePublicType` (model/model.ts) computes —
 *  `scalar` carries the matched table entry's key and the TypeSpec core scalar `em api
 *  generate` emits for it; `declared` carries the reachable type's own name (see
 *  `ApiSurfaceType` below for its full field shape); `scalar-alias` (GH #477, schema 1.1)
 *  carries the declared identity scalar's own name in `tsType` (what actually appears in the
 *  generated contract, same convention `declared` already uses) and the table key it extends
 *  in `base` — `scalar`/`declared` leave `base` `null`; `enum` (GH #478, schema 1.2) carries
 *  the declared enum's own name in `tsType`, same convention — find its members under the
 *  report's own `enums` list. */
export interface ApiSurfaceFieldType {
  kind: "scalar" | "declared" | "scalar-alias" | "enum";
  scalar: string | null;
  /** The `PUBLIC_SCALAR_TYPES` key a `scalar-alias` extends; `null` for every other kind. */
  base: string | null;
  tsType: string;
  array: boolean;
}

export interface ApiSurfaceField {
  name: string;
  type: ApiSurfaceFieldType;
  optional: boolean;
  tag: boolean;
  assigned: boolean;
  renamedFrom: string[] | null;
}

/** One public command/event/view on the surface. `slug` is the kebab-slug of `name` — a stable,
 *  human-legible identity a companion tool can use without re-deriving it (same slugging `em api
 *  check`'s element ids use, minus the `<kind>.` prefix since commands/events/views are already
 *  separated into their own arrays here). */
export interface ApiSurfaceElement {
  name: string;
  slug: string;
  fields: ApiSurfaceField[];
  invariants: { id: string; rule: string | null }[] | null;
}

/** One declared `type` reachable from a public command/event/view's fields. */
export interface ApiSurfaceType {
  name: string;
  slug: string;
  fields: ApiSurfaceField[];
}

/** One declared `scalar Name: base` identity alias reachable from a public command/event/view's
 *  fields (GH #477, schema 1.1) — `base` is the `PUBLIC_SCALAR_TYPES` key it extends. */
export interface ApiSurfaceScalar {
  name: string;
  slug: string;
  base: string;
}

/** One declared `enum Name { member, … }` reachable from a public command/event/view's fields
 *  (GH #478, schema 1.2) — `members` in declaration order, raw (unquoted). */
export interface ApiSurfaceEnum {
  name: string;
  slug: string;
  members: string[];
}

export interface ApiSurfaceReport {
  file: string;
  modelKey: string;
  commands: ApiSurfaceElement[];
  events: ApiSurfaceElement[];
  views: ApiSurfaceElement[];
  types: ApiSurfaceType[];
  scalars: ApiSurfaceScalar[];
  enums: ApiSurfaceEnum[];
}

export type ApiSurfaceOutcome =
  | { ok: true; report: ApiSurfaceReport; diagnostics: Diagnostic[] }
  | { ok: false; message: string; diagnostics: Diagnostic[] };

/** Resolve one field's public type exactly as `em api generate`'s own `fieldType()` does
 *  (emit/api.ts) — declared types win (same precedence `resolvePublicType` already gives), then
 *  a declared identity scalar (GH #477), then a declared enum (GH #478), else the fixed scalar
 *  table. A model with errors never reaches here (both CLI callers refuse first), so an
 *  unresolved type is a programming error, not a user-facing case — same posture as
 *  `buildApiContract`'s own throw. */
function surfaceFieldType(
  f: FieldExport,
  typesByName: Map<string, TypeDecl>,
  scalarsByName: Map<string, ScalarDecl>,
  enumsByName: Map<string, EnumDecl>,
  owner: string,
): ApiSurfaceFieldType {
  const r = resolvePublicType(f.type ?? undefined, typesByName, scalarsByName, enumsByName);
  if (!r) {
    throw new Error(
      `em api surface: ${owner} field "${f.name}" has no public type — em validate's ` +
        "public-field-type-unresolved should have refused this model",
    );
  }
  if (r.kind === "scalar") return { kind: "scalar", scalar: r.scalar, base: null, tsType: r.tsType, array: r.array };
  if (r.kind === "identity") {
    return { kind: "scalar-alias", scalar: null, base: r.base, tsType: r.scalarDecl.name, array: r.array };
  }
  if (r.kind === "enum") return { kind: "enum", scalar: null, base: null, tsType: r.enumDecl.name, array: r.array };
  return { kind: "declared", scalar: null, base: null, tsType: r.typeDecl.name, array: r.array };
}

function surfaceField(
  f: FieldExport,
  typesByName: Map<string, TypeDecl>,
  scalarsByName: Map<string, ScalarDecl>,
  enumsByName: Map<string, EnumDecl>,
  owner: string,
): ApiSurfaceField {
  return {
    name: f.name,
    type: surfaceFieldType(f, typesByName, scalarsByName, enumsByName, owner),
    optional: f.optional,
    tag: f.tag,
    assigned: f.assigned,
    renamedFrom: f.renamedFrom,
  };
}

function surfaceElement(
  el: ElementExport,
  typesByName: Map<string, TypeDecl>,
  scalarsByName: Map<string, ScalarDecl>,
  enumsByName: Map<string, EnumDecl>,
): ApiSurfaceElement {
  return {
    name: el.name,
    slug: kebabSlug(el.name),
    fields: (el.fields ?? []).map((f) => surfaceField(f, typesByName, scalarsByName, enumsByName, `${el.kind} "${el.name}"`)),
    invariants: el.invariants ?? null,
  };
}

/**
 * Build the `em api surface` report for an already-validated (error-free) model: the `public`
 * commands/events/views (`publicSurfaceOf`, same as `em api generate`/`em api check`) plus every
 * declared type reachable from their fields (`reachableTypeRefs`, same walk `em api generate`'s
 * contract body uses), every declared identity scalar reachable the same way
 * (`reachableScalarRefs`, GH #477), and every declared enum reachable the same way
 * (`reachableEnumRefs`, GH #478), each field's type resolved through `resolvePublicType` — the
 * one notion of the public surface every em surface shares, so a companion tool never re-derives
 * it from `em export --json` and risks drifting from it.
 */
export function buildApiSurfaceReport(
  model: NormalizedModel,
  refs: RefsResult,
  diagnostics: Diagnostic[],
  source: string,
  file: string,
): ApiSurfaceReport {
  const { doc } = buildExportDoc(model, refs, diagnostics, source, file);
  const surface = publicSurfaceOf(doc.model.slices);
  const typesByRef = new Map(doc.model.types.map((t) => [t.ref, t]));
  const reachable = reachableTypeRefs([...surface.commands, ...surface.events, ...surface.views], typesByRef);
  const reachableScalars = reachableScalarRefs([...surface.commands, ...surface.events, ...surface.views], typesByRef);
  const reachableEnums = reachableEnumRefs([...surface.commands, ...surface.events, ...surface.views], typesByRef);
  return {
    file,
    modelKey: doc.model.key,
    commands: surface.commands.map((el) => surfaceElement(el, model.typesByName, model.scalarsByName, model.enumsByName)),
    events: surface.events.map((el) => surfaceElement(el, model.typesByName, model.scalarsByName, model.enumsByName)),
    views: surface.views.map((el) => surfaceElement(el, model.typesByName, model.scalarsByName, model.enumsByName)),
    types: doc.model.types
      .filter((t) => reachable.has(t.ref))
      .map((t) => ({
        name: t.name,
        slug: kebabSlug(t.name),
        fields: t.fields.map((f) => surfaceField(f, model.typesByName, model.scalarsByName, model.enumsByName, `type "${t.name}"`)),
      })),
    scalars: doc.model.scalars
      .filter((s) => reachableScalars.has(s.ref))
      .map((s) => ({ name: s.name, slug: kebabSlug(s.name), base: s.base })),
    enums: doc.model.enums
      .filter((e) => reachableEnums.has(e.ref))
      .map((e) => ({ name: e.name, slug: kebabSlug(e.name), members: e.members })),
  };
}

/**
 * Run `em api surface <file>`: compile, refuse on errors (same posture as `em api generate` —
 * `public-field-type-unresolved` included), build the report. Self-contained (reads + compiles
 * `file` itself) so the MCP `api_surface` tool can call it with just a path, same shape as
 * `runApiCheck`.
 *
 * GH #473: compiles through `compileModelFile` (storyline-aware, GH #421) — a single-file
 * `compile()` here silently omitted every public element declared in a storyline file.
 */
export function runApiSurface(file: string): ApiSurfaceOutcome {
  if (!existsSync(file)) {
    return { ok: false, message: `em api surface: cannot read ${file}`, diagnostics: [] };
  }
  let compiled;
  try {
    compiled = compileModelFile(file);
  } catch (e) {
    if (e instanceof ParseError) {
      return { ok: false, message: `em api surface: parse error in ${file} ${e.message}`, diagnostics: [] };
    }
    if (e instanceof ModelLoadError) {
      return { ok: false, message: `em api surface: ${e.message}`, diagnostics: [] };
    }
    throw e;
  }
  if (hasErrors(compiled.diagnostics)) {
    return { ok: false, message: "em api surface: not generating — fix the errors above", diagnostics: compiled.diagnostics };
  }
  const report = buildApiSurfaceReport(compiled.model, compiled.refs, compiled.diagnostics, compiled.source, file);
  return { ok: true, report, diagnostics: compiled.diagnostics };
}

/** The text listing: one line per command/event/view/type, with its field count. */
export function formatApiSurfaceText(r: ApiSurfaceReport): string[] {
  const lines: string[] = [`model ${r.modelKey} (${r.file})`];
  const fieldCount = (n: number) => `${n} field${n === 1 ? "" : "s"}`;
  const section = (label: string, elements: { slug: string; fields: unknown[] }[]) => {
    if (elements.length === 0) return;
    lines.push(`${label}:`);
    for (const el of elements) lines.push(`  ${el.slug} (${fieldCount(el.fields.length)})`);
  };
  section("commands", r.commands);
  section("events", r.events);
  section("views", r.views);
  section("types", r.types);
  if (r.scalars.length > 0) {
    lines.push("scalars:");
    for (const s of r.scalars) lines.push(`  ${s.slug} extends ${s.base}`);
  }
  if (r.enums.length > 0) {
    lines.push("enums:");
    for (const e of r.enums) lines.push(`  ${e.slug} { ${e.members.join(", ")} }`);
  }
  if (
    r.commands.length === 0 && r.events.length === 0 && r.views.length === 0 &&
    r.types.length === 0 && r.scalars.length === 0 && r.enums.length === 0
  ) {
    lines.push("(no public surface)");
  }
  return lines;
}
