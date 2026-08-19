// SPDX-License-Identifier: MIT
// Coverage for src/render/sliceDiagram.ts's pattern-shape single-slice
// renderer: per-pattern column assembly, and the two regression classes that
// broke the previous crop-based approach (personas/contexts leaking the full
// model's lists, and edge-drawing needing the synthetic model's byName wired
// correctly for semanticEdges to find anything).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { compile } from "../src/pipeline.js";
import { semanticEdges } from "../src/model/edges.js";
import { buildSliceDiagram } from "../src/render/sliceDiagram.js";

const modelFrom = (src: string) => compile(src).model;
const names = (m: { elements: { name: string }[] }) => m.elements.map((e) => e.name).sort();
const sliceNames = (m: { slices: { name: string }[] }) => m.slices.map((s) => s.name);

describe("buildSliceDiagram — State Change", () => {
  it("with a local UI: one column, no extra context pulled", () => {
    const model = modelFrom(`
persona Customer
slice "Browse Catalog" {
  ui Product Catalog @Customer
  command Place Order
  event Order Placed
}
slice "View Open Orders" {
  view Open Orders from "Order Placed"
}
`);
    const { model: sm } = buildSliceDiagram(model, 0);
    expect(sliceNames(sm)).toEqual(["Browse Catalog"]);
    expect(names(sm)).toEqual(["Order Placed", "Place Order", "Product Catalog"]);
  });

  it("with no local UI and no reaction: single column, nothing to pull (an untriggered command)", () => {
    // A slice classifies as "state-change" only when it carries no automation-kind element at
    // all (see classify.ts) — so a command with no local `ui` here has no reaction to chase
    // either; it's exactly `both-ends-of-a-flow/command-untriggered`'s case, a validate concern
    // rather than something this renderer can complete by reaching elsewhere.
    const model = modelFrom(`
context Order
slice "Untriggered" {
  command Place Order
  event Order Placed @Order
}
`);
    const { model: sm } = buildSliceDiagram(model, 0);
    expect(sliceNames(sm)).toEqual(["Untriggered"]);
    expect(names(sm)).toEqual(["Order Placed", "Place Order"]);
  });
});

describe("buildSliceDiagram — State View", () => {
  it("single source: event column, then view+ui column", () => {
    // "View Open Orders" (order-fulfillment.em) — the exact slice a crop-based
    // render used to bleed ~80% of "Browse Catalog" into.
    const model = compile(readFileSync("examples/order-fulfillment.em", "utf8")).model;
    const i = model.slices.findIndex((s) => s.name === "View Open Orders");
    const { model: sm } = buildSliceDiagram(model, i);
    expect(sliceNames(sm)).toEqual(["Browse Catalog", "View Open Orders"]);
    // only the one referenced event comes from the source slice — not the whole
    // "Browse Catalog" slice (its ui/command are NOT pulled in)
    const sourceColumn = sm.elements.filter((e) => e.sliceIndex === 0);
    expect(sourceColumn.map((e) => e.name)).toEqual(["Order Placed"]);
  });

  it("multi-source: one column per distinct origin slice, not a single blown-out column", () => {
    // "Ops Dashboard" (ecommerce-fulfillment.em): sources events from slices 8
    // and 12 spans — the hardest case named in planning.
    const model = compile(readFileSync("examples/ecommerce-fulfillment.em", "utf8")).model;
    const i = model.slices.findIndex((s) => s.name === "Ops Dashboard");
    const { model: sm } = buildSliceDiagram(model, i);
    expect(sliceNames(sm)).toEqual(["Reserve Stock", "Dispatch Shipment", "Ops Dashboard"]);
    expect(sm.slices[0].elements.map((e) => e.name)).toEqual(["Stock Reserved"]);
    expect(sm.slices[1].elements.map((e) => e.name)).toEqual(["Shipment Dispatched"]);
    expect(sm.slices[2].elements.map((e) => e.name).sort()).toEqual(["Fulfillment Board", "Ops Console"]);
  });
});

