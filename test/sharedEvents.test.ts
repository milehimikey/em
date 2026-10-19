// SPDX-License-Identifier: MIT
// GH #279: the same event recorded by two commands (same name AND context) is one logical event.
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { validate } from "../src/model/validate.js";
import { computeRefs } from "../src/model/refs.js";
import { layout } from "../src/layout/grid.js";
import { semanticEdges } from "../src/model/edges.js";
import { buildExportDoc } from "../src/emit/json.js";
import { buildSliceDiagram } from "../src/render/sliceDiagram.js";

const modelFrom = (src: string) => normalize(parse(src));
const diagsFor = (src: string) => {
  const model = modelFrom(src);
  return validate(model, layout(model), computeRefs(model));
};

const shared = (secondEvent: string, ctx2 = "@Sales") => `
model "Shop"
context Sales
context Billing
persona Clerk

slice "Place Order" {
  ui Order Form @Clerk
  command Place Order
  event Order Placed @Sales { orderId: string, total: number }
}

slice "Reorder" {
  ui Reorder Button @Clerk
  command Reorder
  ${secondEvent.replace("CTX", ctx2)}
}

slice "Orders" {
  view Orders from "Order Placed" { orderId: string, total: number }
  ui Order List @Clerk
}
`;

describe("shared events (GH #279)", () => {
  const bare = shared("event Order Placed CTX");

  it("two commands recording one event validate clean (no duplicate-name)", () => {
    const d = diagsFor(bare);
    expect(d.filter((x) => x.severity === "error")).toEqual([]);
    expect(d.find((x) => x.code === "duplicate-name")).toBeUndefined();
    expect(d.find((x) => x.code === "view-from-future-event")).toBeUndefined();
  });

  it("a bare repeat inherits the first declaration's fields", () => {
    const model = modelFrom(bare);
    const repeat = model.elements.filter((e) => e.kind === "event")[1];
    expect(repeat.fields?.map((f) => f.name)).toEqual(["orderId", "total"]);
    expect(repeat.logicalId).not.toBe(repeat.id);
  });

  it("infers an arrow into the view from every recording site", () => {
    const model = modelFrom(bare);
    const view = model.elements.find((e) => e.kind === "view")!;
    const into = semanticEdges(model).filter((e) => e.to === view.id && e.source === "from");
    expect(into.map((e) => model.byId.get(e.from)!.sliceIndex).sort()).toEqual([0, 1]);
  });

  it("exports one logicalRef pointing at the first declaration", () => {
    const model = modelFrom(bare);
    const refs = computeRefs(model);
    const { doc } = buildExportDoc(model, refs, validate(model, layout(model), refs), bare, "shop.em");
    const evs = doc.model.slices.flatMap((s) => s.elements).filter((e) => e.kind === "event");
    expect(evs[0].logicalRef).toBeNull();
    expect(evs[1].logicalRef).toBe(evs[0].ref);
    expect(doc.schemaVersion).toBe("1.19");
  });

  it("a differing field block is shared-event-field-mismatch (error)", () => {
    const d = diagsFor(shared("event Order Placed CTX { orderId: string }"));
    expect(d.find((x) => x.code === "shared-event-field-mismatch")?.severity).toBe("error");
  });

  it("an identical field block is fine", () => {
    const d = diagsFor(shared("event Order Placed CTX { orderId: string, total: number }"));
    expect(d.find((x) => x.code === "shared-event-field-mismatch")).toBeUndefined();
  });

  it("same name in a different context still warns duplicate-name", () => {
    const d = diagsFor(shared("event Order Placed CTX", "@Billing"));
    expect(d.find((x) => x.code === "duplicate-name")).toBeDefined();
    expect(d.find((x) => x.code === "shared-event-field-mismatch")).toBeUndefined();
  });
});

const tagged = (second: string) => `
model "Shop"
context Sales
persona Clerk

slice "Create Product" {
  ui Product Form @Clerk
  command Create Product
  event Product Created @Sales public { productId: string tag, name: string }
}

slice "Create Variant" {
  ui Variant Form @Clerk
  command Create Product Variant
  ${second}
}

slice "Products" {
  view Products from "Product Created" { productId: string, name: string }
  ui Product List @Clerk
}
`;

