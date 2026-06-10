// SPDX-License-Identifier: MIT
// Normalizes a parsed AST into a resolved model: stable ids, resolved
// persona/context lanes, and lookup indexes used by layout and validation.

import { AUTOMATION_KINDS, ElementKind, Field, ModelNode } from "../parser/ast.js";

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
  /** Data attributes declared on the element. */
  fields?: Field[];
  sliceIndex: number;
  line: number;
}

export interface Slice {
  name: string;
  index: number;
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
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function slug(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "n";
}

export function normalize(ast: ModelNode): NormalizedModel {
  const personas = [...ast.personas];
  const contexts = [...ast.contexts];
  const slices: Slice[] = [];
  const elements: Element[] = [];
  const byId = new Map<string, Element>();
  const byName = new Map<string, Element[]>();
  const usedIds = new Set<string>();
  let hasAutomation = false;

  const makeId = (name: string): string => {
    const base = slug(name);
    let id = base;
    let n = 2;
    while (usedIds.has(id)) id = `${base}_${n++}`;
    usedIds.add(id);
    return id;
  };

  ast.slices.forEach((sliceNode, sliceIndex) => {
    const slice: Slice = {
      name: sliceNode.name,
      index: sliceIndex,
      elements: [],
      line: sliceNode.line,
    };

    for (const el of sliceNode.elements) {
      const element: Element = {
        id: makeId(el.name),
        kind: el.kind,
        name: el.name,
        sliceIndex,
        line: el.line,
        from: el.from,
        note: el.note,
        fields: el.fields,
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
  };
}

/** Resolve an arrow endpoint (given by display name) to an element id. */
export function resolveByName(
  byName: Map<string, Element[]>,
  name: string,
): string | undefined {
  const bucket = byName.get(normalizeName(name));
  return bucket && bucket.length > 0 ? bucket[0].id : undefined;
}