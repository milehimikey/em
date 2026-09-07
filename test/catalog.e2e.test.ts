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
    const { model, grid, dot, refs } = compile(MODEL);
    const inputs: CatalogModelInput[] = [{ file: modelFile, model, grid, dot, refs }];
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

    // per-slice diagrams: no slices/*.svg siblings exist on disk for this fixture,
    // so both are built fresh (buildSliceDiagram) into the output tree only.
    expect(existsSync(join(outDir, "model", "slices", "place-order.svg"))).toBe(true);
    expect(existsSync(join(outDir, "model", "slices", "open-orders.svg"))).toBe(true);
    // never written back into the source tree — em catalog is a pure presentation layer
    expect(existsSync(join(dir, "slices", "place-order.svg"))).toBe(false);
    expect(existsSync(join(dir, "slices", "open-orders.svg"))).toBe(false);

    const placeOrderPage = readFileSync(join(outDir, "model", "slices", "place-order.html"), "utf8");
    // the slice's own diagram is the primary embed; the full diagram is a secondary link
    expect(placeOrderPage).toContain('<object class="diagram" type="image/svg+xml" data="place-order.svg">');
    expect(placeOrderPage).toContain('href="../diagram.svg">View full model diagram');
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
    const { model, grid, dot, refs } = compile(DUPLICATE);
    const outDir = join(dir, "out-dup");

    const result = await buildCatalog([{ file: dupFile, model, grid, dot, refs }], { outDir });
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

  it("copies an author-provided slices/<key>.svg sibling instead of building one", async () => {
    // A hand-placed (or `em render --slice`-authored) diagram next to the .em
    // file — deliberately distinguishable content so the assertion can't pass
    // by coincidence.
    const AUTHORED_SVG = '<svg viewBox="0 0 1 1"><!-- hand-authored diagram --></svg>';
    writeFileSync(join(dir, "slices", "place-order.svg"), AUTHORED_SVG);
    try {
      const { model, grid, dot, refs } = compile(MODEL);
      const outDir = join(dir, "out-authored-svg");

      await buildCatalog([{ file: modelFile, model, grid, dot, refs }], { outDir });

      const copied = readFileSync(join(outDir, "model", "slices", "place-order.svg"), "utf8");
      expect(copied).toBe(AUTHORED_SVG); // copied verbatim, not rebuilt
      // the sibling slice ("Open Orders") has no authored .svg, so it still falls
      // back to building one fresh in the same build
      expect(existsSync(join(outDir, "model", "slices", "open-orders.svg"))).toBe(true);
      const built = readFileSync(join(outDir, "model", "slices", "open-orders.svg"), "utf8");
      expect(built).not.toBe(AUTHORED_SVG);
    } finally {
      rmSync(join(dir, "slices", "place-order.svg"), { force: true });
    }
  });

  it("keeps slice keys from different input models collision-free via per-model directories", async () => {
    const { model, grid, dot, refs } = compile(MODEL);
    const outDir = join(dir, "out-multi");
    const inputs: CatalogModelInput[] = [
      { file: modelFile, model, grid, dot, refs },
      { file: join(dir, "model.em"), model, grid, dot, refs }, // same basename on purpose -> model-key dedup via "~2"
    ];

    const result = await buildCatalog(inputs, { outDir });
    expect(result.models).toBe(2);
    expect(existsSync(join(outDir, "model", "slices", "place-order.html"))).toBe(true);
    expect(existsSync(join(outDir, "model~2", "slices", "place-order.html"))).toBe(true);
  });

  // MIL-160: unlike the test above (one file listed twice — always collision-free via the
  // model-key dedup on the OUTPUT side), this is the genuine input-side hazard the ticket
  // exists to catch: two DIFFERENT source .em files sharing a directory, each with a slice
  // named "Checkout" — both would read/write the same `slices/checkout.md` on disk.
  it("flags colliding slice doc paths when two DIFFERENT models share a directory and a slice name", async () => {
    const sharedDir = join(dir, "shared-models");
    mkdirSync(sharedDir, { recursive: true });
    const CHECKOUT_MODEL = `slice "Checkout" {
  ui Checkout Screen @Customer
  command Submit Order
  event Order Submitted
}
`;
    const fileA = join(sharedDir, "a.em");
    const fileB = join(sharedDir, "b.em");
    writeFileSync(fileA, CHECKOUT_MODEL);
    writeFileSync(fileB, CHECKOUT_MODEL);
    const compiledA = compile(CHECKOUT_MODEL);
    const compiledB = compile(CHECKOUT_MODEL);
    const outDir = join(dir, "out-collision");

    const inputs: CatalogModelInput[] = [
      { file: fileA, model: compiledA.model, grid: compiledA.grid, dot: compiledA.dot, refs: compiledA.refs },
      { file: fileB, model: compiledB.model, grid: compiledB.grid, dot: compiledB.dot, refs: compiledB.refs },
    ];
    const result = await buildCatalog(inputs, { outDir });

    const collision = result.diagnostics.find((d) => d.diagnostics.some((diag) => diag.code === "cross-model-slice-doc-collision"));
    expect(collision).toBeDefined();
    expect(collision!.file).toBe(fileB); // attributed to the SECOND model to use the key
    expect(collision!.diagnostics[0].message).toContain('slice key "checkout"');
    expect(collision!.diagnostics[0].refs).toEqual(["checkout", fileA, fileB]);
  });

  // MIL-137: a slice with no own doc that's covered by a sibling's `covers:` (MIL-121) gets a
  // "documented as part of" banner on its detail page, linking to the covering slice's own
  // page — never the covering doc's body rendered under the covered slice's name.
  it("shows a 'documented as part of' banner on a covered slice's page, and never inlines the covering doc's body", async () => {
    const coveredDir = join(dir, "covered-model");
    mkdirSync(join(coveredDir, "slices"), { recursive: true });
    const COVERED_MODEL = `slice "View Only" {
  view Some View from "Thing Done"
}
slice "Covering Slice" {
  processor Reacts from "Some View"
  command React
  event Reacted
}
`;
    const coveredFile = join(coveredDir, "model.em");
    writeFileSync(coveredFile, COVERED_MODEL);
    writeFileSync(
      join(coveredDir, "slices", "covering-slice.md"),
      "---\nstatus: ready-to-implement\ncovers: view-only\n---\n\n## Intent\nBody content that must not leak onto a different slice page.\n",
    );

    const { model, grid, dot, refs } = compile(COVERED_MODEL);
    const outDir = join(coveredDir, "out");
    const result = await buildCatalog([{ file: coveredFile, model, grid, dot, refs }], { outDir });
    expect(result.diagnostics).toEqual([]);

    const coveredPage = readFileSync(join(outDir, "model", "slices", "view-only.html"), "utf8");
    expect(coveredPage).toContain("Documented as part of");
    expect(coveredPage).toContain('href="covering-slice.html">Covering Slice</a>');
    expect(coveredPage).toContain("slices/covering-slice.md");
    expect(coveredPage).toContain("ready-to-implement"); // covering doc's status colors this page too
    expect(coveredPage).not.toContain("Body content that must not leak");
    expect(coveredPage).not.toContain("No slice doc found");

    // the index Status column reflects the covering doc's status too, not "no doc"
    const index = readFileSync(join(outDir, "index.html"), "utf8");
    expect(index).toContain("ready-to-implement");

    // the covering slice's OWN page still renders its doc's body in full
    const coveringPage = readFileSync(join(outDir, "model", "slices", "covering-slice.html"), "utf8");
    expect(coveringPage).toContain("Body content that must not leak onto a different slice page.");
  });
});
