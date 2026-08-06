// SPDX-License-Identifier: MIT
// Cross-model glossary for `em glossary`: aggregates the terms declared across
// N independently-compiled models (element names, field names, personas,
// contexts) and flags conflicting usage of the same normalized term. Simpler
// than diff.ts: glossary aggregates occurrences of a name across independent
// models, so it never needs computeRefs()'s edit-stable ref/slot-matching
// scheme (that's for correlating old-vs-new of the *same* model).

import { ElementKind } from "../parser/ast.js";
import { NormalizedModel, normalizeName } from "./model.js";

export interface GlossaryModelInput {
  /** File path (or other label) as given on the command line — this command's
   *  only cross-file identity, same convention as em diff's DiffSide.label. */
  label: string;
  model: NormalizedModel;
}

interface Occurrence {
  model: string;
}

interface ElementOccurrence extends Occurrence {
  kind: ElementKind;
  line: number;
  sliceName: string;
}

interface FieldOccurrence extends Occurrence {
  elementKind: ElementKind;
  elementName: string;
  type: string | null;
  line: number;
  sliceName: string;
}

/** One normalized term and every place it was declared/used, across all input models. */
export interface GlossaryTerm<O extends Occurrence = Occurrence> {
  key: string;
  /** First-seen display name (first model, first occurrence). */
  name: string;
  occurrences: O[];
}

export interface Glossary {
  /** Input labels, argument order. */
  models: string[];
  /** Element names, sorted by normalized key. */
  elements: GlossaryTerm<ElementOccurrence>[];
  /** Field names — a global namespace across every element/model, not qualified
   *  by owning element, matching validate.ts's own field-name-union convention. */
  fields: GlossaryTerm<FieldOccurrence>[];
  personas: GlossaryTerm[];
  contexts: GlossaryTerm[];
}

export type GlossaryConflictType = "kind-conflict" | "field-type-conflict";

/** A term used inconsistently across ≥2 models. Not a `Diagnostic`: a cross-model
 *  finding needs to carry which model each conflicting occurrence came from, which
 *  `Diagnostic`'s `{severity, message, line}` has no room for — same reasoning that
 *  gives `em diff` its own `ChangeEntry` instead of reusing `Diagnostic`. */
export interface GlossaryConflict {
  type: GlossaryConflictType;
  term: string;
  occurrences: (ElementOccurrence | FieldOccurrence)[];
}

