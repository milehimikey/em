// SPDX-License-Identifier: MIT
// GH #536: the unit graph `em engagement plan --json` publishes for a model whose code is in
// more than one place.
//
// The engagement's own word for a Ledger row is "slice" (one slice doc; engagement.ts's
// `UnitIndex` folds continuation and `covers:`-bound slices into it). A **work unit** is finer:
// one slice's elements in ONE repository — slice × repo. It is what gets a worktree, a branch,
// an implementer and a pull request. A slice whose code is all in one repository has one work
// unit; a State Change slice with its `ui` in the frontend repository and its command in a
// service's has two.
//
// em derives this graph and publishes it. It does not store it, schedule it, or hold claims on
// it: whatever drives the work (the engagement skill's lead, an external harness, a ticket
// queue) owns those. Two relations are the whole vocabulary:
//   - `partOf`: a node belongs to a slice. A slice is done when all its nodes are.
//   - `dependsOn`: a node must wait for others.
// Nodes sharing a `partOf` are siblings and need no edge between them.
//
// Each slice also gets one **closing step**, in the model's repository: it waits on every work
// unit of the slice, writes the binding entries their implementers handed back, and records the
// slice as implemented. It is a node like any other, so any harness can schedule it.
//
// Ordering inside a slice: its work units build in parallel, each against the generated contract.
// Only a slice with no `public` element has no contract to build against, and then the units
// that merely call (a `ui`, a reaction) wait for the units that provide (a command, an event, a
// view).

import { Element, NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { computeModelKey } from "../model/qualifiedRef.js";
import { SELF_REPO_ID } from "../system/manifest.js";
import { ModelPlaces } from "../codemap/modelPlaces.js";

/** The line every unit's pull request carries in its body, so a slice's set of pull requests can
 *  be recovered from the forge alone: `Em-Unit: <modelKey>:<sliceKey>@<repo>`. */
export const UNIT_MARKER_PREFIX = "Em-Unit:";

export interface EngagementPlanUnit {
  /** `<sliceKey>@<repo>` for a work unit, `close:<sliceKey>` for a slice's closing step. Stable
   *  across runs: it is derived from the slice key and the repo id alone. */
  id: string;
  kind: "unit" | "close";
  /** The engagement slice (Ledger row) this node belongs to. */
  partOf: string;
  /** The repo id the work happens in; `self` (the model's repository) for a closing step. */
  repo: string;
  /** The roots, inside `repo`, this unit's elements are placed under; `[]` for a closing step.
   *  `""` is the repository root. */
  roots: string[];
  /** Export refs of the slice's elements this unit builds; `[]` for a closing step. */
  elements: string[];
  /** The slice's level in the plan. */
  level: number;
  /** The branch to cut, in `repo`. The same name in every repository a slice touches: together
   *  with `marker` it is the join key. */
  branch: string;
  /** Always `main`: unit pull requests never stack. */
  base: string;
  prTitle: string;
  /** The exact line to put in the pull request body. */
  marker: string;
  /** Ids of the nodes this one waits for. */
  dependsOn: string[];
  /** GH #537: where the node stands. A work unit's Ledger state (its own record, or the slice's
   *  when the slice is one unit); a closing step is `merged` once the slice doc records the
   *  slice as shipped, `planned` until then. Set by the plan, not by `deriveUnits`. */
  state?: string;
  /** GH #537: the unit's recorded pull request URL; `null` when none, and for a closing step. */
  pr?: string | null;
}

export interface UnitSliceInput {
  key: string;
  level: number;
  branch: string;
  base: string;
  prTitle: string;
}

/** `<sliceKey>@<repo>`. Slice keys and repo ids cannot contain `@`. */
export function unitId(sliceKey: string, repo: string): string {
  return `${sliceKey}@${repo}`;
}

export function closingStepId(sliceKey: string): string {
  return `close:${sliceKey}`;
}

/** The pull-request body line for a unit of `model` (see `UNIT_MARKER_PREFIX`). */
export function unitMarker(modelKey: string, sliceKey: string, repo: string): string {
  return `${UNIT_MARKER_PREFIX} ${modelKey}:${unitId(sliceKey, repo)}`;
}

/**
 * The work units and closing steps of the given engagement slices, slice by slice in the order
 * given, each slice's work units in first-appearance order of their repo, then its closing step.
 * `elementsOf` returns every element that belongs to a slice (continuations folded in).
 * An element the code map does not place belongs to no unit; `unplaced` lists those, per slice.
 */
export function deriveUnits(
  model: NormalizedModel,
  refs: RefsResult,
  modelFile: string,
  places: Extract<ModelPlaces, { kind: "ok" }>,
  slices: readonly UnitSliceInput[],
  elementsOf: (sliceKey: string) => Element[],
): { units: EngagementPlanUnit[]; unplaced: { slice: string; refs: string[] }[] } {
  const modelKey = computeModelKey(model, modelFile);
  const units: EngagementPlanUnit[] = [];
  const unplaced: { slice: string; refs: string[] }[] = [];

  for (const slice of slices) {
    const elements = elementsOf(slice.key);
    const byRepo = new Map<string, { roots: string[]; elements: Element[] }>();
    const missing: string[] = [];
    for (const el of elements) {
      const ref = refs.refById.get(el.id)!;
      const at = places.placement.byRef.get(ref)?.places ?? [];
      if (at.length === 0) {
        missing.push(ref);
        continue;
      }
      for (const place of at) {
        const unit = byRepo.get(place.repo) ?? { roots: [], elements: [] };
        if (!unit.roots.includes(place.root)) unit.roots.push(place.root);
        if (!unit.elements.includes(el)) unit.elements.push(el);
        byRepo.set(place.repo, unit);
      }
    }
    if (missing.length > 0) unplaced.push({ slice: slice.key, refs: missing });

    // No contract to build against: callers wait for providers.
    const hasContract = elements.some((el) => el.public === true);
    const provides = (els: Element[]): boolean => els.some((el) => el.kind === "command" || el.kind === "event" || el.kind === "view");
    const providers = [...byRepo.entries()].filter(([, u]) => provides(u.elements)).map(([repo]) => unitId(slice.key, repo));

    const ids: string[] = [];
    for (const [repo, unit] of byRepo) {
      const id = unitId(slice.key, repo);
      ids.push(id);
      units.push({
        id,
        kind: "unit",
        partOf: slice.key,
        repo,
        roots: unit.roots,
        elements: unit.elements.map((el) => refs.refById.get(el.id)!),
        level: slice.level,
        branch: slice.branch,
        base: slice.base,
        prTitle: slice.prTitle,
        marker: unitMarker(modelKey, slice.key, repo),
        dependsOn: hasContract || provides(unit.elements) ? [] : providers.filter((p) => p !== id),
      });
    }
    units.push({
      id: closingStepId(slice.key),
      kind: "close",
      partOf: slice.key,
      repo: SELF_REPO_ID,
      roots: [],
      elements: [],
      level: slice.level,
      branch: `close/${slice.key}`,
      base: slice.base,
      prTitle: `${slice.prTitle} [close]`,
      marker: unitMarker(modelKey, slice.key, "close"),
      dependsOn: ids,
    });
  }
  return { units, unplaced };
}
