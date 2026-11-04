// SPDX-License-Identifier: MIT
// GH #309 (deferred from #277): embedStorylinePicker splices the live viewer's storyline-picker
// metadata into a composed SVG — the <select> in viewer.html reads it to offer "Full model" plus
// every declared storyline, with no new fetch/endpoint of its own (see src/cli.ts's watch action,
// which writes every variant as a sibling file on disk).
import { describe, it, expect } from "vitest";
import { embedStorylinePicker, StorylineVariant } from "../src/render/storylinePicker.js";

const SVG = '<svg viewBox="0 0 100 100"><g class="node"></g></svg>';

describe("embedStorylinePicker", () => {
  it("returns the svg unchanged when there are no variants (model declares no storylines)", () => {
    expect(embedStorylinePicker(SVG, [])).toBe(SVG);
  });

  it("splices a <metadata id=\"em-storylines\"> with the variant list just inside the root <svg>", () => {
    const variants: StorylineVariant[] = [
      { name: "Full model", file: "model.svg", current: true },
      { name: "Retire a Product", file: "storyline-retire-a-product.svg", current: false },
    ];
    const out = embedStorylinePicker(SVG, variants);
    expect(out.startsWith('<svg viewBox="0 0 100 100"><metadata id="em-storylines">')).toBe(true);
    const json = /<metadata id="em-storylines">([\s\S]*?)<\/metadata>/.exec(out)![1];
    expect(JSON.parse(json)).toEqual(variants);
    // the rest of the document is untouched
    expect(out.endsWith('<g class="node"></g></svg>')).toBe(true);
  });

  it("XML-escapes a storyline name/file carrying &, < or >", () => {
    const variants: StorylineVariant[] = [{ name: 'A & B <x>', file: "storyline-a-b.svg", current: false }];
    const out = embedStorylinePicker(SVG, variants);
    const raw = /<metadata id="em-storylines">([\s\S]*?)<\/metadata>/.exec(out)![1];
    expect(raw).not.toContain("<x>");
    expect(raw).toContain("&amp;");
    const entities: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&" };
    const payload = JSON.parse(raw.replace(/&(?:lt|gt|amp);/g, (e) => entities[e]));
    expect(payload).toEqual(variants);
  });
});
