// SPDX-License-Identifier: MIT
// Normalizes a parsed AST into a resolved model: stable ids, resolved
// persona/context lanes, and lookup indexes used by layout and validation.

import { AUTOMATION_KINDS, ElementKind, Field, ModelNode, TagClause } from "../parser/ast.js";
import { dedupe, slug } from "../util/slug.js";

/** A declared named type (`type Name { … }`) — its own top-level namespace, separate from
 *  elements (a type and an element may share a name without colliding). */
export interface TypeDecl {
  id: string;
  name: string;
  fields: Field[];
  line: number;
}

/** A field's type string resolved to a declared type, when it names one. */
export interface TypeRef {
  typeDecl: TypeDecl;
  /** True when the field's type is `Name[]` (an array of the referenced type) rather than bare. */
  array: boolean;
}

export const DEFAULT_PERSONA = "User";
export const DEFAULT_CONTEXT = "Domain";

export interface Element {
  id: string;
  kind: ElementKind;
  name: string;
  /** Resolved persona lane (ui only). */
  persona?: string;
  /** Resolved context lane (event only). */
  context?: string;
  /** Source event names (view only). */
  from?: string[];
  /** Markdown file holding this element's notes, relative to the .em file. */
  note?: string;
  /** Open question text, flagged red on the diagram until resolved. */
  issue?: string;
  /** Reasoned, ratified deviation between this element and its implementation — the
   *  resolved sibling of `issue` (lint-suppression-with-rationale for conformance). */
  divergence?: string;
  /** Data attributes declared on the element. */
  fields?: Field[];
  sliceIndex: number;
  line: number;
  /** view-only: marks a later timeline instance of an already-declared read model. */
  again?: boolean;
  /** event or view: marks this element as part of the published integration surface. */
  public?: boolean;
  /** Element-level `tag` clauses (composite/external) — events only. Inline field identity
   *  tags live on `Field.tag` instead (see `collectTags` for the merged view). */
  tags?: TagClause[];
  /** `renamed from "Old1", "Old2"` on the element's own name — event or command only
   *  (MIL-68). `undefined` when absent. Purely export/codegen metadata: `em diff` never reads
   *  this, and continues reporting a rename as remove+add. */
  renamedFrom?: string[];
  /** id of the first instance of this logical element (== id for everything except later view instances). */
  logicalId: string;
}

export type TagEntryKind = "identity" | "composite" | "external";

/** One tag key in an event's merged tag set, as both `emit/json.ts` (the `tags` export array)
 *  and `validate.ts` (duplicate-key / composite-field-exists rules) need to see it. */
export interface TagEntry {
  key: string;
  kind: TagEntryKind;
  /** identity: `[fieldName]`. composite: the listed field names. external: `null`. */
  fields: string[] | null;
  /** external: the documentation string. identity/composite: `null`. */
  description: string | null;
}

/**
 * Every tag key an element carries, merged from its two sources and ordered per the export
 * contract: inline field identity tags first (`Field.tag === true`, in field declaration
 * order), then element-level `tag` clauses — composite and external — in declaration order
 * (`Element.tags`). Returns `[]` for an element with no tags at all (never null — callers
 * decide their own "no tags" representation, e.g. `emit/json.ts` exports `null` instead).
 * Shared by `emit/json.ts` and `validate.ts` so both see the identical merged view; in
 * practice only ever meaningful for `kind === "event"` (the only kind `tag` clauses can attach
 * to — enforced at parse time), but takes no kind dependency itself.
 */
export function collectTags(element: Element): TagEntry[] {
  const entries: TagEntry[] = [];
  for (const f of element.fields ?? []) {
    if (f.tag === true) entries.push({ key: f.name, kind: "identity", fields: [f.name], description: null });
  }
  for (const t of element.tags ?? []) {
    if (t.kind === "composite") entries.push({ key: t.key, kind: "composite", fields: t.fields ?? [], description: null });
    else entries.push({ key: t.key, kind: "external", fields: null, description: t.description ?? null });
  }
  return entries;
}

export interface Slice {
  name: string;
  index: number;
  /** `source "url"` — link to the ticket/conversation this slice traces back to. */
  source?: string;
  elements: Element[];
  line: number;
}

export interface ResolvedArrow {
  from: string;
  to: string;
  fromId?: string;
  toId?: string;
  line: number;
}

