// SPDX-License-Identifier: MIT
// Abstract syntax tree produced by the parser.

export type ElementKind =
  | "ui"
  | "command"
  | "view"
  | "event"
  | "automation"
  | "processor"
  | "saga"
  | "translation";

/** Element keywords that live in the automation band (top). */
export const AUTOMATION_KINDS: ReadonlySet<ElementKind> = new Set([
  "automation",
  "processor",
  "saga",
  "translation",
]);

/** A data attribute on an element, e.g. `total: Money`. */
export interface Field {
  name: string;
  /** Optional type annotation after a `:`. */
  type?: string;
  /** Trailing `tag` clause on the field line (event fields only): marks this field as an
   *  identity tag — the tag key defaults to the field's own name. Merged with any
   *  element-level `tag` clauses (`ElementNode.tags`) at export time via `model/model.ts`'s
   *  `collectTags`, rather than normalized into that array here — keeps the field's own
   *  `tag` flag visible right next to the field it marks. */
  tag?: boolean;
  /** Trailing `renamed from "Old1", "Old2"` clause on the field line (event/command fields
   *  only, MIL-68): the prior name(s) this field was known as, most-recent-first, for
   *  payload-conversion codegen at handling time. `undefined` when absent — a declared
   *  type's fields can never carry this clause (it can't parse there), so they always export
   *  it as `null` (see `emit/json.ts`'s `fieldExport`). Purely export/codegen metadata —
   *  `em diff` still reports a rename as remove+add (see `ElementNode.renamedFrom`). */
  renamedFrom?: string[];
  /** Trailing `assigned` clause on the field line (event fields only, MIL-148): marks this
   *  field as system-assigned — set by the server/handler, never supplied by a triggering
   *  command — so `fields-completeness/event-field-no-source` never checks it against the
   *  slice's commands. Still visible to view↔event field tracing; the marker only narrows
   *  the event↔command completeness check, not the view-facing one. */
  assigned?: boolean;
}

/** Kind of an element-level `tag` clause (`ElementNode.tags`) — the inline field `tag` (identity)
 *  isn't one of these; it lives on `Field.tag` instead and is merged in only at export/validate
 *  time (see `model/model.ts`'s `collectTags`). */
export type TagClauseKind = "composite" | "external";

/** An element-level `tag` clause — `tag <key> from a, b` (composite) or
 *  `tag <key> external "text"` (external). Events only (MIL-66). Declared either as a
 *  trailing clause on the element (same family as `note`/`issue`, via `extractClauses`) or as
 *  one or more standalone `tag ...` lines immediately following the event inside a slice body.
 *  Multiple accumulate, in declaration order. */
export interface TagClause {
  /** The declared tag key (bare identifier, unquoted). */
  key: string;
  kind: TagClauseKind;
  /** composite only: the ≥2 field names forming this tag key, in declaration order. */
  fields?: string[];
  /** external only: free-text documentation of how this tag would be computed — never parsed. */
  description?: string;
  line: number;
}

export interface ElementNode {
  kind: ElementKind;
  name: string;
  /** @Persona tag — only meaningful for `ui`. */
  persona?: string;
  /** @Context tag — only meaningful for `event`. */
  context?: string;
  /** `from "Event", "Event2"` — only meaningful for `view`. */
  from?: string[];
  /** `note "path.md"` — markdown file holding this element's notes. */
  note?: string;
  /** `issue "text"` — an open question, flagged red on the diagram until resolved. */
  issue?: string;
  /** `divergence "text"` — a reasoned, ratified deviation between this element and its
   *  implementation. Distinct from `issue`: this is the *resolved* state (lint-suppression-
   *  with-rationale for conformance), not an open question. */
  divergence?: string;
  /** Data attributes declared in a `{ … }` block on the element. */
  fields?: Field[];
  /** view-only: a later timeline instance of an already-declared read model. */
  again?: boolean;
  /** `public` — event or view: marks this element as part of the published integration
   *  surface (an event as a contract, a view as a public read API's response shape), as
   *  opposed to an internal-only fact or read model. */
  public?: boolean;
  /** Element-level `tag` clauses (composite/external) — events only. `undefined`/absent when
   *  none are declared; inline field identity tags live on `Field.tag` instead, not here. */
  tags?: TagClause[];
  /** `renamed from "Old1", "Old2"` on the element's own name — event or command only (MIL-68):
   *  the prior name(s) this element was known as, most-recent-first. Codegen/export metadata
   *  for payload conversion — `em diff` deliberately does NOT infer a rename from this (stays
   *  remove+add, no-inference philosophy); this is purely additive metadata a consumer opts
   *  into reading. `undefined` when absent. */
  renamedFrom?: string[];
  line: number;
}

export interface SliceNode {
  name: string;
  /** `source "url"` — link to the ticket/conversation this slice traces back to. */
  source?: string;
  elements: ElementNode[];
  line: number;
}

export interface ArrowNode {
  from: string;
  to: string;
  line: number;
}

/** A named, reusable structured type, e.g. `type Money { amount: int, currency: String }`.
 *  Declared at top level; referenced from any field's type string elsewhere in the model
 *  (bare = nested object, `Name[]` = array of it). Supports no clauses in v1 — just a name
 *  and a `{ fields }` block. */
export interface TypeDeclNode {
  name: string;
  fields: Field[];
  line: number;
}

export interface ModelNode {
  name: string;
  /** True when the source declared `model "Name"`; false when `name` is the parser's default
   *  title. The distinction matters to `model/qualifiedRef.ts` (MIL-193), whose model key is the
   *  slugged declared name — an undeclared name must not become a key. */
  nameDeclared: boolean;
  /** Declared persona lanes, in order. */
  personas: string[];
  /** Declared context/concept lanes, in order. */
  contexts: string[];
  slices: SliceNode[];
  /** Explicit top-level arrows (e.g. read-model feedback to a UI). */
  arrows: ArrowNode[];
  /** Named structured type declarations, in document order. */
  types: TypeDeclNode[];
}