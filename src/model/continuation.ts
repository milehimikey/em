// SPDX-License-Identifier: MIT
// MIL-208: a `view X again` instance is a continuation of the slice that first declared that
// view — one read model, fed by more than one event over the timeline — not a spec unit of its
// own. This module is the single predicate + resolution every consumer (docJoin, export,
// status, coverage, slice index, the ratify family, `slice new --wire`, catalog, the render
// status legend) shares, so "what counts as a continuation slice" and "whose doc does it
// borrow" are never re-derived twice. See docs/slice-doc-schema.md's "Continuations" section
// and the implement contract §5 for the resulting authoring rule (one read model = one doc =
// one PR).
//
// This is the RAW structural predicate — purely a fact about the model's shape (an again-view-
// only slice), independent of whether a doc actually exists. "Legacy own doc wins" (a
// continuation slice that still carries its own note-bound doc, or a stray `slices/<key>.md`
// file, keeps today's behavior — see docJoin.ts/rules.ts) is layered on TOP of this predicate
// by each consumer, never folded in here: this module has no filesystem access and no opinion
// about docs at all.

import { NormalizedModel } from "./model.js";
import { RefsResult } from "./refs.js";

export interface ContinuationInfo {
  /** Export key of the slice holding the originating (first) declaration of the repeated view. */
  sliceKey: string;
  /** Index into `model.slices` of that originating slice. */
  sliceIndex: number;
  /** `Element.logicalId` of the view this continuation instance repeats — also the originating
   *  view element's own `id` (the first instance's id and logicalId are always equal). */
  viewLogicalId: string;
}

/**
 * A slice at `sliceIndex` is a continuation iff every non-`ui` element it declares is a `view`
 * with `again === true`, and it declares at least one element at all. Anything else (a command,
 * event, processor, translation, or a plain non-`again` view alongside or instead) makes it an
 * ordinary slice — returns `null`. `ui` elements are ignored for the predicate: a continuation
 * slice may still carry a UI wireframe/screen note alongside its repeated view.
 *
 * When a slice declares more than one `again` view (unusual, but not forbidden by the grammar),
 * the FIRST in declaration order decides the resolution — a slice can only be a continuation of
 * one originating slice, and document order is the only deterministic tie-break available.
 */
export function continuationOf(model: NormalizedModel, refs: RefsResult, sliceIndex: number): ContinuationInfo | null {
  const slice = model.slices[sliceIndex];
  const nonUi = slice.elements.filter((el) => el.kind !== "ui");
  if (nonUi.length === 0) return null;
  if (!nonUi.every((el) => el.kind === "view" && el.again === true)) return null;

  // Guaranteed to exist: `every` above already established every entry is a `view` with
  // `again === true`, and `nonUi.length > 0`.
  const firstAgainView = nonUi[0];

  const originating = model.byId.get(firstAgainView.logicalId);
  if (!originating) return null; // defensive — logicalId always resolves in a normalized model
  if (originating.sliceIndex === sliceIndex) return null; // an again on its own first declaration is a model error (view-again-without-earlier) elsewhere, not a continuation here

  return {
    sliceKey: refs.sliceKeys[originating.sliceIndex],
    sliceIndex: originating.sliceIndex,
    viewLogicalId: firstAgainView.logicalId,
  };
}
