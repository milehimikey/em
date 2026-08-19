// SPDX-License-Identifier: MIT
// Coverage for src/catalog/classify.ts: one case per SlicePattern, following
// the exact DSL-element signatures docs/patterns.md documents.
import { describe, it, expect } from "vitest";
import { compile } from "../src/pipeline.js";
import { classifySlicePattern, slicePatternLabel } from "../src/catalog/classify.js";

describe("classifySlicePattern", () => {
  it("classifies ui+command+event as State Change", () => {
    const { model } = compile(`slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed @Order
}`);
    expect(classifySlicePattern(model.slices[0])).toBe("state-change");
    expect(slicePatternLabel("state-change")).toBe("State Change");
  });

  it("classifies view+ui (no event/command) as State View", () => {
    const { model } = compile(`slice "Open Orders" {
  view Open Orders from "Order Placed"
  ui Order List @Customer
}`);
    expect(classifySlicePattern(model.slices[0])).toBe("state-view");
    expect(slicePatternLabel("state-view")).toBe("State View");
  });

  it("classifies a bare view+processor slice (no command yet) as Automation", () => {
    const { model } = compile(`slice "Payments To Process" {
  view Payments To Process from "Payment Requested"
  processor Payment Gateway
}`);
    expect(classifySlicePattern(model.slices[0])).toBe("automation");
    expect(slicePatternLabel("automation")).toBe("Automation");
  });

  it("classifies a translation-only slice as Translation", () => {
    const { model } = compile(`slice "Carrier Webhook" {
  translation Carrier Adapter
}`);
    expect(classifySlicePattern(model.slices[0])).toBe("translation");
    expect(slicePatternLabel("translation")).toBe("Translation");
  });

  it("classifies an unrecognized kind combination as Unclassified", () => {
    const { model } = compile(`slice "Dangling" {
  ui Screen @Customer
}`);
    expect(classifySlicePattern(model.slices[0])).toBe("unclassified");
    expect(slicePatternLabel("unclassified")).toBe("Unclassified");
  });

  it("classifies the canonical merged shape — processor+command+event together — as Automation, " +
    "not State Change (checking reaction kinds before command/event is what makes this work; " +
    "see the doc comment on classifySlicePattern)", () => {
    const { model } = compile(`slice "Payments To Process" {
  view Payments To Process from "Payment Requested"
}
slice "Capture Payment" {
  processor Payment Gateway from "Payments To Process"
  command Capture Payment
  event Payment Captured @Payment
}`);
    expect(classifySlicePattern(model.slices[1])).toBe("automation");
  });

  it("classifies the merged shape with a translation the same way — Translation, not State Change", () => {
    const { model } = compile(`slice "Confirm Delivery" {
  translation Carrier Adapter
  command Confirm Delivery
  event Delivery Confirmed @Shipping
}`);
    expect(classifySlicePattern(model.slices[0])).toBe("translation");
  });
});
