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

  it("classifies view+processor (the automation reaction slice) as Automation", () => {
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

  it("classifies Automation/Translation's second slice (bare command+event) as State Change — " +
    "a deliberate simplification of per-slice classification, not a bug (see docs/patterns.md)", () => {
    const { model } = compile(`slice "Payments To Process" {
  view Payments To Process from "Payment Requested"
  processor Payment Gateway
}
slice "Capture Payment" {
  command Capture Payment
  event Payment Captured @Payment
}`);
    expect(classifySlicePattern(model.slices[1])).toBe("state-change");
  });
});
