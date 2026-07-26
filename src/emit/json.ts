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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Element, NormalizedModel, resolveByName } from "../model/model.js";
import { Diagnostic } from "../model/validate.js";
import { dedupe, kebabSlug } from "../util/slug.js";

// Read once from package.json (two levels up from src/emit/ and dist/emit/
// alike) so `generator.version` can never drift from the released version.
// tsconfig targets NodeNext without resolveJsonModule, hence fs over import.
export const GENERATOR_NAME = "@milehimikey/em";
export const GENERATOR_VERSION: string = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"),
).version;

export const SCHEMA_VERSION = "1.0";

export interface ExportResult {
  /** Pretty-printed JSON, no trailing newline. */
  text: string;
  /** validate()'s diagnostics plus any ref-collision warnings raised while exporting. */
  diagnostics: Diagnostic[];
}

export interface RefsResult {
  /** Export key per slice, same order/index as `model.slices`. */
  sliceKeys: string[];
  /** Internal `Element.id` -> stable export `ref`. */
  refById: Map<string, string>;
  /** Ref-collision warnings raised while assigning keys/refs (duplicate names). */
  diagnostics: Diagnostic[];
}

/**
 * Assign every slice its export key (`slug(name)`) and every element its
 * export ref (`<sliceKey>/<kind>.<slug(name)>`), in document order, deduped
 * with a `~2`, `~3`, … suffix on collision. Shared by `em export` (this
 * module) and `em diff` (`src/model/diff.ts`), which both need the same
 * edit-stable identity scheme to match elements/slices across models.
 */
export function computeRefs(model: NormalizedModel): RefsResult {
  const diagnostics: Diagnostic[] = [];

  // Pass 1: assign every slice its export key and every element its export
  // ref, in document order, before resolving any cross-references. Doing
  // refs and cross-references in separate passes means a `from` or arrow
  // can point at any element regardless of declaration order within a slice.
  const usedSliceKeys = new Set<string>();
  const sliceKeys: string[] = model.slices.map((slice) => {
    const base = kebabSlug(slice.name);
    const key = dedupe(base, usedSliceKeys, "~");
    if (key !== base) {
      diagnostics.push({
        severity: "warning",
        message: `duplicate slice name "${slice.name}" (export key "${base}" already used); rename slices uniquely for stable export refs`,
        line: slice.line,
      });
    }
    return key;
  });

  const usedElementRefs = new Set<string>();
  const refById = new Map<string, string>();
  model.slices.forEach((slice, sliceIndex) => {
    const sliceKey = sliceKeys[sliceIndex];
    for (const el of slice.elements) {
      const base = `${sliceKey}/${el.kind}.${kebabSlug(el.name)}`;
      const ref = dedupe(base, usedElementRefs, "~");
      if (ref !== base) {
        diagnostics.push({
          severity: "warning",
          message: `duplicate ${el.kind} "${el.name}" in slice "${slice.name}" (export ref "${base}" already used); rename for a stable export ref`,
          line: el.line,
        });
      }
      refById.set(el.id, ref);
    }
  });

  return { sliceKeys, refById, diagnostics };
}

/** Build the `em export` document for an already-validated (error-free) model. */
export function buildExport(
  model: NormalizedModel,
  diagnostics: Diagnostic[],
  source: string,
  path: string,
): ExportResult {
  const { sliceKeys, refById, diagnostics: extra } = computeRefs(model);

  const refOf = (id: string | undefined): string | null =>
    id ? refById.get(id) ?? null : null;

  const fromOf = (el: Element): { name: string; ref: string | null }[] | null => {
    if (!el.from || el.from.length === 0) return null;
    return el.from.map((name) => ({ name, ref: refOf(resolveByName(model.byName, name)) }));
  };

  const doc = {
    schemaVersion: SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    source: { path, sha256: createHash("sha256").update(source, "utf8").digest("hex") },
    model: {
      name: model.name,
      personas: model.personas,
      contexts: model.contexts,
      hasAutomation: model.hasAutomation,
      slices: model.slices.map((slice, sliceIndex) => ({
        key: sliceKeys[sliceIndex],
        name: slice.name,
        index: slice.index,
        line: slice.line,
        elements: slice.elements.map((el) => ({
          ref: refById.get(el.id)!,
          kind: el.kind,
          name: el.name,
          line: el.line,
          fields: el.fields ? el.fields.map((f) => ({ name: f.name, type: f.type ?? null })) : null,
          note: el.note ?? null,
          issue: el.issue ?? null,
          from: fromOf(el),
          persona: el.persona ?? null,
          context: el.context ?? null,
          again: el.again === true,
          logicalRef:
            el.kind === "view" && el.again === true ? refOf(el.logicalId) : null,
        })),
      })),
      arrows: model.arrows.map((a) => ({
        from: a.from,
        to: a.to,
        fromRef: refOf(a.fromId),
        toRef: refOf(a.toId),
        line: a.line,
      })),
    },
    diagnostics: [...diagnostics, ...extra].map((d) => ({
      severity: d.severity,
      message: d.message,
      line: d.line ?? null,
    })),
  };

  return { text: JSON.stringify(doc, null, 2), diagnostics: [...diagnostics, ...extra] };
}
