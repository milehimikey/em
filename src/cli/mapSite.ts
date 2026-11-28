// SPDX-License-Identifier: MIT
// Testable core of `em render --map`'s output: the storyline canvas as the root page, one static
// viewer page per storyline (src/render/staticViewer.ts) that the canvas's frames open, and —
// only when asked for — one for the full model. Factored out of cli.ts's render action the same
// way src/cli/watchStoryline.ts is for `em watch`; the action lays the diagrams out and writes
// what this returns.
//
// The storylines are the site: the full model is never the landing page and is not written at
// all unless `--full-model` asks (owner ruling 2026-11-03 on the live view, carried here).
// Output is deterministic — no timestamps — because models commit this folder beside the source.

import { NormalizedModel } from "../model/model.js";
import { StorylineMap } from "../model/storylineMap.js";
import { StorylineFrame, buildStorylineMapHtml } from "../render/storylineMap.js";
import { StaticViewerVariant, buildStaticViewerHtml } from "../render/staticViewer.js";

/** A storyline's rendered diagram, ready to place on the canvas and in its own page. */
export interface MapSiteStoryline {
  name: string;
  slug: string;
  sliceCount: number;
  svg: string;
}

/** Page filename of the opt-in full model. The leading underscore keeps it clear of every
 *  storyline page: a kebab slug never starts with one. */
export const FULL_MODEL_PAGE = "_full-model.html";

export interface MapSiteInput {
  model: NormalizedModel;
  map: StorylineMap;
  storylines: MapSiteStoryline[];
  /** Filename of the canvas page within the output folder (`map.html`, or `-o`'s basename). */
  mapFile: string;
  /** The full model's rendered SVG; given only under `--full-model`. */
  fullModelSvg?: string;
}

export type MapSiteResult = { files: Map<string, string> } | { error: string };

/** Every HTML file of the site, keyed by filename within the output folder. The per-storyline
 *  `.svg` files are the caller's to write (they are the diagrams themselves, unchanged). */
export function buildMapSite(input: MapSiteInput): MapSiteResult {
  const { model, storylines, mapFile } = input;
  const pageOf = (slug: string): string => `${slug}.html`;
  const clash = storylines.find((s) => pageOf(s.slug) === mapFile);
  if (clash) {
    return {
      error:
        `em render --map: storyline "${clash.name}" has its page at ${pageOf(clash.slug)}, which is also the canvas page — ` +
        `pick another canvas filename with -o (e.g. -o index.html)`,
    };
  }

  const withFull = input.fullModelSvg !== undefined;
  const variantsFor = (current: string): StaticViewerVariant[] => [
    ...(withFull ? [{ name: "Full model", file: FULL_MODEL_PAGE, current: current === FULL_MODEL_PAGE }] : []),
    ...storylines.map((s) => ({ name: s.name, file: pageOf(s.slug), current: current === pageOf(s.slug) })),
  ];

  const files = new Map<string, string>();
  const frames: StorylineFrame[] = storylines.map((s) => ({
    name: s.name,
    slug: s.slug,
    sliceCount: s.sliceCount,
    svg: s.svg,
    href: `./${pageOf(s.slug)}`,
  }));
  files.set(mapFile, buildStorylineMapHtml(model, frames, input.map));
  for (const s of storylines) {
    files.set(
      pageOf(s.slug),
      buildStaticViewerHtml({
        svg: s.svg,
        title: `${model.name} — ${s.name}`,
        mapHref: `./${mapFile}`,
        variants: variantsFor(pageOf(s.slug)),
      }),
    );
  }
  if (input.fullModelSvg !== undefined) {
    files.set(
      FULL_MODEL_PAGE,
      buildStaticViewerHtml({
        svg: input.fullModelSvg,
        title: `${model.name} — full model`,
        mapHref: `./${mapFile}`,
        variants: variantsFor(FULL_MODEL_PAGE),
      }),
    );
  }
  return { files };
}
