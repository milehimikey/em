// SPDX-License-Identifier: MIT
// Testable core of `em watch --serve --storyline <name>` (GH #309, deferred from #277):
// resolving the --storyline argument against the model (the exact same resolution `em render
// --storyline` and `em engagement`'s own `--storyline` selector use — findStoryline, GH #348's
// case/whitespace-insensitive match) and the live viewer's storyline-picker entries. Factored
// out of cli.ts's `watch` action, which starts a long-running file watcher and isn't itself
// unit-testable, mirroring src/cli/render-inputs.ts's existing split for `em render`'s own
// `--slice`/`--storyline`.

import { NormalizedModel, Storyline } from "../model/model.js";
import { kebabSlug } from "../util/slug.js";
import { findStoryline } from "../model/storylines.js";
import { StorylineVariant } from "../render/storylinePicker.js";

/** Flat (no subdirectory) filename for a storyline's live-serve subset SVG, written alongside
 *  the full model's own output file. Flat, unlike `em render --storyline`'s `storylines/`
 *  convention, because the live viewer's `?svg=` allowlist (serve.ts / viewer.html) accepts a
 *  bare filename only — never a path with a separator. */
export function storylineFileFor(name: string): string {
  return `storyline-${kebabSlug(name)}.svg`;
}

/** The live viewer's storyline-picker entries (GH #309): "Full model" plus one per declared
 *  storyline, `current` marking whichever file THIS render is — so the same list, computed
 *  once per build, embeds into every output file with only `current` differing. `[]` (no
 *  picker) when the model declares none. */
export function storylineVariants(model: NormalizedModel, outFile: string, currentFile: string): StorylineVariant[] {
  const declared = model.storylines ?? [];
  if (declared.length === 0) return [];
  return [
    { name: "Full model", file: outFile, current: currentFile === outFile },
    ...declared.map((st) => {
      const file = storylineFileFor(st.name);
      return { name: st.name, file, current: currentFile === file };
    }),
  ];
}

export type StorylineResolution = { storyline: Storyline } | { error: string } | { none: true };

/** Resolve `--storyline <name>` against the model — `{ none: true }` when the flag wasn't
 *  given at all. Same validation `em render --storyline` reports on an unknown name: lists
 *  every declared storyline, so a typo is correctable without opening the .em file. Uses
 *  findStoryline directly (not render/storylineDiagram.ts's resolveStorylineArg) only because
 *  that helper's error text is hardcoded to "em render --storyline" — the lookup itself (GH
 *  #348's case/whitespace-insensitive match) is the one `em render`, `em engagement
 *  --storyline` and this all share; this is not a second resolution. */
export function resolveWatchStoryline(model: NormalizedModel, name: string | undefined): StorylineResolution {
  if (name === undefined) return { none: true };
  const storyline = findStoryline(model, name);
  if (storyline) return { storyline };
  const declared = model.storylines ?? [];
  const known = declared.map((s) => `"${s.name}"`).join(", ");
  return {
    error:
      declared.length === 0
        ? `em watch --storyline: this model declares no storylines`
        : `em watch --storyline: no storyline "${name}" (declared: ${known})`,
  };
}

/** GH #422: the URL `em watch --serve` prints. A model that declares storylines opens on the
 *  storyline canvas (`/map`, the page `em render --map` builds, served live) unless
 *  `--storyline` pinned one storyline, in which case the viewer opens inside that storyline as
 *  before (#309). `--storyline` aside, the full timeline is one picker entry away, never the
 *  landing page (owner ruling 2026-11-03). */
export function liveViewUrl(base: string, liveFile: string, hasStorylines: boolean, pinned: boolean): string {
  if (hasStorylines && !pinned) return `${base}/map`;
  return `${base}/?svg=${encodeURIComponent(liveFile)}`;
}
