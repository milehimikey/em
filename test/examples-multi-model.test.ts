// SPDX-License-Identifier: MIT
// Guards examples/multi-model/ (MIL-160) — the worked example of the documented
// one-directory-per-model convention. Both models parse/validate cleanly, and — the whole
// point of the example — deliberately reusing the same slice name ("Checkout") across the two
// models never produces a cross-model-slice-doc-collision warning, because each model owns its
// own directory. Parallel to test/examples.test.ts's flat-file sweep, which doesn't reach this
// nested layout.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { hasErrors } from "../src/model/validate.js";
import { detectSliceDocCollisions } from "../src/catalog/modelCollisionValidate.js";

const CHECKOUT_FILE = join("examples", "multi-model", "models", "checkout", "checkout.em");
const FULFILLMENT_FILE = join("examples", "multi-model", "models", "fulfillment", "fulfillment.em");

describe("examples/multi-model/", () => {
  it("both models parse and validate without errors", () => {
    for (const file of [CHECKOUT_FILE, FULFILLMENT_FILE]) {
      const { diagnostics } = compile(readFileSync(file, "utf8"));
      expect(hasErrors(diagnostics), file).toBe(false);
    }
  });

  it("both models declare a slice named \"Checkout\" (the point of the example)", () => {
    const checkout = compile(readFileSync(CHECKOUT_FILE, "utf8"));
    const fulfillment = compile(readFileSync(FULFILLMENT_FILE, "utf8"));
    expect(checkout.refs.sliceKeys).toContain("checkout");
    expect(fulfillment.refs.sliceKeys).toContain("checkout");
  });

  it("reports ZERO collisions across the two models — one directory per model is enough", () => {
    const checkout = compile(readFileSync(CHECKOUT_FILE, "utf8"));
    const fulfillment = compile(readFileSync(FULFILLMENT_FILE, "utf8"));
    const diags = detectSliceDocCollisions([
      { file: CHECKOUT_FILE, sliceKeys: checkout.refs.sliceKeys },
      { file: FULFILLMENT_FILE, sliceKeys: fulfillment.refs.sliceKeys },
    ]);
    expect(diags).toEqual([]);
  });
});