describe("shared events inherit the whole declaration (GH #279)", () => {
  it("a bare repeat inherits tags and public, and exports them on each site", () => {
    const src = tagged("event Product Created @Sales");
    const model = modelFrom(src);
    const refs = computeRefs(model);
    const diags = validate(model, layout(model), refs);
    expect(diags.filter((d) => d.severity === "error")).toEqual([]);
    const { doc } = buildExportDoc(model, refs, diags, src, "shop.em");
    const evs = doc.model.slices.flatMap((s) => s.elements).filter((e) => e.kind === "event");
    expect(evs[1].public).toBe(true);
    expect(evs[1].tags).toEqual(evs[0].tags);
    expect(evs[1].tags).not.toBeNull();
  });

  it("an element-level tag on the first site is inherited too", () => {
    const src = tagged("event Product Created @Sales").replace(
      "event Product Created @Sales public { productId: string tag, name: string }",
      "event Product Created @Sales public { productId: string, name: string }\n  tag productName from productId, name",
    );
    const model = modelFrom(src);
    const evs = model.elements.filter((e) => e.kind === "event");
    expect(evs[1].tags).toBe(evs[0].tags);
    expect(evs[1].tags?.length).toBe(1);
  });

  it("a repeat declaring a different tag is shared-event-field-mismatch", () => {
    const src = tagged("event Product Created @Sales public { productId: string, name: string }\n  tag variantKey from productId, name");
    const d = diagsFor(src);
    const hit = d.find((x) => x.code === "shared-event-field-mismatch");
    expect(hit?.severity).toBe("error");
    expect(hit?.message).toContain("tags");
  });

  it("a repeat declaring public when the first is not is a mismatch", () => {
    const src = tagged("event Product Created @Sales public").replace(
      "@Sales public { productId: string tag, name: string }",
      "@Sales { productId: string tag, name: string }",
    );
    const d = diagsFor(src);
    expect(d.find((x) => x.code === "shared-event-field-mismatch")?.message).toContain("public");
  });
});

describe("every recording site needs a reader after it (GH #279)", () => {
  const sites = `
model "Shop"
context Sales
persona Clerk

slice "A" {
  ui Form A @Clerk
  command Do A
  event Thing Done @Sales
}
slice "Things" {
  view Things from "Thing Done"
  ui Thing List @Clerk
}
slice "C" {
  ui Form C @Clerk
  command Do C
  event Thing Done @Sales
}
slice "D" {
  ui Form D @Clerk
  command Do D
  event Thing Done @Sales
}
`;
  it("sites in slices 1, 3, 4 with the only reader in slice 2 warn for slices 3 and 4", () => {
    const unread = diagsFor(sites).filter((d) => d.code === "both-ends-of-a-flow/event-unread");
    expect(unread.length).toBe(2);
    expect(unread[0].message).toContain('slice "C"');
    expect(unread[1].message).toContain('slice "D"');
  });

  it("a later `view again from` reader after the last site clears them", () => {
    const fixed = sites + `
slice "Things later" {
  view Things again from "Thing Done"
  ui Thing List 2 @Clerk
}
`;
    expect(diagsFor(fixed).filter((d) => d.code === "both-ends-of-a-flow/event-unread")).toEqual([]);
  });
});

describe("render and query of shared events (GH #279)", () => {
  it("the view's slice diagram draws an event -> view path from each recording site", () => {
    const model = modelFrom(shared("event Order Placed @Sales"));
    const { model: sm } = buildSliceDiagram(model, 2);
    const view = sm.elements.find((e) => e.kind === "view")!;
    const into = semanticEdges(sm).filter((e) => e.to === view.id && e.source === "from");
    expect(sm.elements.filter((e) => e.kind === "event").length).toBe(2);
    expect(into.length).toBe(2);
  });
});