describe("buildSliceDiagram — Automation / Translation", () => {
  it("Automation: the watched view pulled from the slice before, then this slice's processor+command+event", () => {
    const model = compile(readFileSync("examples/order-fulfillment.em", "utf8")).model;
    const i = model.slices.findIndex((s) => s.name === "Capture Payment");
    const { model: sm } = buildSliceDiagram(model, i);
    expect(sliceNames(sm)).toEqual(["Payments To Process", "Capture Payment"]);
    expect(sm.slices[0].elements.map((e) => e.kind)).toEqual(["view"]);
    expect(sm.slices[1].elements.map((e) => e.kind).sort()).toEqual(["command", "event", "processor"]);
  });

  it("Automation: filters a stray UI out of the origin slice — only the referenced view is pulled", () => {
    const model = modelFrom(`
persona Manager
slice "React" {
  view Watched from "Something Happened"
  ui Dashboard @Manager
}
slice "Follow Up" {
  processor Worker from "Watched"
  command Do The Thing
  event Thing Done
}
`);
    const { model: sm } = buildSliceDiagram(model, 1);
    expect(sliceNames(sm)).toEqual(["React", "Follow Up"]);
    expect(sm.slices[0].elements.map((e) => e.kind)).toEqual(["view"]);
    expect(names(sm)).not.toContain("Dashboard");
  });

  it("Translation: same shared shape as Automation", () => {
    // "Carrier Sync" (ecommerce-fulfillment.em): the read model the translation watches,
    // pulled from the slice before "Record Delivery"'s translation+command+event.
    const model = compile(readFileSync("examples/ecommerce-fulfillment.em", "utf8")).model;
    const i = model.slices.findIndex((s) => s.name === "Record Delivery");
    const { model: sm } = buildSliceDiagram(model, i);
    expect(sliceNames(sm)).toEqual(["Carrier Sync", "Record Delivery"]);
    expect(sm.slices[0].elements.map((e) => e.kind)).toEqual(["view"]);
    expect(sm.slices[1].elements.map((e) => e.kind).sort()).toEqual(["command", "event", "translation"]);
  });

  it("Automation with no `from` to chase: single column, doesn't throw", () => {
    const model = modelFrom(`
slice "React" {
  view Watched from "Something Happened"
  processor Worker
}
`);
    const { model: sm } = buildSliceDiagram(model, 0);
    expect(sliceNames(sm)).toEqual(["React"]);
  });
});

describe("buildSliceDiagram — unclassified", () => {
  it("an empty slice: one column, no extras, doesn't throw", () => {
    const model = modelFrom(`
slice "Nothing Here" {
}
`);
    const { model: sm } = buildSliceDiagram(model, 0);
    expect(sliceNames(sm)).toEqual(["Nothing Here"]);
    expect(sm.elements).toEqual([]);
  });
});

describe("buildSliceDiagram — keepEmptyLanes", () => {
  it("is dropped by default (matching layout()'s own default) and respected when passed", () => {
    const model = modelFrom(`
slice "Nothing Here" {
}
`);
    const collapsed = buildSliceDiagram(model, 0);
    expect(collapsed.grid.rows.some((r) => r.band === "api")).toBe(false);

    const kept = buildSliceDiagram(model, 0, { keepEmptyLanes: true });
    expect(kept.grid.rows.some((r) => r.band === "api")).toBe(true);
  });
});

describe("buildSliceDiagram — regression guards", () => {
  it("personas/contexts reflect only the included elements, not the full model's lists", () => {
    // The full model here declares 3 personas and 2 contexts; "View Open Orders"
    // only uses 1 persona and 1 context (via its pulled-in source event). This is
    // the exact bug class that made the previous crop-based approach barely
    // narrower than the full diagram — an unused row still reserves its own
    // swimlane in layout().
    const model = modelFrom(`
persona Customer
persona Manager
persona Support
context Order
context Payment
slice "Browse Catalog" {
  ui Product Catalog @Customer
  command Place Order
  event Order Placed @Order
}
slice "Manager Review" {
  ui Review Screen @Manager
}
slice "Support Tools" {
  ui Support Screen @Support
}
slice "View Open Orders" {
  view Open Orders from "Order Placed"
}
`);
    const i = model.slices.findIndex((s) => s.name === "View Open Orders");
    const { model: sm } = buildSliceDiagram(model, i);
    expect(sm.personas).toEqual([]); // "View Open Orders" itself has no ui, its source event has no ui either
    expect(sm.contexts).toEqual(["Order"]);
  });

  it("byName is populated correctly: semanticEdges() draws the same arrows on the synthetic model with zero new edge code", () => {
    const model = compile(readFileSync("examples/order-fulfillment.em", "utf8")).model;
    const i = model.slices.findIndex((s) => s.name === "View Open Orders");
    const { model: sm } = buildSliceDiagram(model, i);

    const event = sm.byName.get("order placed")![0];
    const view = sm.byName.get("open orders")![0];
    const edges = semanticEdges(sm);
    expect(edges.some((e) => e.from === event.id && e.to === view.id)).toBe(true);
  });

  it("byId preserves each element's original id — clone only overrides sliceIndex", () => {
    const model = compile(readFileSync("examples/order-fulfillment.em", "utf8")).model;
    const i = model.slices.findIndex((s) => s.name === "View Open Orders");
    const original = model.slices[i].elements.find((e) => e.kind === "view")!;
    const { model: sm } = buildSliceDiagram(model, i);
    const clone = sm.byId.get(original.id);
    expect(clone).toBeDefined();
    expect(clone!.name).toBe(original.name);
    expect(clone!.fields).toEqual(original.fields);
  });

  it("never mutates the real model's elements", () => {
    const model = compile(readFileSync("examples/order-fulfillment.em", "utf8")).model;
    const i = model.slices.findIndex((s) => s.name === "View Open Orders");
    const before = model.slices[i].elements.map((e) => e.sliceIndex);
    buildSliceDiagram(model, i);
    const after = model.slices[i].elements.map((e) => e.sliceIndex);
    expect(after).toEqual(before);
  });
});
