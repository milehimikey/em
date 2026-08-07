// SPDX-License-Identifier: MIT
// Testable input handling for `em render --slice`: slice-name resolution and
// its default output path, factored out of cli.ts so they're unit-testable
// without spawning a subprocess (mirrors src/cli/catalog-inputs.ts's shape).
// Unlike planCatalogArgs's pre-file --format check, resolving a slice name
// needs the compiled model, so this isn't a pre-file plan*Args gate — it's
// called from the render action after compileFile().

import { dirname, join } from "node:path";
import { Slice } from "../model/model.js";
import { kebabSlug } from "../util/slug.js";

export type SliceLookup = { index: number } | { error: string };

/**
 * Resolve `--slice <name>` against the compiled model's slices: an exact,
 * case-sensitive match against `Slice.name` — not a fuzzy namespace. On no
 * match, lists every valid slice name in declaration order so a typo is
 * correctable without opening the .em file.
 *
 * Note this is a *different* identity than `em export`/`em catalog`'s
 * deduped `sliceKey` (kebab-slug + `~2`/`~3` suffix for repeated names) —
 * `findIndex` here always returns the *first* slice with a given name, so two
 * identically-named slices can't be disambiguated via `--slice` at all today.
 * Rare in practice (duplicate slice names are themselves a validation
 * warning), and not worth a key-based `--slice` syntax until it's a real
 * complaint — flagging here rather than silently.
 */
export function resolveSliceArg(name: string, slices: Slice[]): SliceLookup {
  const index = slices.findIndex((s) => s.name === name);
  if (index >= 0) return { index };
  const names = slices.map((s) => `"${s.name}"`).join(", ");
  return {
    error: `em render: no slice named "${name}" — valid slices: ${names || "(model has no slices)"}`,
  };
}

/**
 * Default output path for a slice diagram: slices/<kebab-slug>.svg next to the
 * .em file — the same slices/ + kebabSlug convention em catalog's sibling-file
 * lookup and the event-modeling skill's slice-doc path already use.
 */
export function defaultSliceOut(file: string, sliceName: string): string {
  return join(dirname(file), "slices", `${kebabSlug(sliceName)}.svg`);
}
