// SPDX-License-Identifier: MIT
// GH #309 (deferred from #277): the testable core of `em watch --serve --storyline <name>` —
// resolving the --storyline argument (same resolution `em render --storyline` and the
// engagement `--storyline` selector use, GH #348's findStoryline) and the live viewer's
// storyline-picker entries — factored into src/cli/watchStoryline.ts per render-inputs.ts's
// existing split, since cli.ts's `watch` action itself (a long-running watcher) isn't
// unit-testable directly.
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { resolveWatchStoryline, storylineFileFor, storylineVariants } from "../src/cli/watchStoryline.js";

// Two declared storylines (one with a multi-word name, to exercise kebab-slugging) plus a
// slice outside any storyline.
const SRC = `
persona Clerk
context Inventory

storyline "Main" {
  slice "Receive" {
    ui Goods In @Clerk
    command Receive Stock
    event Stock Received @Inventory
  }
}

storyline "Retire a Product" {
  slice "Archive" {
    ui Archive Form @Clerk
    command Archive Product
    event Product Archived @Inventory
  }
}
`;

const NONE = `
persona Clerk
context Inventory

slice "Receive" {
  ui Goods In @Clerk
  command Receive Stock
  event Stock Received @Inventory
}
`;

function modelFrom(src: string) {
  return normalize(parse(src));
}

describe("storylineFileFor", () => {
  it("kebab-slugs the storyline name into a flat storyline-<slug>.svg filename", () => {
    expect(storylineFileFor("Retire a Product")).toBe("storyline-retire-a-product.svg");
    expect(storylineFileFor("Main")).toBe("storyline-main.svg");
  });

  it("is flat — never a path with a separator, so it always passes the viewer's ?svg= allowlist", () => {
    const file = storylineFileFor("Weird / Name");
    expect(file).not.toMatch(/[/\\:]/);
    expect(/^[^/\\:]+\.svg$/.test(file)).toBe(true);
  });
});

describe("storylineVariants", () => {
  it("is [] when the model declares no storylines — nothing for the picker to show", () => {
    expect(storylineVariants(modelFrom(NONE), "model.svg", "model.svg")).toEqual([]);
  });

  it("lists 'Full model' plus one entry per declared storyline, marking the current file", () => {
    const model = modelFrom(SRC);
    const variants = storylineVariants(model, "model.svg", "storyline-retire-a-product.svg");
    expect(variants).toEqual([
      { name: "Full model", file: "model.svg", current: false },
      { name: "Main", file: "storyline-main.svg", current: false },
      { name: "Retire a Product", file: "storyline-retire-a-product.svg", current: true },
    ]);
  });

  it("marks 'Full model' current when currentFile is the out file", () => {
    const model = modelFrom(SRC);
    const variants = storylineVariants(model, "model.svg", "model.svg");
    expect(variants[0]).toEqual({ name: "Full model", file: "model.svg", current: true });
    expect(variants.every((v) => v.file !== "model.svg" ? !v.current : true)).toBe(true);
  });
});

describe("resolveWatchStoryline", () => {
  it("{ none: true } when --storyline wasn't given", () => {
    expect(resolveWatchStoryline(modelFrom(SRC), undefined)).toEqual({ none: true });
  });

  it("resolves a declared storyline case/whitespace-insensitively (GH #348)", () => {
    const model = modelFrom(SRC);
    const resolved = resolveWatchStoryline(model, "  retire   a product ");
    expect("storyline" in resolved && resolved.storyline.name).toBe("Retire a Product");
  });

  it("an unknown name errors, listing the declared storylines, same shape `em render --storyline` reports", () => {
    const resolved = resolveWatchStoryline(modelFrom(SRC), "Nope");
    expect("error" in resolved && resolved.error).toContain('"Main", "Retire a Product"');
  });

  it("a model with no storylines errors distinctly on any --storyline value", () => {
    const resolved = resolveWatchStoryline(modelFrom(NONE), "Anything");
    expect("error" in resolved && resolved.error).toContain("declares no storylines");
  });
});
