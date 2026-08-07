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

  it("with no local UI: pulls the previous slice's automation-kind trigger as earlier context", () => {
    // "Capture Payment" (order-fulfillment.em): no ui, triggered by "Payments To
    // Process"'s processor. Real, already-verified case, per plan.
    const model = compile(readFileSync("examples/order-fulfillment.em", "utf8")).model;
    const i = model.slices.findIndex((s) => s.name === "Capture Payment");
    const { model: sm } = buildSliceDiagram(model, i);
    expect(sliceNames(sm)).toEqual(["Payments To Process", "Capture Payment"]);
    // only the processor comes along from the trigger slice — not its own view too
    const triggerColumn = sm.elements.filter((e) => e.sliceIndex === 0);
    expect(triggerColumn.map((e) => e.kind)).toEqual(["processor"]);
    expect(names(sm)).toEqual(["Capture Payment", "Payment Captured", "Payment Gateway"]);
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
  it("Automation: view+processor column, then the next slice's command+event", () => {
    const model = compile(readFileSync("examples/order-fulfillment.em", "utf8")).model;
    const i = model.slices.findIndex((s) => s.name === "Payments To Process");
    const { model: sm } = buildSliceDiagram(model, i);
    expect(sliceNames(sm)).toEqual(["Payments To Process", "Capture Payment"]);
    expect(sm.slices[0].elements.map((e) => e.kind).sort()).toEqual(["processor", "view"]);
    expect(sm.slices[1].elements.map((e) => e.kind).sort()).toEqual(["command", "event"]);
  });

  it("Automation: filters a stray UI out of the next slice — only command/event are pulled", () => {
    const model = modelFrom(`
persona Manager
slice "React" {
  view Watched from "Something Happened"
  processor Worker
}
slice "Follow Up" {
  command Do The Thing
  event Thing Done
  ui Confirmation Screen @Manager
}
`);
    const { model: sm } = buildSliceDiagram(model, 0);
    expect(sliceNames(sm)).toEqual(["React", "Follow Up"]);
    expect(sm.slices[1].elements.map((e) => e.kind).sort()).toEqual(["command", "event"]);
    expect(names(sm)).not.toContain("Confirmation Screen");
  });

  it("Translation: same shared shape as Automation", () => {
    // "Carrier Sync" (ecommerce-fulfillment.em): internally-triggered translation
    // (has a same-slice view), followed by "Record Delivery"'s command+event.
    const model = compile(readFileSync("examples/ecommerce-fulfillment.em", "utf8")).model;
    const i = model.slices.findIndex((s) => s.name === "Carrier Sync");
    const { model: sm } = buildSliceDiagram(model, i);
    expect(sliceNames(sm)).toEqual(["Carrier Sync", "Record Delivery"]);
    expect(sm.slices[0].elements.map((e) => e.kind).sort()).toEqual(["translation", "view"]);
    expect(sm.slices[1].elements.map((e) => e.kind).sort()).toEqual(["command", "event"]);
  });

  it("Automation as the very last slice: no next-slice column, doesn't throw", () => {
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
