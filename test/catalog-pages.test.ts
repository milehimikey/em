// SPDX-License-Identifier: MIT
// Coverage for src/catalog/pages.ts's pure HTML-string builders.
import { describe, it, expect } from "vitest";
import { compile } from "../src/pipeline.js";
import { computeRefs } from "../src/emit/json.js";
import { escapeHtml, renderIndexPage, renderSlicePage, CatalogModelSummary } from "../src/catalog/pages.js";
import { parseSliceDoc } from "../src/catalog/sliceDoc.js";

describe("escapeHtml", () => {
  it("escapes & < > \" '", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;",
    );
  });
});

describe("renderIndexPage", () => {
  it("lists every model and slice with escaped names, pattern, status, and links", () => {
    const models: CatalogModelSummary[] = [
      {
        key: "checkout",
        name: "Checkout & Payments",
        file: "checkout.em",
        diagramFile: "diagram.svg",
        slices: [
          {
            key: "place-order",
            name: "Place Order",
            pattern: "state-change",
            hasDoc: true,
            status: "ready-to-implement",
          },
          { key: "open-orders", name: "Open Orders", pattern: "state-view", hasDoc: false, status: null },
        ],
      },
    ];
    const html = renderIndexPage(models, "My Catalog");

    expect(html).toContain("Checkout &amp; Payments"); // escaped name
    expect(html).toContain("checkout/slices/place-order.html");
    expect(html).toContain("State Change");
    expect(html).toContain("ready-to-implement");
    expect(html).toContain("no doc");
    expect(html).toContain("checkout/diagram.svg");
  });
});

describe("renderSlicePage", () => {
  it("embeds the diagram, the element table, and the rendered slice doc", () => {
    const { model } = compile(`slice "Place Order" {
  ui Checkout @Customer
  command Place Order { total: Money }
  event Order Placed @Order issue "needs currency?"
}`);
    const slice = model.slices[0];
    const refs = computeRefs(model);
    const elementRefs = new Map<string, string>();
    for (const el of slice.elements) {
      const ref = refs.refById.get(el.id);
      if (ref) elementRefs.set(el.id, ref);
    }
    const doc = parseSliceDoc("- **Status:** draft\n\n## Intent\nWhy this exists.\n");

    const html = renderSlicePage({
      modelName: "Checkout",
      diagramFile: "../diagram.svg",
      format: "svg",
      slice,
      sliceKey: "place-order",
      pattern: "state-change",
      elementRefs,
      doc,
      docExpectedPath: "slices/place-order.md",
    });

    expect(html).toContain('data="../diagram.svg"');
    expect(html).toContain("Place Order");
    expect(html).toContain("total: Money");
    expect(html).toContain("needs currency?");
    expect(html).toContain("Why this exists.");
    expect(html).toContain("draft");
  });

  it("shows a 'no doc' notice, and still renders the element table, when no slice doc was found", () => {
    const { model } = compile(`slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed
}`);
    const slice = model.slices[0];
    const html = renderSlicePage({
      modelName: "Checkout",
      diagramFile: "../diagram.svg",
      format: "svg",
      slice,
      sliceKey: "place-order",
      pattern: "state-change",
      elementRefs: new Map(),
      doc: null,
      docExpectedPath: "slices/place-order.md",
    });
    expect(html).toContain("No slice doc found");
    expect(html).toContain("slices/place-order.md");
    expect(html).toContain("no doc");
    expect(html).toContain("Checkout"); // element table still renders from the AST alone
  });

  it("declares the diagram's actual MIME type — image/png for a png diagram, not svg", () => {
    const { model } = compile(`slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed
}`);
    const html = renderSlicePage({
      modelName: "Checkout",
      diagramFile: "../diagram.png",
      format: "png",
      slice: model.slices[0],
      sliceKey: "place-order",
      pattern: "state-change",
      elementRefs: new Map(),
      doc: null,
      docExpectedPath: "slices/place-order.md",
    });
    expect(html).toContain('type="image/png"');
    expect(html).not.toContain('type="image/svg+xml"');
  });
});

describe("layout's home link", () => {
  it("index page links home to a same-directory relative path, not an absolute one", () => {
    const html = renderIndexPage([], "My Catalog");
    expect(html).toContain('href="index.html"');
    expect(html).not.toContain('href="/"');
  });

  it("slice page links home back up to the catalog root, not an absolute path", () => {
    const { model } = compile(`slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed
}`);
    const html = renderSlicePage({
      modelName: "Checkout",
      diagramFile: "../diagram.svg",
      format: "svg",
      slice: model.slices[0],
      sliceKey: "place-order",
      pattern: "state-change",
      elementRefs: new Map(),
      doc: null,
      docExpectedPath: "slices/place-order.md",
    });
    expect(html).toContain('href="../../index.html"');
    expect(html).not.toContain('href="/"');
  });
});
