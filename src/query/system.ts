// SPDX-License-Identifier: MIT
// `em query`'s multi-model addressing (MIL-168): a `QuerySystem` is one or more compiled
// models, each keyed by a short, stable `modelKey` derived from its input filename. Refs
// (`<sliceKey>/<kind>.<slug>`) are, and remain, model-UNQUALIFIED — `computeRefs()`'s contract
// is untouched, and `em export`'s document shape doesn't change. For a query answer that spans
// more than one input file, that's ambiguous on its own (two models can easily mint the same
// slice/element ref independently), so `em query` addresses cross-model results with a qualified
// form: `<modelKey>:<sliceKey>/<kind>.<slug>` — accepted on input alongside a bare ref/display
// name, and used to disambiguate/print results whenever more than one file was given.
//
// This is a query-only convention, decided here because query is the first surface that ever
// needs to name an element across model boundaries in one answer. It's the natural shape for
// em-portal's future deep links too, so it's called out prominently in this ticket's report —
// changing it later means changing every link already minted against it.

import { NormalizedModel, normalizeName } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { ModelIndex } from "../model/queryIndex.js";
import { dedupe, kebabSlug } from "../util/slug.js";
import { basename, extname } from "node:path";

export interface QueryModelEntry {
  file: string;
  modelKey: string;
  model: NormalizedModel;
  refs: RefsResult;
  index: ModelIndex;
}

export interface QuerySystem {
  entries: QueryModelEntry[];
  /** True once more than one file was given — the CLI/MCP layer's signal to qualify every ref
   *  in its output (`qualifyRef` below), and the signal `resolveElement`'s ambiguity rule uses
   *  ("unqualified + multi-model + ambiguous" -> list qualified candidates, per this ticket's
   *  design note). */
  multiModel: boolean;
}

/** Derive each file's `modelKey`: the kebab-slugged basename (extension stripped), deduped with
 *  `~2`/`~3`, ... on collision within this one invocation — same dedupe() convention
 *  `computeRefs()` uses for slice/element refs. Order-stable: the first file to claim a
 *  basename keeps the bare key. */
export function computeModelKeys(files: string[]): string[] {
  const used = new Set<string>();
  return files.map((f) => dedupe(kebabSlug(basename(f, extname(f))), used, "~"));
}

export function buildQuerySystem(
  entries: Array<{ file: string; model: NormalizedModel; refs: RefsResult; index: ModelIndex }>,
): QuerySystem {
  const keys = computeModelKeys(entries.map((e) => e.file));
  return {
    entries: entries.map((e, i) => ({ file: e.file, modelKey: keys[i], model: e.model, refs: e.refs, index: e.index })),
    multiModel: entries.length > 1,
  };
}

/** `<modelKey>:<ref>` when the system spans more than one model, else the bare ref — the one
 *  place every query verb formats a ref for output, so the qualifier convention can't drift
 *  between verbs. */
export function qualifyRef(system: QuerySystem, modelKey: string, ref: string): string {
  return system.multiModel ? `${modelKey}:${ref}` : ref;
}

export interface ResolvedElement {
  modelKey: string;
  file: string;
  entry: QueryModelEntry;
  ref: string;
  qualifiedRef: string;
  elementKind: string;
  elementName: string;
}

export type ResolveResult =
  | { ok: true; match: ResolvedElement }
  | { ok: false; error: string };

const REF_SHAPE_RE = /\//;

/** Resolve one user-supplied element reference — a stable ref, a `<modelKey>:`-qualified ref, or
 *  a bare display name — against every model in `system` (or just the named model, when
 *  qualified). A bare name/ref matching more than one element across the searched model(s) is
 *  always an error listing every candidate as a fully-qualified ref (`<modelKey>:<ref>`, even
 *  when `system` is single-model — a candidate list must be unambiguous on its own) — resolution
 *  never guesses. "Resolution is per-model" (MIL-168's spec): a bare name is looked up in each
 *  candidate model's OWN `byName` index, never merged across models before matching. */
export function resolveElement(system: QuerySystem, raw: string): ResolveResult {
  let modelKey: string | undefined;
  let rest = raw;
  const colon = raw.indexOf(":");
  if (colon > 0) {
    const prefix = raw.slice(0, colon);
    if (system.entries.some((e) => e.modelKey === prefix)) {
      modelKey = prefix;
      rest = raw.slice(colon + 1);
    }
  }

  const candidates = modelKey ? system.entries.filter((e) => e.modelKey === modelKey) : system.entries;
  if (modelKey && candidates.length === 0) {
    return { ok: false, error: `em query: unknown model "${modelKey}" in "${raw}"` };
  }

  const matches: ResolvedElement[] = [];
  for (const entry of candidates) {
    if (REF_SHAPE_RE.test(rest)) {
      const el = entry.index.byRef.get(rest);
      if (el) {
        const ref = entry.refs.refById.get(el.id)!;
        matches.push({ modelKey: entry.modelKey, file: entry.file, entry, ref, qualifiedRef: `${entry.modelKey}:${ref}`, elementKind: el.kind, elementName: el.name });
      }
    } else {
      const bucket = entry.model.byName.get(normalizeName(rest));
      for (const el of bucket ?? []) {
        const ref = entry.refs.refById.get(el.id)!;
        matches.push({ modelKey: entry.modelKey, file: entry.file, entry, ref, qualifiedRef: `${entry.modelKey}:${ref}`, elementKind: el.kind, elementName: el.name });
      }
    }
  }

  if (matches.length === 0) {
    return { ok: false, error: `em query: no element matches "${raw}"` };
  }
  if (matches.length > 1) {
    const candidateRefs = matches.map((m) => m.qualifiedRef).join(", ");
    return { ok: false, error: `em query: "${raw}" is ambiguous — matches ${matches.length} elements: ${candidateRefs}` };
  }
  return { ok: true, match: matches[0] };
}
