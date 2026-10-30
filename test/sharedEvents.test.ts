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

// GH #328: each recording site feeds the nearest instance of the reading view at or after it.
describe("a repeated view reads only the sites since its previous reading instance (GH #328)", () => {
  const ordering = `
model "Ordering"
persona Customer
context Sales

slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed @Sales { orderId: UUID }
}

slice "Order Status" {
  view Order Status from "Order Placed"
  ui Track Order @Customer
}

slice "Reorder" {
  ui Reorder Button @Customer
  command Reorder
  event Order Placed @Sales
}

slice "Order Status after Reorder" {
  view Order Status again from "Order Placed"
  ui Track Order @Customer
}
`;
  const fromEdges = (src: string) => {
    const model = modelFrom(src);
    return semanticEdges(model)
      .filter((e) => e.source === "from")
      .map((e) => {
        const a = model.byId.get(e.from)!;
        const b = model.byId.get(e.to)!;
        return `${model.slices[a.sliceIndex].name} -> ${model.slices[b.sliceIndex].name}`;
      });
  };

  it("the Ordering exhibit yields exactly two from edges, no back-span", () => {
    expect(fromEdges(ordering)).toEqual([
      "Place Order -> Order Status",
      "Reorder -> Order Status after Reorder",
    ]);
  });

  it("the previous instance is the previous one that READS the event (interleaved case)", () => {
    const src = `
model "Shop"
persona Customer
context Sales

slice "A1" {
  ui A1 UI @Customer
  command Do A1
  event E1 Happened @Sales
}
slice "Slice X" {
  view X from "E1 Happened"
  ui X UI @Customer
}
slice "F" {
  ui F UI @Customer
  command Do F
  event F Happened @Sales
}
slice "Slice X2" {
  view X again from "F Happened"
  ui X UI 2 @Customer
}
slice "A2" {
  ui A2 UI @Customer
  command Do A2
  event E1 Happened @Sales
}
slice "Slice X3" {
  view X again from "E1 Happened"
  ui X UI 3 @Customer
}
`;
    expect(fromEdges(src)).toEqual(["A1 -> Slice X", "F -> Slice X2", "A2 -> Slice X3"]);
  });

  it("an empty window keeps every reachable site (cumulative from is unchanged)", () => {
    const src = ordering.replace(
      /slice "Order Status after Reorder" \{/,
      `slice "Order Status Again" {
  view Order Status again from "Order Placed"
  ui Track Order @Customer
}
slice "Order Status after Reorder" {`,
    );
    const edges = fromEdges(src);
    expect(edges).toContain("Place Order -> Order Status");
    expect(edges).toContain("Reorder -> Order Status Again");
    // the third instance has no new site since the second: today's edge set (both sites)
    expect(edges.filter((e) => e.endsWith("-> Order Status after Reorder")).sort()).toEqual([
      "Place Order -> Order Status after Reorder",
      "Reorder -> Order Status after Reorder",
    ]);
  });

  it("a from-less instance in a slice that records the event is a previous reader (critic probe)", () => {
    const src = `
model "Ordering"
persona Customer
context Sales

slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed @Sales { orderId: UUID }
}
slice "Order Status" {
  view Order Status from "Order Placed"
  ui Track Order @Customer
}
slice "Import Order" {
  event Order Placed @Sales
  view Order Status again
}
slice "Reorder" {
  ui Reorder Button @Customer
  command Reorder
  event Order Placed @Sales
}
slice "Order Status after Reorder" {
  view Order Status again from "Order Placed"
  ui Track Order @Customer
}
`;
    const edges = fromEdges(src).filter((e) => e.endsWith("-> Order Status after Reorder"));
    expect(edges).toEqual(["Reorder -> Order Status after Reorder"]);
    // the Import Order site feeds only its same-slice instance, by pattern
    const model = modelFrom(src);
    const site = model.elements.find((e) => e.kind === "event" && model.slices[e.sliceIndex].name === "Import Order")!;
    const out = semanticEdges(model).filter((e) => e.from === site.id);
    expect(out.map((e) => [e.source, model.slices[model.byId.get(e.to)!.sliceIndex].name])).toEqual([
      ["pattern", "Import Order"],
    ]);
  });

  it("a from-less continuation lifted out of a command slice never counts as a previous reader", () => {
    const src = `
model "Ordering"
persona Customer
context Sales

slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed @Sales { orderId: UUID }
}
slice "Order Status" {
  view Order Status from "Order Placed"
  ui Track Order @Customer
}
slice "Import Order" {
  ui Import Button @Customer
  command Import Order
  event Order Placed @Sales
  view Order Status again
}
slice "Order Status after Import" {
  view Order Status again from "Order Placed"
  ui Track Order @Customer
}
`;
    const model = modelFrom(src);
    expect(model.slices.some((s) => s.synthesized)).toBe(true);
    const site = model.elements.find((e) => e.kind === "event" && model.slices[e.sliceIndex].name === "Import Order")!;
    const edges = semanticEdges(model);
    const out = edges.filter((e) => e.from === site.id && e.source === "from");
    expect(out.map((e) => model.slices[model.byId.get(e.to)!.sliceIndex].name)).toEqual(["Order Status after Import"]);
    // no recording site is left without an outgoing edge to a view
    for (const ev of model.elements.filter((e) => e.kind === "event")) {
      expect(edges.some((e) => e.from === ev.id && model.byId.get(e.to)?.kind === "view")).toBe(true);
    }
  });

  it("an instance fed by an explicit arrow from the event is a previous reader", () => {
    const src = `
model "Ordering"
persona Customer
context Sales

slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed @Sales { orderId: UUID }
}
slice "Order Status" {
  view Order Status
  ui Track Order @Customer
}
arrow Order Placed -> Order Status
slice "Reorder" {
  ui Reorder Button @Customer
  command Reorder
  event Order Placed @Sales
}
slice "Order Status after Reorder" {
  view Order Status again from "Order Placed"
  ui Track Order @Customer
}
`;
    const model = modelFrom(src);
    expect(model.arrows.some((a) => a.toId !== undefined && a.fromId !== undefined)).toBe(true);
    expect(fromEdges(src).filter((e) => e.endsWith("-> Order Status after Reorder"))).toEqual([
      "Reorder -> Order Status after Reorder",
    ]);
  });

  it("the slice diagram follows the same rule", () => {
    const model = modelFrom(ordering);
    const { model: sm } = buildSliceDiagram(model, 3);
    const view = sm.elements.find((e) => e.kind === "view")!;
    const into = semanticEdges(sm).filter((e) => e.to === view.id && e.source === "from");
    expect(into.length).toBe(1);
  });
});
