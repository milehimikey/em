// SPDX-License-Identifier: MIT
// The timeline a model's storylines compose (GH #277). File order is the one timeline a model
// has always had; a `storyline "Name" after "Other" { … }` block is read as if its slices
// followed the last slice of `Other` (owner ruling on Law 2: "you can't go backward in a
// story"). Every forward-only check (`view-from-future-event`, `reaction-from-future-view`,
// `arrow-backward`, `loops-to-forward`) and every `from`/`again` resolution asks THIS module
// which of two slices is earlier, instead of comparing `sliceIndex` directly, so the composed
// timeline is one definition. A model with no `after` clause gets exactly the file-order answers
// it always did.

import { Storyline, NormalizedModel, normalizeName } from "./model.js";

export type TimelineRelation = "before" | "same" | "after";

interface StorylineIndex {
  byKey: Map<string, Storyline>;
  /** storyline name -> the storylines it comes after, root first, nearest last. Empty when it
   *  declares no `after`, names an unknown storyline, or sits on a cycle (validate reports it). */
  chain: Map<string, Storyline[]>;
}

const cache = new WeakMap<NormalizedModel, StorylineIndex>();

function indexOf(model: NormalizedModel): StorylineIndex {
  const hit = cache.get(model);
  if (hit) return hit;
  const storylines = model.storylines ?? [];
  const byKey = new Map<string, Storyline>();
  for (const st of storylines) {
    const key = normalizeName(st.name);
    if (!byKey.has(key)) byKey.set(key, st);
  }
  const chain = new Map<string, Storyline[]>();
  for (const st of storylines) {
    const preds: Storyline[] = [];
    const seen = new Set<Storyline>([st]);
    let cur: Storyline | undefined = st;
    let cyclic = false;
    while (cur && cur.after !== undefined) {
      const next = byKey.get(normalizeName(cur.after));
      if (!next) break;
      if (seen.has(next)) {
        cyclic = true;
        break;
      }
      seen.add(next);
      preds.unshift(next);
      cur = next;
    }
    chain.set(st.name, cyclic ? [] : preds);
  }
  const index = { byKey, chain };
  cache.set(model, index);
  return index;
}

/** The storyline a slice was declared in, if any. */
export function storylineOfSlice(model: NormalizedModel, sliceIndex: number): Storyline | undefined {
  const name = model.slices[sliceIndex]?.storyline;
  return name === undefined ? undefined : indexOf(model).byKey.get(normalizeName(name));
}

/** Storyline lookup by (case/whitespace-insensitive) name. */
export function findStoryline(model: NormalizedModel, name: string): Storyline | undefined {
  return indexOf(model).byKey.get(normalizeName(name));
}

/** The storylines `storyline` comes after, transitively: root first, the directly referenced one
 *  last. `[]` when it has no (valid) `after`. */
export function afterChain(model: NormalizedModel, storyline: Storyline): Storyline[] {
  return indexOf(model).chain.get(storyline.name) ?? [];
}

/** Whether `a` and `b` are in an `after` relationship, and which way. */
function storylineRelation(model: NormalizedModel, a: Storyline, b: Storyline): TimelineRelation | undefined {
  if (a === b) return "same";
  if (afterChain(model, a).includes(b)) return "after"; // a comes after b
  if (afterChain(model, b).includes(a)) return "before";
  return undefined;
}

/**
 * Where slice `target` sits on the timeline relative to slice `viewer`: "before" (strictly
 * earlier), "same" (the same slice) or "after" (strictly later). Two slices of storylines in an
 * `after` relationship are ordered by that relationship, whatever their file positions; every
 * other pair is ordered by file order (slice index).
 */
export function relationOnTimeline(model: NormalizedModel, target: number, viewer: number): TimelineRelation {
  if (target === viewer) return "same";
  const st = storylineOfSlice(model, target);
  const sv = storylineOfSlice(model, viewer);
  if (st && sv) {
    const rel = storylineRelation(model, st, sv);
    if (rel === "after") return "after";
    if (rel === "before") return "before";
  }
  return target < viewer ? "before" : "after";
}

