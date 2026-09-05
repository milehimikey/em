// SPDX-License-Identifier: MIT
// Model-qualified addressing (MIL-193): the ONE grammar for naming a slice, element, or type
// that lives in another model. Export refs (`<sliceKey>/<kind>.<slug>`, `computeRefs()`) are
// deliberately model-unqualified and stay valid everywhere they are today; any artifact that
// crosses a model boundary — `em query`'s multi-model output, `em export`'s own `model.key`,
// MIL-194's seam manifest, em-portal deep links, em-tracker-bridge — prefixes them with a
// `modelKey` using exactly this module, so the "one addressing scheme" constraint (MIL-162)
// can't die by each consumer inventing its own qualifier.
//
//   <modelKey>:<sliceKey>/<kind>.<slug>   element
//   <modelKey>:<sliceKey>                 slice
//   <modelKey>:types/<slug>               type
//
// `modelKey` is the kebab-slug of the DECLARED model name (`model "Name"`) — the same
// `kebabSlug()` every other export identity derives from — never a path: it survives file
// moves and renames, and a single-model `em export` can carry it with no system context. A
// file that declares no name falls back to its kebab-slugged basename (extension stripped);
// two models in one multi-model invocation that mint the same key are deduped `~2`, `~3`, …
// in file-list order (first wins the bare key) with a `duplicate-model-key` warning naming
// both files — the same posture as `computeRefs()`'s `duplicate-slice-name`.
//
// Lives in model/ for the same layering reason as refs.ts: a pure function of NormalizedModel
// (no fs, no JSON shape), consumed by emit/, query/, and — via the package's `./refs` subpath
// export — by external packages, which must never grow a second parser for this grammar.

import { NormalizedModel } from "./model.js";
import type { Diagnostic } from "./validate.js";
import { pushDiag } from "./rules.js";
import { dedupe, kebabSlug } from "../util/slug.js";

/** The model-key shape: a kebab slug (`kebabSlug()`'s output) with an optional `~n` collision
 *  suffix. Anchored; the single definition `parseQualifiedRef`/`isQualifiedRef` split on. */
export const MODEL_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:~\d+)?$/;

/** Strip a path to its kebab-slugged basename, extension removed — the no-declared-name
 *  fallback. Pure string work (no fs, and both `/` and `\` separators) so the module stays
 *  usable from a browser bundle. */
function fileBasenameKey(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  const dot = base.lastIndexOf(".");
  return kebabSlug(dot > 0 ? base.slice(0, dot) : base);
}

/**
 * A model's own key: `kebabSlug(model.name)` when the name was declared (`model "Name"`);
 * otherwise the kebab-slugged basename of `fallbackFile` (extension stripped) when one is
 * given; otherwise the slug of the parser's default title. Never deduped — collisions are a
 * multi-model concern, see `computeModelKeys()`.
 */
export function computeModelKey(model: NormalizedModel, fallbackFile?: string): string {
  if (!model.nameDeclared && fallbackFile) return fileBasenameKey(fallbackFile);
  return kebabSlug(model.name);
}

export interface ModelKeysResult {
  /** One key per entry, same order/index as the input. */
  keys: string[];
  /** `duplicate-model-key` warnings, one per entry that had to take a `~n` suffix. */
  diagnostics: Diagnostic[];
}

/**
 * Keys for every model of one multi-model invocation: `computeModelKey()` each, then dedupe
 * with `~2`, `~3`, … in input order (the first entry to claim a key keeps it bare) and warn
 * on every collision. Order-stable: a consumer that always lists its files the same way gets
 * the same keys back.
 */
export function computeModelKeys(entries: Array<{ model: NormalizedModel; file: string }>): ModelKeysResult {
  const diagnostics: Diagnostic[] = [];
  const used = new Set<string>();
  const firstFileByKey = new Map<string, string>();
  const keys = entries.map(({ model, file }) => {
    const base = computeModelKey(model, file);
    const key = dedupe(base, used, "~");
    if (key === base) {
      firstFileByKey.set(base, file);
    } else {
      pushDiag(diagnostics, "duplicate-model-key", {
        message: `duplicate model key "${base}" (${firstFileByKey.get(base)} and ${file} both derive it); give each model a unique \`model "Name"\` so cross-model refs stay stable — ${file} is addressed as "${key}" in this run`,
        refs: [key, base],
      });
    }
    return key;
  });
  return { keys, diagnostics };
}

/** `<modelKey>:<ref>` — the one place the qualifier separator is spelled. `ref` is an
 *  element ref, a bare slice key, or a type ref, unchanged. */
export function formatQualifiedRef(modelKey: string, ref: string): string {
  return `${modelKey}:${ref}`;
}

export interface ParsedQualifiedRef {
  /** The qualifier, or `null` when `input` carried none (or its prefix isn't a model-key shape). */
  modelKey: string | null;
  /** The model-unqualified remainder — `input` itself when unqualified. */
  ref: string;
}

/**
 * Split `<modelKey>:<ref>` on the FIRST colon, but only when the prefix has the model-key
 * shape (`MODEL_KEY_RE`); anything else is returned intact as an unqualified ref — a display
 * name ("Order: Paid") may legitimately contain a colon, and callers resolving names must not
 * lose it. Shape-only: whether the key names a model this caller actually has is its own
 * question (`em query`'s `resolveElement` checks that and reports an unknown prefix).
 */
export function parseQualifiedRef(input: string): ParsedQualifiedRef {
  const colon = input.indexOf(":");
  if (colon <= 0) return { modelKey: null, ref: input };
  const prefix = input.slice(0, colon);
  if (!MODEL_KEY_RE.test(prefix)) return { modelKey: null, ref: input };
  return { modelKey: prefix, ref: input.slice(colon + 1) };
}

/** True when `parseQualifiedRef(input)` would find a model-key-shaped qualifier. */
export function isQualifiedRef(input: string): boolean {
  return parseQualifiedRef(input).modelKey !== null;
}
