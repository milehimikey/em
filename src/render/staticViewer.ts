// SPDX-License-Identifier: MIT
// The viewer as a static page: `em render --map` writes one per storyline beside the canvas, so
// the map → storyline → slice-doc drill-down `em watch --serve` gives live also works with no
// server — opened from disk, committed beside the model, or put on any static host.
//
// One viewer, not two: this is VIEWER_HTML (src/render/viewer.html) with a config script set
// ahead of its own, which switches the page into its static mode (see that file's header). The
// diagram travels inside the config, so the page fetches nothing; the slice docs are already in
// the SVG's em-slices metadata (src/render/sliceOverlay.ts), exactly as the live viewer reads
// them.

import { VIEWER_HTML } from "./viewerHtml.js";

/** One entry of the page's storyline picker: a sibling page, by relative href. */
export interface StaticViewerVariant {
  name: string;
  /** Relative href of the sibling page (`<slug>.html`). */
  file: string;
  current: boolean;
}

export interface StaticViewerOptions {
  /** The rendered SVG this page shows (composeSvg's output). */
  svg: string;
  /** Header and tab title, e.g. `toolshed — Join the shed`. */
  title: string;
  /** Relative href of the storyline canvas the breadcrumb returns to. */
  mapHref: string;
  /** Sibling pages for the picker; omit or `[]` for no picker. */
  variants?: StaticViewerVariant[];
  /** Short text for the header's right edge, e.g. when the page was generated. */
  stamp?: string;
}

const HEAD_END = "</head>";
const TITLE = /<title>[^<]*<\/title>/;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** JSON safe inside a `<script>`: no `<` survives, so neither `</script>` nor `<!--` can appear,
 *  and the two line separators JSON allows raw but older script parsers do not are escaped too. */
function scriptJson(value: unknown): string {
  // The two line separators, by code point so this source holds no raw one.
  const ls = String.fromCharCode(0x2028);
  const ps = String.fromCharCode(0x2029);
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .split(ls).join("\\u2028")
    .split(ps).join("\\u2029");
}

export function buildStaticViewerHtml(opts: StaticViewerOptions): string {
  if (!VIEWER_HTML.includes(HEAD_END) || !TITLE.test(VIEWER_HTML)) {
    throw new Error("staticViewer: viewer.html lost its <title> or </head> — the static page cannot be built");
  }
  const config = {
    svg: opts.svg,
    title: opts.title,
    mapHref: opts.mapHref,
    variants: opts.variants ?? [],
    stamp: opts.stamp ?? "",
  };
  // Function replacers: a `$` in model text must not be read as a replacement pattern.
  return VIEWER_HTML.replace(TITLE, () => `<title>${esc(opts.title)}</title>`).replace(
    HEAD_END,
    () => `  <script>window.EM_STATIC = ${scriptJson(config)};</script>\n${HEAD_END}`,
  );
}
