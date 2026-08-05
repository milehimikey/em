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
  /** `public` — event-only: marks this event as part of the published integration
   *  surface, as opposed to an internal-only fact. */
  public?: boolean;
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