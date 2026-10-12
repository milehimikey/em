// SPDX-License-Identifier: MIT
// GH #237: the one resolver behind every `<slice-key>` CLI argument (`em validate --slice-ready`,
// `em export --slice`, `em coverage --slice`, the `em slice` verbs, `em engagement new --slices`
// and `em engagement set`). It sits next to the export-key derivation (refs.ts's `kebabSlug(slice.name)`
// + dedupe) and never re-derives a key: it only maps what a person typed onto an existing
// `refs.sliceKeys` entry. Input-side only — everything em writes keeps the canonical export key.

import { NormalizedModel } from "./model.js";
import type { RefsResult } from "./refs.js";
import { kebabSlug } from "../util/slug.js";

export type ResolvedSlice = { ok: true; key: string; index: number } | { ok: false; message: string };

/** Above this many slices an unknown key prints the nearest few instead of the whole list. */
const LIST_ALL_LIMIT = 20;
const NEAREST = 3;

const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Resolution order: exact export key; exact display name (case-insensitive, whitespace-
 * normalized); a unique prefix of an export key or a display name (the input's kebab form counts
 * as a candidate too, so `ORD-0001` finds `ord-0001-place-order`); an ambiguous prefix lists the
 * candidates; anything else is unknown and prints the valid keys (or the nearest few on a model
 * with more than 20 slices). The unknown message opens with the historic
 * `no slice with export key "<input>" in this model`.
 */
export function resolveSliceKey(model: NormalizedModel, refs: RefsResult, input: string): ResolvedSlice {
  const exact = refs.sliceKeys.indexOf(input);
  if (exact !== -1) return { ok: true, key: input, index: exact };

  const wanted = norm(input);
  const names = model.slices.map((s) => norm(s.name));
  const byName = names.flatMap((n, i) => (n === wanted ? [i] : []));
  if (byName.length === 1) return { ok: true, key: refs.sliceKeys[byName[0]], index: byName[0] };
  if (byName.length > 1) return ambiguous(refs, input, byName);

  const kebab = /[a-z0-9]/.test(wanted) ? kebabSlug(input) : "";
  if (kebab !== "") {
    const hits: number[] = [];
    refs.sliceKeys.forEach((key, i) => {
      if (key.startsWith(wanted) || key.startsWith(kebab) || names[i].startsWith(wanted)) hits.push(i);
    });
    if (hits.length === 1) return { ok: true, key: refs.sliceKeys[hits[0]], index: hits[0] };
    if (hits.length > 1) return ambiguous(refs, input, hits);
  }

  const head = `no slice with export key "${input}" in this model`;
  if (refs.sliceKeys.length === 0) return { ok: false, message: `${head} (the model has no slices)` };
  if (refs.sliceKeys.length <= LIST_ALL_LIMIT) return { ok: false, message: `${head} — valid keys: ${refs.sliceKeys.join(", ")}` };
  const nearest = refs.sliceKeys
    .map((key, i) => ({ key, d: Math.min(editDistance(kebab || wanted, key), editDistance(wanted, names[i])) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, NEAREST)
    .map((c) => c.key);
  return { ok: false, message: `${head} — did you mean ${nearest.join(", ")}?` };
}

function ambiguous(refs: RefsResult, input: string, indices: number[]): ResolvedSlice {
  return { ok: false, message: `slice "${input}" is ambiguous — it matches ${indices.map((i) => refs.sliceKeys[i]).join(", ")}` };
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}
