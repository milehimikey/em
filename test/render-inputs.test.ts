// SPDX-License-Identifier: MIT
// Coverage for `em render --slice`'s input handling (src/cli/render-inputs.ts):
// slice-name resolution and its default output path, matching the repo's
// convention of testing this logic at the module level (see
// test/catalog-inputs.test.ts).
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { resolveSliceArg, defaultSliceOut } from "../src/cli/render-inputs.js";
import { Slice } from "../src/model/model.js";

function slice(name: string, index: number): Slice {
  return { name, index, elements: [], line: 1 };
}

describe("resolveSliceArg", () => {
  const slices = [slice("Place Order", 0), slice("Ship Order", 1)];

  it("resolves an exact name match to its index", () => {
    expect(resolveSliceArg("Ship Order", slices)).toEqual({ index: 1 });
  });

  it("is case-sensitive — no fuzzy/case-insensitive fallback", () => {
    expect(resolveSliceArg("ship order", slices)).toEqual({
      error: 'em render: no slice named "ship order" — valid slices: "Place Order", "Ship Order"',
    });
  });

  it("lists every valid slice name, in declaration order, on no match", () => {
    expect(resolveSliceArg("Nope", slices)).toEqual({
      error: 'em render: no slice named "Nope" — valid slices: "Place Order", "Ship Order"',
    });
  });

  it("reports a model with no slices honestly rather than an empty list", () => {
    expect(resolveSliceArg("Anything", [])).toEqual({
      error: 'em render: no slice named "Anything" — valid slices: (model has no slices)',
    });
  });
});

describe("defaultSliceOut", () => {
  it("kebab-slugs the slice name into slices/<slug>.svg next to the .em file", () => {
    expect(defaultSliceOut("model.em", "Place Order")).toBe(join("slices", "place-order.svg"));
  });

  it("resolves relative to the .em file's own directory, not the cwd", () => {
    expect(defaultSliceOut("nested/dir/model.em", "Ship Order")).toBe(
      join("nested", "dir", "slices", "ship-order.svg"),
    );
  });
});