export interface NormalizedModel {
  name: string;
  personas: string[];
  contexts: string[];
  hasAutomation: boolean;
  slices: Slice[];
  elements: Element[];
  byId: Map<string, Element>;
  /** Normalized display name -> elements with that name (across slices). */
  byName: Map<string, Element[]>;
  arrows: ResolvedArrow[];
  /** Declared named types (`type Name { … }`), in document order. */
  types: TypeDecl[];
  /** Normalized name -> first-declared TypeDecl (references resolve to the first occurrence,
   *  same convention as `byName`). */
  typesByName: Map<string, TypeDecl>;
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalize(ast: ModelNode): NormalizedModel {
  const personas = [...ast.personas];
  const contexts = [...ast.contexts];
  const slices: Slice[] = [];
  const elements: Element[] = [];
  const byId = new Map<string, Element>();
  const byName = new Map<string, Element[]>();
  const usedIds = new Set<string>();
  const firstViewIdByName = new Map<string, string>();
  let hasAutomation = false;

  const makeId = (name: string): string => dedupe(slug(name), usedIds, "_");

  // Types are their own namespace: a separate id set so a type and an element may
  // legitimately share a name/slug without colliding (their ids are never compared
  // against each other, only used as map keys within their own registry).
  const usedTypeIds = new Set<string>();
  const makeTypeId = (name: string): string => dedupe(slug(name), usedTypeIds, "_");
  const types: TypeDecl[] = ast.types.map((t) => ({
    id: makeTypeId(t.name),
    name: t.name,
    fields: t.fields,
    line: t.line,
  }));
  const typesByName = new Map<string, TypeDecl>();
  for (const t of types) {
    const key = normalizeName(t.name);
    if (!typesByName.has(key)) typesByName.set(key, t); // first declaration wins
  }

  ast.slices.forEach((sliceNode, sliceIndex) => {
    const slice: Slice = {
      name: sliceNode.name,
      index: sliceIndex,
      source: sliceNode.source,
      elements: [],
      line: sliceNode.line,
    };

    for (const el of sliceNode.elements) {
      const element: Element = {
        id: makeId(el.name),
        logicalId: "",
        again: el.again,
        public: el.public,
        kind: el.kind,
        name: el.name,
        sliceIndex,
        line: el.line,
        from: el.from,
        note: el.note,
        issue: el.issue,
        divergence: el.divergence,
        fields: el.fields,
        tags: el.tags,
        renamedFrom: el.renamedFrom,
      };

      if (el.kind === "ui") {
        const persona = el.persona ?? personas[0] ?? DEFAULT_PERSONA;
        if (!personas.includes(persona)) personas.push(persona);
        element.persona = persona;
      } else if (el.kind === "event") {
        const context = el.context ?? contexts[0] ?? DEFAULT_CONTEXT;
        if (!contexts.includes(context)) contexts.push(context);
        element.context = context;
      } else if (AUTOMATION_KINDS.has(el.kind)) {
        hasAutomation = true;
      }

      if (element.kind === "view") {
        const lkey = normalizeName(element.name);
        const first = firstViewIdByName.get(lkey);
        element.logicalId = first ?? element.id;
        if (!first) firstViewIdByName.set(lkey, element.id);
      } else {
        element.logicalId = element.id;
      }
      slice.elements.push(element);
      elements.push(element);
      byId.set(element.id, element);
      const key = normalizeName(element.name);
      const bucket = byName.get(key);
      if (bucket) bucket.push(element);
      else byName.set(key, [element]);
    }

    slices.push(slice);
  });

  if (personas.length === 0) personas.push(DEFAULT_PERSONA);
  if (contexts.length === 0) contexts.push(DEFAULT_CONTEXT);

  const arrows: ResolvedArrow[] = ast.arrows.map((a) => ({
    from: a.from,
    to: a.to,
    fromId: resolveByName(byName, a.from),
    toId: resolveByName(byName, a.to),
    line: a.line,
  }));

  return {
    name: ast.name,
    personas,
    contexts,
    hasAutomation,
    slices,
    elements,
    byId,
    byName,
    arrows,
    types,
    typesByName,
  };
}

/**
 * Resolve a field's raw type string to a declared type, when it names one — bare (`Name`) or
 * as an array (`Name[]`), matched case/whitespace-insensitively via `normalizeName`. Every
 * other type string (`Money`, `UUID`, `List<LineItem>`, anything undeclared) resolves to
 * `null` and stays exactly as free-text/unchecked as it is today — there is no primitive
 * whitelist, only opportunistic resolution against whatever `type` blocks the model declares.
 * Shared by `validate.ts` (cycle detection) and `emit/json.ts` (`typeRef` export).
 */
export function resolveTypeRef(
  typeStr: string | undefined,
  typesByName: Map<string, TypeDecl>,
): TypeRef | null {
  if (!typeStr) return null;
  const trimmed = typeStr.trim();
  const array = trimmed.endsWith("[]");
  const base = (array ? trimmed.slice(0, -2) : trimmed).trim();
  if (!base) return null;
  const typeDecl = typesByName.get(normalizeName(base));
  return typeDecl ? { typeDecl, array } : null;
}

/** Resolve an arrow endpoint (given by display name) to an element id. */
export function resolveByName(
  byName: Map<string, Element[]>,
  name: string,
): string | undefined {
  const bucket = byName.get(normalizeName(name));
  return bucket && bucket.length > 0 ? bucket[0].id : undefined;
}