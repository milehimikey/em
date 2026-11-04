// SPDX-License-Identifier: MIT
// Embeds the live viewer's storyline-picker metadata (GH #309, deferred from #277) into a
// composed SVG: a flat `<metadata id="em-storylines">` JSON array, read by viewer.html to
// render a <select> that switches between the full model and any declared storyline without
// restarting `em watch --serve`. Spliced the same way sliceOverlay.ts's own
// `<metadata id="em-slices">` is — just inside the root `<svg>` — and a no-op (returns `svg`
// unchanged) when there's nothing to pick between, i.e. the model declares no storylines.

/** One entry of the live viewer's storyline picker: a file this `em watch --serve` session
 *  writes (the full model, or one storyline's subset — see src/cli/watchStoryline.ts), and
 *  whether it's the one currently loaded. */
export interface StorylineVariant {
  name: string;
  file: string;
  current: boolean;
}

export function embedStorylinePicker(svg: string, variants: StorylineVariant[]): string {
  if (variants.length === 0) return svg;
  const metadata = `<metadata id="em-storylines">${escXml(JSON.stringify(variants))}</metadata>`;
  return svg.replace(/(<svg\b[^>]*>)/, `$1${metadata}`);
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