/** True when `target` is strictly later than `viewer` on the timeline. */
export function isLaterOnTimeline(model: NormalizedModel, target: number, viewer: number): boolean {
  return relationOnTimeline(model, target, viewer) === "after";
}

/** True when `target` is strictly earlier than `viewer` on the timeline. */
export function isEarlierOnTimeline(model: NormalizedModel, target: number, viewer: number): boolean {
  return relationOnTimeline(model, target, viewer) === "before";
}

/**
 * The candidate that is the latest at-or-before `viewer` on the timeline (strict: `strict` drops
 * the viewer's own slice). A viewer inside a storyline that declares `after` prefers, in order:
 * a candidate in its own storyline, then one in the storylines it comes after (nearest
 * referenced storyline first, latest slice within it), then anything else by file order — so
 * `from`/`again` resolve against the referenced storyline's end state, not whatever view a
 * sibling storyline left in between. Any other viewer gets plain file order.
 */
export function latestOnTimeline<T extends { sliceIndex: number }>(
  model: NormalizedModel,
  candidates: T[],
  viewer: number,
  strict = false,
): T | undefined {
  const visible = candidates.filter((c) => {
    const rel = relationOnTimeline(model, c.sliceIndex, viewer);
    return rel === "before" || (!strict && rel === "same");
  });
  if (visible.length === 0) return undefined;
  const own = storylineOfSlice(model, viewer);
  const chain = own ? afterChain(model, own) : [];
  const rank = (c: T): [number, number, number] => {
    if (chain.length === 0) return [0, 0, c.sliceIndex];
    const st = storylineOfSlice(model, c.sliceIndex);
    if (st === own) return [2, 0, c.sliceIndex];
    const pos = st ? chain.indexOf(st) : -1;
    if (pos >= 0) return [1, pos, c.sliceIndex];
    return [0, 0, c.sliceIndex];
  };
  return visible.reduce((best, c) => {
    const a = rank(best);
    const b = rank(c);
    for (let i = 0; i < 3; i++) {
      if (b[i] !== a[i]) return b[i] > a[i] ? c : best;
    }
    return best;
  });
}

/** True when the flow `source -> target` points left in the full-model render (file order) even
 *  though the composed timeline reads it forward — a storyline declared `after` another that
 *  sits lower in the file. The one case where composing the timeline would let an arrow point
 *  right-to-left, which is an error rather than a special render. */
export function composedButRenderedBackward(model: NormalizedModel, source: number, target: number): boolean {
  return source > target && relationOnTimeline(model, source, target) === "before";
}

/** Declaration index of the storyline a slice belongs to, or -1 for a slice outside any. */
export function storylineIndexOfSlice(model: NormalizedModel, sliceIndex: number): number {
  const st = storylineOfSlice(model, sliceIndex);
  return st ? (model.storylines ?? []).indexOf(st) : -1;
}

/** One contiguous run of columns belonging to one storyline: a storyline whose slices are
 *  interleaved with others renders one band segment per run (GH #277). */
export interface StorylineRun {
  storyline: Storyline;
  /** Declaration index of the storyline (drives its colour). */
  index: number;
  fromCol: number;
  toCol: number;
}

/** The band segments of the full-model render, in column order. */
export function storylineRuns(model: NormalizedModel): StorylineRun[] {
  const runs: StorylineRun[] = [];
  const storylines = model.storylines ?? [];
  for (let c = 0; c < model.slices.length; c++) {
    const index = storylineIndexOfSlice(model, c);
    if (index < 0) continue;
    const last = runs[runs.length - 1];
    if (last && last.index === index && last.toCol === c - 1) last.toCol = c;
    else runs.push({ storyline: storylines[index], index, fromCol: c, toCol: c });
  }
  return runs;
}
