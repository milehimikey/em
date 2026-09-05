// SPDX-License-Identifier: MIT
// `em query`'s multi-model addressing (MIL-168): a `QuerySystem` is one or more compiled
// models, each keyed by a short, stable `modelKey`. Refs (`<sliceKey>/<kind>.<slug>`) are, and
// remain, model-UNQUALIFIED — `computeRefs()`'s contract is untouched. For a query answer that
// spans more than one input file, that's ambiguous on its own (two models can easily mint the
// same slice/element ref independently), so `em query` addresses cross-model results with the
// qualified form `<modelKey>:<sliceKey>/<kind>.<slug>` — accepted on input alongside a bare
// ref/display name, and used to disambiguate/print results whenever more than one file was given.
//
// Query was the first surface to need this (MIL-168) and originally derived `modelKey` from the
// input filename. Since MIL-193 the key, the grammar, and the parse/format live in
// model/qualifiedRef.ts — the ONE cross-model addressing scheme every em surface shares
// (`em export`'s `model.key`, MIL-194's seam manifest, em-portal deep links): the key is the
// kebab-slug of the declared `model "Name"` (basename fallback when none is declared), so a
// query result's qualified ref is the same string an export consumer would mint for the same
// element. This module only decides WHEN to qualify (more than one file given) and how a
// user-supplied ref resolves; it never spells the grammar itself.

import { NormalizedModel, normalizeName } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { ModelIndex } from "../model/queryIndex.js";
import type { Diagnostic } from "../model/validate.js";
import { computeModelKeys, formatQualifiedRef, parseQualifiedRef } from "../model/qualifiedRef.js";

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
  /** `duplicate-model-key` warnings from keying the entries (MIL-193, `computeModelKeys()`):
   *  two input models deriving the same key, the later one suffixed `~2`/`~3`, … in file-list
   *  order. Empty for a single-model system. The CLI prints these to stderr like any other
   *  compile warning; the JSON document is unaffected (MCP parity holds). */
  diagnostics: Diagnostic[];
}

export function buildQuerySystem(
  entries: Array<{ file: string; model: NormalizedModel; refs: RefsResult; index: ModelIndex }>,
): QuerySystem {
  const { keys, diagnostics } = computeModelKeys(entries);
  return {
    entries: entries.map((e, i) => ({ file: e.file, modelKey: keys[i], model: e.model, refs: e.refs, index: e.index })),
    multiModel: entries.length > 1,
    diagnostics,
  };
}

/** `<modelKey>:<ref>` when the system spans more than one model, else the bare ref — the one
 *  place every query verb decides whether to qualify a ref for output, so the WHEN can't drift
 *  between verbs (the HOW is `formatQualifiedRef()`'s). */
export function qualifyRef(system: QuerySystem, modelKey: string, ref: string): string {
  return system.multiModel ? formatQualifiedRef(modelKey, ref) : ref;
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
 *  candidate model's OWN `byName` index, never merged across models before matching. A repeated
 *  read model's later instances (`view X again`) don't count as separate name matches — see
 *  the bare-name branch below. */
export function resolveElement(system: QuerySystem, raw: string): ResolveResult {
  // `parseQualifiedRef` only splits when the prefix has the model-key SHAPE; a prefix that
  // isn't one of THIS system's keys is then left in place — a display name may legitimately
  // contain a colon — so the search runs over every model; if nothing matches, the miss names
  // the unrecognised prefix (a typo'd qualifier is the likely cause).
  const parsed = parseQualifiedRef(raw);
  const known = parsed.modelKey !== null && system.entries.some((e) => e.modelKey === parsed.modelKey);
  const modelKey = known ? parsed.modelKey! : undefined;
  const rest = known ? parsed.ref : raw;

  const candidates = modelKey ? system.entries.filter((e) => e.modelKey === modelKey) : system.entries;

  const matches: ResolvedElement[] = [];
  for (const entry of candidates) {
    // A slash makes the input look like a ref; when no ref matches, fall through to the
    // display-name lookup — a name may itself contain a slash ("Approve/Reject Screen").
    const byRef = REF_SHAPE_RE.test(rest) ? entry.index.byRef.get(rest) : undefined;
    if (byRef) {
      const ref = entry.refs.refById.get(byRef.id)!;
      matches.push({ modelKey: entry.modelKey, file: entry.file, entry, ref, qualifiedRef: formatQualifiedRef(entry.modelKey, ref), elementKind: byRef.kind, elementName: byRef.name });
    } else {
      // A repeated read model (`view X again`) has one name and several instances; the bare
      // name means the read model, which resolves to its FIRST instance (`logicalId`) — every
      // closure/path verb then follows the instance chain from there (verbs.ts's header). A
      // later instance stays addressable by its own ref.
      const bucket = (entry.model.byName.get(normalizeName(rest)) ?? []).filter((el) => el.logicalId === el.id);
      for (const el of bucket) {
        const ref = entry.refs.refById.get(el.id)!;
        matches.push({ modelKey: entry.modelKey, file: entry.file, entry, ref, qualifiedRef: formatQualifiedRef(entry.modelKey, ref), elementKind: el.kind, elementName: el.name });
      }
    }
  }

  if (matches.length === 0) {
    const hint =
      parsed.modelKey !== null && !known
        ? ` ("${parsed.modelKey}" is not a model key — input models are: ${system.entries.map((e) => e.modelKey).join(", ")})`
        : "";
    return { ok: false, error: `em query: no element matches "${raw}"${hint}` };
  }
  if (matches.length > 1) {
    const candidateRefs = matches.map((m) => m.qualifiedRef).join(", ");
    return { ok: false, error: `em query: "${raw}" is ambiguous — matches ${matches.length} elements: ${candidateRefs}` };
  }
  return { ok: true, match: matches[0] };
}
