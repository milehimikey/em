// SPDX-License-Identifier: MIT
// End-to-end coverage for `em catalog`'s file-writing (src/catalog/build.ts):
// real renderDot output, the directory-per-model layout, real slice-doc
// discovery/parsing off disk, and the "no doc" fallback — parallel to
// test/render.e2e.test.ts's real-pipeline convention.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { buildCatalog, CatalogModelInput } from "../src/catalog/build.js";

// "Place Order" has a real slices/place-order.md doc; "Open Orders" deliberately doesn't,
// to exercise the "no doc" fallback in the same build. The event's `note` (an element-level
// annotation, unrelated file) confirms slice-doc discovery never reads Element.note.
const MODEL = `slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed @Order note "notes/order-placed.md"
}
slice "Open Orders" {
  view Open Orders from "Order Placed"
  ui Order List @Customer
}
`;

const SLICE_DOC = `- **Status:** reviewed

## Intent
Let customers place orders.
`;

let dir: string;
let modelFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "em-catalog-e2e-"));
  modelFile = join(dir, "model.em");
  writeFileSync(modelFile, MODEL);
  mkdirSync(join(dir, "slices"), { recursive: true });
  writeFileSync(join(dir, "slices", "place-order.md"), SLICE_DOC);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("buildCatalog", () => {
  it("writes the full directory-per-model tree with real diagrams and slice pages", async () => {
    const { model, grid, dot } = compile(MODEL);
    const inputs: CatalogModelInput[] = [{ file: modelFile, model, grid, dot }];
    const outDir = join(dir, "out");

    const result = await buildCatalog(inputs, { outDir });
    expect(result).toEqual({ models: 1, slices: 2, diagnostics: [] });

    expect(existsSync(join(outDir, "index.html"))).toBe(true);
    expect(existsSync(join(outDir, "model", "diagram.svg"))).toBe(true);
    expect(existsSync(join(outDir, "model", "slices", "place-order.html"))).toBe(true);
    expect(existsSync(join(outDir, "model", "slices", "open-orders.html"))).toBe(true);

    const index = readFileSync(join(outDir, "index.html"), "utf8");
    expect(index).toContain("Place Order");
    expect(index).toContain("Open Orders");
    expect(index).toContain("State Change");
    expect(index).toContain("State View");
    // the diagram is embedded on the index page itself, not just linked
    expect(index).toContain('<object class="diagram" type="image/svg+xml" data="model/diagram.svg">');
    expect(index).toContain("reviewed");
    expect(index).toContain("no doc");

    const placeOrderPage = readFileSync(join(outDir, "model", "slices", "place-order.html"), "utf8");
    expect(placeOrderPage).toContain('data="../diagram.svg"');
    expect(placeOrderPage).toContain("Let customers place orders."); // real doc, rendered
    expect(placeOrderPage).toContain("reviewed");

    // The "no doc" slice still renders cleanly from AST facts alone, without throwing.
    const openOrdersPage = readFileSync(join(outDir, "model", "slices", "open-orders.html"), "utf8");
    expect(openOrdersPage).toContain("No slice doc found");
    expect(openOrdersPage).toContain("slices/open-orders.md");
  });

  it("surfaces ref-collision diagnostics and never bleeds one slice's doc onto its same-named sibling", async () => {
    // Two slices named "Place Order" in one model: computeRefs dedupes their export keys to
    // "place-order" and "place-order~2" and warns about the collision. Only "place-order.md"
    // exists on disk (the file a human would actually author for the name "Place Order"), so
    // the second slice must NOT silently render the first slice's doc content.
    const DUPLICATE = `slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed
}
slice "Place Order" {
  ui Retry Checkout @Customer
  command Retry Order
  event Order Retried
}
`;
    const dupFile = join(dir, "dup.em");
    writeFileSync(dupFile, DUPLICATE);
    const { model, grid, dot } = compile(DUPLICATE);
    const outDir = join(dir, "out-dup");

    const result = await buildCatalog([{ file: dupFile, model, grid, dot }], { outDir });
    expect(result.slices).toBe(2);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].file).toBe(dupFile);
    expect(result.diagnostics[0].diagnostics[0].message).toContain('duplicate slice name "Place Order"');

    const first = readFileSync(join(outDir, "dup", "slices", "place-order.html"), "utf8");
    const second = readFileSync(join(outDir, "dup", "slices", "place-order~2.html"), "utf8");
    expect(first).toContain("Let customers place orders."); // real doc content
    expect(second).toContain("No slice doc found"); // honest, not a duplicate of `first`
    expect(second).not.toContain("Let customers place orders.");
  });

  it("keeps slice keys from different input models collision-free via per-model directories", async () => {
    const { model, grid, dot } = compile(MODEL);
    const outDir = join(dir, "out-multi");
    const inputs: CatalogModelInput[] = [
      { file: modelFile, model, grid, dot },
      { file: join(dir, "model.em"), model, grid, dot }, // same basename on purpose -> model-key dedup via "~2"
    ];

    const result = await buildCatalog(inputs, { outDir });
    expect(result.models).toBe(2);
    expect(existsSync(join(outDir, "model", "slices", "place-order.html"))).toBe(true);
    expect(existsSync(join(outDir, "model~2", "slices", "place-order.html"))).toBe(true);
  });
});
