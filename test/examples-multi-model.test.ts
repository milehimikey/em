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
import { loadSystem } from "../src/cli/systemInputs.js";
import { verifySystem } from "../src/system/verify.js";

const CHECKOUT_FILE = join("examples", "multi-model", "models", "checkout", "checkout.em");
const FULFILLMENT_FILE = join("examples", "multi-model", "models", "fulfillment", "fulfillment.em");
const MANIFEST_FILE = join("examples", "multi-model", "system.yaml");

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

  // MIL-194: the same example doubles as the worked seam — checkout's public `Order Submitted`
  // feeds fulfillment's externally-fed `Order Intake` translation, declared in system.yaml —
  // plus one deliberately unbound public event, so `em system` shows both a verified seam and a
  // `dangling-public-event` warning. Exactly those, nothing else.
  it("system.yaml verifies with exactly one verified seam and one dangling-public-event warning", () => {
    const loaded = loadSystem(MANIFEST_FILE);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const report = verifySystem(loaded.manifest, loaded.models, MANIFEST_FILE);
    expect(report.seams).toEqual([
      expect.objectContaining({
        from: "checkout:checkout/event.order-submitted",
        to: "fulfillment:receive-order/translation.order-intake",
        status: "verified",
        diagnostics: [],
      }),
    ]);
    expect(report.diagnostics.map((d) => [d.severity, d.code, d.refs])).toEqual([
      ["warning", "dangling-public-event", ["checkout:cancel-order/event.order-cancelled"]],
    ]);
    expect(report.contextMap.edges).toEqual([{ from: "checkout", to: "fulfillment", seams: 1 }]);
  });

  it("the translation is externally fed (no in-model edge into it) — the shape the seam binds", () => {
    const loaded = loadSystem(MANIFEST_FILE);
    if (!loaded.ok) throw new Error("manifest failed to load");
    const fulfillment = loaded.models.find((m) => m.key === "fulfillment")!;
    expect(fulfillment.doc.model.edges.some((e) => e.to === "receive-order/translation.order-intake")).toBe(false);
  });
});
