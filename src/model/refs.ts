// SPDX-License-Identifier: MIT
// Computes every export-stable identity (slice keys, element refs, type refs) for a
// normalized model — the one scheme `em export`, `em diff`, `em catalog`, and (MIL-91)
// `em validate`'s diagnostics all share so an entity's identity is never re-derived twice.
//
// Lives in model/ rather than emit/ (where it lived through MIL-78/86/90, moved here for
// MIL-91): it's a pure function of NormalizedModel — no JSON shape, no fs — and validate.ts
// now needs it too. Piling a second model-layer consumer onto an emit-owned module would be
// backwards; moving it here makes emit/json.ts, model/diff.ts, and catalog/build.ts all
// depend downward on model/, the correct direction.

import { NormalizedModel } from "./model.js";
import type { Diagnostic } from "./validate.js";
import { pushDiag } from "./rules.js";
import { dedupe, kebabSlug } from "../util/slug.js";

export interface RefsResult {
  /** Export key per slice, same order/index as `model.slices`. */
  sliceKeys: string[];
  /** Internal `Element.id` -> stable export `ref`. */
  refById: Map<string, string>;
  /** Internal `TypeDecl.id` -> stable export `ref` (`types/<slug(name)>`). */
  refByTypeId: Map<string, string>;
  /** Ref-collision warnings raised while assigning keys/refs (duplicate names). */
  diagnostics: Diagnostic[];
}

/**
 * Assign every slice its export key (`slug(name)`) and every element its export ref
 * (`<sliceKey>/<kind>.<slug(name)>`), in document order, deduped with a `~2`, `~3`, … suffix
 * on collision. Shared by `em export` (`emit/json.ts`), `em diff` (`model/diff.ts`), `em
 * catalog` (`catalog/build.ts`), and `em validate`'s diagnostics (`model/validate.ts`, via
 * `pipeline.ts`'s single per-compile call) — all of which need the same edit-stable identity
 * scheme to match elements/slices across models or tag a finding to the entity it concerns.
 * Also assigns every declared type its export ref (`types/<slug(name)>`) — types aren't
 * slice-scoped, so no sliceKey prefix, same dedup-with-warning machinery otherwise.
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
      pushDiag(diagnostics, "duplicate-slice-name", {
        message: `duplicate slice name "${slice.name}" (export key "${base}" already used); rename slices uniquely for stable export refs`,
        line: slice.line,
        refs: [key, base],
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
        pushDiag(diagnostics, "duplicate-element-ref", {
          message: `duplicate ${el.kind} "${el.name}" in slice "${slice.name}" (export ref "${base}" already used); rename for a stable export ref`,
          line: el.line,
          refs: [ref, base],
        });
      }
      refById.set(el.id, ref);
    }
  });

  const usedTypeRefs = new Set<string>();
  const refByTypeId = new Map<string, string>();
  for (const t of model.types) {
    const base = `types/${kebabSlug(t.name)}`;
    const ref = dedupe(base, usedTypeRefs, "~");
    if (ref !== base) {
      pushDiag(diagnostics, "duplicate-type-ref", {
        message: `duplicate type "${t.name}" (export ref "${base}" already used); rename for a stable export ref`,
        line: t.line,
        refs: [ref, base],
      });
    }
    refByTypeId.set(t.id, ref);
  }

  return { sliceKeys, refById, refByTypeId, diagnostics };
}