function collectTerms<O extends Occurrence>(entries: { name: string; occurrence: O }[]): GlossaryTerm<O>[] {
  const byKey = new Map<string, GlossaryTerm<O>>();
  for (const { name, occurrence } of entries) {
    const key = normalizeName(name);
    let term = byKey.get(key);
    if (!term) {
      term = { key, name, occurrences: [] };
      byKey.set(key, term);
    }
    term.occurrences.push(occurrence);
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Build the glossary: walk every input model's elements/fields/personas/contexts. */
export function buildGlossary(inputs: GlossaryModelInput[]): Glossary {
  const elementEntries: { name: string; occurrence: ElementOccurrence }[] = [];
  const fieldEntries: { name: string; occurrence: FieldOccurrence }[] = [];
  const personaEntries: { name: string; occurrence: Occurrence }[] = [];
  const contextEntries: { name: string; occurrence: Occurrence }[] = [];

  for (const { label, model } of inputs) {
    for (const el of model.elements) {
      const sliceName = model.slices[el.sliceIndex].name;
      elementEntries.push({
        name: el.name,
        occurrence: { model: label, kind: el.kind, line: el.line, sliceName },
      });
      for (const f of el.fields ?? []) {
        fieldEntries.push({
          name: f.name,
          occurrence: {
            model: label,
            elementKind: el.kind,
            elementName: el.name,
            type: f.type ?? null,
            line: el.line,
            sliceName,
          },
        });
      }
    }

    // Dedup personas/contexts per-model by normalized key before recording an
    // occurrence: model.ts's own persona/context arrays dedupe by case-sensitive
    // `Array.includes`, not `normalizeName` — without this, e.g. "Order" and
    // "order" both declared in one model would fabricate two occurrences of what
    // should be a single per-model occurrence. Casing conflicts are out of v1
    // scope, but this keeps them from silently inflating cross-model conflicts.
    const seenPersonas = new Set<string>();
    for (const p of model.personas) {
      const key = normalizeName(p);
      if (seenPersonas.has(key)) continue;
      seenPersonas.add(key);
      personaEntries.push({ name: p, occurrence: { model: label } });
    }
    const seenContexts = new Set<string>();
    for (const c of model.contexts) {
      const key = normalizeName(c);
      if (seenContexts.has(key)) continue;
      seenContexts.add(key);
      contextEntries.push({ name: c, occurrence: { model: label } });
    }
  }

  return {
    models: inputs.map((i) => i.label),
    elements: collectTerms(elementEntries),
    fields: collectTerms(fieldEntries),
    personas: collectTerms(personaEntries),
    contexts: collectTerms(contextEntries),
  };
}

/** Same term, different element `kind`, across ≥2 distinct models. Requiring ≥2
 *  distinct models keeps this non-overlapping with validate.ts's existing
 *  single-model "ambiguous names" check (a name defined >1 time in one file). */
export function detectKindConflicts(glossary: Glossary): GlossaryConflict[] {
  const conflicts: GlossaryConflict[] = [];
  for (const term of glossary.elements) {
    const models = new Set(term.occurrences.map((o) => o.model));
    const kinds = new Set(term.occurrences.map((o) => o.kind));
    if (models.size > 1 && kinds.size > 1) {
      conflicts.push({ type: "kind-conflict", term: term.name, occurrences: term.occurrences });
    }
  }
  return conflicts;
}

/** Same field name, different `type` (or typed vs. untyped), across ≥2 distinct models. */
export function detectFieldTypeConflicts(glossary: Glossary): GlossaryConflict[] {
  const conflicts: GlossaryConflict[] = [];
  for (const term of glossary.fields) {
    const models = new Set(term.occurrences.map((o) => o.model));
    const types = new Set(term.occurrences.map((o) => o.type));
    if (models.size > 1 && types.size > 1) {
      conflicts.push({ type: "field-type-conflict", term: term.name, occurrences: term.occurrences });
    }
  }
  return conflicts;
}

export function hasConflicts(conflicts: GlossaryConflict[]): boolean {
  return conflicts.length > 0;
}

function typeLabel(t: string | null): string {
  return t ?? "(untyped)";
}

/** One formatted conflict line, e.g.:
 *  `kind-conflict "Order": event in checkout.em:12 (slice "Submit Order"), view in billing.em:5 (slice "Show Orders")` */
export function formatConflictLine(c: GlossaryConflict): string {
  if (c.type === "kind-conflict") {
    const els = c.occurrences as ElementOccurrence[];
    const parts = els.map((o) => `${o.kind} in ${o.model}:${o.line} (slice "${o.sliceName}")`).join(", ");
    return `kind-conflict "${c.term}": ${parts}`;
  }
  const flds = c.occurrences as FieldOccurrence[];
  const parts = flds
    .map((o) => `${typeLabel(o.type)} on ${o.elementKind} "${o.elementName}" in ${o.model}:${o.line}`)
    .join(", ");
  return `field-type-conflict "${c.term}": ${parts}`;
}

/** Full `em glossary` default report: scale summary line, then either every conflict
 *  line or "no conflicts" — conflicts are this command's "diagnostics," the same role
 *  `Diagnostic[]` plays for `em validate`. */
export function formatGlossarySummary(glossary: Glossary, conflicts: GlossaryConflict[]): string {
  const termCount =
    glossary.elements.length + glossary.fields.length + glossary.personas.length + glossary.contexts.length;
  const modelWord = glossary.models.length === 1 ? "model" : "models";
  const termWord = termCount === 1 ? "term" : "terms";
  const conflictWord = conflicts.length === 1 ? "conflict" : "conflicts";
  const header = `${glossary.models.length} ${modelWord}, ${termCount} ${termWord}, ${conflicts.length} ${conflictWord}`;
  const body = conflicts.length === 0 ? "no conflicts" : conflicts.map(formatConflictLine).join("\n");
  return `${header}\n\n${body}`;
}
